/**
 * 聊天会话槽位的生命周期策略：删除状态的判定与驱逐。
 *
 * 归属（台账 `ce-standards-todo.md` D1）：本模块判的是「Environment 删除后哪些聊天槽位必须失效」，
 * 属 chat 域策略，随聊天容器簇从 `apps/web/src/pages/agent-panel/` 归位本包。逻辑逐字未改。
 *
 * 两个函数都是纯函数（零 import、无副作用），由宿主壳 `apps/web/src/pages/agent-panel/ChatArea.tsx`
 * 经窄子路径 `@fenix/agent-runtime/web/agent-panel/chat-area-lifecycle` 消费：槽位的挂载与渲染归宿主壳，
 * 「哪个槽位已失效」的判据归 chat 域，两者分居而不各自复制一份判据。
 */

/** ChatArea keep-alive 缓存中单个会话面板的稳定标识。 */
export interface SessionSlot {
  agentId: string;
  sessionId: string | null;
}

/** 删除状态命中当前 Environment 时禁用所有依赖其 ID 的请求和渲染。 */
export function resolveActiveChatEnvironmentId(
  agentId: string | null,
  deletedEnvironmentIds?: ReadonlySet<string>,
): string | null {
  return agentId && !deletedEnvironmentIds?.has(agentId) ? agentId : null;
}

/** 驱逐已删除 Environment 的 keep-alive 会话，同时保留其他会话的引用稳定性。 */
export function evictDeletedEnvironmentSlots<T extends SessionSlot>(
  slots: Record<string, T>,
  deletedEnvironmentIds: ReadonlySet<string>,
): Record<string, T> {
  const next = Object.fromEntries(
    Object.entries(slots).filter(([, slot]) => !deletedEnvironmentIds.has(slot.agentId)),
  ) as Record<string, T>;
  return Object.keys(next).length === Object.keys(slots).length ? slots : next;
}
