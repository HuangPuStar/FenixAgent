import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "@server/plugins/auth";
import { setTestOrgContext } from "@server/services/org-context";
import { readJson, resetAllStubs, stubConfigPg, stubIdentityDirectory } from "@server/test-utils/helpers";
import type { AuthorizedProviderDetail, AuthorizedProviderListItem } from "../server/facades/provider-facade";
import {
  AVAILABLE_MODELS_CACHE_TTL_MS,
  invalidateAvailableModelsCache,
  writeAvailableModelsCache,
} from "../server/services/available-models-cache";
import {
  createStubModelManagementServerModule,
  createStubProviderFacade,
  installModelManagementModule,
  resetModelManagementModuleForTesting,
} from "../server/testing";

/**
 * `/web/config/models` 协议层的接缝迁移（决策 D6 + 计划 S5）。
 *
 * 这一层没有自己的授权判断：可用模型列表是 `ProviderFacade.list` + 逐条 `getById` 的**投影**，
 * 每一行的 `scope` / `access` 都取自父 Provider（模型不注册自己的资源类型）。用户偏好里的模型引用
 * 也必须先经 Facade 校验可读。因此用例只替换 Facade 与身份目录替身，断言投影字段、引用校验与
 * 按主体缓存的行为。
 *
 * 内联凭据、上游探测都在 `/config/providers` 一侧，本文件不覆盖。
 */

const route = (await import("../server/routes/web/config/models")).default;

function authenticate(organizationId = "org-1", userId = "user-1", role: "owner" | "member" = "owner") {
  setTestAuth({
    user: { id: userId, email: `${userId}@example.test`, name: "Tester" },
    authContext: { organizationId, userId, role },
  });
  setTestOrgContext({ organizationId, userId, role });
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

/** Provider 列表项夹具；`scope` 决定它在可用模型列表里是否带来源组织名。 */
function providerListItem(overrides: Partial<AuthorizedProviderListItem> = {}): AuthorizedProviderListItem {
  return {
    id: "provider-1",
    userId: "user-1",
    organizationId: "org-1",
    name: "demo",
    displayName: "Demo",
    kind: "direct",
    gatewayType: null,
    protocol: "openai",
    baseUrl: "https://upstream.test/v1",
    apiKey: "sk-test-placeholder",
    extraOptions: null,
    visibility: "private",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
    access: { actions: ["read", "update", "delete"] },
    modelCount: 1,
    ...overrides,
  };
}

/** Provider 详情夹具；`limitConfig` 会被摊平成 `contextLimit` / `outputLimit` 两列。 */
function providerDetail(overrides: Partial<AuthorizedProviderDetail> = {}): AuthorizedProviderDetail {
  return {
    ...providerListItem(),
    models: [
      {
        id: "model-row-1",
        providerId: "provider-1",
        organizationId: "org-1",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        modalities: ["text"],
        limitConfig: { context: 128_000, output: 8_192 },
        cost: null,
        options: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    ...overrides,
  };
}

/** 装配模块替身；`identity` 默认取测试注册表的转发代理，用例按需覆盖组织名解析。 */
function installFacade(facade: Partial<ReturnType<typeof createStubProviderFacade>>) {
  installModelManagementModule(
    createStubModelManagementServerModule({
      facade: createStubProviderFacade({ list: async () => ({ items: [], total: 0 }), ...facade }),
    }),
  );
}

describe("模型配置 Web 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetModelManagementModuleForTesting();
    invalidateAvailableModelsCache();
    authenticate();
    installFacade({});
    stubConfigPg({
      getUserConfig: async () => ({ currentModel: null, smallModel: null, permission: null }),
      setUserConfig: async () => {},
    });
  });

  afterEach(() => {
    resetModelManagementModuleForTesting();
    invalidateAvailableModelsCache();
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 可用列表每行都是 Provider 的投影：模型没有自己的归属与动作，取父 Provider 的一份。
  test("可用模型列表继承 Provider 的 scope 与 access", async () => {
    installFacade({
      list: async () => ({ items: [providerListItem()], total: 1 }),
      getById: async () => providerDetail(),
    });

    const response = await request("/config/models");
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data.current).toEqual({ model: null, small_model: null, permission: null });
    expect(body.data.available).toEqual([
      {
        id: "model-row-1",
        modelId: "gpt-4o",
        displayName: "GPT-4o",
        provider: "demo",
        providerId: "provider-1",
        providerDisplayName: "Demo",
        contextLimit: 128_000,
        outputLimit: 8_192,
        modalities: ["text"],
        scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
        access: { actions: ["read", "update", "delete"] },
      },
    ]);
  });

  // 来源组织名只给跨组织可见的 Provider：本组织资源加前缀只会让每一行都重复当前组织名。
  test("只有跨组织可见的 Provider 带来源组织名", async () => {
    installFacade({
      list: async () => ({
        items: [
          providerListItem(),
          providerListItem({
            id: "provider-2",
            name: "shared",
            displayName: "Shared",
            organizationId: "org-source",
            visibility: "public",
            scope: { organizationId: "org-source", ownerUserId: "user-source", visibility: "public" },
            access: { actions: ["read"] },
          }),
        ],
        total: 2,
      }),
      getById: async (_actor, resourceId) =>
        providerDetail(resourceId === "provider-2" ? { id: "provider-2", name: "shared", displayName: "Shared" } : {}),
    });
    stubIdentityDirectory({ listOrganizationNames: async () => new Map([["org-source", "来源组织"]]) });

    const body = await (await request("/config/models")).json();

    expect(body.data.available.map((row: { provider: string }) => row.provider)).toEqual(["demo", "shared"]);
    expect(body.data.available[0].organizationName).toBeUndefined();
    expect(body.data.available[1].organizationName).toBe("来源组织");
  });

  // 构建可用列表是 N+1 查询，TTL 内必须命中缓存：第二次请求不能再打一次 Provider 列表。
  test("可用列表在 TTL 内命中按主体缓存", async () => {
    const list = mock(async () => ({ items: [providerListItem()], total: 1 }));
    installFacade({ list, getById: async () => providerDetail() });

    await request("/config/models");
    await request("/config/models");

    expect(list).toHaveBeenCalledTimes(1);
  });

  /**
   * 缓存值是 actor 相关的投影（每行带 Provider 的 `access.actions`），因此不能同组织共享：
   * owner 预热后，同组织的 member 必须拿到按自己的角色推导的 `access`，而不是读到 owner 的。
   * 只按 organizationId 分键会让控制台给 member 显示只有 owner 才有的管理与共享入口。
   */
  test("同组织不同用户不共享可用模型缓存", async () => {
    const list = mock(async () => ({ items: [providerListItem()], total: 1 }));
    installFacade({
      list,
      getById: async (actor) =>
        providerDetail({ access: { actions: actor.userId === "user-1" ? ["read", "update", "delete"] : ["read"] } }),
    });

    const owner = await (await request("/config/models")).json();
    authenticate("org-1", "user-2", "member");
    const member = await (await request("/config/models")).json();

    expect(owner.data.available[0].access).toEqual({ actions: ["read", "update", "delete"] });
    expect(member.data.available[0].access).toEqual({ actions: ["read"] });
    expect(list).toHaveBeenCalledTimes(2);
  });

  // refresh 强制绕过缓存：面板改完上游配置后需要立刻看到新模型，不等 5 分钟。
  test("refresh 绕过缓存强制重建并返回条数", async () => {
    const list = mock(async () => ({ items: [providerListItem()], total: 1 }));
    installFacade({ list, getById: async () => providerDetail() });

    await request("/config/models");
    const response = await json("/config/models/refresh", "POST");

    expect(list).toHaveBeenCalledTimes(2);
    expect(await readJson(response)).toEqual({ success: true, data: { count: 1 } });
  });

  // 缓存按主体隔离：另一个组织的同名用户写入的键不得让当前主体读到它的模型列表。
  test("其他组织的缓存不影响当前主体", async () => {
    const list = mock(async () => ({ items: [providerListItem()], total: 1 }));
    installFacade({ list, getById: async () => providerDetail() });

    writeAvailableModelsCache({ organizationId: "org-2", userId: "user-1" }, [], Date.now());
    const body = await (await request("/config/models")).json();

    expect(list).toHaveBeenCalledTimes(1);
    expect(body.data.available).toHaveLength(1);
    expect(AVAILABLE_MODELS_CACHE_TTL_MS).toBeGreaterThan(0);
  });

  // 三个字段全空的更新是无意义请求，必须在协议层拒绝而不是静默写一次空配置。
  test("偏好更新未提供任何字段返回 400", async () => {
    const setUserConfig = mock(async () => {});
    stubConfigPg({ setUserConfig });

    const response = await json("/config/models", "PUT", {});

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("VALIDATION_ERROR");
    expect(setUserConfig).not.toHaveBeenCalled();
  });

  // 引用不可见的 Provider 与引用不存在的 Provider 对调用方是同一个结论：400，且不得写入偏好。
  test("偏好引用不可读的 Provider 返回 400", async () => {
    const setUserConfig = mock(async () => {});
    stubConfigPg({ setUserConfig });
    installFacade({ get: async () => undefined });

    const response = await json("/config/models", "PUT", { model: "missing/gpt-4o" });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.message).toContain("missing");
    expect(setUserConfig).not.toHaveBeenCalled();
  });

  // Provider 可读但其下没有该模型同样是不可用引用：不得把悬空引用写进用户偏好。
  test("偏好引用 Provider 下不存在的模型返回 400", async () => {
    const setUserConfig = mock(async () => {});
    stubConfigPg({ setUserConfig });
    installFacade({ get: async () => providerDetail() });

    const response = await json("/config/models", "PUT", { model: "demo/nope" });

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("VALIDATION_ERROR");
    expect(setUserConfig).not.toHaveBeenCalled();
  });

  // 三段式引用 `orgId/providerId/modelId` 必须按资源键定位 Provider：跨组织同名 Provider 只有资源键能区分。
  test("偏好接受三段式资源键引用并按资源键定位 Provider", async () => {
    const requested: unknown[] = [];
    const stored: Record<string, unknown>[] = [];
    stubConfigPg({
      getUserConfig: async () => ({ currentModel: "org-1/provider-1/gpt-4o", smallModel: null, permission: null }),
      setUserConfig: async (_subject, value) => {
        stored.push(value);
      },
    });
    installFacade({
      get: async (actor, nameOrKey) => {
        requested.push({ actor, nameOrKey });
        return providerDetail();
      },
    });

    const response = await json("/config/models", "PUT", { model: "org-1/provider-1/gpt-4o" });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect((requested[0] as { nameOrKey: string }).nameOrKey).toBe("org-1/provider-1");
    expect((requested[0] as { actor: { userId: string } }).actor.userId).toBe("user-1");
    expect(stored).toEqual([{ currentModel: "org-1/provider-1/gpt-4o", smallModel: undefined, permission: undefined }]);
    expect(body.data.model).toBe("org-1/provider-1/gpt-4o");
  });

  // 写入偏好后必须失效本组织缓存：否则刷新页面仍会看到旧的"当前模型"标记。
  test("偏好写入后失效本组织缓存", async () => {
    const list = mock(async () => ({ items: [providerListItem()], total: 1 }));
    installFacade({ list, get: async () => providerDetail(), getById: async () => providerDetail() });

    await request("/config/models");
    await json("/config/models", "PUT", { model: "demo/gpt-4o" });
    await request("/config/models");

    expect(list).toHaveBeenCalledTimes(2);
  });

  // 非 `AppError` 的意外异常由信封按 fallbackCode 归为配置读写失败，而不是冒泡成无码 500。
  test("意外异常按 fallbackCode 归一化为配置错误码", async () => {
    installFacade({
      list: async () => {
        throw new TypeError("boom");
      },
    });

    const response = await request("/config/models");
    const body = await readJson(response);

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("CONFIG_READ_ERROR");
  });
});
