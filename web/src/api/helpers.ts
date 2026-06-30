/**
 * helpers.ts — 前端 API 工具函数
 *
 * 从 client.ts 迁移出的纯工具函数，不依赖 Eden Treaty。
 */

// ── SSE 辅助函数 ──

export function createSessionEventSource(sessionId: string): EventSource {
  return new EventSource(`/web/sessions/${sessionId}/events`, { withCredentials: true });
}

// ── UUID 存储辅助函数 ──

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}
