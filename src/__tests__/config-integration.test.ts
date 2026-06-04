import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const configRoute = (await import("../routes/web/config/index")).default;

function request(path: string, init?: RequestInit) {
  return configRoute.handle(new Request(`http://localhost${path.replace(/^\/web/, "")}`, init));
}

describe("Config Route Integration", () => {
  beforeEach(() => {
    resetAllStubs();
    stubConfigPg({
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
      getAgentConfigByResourceKey: async () => null,
      getReadableAgentConfigById: async () => null,
      assertAgentConfigInternalWritable: async () => null,
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
      listAgentSkillIds: async () => [],
      syncAgentSkills: async () => {},
    });
    setTestAuth({
      user: { id: "test-user", email: "test@test.com", name: "Test" },
      authContext: { organizationId: "test-team", userId: "test-user", role: "owner" },
    });
    setTestOrgContext({ organizationId: "test-team", userId: "test-user", role: "owner" });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
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

  test("agents list 返回共享 Agent 的 resourceAccess", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          where: async () => [],
          limit: async () => [],
        }),
      }),
    });
    stubConfigPg({
      listAgentConfigs: async () => [
        {
          id: "agc-external",
          name: "shared-agent",
          model: "provider/model",
          mode: "primary",
          description: "shared",
          color: null,
          machineId: null,
          resourceAccess: {
            ownership: "external",
            sourceOrganizationId: "org-source",
            sourceOrganizationName: "Source Team",
            resourceUid: "agc-external",
            resourceKey: "org-source/agc-external",
            manageable: false,
            writable: false,
          },
        },
      ],
      listAgentSkillIds: async () => ["skill-1"],
    });

    const res = await request("/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" }),
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.agents[0].resourceAccess.resourceKey).toBe("org-source/agc-external");
    expect(json.data.agents[0].resourceAccess.ownership).toBe("external");
    expect(json.data.agents[0].modelLabel).toBe("provider/model");
    expect(json.data.agents[0].skillLabels).toEqual([{ id: "skill-1", label: "skill-1" }]);
  });

  test("agents get 可读取外部共享 Agent 详情", async () => {
    stubConfigPg({
      getAgentConfig: async () => ({
        id: "agc-external",
        name: "shared-agent",
        model: "provider/model",
        prompt: "shared prompt",
        steps: 20,
        mode: "primary",
        permission: null,
        variant: null,
        temperature: null,
        topP: null,
        disable: false,
        hidden: false,
        color: null,
        description: "shared",
        knowledge: null,
        machineId: "machine-1",
        resourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org-source",
          sourceOrganizationName: "Source Team",
          resourceUid: "agc-external",
          resourceKey: "org-source/agc-external",
          manageable: false,
          writable: false,
        },
      }),
      listAgentSkillIds: async () => ["skill-1"],
    });

    const res = await request("/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "get", name: "org-source/agc-external" }),
    });
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.resourceAccess.resourceKey).toBe("org-source/agc-external");
    expect(json.data.machineId).toBe("machine-1");
  });

  test("agents set 拒绝修改外部共享 Agent", async () => {
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => {
        throw new AppError("forbidden", "FORBIDDEN", 403);
      },
    });

    const res = await request("/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set", name: "org-source/agc-external", data: { prompt: "x" } }),
    });
    const json = await res.json();

    expect(json.success).toBe(false);
    expect(json.error.code).toBe("FORBIDDEN");
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
