import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { createWebConfigAgentsRoutes } from "../server/routes/web/config/agents";
import { initializeAgentConfigModuleConfig } from "../server/testing";
import {
  authorizedAgent,
  createTestAgentPreferencesPort,
  installAgentModuleStub,
  resetAgentModuleStub,
  resetAgentPreferences,
  stubAgentPreferences,
} from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

/**
 * 列表读取的兜底行为（S4 接缝迁移）。
 *
 * 绑定集合与归属范围来自模块替身，标签投影是真实实现：这里让展示表的查询整体失败，验证列表仍然
 * 返回隔离后的资源与稳定的 ID 兜底标签——展示信息失败不得拖垮业务结果。
 */

const route = createWebConfigAgentsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(),
  userAgentPreferences: createTestAgentPreferencesPort(),
});

function request(path: string) {
  return route.handle(new Request(`http://localhost${path}`));
}

describe("round45 Agent 配置列表读取兜底", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
    resetAgentModuleStub();
    setTestAuth({ organizationId: "org-1", userId: "user-1" });
    stubAgentPreferences({ read: async () => ({ defaultAgent: "researcher" }) });
    installAgentModuleStub({
      facade: {
        list: async () => ({
          items: [
            authorizedAgent({
              id: "agent-1",
              name: "researcher",
              organizationId: "org-source",
              ownerUserId: "user-source",
              visibility: "public",
              modelId: "model-1",
              agentNode: { kind: "machine", machineId: "machine-1" },
              actions: ["read"],
            }),
          ],
          total: 1,
        }),
      },
      associations: {
        listSkillIds: async () => ["skill-1"],
        listMcpIds: async () => ["mcp-1"],
        listSiteAppIds: async () => ["site-1"],
      },
    });
    stubDb({
      select: () => {
        throw new Error("关联资源暂不可读");
      },
    });
  });

  afterEach(() => {
    resetAgentModuleStub();
    resetTestAuth();
    resetAgentPreferences();
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
          scope: { organizationId: "org-source", ownerUserId: "user-source", visibility: "public" },
          access: { actions: ["read"] },
        },
      ],
    });
  });
});
