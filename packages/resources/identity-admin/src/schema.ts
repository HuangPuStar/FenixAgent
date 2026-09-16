/** Identity-admin 的协议 schema 稳定出口。 */

export { ApiSystemErrorResponseSchema, ApiSystemUserListResponseSchema } from "./server/schemas/api-system.schema";
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
