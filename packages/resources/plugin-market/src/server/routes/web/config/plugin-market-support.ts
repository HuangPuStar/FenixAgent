import type { ActorContext, AuthorizedResource } from "@fenix/platform-sdk";
import { AppError, WebErrSchema, WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import type { PackageDetailView, PackageVersionView, PackageView } from "../../../domain/package-view";
import type { PublicationChange } from "../../../domain/types";
import { PreviewChangedError } from "../../../facades/plugin-package-facade";
import type { PublicationPreview } from "../../../npm-registry/types";

/**
 * `/web/config/plugin-market` 的协议层公共设施：错误映射、主体提取与视图映射。
 *
 * 单独成文件是因为它同时服务六条路由：错误码 → 状态码、领域视图 → `/web` 视图这两件事写在路由文件里会被
 * 六处复制，而它们必须**只有一处**——复制出去以后新增一个错误码就会漏改其中几条路由，表现为「同一个错误在
 * 列表是 409、在详情是 400」。
 */

export type WebErrorBody = z.infer<typeof WebErrSchema>;

/**
 * handler 的返回形状。
 *
 * 错误分支允许携带 `data`：`PREVIEW_CHANGED` 要把重新读到的快照交回前端原地重新确认（先例：技能上传冲突
 * 用同一个信封带回冲突清单）。
 */
export type WebHandlerResult =
  | { success: true; data: Record<string, unknown> | null }
  | (WebErrorBody & { data?: unknown });

/**
 * 成功响应 schema。
 *
 * 用宽松对象而不是逐字段声明：Elysia 按响应 schema **清理**返回值，逐字段 schema 一旦漏声明某个字段就会
 * 静默把它从响应里删掉（技能冲突体的注释记录了同一条行为）。精确契约由本路由的用例逐字段断言，请求侧的
 * body / params 则一律严格声明——那才是必须拒绝非法输入的地方。
 */
export const looseOkSchema = WebOkSchema(z.union([z.looseObject({}), z.null()]));

/**
 * `PREVIEW_CHANGED` 的 409 响应体。
 *
 * `data.preview` 必须显式声明：Elysia 按 schema 清理时会把未声明的键剥掉，前端就再也拿不到需要重新确认的
 * 快照，只能让用户从头再走一遍预览。
 */
export const previewChangedSchema = WebErrSchema.extend({
  data: z.object({ preview: z.looseObject({}) }),
});

export function buildWebErrorBody(code: string, message: string): WebErrorBody {
  return { success: false, error: { code, message } };
}

/** `PREVIEW_CHANGED` 的冲突体：错误码 + 新快照（消息沿用 Facade 抛出时的措辞，避免两处各写一遍文案）。 */
export function buildPreviewChangedBody(message: string, preview: PublicationPreview): WebHandlerResult {
  return {
    success: false,
    error: { code: "PREVIEW_CHANGED", message },
    data: { preview: toWebPreview(preview) },
  };
}

/** handler 依赖的请求上下文；`requestId` 由宿主的 `derive` 注入，非宿主挂载（含用例）时为 `undefined`。 */
export interface WebRequestContext {
  // biome-ignore lint/suspicious/noExplicitAny: Elysia store 类型未完全可表达
  readonly store: any;
  readonly requestId?: unknown;
}

/**
 * 执行 handler：取主体与请求标识 → 执行 → 把宿主错误类映射为 `/web` 错误体。未知错误保持上抛（500）。
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
 * 秒级时间戳。
 *
 * `/web` 面有两种先例（mcp 的 `inspectedAt` 用毫秒，machine / agent-config / knowledge 用秒），本模块按
 * **多数且更晚统一**的一侧取秒：目录页的展示精度到秒，毫秒位在 UI 上没有消费方，多了只会在契约里留下一个
 * 永远为 0 的尾巴。`null` 原样传递，不折算成 0——0 是 1970 年，会被前端当成一个真实时刻。
 */
function toEpochSeconds(value: Date | null): number | null {
  return value === null ? null : Math.floor(value.getTime() / 1000);
}

/** 版本项视图：不含快照正文（详情页只渲染当前展示版本的正文），`unpublishedAt` 非空即下架水印。 */
function toWebVersionItem(version: PackageVersionView) {
  return {
    exactVersion: version.exactVersion,
    metadataDigest: version.metadataDigest,
    firstPublishedAt: toEpochSeconds(version.firstPublishedAt),
    publishedAt: toEpochSeconds(version.publishedAt),
    unpublishedAt: toEpochSeconds(version.unpublishedAt),
    isLatest: version.isLatest,
  };
}

/** 列表项视图：展示投影（含归属 `scope`）+ 当前主体的有效动作（决策 D2，与 mcp / skill 同形）。 */
export function toWebPackageView(view: AuthorizedResource<PackageView>) {
  return {
    id: view.id,
    slug: view.slug,
    sourceId: view.sourceId,
    packageName: view.packageName,
    latestVersion: view.latestVersion,
    metadata: view.metadata,
    publishedAt: toEpochSeconds(view.publishedAt),
    hidden: view.hidden,
    scope: view.scope,
    access: view.access,
  };
}

/** 详情视图：列表项 + 版本历史（写权主体含已下架版本，带水印）。 */
export function toWebPackageDetailView(view: AuthorizedResource<PackageDetailView>) {
  return {
    ...toWebPackageView(view),
    versions: view.versions.map((version) => toWebVersionItem(version)),
  };
}

/**
 * 预览视图：只给展示与确认需要的四项。
 *
 * 刻意**不含** `metadataJson`：那是落库的字节原文（`PublicationPreview` 的说明解释了为什么存储用文本而不是
 * JSON），前端既不渲染它也不回传它——多传一份只是把一个可能很大的内部表示搬到网络上。
 */
export function toWebPreview(preview: PublicationPreview) {
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
export function toWebChange(change: PublicationChange) {
  return {
    action: change.action,
    slug: change.packageSlug,
    packageName: change.packageName,
    exactVersion: change.exactVersion,
  };
}
