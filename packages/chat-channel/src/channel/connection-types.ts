// packages/chat-channel/src/channel/connection-types.ts
// 连接层类型与共享 ACP relay 的 JSON-RPC 请求所有权状态机。
//
// 同一个 EngineRelayHandle 可能被多个 RCS 连接包装。RPC id、owner 与 relay 生命周期
// 必须按底层 handle 共享；否则不同包装可分配相同 id，并让迟到响应劫持其他会话。

import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import type { NormalizedEvent } from "../schema";

export type RelayMessage = EngineRelayMessage;
export type RpcId = number | string;

/** load/resume 成功后接收无头历史回放的窗口。 */
export const REPLAY_WINDOW_MS = 10_000;
/** prompt 全程无业务入站帧时的失败收敛上限。 */
export const PROMPT_TIMEOUT_MS = 5 * 60_000;
/** session/list 与普通控制 RPC 无响应时的 owner 回收上限。 */
export const CONTROL_RPC_TIMEOUT_MS = 30_000;
/** session/new、session/load、session/resume 无响应时的回滚上限。 */
export const SESSION_SYNC_TIMEOUT_MS = 30_000;

/** 单个会话事务在 ACP 响应前最多暂存的规范化事件数。 */
export const SESSION_TRANSITION_EVENT_LIMIT = 256;
/** 单个会话事务暂存事件的近似 JSON 字节上限。 */
export const SESSION_TRANSITION_BYTE_LIMIT = 1024 * 1024;

/** 最小 WebSocket 连接抽象。 */
export interface WsConnection {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

/** 单个前端 WebSocket 客户端在连接生命周期内的全部状态。 */
export interface ClientConnection {
  ws: WsConnection;
  userId: string;
  agentId: string;
  relayHandle: EngineRelayHandle;
  keepalive: ReturnType<typeof setInterval>;
  instanceId: string;
  rcsSessionId: string;
  acpSessionId: string | null;
  sessionLoaded: boolean;
  workspacePath: string | null;
  openTime: number;
  pendingMessages: string[];
  relayReady: boolean;
  agentStatusReceived: boolean;
}

export type SessionTransitionQueueResult = "queued" | "ignored" | "overflow";

/** session/new、load、resume 在请求响应前持有的隐藏候选投影事务。 */
export interface SessionSyncRequestLifecycle {
  /** load/resume 的目标；create 在响应返回 sessionId 前为 null。 */
  readonly targetSessionId: string | null;
  /** 成功后是否开启历史回放窗口。 */
  readonly replay: boolean;
  /** 仅暂存属于候选 ACP session 的规范化事件；溢出必须安全终止事务。 */
  queueEvent(event: NormalizedEvent): SessionTransitionQueueResult;
  /** 原子停止继续缓冲，并仅返回最终 ACP session 对应的事件。 */
  drainEvents(acceptedSessionId: string): NormalizedEvent[];
  /** 验证响应并在 owner 仍有效时提交隐藏候选投影。 */
  commit(result: Record<string, unknown>, isCurrent: () => boolean): Promise<boolean> | boolean;
  /** 销毁候选投影；必须幂等且不得触碰后继事务。 */
  rollback(): Promise<boolean> | boolean;
}

/** SessionChannel 在分配 id 前提供的不可变请求 owner。 */
export type RpcOwnerInput =
  | { readonly kind: "session-sync"; readonly lifecycle: SessionSyncRequestLifecycle }
  | { readonly kind: "prompt"; readonly turnId: string | null }
  | { readonly kind: "cancel"; readonly turnId: string | null }
  | { readonly kind: "session-list" }
  | { readonly kind: "generic"; readonly method: string };

export type PendingRpcState = "registered" | "sent" | "responding" | "settled" | "superseded" | "aborted";

/** 一个底层 ACP relay handle 的共享 RPC 状态。 */
export interface RelayRpcState {
  lifecycle: "open" | "closing" | "closed";
  epoch: number;
  nextRpcId: number;
  readonly pendingRpcRequests: Map<RpcId, PendingRpc>;
  readonly activeSessionTransitions: Map<string, PendingRpc>;
  readonly relays: Set<SharedRelay>;
  teardownReason: "relay_closed" | "released" | null;
  teardownPromise: Promise<void> | null;
}

/** 物理 relay teardown 的一次性同步 claim；只有 primary 调用方执行跨包装副作用。 */
export interface RelayRpcTeardownClaim {
  readonly primary: boolean;
  readonly reason: "relay_closed" | "released";
  readonly relays: readonly SharedRelay[];
  readonly requests: readonly PendingRpc[];
  readonly cleanup: Promise<void>;
}

/** 唯一 owner 表中的请求实体；对象身份本身就是防止陈旧清理的 capability。 */
export interface PendingRpc {
  readonly id: number;
  readonly token: symbol;
  readonly relayState: RelayRpcState;
  readonly relay: SharedRelay;
  readonly epoch: number;
  readonly owner: RpcOwnerInput;
  readonly abortController: AbortController;
  state: PendingRpcState;
  timeout: ReturnType<typeof setTimeout> | null;
  responsePromise: Promise<void> | null;
}

/** SessionChannel 只依赖该最小预留能力，不接触底层 owner 表。 */
export interface RpcReservation {
  readonly id: number;
  markSent(): boolean;
  abort(): Promise<boolean> | boolean;
}

/**
 * 同一 instance/user/rcsSession 的前端连接共享的包装对象。不同包装仍可能引用同一个
 * EngineRelayHandle，因此 rpcState 由 attachRelayRpcState 按 handle 复用。
 */
export interface SharedRelay {
  handle: EngineRelayHandle;
  unsubscribe: (() => void) | null;
  refCount: number;
  userId: string;
  agentId: string;
  instanceId: string;
  idleMonitorAttached?: boolean;
  rcsSessionId: string;
  workspacePath: string;
  sessionListTimer?: ReturnType<typeof setInterval>;
  destroyed?: boolean;
  relayClosed?: boolean;
  rpcState?: RelayRpcState;
  teardownPromise?: Promise<void> | null;
  lastInboundAt?: number;
  sessionListSkipCount?: number;
  replayWindowUntil: number | null;
  replayTurnId?: string | null;
  replayWindowOwner?: PendingRpc | null;
  replayWindowTimer?: ReturnType<typeof setTimeout> | null;
  replaySkipSynthesis?: boolean;
  callbackAssistant?: { entryId: string; ownerTurnId: string | null } | null;
}

const RELAY_RPC_STATES = new WeakMap<object, RelayRpcState>();

function createRelayRpcState(): RelayRpcState {
  return {
    lifecycle: "open",
    epoch: 0,
    nextRpcId: 0,
    pendingRpcRequests: new Map(),
    activeSessionTransitions: new Map(),
    relays: new Set(),
    teardownReason: null,
    teardownPromise: null,
  };
}

/** 把包装对象附着到其底层 handle 的共享 RPC 状态。 */
export function attachRelayRpcState(shared: SharedRelay): RelayRpcState {
  let state = RELAY_RPC_STATES.get(shared.handle as object);
  if (!state) {
    state = createRelayRpcState();
    RELAY_RPC_STATES.set(shared.handle as object, state);
  }
  state.relays.add(shared);
  shared.rpcState = state;
  return state;
}

/** 读取状态；测试构造的 SharedRelay 也可在首次使用时惰性附着。 */
export function getRelayRpcState(shared: SharedRelay): RelayRpcState {
  return shared.rpcState ?? attachRelayRpcState(shared);
}

/** 包装、底层 handle 与共享生命周期均开放时才允许预留新请求。 */
export function isRelayAvailable(shared: SharedRelay): boolean {
  const state = getRelayRpcState(shared);
  return (
    !shared.destroyed &&
    !shared.relayClosed &&
    shared.handle.state === "open" &&
    state.lifecycle === "open" &&
    state.teardownReason === null &&
    state.relays.has(shared)
  );
}

function allocateRpcId(state: RelayRpcState): number {
  for (let attempt = 0; attempt <= state.pendingRpcRequests.size; attempt++) {
    state.nextRpcId = state.nextRpcId >= Number.MAX_SAFE_INTEGER ? 1 : state.nextRpcId + 1;
    if (!state.pendingRpcRequests.has(state.nextRpcId)) return state.nextRpcId;
  }
  throw new Error("No JSON-RPC request id is available");
}

function clearPendingRpcTimer(request: PendingRpc): void {
  if (request.timeout !== null) clearTimeout(request.timeout);
  request.timeout = null;
}

function removeExactOwner(request: PendingRpc, state: PendingRpcState): boolean {
  const relayState = request.relayState;
  if (relayState.pendingRpcRequests.get(request.id) !== request) return false;
  relayState.pendingRpcRequests.delete(request.id);
  if (relayState.activeSessionTransitions.get(request.relay.rcsSessionId) === request) {
    relayState.activeSessionTransitions.delete(request.relay.rcsSessionId);
  }
  clearPendingRpcTimer(request);
  request.state = state;
  request.abortController.abort();
  return true;
}

async function rollbackOwner(request: PendingRpc): Promise<void> {
  if (request.owner.kind !== "session-sync") return;
  await request.owner.lifecycle.rollback();
}

/**
 * 在同一同步段内分配 id 并写入唯一 owner 表。session transition 会原子剥夺同一
 * RCS 会话的旧 owner；旧事务的异步 rollback 只能销毁自己的候选投影。
 */
export function reserveRelayRpc(shared: SharedRelay, owner: RpcOwnerInput): PendingRpc {
  if (!isRelayAvailable(shared)) throw new Error("Relay is not available");
  const relayState = getRelayRpcState(shared);
  const id = allocateRpcId(relayState);

  let superseded: PendingRpc | undefined;
  if (owner.kind === "session-sync") {
    const current = relayState.activeSessionTransitions.get(shared.rcsSessionId);
    if (current && removeExactOwner(current, "superseded")) superseded = current;
  }

  const request: PendingRpc = {
    id,
    token: Symbol(`rpc:${id}`),
    relayState,
    relay: shared,
    epoch: relayState.epoch,
    owner,
    abortController: new AbortController(),
    state: "registered",
    timeout: null,
    responsePromise: null,
  };
  relayState.pendingRpcRequests.set(id, request);
  if (owner.kind === "session-sync") {
    relayState.activeSessionTransitions.set(shared.rcsSessionId, request);
  }
  if (owner.kind === "session-list" || owner.kind === "generic") {
    request.timeout = setTimeout(() => {
      void abortPendingRpc(request);
    }, CONTROL_RPC_TIMEOUT_MS);
    (request.timeout as { unref?: () => void }).unref?.();
  }

  if (superseded) {
    void rollbackOwner(superseded).catch(() => {
      // 新 owner 已完成同步接管；旧候选回收失败由其 DocManager onError 保留诊断上下文。
    });
  }
  return request;
}

/** send 返回后标记 sent；同步响应已先进入 responding 时仍视为成功发送。 */
export function markPendingRpcSent(request: PendingRpc): boolean {
  if (request.relayState.pendingRpcRequests.get(request.id) !== request) return false;
  if (request.state === "registered") request.state = "sent";
  return request.state === "sent" || request.state === "responding";
}

/** 仅当前 owner 可安装或替换自己的 timeout。 */
export function setPendingRpcTimer(request: PendingRpc, timer: ReturnType<typeof setTimeout>): boolean {
  if (
    request.relayState.pendingRpcRequests.get(request.id) !== request ||
    (request.state !== "registered" && request.state !== "sent")
  ) {
    clearTimeout(timer);
    return false;
  }
  clearPendingRpcTimer(request);
  request.timeout = timer;
  return true;
}

/** 响应按 id 对 owner 做一次 CAS；异步处理完成前 owner 保持在 responding。 */
export function beginRpcResponse(shared: SharedRelay, rpcId: RpcId): PendingRpc | null {
  const relayState = getRelayRpcState(shared);
  if (relayState.lifecycle !== "open" || relayState.teardownReason !== null) return null;
  const request = relayState.pendingRpcRequests.get(rpcId);
  // 同一物理 handle 会把响应分发给多个 listener；只有创建 reservation 的精确包装
  // 才能 claim，否则先执行的错误 listener 会按共享数字 id 劫持另一会话的响应。
  if (request?.relay !== shared || (request.state !== "registered" && request.state !== "sent")) return null;
  if (request.epoch !== relayState.epoch || request.abortController.signal.aborted) return null;
  request.state = "responding";
  clearPendingRpcTimer(request);
  return request;
}

/** 异步 commit 内部的生命周期栅栏。 */
export function isPendingRpcCurrent(request: PendingRpc): boolean {
  return (
    request.relayState.lifecycle === "open" &&
    request.relayState.teardownReason === null &&
    request.relayState.epoch === request.epoch &&
    request.relayState.pendingRpcRequests.get(request.id) === request &&
    request.state === "responding" &&
    !request.abortController.signal.aborted &&
    !request.relay.destroyed &&
    !request.relay.relayClosed &&
    request.relay.handle.state === "open"
  );
}

/** 成功处理后只结算同一对象 owner。 */
export function settlePendingRpc(request: PendingRpc): boolean {
  return removeExactOwner(request, "settled");
}

/** 同步剥夺 owner，供 timeout/failed-send/teardown 在任何 await 前建立栅栏。 */
export function claimPendingRpcAbort(request: PendingRpc, state: "aborted" | "superseded" = "aborted"): boolean {
  return removeExactOwner(request, state);
}

/** 回滚已被剥夺的 session candidate。 */
export async function cleanupAbortedRpc(request: PendingRpc): Promise<void> {
  await rollbackOwner(request);
}

/** 精确 abort；响应处理已经开始后由 response/teardown 路径负责结算。 */
export async function abortPendingRpc(request: PendingRpc): Promise<boolean> {
  if (request.state !== "registered" && request.state !== "sent") return false;
  if (!claimPendingRpcAbort(request)) return false;
  await cleanupAbortedRpc(request);
  return true;
}

/** 当前 RCS 会话仍有效的 session transition。 */
export function getActiveSessionTransition(shared: SharedRelay): PendingRpc | null {
  const state = getRelayRpcState(shared);
  const request = state.activeSessionTransitions.get(shared.rcsSessionId);
  if (!request || request.relay !== shared || request.owner.kind !== "session-sync") return null;
  if (state.pendingRpcRequests.get(request.id) !== request) return null;
  if (request.state !== "registered" && request.state !== "sent" && request.state !== "responding") return null;
  return request;
}

/** 只读快照，供诊断与精确的包装级清理使用。 */
export function listPendingRpcForRelay(shared: SharedRelay): PendingRpc[] {
  return [...getRelayRpcState(shared).pendingRpcRequests.values()].filter((request) => request.relay === shared);
}

function claimRequestsForRelay(shared: SharedRelay): PendingRpc[] {
  const requests = listPendingRpcForRelay(shared);
  return requests.filter((request) => claimPendingRpcAbort(request));
}

/** 已同步剥夺的 owner 先等待在途 response handler，再幂等回滚其候选资源。 */
async function cleanupClaimedRpc(request: PendingRpc): Promise<void> {
  try {
    if (request.responsePromise) await request.responsePromise;
  } finally {
    await cleanupAbortedRpc(request);
  }
}

/**
 * 一次性 claim 底层 handle teardown。首个调用者在任何 await 前冻结全部包装与 owner
 * 快照、推进 epoch 并剥夺 owner；后继监听器仅复用同一 cleanup Promise，不重复副作用。
 */
export function claimRelayRpcTeardown(shared: SharedRelay, reason: "relay_closed" | "released"): RelayRpcTeardownClaim {
  const state = getRelayRpcState(shared);
  if (state.teardownPromise) {
    return {
      primary: false,
      reason: state.teardownReason ?? reason,
      relays: [],
      requests: [],
      cleanup: state.teardownPromise,
    };
  }

  const relays = [...state.relays];
  const requests = [...state.pendingRpcRequests.values()];
  state.lifecycle = "closing";
  state.teardownReason = reason;
  state.epoch += 1;
  if (reason === "relay_closed") {
    for (const relay of relays) relay.relayClosed = true;
  }

  const claimed = requests.filter((request) => claimPendingRpcAbort(request));
  state.pendingRpcRequests.clear();
  state.activeSessionTransitions.clear();
  const cleanup = Promise.allSettled(claimed.map(cleanupClaimedRpc)).then(() => {
    state.lifecycle = "closed";
  });
  state.teardownPromise = cleanup;

  return { primary: true, reason, relays, requests, cleanup };
}

/** 兼容调用入口；新代码若需执行一次性副作用应使用 claimRelayRpcTeardown。 */
export function beginRelayRpcTeardown(shared: SharedRelay): Promise<void> {
  return claimRelayRpcTeardown(shared, "relay_closed").cleanup;
}

/**
 * 释放单个 RCS 包装。非最后包装只剥夺自己的 owner；最后包装同步 claim 物理
 * teardown。返回 true 仅表示本调用拥有主动关闭底层 handle 的权利。
 */
export function releaseRelayRpcState(shared: SharedRelay): {
  readonly shouldCloseHandle: boolean;
  readonly cleanup: Promise<void>;
} {
  const state = getRelayRpcState(shared);
  if (!state.relays.has(shared)) {
    return { shouldCloseHandle: false, cleanup: state.teardownPromise ?? Promise.resolve() };
  }

  const isLastWrapper = state.relays.size === 1;
  if (isLastWrapper) {
    const teardown = claimRelayRpcTeardown(shared, "released");
    state.relays.delete(shared);
    return {
      shouldCloseHandle: teardown.primary && teardown.reason === "released",
      cleanup: teardown.cleanup,
    };
  }

  state.relays.delete(shared);
  const owned = claimRequestsForRelay(shared);
  const ownedCleanup = Promise.allSettled(owned.map(cleanupClaimedRpc)).then(() => undefined);
  return {
    shouldCloseHandle: false,
    cleanup: state.teardownPromise
      ? Promise.all([ownedCleanup, state.teardownPromise]).then(() => undefined)
      : ownedCleanup,
  };
}
