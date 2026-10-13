// plugin-market-admin-utils.ts — 管理台的**展示层纯逻辑**（只在管理面消费）
//
// 与 `plugin-market-utils.ts` 的分工：那边是两条面共用的展示取值、格式化与范围判定（同一个条目对谁都给同一个
// 答案），这边是**只有管理面才有的东西**——多一档「已下架」的范围口径、写入结果 → 提示文案、409 冲突体 → 新
// 快照。浏览面既没有写路径、也没有「已下架」这一档（公开口径里根本不存在这类条目），因此这三件事在浏览面没有
// 消费方，放在那边只会让浏览面的模块图里多一段永远不会执行的代码。
//
// 依旧不 import React、不读 i18n 单例：返回的是文案 key 与渲染子集，`t()` 与渲染由页面负责。

import * as z from "zod/v4";
import type { PluginCatalogScope } from "../api/plugin-market-types";
import type { PluginAdminPackageView } from "../api/system-plugin-market-types";
import { countScopes, filterPackages } from "./plugin-market-utils";

/**
 * 管理面的范围口径：浏览面三档 + 「已下架」。
 *
 * 「已下架」= **整包**下架（`hidden`：所有版本都撤下，公开面对该条目返回 404）。只撤下部分版本的条目仍然是
 * 可见条目，它的水印在版本历史里，不在这一档。
 */
export type PluginAdminCatalogScope = PluginCatalogScope | "withdrawn";

/** 管理面的范围计数：三档沿用浏览面口径，另加「已下架」。 */
export function countAdminScopes(packages: readonly PluginAdminPackageView[]): Record<PluginAdminCatalogScope, number> {
  return { ...countScopes(packages), withdrawn: packages.filter((view) => view.hidden).length };
}

/**
 * 管理面的目录过滤：与浏览面同一份实现，只在「已下架」这一档上做加法。
 *
 * 不复用调用点的写法（`filterPackages(packages, query, scope)` 然后各自再判一次 `hidden`）是为了让
 * 「哪些条目属于这一档」只有一处定义：两处各写一次，改判据时总会漏掉一处。
 */
export function filterAdminPackages(
  packages: readonly PluginAdminPackageView[],
  query: string,
  scope: PluginAdminCatalogScope,
): PluginAdminPackageView[] {
  if (scope !== "withdrawn") return filterPackages(packages, query, scope);
  return filterPackages(packages, query, "all").filter((view) => view.hidden);
}

/**
 * 409 `PREVIEW_CHANGED` 带回的新快照。
 *
 * 入参是**错误信封**（`{ code, data }`）而不是 `ApiError`：管理面 API 刻意不做 `unwrap`（发布路径拿到的是
 * `request()` 的失败响应 `{ success: false, error }`），新快照就在 `error.data.preview` 里；若只接
 * `ApiError`，这条路径永远解析不出东西，而界面上表现为「冲突提示不出来、按钮点了没反应」。
 *
 * 解析出来的是**渲染子集**（{@link PreviewSnapshot}）而不是整份 `PluginPublicationPreview`：预览面板只读
 * 下列字段，逐字段校验既拿得到类型（不用断言一个 `unknown` 袋子），也顺带保证了畸形响应不会被画到界面上。
 */
const previewSchema = z.object({
  packageName: z.string().min(1),
  exactVersion: z.string().min(1),
  metadataDigest: z.string().min(1),
  metadata: z.object({
    displayName: z.string().nullish(),
    summary: z.string().nullish(),
    description: z.string().nullish(),
    agents: z.array(z.unknown()),
    skills: z.array(z.unknown()),
    servers: z.array(z.unknown()),
  }),
});

/** 预览面板渲染所需的字段子集；`PluginPublicationPreview` 结构上满足它（成员数组只用于计数）。 */
export type PreviewSnapshot = z.infer<typeof previewSchema>;

/** 从失败信封里取回「刚读到的快照」；码不符或形状畸形时返回 null（界面按「预览不可用」处理）。 */
export function readPreviewChangedPayload(error: { code: string; data?: unknown } | undefined): PreviewSnapshot | null {
  if (error?.code !== "PREVIEW_CHANGED") return null;
  const data = error.data as { preview?: unknown } | undefined;
  const parsed = previewSchema.safeParse(data?.preview);
  return parsed.success ? parsed.data : null;
}

/**
 * 写入动作的结果 → 提示文案 key（四条文案都带 `{{version}}` 插值）。
 *
 * `noop`（版本已在市场中）也是成功，但不能说「已发布」：用户需要知道这次点击没有产生新快照，否则会以为
 * 私有源上的新内容已经进了市场。
 */
export function changeToastKey(action: string): string {
  switch (action) {
    case "publish":
      return "toast.published";
    case "noop":
      return "toast.noop";
    case "unpublish":
      return "toast.unpublished";
    case "restore":
      return "toast.restored";
    default:
      // 服务端新增动作类型时不静默吞掉：落在最接近的中性口径上，同时该分支的存在本身就是一次提醒。
      return "toast.published";
  }
}
