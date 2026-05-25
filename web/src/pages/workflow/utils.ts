import type { DAGEvent } from "../../api/workflow-engine";

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
