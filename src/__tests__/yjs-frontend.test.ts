import { describe, expect, test } from "bun:test";
import {
  handleYjsWsClose,
  handleYjsWsMessage,
  handleYjsWsOpen,
  translateSimpleAction,
} from "../transport/relay/yjs-frontend";

describe("translateSimpleAction compatibility facade", () => {
  // 稳定 facade 必须继续暴露路由所需的 WS 生命周期 handlers 与 action 翻译器。
  test("exports websocket lifecycle handlers", () => {
    expect(handleYjsWsOpen).toBeFunction();
    expect(handleYjsWsMessage).toBeFunction();
    expect(handleYjsWsClose).toBeFunction();
    expect(translateSimpleAction).toBeFunction();
  });

  // 旧路由导出的兼容门面须为不同环境请求保留各自解析出的 cwd
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
