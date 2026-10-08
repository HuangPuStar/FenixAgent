// pages/list/workflow-list-model.ts
// 列表页的**纯派生**（§3.5 三层分工的模型层）：视图状态判定、状态列语义、删除结果语义与更新时间取样。
//
// 为什么这些判断不放组件里：它们决定「界面上出现哪一屏」——把「上游没绑定」误判成「没有数据」是列表页
// 最容易通过的静默缺陷（空表看起来像合法结果），而这类判定只有在纯函数层才能被用例逐条枚举。组件只负责
// 把结论映射成 JSX。
//
// 返回 i18n **键**而不是文案：键是有限枚举，可被包内 i18n 用例逐个查字典（动态拼键在运行时才暴露缺项）；
// 文案取值属视图层（§9.1）。

import type { StatusTone } from "@fenix/ui-components/config/StatusBadge";
import { ApiError } from "@fenix/web-runtime/api/request";
import type { WorkflowV2OrgAppBinding } from "../../api/canvas-session";
import type { WorkflowV2DeleteResult, WorkflowV2WorkflowItem } from "../../api/workflows";

/** 列表分页大小；写死一档，页脚不提供页长切换（`24 条/页` 这类选择是本地偏好，需要持久化才有意义）。 */
export const LIST_PAGE_SIZE = 20;

/**
 * 本页的 i18n 键族前缀，同时是传给共享 `Pagination` 的 `translationPrefix`。
 *
 * 那个组件内部用模板字符串拼 `pagination_total` 等键（静态扫描看不到），所以这里把前缀**导出**供包内
 * i18n 用例与页面引用同一取值：改前缀只有这一个地方，用例不会与页面漂移。
 */
export const LIST_I18N_SCOPE = "list";

/** 载入失败的分类；无权限与普通失败**共用一套骨架但行为不同**：前者不给重试（401/403 重试只会重复被拒）。 */
export function isUnauthorizedError(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  // `request()` 把无业务码的 401/403 归一为 UNAUTHORIZED；服务端自带的码是 UNAUTHENTICATED /
  // FORBIDDEN（`src/server/routes/web/*` 的失败信封）。三者都不会因为再点一次重试而改变。
  return error.code === "UNAUTHORIZED" || error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN";
}

/**
 * 列表页的视图状态。
 *
 * `blocked` 与 `empty` 刻意分开：未绑定租户 App 时列表**可能确实有记录**（绑定被换掉之前建的），但那些
 * 工作流在上游没有归属、打开必然失败，因此给引导而不是渲染一张点不动的表。
 */
export type WorkflowListViewState =
  | { readonly kind: "loading" }
  /** 会话失效或被拒：给说明，不给重试。 */
  | { readonly kind: "unauthorized" }
  /** 网络 / 服务端失败：给重试。 */
  | { readonly kind: "failed" }
  /** 上游未就绪（未绑定 / 降级）：给引导与重试，重新探测即可自愈。 */
  | { readonly kind: "blocked"; readonly reason: "unbound" | "degraded" }
  | { readonly kind: "empty" }
  | { readonly kind: "ready"; readonly items: readonly WorkflowV2WorkflowItem[]; readonly total: number };

/** 判定输入：列表与租户绑定两个请求的合并快照（两者同批取，任一失败都是「这一屏没准备好」）。 */
export interface WorkflowListSnapshot {
  readonly loading: boolean;
  /** `useRequest` 的错误；实际类型是 `unwrap()` 抛出的 `ApiError`。 */
  readonly error: unknown;
  /** 租户 App 绑定；未取到时为 null（**不得**当成 unbound，两者的引导不一样）。 */
  readonly binding: WorkflowV2OrgAppBinding | null;
  readonly items: readonly WorkflowV2WorkflowItem[];
  readonly total: number;
}

/** 分支顺序即优先级：进行中 > 失败 > 上游未就绪 > 空 > 就绪。 */
export function resolveListViewState(snapshot: WorkflowListSnapshot): WorkflowListViewState {
  if (snapshot.loading) return { kind: "loading" };
  if (snapshot.error) return { kind: isUnauthorizedError(snapshot.error) ? "unauthorized" : "failed" };
  if (!snapshot.binding) return { kind: "failed" };
  if (snapshot.binding.status !== "active") {
    return { kind: "blocked", reason: snapshot.binding.status === "unbound" ? "unbound" : "degraded" };
  }
  if (snapshot.items.length === 0) return { kind: "empty" };
  return { kind: "ready", items: snapshot.items, total: snapshot.total };
}

/** 状态列的呈现描述：色调 + 文案键 + 已发布版本号（未发布为 null）。 */
export interface WorkflowStatusDescriptor {
  readonly tone: StatusTone;
  readonly labelKey: string;
  readonly version: string | null;
}

/**
 * 状态列语义：以「能不能用」而不是 `syncState` 的字段名说话。
 *
 * - `pending_delete` 优先：删除进行中的记录即使有已发布版本也不再是可编辑对象；
 * - 有 `publishedVersion` → 已发布（附版本号），否则未发布（草稿）。
 *
 * 色调只给语义，配色留在 `StatusBadge`（§4.1）。
 */
export function describeWorkflowStatus(item: WorkflowV2WorkflowItem): WorkflowStatusDescriptor {
  if (item.syncState === "pending_delete") {
    return { tone: "warning", labelKey: "list.status.pending_delete", version: item.publishedVersion };
  }
  if (item.publishedVersion !== null) {
    return { tone: "success", labelKey: "list.status.published", version: item.publishedVersion };
  }
  return { tone: "neutral", labelKey: "list.status.unpublished", version: null };
}

/** 删除结果：`deleted` 为真才是删掉了；否则是上游按策略拒绝，`strategy` 说明原因。 */
export type WorkflowDeleteOutcome =
  | { readonly kind: "deleted" }
  | { readonly kind: "refused"; readonly strategy: number | null };

export function resolveDeleteOutcome(result: WorkflowV2DeleteResult): WorkflowDeleteOutcome {
  return result.deleted ? { kind: "deleted" } : { kind: "refused", strategy: result.strategy };
}

/**
 * 策略值 → 拒绝原因键。取值来自服务端 `delete_strategy`：0=可删、1=首发审核中、2=需先下架
 * （`src/server/routes/web/workflows.ts` 的 `detail.description`）。
 *
 * 未登记的值（含 null：策略探不到但 `force` 才会走到删除，正常路径下不该出现）落在 `unknown`：宁可给
 * 「暂时不能删」也不要把原因说错。
 */
export function deleteRefusalKey(strategy: number | null): string {
  switch (strategy) {
    case 1:
      return "list.delete_refused.reviewing";
    case 2:
      return "list.delete_refused.unpublish_required";
    default:
      return "list.delete_refused.unknown";
  }
}

/**
 * 初始化工作流空间失败的「稳定错误码 → 字典键」映射（§9.3：错误文案取码，不取 message）。
 *
 * 为什么必须走码：`unwrap()` 抛出的 `ApiError.message` 是后端错误信封的原文，其中 `UPSTREAM_*` 分支
 * 带的是上游措辞、`INTERNAL_ERROR` 带的是服务端内部描述——上屏等于把不是我方写的句子当成产品文案
 * （本包比全仓门禁更严：**任何**用户可见字符串都不得来自 `err.message`）。
 *
 * 四个分支对应**用户下一步动作不同**的四类：会话失效要重新登录、平台账号不可用要等引导恢复或找管理员、
 * 上游不可达 / 拒绝稍后重试即可；其余（`INTERNAL_ERROR`、请求层归一出的 `NETWORK_ERROR` / `SERVER_ERROR`、
 * 以及后续新增的码）一律走通用文案——不认识的失败不该被翻译成一句看似精确的承诺。
 */
export function initializeErrorKey(error: unknown): string {
  const code = error instanceof ApiError ? error.code : null;
  switch (code) {
    case "UNAUTHENTICATED":
    case "UNAUTHORIZED":
    case "FORBIDDEN":
      return "list.initialize_failed_unauthorized";
    case "PLATFORM_SESSION_UNAVAILABLE":
      return "list.initialize_failed_session";
    case "UPSTREAM_UNAVAILABLE":
    case "UPSTREAM_REJECTED":
      return "list.initialize_failed_upstream";
    default:
      return "list.initialize_failed";
  }
}

/** 更新时间的呈现：相对时间（走字典、带 `count`）或超过一周后的绝对日期。 */
export type UpdatedAtView =
  | { readonly kind: "relative"; readonly key: string; readonly count: number }
  | { readonly kind: "date"; readonly iso: string };

/** 相对时间的四档键（与旧包同一命名空间下的 `list.relative_*` 同键同名，2F 换包时不产生第二套键）。 */
export const UPDATED_AT_KEYS = {
  now: "list.relative_now",
  minutes: "list.relative_minutes",
  hours: "list.relative_hours",
  days: "list.relative_days",
} as const;

/**
 * 更新时间取样（传入 `now` 而不是内部读时钟：用例要能钉住每一档的边界）。
 *
 * 未来时间戳（时钟偏差）与「刚刚」同义，由第一档一并覆盖；超过一周回退成日期串——继续放大粒度
 * （「3 周前」）对「这个工作流多久没人动过」这个判断没有增益，反而更难换算成具体日期。
 */
export function resolveUpdatedAt(iso: string, now: number): UpdatedAtView {
  const elapsedSeconds = (now - new Date(iso).getTime()) / 1000;
  if (elapsedSeconds < 60) return { kind: "relative", key: UPDATED_AT_KEYS.now, count: 0 };
  if (elapsedSeconds < 3600) {
    return { kind: "relative", key: UPDATED_AT_KEYS.minutes, count: Math.floor(elapsedSeconds / 60) };
  }
  if (elapsedSeconds < 86_400) {
    return { kind: "relative", key: UPDATED_AT_KEYS.hours, count: Math.floor(elapsedSeconds / 3600) };
  }
  if (elapsedSeconds < 604_800) {
    return { kind: "relative", key: UPDATED_AT_KEYS.days, count: Math.floor(elapsedSeconds / 86_400) };
  }
  return { kind: "date", iso };
}
