/**
 * helpers.ts — 前端 API 工具函数
 *
 * 从 client.ts 迁移出的纯工具函数，不依赖 Eden Treaty。
 */

// ── SSE 辅助函数 ──

export function createSessionEventSource(sessionId: string): EventSource {
  const uuid = getUuid();
  const activeOrgId = localStorage.getItem("active_org_id");
  const params = new URLSearchParams();
  if (uuid) params.set("uuid", uuid);
  if (activeOrgId) params.set("activeOrganizationId", activeOrgId);
  const query = params.toString();
  const url = query ? `/web/sessions/${sessionId}/events?${query}` : `/web/sessions/${sessionId}/events`;
  return new EventSource(url, { withCredentials: true });
}

// ── UUID 存储辅助函数 ──

const UUID_KEY = "rcs_uuid";

export function getUuid(): string {
  return localStorage.getItem(UUID_KEY) || "";
}

export function setUuid(uuid: string): void {
  localStorage.setItem(UUID_KEY, uuid);
}
