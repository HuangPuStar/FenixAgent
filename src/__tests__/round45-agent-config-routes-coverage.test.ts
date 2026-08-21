import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { InvalidKnowledgeBindingError, setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const route = (await import("../routes/web/config/agents")).default;
const now = new Date("2026-08-19T00:00:00.000Z");

function request(path: string) {
  return route.handle(new Request(`http://localhost${path}`));
}

function agent() {
  return {
    id: "agent-1",
    organizationId: "org-1",
    userId: "user-1",
    name: "researcher",
    prompt: "help",
    model: "provider/model",
    modelId: "model-1",
    description: "说明",
    extra: { temperature: 0.2 },
    agentNode: { kind: "machine", machineId: "machine-1" },
    resourceAccess: {
      ownership: "external",
      writable: false,
      sourceOrganizationId: "org-source",
      resourceUid: "agent-source",
      resourceKey: "org-source/agent-source",
      manageable: false,
    },
    createdAt: now,
    updatedAt: now,
  };
}

function installDbRows(rows: unknown[][]) {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => {
          const next = () => rows.shift() ?? [];
          return {
            limit: async () => next(),
            // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询构造器在 await 时必须是 thenable。
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(next()).then(resolve),
          };
        },
      }),
    }),
  });
}

function installDefaults() {
  stubConfigPg({
    getAgentConfig: async () => null,
    getUserConfig: async () => ({ defaultAgent: null }),
    listAgentConfigs: async () => [],
    listAgentMcpIds: async () => [],
    listAgentSiteAppIds: async () => [],
    listAgentSkillIds: async () => [],
  });
}

describe("round45 Agent 配置路由补充覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    installDefaults();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    setListAgentKnowledgeBindingsById(null);
    resetAllStubs();
  });

  // 外部组织共享的 Agent 详情应使用来源组织读取关联资源，并转换为前端展示标签。
  test("详情转换共享 Agent 的关联资源与记忆状态", async () => {
    stubConfigPg({
      getAgentConfig: async () => agent(),
      listAgentSkillIds: async () => ["skill-1"],
      listAgentMcpIds: async () => ["mcp-1"],
      listAgentSiteAppIds: async () => ["site-1"],
    });
    setListAgentKnowledgeBindingsById(async () => [
      {
        knowledgeBaseId: "kb-1",
        priority: 0,
        enabled: true,
        config: { searchFirst: false, maxResults: 3, defaultNamespaces: ["docs"] },
      },
    ]);
    installDbRows([
      [
        {
          id: "model-1",
          modelName: "gpt",
          displayName: "GPT",
          providerId: "provider-1",
          providerOrganizationId: "org-source",
        },
      ],
      [{ id: "provider-1", name: "openai", displayName: "OpenAI" }],
      [{ id: "machine-1", agentName: "worker", name: "", machineInfo: { hostname: "host-1" } }],
      [{ id: "skill-1", label: "检索" }],
      [{ id: "mcp-1", label: "浏览器" }],
      [{ id: "kb-1", name: "知识库", slug: "docs" }],
      [{ id: "site-1", name: "站点", remoteAppId: "remote-1" }],
      [{ enabled: true }],
    ]);

    const response = await request("/config/agents?name=org-source/agent-source");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      enableMemory: true,
      knowledge: { knowledgeBaseIds: ["kb-1"], policy: { searchFirst: false, maxResults: 3 } },
      relatedResources: {
        modelLabel: "OpenAI/GPT",
        machineLabel: "host-1",
        skills: [{ id: "skill-1", label: "检索" }],
        mcps: [{ id: "mcp-1", label: "浏览器" }],
        knowledgeBases: [{ id: "kb-1", label: "知识库", slug: "docs" }],
        siteApps: [{ id: "site-1", label: "站点", remoteAppId: "remote-1" }],
      },
    });
  });

  // 读取期间发现跨组织知识库绑定无效时，路由必须返回可识别的 400 错误。
  test("详情将无效知识库绑定映射为 400", async () => {
    stubConfigPg({ getAgentConfig: async () => agent() });
    installDbRows([[], [], [{ enabled: false }]]);
    let reads = 0;
    setListAgentKnowledgeBindingsById(async () => {
      reads += 1;
      if (reads === 2) throw new InvalidKnowledgeBindingError("知识库不属于当前组织");
      return [];
    });

    const response = await request("/config/agents?name=researcher");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      code: "INVALID_KNOWLEDGE_BINDINGS",
      message: "知识库不属于当前组织",
    });
  });
});
