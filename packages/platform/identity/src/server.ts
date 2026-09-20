/**
 * Identity 模块的服务端公开入口。
 *
 * 依赖方向（ce-ee-engineering-standards §2.3）：本包属 `platform-impl`，任何资源模块与
 * Agent Runtime 都**不得**导入本入口；它们读取身份数据只能经 `@fenix/platform-sdk` 的
 * `IdentityDirectory` 契约。宿主 `apps/server` 是唯一的合法消费者。
 *
 * 本模块不提供 `authGuardPlugin`：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向
 * 已构造的子实例回填，而守卫必须与宿主的认证解析（含测试 seam 与 ALS 增强）是同一份实例。
 * 因此 `/web/*` 与 `/api/system/*` 路由改为工厂，由宿主注入守卫。
 */

export type { ApiSystemPagination, ApiSystemUserRecord, IdentityDirectory } from "@fenix/platform-sdk";
export { getAuth, resetAuth } from "./auth/better-auth";
export { decryptPassword, getEncryptionKey } from "./auth/encryption";
export { buildTrustedOrigins } from "./auth/trusted-origins";
export type { IdentityConfig } from "./config";
export type { IOrganizationRepo } from "./repositories/organization";
export { organizationRepo } from "./repositories/organization";
export { isPhoneNumberRegistered } from "./repositories/user";
/**
 * 用户偏好（`user_config`）的读写。1.5c 从宿主 `apps/server/src/services/config/user-config.ts` 迁入：
 * 表的真相来源本就在本包，宿主是唯一消费者（`services/resource-module-ports.ts` 的两个偏好端口）。
 * `permission` 按 jsonb 原样透传，模型属于宿主的权限栈。
 */
export type { UserConfigData, UserConfigSubject } from "./repositories/user-config";
export { getUserConfig, setUserConfig } from "./repositories/user-config";
export { createApiSystemRoutes } from "./routes/api/system";
export type { SystemApiRouteDependencies, WebIdentityRouteDependencies } from "./routes/dependencies";
export { createWebApiKeysRoutes } from "./routes/web/api-keys";
export { createWebOrganizationsRoutes } from "./routes/web/organizations";
/**
 * 轮换调用方名下指定名称的 API Key，返回明文 key。
 *
 * agent-config 的 meta agent 需要轮换自己的 key，但资源包不得导入本包，因此由宿主注入该函数。
 */
export { rotateCallerApiKey } from "./services/caller-api-keys";
export { ensureSystemAdmin } from "./services/ensure-system-admin";
export { createIdentityDirectory } from "./services/identity-directory";
export { buildPhoneTempEmail, isEmailIdentifier, normalizeChineseMainlandPhoneNumber } from "./services/phone-number";
export type {
  EnvironmentSecretResolver,
  EnvironmentSecretSubject,
  IdentityAuthentication,
  IdentityAuthenticationDependencies,
  IdentityAuthenticationResult,
} from "./services/request-authentication";
export {
  IdentityAuthenticationError,
  resolveCredentialAuthentication,
  resolveIdentityAuthentication,
} from "./services/request-authentication";
