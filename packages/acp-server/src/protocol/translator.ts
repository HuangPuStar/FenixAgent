// packages/acp-server/src/action-translator.ts
// 前端 action → ACP JSON-RPC 翻译。
// 纯函数，不依赖任何 I/O 或框架。

/**
 * 将前端的简化操作转换为 ACP JSON-RPC 请求。
 *
 * workspacePath 由服务端根据已认证的 environment 解析，不可信任浏览器传入的值。
 *
 * @param parsed  前端发来的 { action, ... }
 * @param workspacePath 环境工作目录（服务端解析后注入）
 * @param rpcId   JSON-RPC 请求 id。调用方必须提供，避免消息被当作 notification 而非 request。
 */
export function translateSimpleAction(
  parsed: Record<string, unknown>,
  workspacePath: string | null | undefined,
  rpcId: number,
): Record<string, unknown> {
  const action = parsed.action as string;
  const id = rpcId;
  switch (action) {
    case "send_prompt":
      // 携带目标 sessionId（服务端 forwardYjsAction 注入，来自绑定的 acpSessionId）：
      // acp-dispatcher 据此精确路由 prompt；旧客户端不带时字段缺失，dispatcher
      // fallback 到连接级当前会话（向后兼容，但多会话共享 relay 时可能串会话）。
      return {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { content: parsed.content, sessionId: parsed.sessionId },
      };
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
