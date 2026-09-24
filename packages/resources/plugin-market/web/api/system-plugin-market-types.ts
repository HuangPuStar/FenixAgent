// system-plugin-market-types.ts — 插件市场 `/api/system/*` 的视图类型（**管理面**）
//
// 与浏览面（`./plugin-market-types.ts`）是两份投影，不是一套字段两个信封：
//
// - 条目多一个 `hidden`（整包下架）：公开口径里这类条目根本不存在，只有全量口径看得见它；
// - 版本项多一个 `unpublishedAt`（下架水印）：公开口径的版本历史只含可见版本；
// - 没有逐行 `access`：管理面的请求里没有主体（判据是系统 API Key），管理页因此不按条目判断能力——
//   能进这个页面就能写。
//
// 快照形状（`PluginPackageMetadata`）两条面共用：那是市场里冻结的同一份数据，不因看的人是谁而变。

import type { PluginPackageMetadata } from "./plugin-market-types";

/** 管理面条目视图：全量口径，含整包下架的条目。 */
export interface PluginAdminPackageView {
  id: string;
  slug: string;
  sourceId: string;
  packageName: string;
  /** 最新可见版本；整包下架时为 null。 */
  latestVersion: string | null;
  metadata: PluginPackageMetadata | null;
  /** 秒级时间戳；无可见版本时为 null。 */
  publishedAt: number | null;
  /** 整包下架：公开面对它返回 404。 */
  hidden: boolean;
}

/** 管理面版本项：可见版本与已下架版本都在，已下架的非空 `unpublishedAt` 就是水印。 */
export interface PluginAdminPackageVersion {
  exactVersion: string;
  metadataDigest: string;
  firstPublishedAt: number | null;
  publishedAt: number | null;
  unpublishedAt: number | null;
  isLatest: boolean;
}

export interface PluginAdminPackageDetailView extends PluginAdminPackageView {
  versions: PluginAdminPackageVersion[];
}

export interface PluginAdminPackageListResult {
  packages: PluginAdminPackageView[];
  total: number;
}

/** 预览视图：不含落库字节（`metadataJson`），管理页既不渲染它也不回传它。 */
export interface PluginPublicationPreview {
  packageName: string;
  exactVersion: string;
  metadata: PluginPackageMetadata;
  /** 「用户确认的是这一份内容」的凭据，随确认请求回传。 */
  metadataDigest: string;
}

/**
 * 写入结果：只回「发生了什么」。
 *
 * `action` 是 `publish` / `noop` / `restore` / `unpublish` 之一（后端的 `PublicationChange`），但不在这里收窄
 * 成联合类型：服务端将来新增动作时，前端应该落到兜底文案而不是类型报错——那属于运行期的兼容判断
 * （见 `web/lib/plugin-market-admin-utils.ts` 的 `changeToastKey`）。
 */
export interface PluginPublicationChange {
  action: string;
  slug: string;
  packageName: string;
  exactVersion: string;
}
