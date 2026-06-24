import { afterEach, beforeEach, describe, expect, test } from "bun:test";

describe("agent-sites service — 配置检测", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.AGENT_SITES_BASE_URL = "http://localhost:9999";
    process.env.AGENT_SITES_MASTER_KEY = "test-master-key";
  });

  afterEach(() => {
    process.env = { ...originalEnv } as NodeJS.ProcessEnv;
  });

  test("isAgentSitesConfigured 配置完整返回 true", async () => {
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(true);
  });

  test("isAgentSitesConfigured 缺失 BASE_URL 返回 false", async () => {
    delete process.env.AGENT_SITES_BASE_URL;
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });

  test("isAgentSitesConfigured 缺失 MASTER_KEY 返回 false", async () => {
    delete process.env.AGENT_SITES_MASTER_KEY;
    const { isAgentSitesConfigured } = await import("../services/agent-sites");
    expect(isAgentSitesConfigured()).toBe(false);
  });
});

describe("agent-sites service — 错误类型", () => {
  test("AgentSitesError 正确构造", async () => {
    const { AgentSitesError } = await import("../services/agent-sites");
    const err = new AgentSitesError(401, "Unauthorized");
    expect(err.status).toBe(401);
    expect(err.message).toBe("Unauthorized");
    expect(err.name).toBe("AgentSitesError");
  });
});
