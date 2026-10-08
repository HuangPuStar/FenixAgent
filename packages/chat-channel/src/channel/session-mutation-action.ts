import { translateSimpleAction } from "../protocol/translator";
import type { DocManager } from "../state/doc-manager";
import type { SessionConnection } from "./session-channel";
import { CommandExecutionError } from "./types";

/** Fenix 标题写入确认后才返回成功；不向 Agent 发送重命名方法。 */
export async function renameSessionAction(
  docManager: DocManager,
  connection: SessionConnection,
  sessionId: string,
  rawTitle: unknown,
  reportError: (message: string, error: unknown) => void,
): Promise<void> {
  if (typeof rawTitle !== "string" || !rawTitle.trim() || rawTitle.length > 200 || !sessionId) {
    throw new CommandExecutionError("ACTION.INVALID_STATE");
  }
  try {
    await docManager.renameSession(connection.rcsSessionId, sessionId, rawTitle.trim(), connection.acpSessionId);
  } catch (error) {
    reportError("[SessionChannel] persistent rename failed", error);
    throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
  }
}

/** Agent 删除确认后移除 Fenix 标题；响应等待器始终由共享 relay 持有并在失败时取消。 */
export async function deleteSessionAction(
  docManager: DocManager,
  connection: SessionConnection,
  sessionId: string,
  rpc: Record<string, unknown>,
  reportError: (message: string, error: unknown) => void,
): Promise<void> {
  if (!connection.awaitSessionMutation) throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
  const mutation = connection.awaitSessionMutation(rpc.id as number | string);
  try {
    await connection.sendToRelay(rpc);
  } catch (error) {
    mutation.cancel();
    reportError("[SessionChannel] relay send failed: action=delete_session", error);
    throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
  }
  if (!(await mutation.completed)) throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
  try {
    await docManager.removeSessionTitle(connection.rcsSessionId, sessionId);
  } catch (error) {
    reportError("[SessionChannel] session title cleanup failed", error);
  }
  try {
    await connection.sendToRelay(
      translateSimpleAction({ action: "list_sessions" }, connection.workspacePath, connection.getNextRpcId()),
    );
  } catch (error) {
    reportError("[SessionChannel] session list refresh failed", error);
  }
}
