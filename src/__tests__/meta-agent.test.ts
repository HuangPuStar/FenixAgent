import { describe, expect, test, mock, beforeEach } from "bun:test";

const mockCreateWebEnvironment = mock<(params: any) => Promise<any>>();
const mockListEnvironmentsWithInstances = mock<(teamId: string) => Promise<any[]>>();
const mockSpawnInstanceFromEnvironment = mock<(userId: string, envId: string) => Promise<any>>();
const mockUpsertSkill = mock<(ctx: any, name: string, data: any) => Promise<string>>();
const mockGetAgentConfig = mock<(ctx: any, name: string) => Promise<any>>();
const mockCreateAgentConfig = mock<(ctx: any, name: string, data: any) => Promise<any>>();
const mockWriteMetaSkillFile = mock<() => Promise<string>>();
const mockCreateApiKey = mock<(userId: string, label: string, teamId: string, options?: any) => Promise<any>>();

mock.module("../auth/api-key-service", () => ({
  createApiKey: mockCreateApiKey,
  hashApiKey: (key: string) => `hash_${key}`,
}));

mock.module("../services/environment-web", () => ({
  createWebEnvironment: mockCreateWebEnvironment,
  listEnvironmentsWithInstances: mockListEnvironmentsWithInstances,
}));

mock.module("../services/instance", () => ({
  spawnInstanceFromEnvironment: mockSpawnInstanceFromEnvironment,
}));

mock.module("../services/config/skill", () => ({
  upsertSkill: mockUpsertSkill,
}));

mock.module("../services/config/agent-config", () => ({
  getAgentConfig: mockGetAgentConfig,
  createAgentConfig: mockCreateAgentConfig,
}));

mock.module("../services/config/skill-meta-content", () => ({
  META_SKILL_NAME: "workflow-editor",
  META_SKILL_DESCRIPTION: "test",
  writeMetaSkillFile: mockWriteMetaSkillFile,
}));

import { META_ENVIRONMENT_NAME, findMetaEnvironment, ensureMetaEnvironment } from "../services/meta-agent";

const testCtx = {
  teamId: "team-001",
  userId: "user-001",
  role: "owner" as const,
};

beforeEach(() => {
  mockCreateWebEnvironment.mockReset();
  mockListEnvironmentsWithInstances.mockReset();
  mockSpawnInstanceFromEnvironment.mockReset();
  mockUpsertSkill.mockReset();
  mockGetAgentConfig.mockReset();
  mockCreateAgentConfig.mockReset();
  mockWriteMetaSkillFile.mockReset().mockResolvedValue("/tmp/SKILL.md");
  mockCreateApiKey.mockReset().mockResolvedValue({
    record: { id: "key-1", label: "Meta Agent" },
    fullKey: "rcs_test_meta_key_123",
  });
});

// 常量校验
test("META_ENVIRONMENT_NAME 为 meta-agent（kebab-case）", () => {
  expect(META_ENVIRONMENT_NAME).toBe("meta-agent");
});

// findMetaEnvironment
describe("findMetaEnvironment", () => {
  test("从环境列表中找到 name=meta-agent 的环境", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([
      { id: "env-1", name: "my-agent" },
      { id: "env-meta-1", name: "meta-agent" },
      { id: "env-2", name: "another" },
    ]);
    const result = await findMetaEnvironment(testCtx);
    expect(result).toEqual({ id: "env-meta-1", name: "meta-agent" });
  });

  test("列表中不存在 meta-agent 时返回 null", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([{ id: "env-1", name: "my-agent" }]);
    const result = await findMetaEnvironment(testCtx);
    expect(result).toBeNull();
  });
});

// ensureMetaEnvironment
describe("ensureMetaEnvironment", () => {
  test("已存在 meta 环境时直接返回，不重复创建", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([{ id: "env-meta-1", name: "meta-agent" }]);
    mockGetAgentConfig.mockResolvedValueOnce({ id: "ac-meta" });
    mockUpsertSkill.mockResolvedValueOnce("skill-1");
    mockSpawnInstanceFromEnvironment.mockResolvedValueOnce({ id: "inst-1", status: "running" });

    const result = await ensureMetaEnvironment(testCtx);
    expect(result.environmentId).toBe("env-meta-1");
    expect(result.status).toBe("reused");
    expect(mockCreateWebEnvironment).not.toHaveBeenCalled();
  });

  test("不存在 meta 环境时创建并返回", async () => {
    mockListEnvironmentsWithInstances.mockResolvedValueOnce([]);
    mockGetAgentConfig.mockResolvedValueOnce({ id: "ac-meta" });
    mockCreateWebEnvironment.mockResolvedValueOnce({ id: "env-new-meta", name: "meta-agent" });
    mockSpawnInstanceFromEnvironment.mockResolvedValueOnce({ id: "inst-1", status: "running" });
    mockUpsertSkill.mockResolvedValueOnce("skill-1");

    const result = await ensureMetaEnvironment(testCtx);
    expect(result.environmentId).toBe("env-new-meta");
    expect(result.status).toBe("created");
    expect(mockCreateWebEnvironment).toHaveBeenCalledWith(expect.objectContaining({ name: "meta-agent" }));
  });
});
