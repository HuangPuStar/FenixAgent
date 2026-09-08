import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import type { ChannelBindingRow } from "../repositories/channel-binding";
import { channelBindingRepo } from "../repositories/channel-binding";
import type { EnvironmentRecord } from "../repositories/environment";
import { setHermesClientGetter } from "../services/channel-provider";
import { readJson, resetAllStubs, stubAuthApi, stubEnvironmentRepo } from "../test-utils/helpers";

const route = (await import("../routes/web/channels")).default;
const now = new Date("2026-08-19T00:00:00.000Z");

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

function authenticate() {
  setTestAuth({
    user: { id: "user-1", email: "user-1@example.test", name: "Tester" },
    authContext: { organizationId: "org-1", userId: "user-1", role: "owner" },
  });
}

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}
function json(path: string, method: string, body: Record<string, unknown>) {
  return request(path, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
    authenticate();
    // 其他测试可能初始化全局 Hermes 单例；本套路由测试默认覆盖未初始化场景。
    setHermesClientGetter(() => null);
    stubEnvironmentRepo({
      getById: async (id: string) => (id === "env-1" ? environment() : undefined),
      listByOrganizationId: async () => [environment()],
    });
    channelBindingRepo.create = mock(async (input) => binding(input));
    channelBindingRepo.delete = mock(async () => true);
    channelBindingRepo.getById = mock(async (id: string) => (id === "binding-1" ? binding() : binding({ id })));
    channelBindingRepo.list = mock(async () => [binding()]);
    channelBindingRepo.update = mock(async () => {});
  });
  afterEach(() => {
    resetTestAuth();
    setHermesClientGetter(null);
    restoreRepo();
    resetAllStubs();
  });

  // 未认证请求必须由认证中间件拒绝。
  test("未认证列表返回 401", async () => {
    resetTestAuth();
    stubAuthApi({ getSession: async () => null, verifyApiKey: async () => ({ valid: false }) });
    expect((await request("/channels/bindings")).status).toBe(401);
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
    stubEnvironmentRepo({ getById: async () => undefined });
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
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-foreign" }) });
    expect((await json("/channels/bindings", "POST", { platform: "feishu", agentId: "env-1" })).status).toBe(404);
  });
  // 删除不存在绑定应返回 not found。
  test("删除不存在绑定返回 404", async () => {
    channelBindingRepo.list = mock(async () => []);
    expect((await request("/channels/bindings/missing", { method: "DELETE" })).status).toBe(404);
  });
  // 删除跨组织绑定必须拒绝。
  test("删除其他组织绑定返回 403", async () => {
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-foreign" }) });
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
    stubEnvironmentRepo({ getById: async () => environment({ organizationId: "org-foreign" }) });
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
    stubEnvironmentRepo({ getById: async () => (++reads === 1 ? environment() : undefined) });
    expect(
      (await (await json("/channels/bindings/binding-1", "PATCH", { chatId: null })).json()).data.agentName,
    ).toBeNull();
  });
  // 非布尔 enabled 必须被更新 schema 拒绝。
  test("更新绑定拒绝无效 enabled", async () => {
    expect((await json("/channels/bindings/binding-1", "PATCH", { enabled: "false" })).status).toBe(422);
  });
});
