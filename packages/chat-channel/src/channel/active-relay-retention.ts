import { TURN_TERMINAL_STATUSES } from "../schema";
import { readActiveTurn } from "../state/chat-writer";
import type { DocManager } from "../state/doc-manager";
import type { SharedRelay } from "./connection-types";
import type { GatewayDependencies } from "./gateway";
import { failPendingSessionMutations } from "./session-mutation";
import { failPendingUserInputRequests } from "./user-input-pending";

/** 在途 prompt 或当前 relay 确认的未结束 turn 必须继续接收最终回执。 */
export function hasActiveRelayWork(shared: SharedRelay, docManager: DocManager): boolean {
  if (shared.pendingPromptIds?.size) return true;
  const session = docManager.getSessionYdoc(shared.rcsSessionId);
  if (!session) return false;
  const turn = readActiveTurn(session);
  return Boolean(
    turn.turnId && turn.turnId === shared.liveTurnId && turn.turnStatus && !TURN_TERMINAL_STATUSES.has(turn.turnStatus),
  );
}

/** 回复收口后尝试释放零页面连接的 relay；Doc 销毁代表运行实例强制回收。 */
export function watchActiveRelay(shared: SharedRelay, docManager: DocManager, release: () => void): () => void {
  const session = docManager.getSessionYdoc(shared.rcsSessionId);
  if (!session) return () => {};
  // pendingPromptIds 在投影终态之后消费，微任务中同时核对两者。
  const onUpdate = () =>
    queueMicrotask(() => {
      if (!shared.destroyed && shared.refCount === 0 && !hasActiveRelayWork(shared, docManager)) release();
    });
  const onDestroy = () => {
    if (shared.refCount === 0) release();
  };
  shared.checkRetention = onUpdate;
  session.on("update", onUpdate);
  session.on("destroy", onDestroy);
  return () => {
    shared.checkRetention = undefined;
    session.off("update", onUpdate);
    session.off("destroy", onDestroy);
  };
}

/** 统一释放页面或活动回复持有的共享 relay 资源。 */
export function releaseGatewayRelay(shared: SharedRelay | undefined, dependencies: GatewayDependencies): void {
  if (!shared) return;
  shared.destroyed = true;
  shared.stopRetentionWatch?.();
  shared.stopRetentionWatch = undefined;
  shared.releaseRetained = undefined;
  // 释放连接代次的执行资源，命令结果仍在有界去重窗口内保留。
  dependencies.sessionChannel.disposeRcsSession(shared.rcsSessionId);
  if (shared.sessionListTimer) {
    clearInterval(shared.sessionListTimer);
    shared.sessionListTimer = undefined;
  }
  shared.pendingSessionSyncIds?.clear();
  shared.latestSessionSyncRpcId = null;
  shared.pendingPromptIds?.clear();
  shared.pendingPromptTurns?.clear();
  failPendingSessionMutations(shared);
  // 在途 steer 请求随 relay 释放一并失败：回执不再可达，悬挂会让前端停在"发送中"
  failPendingUserInputRequests(shared);
  if (shared.replayWindowTimer) {
    clearTimeout(shared.replayWindowTimer);
    shared.replayWindowTimer = null;
  }
  shared.replaySkipSynthesis = undefined;
  try {
    dependencies.broadcaster.unregisterYjsDocListener(`chat:${shared.rcsSessionId}`);
    dependencies.broadcaster.unregisterYjsDocListener(`session:${shared.rcsSessionId}`);
  } catch {
    /* ignore */
  }
  try {
    shared.unsubscribe?.();
  } catch {
    /* ignore */
  }
  try {
    shared.handle.close(1000, "all yjs frontend clients disconnected");
  } catch {
    /* ignore */
  }
}
