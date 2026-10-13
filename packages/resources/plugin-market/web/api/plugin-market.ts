/**
 * plugin-market.ts — 插件市场域 API 模块（**浏览面**）
 *
 * 两条读端点：列表与详情。发布、下架与恢复是平台管理动作，走系统凭据的
 * `./system-plugin-market.ts`（`/api/system/plugin-market/*`）——控制台里没有任何写入口，用户只是「看得到
 * 市场」。
 *
 * 这两条路径**永不访问 npm 私有源**：它们只经服务端 Facade 的读方法，浏览既有快照与私有源此刻的内容无关。
 *
 * 读方法仍返回 `ApiResponse` 而不在模块内 `unwrap`（调用方用 `unwrap` 拿 `ApiError` 语义）：这是本域与
 * `system-plugin-market.ts` 共守的一条口径——该模块的写路径必须把 409 响应体里的新快照交给调用方，
 * 两个模块对同一件「响应怎么交给上层」的事给两种约定只会让人在错误的一侧写 `try/catch`。
 */

import { request } from "@fenix/web-runtime/api/request";
import type { PluginPackageDetailView, PluginPackageListResult } from "./plugin-market-types";

export const pluginMarketApi = {
  /** 市场列表（后端不做服务端分页与检索，过滤在前端完成——决策 D7）。 */
  list: () => request<PluginPackageListResult>("/web/config/plugin-market/packages", { method: "GET" }),

  /** 条目详情：展示快照 + 版本历史（公开口径，只含可见版本）。 */
  get: (slug: string) =>
    request<{ package: PluginPackageDetailView }>("/web/config/plugin-market/packages/:slug", {
      method: "GET",
      params: { slug },
    }),
};
