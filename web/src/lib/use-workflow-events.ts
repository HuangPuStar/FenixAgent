import { pushContext, removeContext } from "./context-queue";

interface DAGSnapshot {
  dag_status: string;
  node_states: Record<string, { status: string; exit_code?: number }>;
}

const errors: string[] = [];
let runStatusSummary: string | null = null;

function syncToContextQueue(): void {
  if (errors.length === 0 && runStatusSummary === null) {
    removeContext("workflow-events");
    return;
  }
  const lines: string[] = ["[工作流事件]"];
  if (runStatusSummary) {
    lines.push(`运行状态: ${runStatusSummary}`);
  }
  for (const err of errors) {
    lines.push(err);
  }
  pushContext("workflow-events", lines.join("\n"));
}

export function pushWorkflowError(source: string, message: string): void {
  errors.push(`错误 (${source}): ${message}`);
  syncToContextQueue();
}

export function pushWorkflowRunStatus(summary: string | null): void {
  runStatusSummary = summary;
  syncToContextQueue();
}

export function clearWorkflowEvents(): void {
  errors.length = 0;
  runStatusSummary = null;
  removeContext("workflow-events");
}

export function buildRunSummary(snap: DAGSnapshot): string | null {
  const { dag_status, node_states } = snap;
  const entries = Object.entries(node_states);
  const total = entries.length;

  if (total === 0 && dag_status === "PENDING") return null;

  const completed = entries.filter(([, s]) => s.status === "COMPLETED").length;
  const failed = entries.filter(([, s]) => s.status === "FAILED").length;
  const failedNodes = entries.filter(([, s]) => s.status === "FAILED").map(([id]) => id);

  if (dag_status === "SUCCESS") {
    return `运行成功 (${completed}/${total} 完成)`;
  }

  if (dag_status === "FAILED" || dag_status === "ERROR") {
    const parts = [`运行失败 (${completed}/${total} 完成, ${failed} 失败`];
    if (failedNodes.length > 0) parts.push(`: ${failedNodes.join(", ")}`);
    parts.push(")");
    return parts.join("");
  }

  if (dag_status === "CANCELLED") {
    return `已取消 (${completed}/${total} 完成)`;
  }

  if (dag_status === "SUSPENDED") {
    const suspendedNodes = entries.filter(([, s]) => s.status === "RUNNING").map(([id]) => id);
    return `等待审批 (${completed}/${total} 完成, 等待: ${suspendedNodes.join(", ") || "无"})`;
  }

  return `运行中 (${completed}/${total} 完成)`;
}

export function useWorkflowEvents() {
  return { pushWorkflowError, pushWorkflowRunStatus, clearWorkflowEvents };
}
