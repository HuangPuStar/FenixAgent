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
  const lines: string[] = ["[Workflow Event]"];
  if (runStatusSummary) {
    lines.push(`Run Status: ${runStatusSummary}`);
  }
  for (const err of errors) {
    lines.push(err);
  }
  pushContext("workflow-events", lines.join("\n"));
}

export function pushWorkflowError(source: string, message: string): void {
  errors.push(`Error (${source}): ${message}`);
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

export function useWorkflowEvents() {
  return { pushWorkflowError, pushWorkflowRunStatus, clearWorkflowEvents };
}
