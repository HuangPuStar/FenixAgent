// packages/chat-channel/src/channel/sync-connection.ts
// 连接层与新同步 runtime 的适配：帧判据、WS 三原语、按连接创建/关闭 runtime。
//
// 这里只做连接与生命周期适配，不复制协议规则；握手、额度、ACK、封口仍在 `sync/runtime/**`。
// 每条已认证连接独立创建 runtime + 内存 store，同一 scope 的多标签页不共享（主控裁决）。

import type { DocManager } from "../state/doc-manager";
import type { Clock, DigestFn, RandomSource } from "../sync/clock";
import { SyncProtocolError } from "../sync/protocol/errors";
import type { SyncFrameTransport } from "../sync/runtime/egress";
import { createSyncHostSession } from "../sync/runtime/host-session";
import type { SyncStoreRegistry } from "../sync/runtime/store-registry";
import type { ProjectionStore } from "../sync/store/types";
import type { ConnectionRegistry } from "./connection-registry";
import type { ChatSyncProtocolConfig, ClientConnection, SyncConnection, WsConnection } from "./connection-types";
import { type LegacyChatDocumentSource, readLegacyCommittedHistory } from "./legacy-chat-history";
import { logSyncClose, setSyncCloseContextForConnection } from "./sync-close-diagnostics";

const SYNC_FRAME_FIRST_BYTE = 0x7b;
const SYNC_CLOSE_CODE = 1008;
const MAX_CLOSE_REASON_CHARS = 120;
/** 跨进程换代复核周期：不能对每个事件做 Redis I/O，也不能让节点 B 永久停在旧代次。 */
const GENERATION_WATCH_INTERVAL_MS = 2_000;

/** 新协议帧判据：binary 首字节 `{`（UTF-8 JSON）；旧 Yjs 帧首字节为 0x01/0x02/0x03 或 magic 0xa7 0x59。 */
export function isSyncProtocolFrame(data: Uint8Array): boolean {
  return data.length > 0 && data[0] === SYNC_FRAME_FIRST_BYTE;
}

function syncCloseReason(reason: string): string {
  return reason.length > MAX_CLOSE_REASON_CHARS ? reason.slice(0, MAX_CLOSE_REASON_CHARS) : reason;
}

/** 协议错误关闭码：版本/结构错误 1002，超大帧 1009，其余策略关闭 1008。 */
function syncCloseCode(reason: string): number {
  if (reason.startsWith("unsupported protocol version")) return 1002;
  if (/too large/i.test(reason)) return 1009;
  return SYNC_CLOSE_CODE;
}

/** send 返回真实成败，bufferedAmount 取 socket 真值，close 映射为策略关闭（1008）。 */
function createSyncTransport(ws: WsConnection): SyncFrameTransport {
  return {
    send(bytes: Uint8Array): boolean {
      if (ws.readyState !== 1) return false;
      try {
        ws.send(bytes);
        return true;
      } catch {
        return false;
      }
    },
    bufferedAmount(): number {
      return typeof ws.bufferedAmount === "number" ? ws.bufferedAmount : 0;
    },
    close(reason: string): void {
      const code = syncCloseCode(reason);
      logSyncClose(ws, { code, reason, source: "sync-provider" });
      try {
        ws.close(code, syncCloseReason(reason));
      } catch {
        /* 连接已关闭 */
      }
    },
  };
}

/**
 * 为一个已认证连接创建独立同步运行时。
 *
 * scope 由调用方用服务端认证/归属结果构造；初始化失败以 1012 关闭，允许客户端退避重试。
 * 调用方负责释放旧链路连接（handleClose）。
 */
export interface GatewaySyncHostOverrides {
  readonly clock?: Clock;
  readonly random?: RandomSource;
  readonly digest?: DigestFn;
  readonly store?: ProjectionStore;
  /** 同 scope 共享投影存储；Gateway 缺省注入进程内注册表。 */
  readonly storeRegistry?: SyncStoreRegistry;
  readonly tickIntervalMs?: number;
  readonly spoolRootDir?: string;
}

/** 连接层能提供的真实历史来源：旧 Chat Doc + 当前 ACP 会话标识。 */
interface SyncHistoryContext {
  readonly acpSessionId: string | null;
  readonly docs: LegacyChatDocumentSource;
}

/** 总是经 openChat 复核 Redis active generation，不能信任进程内旧 Doc。 */
async function resolveStoreBinding(docs: LegacyChatDocumentSource, rcsSessionId: string) {
  return await docs.openChat(rcsSessionId);
}

export async function attachGatewaySyncConnection(
  ws: WsConnection,
  config: ChatSyncProtocolConfig,
  organizationId: string,
  rcsSessionId: string,
  owner: string,
  reportError: (message: string, error: unknown) => void,
  overrides: GatewaySyncHostOverrides = {},
  history?: SyncHistoryContext,
): Promise<SyncConnection | undefined> {
  try {
    const chatDoc = history === undefined ? undefined : await resolveStoreBinding(history.docs, rcsSessionId);
    // 在同一同步段固定历史与代次，再 acquire；后续换代不能把新历史导入旧 store。
    const records = chatDoc ? readLegacyCommittedHistory(chatDoc.ydoc) : undefined;
    const storeBinding = chatDoc?.generation;
    const historySource =
      records === undefined
        ? undefined
        : {
            acpSessionId: history?.acpSessionId ?? "",
            read: async () => records,
          };
    const runtime = await createSyncHostSession({
      scope: { organizationId, rcsSessionId },
      runtimeConfig: {
        sealGraceMs: config.sealGraceMs,
        retireGraceMs: config.retireGraceMs,
        tickIntervalMs: overrides.tickIntervalMs,
        spoolRootDir: overrides.spoolRootDir,
      },
      transport: createSyncTransport(ws),
      clock: overrides.clock,
      random: overrides.random,
      digest: overrides.digest,
      store: overrides.store,
      storeRegistry: overrides.storeRegistry,
      historySource,
      storeBinding,
      owner,
      onError: reportError,
      onIngressStopped: (error) => {
        reportError("[YJS-FE] sync ingress stopped; closing connection for rebuild", error);
        // 终态错误码让客户端停止静默重连并进入可见错误态（可回退旧通道）。
        if (ws.readyState === 1) ws.close(1011, "sync ingress stopped");
      },
    });
    let watcher: ReturnType<typeof setInterval> | null = null;
    const stopWatcher = (): void => {
      if (watcher !== null) clearInterval(watcher);
      watcher = null;
    };
    const invalidate = (): void => {
      try {
        stopWatcher();
        if (ws.readyState === 1) ws.close(1012, "projection replaced");
        void runtime.dispose().catch((error: unknown) => reportError("[YJS-FE] sync dispose failed", error));
      } catch (error) {
        reportError("[YJS-FE] sync connection invalidation failed", error);
      }
    };
    // 换代只在本进程经 replaceProjection 发生；控制器先失效连接，这里再兜底拒绝旧 store 的写入。
    // 无代次的轻量 Doc 来源（测试/未水合）不做 fencing，生产 openChat 始终返回代次。
    const isCurrent = (): boolean =>
      runtime.closed ||
      !history ||
      storeBinding === undefined ||
      history.docs.getChat(rcsSessionId)?.generation === storeBinding;
    const accept = (action: () => void): void => {
      if (!isCurrent()) {
        invalidate();
        return;
      }
      try {
        action();
      } catch (error) {
        reportError("[YJS-FE] sync event acceptance failed", error);
      }
    };
    if (!isCurrent()) {
      invalidate();
      return;
    }
    // 跨进程：节点 A 换代不会触碰节点 B 的内存 Doc，只能周期复核 Redis active generation。
    if (history?.docs.isGenerationCurrent !== undefined && storeBinding !== undefined) {
      watcher = setInterval(() => {
        void history.docs
          .isGenerationCurrent?.(rcsSessionId, storeBinding)
          .then((current) => {
            if (current === false) invalidate();
          })
          .catch((error: unknown) => reportError("[YJS-FE] sync generation watch failed", error));
      }, GENERATION_WATCH_INTERVAL_MS);
      watcher.unref?.();
    }
    return {
      onInboundBytes: async (bytes) => {
        if (isCurrent()) await runtime.onInboundBytes(bytes);
      },
      acceptNormalizedEvent: (event) => accept(() => runtime.acceptNormalizedEvent(event)),
      acceptUserMessage: (turnId, text) => accept(() => runtime.acceptUserMessage(turnId, text)),
      diagnostics: () => runtime.diagnostics(),
      ingressDiagnostics: () => runtime.ingressDiagnostics(),
      dispose: () => {
        try {
          stopWatcher();
          void runtime.dispose().catch((error: unknown) => reportError("[YJS-FE] sync dispose failed", error));
        } catch (error) {
          reportError("[YJS-FE] sync dispose failed", error);
        }
      },
    };
  } catch (error) {
    reportError("[YJS-FE] Failed to initialize sync protocol runtime", error);
    try {
      ws.close(1012, "sync init retry");
    } catch {
      /* 连接已关闭 */
    }
    return;
  }
}

/**
 * 首次同步帧的 attach 在途登记。
 *
 * 并发首帧若各自看到 `entry.syncConnection === undefined`，会各建一份 runtime；后写覆盖前者，
 * 先建的 provider/subscriber/定时器无人释放。登记按 entry 生命周期托管（WeakMap 随 GC 释放），
 * 落定后立即删除，失败时下一帧可重新尝试。
 */
const pendingSyncAttachments = new WeakMap<ClientConnection, Promise<SyncConnection | null>>();

/**
 * 确保连接级同步 runtime 存在；并发调用共享同一次 attach。
 *
 * 已存在时直接复用。attach 返回 `undefined`（初始化失败）或 reject 时清除在途登记，
 * 下一帧可重试；失败诊断由 attach 自身负责。
 */
export async function ensureGatewaySyncConnection(
  entry: ClientConnection,
  attach: () => Promise<SyncConnection | undefined>,
): Promise<SyncConnection | undefined> {
  if (entry.syncClosed || entry.ws.readyState !== 1) return;
  if (entry.syncConnection) return entry.syncConnection;
  const inflight = pendingSyncAttachments.get(entry);
  if (inflight) return (await inflight) ?? undefined;
  const pending = attach().then((connection) => {
    if (entry.syncClosed || entry.ws.readyState !== 1) {
      connection?.dispose();
      return null;
    }
    if (connection) entry.syncConnection = connection;
    return connection ?? null;
  });
  pendingSyncAttachments.set(entry, pending);
  try {
    return (await pending) ?? undefined;
  } finally {
    if (pendingSyncAttachments.get(entry) === pending) pendingSyncAttachments.delete(entry);
  }
}

/**
 * attach 窗口内入队的用户消息在首个同步帧（HELLO）建立基线后补写。
 * 不能在建 runtime 后立刻写：写者需要已提交基线，否则会停写。
 */
export function flushPendingSyncUserMessages(entry: ClientConnection, connection: SyncConnection): void {
  const pending = entry.pendingSyncUserMessages;
  entry.pendingSyncUserMessages = undefined;
  for (const message of pending ?? []) connection.acceptUserMessage(message.turnId, message.text);
}

/**
 * 处理 binary 帧的新协议分流。
 *
 * 返回 `true` 表示该帧已由本函数处理（新协议或明确拒绝），调用方不得再进入旧 Yjs 分支。
 * 开关关闭时 `{` 帧以明确理由关闭连接，不静默忽略。
 */
export async function routeSyncProtocolFrame(
  entry: ClientConnection | undefined,
  ws: WsConnection,
  data: Uint8Array,
  config: ChatSyncProtocolConfig | undefined,
  reportError: (message: string, error: unknown) => void,
  overrides?: GatewaySyncHostOverrides,
  pending?: {
    readonly registry: Pick<ConnectionRegistry, "bufferPendingBinary" | "pendingTextCount" | "pendingBinaryCount">;
    readonly wsId: string;
    readonly docManager?: Pick<DocManager, "getSessionYdoc" | "getChat" | "openChat">;
  },
): Promise<boolean> {
  if (!isSyncProtocolFrame(data)) return false;
  if (pending) setSyncCloseContextForConnection(pending.registry, ws, pending.wsId, entry, pending.docManager);
  if (!config?.enabled) {
    logSyncClose(ws, { code: SYNC_CLOSE_CODE, reason: "sync protocol disabled", source: "gateway-route" });
    ws.close(SYNC_CLOSE_CODE, "sync protocol disabled");
    return true;
  }
  if (!entry) {
    // 浏览器 open 后 HELLO 可能早于服务端 handleOpen 的异步装配：暂存到 entry 创建。
    if (pending?.registry.bufferPendingBinary(pending.wsId, data)) return true;
    logSyncClose(ws, { code: SYNC_CLOSE_CODE, reason: "sync protocol unavailable", source: "gateway-route" });
    ws.close(SYNC_CLOSE_CODE, "sync protocol unavailable");
    return true;
  }
  // 首次新协议帧到达时才创建 runtime：只说不发新帧的连接不承担内存投影成本。
  // 并发首帧共享同一次 attach，避免重复创建 runtime 后相互覆盖泄漏。
  const syncConnection = await ensureGatewaySyncConnection(entry, () =>
    attachGatewaySyncConnection(
      ws,
      config,
      entry.organizationId ?? entry.userId,
      entry.rcsSessionId,
      `${entry.userId}:${entry.instanceId}`,
      reportError,
      overrides,
      pending?.docManager === undefined ? undefined : { acpSessionId: entry.acpSessionId, docs: pending.docManager },
    ),
  );
  if (!syncConnection) return true;
  try {
    await syncConnection.onInboundBytes(data);
    flushPendingSyncUserMessages(entry, syncConnection);
  } catch (error) {
    reportError("[YJS-FE] sync protocol inbound failed", error);
    const code =
      error instanceof SyncProtocolError
        ? error.code === "FRAME_TOO_LARGE" || error.code === "FRAME_HEADER_TOO_LARGE"
          ? 1009
          : 1002
        : 1011;
    const reason = code === 1009 ? "sync frame too large" : "sync protocol error";
    logSyncClose(ws, { code, reason, source: "gateway-route" });
    ws.close(code, reason);
  }
  return true;
}

/**
 * entry 创建前暂存的同步帧按顺序补交给连接级 runtime。
 *
 * 真实竞态：浏览器 WebSocket open 后立即发送 HELLO，而服务端 handleOpen 仍在异步查询
 * environment / 打开旧 Doc；此时 entry 尚未登记。若不暂存会以 1008 关闭，客户端只看到
 * SYNC_RELAY.SYNC_FAILED（reason 不是 "sync protocol disabled"，不会回退旧路径）。
 */
export async function flushPendingSyncFrames(
  registry: Pick<
    ConnectionRegistry,
    "consumePendingBinary" | "bufferPendingBinary" | "pendingTextCount" | "pendingBinaryCount"
  >,
  wsId: string,
  entry: ClientConnection,
  ws: WsConnection,
  config: ChatSyncProtocolConfig | undefined,
  reportError: (message: string, error: unknown) => void,
  overrides?: GatewaySyncHostOverrides,
  docManager?: Pick<DocManager, "getSessionYdoc" | "getChat" | "openChat">,
): Promise<void> {
  // entry 已创建：刷新诊断上下文，provider 后续关闭时能看到真实的 entry/scope。
  setSyncCloseContextForConnection(registry, ws, wsId, entry);
  for (const frame of registry.consumePendingBinary(wsId) ?? []) {
    await routeSyncProtocolFrame(entry, ws, frame, config, reportError, overrides, {
      registry,
      wsId,
      docManager,
    });
  }
}
