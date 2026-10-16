import type { SharedRelay } from "./connection-types";

/** 登记 Agent 会话变更 RPC；成功响应前不得提交命令，超时按失败处理。 */
export function waitForSessionMutation(
  shared: SharedRelay,
  rpcId: number | string,
  timeoutMs = 10_000,
): { completed: Promise<boolean>; cancel: () => void } {
  let finish: (succeeded: boolean) => void = () => {};
  const completed = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    finish = (succeeded) => {
      clearTimeout(timer);
      shared.pendingSessionMutations?.delete(rpcId);
      resolve(succeeded);
    };
  });
  if (!shared.pendingSessionMutations) shared.pendingSessionMutations = new Map();
  shared.pendingSessionMutations.set(rpcId, finish);
  return { completed, cancel: () => finish(false) };
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
): { completed: Promise<string | null>; cancel: () => void } {
  let finish: (sessionId: string | null) => void = () => {};
  const completed = new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => finish(null), timeoutMs);
    finish = (sessionId) => {
      clearTimeout(timer);
      shared.pendingSessionCreations?.delete(rpcId);
      resolve(sessionId);
    };
  });
  if (!shared.pendingSessionCreations) shared.pendingSessionCreations = new Map();
  shared.pendingSessionCreations.set(rpcId, finish);
  return { completed, cancel: () => finish(null) };
}

/** 结算 create_session 回执；未登记（load/resume 或已结算）时无副作用。 */
export function settleSessionCreation(shared: SharedRelay, rpcId: number | string, sessionId: string | null): void {
  shared.pendingSessionCreations?.get(rpcId)?.(sessionId);
}
