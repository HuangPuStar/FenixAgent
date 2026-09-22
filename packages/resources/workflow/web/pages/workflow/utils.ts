import { ApiError } from "@fenix/web-runtime/api/request";
import type { DAGEvent } from "../../api/workflow-engine";

/**
 * 判断工作流页面加载失败是否属于「无权限」。
 *
 * 判据是错误**码**而不是 HTTP 状态码：`@fenix/web-runtime/api/request` 把无业务错误码的 401/403 一并
 * 归一为 `UNAUTHORIZED`。401 需要重新登录、403 是永久拒绝，两者都不会因为再点一次重试而改变，所以
 * 无权限分支单独渲染且**不给**重试按钮，避免把用户引向无意义的重复请求（与同批资源包
 * `packages/resources/mcp` 的 `isUnauthorizedError` 同一口径）。
 *
 * 放在这里而不是各页面内部：列表页与版本页都要做同一判定，重复两份会在补第三个页面时漂移；
 * 出现第三个消费方或需要按状态码细分时再上移到公共模块。
 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "UNAUTHORIZED";
}

export function dedupEvents(events: DAGEvent[]): DAGEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.event_id)) return false;
    seen.add(e.event_id);
    return true;
  });
}

export const DAG_STATUS_CFG: Record<string, { color: string; bg: string; labelKey: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", labelKey: "editor.dag_status_pending" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", labelKey: "editor.dag_status_running" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb", labelKey: "editor.dag_status_suspended" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4", labelKey: "editor.dag_status_success" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", labelKey: "editor.dag_status_failed" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", labelKey: "editor.dag_status_cancelled" },
  ERROR: { color: "#ef4444", bg: "#fef2f2", labelKey: "editor.dag_status_error" },
};

/**
 * 相对时间文案的 key 族：`runs.*`（运行列表/运行记录）与 `list.*`、`versions.*` 在 zh/en 里逐字相同，
 * 但**不合并为一族**——key 是翻译资源的引用，换族等于替三个页面重指文案，
 * 超出「收敛重复实现」的范围，因此由调用点显式声明自己读哪族。
 */
export type RelativeTimeScope = "runs" | "list" | "versions";

const RELATIVE_TIME_KEYS: Record<RelativeTimeScope, { now: string; minutes: string; hours: string; days: string }> = {
  runs: {
    now: "runs.relative_now",
    minutes: "runs.relative_minutes",
    hours: "runs.relative_hours",
    days: "runs.relative_days",
  },
  list: {
    now: "list.relative_now",
    minutes: "list.relative_minutes",
    hours: "list.relative_hours",
    days: "list.relative_days",
  },
  versions: {
    now: "versions.relative_now",
    minutes: "versions.relative_minutes",
    hours: "versions.relative_hours",
    days: "versions.relative_days",
  },
};

/**
 * 相对时间：按时间差取分钟 / 小时 / 天粒度，超过一周回退为日期字符串。
 *
 * 这里是唯一实现（列表页与版本页原先各有一份本地副本，已删除）。两份副本的取整写错了：
 * 小时档都是 `Math.floor(diff / 86400)`（恒为 0，显示「0 小时前 / 0 天前」），
 * 版本页还把小时档的 key 也写成了 `*_days`，列表页则缺「天」档（1~7 天显示成日期）。
 * 副本删除即修正，行为差异见本次改动报告。
 */
export function relativeTime(
  t: (key: string, opts?: Record<string, unknown>) => string,
  iso?: string | null,
  scope: RelativeTimeScope = "runs",
): string {
  if (!iso) return "--";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  // 未来时间戳（diff < 0）与「刚刚」同义，由下面第一个分支一并覆盖
  if (diff < 60) return t(RELATIVE_TIME_KEYS[scope].now);
  if (diff < 3600) return t(RELATIVE_TIME_KEYS[scope].minutes, { count: Math.floor(diff / 60) });
  if (diff < 86400) return t(RELATIVE_TIME_KEYS[scope].hours, { count: Math.floor(diff / 3600) });
  if (diff < 604800) return t(RELATIVE_TIME_KEYS[scope].days, { count: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString();
}

export function formatEventType(t: (key: string) => string, type: string): string {
  const map: Record<string, string> = {
    "dag.started": t("editor.dag_started"),
    "dag.completed": t("editor.dag_completed"),
    "dag.cancelled": t("editor.dag_cancelled"),
    "node.started": t("editor.node_started"),
    "node.completed": t("editor.node_completed"),
    "node.failed": t("editor.node_failed"),
    "node.cancelled": t("editor.node_cancelled"),
    "node.retrying": t("editor.node_retrying"),
    "node.skipped": t("editor.node_skipped"),
    "sub_workflow.started": t("editor.sub_workflow_started"),
    "sub_workflow.completed": t("editor.sub_workflow_completed"),
    "loop.iteration_started": t("editor.loop_iteration_started"),
    "loop.iteration_completed": t("editor.loop_iteration_completed"),
    "audit.requested": t("editor.audit_requested"),
    "audit.approved": t("editor.audit_approved"),
  };
  return map[type] ?? type;
}

export function formatMeta(
  t: (key: string, opts?: Record<string, unknown>) => string,
  type: string,
  meta: Record<string, unknown>,
): string {
  if (type === "node.completed") {
    const parts: string[] = [];
    if (meta.exit_code != null) parts.push(`exit=${meta.exit_code}`);
    if (meta.output_size != null) parts.push(`${meta.output_size}B`);
    if (meta.latency_ms != null) parts.push(`${Math.round(Number(meta.latency_ms))}ms`);
    return parts.join(" · ");
  }
  if (type === "node.failed") return String(meta.error ?? "");
  if (type === "node.retrying") return t("editor.retry_meta", { attempt: meta.attempt, delay: meta.next_delay_ms });
  if (type === "node.started") {
    if (meta.pid) return `pid=${meta.pid}`;
    return "";
  }
  if (type === "dag.completed") {
    if (meta.duration_ms != null) return `${Math.round(Number(meta.duration_ms) / 1000)}s`;
    return "";
  }
  return "";
}
