import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ActorContext, MemberRole } from "@fenix/platform-sdk";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import type {
  AuthorizedProviderDetail,
  AuthorizedProviderListItem,
  ProviderWriteData,
} from "../server/facades/provider-facade";
import { createApiModelsRoutes } from "../server/routes/api/models";
import {
  createStubModelManagementServerModule,
  createStubProviderFacade,
  installModelManagementModule,
  resetModelManagementModuleForTesting,
} from "../server/testing";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

/**
 * `/api/models` 协议层（对外稳定合同）的边界用例。
 *
 * 这层没有授权判断：可见性、`update`/`delete` 动作与系统托管都在 Facade 内完成，route 只负责「守卫
 * 拒绝 → 401」「Facade 抛 NotFound/Forbidden → 404/403」的映射与响应投影。因此本文件的断言分四类：
 *
 * 1. **身份只能来自守卫**：请求体/查询里的组织与用户字段不得影响 Facade 收到的 actor，否则调用方可以
 *    借 body 把自己"变成"另一个组织的主体（跨组织写）。
 * 2. **不可见即不存在**：Facade 对跨组织资源返回 `undefined` / 抛 `NotFoundError` 时，本层必须给出
 *    404 而不是 403——403 会确认「这个资源存在」，等于泄露资源清单。
 * 3. **凭据不外泄**：Provider 详情/列表的响应投影与错误体都不得出现 `apiKey` 明文。
 * 4. **分页与定位在协议层的边界**：Provider 列表与子 Model 列表都在内存里切片（`total` 是全集条数），
 *    子 Model 详情按行 ID 定位，越界页与缺失子行都必须给出确定结果。
 *
 * 关于「全部端点 401」这条循环的区分力：每个 handler 自己也有 `if (!actor) return error(401)`，而守卫
 * 替身在未解析出主体时只是把 `null` 写进 `store.actor`（不拒绝请求），所以**守卫根本没挂上**时循环
 * 依然全绿——它钉住的是 401 的响应形状，不是「守卫已生效」。身份确实来自守卫这一点由「列表按会话主体
 * 过滤」的用例单独证明（见下方用例）。
 *
 * 装配方式与 `round-config-{models,providers}-routes.test.ts` 一致：注入守卫替身 + 模块替身，不触碰
 * 宿主 `apps/server`（包侧不得依赖宿主守卫，理由见 `./guard-stubs`）。
 */

/** 当前请求的身份；守卫替身按取值函数读取，用例可中途换人。 */
let currentActor: ActorContext | null = null;

const route = createApiModelsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin(() => currentActor) });

function actorFixture(organizationId = "org-1", userId = "user-1", role: MemberRole = "owner"): ActorContext {
  return { kind: "user", userId, activeOrganizationId: organizationId, memberships: [{ organizationId, role }] };
}

function authenticate(organizationId = "org-1", userId = "user-1", role: MemberRole = "owner") {
  currentActor = actorFixture(organizationId, userId, role);
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

/** 子表行的形状；经详情类型取得，避免直接依赖仓储层类型。 */
type ModelRowFixture = AuthorizedProviderDetail["models"][number];

/** 本组织 Provider 详情夹具；`apiKey` 是必须被响应投影丢弃的敏感字段。 */
function providerDetail(overrides: Partial<AuthorizedProviderDetail> = {}): AuthorizedProviderDetail {
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
    apiKey: "sk-live-secret-9f3a",
    extraOptions: null,
    visibility: "private",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId: "org-1", ownerUserId: "user-1", visibility: "private" },
    access: { actions: ["read", "update", "delete"] },
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

function providerListItem(overrides: Partial<AuthorizedProviderListItem> = {}): AuthorizedProviderListItem {
  const { models: _models, ...rest } = providerDetail();
  return { ...rest, modelCount: 1, ...overrides };
}

/** 子表行夹具；`options` 是自由形状 jsonb 列，只在详情投影里出现。 */
function modelRow(overrides: Partial<ModelRowFixture> = {}): ModelRowFixture {
  // 显式断言：`Partial` 展开会让每个字段带上 `undefined`，与行的必填形状不同源。
  return { ...providerDetail().models[0], ...overrides } as ModelRowFixture;
}

/** 装配模块替身；未打桩的方法调用即抛错（见 `../server/testing`），因此漏配会当场暴露。 */
function installFacade(facade: Partial<ReturnType<typeof createStubProviderFacade>>) {
  installModelManagementModule(createStubModelManagementServerModule({ facade: createStubProviderFacade(facade) }));
}

/** 全部端点都挂着 `sessionAuth` 宏；路径统一带 `/api/models` 前缀，和宿主挂载一致。 */
const PROTECTED_ROUTES: ReadonlyArray<{ method: string; path: string; body?: Record<string, unknown> }> = [
  { method: "GET", path: "/providers" },
  { method: "POST", path: "/providers", body: { name: "demo" } },
  { method: "GET", path: "/providers/provider-1" },
  { method: "PUT", path: "/providers/provider-1", body: { displayName: "Renamed" } },
  { method: "DELETE", path: "/providers/provider-1" },
  { method: "GET", path: "/providers/provider-1/models" },
  { method: "POST", path: "/providers/provider-1/models", body: { modelId: "gpt-4o-mini" } },
  { method: "GET", path: "/providers/provider-1/models/model-row-1" },
  { method: "PUT", path: "/providers/provider-1/models/model-row-1", body: { displayName: "Renamed" } },
  { method: "DELETE", path: "/providers/provider-1/models/model-row-1" },
];

describe("/api/models 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetModelManagementModuleForTesting();
    authenticate();
    // 默认替身全部未打桩：任何一条用例若绕过守卫落到 Facade，都会以「未打桩」失败而不是静默通过。
    installFacade({});
  });

  afterEach(() => {
    resetModelManagementModuleForTesting();
    currentActor = null;
  });

  // 会话守卫未解析出主体时，每个端点都必须在进入业务逻辑前拒绝，而不是靠 Facade 兜底。
  // 注意这条循环的区分力上限：handler 自己也有 `!actor` 分支，所以它钉的是 401 的响应形状（含错误码），
  // 不是「守卫已挂上」——后者由下一条用例证明。
  test("缺少主体时全部端点返回 401 且不触达 Facade", async () => {
    currentActor = null;

    for (const entry of PROTECTED_ROUTES) {
      const response =
        entry.body === undefined
          ? await request(`/api/models${entry.path}`)
          : await json(`/api/models${entry.path}`, entry.method, entry.body);

      expect(`${entry.method} ${entry.path} → ${response.status}`).toBe(`${entry.method} ${entry.path} → 401`);
      expect((await readJson(response)).error.code).toBe("UNAUTHORIZED");
    }
  });

  // 守卫确实运行并把会话主体写入 store：Facade 收到的 actor 就是本次会话身份，列表因此只含该组织的数据。
  // 这条是本文件唯一能区分「守卫生效」与「守卫没挂上」的断言——守卫缺席时 store.actor 恒为 null，前面那
  // 条循环依然全绿（handler 自己也会 401）。
  test("守卫把会话主体写入 store，列表按该主体身份过滤", async () => {
    const seenActors: ActorContext[] = [];
    installFacade({
      list: async (actor) => {
        seenActors.push(actor);
        return actor.activeOrganizationId === "org-2"
          ? { items: [providerListItem({ id: "provider-b", name: "b" })], total: 1 }
          : { items: [providerListItem({ id: "provider-a", name: "a" })], total: 1 };
      },
    });

    authenticate("org-2", "user-9");
    const external = await readJson(await request("/api/models/providers"));
    expect(seenActors).toHaveLength(1);
    expect(seenActors[0]?.activeOrganizationId).toBe("org-2");
    expect(seenActors[0]?.userId).toBe("user-9");
    expect(external.items.map((item: { id: string }) => item.id)).toEqual(["provider-b"]);

    // 换一个身份再发一次：同一实例上每次请求都重新由守卫写入主体，不会沿用上一次的 actor。
    authenticate("org-1", "user-1");
    const internal = await readJson(await request("/api/models/providers"));
    expect(seenActors[1]?.activeOrganizationId).toBe("org-1");
    expect(internal.items.map((item: { id: string }) => item.id)).toEqual(["provider-a"]);
  });

  // 请求体里的组织/用户字段不得影响身份：actor 只能来自守卫解析，否则调用方能把写入落到别的组织。
  test("请求体不能改写身份，组织上下文取自守卫注入的 actor", async () => {
    const received: Array<{ actor: ActorContext; name: string; data: ProviderWriteData }> = [];
    installFacade({
      get: async () => undefined,
      save: async (actor, name, data) => {
        received.push({ actor, name, data });
        return providerDetail();
      },
    });

    const response = await json("/api/models/providers", "POST", {
      name: "demo",
      organizationId: "org-2",
      userId: "user-2",
      resourceAccess: { scope: { organizationId: "org-2" } },
    });

    expect(response.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]?.actor.activeOrganizationId).toBe("org-1");
    expect(received[0]?.actor.userId).toBe("user-1");
    expect(received[0]?.data).not.toHaveProperty("organizationId");
    // `ownership` 由「资源归属组织 vs 当前 active organization」比较得出：body 若能改写身份，这里会变成 external。
    const body = await readJson(response);
    expect(body.resourceAccess.ownership).toBe("internal");
    expect(body.resourceAccess.sourceOrganizationId).toBe("org-1");
  });

  // 跨组织不可见的 Provider 对调用方必须表现为「不存在」：404 不确认资源存在，不泄露他人资源清单。
  test("跨组织不可见的 Provider 读、写、删都返回 404", async () => {
    installFacade({
      getById: async () => undefined,
      remove: async () => {
        throw new NotFoundError("Provider 'shared' not found");
      },
      updateModel: async () => {
        throw new NotFoundError("Provider 'shared' not found");
      },
    });

    const read = await request("/api/models/providers/shared");
    const createModel = await json("/api/models/providers/shared/models", "POST", { modelId: "gpt-4o" });
    const updateModel = await json("/api/models/providers/shared/models/model-row-1", "PUT", { displayName: "x" });
    const remove = await request("/api/models/providers/shared", { method: "DELETE" });

    for (const response of [read, createModel, updateModel, remove]) {
      expect(response.status).toBe(404);
      expect((await readJson(response)).error.code).toBe("NOT_FOUND");
    }
  });

  // 可见但无 update 动作（跨组织只读共享）时，写入必须 403：可见性不等于可改。
  test("无 update 动作时更新 Provider 返回 403", async () => {
    installFacade({
      saveById: async () => {
        throw new ForbiddenError("Provider 'shared' is read-only for the active organization");
      },
    });

    const response = await json("/api/models/providers/shared", "PUT", { displayName: "Renamed" });

    expect(response.status).toBe(403);
    expect((await readJson(response)).error.code).toBe("FORBIDDEN");
  });

  // Provider 详情响应不得出现 apiKey 明文：投影与响应 schema 都要把它挡在外面。
  test("Provider 详情与列表响应不含 apiKey 明文", async () => {
    installFacade({
      getById: async () => providerDetail(),
      list: async () => ({ items: [providerListItem()], total: 1 }),
    });

    const detail = await request("/api/models/providers/provider-1");
    const list = await request("/api/models/providers");

    expect(detail.status).toBe(200);
    expect(list.status).toBe(200);
    // 先读文本再解析：Response body 只能消费一次，密钥断言针对的是真正发出去的字节。
    const detailText = await detail.text();
    const listText = await list.text();
    expect(detailText).not.toContain("sk-live-secret-9f3a");
    expect(listText).not.toContain("sk-live-secret-9f3a");
    expect(JSON.parse(detailText)).not.toHaveProperty("apiKey");
    expect(JSON.parse(listText).items[0]).not.toHaveProperty("apiKey");
  });

  // 列表分页在内存里切片（Facade 返回当前主体可见的全集），`total` 必须是全集条数而不是当前页条数。
  test("列表按 page/pageSize 切片且 total 为全集条数", async () => {
    const items = ["a", "b", "c"].map((name) =>
      providerListItem({ id: `provider-${name}`, name, displayName: name.toUpperCase() }),
    );
    installFacade({ list: async () => ({ items, total: items.length }) });

    const body = await readJson(await request("/api/models/providers?page=2&pageSize=1"));

    expect(body.total).toBe(3);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(1);
    expect(body.items.map((item: { name: string }) => item.name)).toEqual(["b"]);
  });

  // 子 Model 列表在内存里切片：`total` 是子行全集条数而不是当前页条数，调用方据此翻页。
  test("子 Model 列表按 page/pageSize 切片且 total 为子行全集条数", async () => {
    const models = [
      modelRow({ id: "model-row-1", modelId: "gpt-4o" }),
      modelRow({ id: "model-row-2", modelId: "gpt-4o-mini" }),
    ];
    installFacade({ getById: async () => providerDetail({ models }) });

    const body = await readJson(await request("/api/models/providers/provider-1/models?page=2&pageSize=1"));

    expect(body.total).toBe(2);
    expect(body.page).toBe(2);
    expect(body.pageSize).toBe(1);
    expect(body.items.map((item: { modelId: string }) => item.modelId)).toEqual(["gpt-4o-mini"]);
    // 独立 Model 视图带父级名称（内嵌摘要不带），列表项因此可以自解释。
    expect(body.items[0].providerName).toBe("demo");
  });

  // 越界页不是错误：返回空 items 且 total 仍是全集条数，调用方据此判断已经翻到底。
  test("子 Model 列表越界页码返回空 items 且保留 total", async () => {
    installFacade({ getById: async () => providerDetail() });

    const body = await readJson(await request("/api/models/providers/provider-1/models?page=99&pageSize=20"));

    expect(body.items).toEqual([]);
    expect(body.total).toBe(1);
  });

  // 子 Model 详情按行 ID 定位：`options` 只在这里投影（内嵌摘要不含），且必须回带父级名称。
  test("子 Model 详情按行 ID 定位并投影 options", async () => {
    installFacade({
      getById: async () => providerDetail({ models: [modelRow({ options: { temperature: 0.2 } })] }),
    });

    const body = await readJson(await request("/api/models/providers/provider-1/models/model-row-1"));

    expect(body).toEqual({
      providerId: "provider-1",
      id: "model-row-1",
      modelId: "gpt-4o",
      providerName: "demo",
      displayName: "GPT-4o",
      modalities: ["text"],
      limitConfig: { context: 128_000, output: 8_192 },
      cost: null,
      options: { temperature: 0.2 },
    });
  });

  // 行 ID 不在该 Provider 的子行里时必须 404：不能回退成空对象，也不能泄露其它 Provider 的同名行。
  test("子 Model 详情行 ID 不存在时返回 404", async () => {
    installFacade({ getById: async () => providerDetail() });

    const response = await request("/api/models/providers/provider-1/models/model-row-missing");

    expect(response.status).toBe(404);
    expect((await readJson(response)).error.code).toBe("NOT_FOUND");
  });

  // 不可见 Provider 的子行一律表现为「不存在」：列表与详情都 404，不确认 Provider 存在。
  test("不可见 Provider 的子 Model 列表与详情返回 404", async () => {
    installFacade({ getById: async () => undefined });

    const list = await request("/api/models/providers/shared/models");
    const detail = await request("/api/models/providers/shared/models/model-row-1");

    for (const response of [list, detail]) {
      expect(response.status).toBe(404);
      expect((await readJson(response)).error.code).toBe("NOT_FOUND");
    }
  });

  // 创建重名 Provider 是协议层判定（唯一索引冲突在 Facade 侧不表达），必须 409 且不调用写入。
  test("创建重名 Provider 返回 409 且不写入", async () => {
    const save = mock(async () => providerDetail());
    installFacade({ get: async () => providerDetail(), save });

    const response = await json("/api/models/providers", "POST", { name: "demo" });

    expect(response.status).toBe(409);
    expect((await readJson(response)).error.code).toBe("CONFLICT");
    expect(save).not.toHaveBeenCalled();
  });

  // 删除 Model 回传被删行的 modelId（Facade 在删除前已定位过子行），调用方无需再查一次。
  test("删除 Model 回传被删行的 modelId", async () => {
    installFacade({
      removeModel: async () => ({
        provider: providerDetail(),
        modelId: "gpt-4o",
      }),
    });

    const body = await readJson(
      await request("/api/models/providers/provider-1/models/model-row-1", { method: "DELETE" }),
    );

    expect(body).toEqual({ providerId: "provider-1", id: "model-row-1", modelId: "gpt-4o", deleted: true });
  });
});
