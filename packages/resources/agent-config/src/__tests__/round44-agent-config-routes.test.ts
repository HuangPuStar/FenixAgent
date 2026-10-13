import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { readJson, stubDb } from "@fenix/platform-sdk/testing";
import type { AgentConfigWriteData } from "../server/repositories/agent-config-resource";
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
 * `/web/config/agents` 协议层的接缝迁移（S4）。
 *
 * 应用编排（授权、资源解析、绑定同步、实例重启）已经整体收敛到 `AgentConfigServerModule`，因此路由
 * 用例只替换模块替身：`facade` 表达"授权后看到什么"，`associations` 表达"绑定写入打到哪张表"。
 * 视图按决策 D2 返回 `scope + access`，旧栈的 `resourceAccess` 不再出现在 `/web` 响应里。
 */

// 守卫与偏好端口由宿主注入：测试注入替身（§6.4），端口方法在请求期读取可变替身实现。
const route = createWebConfigAgentsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(),
  userAgentPreferences: createTestAgentPreferencesPort(),
});

function authenticate(organizationId = "org-1") {
  setTestAuth({ organizationId, userId: "user-1" });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown> = {}) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 关联资源标签解析会在绑定集合非空时查 DB；这些用例只关心绑定 ID，因此让查询整体返回空表。 */
function installSafeDb() {
  stubDb({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [],
          // biome-ignore lint/suspicious/noThenProperty: Drizzle 查询构造器在 await 时必须是 thenable。
          then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
        }),
      }),
    }),
  });
}

describe("round44 Agent 配置 Web 路由", () => {
  beforeEach(() => {
    // 复位替身并初始化应用基础设施（DB 句柄经转发代理，见 `../server/testing.ts`）。
    initializeAgentConfigModuleConfig();
    resetAgentModuleStub();
    authenticate();
    installSafeDb();
    // 用户偏好是宿主配置服务的职责（不在本资源模块内），默认"未设置默认 Agent"。
    stubAgentPreferences({});
  });

  afterEach(() => {
    resetAgentModuleStub();
    resetTestAuth();
    resetAgentPreferences();
  });

  // 列表必须以认证组织上下文调用应用层，不能使用客户端输入决定组织。
  test("列表将认证组织传给服务层", async () => {
    let organizationId: string | undefined;
    installAgentModuleStub({
      facade: {
        list: async (actor) => {
          organizationId = actor.activeOrganizationId;
          return { items: [], total: 0 };
        },
      },
    });

    expect((await request("/config/agents")).status).toBe(200);
    expect(organizationId).toBe("org-1");
  });

  // 空列表仍应返回稳定的成功形状及默认 Agent 字段。
  test("列表返回空的当前组织集合", async () => {
    installAgentModuleStub({ facade: { list: async () => ({ items: [], total: 0 }) } });

    const response = await request("/config/agents");

    expect(await readJson(response)).toEqual({ success: true, data: { default_agent: null, agents: [] } });
  });

  // 外部共享资源的只读访问描述必须原样暴露：归属范围与"只有 read"的有效动作都要能区分出来。
  test("列表保留共享资源的访问隔离信息", async () => {
    installAgentModuleStub({
      facade: {
        list: async () => ({
          items: [
            authorizedAgent({
              id: "agent-source",
              organizationId: "org-source",
              ownerUserId: "user-source",
              visibility: "public",
              actions: ["read"],
            }),
          ],
          total: 1,
        }),
      },
    });

    const body = await (await request("/config/agents")).json();

    expect(body.data.agents[0].scope).toEqual({
      organizationId: "org-source",
      ownerUserId: "user-source",
      visibility: "public",
    });
    expect(body.data.agents[0].access).toEqual({ actions: ["read"] });
  });

  // 普通名称详情查询必须委托应用层的名称解析入口，而不是由路由自行拼组织条件。
  test("详情按名称读取当前组织 Agent", async () => {
    let receivedName = "";
    installAgentModuleStub({
      facade: {
        get: async (_actor, name) => {
          receivedName = name;
          return authorizedAgent();
        },
      },
    });

    expect((await request("/config/agents?name=researcher")).status).toBe(200);
    expect(receivedName).toBe("researcher");
  });

  // 不存在的详情应标准化为 NOT_FOUND，而非泄露底层实现错误。
  test("详情不存在时映射为 404", async () => {
    installAgentModuleStub({ facade: { get: async () => undefined } });

    const response = await request("/config/agents?name=missing");

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 详情响应必须包含绑定集合，供前端安全地展示关联资源。
  test("详情返回 skill、MCP 与站点绑定", async () => {
    installAgentModuleStub({
      facade: { get: async () => authorizedAgent() },
      associations: {
        listSkillIds: async () => ["skill-1"],
        listMcpIds: async () => ["mcp-1"],
        listSiteAppIds: async () => ["site-1"],
      },
    });

    const body = await (await request("/config/agents?name=researcher")).json();

    expect(body.data).toMatchObject({ skillIds: ["skill-1"], mcpIds: ["mcp-1"], siteAppIds: ["site-1"] });
  });

  // 创建名称必须符合资源名称约束，避免非法标识符进入配置层。
  test("创建拒绝非法名称", async () => {
    const create = mock(async () => authorizedAgent());
    installAgentModuleStub({ facade: { create } });

    const response = await json("/config/agents", "POST", { name: "invalid_name", data: {} });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(create).not.toHaveBeenCalled();
  });

  // 同名可见资源已存在时必须映射为 409 冲突，而不是把创建静默变成更新。
  test("创建同名 Agent 返回 409", async () => {
    const create = mock(async () => authorizedAgent());
    installAgentModuleStub({ facade: { existsInOrganization: async () => true, create } });

    const response = await json("/config/agents", "POST", { name: "researcher", data: {} });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ALREADY_EXISTS");
    // 命中即止：判定为冲突时不得发生任何写入。
    expect(create).not.toHaveBeenCalled();
  });

  // 判定必须按归属组织：别的组织里那个我能看到的同名 Agent 不构成本组织的创建冲突，否则控制台上会
  // 出现"本组织没有该 Agent 却提示已存在"（真实回归场景：同名 Agent 在另一个组织且为 public）。
  test("其他组织的同名可见 Agent 不构成创建冲突", async () => {
    const create = mock(async () => authorizedAgent({ id: "agent-created", name: "researcher" }));
    installAgentModuleStub({ facade: { existsInOrganization: async () => false, create } });

    const response = await json("/config/agents", "POST", { name: "researcher", data: {} });

    expect(response.status).toBe(200);
    expect(create).toHaveBeenCalled();
  });

  // 创建应将 publicReadable 显式传给应用层以建立共享策略。
  test("创建透传共享可读策略", async () => {
    let input: unknown;
    installAgentModuleStub({
      facade: {
        existsInOrganization: async () => false,
        create: async (_actor, received) => {
          input = received;
          return authorizedAgent({ id: "agent-created", name: "new-agent" });
        },
      },
    });

    expect((await json("/config/agents", "POST", { name: "new-agent", data: { publicReadable: true } })).status).toBe(
      200,
    );
    expect(input).toMatchObject({ name: "new-agent", publicReadable: true });
  });

  // 创建后应经绑定门面同步传入的 MCP 和站点应用绑定。
  test("创建同步 MCP 与站点应用绑定", async () => {
    const calls: string[] = [];
    installAgentModuleStub({
      facade: {
        existsInOrganization: async () => false,
        create: async () => authorizedAgent({ id: "agent-created", name: "new-agent" }),
      },
      associations: {
        syncMcps: async (_id, ids) => {
          calls.push(`mcp:${ids.join(",")}`);
        },
        syncSiteApps: async (_id, ids) => {
          calls.push(`site:${ids.join(",")}`);
        },
      },
    });

    expect(
      (await json("/config/agents", "POST", { name: "new-agent", data: { mcpIds: ["mcp-1"], siteAppIds: ["site-1"] } }))
        .status,
    ).toBe(200);
    expect(calls).toEqual(["mcp:mcp-1", "site:site-1"]);
  });

  // 写路径返回体是前端结果类型（`web/api/agents.ts` 的 AgentSaveResult）的合同：字段增减必须两侧同步。
  // 授权视图字段恒返回（决策 D2），organizationName 只在身份名录给出名称时出现。
  test("创建与更新的返回体恒为 id / name / scope / access", async () => {
    installAgentModuleStub({
      facade: {
        existsInOrganization: async () => false,
        create: async () => authorizedAgent({ id: "agent-created", name: "new-agent" }),
        update: async () => authorizedAgent({ id: "agent-updated", name: "new-agent" }),
      },
    });

    const created = await readJson(await json("/config/agents", "POST", { name: "new-agent", data: {} }));
    expect(Object.keys(created.data as Record<string, unknown>).sort()).toEqual(["access", "id", "name", "scope"]);
    expect(created.data).toMatchObject({
      id: "agent-created",
      name: "new-agent",
      scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
      access: { actions: ["read", "create", "update", "delete", "use"] },
    });

    const updated = await readJson(await json("/config/agents?name=new-agent", "PUT", { data: {} }));
    expect(Object.keys(updated.data as Record<string, unknown>).sort()).toEqual(["access", "id", "name", "scope"]);
    expect(updated.data).toMatchObject({ id: "agent-updated", name: "new-agent" });
  });

  // 更新缺少目标名称时不得触发任何应用层写入。
  test("更新缺少名称返回 400", async () => {
    const update = mock(async () => authorizedAgent());
    installAgentModuleStub({ facade: { update } });

    const response = await json("/config/agents", "PUT", { data: {} });

    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  // 共享只读 Agent 的权限拒绝必须映射为 403。
  test("更新拒绝共享只读 Agent", async () => {
    installAgentModuleStub({
      facade: {
        update: async () => {
          throw new ForbiddenError("只读共享资源");
        },
      },
    });

    const response = await json("/config/agents?name=org-source/shared", "PUT", { data: { description: "changed" } });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  // 更新目标不存在时必须返回 404，不能变成隐式创建。
  test("更新不存在 Agent 返回 404", async () => {
    installAgentModuleStub({
      facade: {
        update: async () => {
          throw new NotFoundError("Agent 'missing' not found");
        },
      },
    });

    const response = await json("/config/agents?name=missing", "PUT", { data: { description: "changed" } });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 更新只能传递白名单字段，防止调用方覆盖组织归属等敏感列。
  test("更新过滤非白名单字段", async () => {
    let updateData: AgentConfigWriteData | undefined;
    installAgentModuleStub({
      facade: {
        update: async (_actor, _name, data) => {
          updateData = data;
          return authorizedAgent();
        },
      },
    });

    expect(
      (
        await json("/config/agents?name=researcher", "PUT", {
          data: { description: "safe", organizationId: "org-attacker" },
        })
      ).status,
    ).toBe(200);
    expect(updateData).toEqual({ description: "safe" });
  });

  // 更新应经绑定门面同步显式提供的 skill 绑定而非忽略关联资源变更。
  test("更新同步 skill 绑定", async () => {
    let skillIds: readonly string[] = [];
    installAgentModuleStub({
      facade: { update: async () => authorizedAgent() },
      associations: {
        syncSkills: async (_id, ids) => {
          skillIds = ids;
        },
      },
    });

    expect(
      (
        await json("/config/agents?name=researcher", "PUT", {
          data: { skillIds: ["11111111-1111-4111-8111-111111111111"] },
        })
      ).status,
    ).toBe(200);
    expect(skillIds).toEqual(["11111111-1111-4111-8111-111111111111"]);
  });

  // 重启 action 必须使用认证主体上下文，保留持久 Instance，仅重启其 runtime。
  test("确认 Agent 配置后重启绑定环境的运行实例", async () => {
    let receivedActor: unknown;
    let receivedName = "";
    installAgentModuleStub({
      facade: {
        restartInstances: async (actor, name) => {
          receivedActor = actor;
          receivedName = name;
          return { environmentIds: ["env-1"], restartedInstanceIds: ["inst-1"] };
        },
      },
    });

    const response = await json("/config/agents/restart?name=researcher", "POST");

    expect(response.status).toBe(200);
    expect(receivedActor).toMatchObject({ activeOrganizationId: "org-1", userId: "user-1" });
    expect(receivedName).toBe("researcher");
    expect(await readJson(response)).toEqual({
      success: true,
      data: { environmentIds: ["env-1"], restartedInstanceIds: ["inst-1"] },
    });
  });

  // 删除内置 Agent 必须在应用层删除调用前拒绝。
  test("删除内置 Agent 返回 403", async () => {
    const remove = mock(async () => {});
    installAgentModuleStub({ facade: { remove } });

    const response = await request("/config/agents?name=build", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(remove).not.toHaveBeenCalled();
  });

  // 删除共享只读 Agent 必须复用应用层的可写权限边界。
  test("删除拒绝共享只读 Agent", async () => {
    installAgentModuleStub({
      facade: {
        remove: async () => {
          throw new ForbiddenError("只读共享资源");
        },
      },
    });

    const response = await request("/config/agents?name=org-source/shared", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  // 删除竞态目标消失时必须返回 404，避免误报成功。
  test("删除竞态目标消失时返回 404", async () => {
    installAgentModuleStub({
      facade: {
        remove: async () => {
          throw new NotFoundError("Agent 'researcher' not found");
        },
      },
    });

    const response = await request("/config/agents?name=researcher", { method: "DELETE" });

    expect(response.status).toBe(404);
  });

  // 设置默认 Agent 必须验证目标在当前主体可见范围内。
  test("设置默认 Agent 不存在时返回 404", async () => {
    installAgentModuleStub({ facade: { get: async () => undefined } });

    const response = await json("/config/agents/default", "POST", { name: "missing" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 设置默认 Agent 应把可见目标的名称写入当前用户配置。
  test("设置默认 Agent 写入当前用户配置", async () => {
    let defaultAgent: string | null | undefined = "";
    installAgentModuleStub({ facade: { get: async () => authorizedAgent({ name: "researcher" }) } });
    stubAgentPreferences({
      write: async (_subject, patch) => {
        defaultAgent = patch.defaultAgent;
      },
    });

    const response = await json("/config/agents/default", "POST", { name: "researcher" });

    expect(response.status).toBe(200);
    expect(defaultAgent).toBe("researcher");
  });

  // 设置默认 Agent 的返回体是前端 AgentSetDefaultResult 的合同：与保存响应不同，它不含资源 id
  // （写入的是用户偏好而不是资源行），字段集必须独立断言，防止前端照抄保存响应的形状。
  test("设置默认 Agent 的返回体为 default_agent / scope / access", async () => {
    installAgentModuleStub({ facade: { get: async () => authorizedAgent({ id: "agent-7", name: "researcher" }) } });

    const body = await readJson(await json("/config/agents/default", "POST", { name: "researcher" }));

    expect(Object.keys(body.data as Record<string, unknown>).sort()).toEqual(["access", "default_agent", "scope"]);
    expect(body.data).toMatchObject({
      default_agent: "researcher",
      scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
      access: { actions: ["read", "create", "update", "delete", "use"] },
    });
  });
});
