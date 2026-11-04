import { expect, test } from "bun:test";
import type { ModuleManifest } from "@fenix/platform-sdk";
import { type AnyElysia, Elysia } from "elysia";
import { generatedModuleManifests } from "../../../generated/module-registry";
import { serverRouteHost } from "../bootstrap/route-host";
import { createExternalOpenApiPlugin, createWebOpenApiPlugin } from "../openapi";
import { EXTERNAL_V1_OPERATIONS } from "../test-utils/external-v1-operations";

/**
 * 真实路由贡献必须按最终挂载路径进入对应文档，且系统管理与独立协议入口不能进入这两份文档。
 * 只构造协议层，不启运行面或连接数据库。
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
  const instances: AnyElysia[] = [];
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
      const mounted =
        contribution.slot === "web" || contribution.slot === "web-config"
          ? new Elysia({ prefix: "/web" }).use(built)
          : built;
      instances.push(mounted);

      for (const route of mounted.routes) {
        if (route.hooks?.detail?.hide) continue;
        // 一条路由可声明多个方法（Elysia 的 `route.method` 此时是数组），逐方法比对。
        const methods = Array.isArray(route.method) ? route.method : [route.method];
        for (const method of methods) declared.push(`${method} ${toOpenApiPath(route.path)}`);
      }
    }
  }

  return { instances, declared };
}

// 路由标签只负责分组，共用、未知或缺失标签都不能改变文档的路径归属。
test("OpenAPI 按路径归属且不依赖标签分类", async () => {
  const app = new Elysia()
    .use(createExternalOpenApiPlugin("test"))
    .use(createWebOpenApiPlugin("test"))
    .get("/api/skills", () => ({}), { detail: { tags: ["SkillConfig"] } })
    .get("/web/skills", () => ({}), { detail: { tags: ["External Skill"] } })
    .get("/api/plugin-market", () => ({}), { detail: { tags: ["PluginMarket"] } })
    .get("/web/plugin-market", () => ({}), { detail: { tags: ["PluginMarket"] } })
    .get("/api/new-resource", () => ({}), { detail: { tags: ["New Resource"] } })
    .get("/web/new-resource", () => ({}))
    .get("/api/system", () => ({}))
    .get("/api/system/logs", () => ({}), { detail: { tags: ["System Logs"] } })
    .get("/api/systematic", () => ({}))
    .get("/api/auth", () => ({}))
    .get("/api/auth/encryption-key", () => ({}), { detail: { tags: ["Auth"] } })
    .get("/api/authors", () => ({}))
    .get("/api/hidden", () => ({}), { detail: { hide: true } })
    .get("/web/hidden", () => ({}), { detail: { hide: true } })
    .post("/api/plugin-market", () => ({}), { detail: { hide: true } })
    .get("/acp/agents", () => ({}), { detail: { tags: ["ACP"] } })
    .get("/apiary/resources", () => ({}))
    .get("/website/resources", () => ({}));

  const externalResponse = await app.handle(new Request("http://localhost/docs/openapi/external/json"));
  const webResponse = await app.handle(new Request("http://localhost/docs/openapi/web/json"));
  expect(externalResponse.status).toBe(200);
  expect(webResponse.status).toBe(200);
  const externalSpec = await externalResponse.json();
  const webSpec = await webResponse.json();
  expect(Object.keys(externalSpec.paths).sort()).toEqual([
    "/api/authors",
    "/api/new-resource",
    "/api/plugin-market",
    "/api/skills",
    "/api/systematic",
  ]);
  expect(Object.keys(webSpec.paths).sort()).toEqual(["/web/new-resource", "/web/plugin-market", "/web/skills"]);
  expect(externalSpec.paths["/api/plugin-market"].get.tags).toEqual(["PluginMarket"]);
  expect(externalSpec.paths["/api/plugin-market"].post).toBeUndefined();
  expect(webSpec.paths["/web/plugin-market"].get.tags).toEqual(["PluginMarket"]);
  const repeatedExternalSpec = await (
    await app.handle(new Request("http://localhost/docs/openapi/external/json"))
  ).json();
  expect(repeatedExternalSpec.paths).toEqual(externalSpec.paths);
  expect((await app.handle(new Request("http://localhost/api/system/logs"))).status).toBe(200);
  expect((await app.handle(new Request("http://localhost/api/auth/encryption-key"))).status).toBe(200);
});

// 首次通过尾斜杠别名读取文档也必须隔离路径，避免污染后续规范地址请求的缓存。
test("OpenAPI 尾斜杠入口与规范入口使用相同路径筛选", async () => {
  const app = new Elysia()
    .use(createExternalOpenApiPlugin("test"))
    .use(createWebOpenApiPlugin("test"))
    .get("/api/resources", () => ({}))
    .get("/web/resources", () => ({}))
    .get("/api/system/logs", () => ({}));

  for (const [audience, expectedPaths] of [
    ["external", ["/api/resources"]],
    ["web", ["/web/resources"]],
  ] as const) {
    for (const suffix of ["/", ""]) {
      const response = await app.handle(new Request(`http://localhost/docs/openapi/${audience}/json${suffix}`));
      expect(response.status).toBe(200);
      expect(Object.keys((await response.json()).paths)).toEqual([...expectedPaths]);
    }
  }
});

// 真实贡献按宿主前缀挂载后，每条可见 API 只出现在其所属文档，系统与协议路由不公开。
test("真实路由贡献下两份 OpenAPI spec 按路径隔离并覆盖可见接口", async () => {
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
    for (const documentedPath of Object.keys(specs[name].paths)) {
      if (name === "external") {
        expect(documentedPath.startsWith("/api/"), documentedPath).toBe(true);
        expect(documentedPath === "/api/system" || documentedPath.startsWith("/api/system/"), documentedPath).toBe(
          false,
        );
      } else {
        expect(documentedPath.startsWith("/web/"), documentedPath).toBe(true);
      }
    }
  }

  const externalPaths = Object.keys(specs.external.paths);
  expect(externalPaths.filter((path) => path in specs.web.paths)).toEqual([]);

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
  const missing = declared.filter((route) => {
    const path = route.split(" ")[1];
    const visible =
      path.startsWith("/web/") ||
      (path.startsWith("/api/") &&
        path !== "/api/system" &&
        !path.startsWith("/api/system/") &&
        path !== "/api/auth" &&
        !path.startsWith("/api/auth/"));
    return visible && !path.includes(".") && !documented.has(route);
  });
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

// 从真实贡献冻结完整操作、包装、SDK 例外、上传和已移除 handler，避免只测手写路由替身。
test("External v1 freezes 37 operations and retires old handlers", async () => {
  const { instances, declared } = await collectContributedRoutes();
  expect(EXTERNAL_V1_OPERATIONS).toHaveLength(37);
  const hiddenWorkflowPath = "/api/v1/workflows/{workflowId}/execute";
  const visibleOperations = EXTERNAL_V1_OPERATIONS.filter((operation) => operation !== `POST ${hiddenWorkflowPath}`);
  expect(declared.filter((route) => route.includes(" /api/v1/")).sort()).toEqual(visibleOperations);
  const app = new Elysia().use(createExternalOpenApiPlugin("test")).use(instances);
  const spec = await (await app.handle(new Request("http://localhost/docs/openapi/external/json"))).json();
  expect(spec.paths[hiddenWorkflowPath]).toBeUndefined();
  expect(spec.components.securitySchemes.BearerAuth).toMatchObject({ type: "http", scheme: "bearer" });
  expect(spec.security).toEqual([{ BearerAuth: [] }]);
  for (const operation of visibleOperations) {
    const [method, path] = operation.split(" ");
    const endpoint = spec.paths[path][method.toLowerCase()];
    expect(endpoint, operation).toBeDefined();
    for (const [status, response] of Object.entries(endpoint.responses) as Array<
      [string, { content?: Record<string, { schema: unknown }> }]
    >) {
      if (!status.startsWith("2") || path.endsWith("/chat/completions") || path.endsWith("/files/download")) continue;
      const schema = response.content?.["application/json"]?.schema as { $ref?: string } | undefined;
      const resolved = schema?.$ref ? spec.components.schemas[schema.$ref.split("/").at(-1)!] : schema;
      expect(JSON.stringify(resolved), operation).toContain("success");
    }
  }
  const chat = spec.paths["/api/v1/chat/completions"].post.responses["200"].content;
  expect(
    spec.paths["/api/v1/environments/{environmentId}/workspace/files/download"].get.responses["200"].content[
      "application/octet-stream"
    ].schema,
  ).toMatchObject({ type: "string", format: "binary" });
  expect(chat["application/json"]).toBeDefined();
  expect(chat["text/event-stream"]).toBeDefined();
  for (const path of ["/api/v1/skills", "/api/v1/environments/{environmentId}/workspace/files"]) {
    expect(spec.paths[path].post.requestBody.content["multipart/form-data"].schema.properties.files.items.format).toBe(
      "binary",
    );
  }
  for (const retired of [
    "/api/agents",
    "/api/skills",
    "/api/mcp",
    "/api/knowledge-bases",
    "/api/models/providers",
    "/api/environments/{environmentId}/workspace/files",
    "/api/agents/{agentId}/instances/connect",
    "/api/agents/{agentId}/v1/chat/completions",
    "/api/workflows/{workflowId}/execute",
    "/api/workflow-v2/workflows/{id}/run",
  ]) {
    expect(spec.paths[retired]).toBeUndefined();
    expect(declared.some((route) => route.split(" ")[1].replace(/\/$/, "") === retired)).toBe(false);
  }
});
