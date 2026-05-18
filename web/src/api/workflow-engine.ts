/**
 * Workflow Engine API Client
 *
 * 对接后端 POST /web/workflow-engine，通过 action 字段分发。
 * 需要登录态（cookie-based session）。
 */

// ── 状态枚举 ──

export type DAGStatus =
  | "PENDING"
  | "RUNNING"
  | "SUSPENDED"
  | "FAILED"
  | "CANCELLED"
  | "ERROR"
  | "SUCCESS";

export type NodeStatus =
  | "PENDING"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";

export type NodeType =
  | "shell"
  | "agent"
  | "api"
  | "audit"
  | "workflow"
  | "loop";

export type EventType =
  | "dag.started"
  | "dag.completed"
  | "dag.cancelled"
  | "node.started"
  | "node.completed"
  | "node.failed"
  | "node.cancelled"
  | "node.retrying"
  | "node.skipped"
  | "sub_workflow.started"
  | "sub_workflow.completed"
  | "loop.iteration_started"
  | "loop.iteration_completed"
  | "audit.requested"
  | "audit.approved";

// ── 核心数据结构 ──

export interface NodeOutput {
  stdout: string;
  json?: unknown;
  exit_code: number;
  size?: number;
  ref?: string;
}

export interface DAGEvent {
  event_id: string;
  run_id: string;
  node_id?: string;
  timestamp: string;
  type: EventType;
  node_type?: NodeType;
  metadata?: Record<string, unknown>;
}

export interface DAGSnapshot {
  snapshot_id: string;
  run_id: string;
  last_event_id: string;
  timestamp: string;
  node_states: Record<string, { status: NodeStatus; exit_code?: number }>;
  dag_status: DAGStatus;
}

export interface RunSummary {
  run_id: string;
  project_id?: string;
  workflow_name: string;
  status: DAGStatus;
  started_at: string;
  completed_at?: string;
  node_summary: {
    total: number;
    completed: number;
    failed: number;
    running: number;
  };
}

export interface DAGRunResult {
  runId: string;
  status: DAGStatus;
  summary: RunSummary;
}

export interface PendingApproval {
  runId: string;
  nodeId: string;
  approvalToken: string;
  expiresAt: string;
  displayData?: unknown;
}

export interface DryRunResult {
  valid: boolean;
  issues: Array<{ type: "error" | "warning"; message: string; field?: string }>;
  executionPlan: {
    topologicalOrder: string[];
    parallelGroups: string[][];
  };
}

// ── API Client ──

async function wfFetch<T>(
  action: string,
  extra?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("/web/workflow-engine", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });

  const json = await res.json();

  if (!res.ok) {
    const errInfo = json.error ?? { message: res.statusText };
    throw new Error(errInfo.message ?? errInfo.type ?? `请求失败 (${res.status})`);
  }

  return json.success && json.data !== undefined ? (json.data as T) : (json as T);
}

export const workflowEngineApi = {
  /** 执行工作流（同步，会阻塞到完成或 SUSPENDED） */
  async run(yaml: string, params?: Record<string, unknown>): Promise<DAGRunResult> {
    return wfFetch<DAGRunResult>("run", { yaml, params });
  },

  /** 校验 + 执行计划（不执行） */
  async dryRun(yaml: string): Promise<DryRunResult> {
    return wfFetch<DryRunResult>("dryRun", { yaml });
  },

  /** 取消运行 */
  async cancel(runId: string): Promise<void> {
    await wfFetch("cancel", { runId });
  },

  /** 获取运行状态快照 */
  async getRunStatus(runId: string): Promise<DAGSnapshot | null> {
    return wfFetch<DAGSnapshot | null>("getRunStatus", { runId });
  },

  /** 获取事件流 */
  async getEvents(runId: string, nodeId?: string): Promise<DAGEvent[]> {
    return wfFetch<DAGEvent[]>("getEvents", { runId, nodeId });
  },

  /** 获取节点输出 */
  async getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
    return wfFetch<NodeOutput | null>("getOutput", { runId, nodeId });
  },

  /** 获取待审批列表 */
  async getPendingApprovals(runId: string): Promise<PendingApproval[]> {
    return wfFetch<PendingApproval[]>("getPendingApprovals", { runId });
  },

  /** 审批通过 */
  async approve(
    runId: string,
    nodeId: string,
    token: string,
    data?: unknown,
  ): Promise<void> {
    await wfFetch("approve", { runId, nodeId, token, data });
  },

  /** 列出运行记录 */
  async listRuns(): Promise<RunSummary[]> {
    return wfFetch<RunSummary[]>("listRuns");
  },

  /** 崩溃恢复 */
  async recover(runId: string, yaml: string): Promise<DAGRunResult> {
    return wfFetch<DAGRunResult>("recover", { runId, yaml });
  },
};
