/**
 * Workflow Engine API Client
 *
 * 对接后端 POST /web/workflow-engine，通过 action 字段分发。
 * 需要登录态（cookie-based session）。
 */

// ── 状态枚举 ──

export type DAGStatus = "PENDING" | "RUNNING" | "SUSPENDED" | "FAILED" | "CANCELLED" | "ERROR" | "SUCCESS";

export type NodeStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SKIPPED";

export type NodeType = "shell" | "agent" | "api" | "audit" | "workflow" | "loop";

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
  workflow_id?: string;
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

import { apiPost } from "./client";

export const workflowEngineApi = {
  /** 执行工作流（同步，会阻塞到完成或 SUSPENDED） */
  async run(yaml: string, params?: Record<string, unknown>, workflowId?: string): Promise<DAGRunResult> {
    return apiPost<DAGRunResult>("/web/workflow-engine", { action: "run", yaml, params, workflowId });
  },

  /** 校验 + 执行计划（不执行） */
  async dryRun(yaml: string): Promise<DryRunResult> {
    return apiPost<DryRunResult>("/web/workflow-engine", { action: "dryRun", yaml });
  },

  /** 取消运行 */
  async cancel(runId: string): Promise<void> {
    await apiPost("/web/workflow-engine", { action: "cancel", runId });
  },

  /** 获取运行状态快照 */
  async getRunStatus(runId: string): Promise<DAGSnapshot | null> {
    return apiPost<DAGSnapshot | null>("/web/workflow-engine", { action: "getRunStatus", runId });
  },

  /** 获取事件流 */
  async getEvents(runId: string, nodeId?: string): Promise<DAGEvent[]> {
    return apiPost<DAGEvent[]>("/web/workflow-engine", { action: "getEvents", runId, nodeId });
  },

  /** 获取节点输出 */
  async getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
    return apiPost<NodeOutput | null>("/web/workflow-engine", { action: "getOutput", runId, nodeId });
  },

  /** 获取待审批列表 */
  async getPendingApprovals(runId: string): Promise<PendingApproval[]> {
    return apiPost<PendingApproval[]>("/web/workflow-engine", { action: "getPendingApprovals", runId });
  },

  /** 审批通过 */
  async approve(runId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
    await apiPost("/web/workflow-engine", { action: "approve", runId, nodeId, token, data });
  },

  /** 列出运行记录 */
  async listRuns(): Promise<RunSummary[]> {
    return apiPost<RunSummary[]>("/web/workflow-engine", { action: "listRuns" });
  },

  /** 崩溃恢复 */
  async recover(runId: string, yaml: string): Promise<DAGRunResult> {
    return apiPost<DAGRunResult>("/web/workflow-engine", { action: "recover", runId, yaml });
  },

  /** 从指定节点重新运行（保留上游输出，目标及下游重新执行） */
  async rerunFrom(runId: string, yaml: string, fromNodeId: string, workflowId?: string): Promise<DAGRunResult> {
    return apiPost<DAGRunResult>("/web/workflow-engine", { action: "rerunFrom", runId, yaml, fromNodeId, workflowId });
  },
};
