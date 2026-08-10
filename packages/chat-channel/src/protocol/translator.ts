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
      return { jsonrpc: "2.0", id, method: "session/prompt", params: { content: parsed.content } };
    case "cancel":
      // 携带目标 sessionId（前端来自 sessionState.acpSessionId），dispatcher 据此
      // 精确路由到 adapter 注册表中对应 session 的 query；旧客户端不带时字段缺失，
      // dispatcher fallback 到当前会话（向后兼容）。
      return { jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId: parsed.sessionId } };
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
      // 权限响应必须以 JSON-RPC 响应形态发送（id = requestId，result 携带 outcome），
      // 与 acp-link client.respondToPermission 对齐：acp-link server/dispatcher 只解析
      // "result" in msg 的响应（requestId 为 perm_ 前缀）；旧 session/permission 请求
      // 形态在两侧都落 Method not found，属于历史协议缺陷（C5 修复）。
      return {
        jsonrpc: "2.0",
        id: typeof parsed.requestId === "string" ? parsed.requestId : "",
        result: {
          outcome:
            typeof parsed.optionId === "string" && parsed.optionId.length > 0
              ? { outcome: "selected", optionId: parsed.optionId }
              : { outcome: "cancelled" },
        },
      };
    case "set_session_mode":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/setMode",
        params: { modeId: parsed.modeId },
      };
    case "set_session_model":
      // 运行时切换模型（同会话内，后续轮次生效）：machine 端 AcpDispatcher 校验
      // 引擎自报 availableModels 后透传引擎；预选列表校验在 SessionChannel 拦截层完成
      return {
        jsonrpc: "2.0",
        id,
        method: "session/setModel",
        params: { modelId: parsed.modelId },
      };
    default:
      return parsed;
  }
}
