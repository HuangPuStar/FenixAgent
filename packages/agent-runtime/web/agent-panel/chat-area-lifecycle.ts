import { useEffect, useLayoutEffect, useState } from "react";

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

interface CachedSessionSlot extends SessionSlot {
  version: number;
}

interface SessionCache {
  ownerKey: string;
  slots: Record<string, CachedSessionSlot>;
}

/** 宿主按返回的稳定 key 挂载面板；切换实例只改变可见性。 */
export function useChatAreaSlots(
  agentId: string | null,
  sessionId: string | null,
  ownerKey: string,
  deletedEnvironmentIds?: ReadonlySet<string>,
) {
  const activeAgentId = resolveActiveChatEnvironmentId(agentId, deletedEnvironmentIds);
  const currentKey = activeAgentId ? JSON.stringify([activeAgentId, sessionId]) : null;
  const [cache, setCache] = useState<SessionCache>(() => ({ ownerKey, slots: {} }));

  // 身份切换当帧就隔离旧面板，不能等 effect 再清理带有历史和草稿的缓存。
  const retained = cache.ownerKey === ownerKey ? cache.slots : {};
  const slots = deletedEnvironmentIds ? evictDeletedEnvironmentSlots(retained, deletedEnvironmentIds) : retained;
  const current =
    currentKey && activeAgentId
      ? (slots[currentKey] ?? {
          agentId: activeAgentId,
          sessionId,
          version: 0,
        })
      : null;
  const allSlots = currentKey && current ? { ...slots, [currentKey]: current } : slots;

  useLayoutEffect(() => {
    setCache((previous) => {
      const retained = previous.ownerKey === ownerKey ? previous.slots : {};
      const slots = deletedEnvironmentIds ? evictDeletedEnvironmentSlots(retained, deletedEnvironmentIds) : retained;
      if (currentKey && activeAgentId && !slots[currentKey]) {
        return { ownerKey, slots: { ...slots, [currentKey]: { agentId: activeAgentId, sessionId, version: 0 } } };
      }
      return previous.ownerKey === ownerKey && previous.slots === slots ? previous : { ownerKey, slots };
    });
  }, [ownerKey, currentKey, activeAgentId, sessionId, deletedEnvironmentIds]);

  useEffect(() => {
    const reconnect = (event: Event) => {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (!detail || typeof detail !== "object" || !("envId" in detail) || typeof detail.envId !== "string") return;
      const instanceUid = "instanceUid" in detail ? detail.instanceUid : undefined;
      if (instanceUid !== undefined && typeof instanceUid !== "string") return;
      setCache((previous) => {
        if (previous.ownerKey !== ownerKey) return previous;
        let changed = false;
        const slots = Object.fromEntries(
          Object.entries(previous.slots).map(([key, slot]) => {
            if (slot.agentId !== detail.envId || (instanceUid !== undefined && slot.sessionId !== instanceUid)) {
              return [key, slot];
            }
            changed = true;
            return [key, { ...slot, version: slot.version + 1 }];
          }),
        );
        return changed ? { ownerKey, slots } : previous;
      });
    };
    window.addEventListener("agent:reconnect", reconnect);
    return () => window.removeEventListener("agent:reconnect", reconnect);
  }, [ownerKey]);

  return {
    activeRestartVersion: current?.version ?? 0,
    slots: Object.entries(allSlots).map(([cacheKey, slot]) => ({
      ...slot,
      key: JSON.stringify([ownerKey, cacheKey, slot.version]),
      active: cacheKey === currentKey,
    })),
  };
}
