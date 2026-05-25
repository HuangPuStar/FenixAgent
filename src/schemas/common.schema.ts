import * as z from "zod/v4";

/** Config 模块成功响应 */
export const ConfigOkSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

/** Config 模块失败响应 */
export const ConfigErrSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** Config 模块通用响应（成功或失败） */
export const ConfigResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.union([ConfigOkSchema(dataSchema), ConfigErrSchema]);

/** Elysia error() 辅助函数返回的错误结构 */
export const ApiErrorSchema = z.object({
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});

/** 分页参数 */
export const PaginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  limit: z.coerce.number().int().positive().max(100).optional().default(20),
});

/** 通用操作成功响应: `{ ok: true }` */
export const OkResponseSchema = z.object({
  ok: z.literal(true),
});

/** 通用状态响应: `{ status: "ok" }` */
export const StatusOkResponseSchema = z.object({
  status: z.literal("ok"),
});

export type PaginationParams = z.infer<typeof PaginationParamsSchema>;
export type OkResponse = z.infer<typeof OkResponseSchema>;
export type StatusOkResponse = z.infer<typeof StatusOkResponseSchema>;
