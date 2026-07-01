/**
 * Workflow Engine API Client
 *
 * 对接后端 POST /web/workflow-engine，通过 action 字段分发。
 * 需要登录态（cookie-based session）。
 */

// ── 状态枚举 ──

export type DAGStatus = "PENDING" | "RUNNING" | "SUSPENDED" | "FAILED" | "CANCELLED" | "ERROR" | "SUCCESS";

export type NodeStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SKIPPED";

export type NodeType = "shell" | "python" | "agent" | "api" | "audit" | "workflow" | "loop" | "transform";

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
  project_id?: string | null;
  node_id?: string | null;
  timestamp: string;
  type: EventType;
  node_type?: NodeType | null;
  metadata?: Record<string, unknown> | null;
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

/** engine.run 启动响应（异步启动，立即返回 runId）
 *  注意：与 DAGRunResult（同步阻塞模式完整结果）不同 — 当前后端 run action 返回 WorkflowRunStartedSchema。
 *  完整的 summary/status 通过后续 getRunStatus 轮询 / SSE 事件获得。 */
export interface RunStarted {
  runId: string;
  status: "RUNNING";
}

/** DAG 最终运行结果（用于 recover / rerunFrom 等同步返回完整 summary 的接口） */
export interface DAGRunResult {
  runId: string;
  status: DAGStatus;
  summary: RunSummary;
  spawnedEnvIds?: string[];
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
  issues: Array<{ type: "error" | "warning"; code: string; message: string; nodeId?: string }>;
  executionPlan: {
    topologicalOrder: string[];
    parallelGroups: string[][];
  };
}

// ── API Client ──

import { request } from "./request";

export const workflowEngineApi = {
  /** 执行工作流（异步启动，立即返回 runId；完整状态通过 getRunStatus / SSE 获取） */
  run: (yaml: string, params?: Record<string, unknown>, workflowId?: string) =>
    request<RunStarted>("/web/workflow-engine", {
      method: "POST",
      body: { action: "run", yaml, params, workflowId },
    }),

  /** 校验 + 执行计划（不执行） */
  dryRun: (yaml: string) =>
    request<DryRunResult>("/web/workflow-engine", {
      method: "POST",
      body: { action: "dryRun", yaml },
    }),

  /** 取消运行 */
  cancel: (runId: string) =>
    request<void>("/web/workflow-engine", { method: "POST", body: { action: "cancel", runId } }),

  /** 审批节点通过 */
  approve: (runId: string, nodeId: string, token: string, data?: unknown) =>
    request<void>("/web/workflow-engine", {
      method: "POST",
      body: { action: "approve", runId, nodeId, token, data },
    }),

  /** 获取运行状态快照 */
  getRunStatus: (runId: string) =>
    request<DAGSnapshot | null>("/web/workflow-engine", {
      method: "POST",
      body: { action: "getRunStatus", runId },
    }),

  /** 获取事件流（可选按 nodeId 过滤） */
  getEvents: (runId: string, _nodeId?: string) =>
    request<DAGEvent[]>("/web/workflow-engine", {
      method: "POST",
      body: { action: "getEvents", runId, nodeId: _nodeId },
    }),

  /** 获取节点输出 */
  getOutput: (runId: string, nodeId: string) =>
    request<NodeOutput | null>("/web/workflow-engine", {
      method: "POST",
      body: { action: "getOutput", runId, nodeId },
    }),

  /** 获取待审批列表 */
  getPendingApprovals: (runId: string) =>
    request<PendingApproval[]>("/web/workflow-engine", {
      method: "POST",
      body: { action: "getPendingApprovals", runId },
    }),

  /** 崩溃恢复：从快照恢复运行 */
  recover: (runId: string, yaml: string) =>
    request<DAGRunResult>("/web/workflow-engine", {
      method: "POST",
      body: { action: "recover", runId, yaml },
    }),

  /** 从指定节点重新运行（保留上游输出，目标及下游重新执行） */
  rerunFrom: (runId: string, yaml: string, fromNodeId: string, workflowId?: string) =>
    request<DAGRunResult>("/web/workflow-engine", {
      method: "POST",
      body: { action: "rerunFrom", runId, yaml, fromNodeId, workflowId },
    }),

  /** 分页查询运行记录，支持状态过滤和名称搜索 */
  listRuns: (params?: { page?: number; pageSize?: number; status?: string; q?: string }) =>
    request<{ items: RunSummary[]; total: number; page: number; pageSize: number }>("/web/workflow-runs", {
      method: "GET",
      query: params as Record<string, string | number | undefined>,
    }),
};
