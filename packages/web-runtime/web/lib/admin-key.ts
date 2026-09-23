// packages/web-runtime/web/lib/admin-key.ts
// 系统 Master Key 的唯一实现（docs/arch/21 §5「前端面板」）。
//
// 消费方：各资源包 web 交付物经 `@fenix/web-runtime/lib/admin-key` 引用（observer、model-management；
// sandbox 包内另有一份临时副本，其自述的移除条件正是本模块落地）。本模块不依赖任何宿主路径别名，
// 因此宿主与各包共享同一份实现，不会再出现第二份副本漂移。
//
// 为什么只放 sessionStorage：master key 是系统最高权限凭据，只应在当前标签页会话内存活——
// 不落 localStorage（避免跨会话与跨标签页残留）、不进日志与错误响应；关闭标签页即失效，
// 401 时由调用方 clearAdminKey() 回门。请求时经 request.ts 的 bearerToken 注入 Authorization 头。
//
// 存储键 "rcs_admin_master_key" 是跨包共享的运行时契约（磁盘上不持久化，仅同源标签页内可读），
// 改动会同时影响全部消费方，必须逐字保持。
//
// 历史：宿主旧副本 `apps/web/src/lib/admin-key.ts` 已随本任务删除，此处实现逐字保留，除文件头注释外无行为变化。

const ADMIN_KEY_STORAGE_KEY = "rcs_admin_master_key";

/** 读取当前 session 内的 master key；未设置或非浏览器环境返回 null。 */
export function getAdminKey(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  return sessionStorage.getItem(ADMIN_KEY_STORAGE_KEY);
}

/**
 * 写入 master key（仅当前标签页 session）。
 *
 * 这是前端规范 §6.3「禁止将 API Key、Token、Secret 存入 localStorage 或 sessionStorage」的**显式例外**
 * （登记在该节的「唯一的凭据类例外」，并附移除条件）：取舍是
 * ——换来刷新页面免重输（master key 无法走 better-auth 会话，重输代价高），代价是同源脚本
 * 与 XSS 可直接读走该值。因此本模块只允许服务系统管理员页（sandbox / observer / model-management
 * 的 master key 门），不得用于普通用户凭据；XSS 面由 §6.1 与 §6.2 控制。
 * 移除条件：master key 改由服务端 HttpOnly Cookie 或仅内存态承载后，删除本模块及其消费方。
 */
export function setAdminKey(key: string): void {
  sessionStorage.setItem(ADMIN_KEY_STORAGE_KEY, key);
}

/** 清除 master key（401 / 退出时调用）。 */
export function clearAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
}
