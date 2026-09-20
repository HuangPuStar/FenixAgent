// 路由工厂的协议映射：路径、状态码、信封形状、请求体校验接线，以及「认证上下文 → 服务入参」这条
// 唯一身份来源。守卫是替身（见 ./guard-stubs 的覆盖声明），因此这里证明的是路由构造与协议映射。
//
// 路径不含 `/web` 前缀：该前缀由宿主 `apps/server/src/routes/web{,/config}/index.ts` 的路由组添加，
// 包内只声明相对于该组的路径。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeTestApplicationInfrastructure, resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import { createWebConfigProdViewsRoutes } from "../server/routes/web/config/prod-views";
import { createWebProdViewsRoutes } from "../server/routes/web/prod-views";
import { type ProdViewServiceDeps, setProdViewDeps } from "../server/services/prod-view";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";
import { AGENT_ID, createProdViewDbStub, type ProdViewDbStub, prodViewRow } from "./prod-view-db-stub";

const ACTOR = { organizationId: "org-1", userId: "user-1" };

// 守卫替身按插件名去重，且与宿主的真实守卫同源：两个工厂共用一份实例（生产同样是注入同一个守卫）。
const authGuardPlugin = createStubSessionAuthGuardPlugin(ACTOR);
const configRoutes = createWebConfigProdViewsRoutes({ authGuardPlugin });
const loadRoutes = createWebProdViewsRoutes({ authGuardPlugin });

/** 装配 DB 替身（先登记句柄、再初始化基础设施）。 */
function installDbStub(stub: ProdViewDbStub): void {
  resetAllStubs();
  stubDb(stub.db);
  initializeTestApplicationInfrastructure();
}

/** 装配加载端点需要的外部能力替身：返回由入参派生的 id，便于断言链路。 */
function installLoadDeps(): void {
  setProdViewDeps({
    createWebEnvironment: async (params) => ({ id: `env-for-${params.agentConfigId}` }),
    findOrCreateDefaultInstance: async (environmentId) => ({ id: `inst-for-${environmentId}` }),
  } satisfies Partial<ProdViewServiceDeps>);
}

/** 以 JSON 请求体发起写请求；`method` 取 REST 动词，路径为包内相对路径。 */
function sendJson(
  routes: { handle: (request: Request) => Promise<Response> },
  method: string,
  path: string,
  body?: unknown,
) {
  return routes.handle(
    new Request(`http://localhost${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

describe("Web Config ProdView 路由", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    setProdViewDeps(null);
    resetAllStubs();
  });

  // 列表返回成功信封与数据数组：前端 `unwrap()` 依赖 `{ success, data }` 形状，缺一层就会解包失败。
  test("GET /config/prod-views 返回成功信封", async () => {
    installDbStub(createProdViewDbStub([prodViewRow({ id: "pv-1", name: "发布视图" })]));

    const response = await configRoutes.handle(new Request("http://localhost/config/prod-views"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: Array<{ id: string; name: string }> };
    expect(body.success).toBe(true);
    expect(body.data.map((row) => row.id)).toEqual(["pv-1"]);
  });

  // 详情命中时返回行本体，且不得把组织等内部列裁剪掉（前端按行建模，字段缺失会静默变 undefined）。
  test("GET /config/prod-views/:id 命中时返回行", async () => {
    installDbStub(createProdViewDbStub([prodViewRow({ id: "pv-1", organizationId: "org-1" })]));

    const response = await configRoutes.handle(new Request("http://localhost/config/prod-views/pv-1"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: { id: string; organizationId: string } };
    expect(body.data).toMatchObject({ id: "pv-1", organizationId: "org-1" });
  });

  // 详情未命中：**现状是 422** 而不是路由声明的 404 —— 处理器把失败信封以默认 200 状态返回，撞上
  // `OkResponseSchema`（要求 `success: true`）后被 Elysia 的响应校验拒绝。该缺陷在迁移前既存（HEAD 的
  // 处理器与响应声明同样如此写），修复属对外协议行为变更，不在本波范围，故此处只钉住现状避免无声漂移。
  test("GET /config/prod-views/:id 未命中时按现状返回 422（既有缺陷）", async () => {
    installDbStub(createProdViewDbStub([]));

    const response = await configRoutes.handle(new Request("http://localhost/config/prod-views/pv-missing"));

    expect(response.status).toBe(422);
    // 客户端拿到的是 Elysia 的校验错误体，而不是 `{ success: false, error }` 信封。
    expect(await response.json()).not.toHaveProperty("success");
  });

  // 创建的组织与创建者必须来自认证上下文：请求体里夹带的同名值不得被采信（否则可把视图写到别人组织）。
  test("POST /config/prod-views 以认证上下文的组织与用户落库", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    const response = await sendJson(configRoutes, "POST", "/config/prod-views", {
      name: "新视图",
      agentId: AGENT_ID,
      organizationId: "org-attacker",
      createdBy: "user-attacker",
    });

    expect(response.status).toBe(200);
    expect(stub.writes.inserts).toHaveLength(1);
    expect(stub.writes.inserts[0]).toMatchObject({ organizationId: "org-1", createdBy: "user-1", name: "新视图" });
  });

  // 请求体校验必须挂在路由上：agentId 非 uuid 时不得进入服务（否则会先写库再在关联约束处失败）。
  test("POST /config/prod-views 请求体非法时拒绝且不写库", async () => {
    const stub = createProdViewDbStub([]);
    installDbStub(stub);

    const response = await sendJson(configRoutes, "POST", "/config/prod-views", {
      name: "新视图",
      agentId: "not-a-uuid",
    });

    // 具体状态码由 Elysia 的校验错误处理器决定（当前为 422），这里只钉住「非成功 + 未落库」。
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(stub.writes.inserts).toHaveLength(0);
  });

  // 更新命中时 200 并返回更新后的行；补丁只含本次请求给出的字段（含 name）。
  test("PUT /config/prod-views/:id 命中时返回更新后的行", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1", name: "旧名" })]);
    installDbStub(stub);

    const response = await sendJson(configRoutes, "PUT", "/config/prod-views/pv-1", { name: "新名" });

    expect(response.status).toBe(200);
    expect(stub.writes.patches[0]).toMatchObject({ name: "新名" });
    expect((await response.json()) as { data: { name: string } }).toMatchObject({ data: { name: "新名" } });
  });

  // 更新未命中映射 404（不是 400/409）：记录不存在与请求不合法是两种可区分的语义。
  test("PUT /config/prod-views/:id 未命中时返回 404", async () => {
    installDbStub(createProdViewDbStub([]));

    const response = await sendJson(configRoutes, "PUT", "/config/prod-views/pv-missing", { name: "新名" });

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 删除成功返回 `{ ok: true }` 信封，并真的走到 DELETE 语句。
  test("DELETE /config/prod-views/:id 命中时返回 ok", async () => {
    const stub = createProdViewDbStub([prodViewRow({ id: "pv-1" })]);
    installDbStub(stub);

    const response = await sendJson(configRoutes, "DELETE", "/config/prod-views/pv-1");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { ok: true } });
    expect(stub.store).toHaveLength(0);
  });

  // 删除未命中映射 404，不得回 200 让前端以为下线成功。
  test("DELETE /config/prod-views/:id 未命中时返回 404", async () => {
    installDbStub(createProdViewDbStub([]));

    const response = await sendJson(configRoutes, "DELETE", "/config/prod-views/pv-missing");

    expect(response.status).toBe(404);
  });
});

describe("Web ProdView 加载路由", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    setProdViewDeps(null);
    resetAllStubs();
  });

  // 公开读取端点：命中且启用时返回环境与实例身份，供前端连接持久实例。
  test("GET /prod-views/:id/load 命中时返回环境与实例身份", async () => {
    installDbStub(createProdViewDbStub([prodViewRow({ id: "pv-1", agentId: AGENT_ID, enabled: true })]));
    installLoadDeps();

    const response = await loadRoutes.handle(new Request("http://localhost/prod-views/pv-1/load"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: Record<string, unknown> };
    expect(body).toMatchObject({
      success: true,
      data: {
        agentConfigId: AGENT_ID,
        environmentId: `env-for-${AGENT_ID}`,
        instanceUid: `inst-for-env-for-${AGENT_ID}`,
      },
    });
  });

  // 未命中与停用都映射为 404（统一的「不可访问」对外表现），且错误码可区分以便排查。
  test("GET /prod-views/:id/load 未命中时返回 404 NOT_FOUND", async () => {
    installDbStub(createProdViewDbStub([]));
    installLoadDeps();

    const response = await loadRoutes.handle(new Request("http://localhost/prod-views/pv-missing/load"));

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "NOT_FOUND" } });
  });

  // 停用视图对访客返回 404 DISABLED：停用必须是访客侧可观测的拒绝。
  test("GET /prod-views/:id/load 视图停用时返回 404 DISABLED", async () => {
    installDbStub(createProdViewDbStub([prodViewRow({ id: "pv-1", enabled: false })]));
    installLoadDeps();

    const response = await loadRoutes.handle(new Request("http://localhost/prod-views/pv-1/load"));

    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toMatchObject({ error: { code: "DISABLED" } });
  });
});
