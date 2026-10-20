import type { ClientConnection, SharedRelay } from "./connection-types";
import type { SessionConnection } from "./session-channel";
import { registerSessionSync, waitForSessionCreation, waitForSessionMutation } from "./session-mutation";
import { registerUserInputRequest } from "./user-input-pending";

let entryRelayNextId = 0;
/** ClientConnection → 包内 SessionConnection 适配（rpcId 与 relay 发送来自连接/共享 relay） */
export function toSessionConnection(
  entry: ClientConnection,
  shared: SharedRelay | undefined,
  onLoadRegistered?: () => void,
): SessionConnection {
  return {
    userId: entry.userId,
    ownerUserId: entry.ownerUserId,
    agentId: entry.agentId,
    instanceId: entry.instanceId,
    rcsSessionId: entry.rcsSessionId,
    acpSessionId: entry.acpSessionId,
    agentStatusReceived: entry.agentStatusReceived,
    sessionLoaded: entry.sessionLoaded,
    workspacePath: entry.workspacePath,
    // 适配对象每次 action 重建，取当前值即可：runtime 在首次同步帧到达后才创建。
    syncConnection: entry.syncConnection,
    sendToRelay: (message) => entry.relayHandle.send(message as never),
    getNextRpcId: () => (shared ? ++shared.nextRpcId : ++entryRelayNextId),
    registerSessionSyncRpcId: (rpcId, targetSessionId) => {
      if (shared) registerSessionSync(shared, rpcId, targetSessionId);
      if (targetSessionId) onLoadRegistered?.();
    },
    registerPendingPrompt: (rpcId, turnId) => {
      if (!shared) return;
      if (!shared.pendingPromptIds) shared.pendingPromptIds = new Set();
      shared.pendingPromptIds.add(rpcId);
      if (turnId) {
        if (!shared.pendingPromptTurns) shared.pendingPromptTurns = new Map();
        shared.pendingPromptTurns.set(rpcId, turnId);
      }
    },
    awaitSessionMutation: (rpcId) => {
      if (!shared) return { completed: Promise.resolve(false), cancel: () => {} };
      return waitForSessionMutation(shared, rpcId);
    },
    // 在途 steer 请求登记：与 prompt / 会话同步同模式挂在 SharedRelay 上，响应由
    // relay-event-handler 按 rpcId 收敛；relay 释放（引用计数归零）时统一失败。
    awaitUserInputRequest: (rpcId, kind, timeoutMs) =>
      shared ? registerUserInputRequest(shared, { rpcId, kind, timeoutMs }) : undefined,
    awaitSessionCreation: (rpcId) => {
      // 没有共享 relay 就没有「谁来结算回执」的一方，直接以空回执完成，避免调用方挂到超时。
      if (!shared) return { completed: Promise.resolve(null), cancel: () => {} };
      return waitForSessionCreation(shared, rpcId);
    },
  };
}
