import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const route = (await import("../routes/web/config/agents")).default;

function request(path: string) {
  return route.handle(new Request(`http://localhost${path}`));
}

describe("round45 Agent 配置列表读取兜底", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
      authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-1", userId: "user-1", role: "owner" });
    setListAgentKnowledgeBindingsById(async () => []);
    stubConfigPg({
      getUserConfig: async () => ({ defaultAgent: "researcher" }),
      listAgentConfigs: async () => [
        {
          id: "agent-1",
          organizationId: "org-source",
          userId: "user-1",
          name: "researcher",
          prompt: null,
          model: null,
          modelId: "model-1",
          description: null,
          extra: null,
          agentNode: { kind: "machine", machineId: "machine-1" },
          resourceAccess: {
            ownership: "external",
            writable: false,
            sourceOrganizationId: "org-source",
            resourceUid: "agent-1",
            resourceKey: "org-source/agent-1",
            manageable: false,
          },
        },
      ],
      listAgentMcpIds: async () => ["mcp-1"],
      listAgentSiteAppIds: async () => ["site-1"],
      listAgentSkillIds: async () => ["skill-1"],
    });
    stubDb({
      select: () => {
        throw new Error("关联资源暂不可读");
      },
    });
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    setListAgentKnowledgeBindingsById(null);
    resetAllStubs();
  });

  // 共享组织的关联资源读取失败时，列表仍应返回隔离后的 Agent 与稳定的标识符兜底标签。
  test("关联资源查询失败时保留 Agent 列表与兜底展示", async () => {
    const response = await request("/config/agents");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      default_agent: "researcher",
      agents: [
        {
          id: "agent-1",
          modelLabel: "model-1",
          skillLabels: [{ id: "skill-1", label: "skill-1" }],
          resourceAccess: { sourceOrganizationId: "org-source", writable: false },
        },
      ],
    });
  });
});
