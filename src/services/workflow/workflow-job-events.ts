/**
 * Per-organization 看板事件总线。
 *
 * 供 workflow-jobs 路由发布 SSE 事件，供 SSE 端点订阅推送。
 * 复用 transport/event-bus 的 EventBus 实例管理。
 */

import { type EventBus, getEventBus, removeEventBus } from "../../transport/event-bus";

/** 看板 SSE 事件类型 */
export type JobEventType =
  | "job.created"
  | "job.started"
  | "job.suspended"
  | "job.completed"
  | "job.deleted"
  | "job.params_updated";

/** 看板 SSE 事件载荷 */
export interface JobEventPayload {
  type: JobEventType;
  jobId: string;
  [key: string]: unknown;
}

/** 生成 organization EventBus 的 key */
function orgBusKey(organizationId: string): string {
  return `kanban:${organizationId}`;
}

/** 获取指定 organization 的看板 EventBus */
export function getKanbanEventBus(organizationId: string): EventBus {
  return getEventBus(orgBusKey(organizationId));
}

/** 发布一个看板 SSE 事件 */
export function publishJobEvent(
  organizationId: string,
  type: JobEventType,
  extra: { jobId: string; [key: string]: unknown },
): void {
  const bus = getKanbanEventBus(organizationId);
  bus.publish({
    id: `job_evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    sessionId: orgBusKey(organizationId),
    type,
    payload: { type, ...extra },
    direction: "outbound",
  });
}

/** 清理看板 EventBus（防止内存泄漏） */
export function removeKanbanEventBus(organizationId: string): void {
  removeEventBus(orgBusKey(organizationId));
}
