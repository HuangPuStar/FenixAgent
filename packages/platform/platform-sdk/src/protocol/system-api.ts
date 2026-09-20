import * as z from "zod/v4";

/**
 * `/api/*` 对外系统 API 的共享协议契约。
 *
 * 该协议面由多个模块共同贡献（identity 的用户/组织/API Key 管理，observer 的日志、观测与
 * 人员树，资源包的 `/api/*` 资源接口），调用方按单一形状解析，因此形状必须只有一个定义处。
 * 放在平台契约包里而不是任一贡献方内部：模块之间不得互相导入对方的 schema，也不得导入宿主
 * `apps/server` 的同名文件（转发 shim 被「删除优于兼容」原则禁止）。
 *
 * 错误响应刻意不携带 `data`，与 `/web/*` 的 `{ success, data }` 信封区分开。
 */
export const ApiSystemErrorResponseSchema = z.object({
  error: z.object({
    code: z.string().describe("错误码。"),
    message: z.string().describe("错误描述。"),
  }),
});

/** `/api/system/*` 的错误响应体。 */
export type ApiSystemErrorResponse = z.infer<typeof ApiSystemErrorResponseSchema>;

/**
 * 对外 `/api/*` 的统一错误响应（含 `/api/system/*` 之外的资源包路由）。
 *
 * 与 {@link ApiSystemErrorResponseSchema} 的线上形状一致，但两者是分别声明的协议面：前者是
 * `/api/system/*` 的既有合同，后者是资源包 `/api/*` 路由共用的错误信封。保持两个具名导出而不是
 * 让其中一方指向另一方，是为了让任一面的 OpenAPI 描述可以独立演进；形状若发生分歧，应先在
 * `docs/design/` 记录再拆分。资源包不得自行 `z.object({ error: ... })` 复制该形状。
 */
export const ApiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().describe("错误码。"),
      message: z.string().describe("错误描述。"),
    }),
  })
  .describe("统一错误响应。");

/** 对外 `/api/*` 的统一错误响应体。 */
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

/** OpenAPI/JSON Schema 生成阶段不支持 `z.date()`，这里约定序列化后只暴露字符串或时间戳。 */
const FlexibleDateTimeSchema = z.union([z.string(), z.number()]);

/** `/api/system/*` 的列表分页入参。 */
export interface ApiSystemPagination {
  readonly page: number;
  readonly pageSize: number;
}

/** `/api/system/*` 列表接口的查询参数。 */
export const ApiSystemPaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1).describe("页码，从 1 开始。"),
  pageSize: z.coerce.number().int().min(1).max(200).default(20).describe("每页条数。"),
});

/** `/api/system/*` 用户记录的线上形状；字段与 {@link ApiSystemUserRecord} 一一对应。 */
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

/**
 * 用户列表响应。
 *
 * identity 的 `/api/system/users` 与 model-management 的网关主体列表共用该形状，因此定义在
 * 平台契约层；任一贡献方都不得在自己的包里另立一份。
 */
export const ApiSystemUserListResponseSchema = z.object({
  items: ApiSystemUserSchema.array().describe("用户列表。"),
  total: z.number().int().nonnegative().describe("总数。"),
  page: z.number().int().positive().describe("当前页码。"),
  pageSize: z.number().int().positive().describe("当前分页大小。"),
});

/**
 * `/api/system/*` 的用户记录。
 *
 * 这是已发布的对外协议形状（含 `emailVerified` / `phoneNumber` 等账号状态字段），与
 * `UserDisplayInfo` 这类内部展示投影刻意分开：前者是合同，后者是模块间传递的窄投影。
 */
export interface ApiSystemUserRecord {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly phoneNumber: string | null;
  readonly phoneNumberVerified: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
