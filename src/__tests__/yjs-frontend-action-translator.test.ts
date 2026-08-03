import { describe, expect, test } from "bun:test";
import { translateSimpleAction } from "@fenix/acp-server";

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
      {
        action: { action: "respond_permission", requestId: "request-1", optionId: "allow" },
        method: "session/permission",
        params: { requestId: "request-1", optionId: "allow" },
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

  // 不认识的 action 必须保持原始对象透传，供现有调用方自行处理
  test("passes through unknown actions unchanged", () => {
    const action = { action: "custom_action", payload: { enabled: true } };

    expect(translateSimpleAction(action, undefined, 1)).toBe(action);
  });
});
