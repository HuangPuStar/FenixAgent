// packages/agent-runtime/src/__tests__/chat-sync-config.test.ts
// 新聊天同步协议的模块配置默认值与覆盖：默认启用，宽限期取装配默认值。

import { describe, expect, test } from "bun:test";
import { createAgentRuntimeModuleConfig } from "../server/testing";

describe("chat sync module config", () => {
  // 默认配置必须启用新协议，避免新部署静默停留在旧同步路径。
  test("默认夹具启用同步协议，并给出 2s / 30s 宽限期", () => {
    const config = createAgentRuntimeModuleConfig();
    expect(config.chatSyncProtocolEnabled).toBe(true);
    expect(config.chatSyncSealGraceMs).toBe(2_000);
    expect(config.chatSyncRetireGraceMs).toBe(30_000);
  });

  // 用例必须能显式关闭开关并覆盖宽限期，验证注入链路而不是只读默认值。
  test("测试可按用例关闭开关并覆盖宽限期", () => {
    const config = createAgentRuntimeModuleConfig({
      chatSyncProtocolEnabled: false,
      chatSyncSealGraceMs: 500,
      chatSyncRetireGraceMs: 60_000,
    });
    expect(config.chatSyncProtocolEnabled).toBe(false);
    expect(config.chatSyncSealGraceMs).toBe(500);
    expect(config.chatSyncRetireGraceMs).toBe(60_000);
  });
});
