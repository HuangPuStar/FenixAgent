/** JSON-RPC 请求 id 计数器（无 id 的请求被当作 notification，agent 不会返回 result） */
let rpcIdSeq = 0;

/**
 * 将前端的简化操作转换为 ACP JSON-RPC 请求。
 * workspacePath 始终由服务端根据已认证的 environment 解析，不能信任浏览器传入的路径。
 */
export function translateSimpleAction(
  parsed: Record<string, unknown>,
  workspacePath?: string | null,
): Record<string, unknown> {
  const action = parsed.action as string;
  const id = ++rpcIdSeq;
  switch (action) {
    case "send_prompt":
      return { jsonrpc: "2.0", id, method: "session/prompt", params: { content: parsed.content } };
    case "cancel":
      return { jsonrpc: "2.0", id, method: "session/cancel", params: {} };
    case "create_session":
      return { jsonrpc: "2.0", id, method: "session/new", params: { cwd: workspacePath } };
    case "load_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/load",
        params: { sessionId: parsed.sessionId, cwd: workspacePath },
      };
    case "resume_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/resume",
        params: { sessionId: parsed.sessionId, cwd: workspacePath },
      };
    case "list_sessions":
      return { jsonrpc: "2.0", id, method: "session/list", params: { cwd: workspacePath } };
    case "rename_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/rename",
        params: { sessionId: parsed.sessionId, title: parsed.title },
      };
    case "delete_session":
      return { jsonrpc: "2.0", id, method: "session/delete", params: { sessionId: parsed.sessionId } };
    case "respond_permission":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/permission",
        params: { requestId: parsed.requestId, optionId: parsed.optionId },
      };
    case "set_session_mode":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/setMode",
        params: { modeId: parsed.modeId },
      };
    default:
      return parsed;
  }
}
