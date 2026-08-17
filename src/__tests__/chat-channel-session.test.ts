import { describe, expect, test } from "bun:test";
import { translateSimpleAction } from "@fenix/chat-channel";

describe("translateSimpleAction", () => {
  // translateSimpleAction 由 @fenix/chat-channel 包导出（C2 迁入），路由经包内 protocol 使用。
  test("exports translateSimpleAction", () => {
    expect(translateSimpleAction).toBeFunction();
  });

  // 旧路由导出的兼容门面须为不同环境请求保留各自解析出的 cwd
  test("list_sessions keeps each resolved workspace path in cwd", () => {
    const firstWorkspacePath = "/tmp/fenix-workspaces/org_001/user_001/env_001";
    const secondWorkspacePath = "/tmp/fenix-workspaces/org_001/user_001/env_002";

    const firstRpc = translateSimpleAction({ action: "list_sessions" }, firstWorkspacePath, 1);
    const secondRpc = translateSimpleAction({ action: "list_sessions" }, secondWorkspacePath, 1);

    expect(firstRpc).toMatchObject({
      jsonrpc: "2.0",
      method: "session/list",
      params: { cwd: firstWorkspacePath },
    });
    expect(secondRpc).toMatchObject({
      jsonrpc: "2.0",
      method: "session/list",
      params: { cwd: secondWorkspacePath },
    });
  });
});
