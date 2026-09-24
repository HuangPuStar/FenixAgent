import type { ActorContext } from "@fenix/platform-sdk";
import { AppError, WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import type { PackageDetailView, PackageVersionView, PackageView } from "../domain/package-view";
import type { PublicationChange } from "../domain/types";
import { PreviewChangedError } from "../facades/plugin-package-facade";
import type { PublicationPreview } from "../npm-registry/types";

/**
 * 两条协议面（`/web/config/plugin-market/*` 与 `/api/system/plugin-market/*`）的公共设施：错误映射、主体
 * 提取与视图映射。
 *
 * 单独成文件是因为它同时服务两条面的八条路由：错误码 → 状态码、领域视图 → 协议视图这两件事写在路由文件里
 * 会被八处复制，而它们必须**只有一处**——复制出去以后新增一个错误码就会漏改其中几条路由，表现为「同一个
 * 错误在列表是 409、在详情是 400」。
 *
 * 两个面共用**视图的基础字段**，各有**信封**：`/web/*` 用 `{ success, data }` / `{ success: false, error }`，
 * `/api/system/*` 用 `{ success: true, data }` / `{ error }`（平台 `ApiSystemErrorResponseSchema` 的既有
 * 合同）。视图这边不是「一套字段两个信封」：浏览面与它的条目可见集合一一对应（没有下架条目、没有逐行动作），
 * 管理面多出下架水印，因此各自有投影函数（见 `toWebPackageBaseView` 的说明）。
 */

export type WebErrorBody = z.infer<typeof WebErrSchema>;

/** 成功分支：两个面同形（`{ success: true, data }`），因此只声明一次。 */
type HandlerSuccess = { success: true; data: Record<string, unknown> | null };

/**
 * `/web` handler 的返回形状。
 *
 * 错误分支允许携带 `data`：`PREVIEW_CHANGED` 要把重新读到的快照交回前端原地重新确认（先例：技能上传冲突
 * 用同一个信封带回冲突清单）。
 */
export type WebHandlerResult = HandlerSuccess | (WebErrorBody & { data?: unknown });

/**
 * `/api/system/*` handler 的返回形状。
 *
 * 失败分支是平台声明的 `{ error: { code, message } }`，**不带 `success`**——那是 `/api/system/*` 的既有
 * 合同（系统面先例见 observer 的三条路由），不为了与 `/web` 对齐而改。`data` 仍可选：409 `PREVIEW_CHANGED`
 * 与 `/web` 一样要把新快照带回去。
 */
export type SystemHandlerResult = HandlerSuccess | { error: WebErrorBody["error"]; data?: unknown };

/**
 * 成功响应 schema。
 *
 * 用宽松对象而不是逐字段声明：Elysia 按响应 schema **清理**返回值，逐字段 schema 一旦漏声明某个字段就会
 * 静默把它从响应里删掉（技能冲突体的注释记录了同一条行为）。精确契约由两条面的用例逐字段断言，请求侧的
 * body / params 则一律严格声明——那才是必须拒绝非法输入的地方。
 */
export const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

/**
 * `PREVIEW_CHANGED` 的 409 响应体（`/web` 面）。
 *
 * `data.preview` 必须显式声明：Elysia 按 schema 清理时会把未声明的键剥掉，前端就再也拿不到需要重新确认的
 * 快照，只能让用户从头再走一遍预览。
 */
export const previewChangedSchema = WebErrSchema.extend({
  data: z.object({ preview: z.looseObject({}) }),
});

/** `/api/system/*` 面的 409 响应体；信封不同，因此单独声明（见文件头）。 */
export const systemPreviewChangedSchema = z.object({
  error: WebErrSchema.shape.error,
  data: z.object({ preview: z.looseObject({}) }),
});

export function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return { success: false, error: { code, message } };
}

/** `/api/system/*` 的错误体：形状是平台声明的合同（整个 `{ error }` 信封），不含 `success`。 */
export function buildSystemErrorBody(code: string, message: string): { error: WebErrorBody["error"] } {
  return { error: { code, message } };
}

/**
 * 精确版本定位参数：包名 + 精确 SemVer。
 *
 * 形状校验在 Facade（`assertPackageName` / `assertExactVersion`）；这里只声明**协议面**的必填与非空——两条
 * 面的写请求体同形，因此只声明一次。
 */
export const versionBodySchema = z.object({
  packageName: z.string().min(1).describe("npm 包名，可含 scope（如 `@acme/investment-team`）。"),
  exactVersion: z.string().min(1).describe("精确 SemVer。范围、tag、部分版本一律拒绝。"),
});

/** 确认发布的请求体：比预览多一个摘要，它是「用户确认的是这一份内容」的凭据。 */
export const publishBodySchema = versionBodySchema.extend({
  previewDigest: z
    .string()
    .min(1)
    .optional()
    .describe("预览返回的 `metadataDigest`；服务端在写入前重读私有源并比对，缺失时拒绝。"),
});

/** 条目定位参数：包名的 URL 安全编码。 */
export const slugParamsSchema = z.object({
  slug: z.string().min(1).describe("包名的 URL 安全编码（`domain/slug.ts` 的 `toPackageSlug`）。"),
});

/** `PREVIEW_CHANGED` 的冲突体（`/web` 面）：错误码 + 新快照。 */
export function buildPreviewChangedBody(message: string, preview: PublicationPreview): WebHandlerResult {
  return {
    success: false,
    error: { code: "PREVIEW_CHANGED", message },
    data: { preview: toPreviewView(preview) },
  };
}

/** `PREVIEW_CHANGED` 的冲突体（`/api/system` 面）；消息沿用 Facade 抛出时的措辞，避免两处各写一遍文案。 */
export function buildSystemPreviewChangedBody(message: string, preview: PublicationPreview): SystemHandlerResult {
  return { error: { code: "PREVIEW_CHANGED", message }, data: { preview: toPreviewView(preview) } };
}

/** handler 依赖的请求上下文；`requestId` 由宿主的 `derive` 注入，非宿主挂载（含用例）时为 `undefined`。 */
export interface WebRequestContext {
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store 类型未完全可表达
  readonly store: any;
  readonly requestId?: unknown;
}

/**
 * 执行 `/web` handler：取主体与请求标识 → 执行 → 把宿主错误类映射为 `/web` 错误体。未知错误保持上抛（500）。
 *
 * 状态码取自错误自身的 `statusCode`（{@link PluginMarketError} 用封闭清单给出、平台错误类各自声明），不在
 * 这里再维护一张码 → 状态的表：那样每新增一个错误码都要在两处登记，漏改的一处会静默把 409 变成 400。
 * 各路由的 `response` 因此必须声明它可能返回的全部状态码。
 */
export async function runWebHandler(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  status: any,
  context: WebRequestContext,
  handler: (actor: ActorContext, requestId: string | null) => Promise<WebHandlerResult>,
): Promise<WebHandlerResult> {
  const actor = context.store.actor as ActorContext | null;
  if (!actor) {
    // 已认证但没有组织上下文（例如未绑定组织的 API Key）不能操作组织资源。
    return status(401, buildWebErrorBody("UNAUTHORIZED", "请求缺少组织上下文"));
  }
  const requestId = typeof context.requestId === "string" ? context.requestId : null;
  try {
    return await handler(actor, requestId);
  } catch (error_) {
    if (error_ instanceof PreviewChangedError) {
      return status(409, buildPreviewChangedBody(error_.message, error_.preview));
    }
    if (error_ instanceof AppError) {
      return status(error_.statusCode, buildWebErrorBody(error_.code, error_.message));
    }
    throw error_;
  }
}

/**
 * 执行 `/api/system` handler。
 *
 * 与 {@link runWebHandler} 的区别只有两处，且都是受信凭据的结果：**不取主体**（系统 key 刻意不恢复用户 /
 * 组织上下文，判据在路由守卫，因此这里连 `store` 都不看）与**换信封**。错误 → 状态码的映射共用同一份
 * `AppError` 语义——`statusCode` 仍取自错误自身，不在这里维护第二张表。
 *
 * `requestId` 收原始值（宿主的 `derive` 产物）：管理面的写入要写审计流水，而它在非宿主挂载（用例）下不存在，
 * 归一只在本函数做一次。
 */
export async function runSystemHandler(
  // biome-ignore lint/suspicious/noExplicitAny: Elysia status 函数在自定义 response schema 下类型不稳定
  status: any,
  requestId: unknown,
  handler: (requestId: string | null) => Promise<SystemHandlerResult>,
): Promise<SystemHandlerResult> {
  try {
    return await handler(typeof requestId === "string" ? requestId : null);
  } catch (error_) {
    if (error_ instanceof PreviewChangedError) {
      return status(409, buildSystemPreviewChangedBody(error_.message, error_.preview));
    }
    if (error_ instanceof AppError) {
      return status(error_.statusCode, buildSystemErrorBody(error_.code, error_.message));
    }
    throw error_;
  }
}

/**
 * 秒级时间戳。
 *
 * `/web` 面有两种先例（mcp 的 `inspectedAt` 用毫秒，machine / agent-config / knowledge 用秒），本模块按
 * **多数且更晚统一**的一侧取秒：目录页的展示精度到秒，毫秒位在 UI 上没有消费方，多了只会在契约里留下一个
 * 永远为 0 的尾巴。`null` 原样传递，不折算成 0——0 是 1970 年，会被前端当成一个真实时刻。
 */
function toEpochSeconds(value: Date | null): number | null {
  return value === null ? null : Math.floor(value.getTime() / 1000);
}

/**
 * 浏览面的字段清单：**只含浏览需要的东西**，且每一项都是本面真的会变化的。
 *
 * 三个领域字段刻意不出现在这里：`hidden`（整包下架的条目根本不在公开口径里，恒为 false）、版本级的
 * `unpublishedAt`（同因，公开口径的版本历史只含可见版本）、以及逐行 `access`（浏览面没有任何写入口，
 * 见 `facades/plugin-package-facade.ts` 的读方法）。把它们照搬过来只会给前端留下三个恒为常量、没有消费
 * 方的字段——那是「界面按一个假能力位渲染」的温床。管理面（`toSystemPackageView`）才需要它们。
 */
function toWebPackageBaseView(view: PackageView) {
  return {
    id: view.id,
    slug: view.slug,
    sourceId: view.sourceId,
    packageName: view.packageName,
    latestVersion: view.latestVersion,
    metadata: view.metadata,
    publishedAt: toEpochSeconds(view.publishedAt),
  };
}

/** 浏览面版本项：不含快照正文（详情页只渲染当前展示版本的正文）。 */
function toWebVersionItem(version: PackageVersionView) {
  return {
    exactVersion: version.exactVersion,
    metadataDigest: version.metadataDigest,
    firstPublishedAt: toEpochSeconds(version.firstPublishedAt),
    publishedAt: toEpochSeconds(version.publishedAt),
    isLatest: version.isLatest,
  };
}

/** 管理面版本项：浏览面的字段 + 下架水印（管理面看得到已下架版本，这个字段在那里才有信息量）。 */
function toSystemVersionItem(version: PackageVersionView) {
  return { ...toWebVersionItem(version), unpublishedAt: toEpochSeconds(version.unpublishedAt) };
}

/** 浏览面列表项视图。 */
export function toWebPackageView(view: PackageView) {
  return toWebPackageBaseView(view);
}

/** 管理面列表项视图：浏览面清单 + 整包下架水印。 */
export function toSystemPackageView(view: PackageView) {
  return { ...toWebPackageBaseView(view), hidden: view.hidden };
}

/** 浏览面详情视图：列表项 + 版本历史。 */
export function toWebPackageDetailView(view: PackageDetailView) {
  return {
    ...toWebPackageView(view),
    versions: view.versions.map((version) => toWebVersionItem(version)),
  };
}

/** 管理面详情视图：同 {@link toSystemPackageView} 的取法。 */
export function toSystemPackageDetailView(view: PackageDetailView) {
  return {
    ...toSystemPackageView(view),
    versions: view.versions.map((version) => toSystemVersionItem(version)),
  };
}

/**
 * 预览视图：只给展示与确认需要的四项。
 *
 * 刻意**不含** `metadataJson`：那是落库的字节原文（`PublicationPreview` 的说明解释了为什么存储用文本而不是
 * JSON），前端既不渲染它也不回传它——多传一份只是把一个可能很大的内部表示搬到网络上。两个面共用同一份投影：
 * 管理台预览到的内容，与它随后确认发布的内容必须是同一份描述。
 */
export function toPreviewView(preview: PublicationPreview) {
  return {
    packageName: preview.ref.packageName,
    exactVersion: preview.ref.exactVersion,
    metadata: preview.metadata,
    metadataDigest: preview.metadataDigest,
  };
}

/**
 * 写入结果视图：只回「发生了什么」。
 *
 * 不回整个刷新后的条目：列表的顺序与展示快照都可能因这次写入而变（逻辑时钟前移、latest 回退），前端本来
 * 就要重新拉一次列表；在这里拼一份「差不多新」的视图，只会让两处各算一遍并可能不一致。
 */
export function toChangeView(change: PublicationChange) {
  return {
    action: change.action,
    slug: change.packageSlug,
    packageName: change.packageName,
    exactVersion: change.exactVersion,
  };
}
