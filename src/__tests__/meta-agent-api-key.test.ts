import { describe, expect, mock, test } from "bun:test";

mock.module("../db", () => ({ db: {} }));
mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      createApiKey: mock(() =>
        Promise.resolve({
          key: "rcs_test_meta_api_key_1234567890",
        }),
      ),
    },
  },
}));
mock.module("../services/environment-web", () => ({
  createWebEnvironment: mock(() => Promise.resolve({ id: "env-meta-1" })),
  listEnvironmentsWithInstances: mock(() => Promise.resolve([])),
}));
mock.module("../services/instance", () => ({
  spawnInstanceFromEnvironment: mock(() =>
    Promise.resolve({
      id: "inst-1",
      userId: "user-1",
      port: 8888,
      pid: 123,
      status: "running",
      command: "",
      error: null,
      apiKey: "",
      createdAt: new Date(),
      environmentId: "env-meta-1",
      sessionId: undefined,
      instanceNumber: 1,
    }),
  ),
}));
mock.module("../services/config/agent-config", () => ({
  getAgentConfig: mock(() => Promise.resolve({ id: "ac-1" })),
  createAgentConfig: mock(() => Promise.resolve({ id: "ac-1" })),
}));
mock.module("../services/config/skill", () => ({
  upsertSkill: mock(() => Promise.resolve()),
}));
mock.module("../services/config/skill-meta-content", () => ({
  META_SKILL_NAME: "meta-agent-control",
  META_SKILL_DESCRIPTION: "Meta Agent control skill",
  writeMetaSkillFile: mock(() => Promise.resolve()),
}));

// ensureMetaEnvironment 使用 better-auth createApiKey
describe("Meta Agent API Key 注入", () => {
  test("ensureMetaEnvironment 应创建 API key 并传入 extraEnv", async () => {
    const { ensureMetaEnvironment } = await import("../services/meta-agent");

    const ctx = {
      organizationId: "org-1",
      userId: "user-1",
      role: "owner" as const,
    };

    const result = await ensureMetaEnvironment(ctx, new Request("http://localhost"));
    expect(result).toBeDefined();
    expect(result.environmentId).toBeDefined();

    const { spawnInstanceFromEnvironment } = await import("../services/instance");
    const spawnCall = (spawnInstanceFromEnvironment as any).mock.calls.at(-1);
    expect(spawnCall).toBeDefined();
    const extraEnv = spawnCall![3];
    expect(extraEnv).toBeDefined();
    expect(extraEnv.USER_META_API_KEY).toBe("rcs_test_meta_api_key_1234567890");
  });
});
