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
import { resolveSyncRuntimeConfig, type SyncRuntimeConfigOverrides } from "./config";
import type { SyncFrameTransport } from "./egress";
import { ensureBaselineGeneration } from "./host-baseline";
import { normalizeAcpSessionUpdate, type SyncIngressEvent } from "./ingress";
import { createSyncScopeRuntime, type SyncTransportDiagnostics } from "./scope-runtime";

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
  /** 释放 runtime、定时器与内存投影；幂等。 */
  dispose(): Promise<void>;
  readonly closed: boolean;
}

const DEFAULT_TICK_INTERVAL_MS = 100;
const HISTORY_LEASE_TTL_MS = 30_000;
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
  readonly owner?: string;
  readonly onError?: (message: string, error: unknown) => void;
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
  const store =
    input.store ??
    new MemoryProjectionStore({
      clock,
      digest,
      capacity: config.capacity,
      lifecycle: config.lifecycle,
    });
  const runtime = await createSyncScopeRuntime({
    scope,
    config,
    clock,
    digest,
    random,
    store,
  });
  runtime.attachTransport(input.transport);

  const reportError = input.onError ?? noop;
  const owner = input.owner ?? `${scope.organizationId}:${scope.rcsSessionId}`;
  const key = scopeKey(scope);
  let cachedGeneration: string | null = null;

  /** 为 stateless 首次连接读取/建立空基线代次（实现集中在 host-baseline.ts）。 */
  const ensureGeneration = async (): Promise<string> => {
    if (cachedGeneration !== null) return cachedGeneration;
    cachedGeneration = await ensureBaselineGeneration({ store, scope, owner, clock, digest, random });
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
  const tickInterval = input.runtimeConfig.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  if (!Number.isSafeInteger(tickInterval) || tickInterval <= 0) {
    await runtime.dispose();
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

  /** 把映射结果按顺序交给 runtime；失败只记录，不阻塞旧 relay 投影。 */
  const acceptEvents = (events: readonly SyncIngressEvent[]): void => {
    if (events.length === 0) return;
    void (async () => {
      for (const event of events) {
        try {
          await runtime.acceptIngress(event);
        } catch (error) {
          reportError("sync host ingress failed", error);
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
      case "tool_call_updated":
      case "tool_call_completed":
      case "tool_call_failed":
        return normalizeAcpSessionUpdate({ ...update, sessionUpdate: "tool_call_update", turnId });
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
      await runtime.history.begin({
        scope,
        acpSessionId: historyInput.acpSessionId,
        owner,
        leaseTtlMs: HISTORY_LEASE_TTL_MS,
      });
      for (const record of historyInput.records) {
        await runtime.history.accept(record.value, record.meta);
      }
      await runtime.history.receivingComplete();
      await runtime.history.buildAndCommit();
      const result = await runtime.history.finalize();
      cachedGeneration = result.generation;
      const generation = await store.readGeneration(key, result.generation);
      return {
        generation: result.generation,
        pointerRevision: result.pointerRevision,
        contentDocIds: generation?.entryRefs.contentDocIds ?? [],
      };
    },
    async tick(): Promise<void> {
      await tickLoop();
    },
    diagnostics(): SyncTransportDiagnostics {
      return runtime.transportDiagnostics();
    },
    async dispose(): Promise<void> {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      try {
        await runtime.dispose();
      } catch (error) {
        reportError("sync host dispose failed", error);
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
