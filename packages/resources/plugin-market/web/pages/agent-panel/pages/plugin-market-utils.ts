// plugin-market-utils.ts — 插件市场目录页的**纯逻辑**
//
// 这里只放可以被单元测试逐条断言的东西：过滤 / 计数、展示取值、动作可见性、错误分类、时间与体积格式化。
// 不 import React、不读 i18n 单例、不发请求——文案 key 由调用方 `t()` 解析（与 `ScopeFilterBar` 不接
// i18n 的裁定同因），因此本文件可以在没有 DOM、没有 i18next 的用例里直接跑。

import { formatDateTime } from "@fenix/ui-components/lib/format";
import { ApiError } from "@fenix/web-runtime/api/request";
import * as z from "zod/v4";
import type { PluginCatalogScope, PluginPackageView } from "../../../api/plugin-market-types";

/**
 * 授权失败的错误码。
 *
 * 两个都要认：`FORBIDDEN` 是本模块后端在写权/读权判定失败时抛的 403，`UNAUTHORIZED` 是「已认证但缺组织
 * 上下文」的 401（`runWebHandler` 的说明）。`request()` 只在响应体没有 code 时才按 HTTP 状态归一，因此
 * 不能只看状态码。
 */
const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/** 是否授权失败；为真时页面走无权限分支（**不给重试**：授权结果是稳定结论，重试只会把用户引向无意义请求）。 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && ACCESS_DENIED_CODES.has(error.code);
}

/** 展示名：快照的 `displayName` 优先，缺失回退包名（快照坏损时视图的 `metadata` 为 null）。 */
export function getPackageDisplayName(view: PluginPackageView): string {
  const displayName = view.metadata?.displayName;
  return displayName && displayName.length > 0 ? displayName : view.packageName;
}

/** 一句话说明：`summary` 优先，回退 `description`；都没有时返回 null（调用方给「暂无说明」）。 */
export function getPackageSummary(view: PluginPackageView): string | null {
  const text = view.metadata?.summary ?? view.metadata?.description ?? null;
  return text && text.length > 0 ? text : null;
}

/** 条目是否来自「专家团队」：快照声明了 agent 成员。 */
export function hasAgentMembers(view: PluginPackageView): boolean {
  return (view.metadata?.agents.length ?? 0) > 0;
}

/** 条目是否来自「连接器」：快照声明了 MCP server 成员。 */
export function hasServerMembers(view: PluginPackageView): boolean {
  return (view.metadata?.servers.length ?? 0) > 0;
}

/**
 * 当前主体能否对该条目执行写动作（下架 / 恢复）。
 *
 * 按 `access.update` 保守判断：动作集合由服务端算好，缺失即视为不可写——前端不做「大概可以」的猜测，
 * 那会让按钮出现而请求被 403 拒回。页面级能力位（能否**发布**新版本）不看条目，见列表响应的 `canPublish`。
 */
export function canWritePackage(view: PluginPackageView): boolean {
  return view.access?.actions?.includes("update") ?? false;
}

/** 各范围命中的条数，供筛选条上的计数徽标使用。 */
export function countScopes(packages: readonly PluginPackageView[]): Record<PluginCatalogScope, number> {
  return {
    all: packages.length,
    teams: packages.filter(hasAgentMembers).length,
    connectors: packages.filter(hasServerMembers).length,
    withdrawn: packages.filter((view) => view.hidden).length,
  };
}

/**
 * 目录过滤：关键词 + 范围。
 *
 * 在**前端**过滤是后端的有意设计（决策 D7：全量返回，不做服务端分页与检索），因此这里的匹配面要够宽——
 * 包名、展示名、当前版本号、关键词与说明文本都参与匹配，用户记得住哪一个都能搜到。
 */
export function filterPackages(
  packages: readonly PluginPackageView[],
  query: string,
  scope: PluginCatalogScope,
): PluginPackageView[] {
  const keyword = query.trim().toLowerCase();
  return packages.filter((view) => {
    if (scope === "teams" && !hasAgentMembers(view)) return false;
    if (scope === "connectors" && !hasServerMembers(view)) return false;
    if (scope === "withdrawn" && !view.hidden) return false;
    if (keyword.length === 0) return true;

    const haystack = [
      view.packageName,
      view.metadata?.displayName ?? "",
      view.latestVersion ?? "",
      view.metadata?.description ?? "",
      view.metadata?.summary ?? "",
      ...(view.metadata?.keywords ?? []),
    ];
    return haystack.some((field) => field.toLowerCase().includes(keyword));
  });
}

/**
 * 选中项的**有效值**：过滤结果里按 slug 命中，未命中（含未选中、选中项被过滤掉）回退到第一条。
 *
 * 详情请求与目录高亮必须取自同一次解析：两处各推一次会漂移成「左边高亮 A、右边显示 B 的详情」。
 * 所以调用方（页面容器）与渲染方（目录页）都调用本函数，输入相同则结果必然相同。
 */
export function resolveSelectedPackage(
  packages: readonly PluginPackageView[],
  query: string,
  scope: PluginCatalogScope,
  slug: string | null,
): PluginPackageView | null {
  const filtered = filterPackages(packages, query, scope);
  return filtered.find((view) => view.slug === slug) ?? filtered[0] ?? null;
}

/**
 * 秒级时间戳 → 本地化时刻串。
 *
 * 后端给的是**秒**（`toEpochSeconds`），而格式化原语吃 epoch **毫秒**：换算只在这一处发生，调用点不得
 * 各自 `* 1000`。`null` 原样回退占位符——0 是 1970 年，折算成 0 会把「没有值」显示成一个真实时刻。
 */
export function formatEpochSeconds(value: number | null, locale?: string, fallback = "—"): string {
  return formatDateTime(value === null ? null : value * 1000, {
    ...(locale === undefined ? {} : { locale }),
    fallback,
  });
}

/** 解包体积 → 本地化文本（1 MiB 以下用 KiB）；缺值或非正数返回 null（调用方不渲染该行）。 */
export function formatBytes(value: number | null, locale?: string): string | null {
  if (value === null || value <= 0) return null;
  const [unit, divisor] = value < 1024 * 1024 ? (["kilobyte", 1024] as const) : (["megabyte", 1024 * 1024] as const);
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, style: "unit", unit }).format(value / divisor);
}

/**
 * 409 `PREVIEW_CHANGED` 带回的新快照。
 *
 * 入参是**错误信封**（`{ code, data }`）而不是 `ApiError`：本域 API 刻意不做 `unwrap`，发布路径拿到的是
 * `request()` 的失败响应 `{ success: false, error }`，新快照就在 `error.data.preview` 里；若只接
 * `ApiError`，这条路径永远解析不出东西，而页面上表现为「冲突提示不出来、按钮点了没反应」。
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
