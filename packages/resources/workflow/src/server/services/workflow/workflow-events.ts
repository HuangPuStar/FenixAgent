/**
 * Per-workflow EventBus 注册表。
 *
 * 供路由层发布 SSE 事件，供 SSE 端点订阅推送。
 * 复用 transport/event-bus 的 EventBus 实例管理。
 */

// EventBus 归运行 port 的数据面（1.4 W6b）：总线的创建/释放是有副作用的能力，不是纯观测，
// 故在 `session` 而不是 `observe`。本包不再直取宿主的 transport/event-bus 模块。
import { type EventBus, getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import { nanoid } from "nanoid";

/** Workflow SSE 事件类型 */
export type WorkflowEventType =
  | "workflow.draft_updated"
  | "workflow.created"
  | "workflow.deleted"
  | "workflow.meta_updated"
  | "workflow.draft_restored"
  | "workflow.run_started"
  | "workflow.run_status_changed"
  | "workflow.run_cancelled"
  | "workflow.dry_run_completed"
  | "workflow.version_published";

/** Workflow SSE 事件载荷 */
export interface WorkflowEventPayload {
  type: WorkflowEventType;
  workflowId: string;
  [key: string]: unknown;
}

/** 生成 workflow EventBus 的 key */
function workflowBusKey(workflowId: string): string {
  return `wf:${workflowId}`;
}

/** 获取指定 workflow 的 EventBus */
export function getWorkflowEventBus(workflowId: string): EventBus {
  return getBoundAgentRuntime().session.getEventBus(workflowBusKey(workflowId));
}

/** 发布一个 workflow SSE 事件 */
export function publishWorkflowEvent(
  workflowId: string,
  type: WorkflowEventType,
  extra: Omit<WorkflowEventPayload, "type" | "workflowId"> = {},
): void {
  const bus = getWorkflowEventBus(workflowId);
  bus.publish({
    id: `wf_evt_${nanoid(12)}`,
    sessionId: workflowBusKey(workflowId),
    type,
    payload: { type, workflowId, ...extra },
    direction: "outbound",
  });
}

/** 清理 workflow EventBus（防止内存泄漏） */
export function removeWorkflowEventBus(workflowId: string): void {
  getBoundAgentRuntime().session.removeEventBus(workflowBusKey(workflowId));
}
