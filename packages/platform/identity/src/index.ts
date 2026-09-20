/**
 * Identity 模块的浏览器安全入口。
 *
 * 身份的服务端实现（better-auth 实例、仓储、认证解析、`/web` 与 `/api/system` 路由工厂）只在
 * `@fenix/identity/server` 暴露。根入口保持可被浏览器打包器消费，任何在此新增的导出都必须
 * 不含 `node:` 依赖、不读 `process.env`。
 */

export type {
  MemberRole,
  MembershipSummary,
  OrganizationMemberSummary,
  OrganizationSummary,
  OrganizationWithMembers,
  SystemTenant,
  UserDisplayInfo,
} from "@fenix/platform-sdk";
