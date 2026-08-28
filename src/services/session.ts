import { v4 as uuidReal } from "uuid";
import { eventService as realEventService } from "../services/event-service";

/**
 * Session 管理已下沉到 Agent 进程（acp-link）。
 * 此文件仅保留 RCS 侧 SSE/EventBus 所需的最小接口。
 * Session 元数据（list/get/create）由 ACP 协议通过 relay 透传。
 *
 * I4 集成第五阶段：agent_session 表已废弃，原 Repository 代理接口
 * （createSession / findOrCreateForEnvironment / bindSessionOwner / _sessionRepo）
 * 已全部删除；实例会话标识由 services/instance-session.ts 确定性生成。
 */

// ────────────────────────────────────────────
// DI 注入点（测试时覆盖）
// ────────────────────────────────────────────
export let _eventService = realEventService;
export let _uuid = uuidReal;

export function _setEventService(es: typeof realEventService) {
  _eventService = es;
}

export function _setUuid(fn: () => string) {
  _uuid = fn;
}

// ────────────────────────────────────────────
// EventBus 相关（核心保留）
// ────────────────────────────────────────────

export function updateSessionStatus(sessionId: string, status: string): void {
  const bus = _eventService.getAllBuses().get(sessionId);
  if (!bus) return;
  bus.publish({
    id: _uuid(),
    sessionId,
    type: "session_status",
    payload: { status },
    direction: "inbound",
  });
}

export function archiveSession(sessionId: string): void {
  updateSessionStatus(sessionId, "archived");
  _eventService.removeBus(sessionId);
}

// ────────────────────────────────────────────
// Session 存根（Agent 管理，RCS 不持久化）
// ────────────────────────────────────────────

interface LightweightSession {
  id: string;
  status: string;
}

/** Session 由 Agent 管理，此函数仅检查 EventBus 是否活跃 */
export async function getSession(sessionId: string): Promise<LightweightSession | null> {
  const bus = _eventService.getAllBuses().get(sessionId);
  if (!bus) return null;
  return { id: sessionId, status: "active" };
}

/** Session 由 Agent 管理，直接返回 sessionId */
export async function resolveExistingSessionId(sessionId: string): Promise<string | null> {
  const bus = _eventService.getAllBuses().get(sessionId);
  return bus ? sessionId : null;
}
