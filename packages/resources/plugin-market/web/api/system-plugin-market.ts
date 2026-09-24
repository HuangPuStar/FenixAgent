/**
 * system-plugin-market.ts — 插件市场的系统 API 模块（**管理面**）
 *
 * 六条 `/api/system/plugin-market/*` 端点：读两条（全量列表、详情）走 GET，写四条（预览、发布、下架、恢复）
 * 走 POST。凭据是系统 master key（`RCS_SYSTEM_API_KEYS`），由调用方在管理台的门后提供，经
 * `request()` 的 `bearerToken` 注入 `Authorization` 头——与 sandbox / observer 的管理面同一条通道
 * （`@fenix/web-runtime/lib/admin-key`）。
 *
 * **本模块不做 `unwrap`**：发布路径的 409 `PREVIEW_CHANGED` 必须把响应体里的新快照交给调用方，而 `unwrap`
 * 会把响应压成一个异常对象，调用方只能靠断言把 `data` 取回来（同 `./plugin-market.ts` 的口径）。
 *
 * 两条读端点也**永不访问私有源**：只有预览与「确认发布但库里没有该版本」会出网。
 */

import { request } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";
import type {
  PluginAdminPackageDetailView,
  PluginAdminPackageListResult,
  PluginPublicationChange,
  PluginPublicationPreview,
} from "./system-plugin-market-types";

/** 精确版本定位参数：包名 + 精确 SemVer（后端在拼 URL 之前做形状校验）。 */
export interface VersionTarget {
  packageName: string;
  exactVersion: string;
}

/** master key 每次请求现取：门内 401 会清掉它，缓存一份会让下次请求继续用失效凭据。 */
const adminOptions = () => ({ bearerToken: getAdminKey() ?? undefined });

export const systemPluginMarketApi = {
  /** 全量列表：含整包下架的条目（公开面看不到它们）。 */
  listAll: () =>
    request<PluginAdminPackageListResult>("/api/system/plugin-market/packages", {
      ...adminOptions(),
      method: "GET",
    }),

  /** 条目详情：含已下架版本与下架水印。 */
  get: (slug: string) =>
    request<{ package: PluginAdminPackageDetailView }>("/api/system/plugin-market/packages/:slug", {
      ...adminOptions(),
      params: { slug },
    }),

  /** 读取私有源并规范化；不写库。私有源未配置时后端返回 503。 */
  preview: (target: VersionTarget) =>
    request<{ preview: PluginPublicationPreview }>("/api/system/plugin-market/publish/preview", {
      ...adminOptions(),
      method: "POST",
      body: target,
    }),

  /** 确认发布；`previewDigest` 是预览返回的摘要，后端写入前重读私有源比对，不一致时 409。 */
  publish: (target: VersionTarget & { previewDigest: string }) =>
    request<{ change: PluginPublicationChange }>("/api/system/plugin-market/publish", {
      ...adminOptions(),
      method: "POST",
      body: target,
    }),

  /** 下架某个精确版本。 */
  unpublish: (target: VersionTarget) =>
    request<{ change: PluginPublicationChange }>("/api/system/plugin-market/unpublish", {
      ...adminOptions(),
      method: "POST",
      body: target,
    }),

  /** 恢复已下架版本；版本从未进入市场时后端返回 404。 */
  restore: (target: VersionTarget) =>
    request<{ change: PluginPublicationChange }>("/api/system/plugin-market/restore", {
      ...adminOptions(),
      method: "POST",
      body: target,
    }),
};
