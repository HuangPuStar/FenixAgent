// web/src/lib/admin-key.ts
// 系统 Master Key 的 sessionStorage 读写 helper（docs/arch/21 §5）。
//
// 为什么本包自己持有一份：sandbox 的 web 文件此前经宿主路径别名 `@/src/lib/admin-key` 引用它，
// 而 §1.3 要求包内 web 的宿主别名引用数为 0（判定为静态 grep，见任务计划 §2.3 的验收条件）。
// 迁往共享包的两个候选都不成立：web-runtime 的收录范围明确排除鉴权类宿主职责
// （见 packages/web-runtime/README「不搬清单」与「鉴权…一律不进入本包」），
// identity 只提供会话内的组织/成员能力，没有系统侧凭据 helper。
// 因此暂由本包持有——它与本包导出的 MasterKeyGate（observer / model-management 复用的同一道
// 系统管理门禁）同侧，不会产生新的跨包依赖方向。
//
// 存储槽位必须与宿主 `apps/web/src/lib/admin-key.ts` 逐字一致：两处读写同一 sessionStorage 键，
// 一旦漂移，宿主路由写入的 key 在包内组件里读不到（表现为反复出现 Master Key 门）。
//
// 移除条件：`@fenix/web-runtime/lib/admin-key`（或系统管理 owner 的等价公开出口）落地后，
// 删除本文件与 `web/index.ts` 中的重导出，改指新出口；该动作必须与宿主副本的删除同批完成。

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

/** 清除 master key（401 / 退出时由面板层调用）。 */
export function clearAdminKey(): void {
  sessionStorage.removeItem(ADMIN_KEY_STORAGE_KEY);
}
