// 权限请求的权威等待期限。
//
// 本地 ACP server（server.ts）与远端 spawn helper（client/acp-spawn-helper.ts）
// 是两个独立的权限请求创建方；任何一方使用不同期限都会让 Agent 已按取消收口、
// 界面仍显示可批准。期限必须由创建方随 permission_request 下发给 ChatChannel，
// 投影与前端倒计时只读取该 expiresAt，不再自行推算。

/** 权限请求等待用户响应的毫秒数；本地与远端创建方共用。 */
export const PERMISSION_TIMEOUT_MS = 30_000;

/** 生成 permission_request 的权威过期时刻（ISO 字符串）。 */
export function createPermissionExpiresAt(now: number = Date.now()): string {
  return new Date(now + PERMISSION_TIMEOUT_MS).toISOString();
}
