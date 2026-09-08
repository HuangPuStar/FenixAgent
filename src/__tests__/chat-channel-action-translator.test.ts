import { describe, expect, test } from "bun:test";
import { translateSimpleAction } from "@fenix/chat-channel";

describe("translateSimpleAction", () => {
  // 每个已支持的前端 action 都应映射到既有的 ACP method 和参数形状
  test("translates every supported action", () => {
    const workspacePath = "/workspace/project";
    const cases: Array<{
      action: Record<string, unknown>;
      method: string;
      params: Record<string, unknown>;
    }> = [
      {
        action: { action: "send_prompt", content: [{ type: "text", text: "hello" }] },
        method: "session/prompt",
        params: { content: [{ type: "text", text: "hello" }] },
      },
      { action: { action: "cancel" }, method: "session/cancel", params: {} },
      { action: { action: "create_session" }, method: "session/new", params: { cwd: workspacePath } },
      {
        action: { action: "load_session", sessionId: "session-load" },
        method: "session/load",
        params: { sessionId: "session-load", cwd: workspacePath },
      },
      {
        action: { action: "resume_session", sessionId: "session-resume" },
        method: "session/resume",
        params: { sessionId: "session-resume", cwd: workspacePath },
      },
      { action: { action: "list_sessions" }, method: "session/list", params: { cwd: workspacePath } },
      {
        action: { action: "rename_session", sessionId: "session-rename", title: "Renamed" },
        method: "session/rename",
        params: { sessionId: "session-rename", title: "Renamed" },
      },
      {
        action: { action: "delete_session", sessionId: "session-delete" },
        method: "session/delete",
        params: { sessionId: "session-delete" },
      },
      { action: { action: "set_session_mode", modeId: "plan" }, method: "session/setMode", params: { modeId: "plan" } },
    ];

    for (const { action, method, params } of cases) {
      expect(translateSimpleAction(action, workspacePath, 1)).toMatchObject({
        jsonrpc: "2.0",
        method,
        params,
      });
    }
  });

  // respond_permission 必须以 JSON-RPC 响应形态发送（id = requestId，result 携带 outcome），
  // 与 acp-link client.respondToPermission 对齐：acp-link server/dispatcher 只解析
  // "result" in msg 的响应，旧 session/permission 请求形态会落 Method not found（C5 修复）
  test("translates respond_permission into a JSON-RPC response with outcome", () => {
    const workspacePath = "/workspace/project";
    const allow = translateSimpleAction(
      { action: "respond_permission", requestId: "request-1", optionId: "allow" },
      workspacePath,
      1,
    );
    expect(allow).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      result: { outcome: { outcome: "selected", optionId: "allow" } },
    });

    // optionId 为空/缺省 → cancelled（前端 deny 约定传 null）
    const deny = translateSimpleAction(
      { action: "respond_permission", requestId: "request-1", optionId: null },
      workspacePath,
      1,
    );
    expect(deny).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      result: { outcome: { outcome: "cancelled" } },
    });
  });

  // 不认识的 action 必须保持原始对象透传，供现有调用方自行处理
  test("passes through unknown actions unchanged", () => {
    const action = { action: "custom_action", payload: { enabled: true } };

    expect(translateSimpleAction(action, undefined, 1)).toBe(action);
  });

  // respond_question 必须以 control_response 传输帧回传（非 JSON-RPC！）：
  // acp-link dispatcher 的 handleTransportMessage 只消费 { type: "control_response",
  // request_id, approved, extra } 形态，extra.answers 为选中选项 label 数组
  // （多问题按问题顺序合并回传）
  test("translates respond_question into a control_response transport frame", () => {
    const workspacePath = "/workspace/project";
    const frame = translateSimpleAction(
      { action: "respond_question", questionId: "iqa_1", optionIds: ["production"] },
      workspacePath,
      1,
    );
    expect(frame).toEqual({
      type: "control_response",
      request_id: "iqa_1",
      approved: true,
      extra: { answers: ["production"] },
    });

    // 多问题合并答案：answers 数组按问题顺序
    const multi = translateSimpleAction(
      { action: "respond_question", questionId: "iqa_1", optionIds: ["production", "all"] },
      workspacePath,
      1,
    );
    expect(multi).toEqual({
      type: "control_response",
      request_id: "iqa_1",
      approved: true,
      extra: { answers: ["production", "all"] },
    });

    // 单题多选答案保持嵌套数组，acp-link 据此还原 JSON Schema array 值。
    const multiSelect = translateSimpleAction(
      { action: "respond_question", questionId: "iqa_1", answers: [["web", "server"]] },
      workspacePath,
      1,
    );
    expect(multiSelect).toEqual({
      type: "control_response",
      request_id: "iqa_1",
      approved: true,
      extra: { answers: [["web", "server"]] },
    });
  });

  // respond_question 选项为空（用户取消/跳过）→ approved=false 且 extra 无有效答案：
  // acp-link adapter 侧解析不到 answers 时 resolve 空答案，agent 按空答案继续
  test("translates respond_question without optionIds as declined", () => {
    const frame = translateSimpleAction({ action: "respond_question", questionId: "iqa_1" }, undefined, 1);
    expect(frame).toEqual({
      type: "control_response",
      request_id: "iqa_1",
      approved: false,
      extra: { outcome: { optionId: "" } },
    });
  });
});
