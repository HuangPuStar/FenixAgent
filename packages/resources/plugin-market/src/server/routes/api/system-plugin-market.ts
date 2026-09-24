import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import Elysia from "elysia";
import { getPluginMarketModule } from "../../runtime";
import type { PluginMarketRouteDependencies } from "../dependencies";
import {
  looseOkSchema,
  publishBodySchema,
  runSystemHandler,
  type SystemHandlerResult,
  slugParamsSchema,
  systemPreviewChangedSchema,
  toChangeView,
  toPreviewView,
  toSystemPackageDetailView,
  toSystemPackageView,
  versionBodySchema,
} from "../plugin-market-support";

/**
 * `/api/system/plugin-market/*` 协议层（**管理面**）。
 *
 * 六条路由，全部受宿主系统 API Key 保护（`systemApiKeyAuth: true`，守卫由宿主注入）：列表、详情、预览、发布、
 * 下架、恢复。这是**平台管理动作的唯一入口**——浏览面（`routes/web/config/plugin-market.ts`）只剩两条读路由，
 * 控制台里不再有任何写按钮（用户看得到市场，管理只在 `/admin` 的插件市场页）。
 *
 * 为什么管理动作走系统凭据而不是「管理员的会话 + 角色判定」：本面的调用方不是某个用户，而是平台运维者，
 * 与 observer 的 `/api/system/logs`、sandbox 的 `/api/system/sandbox-pools` 同一类——**凭据本身就是判据**，
 * 判据在路由守卫。宿主 `systemApiAuthPlugin` 刻意不恢复用户 / 组织上下文，因此这里没有 actor 可传；Facade
 * 在管理面只解析归属组织与审计主体（`facades/plugin-package-facade.ts` 的文件头解释了这条）。
 *
 * 只做协议接入：参数形状校验、把请求映射为应用调用、把结果映射为协议视图、把应用错误映射为稳定错误体。
 * 授权与发布状态分派都在 Facade 内，本文件不判断组织、角色或 `visibility`，也不自己拼业务条件。
 *
 * 两条读路由（列表、详情）也**永不访问私有源**：只有 `preview` 与「确认发布但库内没有该版本」会出网。
 * 恢复与幂等分支复用市场内的冻结快照（出口径见 Facade）。
 *
 * 与浏览面的**信封差异**是合同的一部分：`/api/system/*` 成功 `{ success: true, data }`、失败 `{ error }`
 * （平台 `ApiSystemErrorResponseSchema`）。`409` 例外地多带一个 `data.preview`，它是「预览已变化，请原地重新
 * 确认」的依据——Elysia 按响应 schema 清理返回值，因此它必须显式声明（`systemPreviewChangedSchema`）。
 */

// ── handler：把应用调用包成 `/api/system` 响应体 ──

async function handleList(): Promise<SystemHandlerResult> {
  const { facade } = getPluginMarketModule();
  const { items, total } = await facade.listAll();
  return { success: true, data: { packages: items.map((item) => toSystemPackageView(item)), total } };
}

async function handleDetail(slug: string): Promise<SystemHandlerResult> {
  const { facade } = getPluginMarketModule();
  return { success: true, data: { package: toSystemPackageDetailView(await facade.getDetailAll(slug)) } };
}

async function handlePreview(body: { packageName: string; exactVersion: string }): Promise<SystemHandlerResult> {
  const { facade } = getPluginMarketModule();
  return { success: true, data: { preview: toPreviewView(await facade.preview(body)) } };
}

async function handlePublish(
  body: { packageName: string; exactVersion: string; previewDigest?: string | undefined },
  requestId: string | null,
): Promise<SystemHandlerResult> {
  const { facade } = getPluginMarketModule();
  const change = await facade.publish({
    packageName: body.packageName,
    exactVersion: body.exactVersion,
    ...(body.previewDigest === undefined ? {} : { previewDigest: body.previewDigest }),
    requestId,
  });
  return { success: true, data: { change: toChangeView(change) } };
}

async function handleUnpublish(
  body: { packageName: string; exactVersion: string },
  requestId: string | null,
): Promise<SystemHandlerResult> {
  const { facade } = getPluginMarketModule();
  const change = await facade.unpublish({ ...body, requestId });
  return { success: true, data: { change: toChangeView(change) } };
}

async function handleRestore(
  body: { packageName: string; exactVersion: string },
  requestId: string | null,
): Promise<SystemHandlerResult> {
  const { facade } = getPluginMarketModule();
  const change = await facade.restore({ ...body, requestId });
  return { success: true, data: { change: toChangeView(change) } };
}

// ── 路由注册 ──

/** 六条写/读路由共同声明的响应码：能落在这里的码全部来自 Facade 抛出的 `AppError`（码 → 状态见 `errors.ts`）。 */
const ERROR_RESPONSES = {
  400: ApiSystemErrorResponseSchema,
  401: ApiSystemErrorResponseSchema,
  404: ApiSystemErrorResponseSchema,
};

/** 只有「会出网」的路由才可能拿到私有源的失败码（超时/限流/体积/未配置），因此单独声明一组。 */
const REGISTRY_ERROR_RESPONSES = {
  ...ERROR_RESPONSES,
  413: ApiSystemErrorResponseSchema,
  422: ApiSystemErrorResponseSchema,
  429: ApiSystemErrorResponseSchema,
  503: ApiSystemErrorResponseSchema,
};

export function createApiSystemPluginMarketRoutes(deps: PluginMarketRouteDependencies) {
  const app = new Elysia({ name: "api-system-plugin-market", prefix: "/api/system/plugin-market" }).use(
    deps.systemApiGuardPlugin,
  );

  // GET /api/system/plugin-market/packages — 全量口径（含整包下架的条目，决策 D7 的全量返回同前端过滤）
  app.get(
    "/packages",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ status }: any) => runSystemHandler(status, undefined, () => handleList()),
    {
      systemApiKeyAuth: true,
      response: {
        200: looseOkSchema,
        401: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "获取插件市场全量列表（管理面）",
        description:
          "管理面列表：**含整包下架的条目**（`hidden: true`），因此比浏览面多这一维。同样不做服务端分页与检索（决策 D7）。条目不带逐行有效动作——本面没有主体，能进这条路由就能写（判据是系统 API Key）。",
      },
    },
  );

  // GET /api/system/plugin-market/packages/:slug — 详情（含已下架版本与下架水印）
  app.get(
    "/packages/:slug",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ status, params }: any) => runSystemHandler(status, undefined, () => handleDetail(params.slug)),
    {
      systemApiKeyAuth: true,
      params: slugParamsSchema,
      response: {
        200: looseOkSchema,
        ...ERROR_RESPONSES,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "获取插件市场条目详情（管理面）",
        description:
          "按 `slug` 返回条目详情：展示快照、`versions` 版本历史（**含已下架版本**，带 `unpublishedAt` 水印——整包下架的条目也在这里可见）。不存在或 slug 非法时 404。",
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

  // POST /api/system/plugin-market/publish/preview — 读取私有源并规范化；不写库
  app.post(
    "/publish/preview",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ status, body }: any) => runSystemHandler(status, undefined, () => handlePreview(body)),
    {
      systemApiKeyAuth: true,
      body: versionBodySchema,
      response: {
        200: looseOkSchema,
        ...REGISTRY_ERROR_RESPONSES,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "预览插件版本（管理面）",
        description:
          "从 npm 私有源读取该精确版本的元数据并规范化，返回即将公开的快照与摘要；**不写库**。私有源未配置时 503（`REGISTRY_NOT_CONFIGURED`）。",
      },
    },
  );

  // POST /api/system/plugin-market/publish — 确认发布（摘要不一致时 409 带回新快照）
  app.post(
    "/publish",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ status, body, requestId }: any) => runSystemHandler(status, requestId, (id) => handlePublish(body, id)),
    {
      systemApiKeyAuth: true,
      body: publishBodySchema,
      response: {
        200: looseOkSchema,
        // 409 单独声明：它要多带 `data.preview`，用通用错误体会被 Elysia 按 schema 清掉。
        409: systemPreviewChangedSchema,
        ...REGISTRY_ERROR_RESPONSES,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "发布插件版本（管理面）",
        description:
          "按库内该精确版本的状态分派：已可见 → 幂等（`noop`）、已下架 → 恢复、不存在 → 重读私有源并比对 `previewDigest` 后落库。摘要不一致时 409 `PREVIEW_CHANGED`，响应体带回刚读到的快照供原地重新确认。前两条分支**不访问私有源**。",
      },
    },
  );

  // POST /api/system/plugin-market/unpublish — 下架某个精确版本
  app.post(
    "/unpublish",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ status, body, requestId }: any) => runSystemHandler(status, requestId, (id) => handleUnpublish(body, id)),
    {
      systemApiKeyAuth: true,
      body: versionBodySchema,
      response: {
        200: looseOkSchema,
        ...ERROR_RESPONSES,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "下架插件版本（管理面）",
        description:
          "把某个精确版本从公开面撤下：快照仍留在市场里，可随时恢复。版本不在市场里时 404，且**不访问私有源**。",
      },
    },
  );

  // POST /api/system/plugin-market/restore — 恢复已下架版本
  app.post(
    "/restore",
    // biome-ignore lint/suspicious/noExplicitAny: Elysia context 类型在自定义 response schema 下不稳定
    ({ status, body, requestId }: any) => runSystemHandler(status, requestId, (id) => handleRestore(body, id)),
    {
      systemApiKeyAuth: true,
      body: versionBodySchema,
      response: {
        200: looseOkSchema,
        ...ERROR_RESPONSES,
      },
      detail: {
        tags: ["PluginMarket"],
        summary: "恢复已下架版本（管理面）",
        description:
          "让一个已下架的版本重新对公众可见，复用市场内那份**冻结快照**（不重读私有源，也不比对摘要）。版本从未进入市场时 404，提示改用发布。",
      },
    },
  );

  return app;
}
