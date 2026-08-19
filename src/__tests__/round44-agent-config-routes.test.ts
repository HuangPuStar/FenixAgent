import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AppError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setListAgentKnowledgeBindingsById } from "../services/agent-knowledge";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const route = (await import("../routes/web/config/agents")).default;
const now = new Date("2026-08-19T00:00:00.000Z");

function agent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    organizationId: "org-1",
    userId: "user-1",
    name: "researcher",
    prompt: "help",
    model: "provider/model",
    modelId: null,
    description: null,
    extra: null,
    agentNode: {},
    resourceAccess: {
      ownership: "internal",
      writable: true,
      sourceOrganizationId: "org-1",
      resourceUid: "agent-1",
      resourceKey: "org-1/agent-1",
      manageable: true,
    },
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function authenticate(organizationId = "org-1") {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId, userId: "user-1", role: "owner" },
  });
  setTestOrgContext({ organizationId, userId: "user-1", role: "owner" });
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
    delete: () => ({ where: async () => undefined }),
  });
}

function installRouteDefaults() {
  installSafeDb();
  setListAgentKnowledgeBindingsById(async () => []);
  stubConfigPg({
    getUserConfig: async () => ({ defaultAgent: null }),
    listAgentConfigs: async () => [],
    listAgentSkillIds: async () => [],
    listAgentMcpIds: async () => [],
    listAgentSiteAppIds: async () => [],
    getAgentConfig: async () => null,
    createAgentConfig: async () => "agent-created",
    assertAgentConfigInternalWritable: async () => null,
    updateAgentConfig: async () => undefined,
    deleteAgentConfig: async () => false,
    setUserConfig: async () => undefined,
    syncAgentSkills: async () => undefined,
    syncAgentMcps: async () => undefined,
    syncAgentSiteApps: async () => undefined,
  });
}

describe("round44 Agent 配置 Web 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    authenticate();
    installRouteDefaults();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
    setListAgentKnowledgeBindingsById(null);
  });

  // 列表必须以认证组织上下文调用配置服务，不能使用客户端输入决定组织。
  test("列表将认证组织传给服务层", async () => {
    let organizationId = "";
    stubConfigPg({
      listAgentConfigs: async (ctx) => {
        organizationId = ctx.organizationId;
        return [];
      },
    });

    expect((await request("/config/agents")).status).toBe(200);
    expect(organizationId).toBe("org-1");
  });

  // 空列表仍应返回稳定的成功形状及默认 Agent 字段。
  test("列表返回空的当前组织集合", async () => {
    const response = await request("/config/agents");

    expect(await response.json()).toEqual({ success: true, data: { default_agent: null, agents: [] } });
  });

  // 外部共享资源的只读访问描述必须原样暴露，而不被误标记为内部资源。
  test("列表保留共享资源的访问隔离信息", async () => {
    stubConfigPg({
      listAgentConfigs: async () => [
        agent({
          organizationId: "org-source",
          resourceAccess: {
            ownership: "external",
            writable: false,
            sourceOrganizationId: "org-source",
            resourceUid: "agent-source",
            resourceKey: "org-source/agent-source",
            manageable: false,
          },
        }),
      ],
    });

    const body = await (await request("/config/agents")).json();

    expect(body.data.agents[0].resourceAccess).toMatchObject({ ownership: "external", writable: false });
  });

  // 普通名称详情查询必须委托认证组织范围内的读取接口。
  test("详情按名称读取当前组织 Agent", async () => {
    let receivedName = "";
    stubConfigPg({
      getAgentConfig: async (_ctx, name) => {
        receivedName = name;
        return agent();
      },
    });

    expect((await request("/config/agents?name=researcher")).status).toBe(200);
    expect(receivedName).toBe("researcher");
  });

  // 不存在的详情应标准化为 NOT_FOUND，而非泄露底层实现错误。
  test("详情不存在时映射为 404", async () => {
    const response = await request("/config/agents?name=missing");

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 详情响应必须包含绑定集合，供前端安全地展示关联资源。
  test("详情返回 skill、MCP 与站点绑定", async () => {
    stubConfigPg({
      getAgentConfig: async () => agent(),
      listAgentSkillIds: async () => ["skill-1"],
      listAgentMcpIds: async () => ["mcp-1"],
      listAgentSiteAppIds: async () => ["site-1"],
    });

    const body = await (await request("/config/agents?name=researcher")).json();

    expect(body.data).toMatchObject({ skillIds: ["skill-1"], mcpIds: ["mcp-1"], siteAppIds: ["site-1"] });
  });

  // 创建名称必须符合资源名称约束，避免非法标识符进入配置层。
  test("创建拒绝非法名称", async () => {
    let created = false;
    stubConfigPg({
      createAgentConfig: async () => {
        created = true;
        return "agent-created";
      },
    });

    const response = await json("/config/agents", "POST", { name: "invalid_name", data: {} });

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    expect(created).toBe(false);
  });

  // 同组织重名创建必须映射为 409 冲突。
  test("创建同名 Agent 返回 409", async () => {
    stubConfigPg({ getAgentConfig: async () => agent() });

    const response = await json("/config/agents", "POST", { name: "researcher", data: {} });

    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("ALREADY_EXISTS");
  });

  // 创建应将 publicReadable 显式传递给服务层以建立共享策略。
  test("创建透传共享可读策略", async () => {
    let options: unknown;
    let reads = 0;
    stubConfigPg({
      createAgentConfig: async (_ctx, _name, _data, receivedOptions) => {
        options = receivedOptions;
        return "agent-created";
      },
      getAgentConfig: async () => (reads++ === 0 ? null : agent({ id: "agent-created" })),
    });

    expect((await json("/config/agents", "POST", { name: "new-agent", data: { publicReadable: true } })).status).toBe(
      200,
    );
    expect(options).toEqual({ publicReadable: true });
  });

  // 创建后应同步传入的 MCP 和站点应用绑定。
  test("创建同步 MCP 与站点应用绑定", async () => {
    const calls: string[] = [];
    let reads = 0;
    stubConfigPg({
      createAgentConfig: async () => "agent-created",
      getAgentConfig: async () => (reads++ === 0 ? null : agent({ id: "agent-created" })),
      syncAgentMcps: async (_id, ids) => {
        calls.push(`mcp:${ids.join(",")}`);
      },
      syncAgentSiteApps: async (_id, ids) => {
        calls.push(`site:${ids.join(",")}`);
      },
    });

    expect(
      (await json("/config/agents", "POST", { name: "new-agent", data: { mcpIds: ["mcp-1"], siteAppIds: ["site-1"] } }))
        .status,
    ).toBe(200);
    expect(calls).toEqual(["mcp:mcp-1", "site:site-1"]);
  });

  // 更新缺少目标名称时不得触发可写权限检查。
  test("更新缺少名称返回 400", async () => {
    let checked = false;
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => {
        checked = true;
        return agent();
      },
    });

    const response = await json("/config/agents", "PUT", { data: {} });

    expect(response.status).toBe(400);
    expect(checked).toBe(false);
  });

  // 共享只读 Agent 的权限拒绝必须映射为 403。
  test("更新拒绝共享只读 Agent", async () => {
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => {
        throw new AppError("只读共享资源", "FORBIDDEN", 403);
      },
    });

    const response = await json("/config/agents?name=org-source/shared", "PUT", { data: { description: "changed" } });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  // 更新目标不存在时必须返回 404，不能变成隐式创建。
  test("更新不存在 Agent 返回 404", async () => {
    const response = await json("/config/agents?name=missing", "PUT", { data: { description: "changed" } });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 更新只能传递白名单字段，防止调用方覆盖组织归属等敏感列。
  test("更新过滤非白名单字段", async () => {
    let updateData: Record<string, unknown> = {};
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => agent(),
      updateAgentConfig: async (_ctx, _name, data) => {
        updateData = data;
      },
      getAgentConfig: async () => agent(),
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

  // 更新应同步显式提供的 skill 绑定而非忽略关联资源变更。
  test("更新同步 skill 绑定", async () => {
    let skillIds: string[] = [];
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => agent(),
      updateAgentConfig: async () => undefined,
      getAgentConfig: async () => agent(),
      syncAgentSkills: async (_id, ids) => {
        skillIds = ids;
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

  // 删除内置 Agent 必须在权限或删除服务调用前拒绝。
  test("删除内置 Agent 返回 403", async () => {
    let deleted = false;
    stubConfigPg({
      deleteAgentConfig: async () => {
        deleted = true;
        return true;
      },
    });

    const response = await request("/config/agents?name=build", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(deleted).toBe(false);
  });

  // 删除共享只读 Agent 必须复用内部可写权限边界。
  test("删除拒绝共享只读 Agent", async () => {
    stubConfigPg({
      assertAgentConfigInternalWritable: async () => {
        throw new AppError("只读共享资源", "FORBIDDEN", 403);
      },
    });

    const response = await request("/config/agents?name=org-source/shared", { method: "DELETE" });

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("FORBIDDEN");
  });

  // 删除服务未删除记录时必须返回 404，避免误报成功。
  test("删除竞态目标消失时返回 404", async () => {
    stubConfigPg({ assertAgentConfigInternalWritable: async () => agent(), deleteAgentConfig: async () => false });

    const response = await request("/config/agents?name=researcher", { method: "DELETE" });

    expect(response.status).toBe(404);
  });

  // 设置默认 Agent 必须验证目标在当前组织可见。
  test("设置默认 Agent 不存在时返回 404", async () => {
    const response = await json("/config/agents/default", "POST", { name: "missing" });

    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe("NOT_FOUND");
  });

  // 设置默认 Agent 应把可见目标名称写入当前用户配置。
  test("设置默认 Agent 写入当前用户配置", async () => {
    let defaultAgent = "";
    stubConfigPg({
      getAgentConfig: async () => agent({ name: "researcher" }),
      setUserConfig: async (_ctx, config) => {
        defaultAgent = config.defaultAgent;
      },
    });

    const response = await json("/config/agents/default", "POST", { name: "researcher" });

    expect(response.status).toBe(200);
    expect(defaultAgent).toBe("researcher");
  });
});
