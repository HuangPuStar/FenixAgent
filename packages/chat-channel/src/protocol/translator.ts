// packages/chat-channel/src/protocol/translator.ts
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
      // 携带目标 sessionId（服务端 session-channel 注入，来自绑定的 acpSessionId）：
      // dispatcher 据此精确路由 prompt；旧客户端不带时字段缺失，dispatcher fallback
      // 到连接级当前会话（向后兼容，但多会话共享 relay 时可能串会话——见 session-channel）。
      return {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { content: parsed.content, sessionId: parsed.sessionId },
      };
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
    case "respond_question": // AskUserQuestion 答案必须以 control_response 传输帧回传（非 JSON-RPC！）：
      // acp-link dispatcher 的 handleTransportMessage 只消费 { type: "control_response",
      // request_id, approved, extra } 形态（acp-dispatcher.ts:194）。
      // 多问题（requestedSchema.properties 多个）合并回传 extra.answers 数组
      // （answers[i] = 第 i 个问题的选中 label，按 propertyKeys 顺序对应）；
      // 单问题兼容 extra.outcome.optionId（历史形态，新前端统一走 answers）。
      {
        const optionIds = Array.isArray(parsed.optionIds)
          ? (parsed.optionIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
          : typeof parsed.optionId === "string" && parsed.optionId.length > 0
            ? [parsed.optionId]
            : [];
        return {
          type: "control_response",
          request_id: typeof parsed.questionId === "string" ? parsed.questionId : "",
          approved: optionIds.length > 0,
          extra:
            optionIds.length > 0
              ? { answers: optionIds }
              : { outcome: { optionId: typeof parsed.optionId === "string" ? parsed.optionId : "" } },
        };
      }
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
