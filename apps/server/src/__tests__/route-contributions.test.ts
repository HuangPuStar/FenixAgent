import { beforeEach, expect, test } from "bun:test";
import type { ModuleContribution, ModuleManifest } from "@fenix/platform-sdk";
import { initializeTestApplicationInfrastructure } from "@fenix/platform-sdk/testing";
import { Elysia } from "elysia";
import { bootstrapServerAssembly } from "../bootstrap";
import {
  API_SLOT,
  APP_SLOT,
  mountServerRouteContribution,
  resetRouteContributions,
  takeRouteContributions,
  WEB_CONFIG_SLOT,
  WEB_SLOT,
} from "../bootstrap/route-contributions";

/**
 * 装配期路由贡献的登记契约（1.5e）。
 *
 * 时序是这里的关键：`bootstrapServerAssembly()` 跑在宿主 app 构造之前（review §3.3），贡献只能先被
 * 「构造 + 登记到槽」，再由 `createWebApp` / `createApiApp` / 顶层根 app 从槽里取出挂载。因此本文件锁定
 * 四件事——按槽分组、未知槽当场失败、贡献构造函数必须产出 Elysia 实例、兜底路由靠自己的大 `order` 排在
 * 同槽末尾；真实的端到端装配（真实 profile + 真实 registry）由 `module-assembly.test.ts` 与手工启动验证
 * 覆盖。
 */

/** fixture profile：只启用 probe 这一个资源模块，Shell 槽位沿用发布组合的绑定。 */
const probeProfile = {
  identity: "identity",
  accessControl: "access-control",
  agentRuntime: "agent-runtime",
  webShell: "default",
  resources: ["probe"],
  web: [],
};

/** 三个基础模块 + 一个声明了给定贡献的资源模块；其余模块与本用例无关，不注册。 */
function manifestsWith(contributions: readonly ModuleContribution[]): readonly ModuleManifest[] {
  return [
    { id: "identity", kind: "identity", dependsOn: [], create: () => ({ id: "identity" }) },
    { id: "access-control", kind: "access-control", dependsOn: [], create: () => ({ id: "access-control" }) },
    {
      id: "agent-runtime",
      kind: "agent-runtime",
      dependsOn: ["access-control"],
      create: () => ({ id: "agent-runtime" }),
    },
    { id: "probe", kind: "resource", dependsOn: [], contributions, create: () => ({ id: "probe" }) },
    { id: "default", kind: "web-shell", dependsOn: [] },
  ] satisfies readonly ModuleManifest[];
}

/** 贡献构造函数要产出的最小路由实例；插件名按路径区分，避免 Elysia 按 name 静默去重。 */
function routeInstance(path: string): Elysia {
  return new Elysia({ name: `probe-${path}` }).get(path, () => "ok");
}

/** 槽内路由的 `方法 路径` 列表；用来断言「贡献去了哪一面、注册了哪些端点」而不只是数量。 */
function slottedRoutes(slot: string): string[] {
  return takeRouteContributions(slot).flatMap((routes) =>
    routes.routes.flatMap((route) =>
      (Array.isArray(route.method) ? route.method : [route.method]).map((method) => `${method} ${route.path}`),
    ),
  );
}

async function assemble(contributions: readonly ModuleContribution[]): Promise<void> {
  await bootstrapServerAssembly({
    profile: probeProfile,
    manifests: manifestsWith(contributions),
    loadEnv: () => ({}),
    mountContribution: mountServerRouteContribution,
  });
}

beforeEach(() => {
  resetRouteContributions();
});

// 贡献按 slot 分组登记：`/web`、`/web/config`、`/api` 与顶层 `app` 是四个聚合实例，挂错面等于整组端点前缀错位。
test("路由贡献按聚合槽登记", async () => {
  await assemble([
    { id: "probe.web", kind: "app-route", slot: WEB_SLOT, value: () => routeInstance("/probe") },
    { id: "probe.config", kind: "app-route", slot: WEB_CONFIG_SLOT, value: () => routeInstance("/config/probe") },
    { id: "probe.api", kind: "app-route", slot: API_SLOT, value: () => routeInstance("/api/probe") },
    { id: "probe.app", kind: "app-route", slot: APP_SLOT, value: () => routeInstance("/probe-app") },
  ]);

  expect(slottedRoutes(WEB_SLOT)).toEqual(["GET /probe"]);
  expect(slottedRoutes(WEB_CONFIG_SLOT)).toEqual(["GET /config/probe"]);
  expect(slottedRoutes(API_SLOT)).toEqual(["GET /api/probe"]);
  expect(slottedRoutes(APP_SLOT)).toEqual(["GET /probe-app"]);
});

// 未启用任何贡献到某一面的模块时，槽是空数组而不是报错：profile 决定哪些面有路由。
test("没有贡献的槽为空数组", async () => {
  await assemble([{ id: "probe.web", kind: "app-route", slot: WEB_SLOT, value: () => routeInstance("/probe") }]);

  expect(slottedRoutes(WEB_CONFIG_SLOT)).toEqual([]);
});

// 非 app-route 的贡献（协议、生命周期）在 1.5 内没有消费方，必须被跳过而不是被误挂到路由面上。
test("非 app-route 的贡献不进入槽", async () => {
  await assemble([{ id: "probe.lifecycle", kind: "lifecycle", slot: WEB_SLOT, value: () => routeInstance("/probe") }]);

  expect(slottedRoutes(WEB_SLOT)).toEqual([]);
});

// 未知槽名必须当场失败：静默丢弃一个路由贡献等于让整组端点消失，比启动失败更难排查。
test("未知聚合槽名拒绝装配", async () => {
  await expect(
    assemble([{ id: "probe.unknown", kind: "app-route", slot: "content", value: () => routeInstance("/probe") }]),
  ).rejects.toThrow('指向未知聚合槽 "content"');
});

// 默认槽是 `app`：不声明 slot 的贡献落在顶层应用面，且与显式写 `slot: "app"` 等价（1.5f-1b 起该槽有读者）。
test("未声明 slot 的贡献落在顶层 app 槽", async () => {
  await assemble([{ id: "probe.default", kind: "app-route", value: () => routeInstance("/probe") }]);

  expect(slottedRoutes(APP_SLOT)).toEqual(["GET /probe"]);
});

// 兜底通配路由靠贡献自己的大 `order` 排到同槽末尾：宿主不维护「谁必须最后挂」的清单，声明序在前也不
// 妨碍它被后移（`Array.sort` 自 ES2019 起稳定，同 order 的贡献才保持拓扑序与声明序）。
test("order 大的贡献在同一槽内最后挂载", async () => {
  await assemble([
    {
      id: "probe.app-late",
      kind: "app-route",
      slot: APP_SLOT,
      order: 100,
      value: () => routeInstance("/probe-late"),
    },
    { id: "probe.app", kind: "app-route", slot: APP_SLOT, value: () => routeInstance("/probe") },
  ]);

  expect(slottedRoutes(APP_SLOT)).toEqual(["GET /probe", "GET /probe-late"]);
});

// 贡献的 value 必须是惰性构造函数（manifest 是静态描述符，存不了实例）；类型写错要当场报错。
test("value 不是构造函数时拒绝装配", async () => {
  await expect(assemble([{ id: "probe.bad", kind: "app-route", slot: WEB_SLOT, value: "routes" }])).rejects.toThrow(
    "value 不是构造函数",
  );
});

// 构造函数必须产出 Elysia 实例：返回其它对象会在宿主 `.use()` 时才炸，报错点离装配点太远。
test("构造函数未返回 Elysia 实例时拒绝装配", async () => {
  await expect(
    assemble([{ id: "probe.bad", kind: "app-route", slot: WEB_SLOT, value: () => ({ routes: [] }) }]),
  ).rejects.toThrow("没有返回 Elysia 实例");
});

// 真实发布组合（真实 ce.json + 生成 registry + 真实模块工厂）的端到端登记：断言用 `toEqual` 而不是
// `toContain`——1.5e 每迁入一个包，这里就多一条路径，迁移进度因此有一份可执行的镜像，漏挂不会静默通过。
// 分组顺序即装配收集顺序（拓扑序 + manifest 内声明序），不是视觉分块。
test("真实 profile 装配后各包的路由进入对应槽", async () => {
  initializeTestApplicationInfrastructure();

  await bootstrapServerAssembly({ mountContribution: mountServerRouteContribution });

  // 直接检查真实装配后的路由表，防止已退役端点从其它贡献重新挂入。
  const webRoutes = slottedRoutes(WEB_SLOT);
  expect(webRoutes).not.toContain("POST /meta-agent/ensure");
  const webApp = new Elysia({ prefix: "/web" });
  for (const routes of takeRouteContributions(WEB_SLOT)) webApp.use(routes);
  expect(webApp.routes.some((route) => route.path === "/web/meta-agent/ensure")).toBe(false);

  expect(webRoutes).toEqual([
    // identity
    "GET /api-keys",
    "POST /api-keys",
    "DELETE /api-keys/:id",
    "PUT /api-keys/:id",
    "GET /organizations",
    "GET /organizations/:id",
    "POST /organizations",
    "PUT /organizations/:id",
    "DELETE /organizations/:id",
    "POST /organizations/:id/set-active",
    "GET /organizations/:id/members",
    "GET /organizations/:id/member-candidates",
    "POST /organizations/:id/members",
    "DELETE /organizations/:id/members/:memberId",
    "PUT /organizations/:id/members/:memberId",
    // agent-runtime
    "POST /sessions/:id/events",
    "POST /sessions/:id/control",
    "POST /sessions/:id/interrupt",
    "GET /environments",
    "POST /environments",
    "GET /environments/:id",
    "PUT /environments/:id",
    "POST /environments/:id/enter",
    "DELETE /environments/:id",
    "GET /environments/:id/instances",
    "GET /instances/activity",
    "POST /instances/from-environment",
    "POST /instances/:id/stop",
    "POST /instances/:id/restart",
    "DELETE /instances/:id",
    // knowledge
    "GET /knowledgeBases",
    "POST /knowledgeBases",
    "GET /knowledgeBases/form-options",
    "GET /knowledgeBases/rerank-models",
    "GET /knowledgeBases/:id",
    "PATCH /knowledgeBases/:id",
    "DELETE /knowledgeBases/:id",
    "POST /knowledgeBases/:id/resources/upload",
    "POST /knowledgeBases/:id/resources/url",
    "GET /knowledgeBases/:id/resources",
    "GET /knowledgeBases/:id/resources/:resourceId/file",
    "GET /knowledgeBases/:id/resources/:resourceId/pdf",
    "PATCH /knowledgeBases/:id/resources/:resourceId/enabled",
    "POST /knowledgeBases/:id/resources/:resourceId/reparse",
    "GET /knowledgeBases/:id/resources/:resourceId/chunks",
    "PATCH /knowledgeBases/:id/resources/:resourceId/chunks/:chunkId/enabled",
    "DELETE /knowledgeBases/:id/resources/:resourceId",
    "POST /knowledgeBases/:id/search",
    "POST /knowledgeBases/:id/graph/generate",
    "GET /knowledgeBases/:id/graph",
    "DELETE /knowledgeBases/:id/graph",
    "GET /knowledgeBases/:id/graph/progress",
    "POST /knowledgeBases/models",
    // memory
    "GET /hindsight/status",
    "GET /hindsight/graph",
    "GET /hindsight/bank-stats",
    "GET /hindsight/memories",
    "GET /hindsight/memories/:id",
    "DELETE /hindsight/memories/:id",
    "POST /hindsight/memories",
    "POST /hindsight/recall",
    "POST /hindsight/reflect",
    "GET /hindsight/documents",
    "POST /hindsight/documents",
    "DELETE /hindsight/documents/:id",
    "GET /hindsight/documents/:id/chunks",
    "GET /hindsight/mental-models",
    "GET /hindsight/mental-models/:id",
    "DELETE /hindsight/mental-models/:id",
    "GET /hindsight/entities",
    "GET /hindsight/entities/:id",
    "GET /hindsight/entities/graph",
    // agent-config（`/sidebar-config/` 无守卫，登录页也要用它）
    "GET /sidebar-config/",
    "GET /agent-sites/apps",
    "GET /agent-sites/apps/:id",
    "GET /agent-sites/apps/by-remote/:remoteAppId",
    "POST /agent-sites/apps",
    "PATCH /agent-sites/apps/:id",
    "DELETE /agent-sites/apps/:id",
    "POST /agent-sites/apps/:id/rotate-token",
    "PUT /agent-sites/apps/:id/files/:path",
    "POST /agent-sites/apps/:id/files/bundle",
    "POST /agent-sites/apps/:id/deploy",
    "GET /agent-sites/agent-configs/:agentConfigId/sites",
    "POST /agent-sites/agent-configs/:agentConfigId/sites/:siteAppId",
    "DELETE /agent-sites/agent-configs/:agentConfigId/sites/:siteAppId",
    "ALL /agent-sites/apps/:id/api/*",
    "POST /agent-generation",
    // channel
    "GET /channels/providers",
    "GET /channels/hermes/status",
    "GET /channels/bindings",
    "POST /channels/bindings",
    "DELETE /channels/bindings/:id",
    "PATCH /channels/bindings/:id",
    // machine（`/file-events` 是 WS 升级，method 记为 WS）
    "GET /environments/:id/fs/tree",
    "GET /environments/:id/fs",
    "GET /environments/:id/fs/*",
    "POST /environments/:id/fs/*",
    "PUT /environments/:id/fs/*",
    "DELETE /environments/:id/fs/*",
    "POST /environments/:id/fs/mkdir",
    "POST /environments/:id/fs/rename",
    "DELETE /environments/:id/fs/batch",
    "GET /environments/:id/fs/download-zip",
    "WS /file-events/",
    "POST /registry/machines",
    "GET /registry/machines",
    "GET /registry/machines/:id",
    "PATCH /registry/machines/:id",
    "DELETE /registry/machines/:id",
    "GET /registry/machines/:id/events",
    // model-management
    "GET /model-gateway/:providerId/usage",
    "GET /agents/:environmentId/sessions/:sessionId/peri-tasks/:taskId/detail",
    // prod-view
    "GET /prod-views/:id/load",
    // task
    "GET /tasks/v2",
    "POST /tasks/v2",
    "GET /tasks/v2/:id",
    "PUT /tasks/v2/:id",
    "DELETE /tasks/v2/:id",
    "POST /tasks/v2/:id/toggle",
    "POST /tasks/v2/:id/trigger",
    "GET /tasks/v2/:id/logs",
    "DELETE /tasks/v2/:id/logs",
    // workflow
    "GET /workflow-defs",
    "GET /workflow-defs/recoverable",
    "POST /workflow-defs/recover",
    "PUT /workflow-defs/:id/draft",
    "POST /workflow-defs/:id/publish",
    "GET /workflow-defs/:id/versions",
    "GET /workflow-defs/:id/versions/:version",
    "POST /workflow-defs/:id/versions/:version/set-latest",
    "POST /workflow-defs/:id/versions/:version/restore",
    "GET /workflow-defs/:id/params",
    "POST /workflow-defs/:id/triggers",
    "GET /workflow-defs/:id/triggers",
    "DELETE /workflow-defs/:id/triggers/:triggerId",
    "POST /workflow-defs/:id/triggers/:triggerId/regenerate",
    "POST /workflow-defs/:id/triggers/:triggerId/enable",
    "POST /workflow-defs/:id/triggers/:triggerId/disable",
    "GET /workflow-defs/:id",
    "PATCH /workflow-defs/:id",
    "DELETE /workflow-defs/:id",
    "POST /workflow-defs",
    "GET /workflow-custom-tools",
    "POST /workflow-engine",
    "GET /workflow/:workflowId/events",
    "GET /workflow-runs",
    "POST /workflow-runs",
    "POST /workflow-runs/dry",
    "POST /workflow-runs/:runId/cancel",
    "POST /workflow-runs/:runId/approve",
    "GET /workflow-runs/:runId",
    "GET /workflow-runs/:runId/events",
    "GET /workflow-runs/:runId/nodes/:nodeId/output",
    "GET /workflow-runs/:runId/approvals",
    "POST /workflow-runs/:runId/recover",
    "POST /workflow-runs/:runId/rerun",
  ]);
  expect(slottedRoutes(WEB_CONFIG_SLOT)).toEqual([
    // mcp
    "GET /config/mcp",
    "POST /config/mcp",
    "PUT /config/mcp",
    "DELETE /config/mcp",
    "POST /config/mcp/actions/enable",
    "POST /config/mcp/actions/disable",
    "POST /config/mcp/actions/test",
    "POST /config/mcp/actions/test-url",
    "POST /config/mcp/actions/inspect",
    "GET /config/mcp/actions/tools",
    // skill
    "GET /config/skills",
    "GET /config/skills/:name",
    "GET /config/skills/:name/download",
    "POST /config/skills",
    "PUT /config/skills/:name",
    "PUT /config/skills/:name/access",
    "DELETE /config/skills/:name",
    "POST /config/skills/upload",
    // agent-config
    "GET /config/agents/templates",
    "GET /config/agents",
    "POST /config/agents",
    "PUT /config/agents",
    "POST /config/agents/restart",
    "DELETE /config/agents",
    "POST /config/agents/default",
    // model-management
    "GET /config/models",
    "PUT /config/models",
    "POST /config/models/refresh",
    "GET /config/providers",
    "PUT /config/providers",
    "DELETE /config/providers",
    "POST /config/providers/actions/fetch-models",
    "POST /config/providers/actions/test-model",
    "POST /config/providers/actions/models",
    "PUT /config/providers/actions/models/:modelId",
    "DELETE /config/providers/actions/models/:modelId",
    // plugin-market（浏览面：只有两条读路由；发布 / 下架 / 恢复是平台管理动作，挂在 `api` 槽）
    "GET /config/plugin-market/packages",
    "GET /config/plugin-market/packages/:slug",
    // prod-view
    "GET /config/prod-views",
    "GET /config/prod-views/:id",
    "POST /config/prod-views",
    "PUT /config/prod-views/:id",
    "DELETE /config/prod-views/:id",
    // sandbox
    "GET /config/sandbox-pools",
  ]);
  expect(slottedRoutes(API_SLOT)).toEqual([
    // identity
    "GET /api/system/users",
    "DELETE /api/system/users/:id",
    "POST /api/system/users/reset-password",
    "POST /api/system/users",
    "GET /api/system/users/:id",
    "GET /api/system/users/:id/api-keys",
    "GET /api/system/users/:id/organizations",
    "DELETE /api/system/organizations/:id",
    "GET /api/system/organizations",
    "POST /api/system/organizations",
    "DELETE /api/system/api-keys/:id",
    "GET /api/system/organizations/:id",
    "POST /api/system/organizations/:id/members",
    "POST /api/system/api-keys",
    // agent-runtime
    "POST /api/agents/:agentId/instances/connect",
    "POST /api/agents/:agentId/v1/chat/completions",
    // knowledge
    "GET /api/knowledge-bases",
    // mcp
    "GET /api/mcp",
    "GET /api/mcp/:id",
    "POST /api/mcp",
    "PUT /api/mcp/:id",
    "DELETE /api/mcp/:id",
    // skill
    "GET /api/skills/",
    "GET /api/skills/:id",
    "POST /api/skills/",
    "DELETE /api/skills/:id",
    // agent-config
    "GET /api/agents",
    "GET /api/agents/:id",
    "POST /api/agents",
    "PUT /api/agents/:id",
    "DELETE /api/agents/:id",
    // machine
    "POST /api/environments/:environmentId/workspace/files",
    // model-management
    "GET /api/models/providers",
    "POST /api/models/providers",
    "GET /api/models/providers/:providerId",
    "PUT /api/models/providers/:providerId",
    "DELETE /api/models/providers/:providerId",
    "POST /api/models/providers/:providerId/models",
    "GET /api/models/providers/:providerId/models",
    "GET /api/models/providers/:providerId/models/:id",
    "PUT /api/models/providers/:providerId/models/:id",
    "DELETE /api/models/providers/:providerId/models/:id",
    "GET /api/system/model-gateway/config",
    "GET /api/system/model-gateway/keys",
    "POST /api/system/model-gateway/keys/actions/remove",
    "GET /api/system/model-gateway/models/status",
    "POST /api/system/model-gateway/budgets/actions/bulk-reset",
    "POST /api/system/model-gateway/models/actions/sync",
    "PUT /api/system/model-gateway/budgets/:userId",
    "GET /api/system/model-gateway/budgets",
    "POST /api/system/model-gateway/budgets/actions/bulk-update",
    "GET /api/system/model-gateway/subjects/users",
    "GET /api/system/model-gateway/subjects/agents",
    "GET /api/system/model-gateway/usage",
    // observer
    "GET /api/system/observer/acp-link",
    "GET /api/system/logs/",
    "GET /api/system/logs/search",
    "GET /api/system/logs/download",
    "GET /api/system/people-tree/",
    // plugin-market（管理面；浏览面是 web-config 槽的两条读路由）
    "GET /api/system/plugin-market/packages",
    "GET /api/system/plugin-market/packages/:slug",
    "POST /api/system/plugin-market/publish/preview",
    "POST /api/system/plugin-market/publish",
    "POST /api/system/plugin-market/unpublish",
    "POST /api/system/plugin-market/restore",
    // sandbox
    "GET /api/system/sandbox-pools",
    "POST /api/system/sandbox-pools",
    "GET /api/system/sandbox-pools/:poolId",
    "PUT /api/system/sandbox-pools/:poolId",
    "DELETE /api/system/sandbox-pools/:poolId",
    "GET /api/system/sandbox-instances",
    "GET /api/system/sandbox-instances/:instanceId",
    "PUT /api/system/sandbox-instances/:instanceId",
    "DELETE /api/system/sandbox-instances/:instanceId",
    "POST /api/system/sandbox-instances/rebuild",
    "GET /api/system/sandbox-cluster/pools",
    "POST /api/system/sandbox-cluster/pools",
    "GET /api/system/sandbox-cluster/pools/:poolId",
    "PUT /api/system/sandbox-cluster/pools/:poolId",
    "DELETE /api/system/sandbox-cluster/pools/:poolId",
    "GET /api/system/sandbox-cluster/servers",
    "POST /api/system/sandbox-cluster/servers",
    "GET /api/system/sandbox-cluster/servers/:serverId",
    "PUT /api/system/sandbox-cluster/servers/:serverId",
    "DELETE /api/system/sandbox-cluster/servers/:serverId",
    "POST /api/system/sandbox-cluster/servers/:serverId/health-check",
    "PUT /api/system/sandbox-cluster/servers/:serverId/tunnel",
    "GET /api/system/sandbox-cluster/servers/:serverId/tunnel/frpc.toml",
    "GET /api/system/sandbox-server/servers/:serverId/sandboxes",
    "GET /api/system/sandbox-server/servers/:serverId/sandboxes/:sandboxId",
    "GET /api/system/sandbox-server/servers/:serverId/sandboxes/:sandboxId/diagnostics",
    "POST /api/system/sandbox-server/servers/:serverId/sandboxes/:sandboxId/commands",
    // workflow
    "POST /api/workflows/:workflowId/execute",
  ]);
  expect(slottedRoutes(APP_SLOT)).toEqual([
    // agent-runtime（`/acp` 下四条是 WS 升级，method 记为 WS）
    "GET /acp/agents",
    "WS /acp/ws",
    "WS /acp/file-ws",
    "WS /acp/yjs/:agentId",
    "WS /acp/relay/:agentId",
    // mcp
    "ALL /mcp/knowledge",
    // skill
    "GET /skills/:name/download",
    // agent-config（站点代理；`/app-*` 兜底见末尾）
    "ALL /web/site/deploy/:appId",
    "ALL /web/site/deploy/:appId/*",
    // workflow
    "ALL /workflow-ui/",
    "ALL /workflow-ui/:path",
    "POST /hooks/:publicHash",
    // agent-config 兜底（`order: 100`，必须在所有具体路由之后）
    "ALL /*",
  ]);
});
