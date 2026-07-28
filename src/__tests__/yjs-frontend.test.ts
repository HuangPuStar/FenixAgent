import { describe, expect, test } from "bun:test";
import { translateSimpleAction } from "../transport/relay/yjs-frontend";

describe("translateSimpleAction", () => {
  // 前端请求与 agent status 自动请求共用转译函数，均须保留各自环境的 cwd
  test("list_sessions keeps each resolved workspace path in cwd", () => {
    const firstWorkspacePath = "/tmp/fenix-workspaces/org_001/user_001/env_001";
    const secondWorkspacePath = "/tmp/fenix-workspaces/org_001/user_001/env_002";

    const firstRpc = translateSimpleAction({ action: "list_sessions" }, firstWorkspacePath);
    const secondRpc = translateSimpleAction({ action: "list_sessions" }, secondWorkspacePath);

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
