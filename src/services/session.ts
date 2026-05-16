import { eventService } from "../services/event-service";
import { v4 as uuid } from "uuid";

/**
 * Session 管理已下沉到 Agent 进程（acp-link）。
 * 此文件仅保留 RCS 侧 SSE/EventBus 所需的最小接口。
 * Session 元数据（list/get/create）由 ACP 协议通过 relay 透传。
 */

// ────────────────────────────────────────────
// EventBus 相关（核心保留）
// ────────────────────────────────────────────

export async function updateSessionStatus(sessionId: string, status: string) {
  const bus = eventService.getAllBuses().get(sessionId);
  if (!bus) return;
  bus.publish({
    id: uuid(),
    sessionId,
    type: "session_status",
    payload: { status },
    direction: "inbound",
  });
}

export async function archiveSession(sessionId: string) {
  await updateSessionStatus(sessionId, "archived");
  eventService.removeBus(sessionId);
}

// ────────────────────────────────────────────
// Session 存根（Agent 管理，RCS 不持久化）
// ────────────────────────────────────────────

interface LightweightSession {
  id: string;
  status: string;
}

/** Session 由 Agent 管理，此函数仅检查 EventBus 是否活跃 */
export function getSession(sessionId: string): Promise<LightweightSession | null> {
  const bus = eventService.getAllBuses().get(sessionId);
  if (!bus) return Promise.resolve(null);
  return Promise.resolve({
    id: sessionId,
    status: "active",
  });
}

/** Session 由 Agent 管理，直接返回 sessionId */
export function resolveExistingSessionId(sessionId: string): Promise<string | null> {
  const bus = eventService.getAllBuses().get(sessionId);
  return Promise.resolve(bus ? sessionId : null);
}

/** Session 不再由 RCS 创建，返回轻量存根 */
export function createSession(_req: Record<string, unknown>): Promise<LightweightSession> {
  const id = `session_${uuid().replace(/-/g, "")}`;
  return Promise.resolve({
    id,
    status: "idle",
  });
}

// ────────────────────────────────────────────
// Repository 代理接口
// ────────────────────────────────────────────

import { sessionRepo } from "../repositories";

/** 查找或创建属于某 Environment 的 Session（Bridge 注册编排用） */
export async function findOrCreateForEnvironment(
  environmentId: string,
  defaultTitle: string,
  userId: string,
  source: string = "acp",
): Promise<{ id: string }> {
  const existing = await sessionRepo.listByEnvironment(environmentId);
  if (existing.length > 0) {
    return { id: existing[0].id };
  }
  const session = await sessionRepo.create({
    environmentId,
    title: defaultTitle,
    source,
    userId,
  });
  return { id: session.id };
}

/** 绑定 Session 的 owner UUID（web/auth 路由用） */
export async function bindSessionOwner(sessionId: string, userId: string): Promise<void> {
  await sessionRepo.bindOwner(sessionId, userId);
}
