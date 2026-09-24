/**
 * plugin-market.ts — 插件市场域 API 模块
 *
 * 封装市场条目的读取与三个平台管理动作（发布 / 下架 / 恢复）。
 * 后端是六条 `/web/config/plugin-market/*` 端点：读两条（列表、详情）走 GET，写四条（预览、发布、下架、
 * 恢复）走 POST——写动作是**平台管理动作**（只有系统管理员可用），没有 `/api` 面，也不由外部系统发起。
 *
 * 方法一律返回 `ApiResponse`（域模块不做 `unwrap`）：发布路径的 409 `PREVIEW_CHANGED` 必须把响应体里的
 * 新快照交给调用方，而 `unwrap` 会把响应压成一个异常对象，调用方只能靠断言把 `data` 取回来。页面侧因此
 * 显式判断 `success`——这不是「忘了 unwrap」，是这条路径的真实契约。
 */

import { request } from "@fenix/web-runtime/api/request";
import type {
  PluginPackageDetailView,
  PluginPackageListResult,
  PluginPublicationChange,
  PluginPublicationPreview,
} from "./plugin-market-types";

/** 精确版本定位参数：包名 + 精确 SemVer（后端在拼 URL 之前做形状校验）。 */
export interface VersionTarget {
  packageName: string;
  exactVersion: string;
}

export const pluginMarketApi = {
  /** 全量列表（前端过滤，后端不做服务端分页与检索）。 */
  list: () => request<PluginPackageListResult>("/web/config/plugin-market/packages", { method: "GET" }),

  /** 条目详情：展示快照 + 版本历史（写权主体含已下架版本，带水印）。 */
  get: (slug: string) =>
    request<{ package: PluginPackageDetailView }>("/web/config/plugin-market/packages/:slug", {
      method: "GET",
      params: { slug },
    }),

  /** 读取私有源并规范化；不写库。私有源未配置时后端返回 503。 */
  preview: (target: VersionTarget) =>
    request<{ preview: PluginPublicationPreview }>("/web/config/plugin-market/publish/preview", {
      method: "POST",
      body: target,
    }),

  /** 确认发布；`previewDigest` 是预览返回的摘要，后端写入前重读私有源比对。 */
  publish: (target: VersionTarget & { previewDigest: string }) =>
    request<{ change: PluginPublicationChange }>("/web/config/plugin-market/publish", {
      method: "POST",
      body: target,
    }),

  /** 下架某个精确版本。 */
  unpublish: (target: VersionTarget) =>
    request<{ change: PluginPublicationChange }>("/web/config/plugin-market/unpublish", {
      method: "POST",
      body: target,
    }),

  /** 恢复已下架版本；版本从未进入市场时后端返回 404。 */
  restore: (target: VersionTarget) =>
    request<{ change: PluginPublicationChange }>("/web/config/plugin-market/restore", {
      method: "POST",
      body: target,
    }),
};
