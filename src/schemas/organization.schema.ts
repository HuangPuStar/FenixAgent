import * as z from "zod/v4";

/** better-auth 返回的时间字段，当前可能是时间戳或 ISO 字符串。 */
const FlexibleDateTimeSchema = z
  .union([z.number(), z.string()])
  .describe("时间字段；实际返回可能是时间戳或 ISO 时间字符串。");

/** 组织成员关联的用户信息 */
export const OrganizationUserSchema = z.object({
  id: z.string().describe("用户 ID。"),
  name: z.string().describe("用户名称。"),
  email: z.string().describe("用户邮箱。"),
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

/** 创建组织请求体 */
const CreateOrganizationActionSchema = z.object({
  action: z.literal("create").describe("创建组织。"),
  name: z.string().describe("组织名称。"),
  slug: z.string().describe("组织 slug。"),
  description: z.string().optional().describe("组织描述，会写入 metadata.description。"),
});

/** 更新组织请求体 */
const UpdateOrganizationActionSchema = z.object({
  action: z.literal("update").describe("更新组织。"),
  organizationId: z.string().describe("要更新的组织 ID。"),
  name: z.string().optional().describe("更新后的组织名称。"),
  slug: z.string().optional().describe("更新后的组织 slug。"),
  data: z.record(z.string(), z.unknown()).optional().describe("透传给底层更新接口的原始数据对象。"),
});

/** 组织接口请求体 */
export const OrganizationActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list").describe("获取当前用户可见的组织列表。"),
  }),
  z.object({
    action: z.literal("get").describe("获取单个组织详情。"),
    organizationId: z.string().describe("组织 ID。"),
  }),
  z.object({
    action: z.literal("get-full").describe("获取完整组织详情；不传 organizationId 时默认取当前组织。"),
    organizationId: z.string().optional().describe("可选的组织 ID。"),
  }),
  CreateOrganizationActionSchema,
  UpdateOrganizationActionSchema,
  z.object({
    action: z.literal("delete").describe("删除组织。"),
    organizationId: z.string().describe("要删除的组织 ID。"),
  }),
  z.object({
    action: z.literal("set-active").describe("切换当前激活组织。"),
    organizationId: z.string().describe("要切换到的组织 ID。"),
  }),
  z.object({
    action: z.literal("list-members").describe("获取组织成员列表。"),
    organizationId: z.string().describe("组织 ID。"),
  }),
  z.object({
    action: z.literal("add-member").describe("添加组织成员。"),
    organizationId: z.string().describe("组织 ID。"),
    role: z.string().describe("成员角色。"),
    userId: z.string().optional().describe("要添加的用户 ID。"),
    email: z.string().optional().describe("要添加的用户邮箱；传入后会先转换为 userId。"),
  }),
  z.object({
    action: z.literal("remove-member").describe("移除组织成员。"),
    organizationId: z.string().describe("组织 ID。"),
    memberId: z.string().describe("成员 ID。"),
  }),
  z.object({
    action: z.literal("update-role").describe("更新成员角色。"),
    organizationId: z.string().describe("组织 ID。"),
    memberId: z.string().describe("成员 ID。"),
    role: z.string().describe("新的成员角色。"),
  }),
  z.object({
    action: z.literal("search-users").describe("按邮箱模糊搜索用户。"),
    query: z.string().describe("搜索关键词。"),
  }),
]);

/** 搜索结果用户信息 */
const SearchUserSchema = z.object({
  id: z.string().describe("用户 ID。"),
  name: z.string().describe("用户名。"),
  email: z.string().describe("用户邮箱。"),
  image: z.string().nullable().optional().describe("用户头像 URL。"),
});

/** 通用成功响应 */
const ActionSuccessSchema = z
  .object({
    success: z.literal(true).describe("接口调用成功。"),
  })
  // 该基础分支会被复用到多个 union 响应里；保留附加字段，避免运行时序列化时误删合法的 data。
  .passthrough();

/** 组织接口响应体 */
export const OrganizationActionResponseSchema = z.union([
  ActionSuccessSchema.extend({
    data: OrganizationInfoSchema.array().describe("组织列表。"),
  }),
  ActionSuccessSchema.extend({
    data: OrganizationDetailSchema.describe("组织详情。"),
  }),
  ActionSuccessSchema.extend({
    data: OrganizationInfoSchema.describe("组织信息。"),
  }),
  ActionSuccessSchema.extend({
    data: OrganizationMemberSchema.array().describe("组织成员列表。"),
  }),
  ActionSuccessSchema.extend({
    data: OrganizationMemberSchema.passthrough().describe("成员变更结果。"),
  }),
  ActionSuccessSchema.extend({
    data: z.object({ deleted: z.literal(true).describe("删除操作已执行。") }).describe("删除结果。"),
  }),
  ActionSuccessSchema.extend({
    data: SearchUserSchema.array().describe("搜索结果用户列表。"),
  }),
  ActionSuccessSchema,
]);

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

/** API Key 接口请求体 */
export const ApiKeyActionRequestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("list").describe("获取当前用户 API Key 列表。"),
  }),
  z.object({
    action: z.literal("create").describe("创建新的 API Key。"),
    name: z.string().describe("API Key 名称。"),
    expiresAt: z
      .union([z.string(), z.number()])
      .optional()
      .describe("可选过期时间；当前实现会基于该值换算 expiresIn。"),
    metadata: z.unknown().optional().describe("API Key 扩展元数据。"),
  }),
  z.object({
    action: z.literal("delete").describe("删除 API Key。"),
    id: z.string().describe("API Key ID。"),
  }),
  z.object({
    action: z.literal("update").describe("更新 API Key。"),
    id: z.string().describe("API Key ID。"),
    name: z.string().optional().describe("新的 API Key 名称。"),
    data: z.record(z.string(), z.unknown()).optional().describe("兼容旧调用方的透传字段。"),
  }),
]);

/** 创建 API Key 的返回结果 */
const ApiKeyCreateResultSchema = z
  .object({
    key: z.string().optional().describe("新创建的 API Key 明文，仅创建时返回。"),
  })
  .passthrough();

/** API Key 接口响应体 */
export const ApiKeyActionResponseSchema = z.union([
  ActionSuccessSchema.extend({
    data: ApiKeyInfoSchema.array().describe("API Key 列表。"),
  }),
  ActionSuccessSchema.extend({
    data: ApiKeyCreateResultSchema.describe("创建 API Key 的结果。"),
  }),
  ActionSuccessSchema.extend({
    data: z.object({ deleted: z.literal(true).describe("删除操作已执行。") }).describe("删除结果。"),
  }),
  ActionSuccessSchema,
]);

export type OrganizationInfo = z.infer<typeof OrganizationInfoSchema>;
export type OrganizationDetail = z.infer<typeof OrganizationDetailSchema>;
export type OrganizationMember = z.infer<typeof OrganizationMemberSchema>;
export type OrganizationActionRequest = z.infer<typeof OrganizationActionRequestSchema>;
export type OrganizationActionResponse = z.infer<typeof OrganizationActionResponseSchema>;
export type ApiKeyInfo = z.infer<typeof ApiKeyInfoSchema>;
export type ApiKeyActionRequest = z.infer<typeof ApiKeyActionRequestSchema>;
export type ApiKeyActionResponse = z.infer<typeof ApiKeyActionResponseSchema>;
