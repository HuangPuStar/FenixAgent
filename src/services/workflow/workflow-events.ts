/**
 * Per-workflow EventBus 注册表。
 *
 * 供路由层发布 SSE 事件，供 SSE 端点订阅推送。
 * 复用 transport/event-bus 的 EventBus 实例管理。
 */

import { nanoid } from "nanoid";
import { type EventBus, getEventBus, removeEventBus } from "../../transport/event-bus";

/** Workflow SSE 事件类型 */
export type WorkflowEventType =
  | "workflow.draft_updated"
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
  return getEventBus(workflowBusKey(workflowId));
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
  removeEventBus(workflowBusKey(workflowId));
}
