import { pushContext, removeContext } from "./context-queue";

interface DAGSnapshot {
  dag_status: string;
  node_states: Record<string, { status: string; exit_code?: number }>;
}

/**
 * 每个 workflowId 独立的事件状态。
 *
 * 历史问题：早期实现把 errors/runStatusSummary 放在模块级变量，多个 WorkflowEditor
 * 实例（多 tab / 多组件）会共享状态，导致 A workflow 的错误污染 B 的 context queue。
 * 现在按 workflowId 分作用域，未指定 workflowId 时落到 "_default" 桶（仅用于无 workflowId
 * 的临时场景，如新建未保存的 workflow）。
 */
interface WorkflowEventState {
  errors: string[];
  runStatusSummary: string | null;
}

const states = new Map<string, WorkflowEventState>();

function getState(workflowId: string | null | undefined): WorkflowEventState {
  const key = workflowId || "_default";
  let s = states.get(key);
  if (!s) {
    s = { errors: [], runStatusSummary: null };
    states.set(key, s);
  }
  return s;
}

function contextKey(workflowId: string | null | undefined): string {
  return `workflow-events:${workflowId || "_default"}`;
}

function syncToContextQueue(workflowId: string | null | undefined): void {
  const state = getState(workflowId);
  const key = contextKey(workflowId);
  if (state.errors.length === 0 && state.runStatusSummary === null) {
    removeContext(key);
    return;
  }
  const lines: string[] = ["[Workflow Event]"];
  if (state.runStatusSummary) {
    lines.push(`Run Status: ${state.runStatusSummary}`);
  }
  for (const err of state.errors) {
    lines.push(err);
  }
  pushContext(key, lines.join("\n"));
}

/** 推入错误到指定 workflowId 的状态桶 */
export function pushWorkflowError(workflowId: string | null | undefined, source: string, message: string): void {
  const state = getState(workflowId);
  state.errors.push(`Error (${source}): ${message}`);
  syncToContextQueue(workflowId);
}

/** 推入运行状态摘要到指定 workflowId 的状态桶 */
export function pushWorkflowRunStatus(workflowId: string | null | undefined, summary: string | null): void {
  const state = getState(workflowId);
  state.runStatusSummary = summary;
  syncToContextQueue(workflowId);
}

/** 清除指定 workflowId 的所有事件状态 */
export function clearWorkflowEvents(workflowId: string | null | undefined): void {
  const state = getState(workflowId);
  state.errors.length = 0;
  state.runStatusSummary = null;
  removeContext(contextKey(workflowId));
}

/** 移除指定 workflowId 的状态桶（workflow 切换/卸载时调用，防止内存泄漏） */
export function disposeWorkflowEvents(workflowId: string | null | undefined): void {
  const key = workflowId || "_default";
  states.delete(key);
  removeContext(contextKey(workflowId));
}

export function buildRunSummary(snap: DAGSnapshot): string | null {
  const { dag_status, node_states } = snap;
  const entries = Object.entries(node_states ?? {});
  const total = entries.length;

  if (total === 0 && dag_status === "PENDING") return null;

  const completed = entries.filter(([, s]) => s.status === "COMPLETED").length;
  const failed = entries.filter(([, s]) => s.status === "FAILED").length;
  const failedNodes = entries.filter(([, s]) => s.status === "FAILED").map(([id]) => id);

  if (dag_status === "SUCCESS") {
    return `Run Succeeded (${completed}/${total} completed)`;
  }

  if (dag_status === "FAILED" || dag_status === "ERROR") {
    const parts = [`Run Failed (${completed}/${total} completed, ${failed} failed`];
    if (failedNodes.length > 0) parts.push(`: ${failedNodes.join(", ")}`);
    parts.push(")");
    return parts.join("");
  }

  if (dag_status === "CANCELLED") {
    return `Cancelled (${completed}/${total} completed)`;
  }

  if (dag_status === "SUSPENDED") {
    const suspendedNodes = entries.filter(([, s]) => s.status === "RUNNING").map(([id]) => id);
    return `Awaiting Approval (${completed}/${total} completed, waiting: ${suspendedNodes.join(", ") || "none"})`;
  }

  return `Running (${completed}/${total} completed)`;
}

/** @deprecated 旧的无 workflowId 签名 — 仅向后兼容，新代码必须传 workflowId */
export function useWorkflowEvents() {
  return {
    pushWorkflowError: (source: string, message: string) => pushWorkflowError(null, source, message),
    pushWorkflowRunStatus: (summary: string | null) => pushWorkflowRunStatus(null, summary),
    clearWorkflowEvents: () => clearWorkflowEvents(null),
  };
}
