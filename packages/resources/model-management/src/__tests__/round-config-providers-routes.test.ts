import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "@server/errors";
import { resetTestAuth, setTestAuth } from "@server/plugins/auth";
import { setTestOrgContext } from "@server/services/org-context";
import { readJson, resetAllStubs } from "@server/test-utils/helpers";
import type { AuthorizedProviderDetail, AuthorizedProviderListItem } from "../server/facades/provider-facade";
import {
  createStubModelManagementServerModule,
  createStubProviderFacade,
  installModelManagementModule,
  resetModelManagementModuleForTesting,
} from "../server/testing";

/**
 * `/web/config/providers` 协议层的接缝迁移（决策 D2 + 计划 S5）。
 *
 * 授权、系统托管拒绝、归属解析、Model 跟随 Provider 的编排都已收敛到 `ProviderFacade`，因此路由用例
 * 只替换模块替身：Facade 表达"授权后看到什么 / 什么时候拒绝"，路由用例断言协议形状与状态码。
 *
 * 视图返回 `scope + access`（当前主体的归属与有效动作），旧栈的 `resourceAccess` 不再出现在 `/web`
 * 响应里；错误码（`VALIDATION_ERROR` / `NOT_FOUND` / `FORBIDDEN`）与文案仍是迁移前的逐字契约。
 */

const route = (await import("../server/routes/web/config/providers")).default;

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

/** 列表项夹具；`access.actions` 是前端的"能否编辑"判据。 */
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
    modelCount: 2,
    ...overrides,
  };
}

/** 详情夹具；`models` 是子行快照。 */
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
        modalities: null,
        limitConfig: null,
        cost: null,
        options: null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
    ],
    ...overrides,
  };
}

/** 用给定 Facade 覆盖装配模块替身；其余依赖保持替身默认。 */
function installFacade(facade: Partial<ReturnType<typeof createStubProviderFacade>>) {
  installModelManagementModule(createStubModelManagementServerModule({ facade: createStubProviderFacade(facade) }));
}

describe("Provider 配置 Web 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetModelManagementModuleForTesting();
    authenticate();
    installFacade({ list: async () => ({ items: [], total: 0 }) });
  });

  afterEach(() => {
    resetModelManagementModuleForTesting();
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 列表返回 Facade 的可见集合，并投影为控制台字段：归属与动作原样透传，密钥只出 keyHint。
  test("列表返回 scope/access 与 keyHint，不回显密钥", async () => {
    installFacade({ list: async () => ({ items: [providerListItem()], total: 1 }) });

    const response = await request("/config/providers");
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const [item] = body.data.providers;
    expect(item.providerId).toBe("provider-1");
    expect(item.id).toBe("demo");
    expect(item.name).toBe("Demo");
    expect(item.modelCount).toBe(2);
    expect(item.scope).toEqual({ organizationId: "org-1", ownerUserId: "user-1", visibility: "private" });
    expect(item.access).toEqual({ actions: ["read", "update", "delete"] });
    // 视图只出掩码：前 4 位 + 后 3 位，明文密钥不可能出现在响应里。
    expect(item.keyHint).toBe("sk-t***der");
  });

  // 详情按名称定位，子模型只暴露展示字段：继承来的 Provider 权限不再逐行重复一份。
  test("详情按名称返回子模型投影", async () => {
    installFacade({ get: async () => providerDetail() });

    const response = await request("/config/providers?name=demo");
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.data.id).toBe("demo");
    expect(body.data.models).toEqual([{ id: "gpt-4o", name: "GPT-4o", modalities: null, limit: null, cost: null }]);
  });

  // Facade 的 undefined 是"授权后不可见"，协议层必须映射为 404 而不是 500 或空对象。
  test("不可见的详情返回 404", async () => {
    installFacade({ get: async () => undefined });

    const response = await request("/config/providers?name=missing");
    const body = await readJson(response);

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  // 缺 name 属于协议层校验：必须在进入应用层之前返回 400，不得让 Facade 收到空名称。
  test("写路径缺少 name 返回 400", async () => {
    const save = mock(async () => providerDetail());
    installFacade({ save });

    const response = await json("/config/providers", "PUT", { protocol: "openai" });
    const body = await readJson(response);

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(save).not.toHaveBeenCalled();
  });

  // 保存把已知字段拆到顶层、未知键并入 extraOptions，公开受众经 options 传给 Facade。
  test("保存拆分顶层字段与 extraOptions", async () => {
    const calls: unknown[] = [];
    installFacade({
      get: async () => providerDetail(),
      save: async (...args) => {
        calls.push(args);
        return providerDetail();
      },
    });

    const response = await json("/config/providers?name=demo", "PUT", {
      name: "Renamed",
      protocol: "anthropic",
      baseURL: "https://upstream.test/v2",
      apiKey: "sk-inline",
      options: { apiKey: "sk-not-persisted", region: "cn" },
      publicReadable: true,
      customField: "kept",
    });
    const body = await readJson(response);

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    const [actor, name, data, options] = calls[0] as [
      { userId: string },
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(actor.userId).toBe("user-1");
    expect(name).toBe("demo");
    expect(data).toMatchObject({
      displayName: "Renamed",
      protocol: "anthropic",
      baseUrl: "https://upstream.test/v2",
      apiKey: "sk-inline",
    });
    // 凭据与 baseURL 是**列**而不是 jsonb 里的自由键：写在 `options` 里的同名键会被丢弃，
    // 不得落进 extraOptions——否则 apiKey 会以明文形式长期留在 extra_options 里。
    expect(data.extraOptions).toEqual({ region: "cn", customField: "kept" });
    expect(options).toEqual({ publicReadable: true });
  });

  // 随保存提交的模型清单按 modelId 分派到 add / update，不得静默跳过子表写入。
  test("保存时按 modelId 分派模型的增改", async () => {
    const added: unknown[] = [];
    const updated: unknown[] = [];
    installFacade({
      get: async () => providerDetail(),
      save: async () => providerDetail(),
      addModel: async (...args) => {
        added.push(args);
        return { modelId: "claude-3" };
      },
      updateModel: async (...args) => {
        updated.push(args);
        return { modelId: "gpt-4o" };
      },
    });

    const response = await json("/config/providers?name=demo", "PUT", {
      models: { "gpt-4o": { name: "GPT-4o 更新" }, "claude-3": { name: "Claude" } },
    });

    expect(response.status).toBe(200);
    expect(updated).toHaveLength(1);
    expect(added).toHaveLength(1);
    expect((updated[0] as [unknown, unknown, { value: string }])[2]).toEqual({ by: "modelId", value: "gpt-4o" });
    expect((added[0] as [unknown, unknown, string])[2]).toBe("claude-3");
  });

  // 只读共享 Provider 的写入由 Facade 拒绝，路由把它映射为 403 而不是 500。
  test("保存只读共享 Provider 返回 403", async () => {
    installFacade({
      get: async () => providerDetail(),
      save: async () => {
        throw new ForbiddenError("只读共享资源");
      },
    });

    const response = await json("/config/providers?name=org-source%2Fshared", "PUT", { protocol: "openai" });
    const body = await readJson(response);

    expect(response.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
  });

  // 删除成功返回 data: null；Facade 抛 NotFoundError 时映射为 404。
  test("删除成功返回空数据，不可见时返回 404", async () => {
    installFacade({ remove: async () => undefined });
    const ok = await json("/config/providers?name=demo", "DELETE");
    expect(ok.status).toBe(200);
    expect((await readJson(ok)).data).toBeNull();

    installFacade({
      remove: async () => {
        throw new NotFoundError("Provider 'demo' not found");
      },
    });
    const missing = await json("/config/providers?name=demo", "DELETE");
    expect(missing.status).toBe(404);
    expect((await readJson(missing)).error.code).toBe("NOT_FOUND");
  });

  // 子表写路径缺失或未知 modelId 时先于 Facade 写入返回 400 / 404。
  test("新增模型缺 modelId 返回 400，重复 modelId 返回 400", async () => {
    const addModel = mock(async () => ({ modelId: "gpt-4o" }));
    installFacade({ getWritable: async () => providerDetail(), addModel });

    const missing = await json("/config/providers/actions/models?name=demo", "POST", {});
    expect(missing.status).toBe(400);
    expect((await readJson(missing)).error.code).toBe("VALIDATION_ERROR");

    const duplicated = await json("/config/providers/actions/models?name=demo", "POST", { modelId: "gpt-4o" });
    expect(duplicated.status).toBe(400);
    expect((await readJson(duplicated)).error.code).toBe("VALIDATION_ERROR");
    expect(addModel).not.toHaveBeenCalled();
  });

  // 更新 / 删除子模型时 modelId 必须已存在：否则会写出一个悬空的子行。
  test("更新未知模型返回 404，删除未知模型返回 404", async () => {
    installFacade({ getWritable: async () => providerDetail() });

    const updated = await json("/config/providers/actions/models/nope?name=demo", "PUT", {});
    expect(updated.status).toBe(404);
    expect((await readJson(updated)).error.code).toBe("NOT_FOUND");

    const removed = await json("/config/providers/actions/models/nope?name=demo", "DELETE");
    expect(removed.status).toBe(404);
    expect((await readJson(removed)).error.code).toBe("NOT_FOUND");
  });

  // 子表写入的授权前置由 Facade 的 getWritable 承担：抛 ForbiddenError 时路由不得继续写。
  test("子表写入不可见或只读时返回 403", async () => {
    const addModel = mock(async () => ({ modelId: "gpt-4o" }));
    installFacade({
      getWritable: async () => {
        throw new ForbiddenError("只读共享资源");
      },
      addModel,
    });

    const response = await json("/config/providers/actions/models?name=demo", "POST", { modelId: "gpt-4o" });

    expect(response.status).toBe(403);
    expect((await readJson(response)).error.code).toBe("FORBIDDEN");
    expect(addModel).not.toHaveBeenCalled();
  });

  // 连通性探测读取走 getForProbe（要求 update 动作），不可探测时返回 404，不向上游发起请求。
  test("测试模型时不可探测返回 404，未登记模型返回 404", async () => {
    installFacade({ getForProbe: async () => undefined });
    const untouchable = await json("/config/providers/actions/test-model?name=demo", "POST", { modelId: "gpt-4o" });
    expect(untouchable.status).toBe(404);

    installFacade({ getForProbe: async () => providerDetail() });
    const unknownModel = await json("/config/providers/actions/test-model?name=demo", "POST", { modelId: "nope" });
    expect(unknownModel.status).toBe(404);
    expect((await readJson(unknownModel)).error.code).toBe("NOT_FOUND");
  });

  // 测试模型缺少 modelId 是协议层校验：不得让探测带着空串打到上游。
  test("测试模型缺 modelId 返回 400", async () => {
    const getForProbe = mock(async () => providerDetail());
    installFacade({ getForProbe });

    const response = await json("/config/providers/actions/test-model?name=demo", "POST", {});

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("VALIDATION_ERROR");
    expect(getForProbe).not.toHaveBeenCalled();
  });

  // 内联凭据分支（面板"先测后存"）不读库：Provider 尚未落库，没有资源可授权。
  test("内联凭据的 fetch-models 不读取已存配置", async () => {
    const getForProbe = mock(async () => providerDetail());
    installFacade({ getForProbe });

    // 只断言分支选择：真实探测会发出站请求，这里让它在连接阶段失败即可，不改变被测行为。
    const response = await json("/config/providers/actions/fetch-models?name=demo", "POST", {
      apiKey: "sk-inline",
      protocol: "openai",
      baseURL: "http://127.0.0.1:1",
    });

    expect(response.status).toBe(500);
    expect(getForProbe).not.toHaveBeenCalled();
  });
});
