import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import {
  createStubSkillFacade,
  createStubSkillServerModule,
  installSkillServerModule,
  resetSkillServerModuleForTesting,
} from "@fenix/resource-skill/server/testing";
import { createApiAgentsRoutes } from "../server/routes/api/agents";
import { authorizedAgent, installAgentModuleStub, resetAgentModuleStub } from "./fixtures";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

/**
 * `/api/agents` 对外已发布合同的用例（S4 接缝迁移）。
 *
 * 授权、可见性与资源键解析全部在 Facade：这里只替换模块替身，验证协议层把请求映射成正确的应用调用、
 * 并把结果映射回已发布的 `resourceAccess` 视图（决策 D2 唯一保留旧字段形状的位置）。
 *
 * Skill 名称解析经 `resolveSkillIds` → Skill 资源模块的 Facade（`skill-directory.ts`），因此名称→ID
 * 的解析用 Skill 模块替身表达，不再用配置服务桩。
 *
 * 路由改工厂后由包内守卫替身注入会话（迁移前读宿主 `setTestAuth` / `setTestOrgContext`）：主体一律是
 * 平台 `ActorContext`，用例断言里出现的 `activeOrganizationId` / `userId` 就是宿主注入的内容。
 */

const apiAgentsRoute = createApiAgentsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

function request(path: string, init?: RequestInit) {
  return apiAgentsRoute.handle(new Request(`http://localhost${path}`, init));
}

/** 装入"只含一个可见 Skill"的 Skill 资源替身，供 skillIds 里的名称解析到 UUID。 */
function installVisibleSkill() {
  installSkillServerModule(
    createStubSkillServerModule({
      facade: createStubSkillFacade({
        list: async () => ({
          items: [
            {
              id: "skill-1",
              name: "demo-skill",
              description: "demo",
              path: "/tmp/demo-skill",
              scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
              access: { actions: ["read"] },
            },
          ],
          total: 1,
        }),
      }),
    }),
  );
}

describe("API Agents Routes", () => {
  beforeEach(() => {
    resetAllStubs();
    resetAgentModuleStub();
    resetSkillServerModuleForTesting();
    setTestAuth({ organizationId: "org-1", userId: "user-1" });
    installAgentModuleStub({
      facade: {
        list: async () => ({ items: [], total: 0 }),
        getById: async () => undefined,
        get: async () => undefined,
      },
    });
  });

  afterEach(() => {
    resetAgentModuleStub();
    resetSkillServerModuleForTesting();
    resetTestAuth();
  });

  // 列表接口应返回当前调用方可读的 Agent，包含本组织和外部共享资源。
  test("GET /api/agents returns paginated readable agents", async () => {
    installAgentModuleStub({
      facade: {
        list: async () => ({
          items: [
            authorizedAgent({ id: "agc-internal", name: "internal-agent", organizationId: "org-1" }),
            authorizedAgent({
              id: "agc-external",
              name: "external-agent",
              organizationId: "org-2",
              ownerUserId: "user-2",
              visibility: "public",
              actions: ["read"],
            }),
          ],
          total: 2,
        }),
      },
    });

    const res = await request("/api/agents?page=1&pageSize=10");
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.total).toBe(2);
    expect(json.items).toHaveLength(2);
    expect(json.items.map((item: { id: string }) => item.id)).toEqual(["agc-internal", "agc-external"]);
    expect(json.items[0].resourceAccess.ownership).toBe("internal");
    expect(json.items[1].resourceAccess.ownership).toBe("external");
  });

  // 详情接口应支持读取外部共享 Agent，并透传 resourceAccess。
  test("GET /api/agents/:id returns readable detail", async () => {
    installAgentModuleStub({
      facade: {
        getById: async () =>
          authorizedAgent({
            id: "agc-demo",
            name: "demo-agent",
            organizationId: "org-2",
            ownerUserId: "user-2",
            visibility: "public",
            modelId: "mdl-1",
            prompt: "hello",
            description: "desc",
            extra: { mode: "safe" },
            actions: ["read"],
          }),
      },
      associations: {
        listSkillIds: async () => ["skill-1"],
        listMcpIds: async () => ["mcp-1"],
        getKnowledge: async () => ({ knowledgeBaseIds: ["kb-1"], policy: null }),
      },
    });

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
    installVisibleSkill();
    installAgentModuleStub({
      facade: {
        existsInOrganization: async () => false,
        create: async () =>
          authorizedAgent({
            id: "agc-created",
            name: "created-agent",
            modelId: "mdl-created",
            prompt: "prompt",
            description: "created",
          }),
      },
      associations: { syncSkills, syncMcps },
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

  // 组织内已存在同名 Agent 时必须返回 409，且判定发生在写入之前（命中即止，不得先创建再报错）。
  test("POST /api/agents returns 409 when the name exists in the active organization", async () => {
    const checkName = mock(async () => true);
    const createAgent = mock(async () => authorizedAgent());
    installAgentModuleStub({
      facade: {
        existsInOrganization: checkName,
        create: createAgent,
      },
    });

    const res = await request("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "created-agent", modelId: "mdl-created", prompt: "prompt" }),
    });
    const json = await res.json();

    expect(res.status).toBe(409);
    expect(json.error.code).toBe("ALREADY_EXISTS");
    // 判定的是请求体里的名称，而不是别的字段或路径参数。
    expect(checkName).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), "created-agent");
    expect(createAgent).not.toHaveBeenCalled();
  });

  // 更新和删除都通过路径里的配置 ID 拼出资源键定位资源，而不是复用 name 查询参数。
  test("PUT and DELETE /api/agents/:id operate by config id", async () => {
    const updateAgent = mock(async () =>
      authorizedAgent({
        id: "agc-demo",
        name: "demo-agent",
        modelId: "mdl-1",
        prompt: "prompt",
        description: "updated",
      }),
    );
    const removeAgent = mock(async () => {});
    installAgentModuleStub({
      facade: {
        get: async () => authorizedAgent({ id: "agc-demo", name: "demo-agent", modelId: "mdl-1", prompt: "prompt" }),
        update: updateAgent,
        remove: removeAgent,
      },
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
      expect.objectContaining({ activeOrganizationId: "org-1", userId: "user-1" }),
      "org-1/agc-demo",
      { description: "updated" },
      {},
    );
    expect(deleteRes.status).toBe(200);
    expect(removeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ activeOrganizationId: "org-1", userId: "user-1" }),
      "org-1/agc-demo",
    );
    expect(deleteJson).toEqual({ id: "agc-demo", deleted: true });
  });
});
