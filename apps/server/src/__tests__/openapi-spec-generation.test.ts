import { expect, test } from "bun:test";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { Elysia } from "elysia";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { serverRouteHost } from "../bootstrap/route-host";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "../openapi";

/**
 * 两份文档的 spec 生成必须对**真实**路由贡献成功（1.5f-1b 回归防护）。
 *
 * 背景：`@elysiajs/openapi` 在配置了 `exclude.tags` 时无条件读 `hooks.detail.tags`（1.4.15
 * `toOpenAPISchema`），因此任意一条缺 `detail` 的路由会让**整份** spec 抛 `TypeError`，
 * `/docs/openapi/web/json` 与 `/docs/openapi/external/json` 同时 500——失效面是全部文档，而不是那一条
 * 路由。`/hooks/:publicHash` 随「Webhook 入口迁回 workflow 包」恢复挂载时漏了 `detail`，当时没有任何
 * 测试覆盖文档生成，问题只能在浏览器里撞见。
 *
 * 本用例不启运行面也不连库：路由工厂只做 HTTP 边缘接线，构造它们不需要领域依赖（与装配期
 * `mountServerRouteContribution` 的调用方式一致），因此这条防线足够便宜、可以常驻。
 */

/** Elysia 路由路径 `:name` → OpenAPI 路径 `{name}`；用于把贡献路由与文档里的 path 对齐比对。 */
function toOpenApiPath(path: string): string {
  return path.replace(/:([^/]+)/g, "{$1}");
}

/**
 * 构造真实模块贡献出的全部路由实例。
 *
 * 非 `app-route` 贡献（协议、生命周期）不参与 HTTP 文档面，跳过。
 */
async function collectContributedRoutes() {
  const instances: Elysia[] = [];
  const declared: string[] = [];

  // 收窄到契约面：生成物用 `as const satisfies` 保留各 manifest 的字面量类型，联合类型上访问不到
  // 「只有部分模块声明」的可选字段（`contributions`），与 `module-assembly.test.ts` 同口径。
  const manifests: readonly ModuleManifest[] = generatedModuleManifests;

  for (const manifest of manifests) {
    for (const contribution of manifest.contributions ?? []) {
      if (contribution.kind !== "app-route") continue;
      const built = await (contribution.value as (host: typeof serverRouteHost) => unknown)(serverRouteHost);
      // 与 `mountServerRouteContribution` 同口径：工厂必须产出 Elysia 实例，否则装配期就会失败。
      if (!(built instanceof Elysia)) throw new Error(`贡献 ${manifest.id}/${contribution.id} 未产出 Elysia 实例`);
      instances.push(built);

      for (const route of built.routes) {
        if (route.hooks?.detail?.hide) continue;
        // 一条路由可声明多个方法（Elysia 的 `route.method` 此时是数组），逐方法比对。
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) declared.push(`${method} ${toOpenApiPath(route.path)}`);
      }
    }
  }

  return { instances, declared };
}

// 真实贡献路由挂载后，两份 spec 必须都能生成，且未标记隐藏的路由必须至少出现在其中一份文档里。
test("真实路由贡献下两份 OpenAPI spec 均可生成且覆盖未隐藏路由", async () => {
  const { instances, declared } = await collectContributedRoutes();
  expect(declared.length).toBeGreaterThan(0);

  const app = new Elysia().use(createExternalOpenApiPlugin("test")).use(createWebOpenApiPlugin("test")).use(instances);

  const specs: Record<string, { paths: Record<string, Record<string, unknown>> }> = {};
  for (const [name, path] of [
    ["external", "/docs/openapi/external/json"],
    ["web", "/docs/openapi/web/json"],
  ] as const) {
    const response = await app.handle(new Request(`http://localhost${path}`));
    // 失败时把响应体带进断言消息：spec 生成抛错时插件返回 500 与一行错误文本，没有上下文很难定位。
    const body = await response.text();
    expect(response.status, `[${name}] spec 生成失败：${body.slice(0, 300)}`).toBe(200);
    specs[name] = JSON.parse(body);
    expect(Object.keys(specs[name].paths).length).toBeGreaterThan(0);
  }

  // 契约：接进装配面的路由要么进文档，要么显式 `hide: true`——静默漏掉 detail 的那个分支现在会直接
  // 让上一段断言失败，这里进一步保证「有 detail」不等于「被排除」。
  const documented = new Set<string>();
  for (const spec of Object.values(specs)) {
    for (const [path, operations] of Object.entries(spec.paths)) {
      for (const [method] of Object.entries(operations)) {
        if (method.startsWith("x-")) continue;
        documented.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  // 带扩展名的路径不算漏出：插件默认 `excludeStaticFile: true`，凡含 `.` 的路径都按静态资源排除
  // （如 `/api/system/sandbox-cluster/servers/{serverId}/tunnel/frpc.toml`），这是插件的既定口径。
  const missing = declared.filter((route) => !documented.has(route) && !route.split(" ")[1]?.includes("."));
  expect(missing).toEqual([]);
});

// 协议面路由（Webhook 入口）必须显式隐藏：它无认证、不按 REST 建模，出现在公开文档里即文档泄漏。
test("Webhook 协议入口不出现在任何一份文档中", async () => {
  const { instances } = await collectContributedRoutes();
  const app = new Elysia().use(createExternalOpenApiPlugin("test")).use(createWebOpenApiPlugin("test")).use(instances);

  for (const path of ["/docs/openapi/external/json", "/docs/openapi/web/json"]) {
    const spec = (await (await app.handle(new Request(`http://localhost${path}`))).json()) as {
      paths: Record<string, unknown>;
    };
    expect(Object.keys(spec.paths).some((specPath) => specPath.startsWith("/hooks/"))).toBe(false);
  }
});
