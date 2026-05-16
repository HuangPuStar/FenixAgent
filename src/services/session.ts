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
  environment_id: string | null;
  agent_name: string | null;
  title: string | null;
  status: string;
  source: string;
  permission_mode: string | null;
  worker_epoch: number;
  username: string | null;
  created_at: number;
  updated_at: number;
}

/** Session 由 Agent 管理，此函数仅检查 EventBus 是否活跃 */
export async function getSession(sessionId: string): Promise<LightweightSession | null> {
  const bus = eventService.getAllBuses().get(sessionId);
  if (!bus) return null;
  const now = Date.now() / 1000;
  return {
    id: sessionId,
    environment_id: null,
    agent_name: null,
    title: null,
    status: "active",
    source: "acp",
    permission_mode: null,
    worker_epoch: 0,
    username: null,
    created_at: now,
    updated_at: now,
  };
}

/** Session 由 Agent 管理，直接返回 sessionId */
export async function resolveExistingSessionId(sessionId: string): Promise<string | null> {
  const bus = eventService.getAllBuses().get(sessionId);
  return bus ? sessionId : null;
}

/** Session 不再由 RCS 创建，返回轻量存根 */
export async function createSession(req: Record<string, unknown>): Promise<LightweightSession> {
  const id = `session_${uuid().replace(/-/g, "")}`;
  const now = Date.now() / 1000;
  return {
    id,
    environment_id: (req.environment_id as string) ?? null,
    agent_name: null,
    title: (req.title as string) ?? null,
    status: "idle",
    source: (req.source as string) ?? "acp",
    permission_mode: (req.permission_mode as string) ?? null,
    worker_epoch: 0,
    username: (req.username as string) ?? null,
    created_at: now,
    updated_at: now,
  };
}
