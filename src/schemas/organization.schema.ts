import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

/** better-auth 返回的时间字段，当前可能是时间戳或 ISO 字符串。 */
const FlexibleDateTimeSchema = z
  .union([z.number(), z.string()])
  .describe("时间字段；实际返回可能是时间戳或 ISO 时间字符串。");

/** 组织成员关联的用户信息 */
export const OrganizationUserSchema = z.object({
  id: z.string().describe("用户 ID。"),
  name: z.string().describe("用户名称。"),
  email: z.string().describe("用户邮箱。"),
  phoneNumber: z.string().nullable().optional().describe("用户手机号；未设置时为空。"),
});

/** 组织成员搜索候选项 */
export const OrganizationMemberCandidateSchema = OrganizationUserSchema.extend({
  isMember: z.boolean().describe("该用户是否已在当前组织中。"),
});

/** 组织成员信息 */
export const OrganizationMemberSchema = z.object({
  id: z.string().describe("成员记录 ID。"),
  userId: z.string().describe("成员对应的用户 ID。"),
  role: z.string().describe("成员角色，例如 owner、admin、member。"),
  organizationId: z.string().optional().describe("所属组织 ID；部分接口可能不返回。"),
  user: OrganizationUserSchema.optional().describe("成员关联的用户基础信息。"),
});

/** 组织摘要信息 */
export const OrganizationInfoSchema = z
  .object({
    id: z.string().describe("组织 ID。"),
    name: z.string().describe("组织名称。"),
    slug: z.string().describe("组织唯一标识 slug。"),
    logo: z.string().nullable().optional().describe("组织 Logo 地址；未设置时可能为空。"),
    createdAt: FlexibleDateTimeSchema,
    metadata: z.record(z.string(), z.unknown()).nullable().optional().describe("组织扩展元数据。"),
    role: z.string().optional().describe("当前用户在该组织下的角色，仅列表接口会补充该字段。"),
  })
  .passthrough();

/** 组织详情信息 */
export const OrganizationDetailSchema = OrganizationInfoSchema.extend({
  members: OrganizationMemberSchema.array().describe("该组织下的成员列表。"),
}).passthrough();

/** 通用成功响应 */
const _ActionSuccessSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
  })
  // 该基础分支会被复用到多个 union 响应里；保留附加字段，避免运行时序列化时误删合法的 data。
  .passthrough();

/** API Key 信息 */
export const ApiKeyInfoSchema = z
  .object({
    id: z.string().describe("API Key ID。"),
    name: z.string().describe("API Key 名称。"),
    prefix: z.string().describe("API Key 前缀。"),
    createdAt: FlexibleDateTimeSchema,
    expiresAt: FlexibleDateTimeSchema.nullable().optional().describe("过期时间；为空表示不过期。"),
    lastUsedAt: FlexibleDateTimeSchema.nullable().optional().describe("最后使用时间；未使用过时为空。"),
    metadata: z.unknown().optional().describe("API Key 扩展元数据。"),
  })
  .passthrough();

/** 创建 API Key 的返回结果 */
const ApiKeyCreateResultSchema = z
  .object({
    key: z.string().optional().describe("新创建的 API Key 明文，仅创建时返回。"),
  })
  .passthrough();

/** 创建组织 REST 请求体 */
export const CreateOrganizationBodySchema = z.object({
  name: z.string().describe("组织名称。"),
  slug: z.string().describe("组织唯一标识 slug。"),
  description: z.string().optional().describe("组织描述，会写入 metadata.description。"),
});

/** 更新组织 REST 请求体 */
export const UpdateOrganizationBodySchema = z.object({
  name: z.string().optional().describe("更新后的组织名称。"),
  slug: z.string().optional().describe("更新后的组织 slug。"),
  data: z.record(z.string(), z.unknown()).optional().describe("透传给底层更新接口的原始数据对象。"),
});

/** 添加成员 REST 请求体 */
export const AddMemberBodySchema = z.object({
  role: z.string().describe("成员角色。"),
  userIds: z.array(z.string()).min(1).describe("要批量添加的用户 ID 列表。"),
});

/** 搜索组织成员候选项请求 query */
export const SearchMemberCandidatesQuerySchema = z.object({
  keyword: z.string().optional().describe("搜索关键字，支持姓名、邮箱或手机号。"),
});

/** 更新成员角色 REST 请求体 */
export const UpdateMemberRoleBodySchema = z.object({
  role: z.string().describe("新的成员角色。"),
});

/** 创建 API Key REST 请求体 */
export const CreateApiKeyBodySchema = z.object({
  name: z.string().describe("API Key 名称。"),
  expiresAt: z.union([z.string(), z.number()]).optional().describe("可选过期时间；会基于该值换算 expiresIn。"),
  metadata: z.unknown().optional().describe("API Key 扩展元数据。"),
});

/** 更新 API Key REST 请求体 */
export const UpdateApiKeyBodySchema = z.object({
  name: z.string().optional().describe("新的 API Key 名称。"),
  data: z.record(z.string(), z.unknown()).optional().describe("兼容旧调用方的透传字段。"),
});

// ────────────────────────────────────────────
// REST 响应体（各端点专用，非 union 以通过 tsc 类型检查）
// ────────────────────────────────────────────

/** 组织列表响应 */
export const OrganizationListResponseSchema = WebOkSchema(
  OrganizationInfoSchema.array().describe("组织列表。"),
).describe("组织列表成功响应。");

/** GET /organizations/:id 可能返回基本信息或含成员的详情，二者均接受 */
const OrgDetailOkSchema = WebOkSchema(OrganizationDetailSchema.describe("组织详情。"));
const OrgInfoOkSchema = WebOkSchema(OrganizationInfoSchema.describe("组织基本信息。"));
export const OrganizationGetResponseSchema = z
  .union([OrgDetailOkSchema, OrgInfoOkSchema])
  .describe("组织详情响应（当前组织含成员，否则仅基本信息）。");

/** 创建/更新组织响应 */
export const OrganizationMutateResponseSchema = WebOkSchema(OrganizationInfoSchema.describe("组织信息。")).describe(
  "组织创建/更新成功响应。",
);

/** 删除组织响应 */
export const OrganizationDeleteResponseSchema = WebOkSchema(
  z.object({ deleted: z.literal(true).describe("删除操作已执行。") }),
).describe("组织删除成功响应。");

/** 空数据响应（set-active / remove-member / update-role 等） */
export const OrganizationVoidResponseSchema = WebOkSchema(z.null().describe("无业务数据时固定返回 null。")).describe(
  "操作成功无业务数据。",
);

/** 成员列表响应 */
export const MemberListResponseSchema = WebOkSchema(
  OrganizationMemberSchema.array().describe("组织成员列表。"),
).describe("成员列表成功响应。");

/** 成员变更响应 */
export const MemberMutateResponseSchema = WebOkSchema(
  OrganizationMemberSchema.array().describe("批量成员变更结果。"),
).describe("成员变更成功响应。");

/** 成员候选列表响应 */
export const MemberCandidateListResponseSchema = WebOkSchema(
  OrganizationMemberCandidateSchema.array().describe("组织成员搜索候选项列表。"),
).describe("成员候选列表成功响应。");

/** API Key 列表响应 */
export const ApiKeyListResponseSchema = WebOkSchema(ApiKeyInfoSchema.array().describe("API Key 列表。")).describe(
  "API Key 列表成功响应。",
);

/** API Key 创建响应 */
export const ApiKeyCreateResponseSchema = WebOkSchema(
  ApiKeyCreateResultSchema.describe("创建 API Key 的结果。"),
).describe("API Key 创建成功响应。");

/** API Key 删除响应 */
export const ApiKeyDeleteResponseSchema = WebOkSchema(
  z.object({ deleted: z.literal(true).describe("删除操作已执行。") }),
).describe("API Key 删除成功响应。");

/** API Key 更新/空响应 */
export const ApiKeyVoidResponseSchema = WebOkSchema(z.null().describe("无业务数据时固定返回 null。")).describe(
  "操作成功无业务数据。",
);

export type OrganizationInfo = z.infer<typeof OrganizationInfoSchema>;
export type OrganizationDetail = z.infer<typeof OrganizationDetailSchema>;
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;
export type OrganizationMemberCandidate = z.infer<typeof OrganizationMemberCandidateSchema>;
export type ApiKeyInfo = z.infer<typeof ApiKeyInfoSchema>;
