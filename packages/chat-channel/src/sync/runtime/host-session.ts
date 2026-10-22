// packages/chat-channel/src/sync/runtime/host-session.ts
// 宿主连接适配：把单个已认证 WebSocket 适配成独立的 SyncScopeRuntime（每连接一个，内存 store 不共享）。
//
// 设计约束（2026-10-16 设计 §14 + 主控裁决）：
// - scope 的身份只来自服务端认证与归属校验后的输入；HELLO 自报的 scope 永不用于授权。
// - 每条连接独立 runtime / store：内存 store 的写者租约是 scope 级，共享会让同一 scope 的两个连接互相顶替。
// - 旧 relay 投影路径保持原样；本层只消费其已规范化、已授权的事件（turnId 缺失时不产事件）。
// - 历史导入只接受调用方给出的完整稳定对象列表；ACP load 只回放增量流时不得伪造快照。
//
// 本文件不复制协议规则：帧编解码、握手、额度、ACK、封口继续由 protocol/provider/live/history 承担。

import { type Clock, cryptoRandomSource, type DigestFn, type RandomSource, sha256Digest, systemClock } from "../clock";
import type { HistoryRecordMeta } from "../history/ingest";
import { SyncProtocolError } from "../protocol/errors";
import { encodeSyncFrame, MAX_CONTROL_FRAME_BYTES, parseSyncFrame } from "../protocol/frames";
import { assertIdentifier, type SyncScope, scopeKey } from "../protocol/identity";
import { MemoryProjectionStore } from "../store/memory-store";
import type { ProjectionStore } from "../store/types";
import { commitHostHistory } from "./commit-host-history";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfigOverrides } from "./config";
import type { SyncFrameTransport } from "./egress";
import { ensureBaselineGeneration } from "./host-baseline";
import { normalizeAcpSessionUpdate, type SyncIngressEvent } from "./ingress";
import { createIngressFailureReporter } from "./ingress-failure-reporter";
import { createSyncScopeRuntime, type SyncScopeRuntime, type SyncTransportDiagnostics } from "./scope-runtime";
import { isScopeBusy, type SyncStoreRegistry, uniqueOwner } from "./store-registry";

/** 宿主连接可注入的运行时旋钮（宽限期由 env 装配给出，本层不提供默认值）。 */
export interface SyncHostRuntimeConfig {
  readonly sealGraceMs: number;
  readonly retireGraceMs: number;
  /** 宿主 tick 间隔（毫秒）；缺省 100ms。 */
  readonly tickIntervalMs?: number;
  /** 历史暂存根目录；缺省沿用 runtime config 的 `./data/sync-spool`。 */
  readonly spoolRootDir?: string;
}

/** 连接层传给运行时的认证后 scope（organizationId / rcsSessionId 均为服务端值）。 */
export interface SyncHostScope {
  readonly organizationId: string;
  readonly rcsSessionId: string;
}

/** 连接层已规范化的 ACP 事件（与 `schema.ts` 的 NormalizedEvent 结构兼容，避免 sync 依赖 state）。 */
export interface SyncHostNormalizedEvent {
  readonly type: string;
  readonly update: Record<string, unknown>;
  readonly content?: Record<string, unknown> | null;
  readonly turnId?: string | null;
}

/** 一条可导入的稳定历史记录：`value` 原样进入保真序列化，`meta` 决定身份与拼接位置。 */
export interface SyncHistoryRecord {
  readonly value: unknown;
  readonly meta: HistoryRecordMeta;
}

/**
 * 稳定历史源接缝。
 *
 * 仓库内没有 Peri 持久化历史的读取契约（ACP `load_session` 只回放增量流）；生产装配把旧 Chat Doc
 * 的已提交时间线映射成记录后经此接口注入。`acpSessionId` 只是代次元数据，空字符串表示来源没有
 * ACP 会话标识，不阻止导入。
 */
export interface SyncHistorySource {
  readonly acpSessionId: string;
  read(): Promise<readonly SyncHistoryRecord[]>;
}

export interface SyncHostSession {
  readonly scope: SyncScope;
  /** 入站二进制帧（连接层已按 `{` 首字节判定为新协议）。 */
  onInboundBytes(bytes: Uint8Array): Promise<void>;
  /** 旧投影路径处理后的规范化事件；缺 trusted turnId 时直接忽略。 */
  acceptNormalizedEvent(event: SyncHostNormalizedEvent): void;
  /** 后端单写用户消息；turnId 必须来自 `registerUserMessage` 的可信绑定。 */
  acceptUserMessage(turnId: string, text: string): void;
  /**
   * 历史导入入口：调用方必须一次性给出完整稳定对象列表。
   *
   * ACP `session/load` 目前只回放增量流、拿不到稳定对象列表，因此宿主 load 路径不调用本方法；
   * 这是明确限制，不是把回放事件猜成历史快照。
   */
  importHistory(input: {
    readonly acpSessionId: string;
    readonly records: readonly { readonly value: unknown; readonly meta: HistoryRecordMeta }[];
  }): Promise<{
    readonly generation: string;
    readonly pointerRevision: number;
    readonly contentDocIds: readonly string[];
  }>;
  /** 驱动追赶、ACK 超时扫描与搁置帧重试（由宿主定时器调用）。 */
  tick(): Promise<void>;
  /** 连接窗口快照（观测/测试）；不改变账目。 */
  diagnostics(): SyncTransportDiagnostics;
  /** live ingress 失败计数与停止状态（有界日志的观测出口）；不改变投影。 */
  ingressDiagnostics(): { readonly total: number; readonly lastCode: string | null; readonly stopped: boolean };
  /** 释放 runtime、定时器与内存投影；幂等。 */
  dispose(): Promise<void>;
  readonly closed: boolean;
}

const DEFAULT_TICK_INTERVAL_MS = 100;
const USER_CONTENT_SLOT = "text";
const TEXT_CONTENT_TYPE = "text/plain";
const SEMANTIC_CONTENT_SLOT = "semantic";
const SEMANTIC_CONTENT_TYPE = "application/json";

function noop(): void {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 挂接一个连接级同步运行时。
 *
 * `resolveSyncRuntimeConfig` 负责把宽限期与容量档案收敛成唯一配置；`createSyncScopeRuntime` 在构造期
 * 校验配置并建立独立内存 store。任何失败都原样上抛，由连接层以明确原因关闭连接。
 */
export async function createSyncHostSession(input: {
  readonly scope: SyncHostScope;
  readonly runtimeConfig: SyncHostRuntimeConfig;
  readonly transport: SyncFrameTransport;
  readonly clock?: Clock;
  readonly digest?: DigestFn;
  readonly random?: RandomSource;
  readonly overrides?: Omit<SyncRuntimeConfigOverrides, "lifecycle" | "spoolRootDir">;
  /** 存储替身（测试或未来 DB adapter）；缺省为独立内存 store。 */
  readonly store?: ProjectionStore;
  /**
   * 同 scope 共享投影存储：多标签页必须看到同一份已提交事实。
   *
   * 只共享 store 与一次历史引导，**不共享 runtime**；每个连接仍各自持有 provider 会话与传输绑定，
   * 抢不到单写者租约的连接按 follower 降级。
   */
  readonly storeRegistry?: SyncStoreRegistry;
  /** 稳定历史源；缺省或读取为空时回退空基线。读取失败不缓存，下一次连接可重试。 */
  readonly historySource?: SyncHistorySource;
  /**
   * 投影代次（旧 Chat/Session Doc 的 generation）。同一 scope 换代时必须换 store，
   * 否则新连接会复用上一代次的已提交时间线与一次性历史引导。
   */
  readonly storeBinding?: string;
  readonly owner?: string;
  readonly onError?: (message: string, error: unknown) => void;
  /** 入口永久停写：宿主据此让客户端重建投影，不能只留服务端日志。 */
  readonly onIngressStopped?: (error: unknown) => void;
}): Promise<SyncHostSession> {
  assertIdentifier(input.scope.organizationId, "scope.organizationId");
  assertIdentifier(input.scope.rcsSessionId, "scope.rcsSessionId");
  if (!Number.isSafeInteger(input.runtimeConfig.sealGraceMs) || input.runtimeConfig.sealGraceMs <= 0) {
    throw new Error("sync host config rejected: sealGraceMs must be a positive integer");
  }
  if (!Number.isSafeInteger(input.runtimeConfig.retireGraceMs) || input.runtimeConfig.retireGraceMs <= 0) {
    throw new Error("sync host config rejected: retireGraceMs must be a positive integer");
  }

  const scope: SyncScope = {
    organizationId: input.scope.organizationId,
    rcsSessionId: input.scope.rcsSessionId,
  };
  const clock = input.clock ?? systemClock;
  const digest = input.digest ?? sha256Digest;
  const random = input.random ?? cryptoRandomSource;
  const config = resolveSyncRuntimeConfig({
    ...input.overrides,
    clock,
    random,
    lifecycle: {
      sealGraceMs: input.runtimeConfig.sealGraceMs,
      retireGraceMs: input.runtimeConfig.retireGraceMs,
    },
    spoolRootDir: input.runtimeConfig.spoolRootDir,
  });
  const sharedStore = input.storeRegistry?.acquire(
    scope,
    () =>
      input.store ??
      new MemoryProjectionStore({ clock, digest, capacity: config.capacity, lifecycle: config.lifecycle }),
    input.storeBinding,
  );
  const store =
    sharedStore?.store ??
    input.store ??
    new MemoryProjectionStore({
      clock,
      digest,
      capacity: config.capacity,
      lifecycle: config.lifecycle,
    });
  let runtime: SyncScopeRuntime;
  try {
    runtime = await createSyncScopeRuntime({
      scope,
      config,
      clock,
      digest,
      random,
      store,
    });
  } catch (error) {
    sharedStore?.release();
    throw error;
  }
  runtime.attachTransport(input.transport);

  const reportError = input.onError ?? noop;
  const key = scopeKey(scope);
  // 共享 store 的写者租约按 owner 区分：同一用户同一实例的两个标签页会传入相同基础 owner，
  // 不加后缀时存储会把第二个连接当成「同 owner 续租」，两个写者于是同时持有写权。
  const owner = uniqueOwner(input.owner ?? `${scope.organizationId}:${scope.rcsSessionId}`, random);
  let cachedGeneration: string | null = null;
  let localBootstrap: Promise<string> | null = null;

  const commitHistory = async (
    acpSessionId: string,
    records: readonly SyncHistoryRecord[],
  ): Promise<{ generation: string; pointerRevision: number; contentDocIds: readonly string[] }> => {
    const result = await commitHostHistory({ runtime, store, scope, owner, acpSessionId, records });
    cachedGeneration = result.generation;
    return result;
  };

  /**
   * 读取或导入当前代次（每个共享 store 只执行一次）：
   * 1. 已提交且确实包含导入记录 → 直接复用（重启/掉线不重复扫描旧投影）；
   * 2. 有稳定源 → 读取并导入；空列表回退空基线（不得把「无历史」伪装成导入成功）；
   * 3. 无稳定源或读取失败 → 空基线。
   *
   * 失败刻意从引导任务中抛出：注册表不缓存失败，下一次连接会重试；本次连接由调用方回退基线。
   */
  const bootstrapGeneration = async (): Promise<string> => {
    const pointer = await store.readScopePointer(key);
    if (pointer?.currentGeneration != null) {
      const current = await store.readGeneration(key, pointer.currentGeneration);
      // `importEndOrdinal > 0` 是可恢复的已导入代次；空基线（0）允许下一次连接在源恢复后重试导入。
      if (current?.state === "committed" && (current.importEndOrdinal ?? 0) > 0) return current.generation;
    }
    const source = input.historySource;
    if (source === undefined) return await ensureBaseline();
    const records = await source.read();
    if (records.length === 0) return await ensureBaseline();
    const result = await commitHistory(source.acpSessionId, records);
    return result.generation;
  };

  /**
   * 空基线兜底：并发连接可能同时因引导失败走到这里，只有一个能取得写权，其余按 `SCOPE_BUSY`
   * 短暂退避后重读指针复用赢家提交的代次（否则一次恢复失败会让部分标签页握手失败）。
   */
  const ensureBaseline = async (): Promise<string> => {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await ensureBaselineGeneration({ store, scope, owner, clock, digest, random });
      } catch (error) {
        if (attempt >= 40 || !isScopeBusy(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };

  /** 同一 store 的引导只跑一次；失败不落缓存（`localBootstrap` 归零，注册表也不缓存拒绝）。 */
  const bootstrapOnce = (): Promise<string> => {
    if (sharedStore !== undefined) return sharedStore.bootstrap(bootstrapGeneration);
    if (localBootstrap === null) {
      localBootstrap = bootstrapGeneration().catch((error: unknown) => {
        localBootstrap = null;
        throw error;
      });
    }
    return localBootstrap;
  };

  /** 为 stateless 首次连接读取/建立当前代次（历史导入优先，失败回退空基线）。 */
  const ensureGeneration = async (): Promise<string> => {
    if (cachedGeneration !== null) return cachedGeneration;
    try {
      cachedGeneration = await bootstrapOnce();
    } catch (error) {
      reportError("sync host history bootstrap failed; falling back to empty baseline", error);
      cachedGeneration = await ensureBaseline();
    }
    return cachedGeneration;
  };

  /**
   * 握手预处理：客户端的 scope 永不参与服务端寻址；stateless HELLO 缺 generation 时
   * 按认证 scope 建立/读取当前代次后再交给 provider。其它帧原样透传。
   */
  const prepareInbound = async (bytes: Uint8Array): Promise<Uint8Array> => {
    if (bytes.length === 0 || bytes[0] !== 0x7b || bytes.length > MAX_CONTROL_FRAME_BYTES) return bytes;
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      return bytes;
    }
    if (!isRecord(parsed) || parsed.type !== "HELLO" || parsed.protocolVersion !== 1) return bytes;
    const generation =
      typeof parsed.generation === "string" && parsed.generation.length > 0
        ? parsed.generation
        : await ensureGeneration();
    try {
      return encodeSyncFrame(parseSyncFrame({ ...parsed, scope, generation }));
    } catch (error) {
      throw new SyncProtocolError("MALFORMED_FRAME", {
        cause: error,
        message: "HELLO cannot be bound to the authenticated scope",
      });
    }
  };

  let closed = false;
  /** 入口停止只作用于新协议投影旁路；旧 relay 投影路径不受影响，连接本身也不关闭。 */
  let stopped = false;
  const tickInterval = input.runtimeConfig.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  if (!Number.isSafeInteger(tickInterval) || tickInterval <= 0) {
    await runtime.dispose();
    sharedStore?.release();
    throw new Error("sync host config rejected: tickIntervalMs must be a positive integer");
  }

  const tickLoop = async (): Promise<void> => {
    if (closed) return;
    try {
      await runtime.tick();
    } catch (error) {
      reportError("sync host tick failed", error);
    }
  };
  const timer = setInterval(() => {
    void tickLoop();
  }, tickInterval) as ReturnType<typeof setInterval> & { unref?: () => void };
  timer.unref?.();

  /**
   * 入口失败即停止新投影：失败事件不推进 ingressSeq，继续接收会在同一条流里留下永久缺口。
   * 只报告触发停止的第一次失败（reporter 自身仍按时间窗有界输出），后续事件直接丢弃、不再排队。
   */
  const ingressFailures = createIngressFailureReporter({ report: reportError, now: () => clock.now() });
  const stopIngress = (error: unknown): void => {
    if (stopped) return;
    stopped = true;
    ingressFailures.report(error);
    input.onIngressStopped?.(error);
  };
  /**
   * 同 scope 已有其他连接的写者时，本连接是 follower：实时入口丢弃，靠 tick 从共享 store 追赶。
   * 这是多标签页的正常竞争，不得把投影入口升级成 `stopped`（那会同时停掉订阅与追赶）。
   * 短暂退避避免每条增量都打一次存储；时钟前进后会再次尝试，leader 退出后可自然接管。
   */
  const FOLLOWER_RETRY_MS = 1_000;
  let writerRetryAtMs = 0;
  const acceptEvents = (events: readonly SyncIngressEvent[]): void => {
    if (stopped || events.length === 0) return;
    void (async () => {
      for (const event of events) {
        if (stopped) return;
        if (writerRetryAtMs > clock.now()) continue;
        try {
          await runtime.acceptIngress(event);
        } catch (error) {
          if (isScopeBusy(error)) {
            writerRetryAtMs = clock.now() + FOLLOWER_RETRY_MS;
            continue;
          }
          stopIngress(error);
          return;
        }
      }
    })();
  };

  const mappedEvents = (event: SyncHostNormalizedEvent): readonly SyncIngressEvent[] => {
    const turnId = typeof event.turnId === "string" && event.turnId.length > 0 ? event.turnId : null;
    if (turnId === null) return [];
    const update = event.update;
    switch (event.type) {
      case "message_delta":
        return normalizeAcpSessionUpdate({
          sessionUpdate: "agent_message_chunk",
          content: event.content ?? update.content,
          turnId,
        });
      case "reasoning_delta":
        return normalizeAcpSessionUpdate({
          sessionUpdate: "agent_thought_chunk",
          content: event.content ?? update.content,
          turnId,
        });
      case "tool_call_started":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_update", turnId });
      case "tool_call_updated":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_update", turnId });
      // 私有结果/错误帧的终态由帧类型表达；不能退化成 tool_call_update，否则无 status 时永远 running。
      case "tool_call_completed":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_result", turnId });
      case "tool_call_failed":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_error", turnId });
      case "permission_requested":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "permission_request", turnId });
      case "permission_resolved":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "permission_response", turnId });
      case "turn_failed":
        return [
          semanticEvent(turnId, "error", {
            entityId: `${turnId}:error`,
            metadata: { status: "failed" },
          }),
        ];
      case "turn_cancelled":
      case "turn_interrupted":
        return [
          semanticEvent(turnId, "cancel", {
            entityId: `${turnId}:cancel`,
            metadata: { status: "cancelled" },
          }),
        ];
      // turn_completed 的正常终结需要存储侧 finalDescriptor（入口缺口①），当前不伪造 final。
      // user_message 由后端单写，Agent 回显不得再次写入。
      default:
        return [];
    }
  };

  return {
    scope,
    get closed() {
      return closed;
    },
    async onInboundBytes(bytes: Uint8Array): Promise<void> {
      if (closed) return;
      await runtime.onInboundBytes(await prepareInbound(bytes));
    },
    acceptNormalizedEvent(event: SyncHostNormalizedEvent): void {
      if (closed) return;
      acceptEvents(mappedEvents(event));
    },
    acceptUserMessage(turnId: string, text: string): void {
      if (closed || turnId.length === 0 || text.length === 0) return;
      acceptEvents([
        {
          kind: "text-delta",
          turnId,
          entryId: `${turnId}:user`,
          contentSlot: USER_CONTENT_SLOT,
          contentType: TEXT_CONTENT_TYPE,
          delta: text,
          idempotent: true,
        },
      ]);
    },
    async importHistory(historyInput): Promise<{
      generation: string;
      pointerRevision: number;
      contentDocIds: readonly string[];
    }> {
      if (closed) throw new Error("sync host session is closed");
      if (historyInput.records.length === 0) {
        throw new Error("sync host history import requires a non-empty stable object list");
      }
      return await commitHistory(historyInput.acpSessionId, historyInput.records);
    },
    async tick(): Promise<void> {
      await tickLoop();
    },
    diagnostics(): SyncTransportDiagnostics {
      return runtime.transportDiagnostics();
    },
    ingressDiagnostics(): { total: number; lastCode: string | null; stopped: boolean } {
      return { ...ingressFailures.diagnostics(), stopped };
    },
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        await runtime.dispose();
      } catch (error) {
        reportError("sync host dispose failed", error);
      } finally {
        sharedStore?.release();
      }
    },
  };
}

/** 与 ingress 的 semanticEvent 同形：这里只构造 error/cancel 两种轮次屏障。 */
function semanticEvent(turnId: string, kind: "error" | "cancel", payload: Record<string, unknown>): SyncIngressEvent {
  return {
    kind: "semantic",
    turnId,
    entryId: `${turnId}:assistant`,
    contentSlot: SEMANTIC_CONTENT_SLOT,
    contentType: SEMANTIC_CONTENT_TYPE,
    semantic: { kind, payload },
  };
}
