import { expect, test } from "bun:test";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { type AnyElysia, Elysia } from "elysia";
import { moduleManifest } from "../../fenix.module";
import { createProdViewWebConfigRoutes, createProdViewWebRoutes } from "../server/assembly";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

/**
 * ProdView 的路由贡献装配契约（1.5e 试点）。
 *
 * 这里锁定的是 manifest 声明的两条 app-route 贡献：`slot` 决定挂宿主的哪个聚合面，`value` 是惰性构造
 * 函数——两个字段任一写错都会让整组端点在宿主侧消失（`/web/prod-views/:id/load` 或
 * `/web/config/prod-views`），而宿主装配处的校验只能发现「槽未知」和「没返回 Elysia」，发现不了
 * 「挂错面」。
 *
 * 守卫是替身（见 ./guard-stubs 的覆盖声明），本用例只证明「贡献声明的形状」与「收窄后的构造函数产出
 * 的路径」，不证明鉴权生效。
 */

/** 装配期宿主会传入的协议面；本包只读 `authGuardPlugin`，其余字段按契约占位。 */
const host: ServerRouteHost = {
  authGuardPlugin: createStubSessionAuthGuardPlugin({ organizationId: "org-1", userId: "user-1" }),
  systemApiGuardPlugin: undefined,
  authenticateRequest: undefined,
  environmentLookup: undefined,
  userAgentPreferences: undefined,
  userModelPreferences: undefined,
  resolveSecretReference: undefined,
};

/** 取某条贡献的惰性构造函数；形状不对就让用例当场失败，而不是断言一堆 undefined。 */
function routeFactory(id: string): (host: ServerRouteHost) => Promise<AnyElysia> {
  const contribution = moduleManifest.contributions?.find((entry) => entry.id === id);
  if (!contribution || typeof contribution.value !== "function") {
    throw new Error(`manifest 缺少可调用的路由贡献 ${id}`);
  }
  return contribution.value as (host: ServerRouteHost) => Promise<AnyElysia>;
}

/** 路由实例注册的路径集合；宿主据此判断端点是否真的可用。 */
function routePaths(routes: AnyElysia): string[] {
  return routes.routes.map((route) => route.path);
}

// 两条路由贡献必须分别指向 web 与 web-config 槽：路径是相对形式，挂错面等于整组端点的 URL 前缀错位。
test("manifest 声明两条路由贡献并各自指明聚合槽", () => {
  expect(moduleManifest.contributions?.map((entry) => [entry.id, entry.kind, entry.slot])).toEqual([
    ["prod-view.web", "app-route", "web"],
    ["prod-view.web-config", "app-route", "web-config"],
  ]);
});

// 贡献的构造函数必须产出真实路由实例（宿主会 `instanceof Elysia` 校验），路径保持相对形式。
test("web 槽的贡献产出 /prod-views/:id/load 路由", async () => {
  const routes = await routeFactory("prod-view.web")(host);

  expect(routes).toBeInstanceOf(Elysia);
  expect(routePaths(routes)).toEqual(["/prod-views/:id/load"]);
});

// config 槽的贡献产出管理 CRUD 路由；与上面的用例分开，避免「两条贡献共用一份实现」时互相掩盖。
test("web-config 槽的贡献产出 /config/prod-views 路由组", async () => {
  const routes = await routeFactory("prod-view.web-config")(host);

  expect(routes).toBeInstanceOf(Elysia);
  expect(routePaths(routes)).toContain("/config/prod-views");
  expect(routePaths(routes)).toContain("/config/prod-views/:id");
});

// 收窄函数与路由工厂是同一份契约的两端：直接调用 assembly 的导出必须给出与贡献相同的路径集合。
test("assembly 的收窄结果与贡献一致", () => {
  expect(routePaths(createProdViewWebRoutes(host))).toEqual(["/prod-views/:id/load"]);
  expect(routePaths(createProdViewWebConfigRoutes(host))).toContain("/config/prod-views");
});
