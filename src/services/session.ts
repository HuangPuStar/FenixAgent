import { v4 as uuidReal } from "uuid";
import { eventService as realEventService } from "../services/event-service";

/**
 * Session 管理已下沉到 Agent 进程（acp-link）。
 * 此文件仅保留 RCS 侧 SSE/EventBus 所需的最小接口。
 * Session 元数据（list/get/create）由 ACP 协议通过 relay 透传。
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

import type { ISessionRepo } from "../repositories";
import { sessionRepo as realSessionRepo } from "../repositories";

export let _sessionRepo: ISessionRepo = realSessionRepo;
export function _setSessionRepo(repo: ISessionRepo) {
  _sessionRepo = repo;
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

/** Session 创建 — 写入 PG 持久化 */
export async function createSession(req: Record<string, unknown>): Promise<LightweightSession> {
  const session = await _sessionRepo.create({
    environmentId: req.environment_id as string | undefined,
    title: req.title as string | undefined,
    source: (req.source as string) || "acp",
    idPrefix: req.idPrefix as string | undefined,
    userId: req.userId as string | undefined,
  });
  return { id: session.id, status: session.status };
}

// ────────────────────────────────────────────
// Repository 代理接口
// ────────────────────────────────────────────

/** 查找或创建属于某 Environment 的 Session（Bridge 注册编排用） */
export async function findOrCreateForEnvironment(
  environmentId: string,
  defaultTitle: string,
  userId: string,
  source: string = "acp",
): Promise<{ id: string }> {
  const existing = await _sessionRepo.listByEnvironment(environmentId);
  if (existing.length > 0) {
    return { id: existing[0].id };
  }
  const session = await _sessionRepo.create({
    environmentId,
    title: defaultTitle,
    source,
    userId,
  });
  return { id: session.id };
}

/** 绑定 Session 的 owner UUID（web/auth 路由用） */
export async function bindSessionOwner(sessionId: string, userId: string): Promise<void> {
  await _sessionRepo.bindOwner(sessionId, userId);
}
