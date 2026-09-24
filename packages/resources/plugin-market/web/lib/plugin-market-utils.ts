// plugin-market-utils.ts — 插件市场的**展示层纯逻辑**（浏览面为主，管理面复用其中的展示与检索）
//
// 这里只放可以被单元测试逐条断言的东西：过滤 / 计数、展示取值、错误分类、时间与体积格式化。不 import React、
// 不读 i18n 单例、不发请求——文案 key 由调用方 `t()` 解析（与 `ScopeFilterBar` 不接 i18n 的裁定同因），因此本
// 文件可以在没有 DOM、没有 i18next 的用例里直接跑。
//
// 两条面共用的是**展示取值、格式化与范围判定**：`getPackageDisplayName` / `getPackageSummary` / 成员判定 /
// 检索匹配 / 范围过滤 / 时间与体积格式化对同一个条目给出同一个答案，不因看的人是谁而变（参数取最小结构形状，
// 两面的条目视图在结构上都满足它）。各自独有的是：**范围清单**（浏览面只有「全部 / 专家团队 / 连接器」——已下架
// 的条目根本不在公开口径里；管理面多一档「已下架」）与**写路径的产物**（冲突体解析、写入结果的提示映射，见
// `plugin-market-admin-utils.ts`）。

import { formatDateTime } from "@fenix/ui-components/lib/format";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { PluginCatalogScope, PluginPackageView } from "../api/plugin-market-types";

/**
 * 授权失败的错误码。
 *
 * 两个都要认：`FORBIDDEN` 是读权判定失败的 403，`UNAUTHORIZED` 是「已认证但缺组织上下文」的 401
 * （`runWebHandler` 的说明）。`request()` 只在响应体没有 code 时才按 HTTP 状态归一，因此不能只看状态码。
 */
const ACCESS_DENIED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/**
 * 错误码是否表示授权失败。
 *
 * 与 {@link isUnauthorizedError} 分成两层：管理面的写路径刻意不做 `unwrap`（发布路径要拿 409 冲突体），
 * 拿在手里的是失败**信封**（`{ code, message }`）而不是 `ApiError`——`instanceof` 那一层对信封恒为 false，
 * 只用它会把「凭据失效」误判成普通失败：门不回位，用户停在原地反复点。
 */
export function isAccessDeniedCode(code: string | undefined): boolean {
  return code !== undefined && ACCESS_DENIED_CODES.has(code);
}

/** 是否授权失败；为真时页面走无权限分支（**不给重试**：授权结果是稳定结论，重试只会把用户引向无意义请求）。 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && isAccessDeniedCode(error.code);
}

/**
 * 「展示名 + 快照」这一对字段的条目形状。
 *
 * 取最小结构而不是 `PluginPackageView`：管理面的条目视图（`PluginAdminPackageView`，多一个 `hidden`）也要用
 * 同一个函数，而它与浏览面在展示这件事上的字段完全一致。写成最小形状而不是让管理面视图去 extends 浏览面视图，
 * 是为了让两条面的类型各自演进——管理面多一列可见性时，不该顺带把浏览面的类型也改一遍。
 */
type DisplayablePackage = Pick<PluginPackageView, "packageName" | "metadata">;

/** 检索匹配需要的字段：用户记得住哪一个都能搜到。 */
type SearchablePackage = DisplayablePackage & Pick<PluginPackageView, "latestVersion">;

/** 展示名：快照的 `displayName` 优先，缺失回退包名（快照坏损时视图的 `metadata` 为 null）。 */
export function getPackageDisplayName(view: DisplayablePackage): string {
  const displayName = view.metadata?.displayName;
  return displayName && displayName.length > 0 ? displayName : view.packageName;
}

/** 一句话说明：`summary` 优先，回退 `description`；都没有时返回 null（调用方给「暂无说明」）。 */
export function getPackageSummary(view: DisplayablePackage): string | null {
  const text = view.metadata?.summary ?? view.metadata?.description ?? null;
  return text && text.length > 0 ? text : null;
}

/** 条目是否来自「专家团队」：快照声明了 agent 成员。 */
export function hasAgentMembers(view: DisplayablePackage): boolean {
  return (view.metadata?.agents.length ?? 0) > 0;
}

/** 条目是否来自「连接器」：快照声明了 MCP server 成员。 */
export function hasServerMembers(view: DisplayablePackage): boolean {
  return (view.metadata?.servers.length ?? 0) > 0;
}

/**
 * 关键词匹配：包名、展示名、当前版本号、说明与关键词任一命中即算。
 *
 * 单独一个函数而不是写在 `filterPackages` 里：管理面的检索框用同一份匹配面。两处各写一份的后果是「同一个
 * 包，管理台搜得到、控制台搜不到」——而这类漂移在界面上只表现为「用户以为市场里没有这个包」。
 */
export function matchesPackageKeyword(view: SearchablePackage, query: string): boolean {
  const keyword = query.trim().toLowerCase();
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
}

/** 各范围命中的条数，供筛选条上的计数徽标使用（与 `filterPackages` 同因取最小结构形状）。 */
export function countScopes<T extends SearchablePackage>(packages: readonly T[]): Record<PluginCatalogScope, number> {
  return {
    all: packages.length,
    teams: packages.filter(hasAgentMembers).length,
    connectors: packages.filter(hasServerMembers).length,
  };
}

/**
 * 目录过滤：关键词 + 范围（合取）。
 *
 * 在**前端**过滤是后端的有意设计（决策 D7：全量返回，不做服务端分页与检索）。
 *
 * 泛型收 `T` 而不是固定 `PluginPackageView`：管理面的条目视图多一个 `hidden`，让它丢掉多出来的字段
 * （或反过来按 `as` 断言）都会把「筛选结果还是原来那个类型」这件事变成口头约定。范围判定因此只有一份，
 * 两端不会漂移成「同一个包，控制台搜得到、管理台搜不到」。
 */
export function filterPackages<T extends SearchablePackage>(
  packages: readonly T[],
  query: string,
  scope: PluginCatalogScope,
): T[] {
  return packages.filter((view) => {
    if (scope === "teams" && !hasAgentMembers(view)) return false;
    if (scope === "connectors" && !hasServerMembers(view)) return false;
    return matchesPackageKeyword(view, query);
  });
}

/**
 * 选中项的**有效值**：在**已过滤**的结果里按 slug 命中，未命中（含未选中、选中项被过滤掉）回退到第一条。
 *
 * 入参是过滤结果而不是 `(packages, query, scope)`：调用方本来就要一份过滤结果去渲染目录，让它再解析一次
 * 只会多算一遍，而两处各推一次正是「左边高亮 A、右边显示 B 的详情」的来源。详情请求的定位符与目录高亮因此
 * 必然取自同一次解析。
 */
export function resolveSelectedPackage<T extends Pick<PluginPackageView, "slug">>(
  filtered: readonly T[],
  slug: string | null,
): T | null {
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
