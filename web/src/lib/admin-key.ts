// web/src/lib/admin-key.ts
// 系统 Master Key 的 sessionStorage 读写 helper（docs/arch/21 §5）。
// 约定：master key 仅存 sessionStorage（不落日志、不落 localStorage），请求时经
// request.ts 的 bearerToken 注入 Authorization 头；401 时由调用方 clearAdminKey() 回门。

const ADMIN_KEY_STORAGE_KEY = "rcs_admin_master_key";

/** 读取当前 session 内的 master key；未设置或非浏览器环境返回 null。 */
export function getAdminKey(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(ADMIN_KEY_STORAGE_KEY);
}

/** 写入 master key（仅当前标签页 session）。 */
export function setAdminKey(key: string): void {
  sessionStorage.setItem(ADMIN_KEY_STORAGE_KEY, key);
}

/** 清除 master key（401 / 退出时调用）。 */
export function clearAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
}
