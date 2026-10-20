import type { SharedRelay } from "./connection-types";

/** 登记 Agent 会话变更 RPC；成功响应前不得提交命令，超时按失败处理。 */
export function waitForSessionMutation(
  shared: SharedRelay,
  rpcId: number | string,
  timeoutMs = 10_000,
): { completed: Promise<boolean>; cancel: () => void; isCurrent: () => boolean } {
  const generation = shared.sessionSyncGeneration;
  let finish: (succeeded: boolean) => void = () => {};
  let settled = false;
  const completed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    finish = (succeeded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shared.pendingSessionMutations?.delete(rpcId);
      if (!succeeded) invalidateSessionSync(shared, rpcId);
      resolve(succeeded);
    };
  });
  if (!shared.pendingSessionMutations) shared.pendingSessionMutations = new Map();
  shared.pendingSessionMutations.set(rpcId, finish);
  return {
    completed,
    cancel: () => finish(false),
    isCurrent: () => !shared.destroyed && shared.sessionSyncGeneration === generation,
  };
}

/** Relay 断开或释放时使全部在途会话变更失败。 */
export function failPendingSessionMutations(shared: SharedRelay): void {
  for (const finish of Array.from(shared.pendingSessionMutations?.values() ?? [])) finish(false);
  for (const finish of Array.from(shared.pendingSessionCreations?.values() ?? [])) finish(null);
}

/**
 * 登记 create_session 的创建回执：Agent 给出 sessionId 前不得把「创建成功」写进 committed Ack。
 *
 * 与 {@link waitForSessionMutation} 同形（按 RPC id 登记、超时按未拿到回执处理、relay 断开时统一失败），
 * 差别只在于结算值是 session id 而不是布尔：调用方要的是「创建出了哪个会话」。
 * 超时返回 null 而不是抛错——命令本身已经发出，失败面由调用方按「没有回执」处理。
 */
export function waitForSessionCreation(
  shared: SharedRelay,
  rpcId: number | string,
  timeoutMs = 10_000,
): { completed: Promise<string | null>; cancel: () => void; isCurrent: () => boolean } {
  const generation = shared.sessionSyncGeneration;
  let finish: (sessionId: string | null) => void = () => {};
  let settled = false;
  const completed = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => finish(null), timeoutMs);
    finish = (sessionId) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      shared.pendingSessionCreations?.delete(rpcId);
      if (!sessionId) invalidateSessionSync(shared, rpcId);
      resolve(sessionId);
    };
  });
  if (!shared.pendingSessionCreations) shared.pendingSessionCreations = new Map();
  shared.pendingSessionCreations.set(rpcId, finish);
  return {
    completed,
    cancel: () => finish(null),
    isCurrent: () => !shared.destroyed && shared.sessionSyncGeneration === generation,
  };
}

/** 结算 create_session 回执；未登记（load/resume 或已结算）时无副作用。 */
export function settleSessionCreation(shared: SharedRelay, rpcId: number | string, sessionId: string | null): void {
  shared.pendingSessionCreations?.get(rpcId)?.(sessionId);
}

/** 登记切换请求及回放目标，发送命令的已确认绑定仍由 SessionChannel 持有。 */
export function registerSessionSync(shared: SharedRelay, rpcId: number | string, sessionId?: string): void {
  shared.pendingSessionSyncIds ??= new Set();
  shared.pendingSessionSyncIds.add(rpcId);
  shared.latestSessionSyncRpcId = rpcId;
  shared.pendingSessionTarget = { rpcId, sessionId };
  shared.sessionSyncGeneration = (shared.sessionSyncGeneration ?? 0) + 1;
}

/** 仅失效本次已登记的同步请求，旧超时不能使后续切换丢失提交权。 */
function invalidateSessionSync(shared: SharedRelay, rpcId: number | string): void {
  const registered = shared.pendingSessionSyncIds?.delete(rpcId) === true;
  const ownsTarget = shared.pendingSessionTarget?.rpcId === rpcId;
  if (ownsTarget) shared.pendingSessionTarget = undefined;
  if (shared.latestSessionSyncRpcId === rpcId) shared.latestSessionSyncRpcId = null;
  if (registered || ownsTarget) shared.sessionSyncGeneration = (shared.sessionSyncGeneration ?? 0) + 1;
}
