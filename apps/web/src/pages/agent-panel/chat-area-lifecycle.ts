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
