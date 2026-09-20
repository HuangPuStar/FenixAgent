import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { EnvironmentRecord } from "@fenix/agent-runtime/runtime";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import type { ChannelBindingRow } from "../server/repositories/channel-binding";
import { channelBindingRepo } from "../server/repositories/channel-binding";
import type { ChannelEnvironmentLookup } from "../server/routes/dependencies";
import { createWebChannelsRoutes } from "../server/routes/web/channels";
import { setHermesClientGetter } from "../server/services/channel-provider";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

const now = new Date("2026-08-19T00:00:00.000Z");
const TEST_AUTH = { organizationId: "org-1", userId: "user-1" };

/**
 * Environment 归属查询替身。
 *
 * 真实实现由宿主注入（`@fenix/agent-runtime/server` 的 `environmentRepo`），包内不得依赖宿主
 * preload 的模块替身（`@server/test-utils/stubs/*`），因此这里按路由声明的窄接口提供可控返回值。
 * 每条例用 `beforeEach` 恢复默认行为，避免用例之间的交叉污染。
 */
const environmentLookup: ChannelEnvironmentLookup = {
  getById: async () => undefined,
  listByOrganizationId: async () => [],
};
/** 最近一次列表查询收到的组织 ID：隔离规则必须按认证上下文查询，而不是查全表后过滤。 */
let queriedOrganizationIds: string[] = [];

function environment(overrides: Partial<EnvironmentRecord> = {}): EnvironmentRecord {
  return {
    id: "env-1",
    name: "团队环境",
    description: null,
    workspacePath: "/workspace/env-1",
    agentConfigId: null,
    secret: "environment-secret-must-not-leak",
    machineName: null,
    directory: "/workspace/env-1",
    branch: null,
    gitRepoUrl: null,
    workerType: "local",
    capabilities: null,
    status: "idle",
    username: null,
    userId: "user-1",
    organizationId: "org-1",
    autoStart: false,
    lastPollAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function binding(overrides: Partial<ChannelBindingRow> = {}): ChannelBindingRow {
  return {
    id: "binding-1",
    platform: "feishu",
    chatId: "chat-1",
    agentId: "env-1",
    enabled: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function responseBinding(overrides: Partial<ChannelBindingRow> = {}) {
  const value = binding(overrides);
  return {
    id: value.id,
    platform: value.platform,
    chatId: value.chatId,
    agentId: value.agentId,
    enabled: value.enabled,
  };
}

// 认证守卫按插件名去重，两个实例分属两个独立的 app 根：一个注入认证上下文，一个不注入（未认证）。
const route = createWebChannelsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(TEST_AUTH),
  environmentLookup,
});
/** 未认证场景专用实例：守卫替身按宿主真实守卫的 401 形状拒绝，用于逐端点验证鉴权声明。 */
const anonymousRoute = createWebChannelsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin(null),
  environmentLookup,
});

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}
function jsonInit(method: string, body: Record<string, unknown>): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
function json(path: string, method: string, body: Record<string, unknown>) {
  return request(path, jsonInit(method, body));
}

const originals = {
  create: channelBindingRepo.create,
  delete: channelBindingRepo.delete,
  getById: channelBindingRepo.getById,
  list: channelBindingRepo.list,
  listByPlatformAndEnabled: channelBindingRepo.listByPlatformAndEnabled,
  update: channelBindingRepo.update,
};
function restoreRepo() {
  channelBindingRepo.create = originals.create;
  channelBindingRepo.delete = originals.delete;
  channelBindingRepo.getById = originals.getById;
  channelBindingRepo.list = originals.list;
  channelBindingRepo.listByPlatformAndEnabled = originals.listByPlatformAndEnabled;
  channelBindingRepo.update = originals.update;
}

describe("round54 Web 通道路由", () => {
  beforeEach(() => {
    resetAllStubs();
    restoreRepo();
    queriedOrganizationIds = [];
    environmentLookup.getById = async (id: string) => (id === "env-1" ? environment() : undefined);
    environmentLookup.listByOrganizationId = async (organizationId: string) => {
      queriedOrganizationIds.push(organizationId);
      return [environment()];
    };
    // 其他测试可能初始化全局 Hermes 单例；本套路由测试默认覆盖未初始化场景。
    setHermesClientGetter(() => null);
    channelBindingRepo.create = mock(async (input) => binding(input));
    channelBindingRepo.delete = mock(async () => true);
    channelBindingRepo.getById = mock(async (id: string) => (id === "binding-1" ? binding() : binding({ id })));
    channelBindingRepo.list = mock(async () => [binding()]);
    channelBindingRepo.update = mock(async () => {});
  });
  afterEach(() => {
    setHermesClientGetter(null);
    restoreRepo();
    resetAllStubs();
  });

  // 未认证时每个端点都必须被守卫拦下：逐一断言 401，缺一条 `sessionAuth: true` 声明即失败。
  // 请求体必须是合法载荷：Elysia 的校验阶段先于 `beforeHandle`，空体只会得到 422 而测不到鉴权。
  test("未认证时全部端点返回 401", async () => {
    const cases: Array<[string, RequestInit | undefined]> = [
      ["/channels/providers", undefined],
      ["/channels/hermes/status", undefined],
      ["/channels/bindings", undefined],
      ["/channels/bindings", jsonInit("POST", { platform: "feishu", agentId: "env-1" })],
      ["/channels/bindings/binding-1", jsonInit("PATCH", { enabled: false })],
      ["/channels/bindings/binding-1", { method: "DELETE" }],
    ];
    for (const [path, init] of cases) {
      const response = await anonymousRoute.handle(new Request(`http://localhost${path}`, init));
      expect([path, init?.method ?? "GET", response.status]).toEqual([path, init?.method ?? "GET", 401]);
      expect(await readJson(response)).toEqual({ error: { type: "unauthorized", message: "Not authenticated" } });
    }
  });
  // Hermes 不可用时平台仍安全地标为禁用。
  test("供应商列表返回禁用平台", async () => {
    expect(await readJson(await request("/channels/providers"))).toEqual({
      success: true,
      data: [
        { type: "wechat", label: "微信", status: "disabled" },
        { type: "feishu", label: "飞书", status: "disabled" },
      ],
    });
  });
  // 查询 token 不得从响应中泄露。
  test("供应商列表不回显 token", async () => {
    expect(
      JSON.stringify(await readJson(await request("/channels/providers?token=query-token-must-not-leak"))),
    ).not.toContain("query-token-must-not-leak");
  });
  // 未初始化 Hermes 必须返回稳定断开状态。
  test("Hermes 未初始化时返回断开状态", async () => {
    expect(await readJson(await request("/channels/hermes/status"))).toEqual({
      success: true,
      data: { connected: false, url: "", platforms: [], reconnecting: false, lastConnectedAt: null },
    });
  });
  // 环境查询必须按认证上下文的组织进行，禁止查全表后在内存里过滤（那样会读到其他组织的数据）。
  test("绑定列表按认证组织查询环境", async () => {
    await request("/channels/bindings");
    expect(queriedOrganizationIds).toEqual(["org-1"]);
  });
  // 空列表不得制造伪造绑定。
  test("绑定列表保留空结果", async () => {
    channelBindingRepo.list = mock(async () => []);
    expect(await readJson(await request("/channels/bindings"))).toEqual({ success: true, data: [] });
  });
  // 列表只能包含当前组织环境的绑定。
  test("绑定列表过滤其他组织环境", async () => {
    channelBindingRepo.list = mock(async () => [binding(), binding({ id: "foreign", agentId: "env-foreign" })]);
    expect(await readJson(await request("/channels/bindings"))).toEqual({
      success: true,
      data: [{ ...responseBinding(), agentName: "团队环境" }],
    });
  });
  // 不可读环境对应的名称必须为空。
  test("绑定列表缺少环境时返回空名称", async () => {
    environmentLookup.getById = async () => undefined;
    expect(await readJson(await request("/channels/bindings"))).toEqual({
      success: true,
      data: [{ ...responseBinding(), agentName: null }],
    });
  });
  // 环境 secret 不得出现在绑定响应中。
  test("绑定列表不泄露环境 secret", async () => {
    expect(JSON.stringify(await readJson(await request("/channels/bindings")))).not.toContain(
      "environment-secret-must-not-leak",
    );
  });
  // 创建应携带环境展示名称。
  test("创建绑定返回关联环境名称", async () => {
    const r = await json("/channels/bindings", "POST", { platform: "feishu", chatId: "chat-new", agentId: "env-1" });
    expect(await readJson(r)).toEqual({
      success: true,
      data: { ...responseBinding({ chatId: "chat-new" }), agentName: "团队环境" },
    });
  });
  // 缺省 chatId 必须变为通配 null。
  test("创建绑定默认空 chatId", async () => {
    const create = mock(async (input: ChannelBindingRow) => binding(input));
    channelBindingRepo.create = create;
    await json("/channels/bindings", "POST", { platform: "feishu", agentId: "env-1" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ chatId: null, enabled: true }));
  });
  // 显式禁用状态不得被默认值覆盖。
  test("创建绑定保留显式禁用状态", async () => {
    expect(
      (
        await (
          await json("/channels/bindings", "POST", { platform: "feishu", agentId: "env-1", enabled: false })
        ).json()
      ).data.enabled,
    ).toBe(false);
  });
  // 空平台必须由 schema 拒绝。
  test("创建绑定拒绝空平台", async () => {
    expect((await json("/channels/bindings", "POST", { platform: "", agentId: "env-1" })).status).toBe(422);
  });
  // 缺失环境 ID 必须由 schema 拒绝。
  test("创建绑定拒绝缺失 agentId", async () => {
    expect((await json("/channels/bindings", "POST", { platform: "feishu" })).status).toBe(422);
  });
  // 不存在环境不得创建绑定。
  test("创建绑定拒绝不存在环境", async () => {
    const r = await json("/channels/bindings", "POST", { platform: "feishu", agentId: "missing" });
    expect(r.status).toBe(404);
    expect(await readJson(r)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Agent 不存在" } });
  });
  // 跨组织环境要隐藏为不存在。
  test("创建绑定拒绝其他组织环境", async () => {
    environmentLookup.getById = async () => environment({ organizationId: "org-foreign" });
    expect((await json("/channels/bindings", "POST", { platform: "feishu", agentId: "env-1" })).status).toBe(404);
  });
  // 删除不存在绑定应返回 not found。
  test("删除不存在绑定返回 404", async () => {
    channelBindingRepo.list = mock(async () => []);
    expect((await request("/channels/bindings/missing", { method: "DELETE" })).status).toBe(404);
  });
  // 删除跨组织绑定必须拒绝。
  test("删除其他组织绑定返回 403", async () => {
    environmentLookup.getById = async () => environment({ organizationId: "org-foreign" });
    expect((await request("/channels/bindings/binding-1", { method: "DELETE" })).status).toBe(403);
  });
  // 删除竞争失败仍应映射为 not found。
  test("删除已消失绑定返回 404", async () => {
    channelBindingRepo.delete = mock(async () => false);
    expect((await request("/channels/bindings/binding-1", { method: "DELETE" })).status).toBe(404);
  });
  // 成功删除只返回 null 数据。
  test("删除绑定返回空数据", async () => {
    expect(await readJson(await request("/channels/bindings/binding-1", { method: "DELETE" }))).toEqual({
      success: true,
      data: null,
    });
  });
  // 更新不存在绑定应失败。
  test("更新不存在绑定返回 404", async () => {
    channelBindingRepo.list = mock(async () => []);
    expect((await json("/channels/bindings/missing", "PATCH", { enabled: false })).status).toBe(404);
  });
  // 更新跨组织绑定必须拒绝。
  test("更新其他组织绑定返回 403", async () => {
    environmentLookup.getById = async () => environment({ organizationId: "org-foreign" });
    expect((await json("/channels/bindings/binding-1", "PATCH", { enabled: false })).status).toBe(403);
  });
  // 更新成功需返回最新绑定和环境名称。
  test("更新绑定返回更新后的数据", async () => {
    channelBindingRepo.getById = mock(async () => binding({ enabled: false }));
    expect(await readJson(await json("/channels/bindings/binding-1", "PATCH", { enabled: false }))).toEqual({
      success: true,
      data: { ...responseBinding({ enabled: false }), agentName: "团队环境" },
    });
  });
  // 更新后环境不可读时只能给出空名称。
  test("更新绑定缺少环境时返回空名称", async () => {
    let reads = 0;
    environmentLookup.getById = async () => (++reads === 1 ? environment() : undefined);
    expect(
      (await (await json("/channels/bindings/binding-1", "PATCH", { chatId: null })).json()).data.agentName,
    ).toBeNull();
  });
  // 非布尔 enabled 必须被更新 schema 拒绝。
  test("更新绑定拒绝无效 enabled", async () => {
    expect((await json("/channels/bindings/binding-1", "PATCH", { enabled: "false" })).status).toBe(422);
  });
  // 请求体里的 agentId 是本次写入的新目标，必须与 POST 同口径校验归属：只校验原绑定的 agentId
  // 会让任何已认证用户把绑定改写到其他组织的 Environment，写库已经发生，响应还会回显该环境名。
  test("更新绑定拒绝改指其他组织环境", async () => {
    const update = mock(async () => {});
    channelBindingRepo.update = update;
    environmentLookup.getById = async (id: string) =>
      id === "env-1" ? environment() : environment({ id: "env-2", organizationId: "org-foreign" });
    const r = await json("/channels/bindings/binding-1", "PATCH", { agentId: "env-2" });
    expect(r.status).toBe(404);
    expect(await readJson(r)).toEqual({ success: false, error: { code: "NOT_FOUND", message: "Agent 不存在" } });
    // 越权目标必须在校验阶段就被拒绝，不能先落库再报错。
    expect(update.mock.calls.length).toBe(0);
  });
  // 改指到本组织内的另一个环境是合法更新，且响应应给出新环境的名称。
  test("更新绑定允许改指本组织环境", async () => {
    channelBindingRepo.getById = mock(async () => binding({ agentId: "env-2" }));
    environmentLookup.getById = async (id: string) => environment({ id, name: id === "env-2" ? "新环境" : "团队环境" });
    const r = await json("/channels/bindings/binding-1", "PATCH", { agentId: "env-2" });
    expect(r.status).toBe(200);
    expect(((await readJson(r)) as { data: { agentName: string | null } }).data.agentName).toBe("新环境");
  });
});
