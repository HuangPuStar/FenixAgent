import type { ActorContext } from "@fenix/platform-sdk";
import { WebErrSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { getPluginMarketModule } from "../../../runtime";
import type { PluginMarketRouteDependencies } from "../../dependencies";
import {
  looseOkSchema,
  runWebHandler,
  slugParamsSchema,
  toWebPackageDetailView,
  toWebPackageView,
  type WebHandlerResult,
} from "../../plugin-market-support";

/**
 * `/web/config/plugin-market` 协议层（**浏览面**）。
 *
 * 只做协议接入：参数形状校验、把请求映射为应用调用、把结果映射为 `/web` 视图、把应用错误映射为稳定错误体。
 * 授权与读口径全部在 Facade 内完成，本文件不判断组织、角色或 `visibility`，也不自己拼业务条件。
 *
 * **只有两条读路由**：市场是全局目录，浏览面对所有已认证用户开放；发布、下架与恢复是平台管理动作，走系统
 * 凭据的 `/api/system/plugin-market/*`（`routes/api/system-plugin-market.ts`）。两条面进**同一个 Facade**，
 * 不存在第二套业务实现。
 *
 * 两条读路由**永不访问私有源**：它们只经 Facade 的读方法，而 Facade 的读方法不构造 registry 客户端。
 *
 * 导出的是**路由工厂**而非构造好的实例：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，Elysia 的
 * `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，因此守卫必须由宿主注入
 * （`PluginMarketRouteDependencies`）。包内不复制认证策略，用例注入替身。
 */

// ── handler：把应用调用包成 `/web` 响应体 ──

async function handleList(actor: ActorContext): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const { items, total } = await facade.list(actor);
  return { success: true, data: { packages: items.map((item) => toWebPackageView(item)), total } };
}

async function handleDetail(actor: ActorContext, slug: string): Promise<WebHandlerResult> {
  const { facade } = getPluginMarketModule();
  const detail = await facade.getDetail(actor, slug);
  return { success: true, data: { package: toWebPackageDetailView(detail) } };
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
          "返回当前来源（`PLUGIN_MARKET_SOURCE_ID`）的全部**可见**市场条目，按展示版本的发布时刻倒序。**不做服务端分页与检索**：市场规模由私有源决定且远小于其它目录页，前端过滤已经够用（决策 D7）。整包下架的条目与「不存在」同响应，因此不出现在这里——它们只在管理面（`/api/system/plugin-market/packages`）可见。条目字段：`slug` 定位符、`latestVersion`、`metadata` 规范化快照、`publishedAt`（秒级时间戳）。本面是**纯浏览面**（发布与管理在管理台 `/admin` 的插件市场页），因此不返回逐行的有效动作，也不返回恒为 `false` 的下架标记。",
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
          "按 `slug` 返回条目详情：展示快照与 `versions` 版本历史（**只含可见版本**，下架水印不在本面出现）。整包下架的条目在本面返回 404（与「不存在」同响应）——它只对管理面可见。",
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

  return app;
}
