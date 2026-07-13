import * as z from "zod/v4";

// OpenAPI/JSON Schema 生成阶段不支持 z.date()，这里统一约定序列化后只暴露字符串或时间戳。
const FlexibleDateTimeSchema = z.union([z.string(), z.number()]);

export const ApiSystemErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

export const ApiSystemPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
  pageSize: z.coerce.number().int().min(1).max(200).default(20).describe("每页条数。"),
});

export const ApiSystemUserSchema = z.object({
  id: z.string().describe("用户 ID。"),
  name: z.string().describe("用户名称。"),
  email: z.string().describe("用户邮箱。"),
  emailVerified: z.boolean().describe("邮箱是否已验证。"),
  phoneNumber: z.string().nullable().describe("用户手机号；未设置时为空。"),
  phoneNumberVerified: z.boolean().describe("手机号是否已验证。"),
  createdAt: FlexibleDateTimeSchema.describe("创建时间。"),
  updatedAt: FlexibleDateTimeSchema.describe("更新时间。"),
});

export const ApiSystemUserListResponseSchema = z.object({
  items: ApiSystemUserSchema.array().describe("用户列表。"),
  total: z.number().int().nonnegative().describe("总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});

export const ApiSystemUserIdParamsSchema = z.object({
  id: z.string().describe("用户 ID。"),
});

export const ApiSystemApiKeyIdParamsSchema = z.object({
  id: z.string().describe("API Key ID。"),
});

export const ApiSystemCreateUserBodySchema = z
  .object({
    email: z.email().optional().describe("用户邮箱；手机号用户可不传。"),
    emailVerified: z.boolean().optional().describe("是否标记邮箱已验证。"),
    phoneNumber: z.string().optional().describe("用户手机号；不传邮箱时会作为登录标识。"),
    phoneNumberVerified: z.boolean().optional().describe("是否标记手机号已验证。"),
    name: z.string().min(1).describe("用户名称。"),
    password: z.string().min(8).describe("初始密码。"),
  })
  .refine((value) => !!value.email || !!value.phoneNumber, {
    message: "email 或 phoneNumber 至少需要提供一个",
    path: ["email"],
  });

export const ApiSystemOrganizationSchema = z.object({
  id: z.string().describe("组织 ID。"),
  name: z.string().describe("组织名称。"),
  slug: z.string().describe("组织 slug。"),
  logo: z.string().nullable().optional().describe("组织 Logo。"),
  metadata: z.record(z.string(), z.unknown()).nullable().optional().describe("组织扩展元数据。"),
  createdAt: FlexibleDateTimeSchema.describe("创建时间。"),
});

export const ApiSystemOrganizationMemberSchema = z.object({
  id: z.string().describe("成员记录 ID。"),
  organizationId: z.string().describe("组织 ID。"),
  userId: z.string().describe("用户 ID。"),
  role: z.string().describe("成员角色。"),
  createdAt: FlexibleDateTimeSchema.describe("创建时间。"),
});

export const ApiSystemOrganizationDetailSchema = ApiSystemOrganizationSchema.extend({
  members: ApiSystemOrganizationMemberSchema.array().describe("组织成员列表。"),
});

export const ApiSystemOrganizationListResponseSchema = z.object({
  items: ApiSystemOrganizationSchema.array().describe("组织列表。"),
  total: z.number().int().nonnegative().describe("总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});

export const ApiSystemOrganizationIdParamsSchema = z.object({
  id: z.string().describe("组织 ID。"),
});

export const ApiSystemCreateOrganizationBodySchema = z.object({
  name: z.string().min(1).describe("组织名称。"),
  slug: z.string().min(1).describe("组织 slug。"),
  ownerUserId: z.string().optional().describe("可选的 owner 用户 ID。"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("组织扩展元数据。"),
});

export const ApiSystemAddOrganizationMemberBodySchema = z.object({
  userId: z.string().describe("待加入的用户 ID。"),
  role: z.enum(["owner", "admin", "member"]).describe("成员角色。"),
});

export const ApiSystemCreateApiKeyBodySchema = z.object({
  userId: z.string().describe("API Key 归属用户 ID。"),
  organizationId: z.string().describe("API Key 绑定的组织 ID。"),
  role: z.enum(["owner", "admin", "member"]).describe("该 key 在目标组织下的角色。"),
  name: z.string().min(1).describe("API Key 名称。"),
  expiresIn: z.number().int().positive().nullable().optional().describe("过期秒数；为空表示不过期。"),
  metadata: z.record(z.string(), z.unknown()).optional().describe("附加 metadata。"),
});

export const ApiSystemApiKeyResultSchema = z.object({
  id: z.string().describe("API Key ID。"),
  name: z.string().nullable().describe("API Key 名称。"),
  prefix: z.string().nullable().describe("API Key 前缀。"),
  key: z.string().describe("新创建的 API Key 明文，仅创建时返回。"),
  start: z.string().nullable().describe("Key 前几位。"),
  userId: z.string().describe("归属用户 ID。"),
  organizationId: z.string().describe("绑定组织 ID。"),
  role: z.string().describe("绑定角色。"),
  createdAt: FlexibleDateTimeSchema.describe("创建时间。"),
  expiresAt: FlexibleDateTimeSchema.nullable().describe("过期时间。"),
  metadata: z.record(z.string(), z.unknown()).nullable().describe("最终 metadata。"),
});

export const ApiSystemApiKeyListItemSchema = ApiSystemApiKeyResultSchema.omit({
  key: true,
}).describe("用户 API Key 列表项；不返回明文 key。");

export const ApiSystemApiKeyListResponseSchema = z.object({
  items: ApiSystemApiKeyListItemSchema.array().describe("API Key 列表。"),
  total: z.number().int().nonnegative().describe("总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});

export const ApiSystemUserOrganizationSchema = ApiSystemOrganizationSchema.extend({
  memberId: z.string().describe("成员记录 ID。"),
  role: z.string().describe("该用户在组织中的角色。"),
  memberCreatedAt: FlexibleDateTimeSchema.describe("该用户加入组织的时间。"),
});

export const ApiSystemUserOrganizationListResponseSchema = z.object({
  items: ApiSystemUserOrganizationSchema.array().describe("用户所属组织列表。"),
  total: z.number().int().nonnegative().describe("总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});

export const ApiSystemDeleteResponseSchema = z.object({
  deleted: z.literal(true).describe("删除操作已执行。"),
});

export type ApiSystemPaginationQuery = z.infer<typeof ApiSystemPaginationQuerySchema>;
export type ApiSystemCreateUserBody = z.infer<typeof ApiSystemCreateUserBodySchema>;
export type ApiSystemCreateOrganizationBody = z.infer<typeof ApiSystemCreateOrganizationBodySchema>;
export type ApiSystemAddOrganizationMemberBody = z.infer<typeof ApiSystemAddOrganizationMemberBodySchema>;
export type ApiSystemCreateApiKeyBody = z.infer<typeof ApiSystemCreateApiKeyBodySchema>;
