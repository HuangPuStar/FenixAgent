import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import * as z from "zod/v4";
import { getPluginMarketModule } from "../../../runtime";
import type { PluginMarketRouteDependencies } from "../../dependencies";
import {
  looseOkSchema,
  previewChangedSchema,
  runWebHandler,
  toWebChange,
  toWebPackageDetailView,
  toWebPackageView,
  toWebPreview,
  type WebHandlerResult,
} from "./plugin-market-support";

/**
 * `/web/config/plugin-market` 协议层。
 *
 * 只做协议接入：参数形状校验、把请求映射为应用调用、把结果映射为 `/web` 视图、把应用错误映射为稳定错误体。
 * 授权、读口径、发布状态分派与 registry 读取全部在 Facade 内完成，本文件不判断组织、角色或 `visibility`，
 * 也不自己拼业务条件。
 *
 * 三条不变量在本层的表达方式：
 * - 读路径（列表 / 详情）**永不访问私有源**：它们只经 Facade 的读方法，Facade 的读方法不构造 registry 客户端。
 * - 写路径的 `requestId` 来自宿主 `derive`（`apps/server/src/main.ts` 的 `deriveRequestId`），随命令进审计
 *   流水；非宿主挂载（包内用例）取不到时为 `null`，不臆造标识。
 * - `PREVIEW_CHANGED` 走 409 + `data.preview`：这条冲突不是「请求非法」，而是「需要用户在新快照上重新确认」。
 *
 * 导出的是**路由工厂**而非构造好的实例：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，Elysia 的
 * `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，因此守卫必须由宿主注入
 * （`PluginMarketRouteDependencies`）。包内不复制认证策略，用例注入替身。
 */

/** 精确版本定位参数：包名 + 精确 SemVer。形状校验在 Facade（`assertPackageName` / `assertExactVersion`）。 */
const versionBodySchema = z.object({
  packageName: z.string().min(1).describe("npm 包名，可含 scope（如 `@acme/investment-team`）。"),
  exactVersion: z.string().min(1).describe("精确 SemVer。范围、tag、部分版本一律拒绝。"),
});

/** 确认发布的请求体：比预览多一个摘要，它是「用户确认的是这一份内容」的凭据。 */
const publishBodySchema = versionBodySchema.extend({
  previewDigest: z
    .string()
    .min(1)
    .optional()
    .describe("预览返回的 `metadataDigest`；服务端在写入前重读私有源并比对，缺失时拒绝。"),
});

const slugParamsSchema = z.object({
  slug: z.string().min(1).describe("包名的 URL 安全编码（`domain/slug.ts` 的 `toPackageSlug`）。"),
});

// ── handler：把应用调用包成 `/web` 响应体 ──

async function handleList(actor: ActorContext): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const { items, total, canPublish } = await facade.list(actor);
  return {
    success: true,
    data: { packages: items.map((item) => toWebPackageView(item)), total, canPublish },
  };
}

async function handleDetail(actor: ActorContext, slug: string): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const detail = await facade.getDetail(actor, slug);
  return { success: true, data: { package: toWebPackageDetailView(detail) } };
}

async function handlePreview(
  actor: ActorContext,
  input: { packageName: string; exactVersion: string },
): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const preview = await facade.preview(actor, input);
  return { success: true, data: { preview: toWebPreview(preview) } };
}

async function handlePublish(
  actor: ActorContext,
  input: { packageName: string; exactVersion: string; previewDigest?: string },
  requestId: string | null,
): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const change = await facade.publish(actor, {
    packageName: input.packageName,
    exactVersion: input.exactVersion,
    ...(input.previewDigest === undefined ? {} : { previewDigest: input.previewDigest }),
    requestId,
  });
  return { success: true, data: { change: toWebChange(change) } };
}

async function handleUnpublish(
  actor: ActorContext,
  input: { packageName: string; exactVersion: string },
  requestId: string | null,
): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const change = await facade.unpublish(actor, { ...input, requestId });
  return { success: true, data: { change: toWebChange(change) } };
}

async function handleRestore(
  actor: ActorContext,
  input: { packageName: string; exactVersion: string },
  requestId: string | null,
): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const change = await facade.restore(actor, { ...input, requestId });
  return { success: true, data: { change: toWebChange(change) } };
}

// ── 路由注册 ──

export function createWebPluginMarketConfigRoutes(deps: PluginMarketRouteDependencies) {
  const app = new Elysia({ name: "web-config-plugin-market" }).use(deps.authGuardPlugin);

  // GET /web/config/plugin-market/packages — 全量列表（前端过滤，决策 D7）
  app.get(
    "/config/plugin-market/packages",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ store, status, requestId }: any) => runWebHandler(status, { store, requestId }, (actor) => handleList(actor)),
    {
      sessionAuth: true,
      response: {
        200: looseOkSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "获取插件市场列表",
        description:
          "返回当前来源（`PLUGIN_MARKET_SOURCE_ID`）的全部市场条目，按展示版本的发布时刻倒序。**不做服务端分页与检索**：市场规模由私有源决定且远小于其它目录页，前端过滤已经够用（决策 D7）。非写权主体（非平台系统管理员）看不到整包下架的条目。条目字段：`slug` 定位符、`latestVersion`（整包下架时为 `null`）、`metadata` 规范化快照、`publishedAt`（秒级时间戳）、`hidden` 与 `scope` / `access`。`canPublish` 是页面级能力位（当前主体可否发布/下架/恢复），由服务端在同一写权探针上给出——前端不得按列表条目推导，否则空市场时管理员也会被判成只读。",
      },
    },
  );

  // GET /web/config/plugin-market/packages/:slug — 详情（展示快照 + 版本历史）
  app.get(
    "/config/plugin-market/packages/:slug",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ store, status, params, requestId }: any) =>
      runWebHandler(status, { store, requestId }, (actor) => handleDetail(actor, params.slug)),
    {
      sessionAuth: true,
      params: slugParamsSchema,
      response: {
        200: looseOkSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "获取插件市场条目详情",
        description:
          "按 `slug` 返回条目详情：展示快照、`versions` 版本历史与 `access` 有效动作。整包下架的条目对非写权主体返回 404（与「不存在」同响应）；写权主体可见，`hidden` 为 `true`，版本历史含已下架版本并带 `unpublishedAt` 水印。",
        parameters: [
          {
            name: "slug",
            in: "path",
            required: true,
            description: "包名的 URL 安全编码。",
            schema: { type: "string" },
          },
        ],
      },
    },
  );

  // POST /web/config/plugin-market/publish/preview — 读取私有源并规范化（不写库）
  app.post(
    "/config/plugin-market/publish/preview",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ store, status, body, requestId }: any) =>
      runWebHandler(status, { store, requestId }, (actor) => handlePreview(actor, body)),
    {
      sessionAuth: true,
      body: versionBodySchema,
      response: {
        200: looseOkSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        413: WebErrSchema,
        422: WebErrSchema,
        429: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "预览插件版本（不落库）",
        description:
          "从 npm 私有源读取指定包与该精确版本的 packument，按市场白名单规范化后返回 `metadata` 与 `metadataDigest`。**不写库、不请求 tarball**。`metadataDigest` 必须在确认发布时原样回传。仅平台系统管理员可调用。错误：`INVALID_INPUT` 400（包名或版本形状不合法）、`PACKAGE_NOT_FOUND` 404、`VERSION_NOT_FOUND` 404、`METADATA_INVALID` 422、`METADATA_TOO_LARGE` 413、`REGISTRY_RATE_LIMITED` 429、`REGISTRY_UNAVAILABLE` / `REGISTRY_NOT_CONFIGURED` 503。",
      },
    },
  );

  // POST /web/config/plugin-market/publish — 按库内状态分派（幂等 / 恢复 / 回源发布）
  app.post(
    "/config/plugin-market/publish",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ store, status, body, requestId }: any) =>
      runWebHandler(status, { store, requestId }, (actor) => handlePublish(actor, body, requestId ?? null)),
    {
      sessionAuth: true,
      body: publishBodySchema,
      response: {
        200: looseOkSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: previewChangedSchema,
        413: WebErrSchema,
        422: WebErrSchema,
        429: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "发布（或恢复）插件版本",
        description:
          '按库内该精确版本的状态分派：已可见 → 幂等无操作（`action: "noop"`）；已下架 → 恢复（复用市场内的冻结快照，**不访问私有源**）；不存在 → 读取私有源、比对 `previewDigest` 后落库（`action: "publish"`）。响应只回 `change.action` 等「发生了什么」，前端据此刷新列表。摘要与重读结果不一致时返回 409 `PREVIEW_CHANGED`，响应体的 `data.preview` 是新读到的快照与摘要，前端应据此原地重新确认。仅平台系统管理员可调用。',
      },
    },
  );

  // POST /web/config/plugin-market/unpublish — 下架某个精确版本
  app.post(
    "/config/plugin-market/unpublish",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ store, status, body, requestId }: any) =>
      runWebHandler(status, { store, requestId }, (actor) => handleUnpublish(actor, body, requestId ?? null)),
    {
      sessionAuth: true,
      body: versionBodySchema,
      response: {
        200: looseOkSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "下架插件版本",
        description:
          "下架指定的精确版本；被下架的是当前 latest 时，指针先回退到次新的可见版本。版本不在市场里返回 404 `PUBLICATION_NOT_FOUND`。最后一个可见版本被下架后，整个包对非写权主体消失。仅平台系统管理员可调用。",
      },
    },
  );

  // POST /web/config/plugin-market/restore — 恢复一个已下架的版本
  app.post(
    "/config/plugin-market/restore",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ store, status, body, requestId }: any) =>
      runWebHandler(status, { store, requestId }, (actor) => handleRestore(actor, body, requestId ?? null)),
    {
      sessionAuth: true,
      body: versionBodySchema,
      response: {
        200: looseOkSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "恢复已下架的插件版本",
        description:
          "把已下架的版本重新对公众可见：复用市场内的冻结快照，**不访问私有源**，`firstPublishedAt` 不变、逻辑时刻前移到新的单调时刻。版本从未进入市场时返回 404 `PUBLICATION_NOT_FOUND`（那是「发布」而不是「恢复」）。仅平台系统管理员可调用。",
      },
    },
  );

  return app;
}
