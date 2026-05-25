/** DAG 运行状态 */
export type DAGStatus = "PENDING" | "RUNNING" | "SUSPENDED" | "FAILED" | "CANCELLED" | "ERROR" | "SUCCESS";

/** 节点状态 */
export type NodeStatus = "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" | "SKIPPED";

/** 统一节点输出格式 */
export interface NodeOutput {
  stdout: string;
  json?: unknown;
  exit_code: number;
  size?: number;
  ref?: string;
}

/** 全部 15 种事件类型 */
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

/** DAG 事件 */
export interface DAGEvent {
  event_id: string;
  run_id: string;
  project_id?: string;
  node_id?: string;
  timestamp: string;
  type: EventType;
  node_type?: import("./dag").NodeType;
  metadata?: Record<string, unknown>;
}

/** DAG 快照 */
export interface DAGSnapshot {
  snapshot_id: string;
  run_id: string;
  last_event_id: string;
  timestamp: string;
  node_states: Record<string, { status: NodeStatus; exit_code?: number }>;
  dag_status: DAGStatus;
}

/** 运行摘要 */
export interface RunSummary {
  run_id: string;
  project_id?: string;
  workflow_id?: string;
  workflow_name: string;
  status: DAGStatus;
  started_at: string;
  completed_at?: string;
  node_summary: { total: number; completed: number; failed: number; running: number };
}
