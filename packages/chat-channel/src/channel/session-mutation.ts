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
}
