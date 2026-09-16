/** Identity-admin 资源包的服务端公开入口。 */

export type { IOrganizationRepo } from "./server/repositories/organization";
export { organizationRepo } from "./server/repositories/organization";
export { default as apiSystemRoutes } from "./server/routes/api/system";
export { default as webApiKeysRoutes } from "./server/routes/web/api-keys";
export { default as webBrandingRoutes } from "./server/routes/web/branding";
export { default as webOrganizationsRoutes } from "./server/routes/web/organizations";
export { ApiSystemErrorResponseSchema } from "./server/schemas/api-system.schema";
export type {
  ApiKeyInfo,
  OrganizationDetail,
  OrganizationInfo,
  OrganizationMember,
} from "./server/schemas/organization.schema";
export {
  ApiKeyInfoSchema,
  OrganizationDetailSchema,
  OrganizationInfoSchema,
  OrganizationMemberSchema,
} from "./server/schemas/organization.schema";
export { ensureSystemAdmin } from "./server/services/system-admin";
export type { SystemApiPagination, SystemApiUserRecord } from "./server/services/system-api";
