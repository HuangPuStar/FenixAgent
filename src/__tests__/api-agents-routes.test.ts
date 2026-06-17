import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const apiAgentsRoute = (await import("../routes/api/agents")).default;

function request(path: string, init?: RequestInit) {
  return apiAgentsRoute.handle(new Request(`http://localhost${path}`, init));
}

describe("API Agents Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    setListAgentKnowledgeBindingsById(async () => []);
    setTestAuth({
      user: { id: "user-1", email: "user@test.com", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubConfigPg({
      AGENT_SETTABLE_FIELDS: ["modelId", "prompt", "description", "extra", "machineId", "knowledge"],
      listAgentConfigs: async () => [],
      getAgentConfigById: async () => null,
      getReadableAgentConfigById: async () => null,
      createAgentConfig: async () => "agc-created",
      updateAgentConfig: async () => true,
      deleteAgentConfig: async () => true,
      listAgentSkillIds: async () => [],
      listAgentMcpIds: async () => [],
      listSkills: async () => [],
      syncAgentSkills: async () => {},
      syncAgentMcps: async () => {},
    });
  });

  afterEach(() => {
    setListAgentKnowledgeBindingsById(null);
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 列表接口应返回当前调用方可读的 Agent，包含本组织和外部共享资源。
  test("GET /api/agents returns paginated readable agents", async () => {
    stubConfigPg({
      listAgentConfigs: async () => [
        {
          id: "agc-internal",
          organizationId: "org-1",
          userId: "user-1",
          name: "internal-agent",
          model: "provider/model",
          modelId: "mdl-1",
          description: "internal",
          machineId: null,
          resourceAccess: {
            ownership: "internal",
            sourceOrganizationId: "org-1",
            resourceUid: "agc-internal",
            resourceKey: "org-1/agc-internal",
            manageable: true,
            writable: true,
            publicReadable: false,
          },
        },
        {
          id: "agc-external",
          organizationId: "org-2",
          userId: "user-2",
          name: "external-agent",
          model: null,
          modelId: null,
          description: "external",
          machineId: null,
          resourceAccess: {
            ownership: "external",
            sourceOrganizationId: "org-2",
            resourceUid: "agc-external",
            resourceKey: "org-2/agc-external",
            manageable: false,
            writable: false,
            publicReadable: true,
          },
        },
      ],
    });

    const res = await request("/api/agents?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.total).toBe(2);
    expect(json.items).toHaveLength(2);
    expect(json.items.map((item: { id: string }) => item.id)).toEqual(["agc-internal", "agc-external"]);
  });

  // 详情接口应支持读取外部共享 Agent，并透传 resourceAccess。
  test("GET /api/agents/:id returns readable detail", async () => {
    stubConfigPg({
      getReadableAgentConfigById: async () => ({
        id: "agc-demo",
        organizationId: "org-2",
        userId: "user-2",
        name: "demo-agent",
        model: "provider/model",
        modelId: "mdl-1",
        prompt: "hello",
        description: "desc",
        extra: { mode: "safe" },
        machineId: "machine-1",
        resourceAccess: {
          ownership: "external",
          sourceOrganizationId: "org-2",
          resourceUid: "agc-demo",
          resourceKey: "org-2/agc-demo",
          manageable: false,
          writable: false,
          publicReadable: true,
        },
      }),
      listAgentSkillIds: async () => ["skill-1"],
      listAgentMcpIds: async () => ["mcp-1"],
    });
    setListAgentKnowledgeBindingsById(async () => [
      { knowledgeBaseId: "kb-1", priority: 0, enabled: true, config: null },
    ]);

    const res = await request("/api/agents/agc-demo");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id).toBe("agc-demo");
    expect(json.skillIds).toEqual(["skill-1"]);
    expect(json.mcpIds).toEqual(["mcp-1"]);
    expect(json.knowledge.knowledgeBaseIds).toEqual(["kb-1"]);
    expect(json.resourceAccess?.ownership).toBe("external");
  });

  // 创建接口接收标准 JSON body，并同步 Skill / MCP 关联。
  test("POST /api/agents creates an agent with direct body shape", async () => {
    const syncSkills = mock(async () => {});
    const syncMcps = mock(async () => {});

    stubConfigPg({
      listAgentConfigs: async () => [],
      createAgentConfig: async () => "agc-created",
      getReadableAgentConfigById: async () => ({
        id: "agc-created",
        organizationId: "org-1",
        userId: "user-1",
        name: "created-agent",
        model: null,
        modelId: "mdl-created",
        prompt: "prompt",
        description: "created",
        extra: null,
        machineId: null,
      }),
      listSkills: async () => [{ id: "skill-1", name: "demo-skill" }],
      syncAgentSkills: syncSkills,
      syncAgentMcps: syncMcps,
    });

    const res = await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "created-agent",
        modelId: "mdl-created",
        prompt: "prompt",
        skillIds: ["demo-skill"],
        mcpIds: ["mcp-1"],
      }),
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.id).toBe("agc-created");
    expect(syncSkills).toHaveBeenCalledWith("agc-created", ["skill-1"]);
    expect(syncMcps).toHaveBeenCalledWith("agc-created", ["mcp-1"]);
  });

  // 更新和删除都通过路径里的配置 ID 定位资源，而不是复用 name 查询参数。
  test("PUT and DELETE /api/agents/:id operate by config id", async () => {
    const updateAgent = mock(async () => true);
    const deleteAgent = mock(async () => true);

    stubConfigPg({
      getAgentConfigById: async () => ({
        id: "agc-demo",
        organizationId: "org-1",
        userId: "user-1",
        name: "demo-agent",
        model: null,
        modelId: "mdl-1",
        prompt: "prompt",
        description: "desc",
        extra: null,
        machineId: null,
      }),
      getReadableAgentConfigById: async () => ({
        id: "agc-demo",
        organizationId: "org-1",
        userId: "user-1",
        name: "demo-agent",
        model: null,
        modelId: "mdl-1",
        prompt: "prompt",
        description: "updated",
        extra: null,
        machineId: null,
        resourceAccess: {
          ownership: "internal",
          sourceOrganizationId: "org-1",
          resourceUid: "agc-demo",
          resourceKey: "org-1/agc-demo",
          manageable: true,
          writable: true,
          publicReadable: false,
        },
      }),
      updateAgentConfig: updateAgent,
      deleteAgentConfig: deleteAgent,
    });

    const updateRes = await request("/api/agents/agc-demo", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "updated" }),
    });
    const deleteRes = await request("/api/agents/agc-demo", { method: "DELETE" });
    const deleteJson = await deleteRes.json();

    expect(updateRes.status).toBe(200);
    expect(updateAgent).toHaveBeenCalledWith(
      { organizationId: "org-1", userId: "user-1", role: "owner" },
      "demo-agent",
      { description: "updated" },
      { publicReadable: undefined },
    );
    expect(deleteRes.status).toBe(200);
    expect(deleteAgent).toHaveBeenCalledWith(
      { organizationId: "org-1", userId: "user-1", role: "owner" },
      "demo-agent",
    );
    expect(deleteJson).toEqual({ id: "agc-demo", deleted: true });
  });
});
