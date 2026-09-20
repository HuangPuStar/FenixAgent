import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { InvalidKnowledgeBindingError } from "@fenix/resource-knowledge/server";
import { agentSiteApp, knowledgeBase, machine, mcpServer, model, provider, skill } from "@server/db/schema";
import { resetTestAuth, setTestAuth } from "@server/plugins/auth";
import { setTestOrgContext } from "@server/services/org-context";
import { stubConfigPg } from "@server/test-utils/stubs/config-pg-stub";
import { authorizedAgent, installAgentModuleStub, resetAgentModuleStub } from "./fixtures";

/**
 * `/web/config/agents` 详情视图的补充覆盖（S4 接缝迁移）。
 *
 * 关联资源的**绑定集合**来自模块替身（`associations`），标签投影仍是真实实现：它按资源归属组织查
 * 展示表，因此这里用 `stubDb` 按表分发替身行。这样"绑定对不对"和"标签投影成什么"两件事分别落在
 * 各自的接缝上，用例不会因为替换了绑定来源而丢掉标签解析的覆盖。
 */

const route = (await import("../server/routes/web/config/agents")).default;

function request(path: string) {
  return route.handle(new Request(`http://localhost${path}`));
}

/** 按表身份分发查询结果：标签投影按表查行，与调用顺序无关。 */
function installDbRows(byTable: {
  readonly model?: unknown[];
  readonly provider?: unknown[];
  readonly machine?: unknown[];
  readonly skill?: unknown[];
  readonly mcpServer?: unknown[];
  readonly knowledgeBase?: unknown[];
  readonly agentSiteApp?: unknown[];
}) {
  stubDb({
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === model
              ? (byTable.model ?? [])
              : table === provider
                ? (byTable.provider ?? [])
                : table === machine
                  ? (byTable.machine ?? [])
                  : table === skill
                    ? (byTable.skill ?? [])
                    : table === mcpServer
                      ? (byTable.mcpServer ?? [])
                      : table === knowledgeBase
                        ? (byTable.knowledgeBase ?? [])
                        : table === agentSiteApp
                          ? (byTable.agentSiteApp ?? [])
                          : [];
          return {
            limit: async () => rows,
            // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询构造器在 await 时必须是 thenable。
            then: (resolve: (value: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
          };
        },
      }),
    }),
  });
}

describe("round45 Agent 配置路由补充覆盖", () => {
  beforeEach(() => {
    resetAllStubs();
    resetAgentModuleStub();
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    stubConfigPg({ getUserConfig: async () => ({ defaultAgent: null }) });
  });

  afterEach(() => {
    resetAgentModuleStub();
    resetTestAuth();
    setTestOrgContext(null);
    resetAllStubs();
  });

  // 外部组织共享的 Agent 详情应使用归属组织读取关联资源，并转换为前端展示标签。
  test("详情转换共享 Agent 的关联资源与记忆状态", async () => {
    installAgentModuleStub({
      facade: {
        get: async () =>
          authorizedAgent({
            id: "agent-source",
            name: "shared-agent",
            organizationId: "org-source",
            ownerUserId: "user-source",
            visibility: "public",
            modelId: "model-1",
            agentNode: { kind: "machine", machineId: "machine-1" },
          }),
      },
      associations: {
        listSkillIds: async () => ["skill-1"],
        listMcpIds: async () => ["mcp-1"],
        listSiteAppIds: async () => ["site-1"],
        listKnowledgeBindings: async () => [{ knowledgeBaseId: "kb-1" }],
        getKnowledge: async () => ({
          knowledgeBaseIds: ["kb-1"],
          policy: { searchFirst: false, maxResults: 3, defaultNamespaces: ["docs"] },
        }),
        isMemoryEnabled: async () => true,
      },
    });
    installDbRows({
      model: [{ id: "model-1", modelName: "gpt", displayName: "GPT", providerId: "provider-1" }],
      provider: [{ id: "provider-1", name: "openai", displayName: "OpenAI" }],
      machine: [{ id: "machine-1", agentName: "worker", name: "", machineInfo: { hostname: "host-1" } }],
      skill: [{ id: "skill-1", label: "检索" }],
      mcpServer: [{ id: "mcp-1", label: "浏览器" }],
      knowledgeBase: [{ id: "kb-1", name: "知识库", slug: "docs" }],
      agentSiteApp: [{ id: "site-1", name: "站点", remoteAppId: "remote-1" }],
    });

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
    installAgentModuleStub({
      facade: { get: async () => authorizedAgent() },
      associations: {
        getKnowledge: async () => {
          throw new InvalidKnowledgeBindingError("知识库不属于当前组织");
        },
      },
    });

    const response = await request("/config/agents?name=researcher");

    expect(response.status).toBe(400);
    expect((await response.json()).error).toEqual({
      code: "INVALID_KNOWLEDGE_BINDINGS",
      message: "知识库不属于当前组织",
    });
  });
});
