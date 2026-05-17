import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { setTestAuth, resetTestAuth } from "../plugins/auth";
import { setTestTeamContext } from "../services/team-context";

// Mock auth
// Mock config-pg service
mock.module("../services/config-pg", () => ({
  listProviders: async () => [],
  getProvider: async () => null,
  upsertProvider: async () => "prov-id",
  deleteProvider: async () => true,
  addModel: async () => {},
  updateModel: async () => {},
  removeModel: async () => {},
  getUserConfig: async () => ({ defaultAgent: null, currentModel: null, smallModel: null, permission: null }),
  setUserConfig: async () => {},
  listAgentConfigs: async () => [],
  getAgentConfig: async () => null,
  createAgentConfig: async () => {},
  updateAgentConfig: async () => {},
  deleteAgentConfig: async () => [],
  listMcpServers: async () => [],
  getMcpServer: async () => null,
  createMcpServer: async () => {},
  updateMcpServer: async () => {},
  deleteMcpServer: async () => [],
  setMcpServerEnabled: async () => [],
  listSkills: async () => [],
  getSkill: async () => null,
  upsertSkill: async () => "skill-id",
  deleteSkill: async () => true,
  enableSkill: async () => true,
  disableSkill: async () => true,
}));

// Mock skill service
mock.module("../services/skill", () => ({
  SKILLS_DIR: "/tmp/test-skills",
  listSkills: async () => [],
  getSkill: async () => null,
  setSkill: async (_ctx: any, _name: string, data: any) => ({ name: _name, enabled: true, description: data.description, path: "/tmp/test-skills/" + _name + "/SKILL.md" }),
  deleteSkill: async () => true,
  enableSkill: async () => true,
  disableSkill: async () => true,
  listSkillSources: async () => [],
  importSkillDirectories: async () => ({ imported: [], skipped: [], conflicts: [] }),
  importWorkspaceSkillDirectories: async () => ({ imported: [], skipped: [], conflicts: [] }),
  getWorkspaceSkill: async () => null,
  setWorkspaceSkill: async (_ws: string, _name: string, data: any) => ({ name: _name, enabled: true, description: data.description, path: "/tmp/test/" + _name + "/SKILL.md" }),
  deleteWorkspaceSkill: async () => true,
  listWorkspaceSkills: async () => [],
}));

const configRoute = (await import("../routes/web/config/index")).default;

function request(path: string, init?: RequestInit) {
  return configRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("Config Route Integration", () => {
  beforeEach(() => {
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { teamId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestTeamContext({ teamId: "test-team", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    resetTestAuth();
    setTestTeamContext(null);
  });

  test("mocked sessionAuth 通过后返回成功", async () => {
    const res = await request("/web/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("无效 module 返回 404", async () => {
    const res = await request("/web/config/invalid", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    expect(res.status).toBe(404);
  });

  test("providers 路由可达", async () => {
    const res = await request("/web/config/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("models 路由可达", async () => {
    const res = await request("/web/config/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get" }),
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("agents 路由可达", async () => {
    const res = await request("/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });

  test("skills 路由可达", async () => {
    const res = await request("/web/config/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    expect(res.status).not.toBe(404);
    const json = await res.json();
    expect(json.success).toBe(true);
  });
});
