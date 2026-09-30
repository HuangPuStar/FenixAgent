import type { SystemTenant } from "@fenix/platform-sdk";
import { _deps, SYSTEM_ADMIN_EMAIL } from "./ensure-system-admin";

/**
 * 系统托管租户的只读解析（`IdentityDirectory.resolveSystemTenant` 的实现）。
 *
 * **本函数不触发引导**：引导是宿主启动期的显式动作（`apps/server/src/bootstrap/host-startup.ts` 与
 * `apps/server/src/services/sync-builtin.ts` 调用的 `ensureSystemAdmin()`，两者都在任何租户读取之前
 * 完成）。因此这里既不 INSERT `user` / `account` / `organization` / `member`，也不写系统管理员密码
 * 文件，更不会在已引导的库上重复收紧凭据文件权限——`IdentityDirectory` 是平台契约里的只读投影
 * （ce-ee-engineering-standards §5.3），调用方必须能按「两次查询、无副作用」估算调用成本，且
 * 「未初始化」不能与「首次初始化」共用同一个入口。
 *
 * 其余语义与此前一致：未引导（无系统管理员账号，或账号存在但 admin 组织归属缺失）时抛错，不返回
 * 空值让调用方把系统资源写到错误归属下；`userId` / `email` 是审计主体，系统托管资源的 `user_id`
 * 必须写这个真实用户 ID，不得伪造 actor。
 *
 * 查询原语沿用 `ensure-system-admin` 的 `_deps` 注入缝：与引导共用同一份实现和同一份测试替身，
 * 避免两份 seam 各自漂移；这里只读其中的两个查询依赖，不触碰任何写依赖。
 */
export async function resolveSystemAdminTenant(): Promise<SystemTenant> {
  const existing = await _deps.findUserByEmail(SYSTEM_ADMIN_EMAIL);
  if (!existing) {
    throw new Error(
      `[system-admin] system tenant is not bootstrapped: ${SYSTEM_ADMIN_EMAIL} does not exist; ` +
        "host startup must run ensureSystemAdmin() before resolving the system tenant",
    );
  }

  const organization = await _deps.findAdminOrganizationForUser(existing.id);
  if (!organization) {
    throw new Error(
      `[system-admin] system tenant is inconsistent: ${SYSTEM_ADMIN_EMAIL} exists but the admin organization membership is missing`,
    );
  }

  return {
    organizationId: organization.organizationId,
    organizationSlug: organization.slug,
    userId: existing.id,
    email: SYSTEM_ADMIN_EMAIL,
  };
}
