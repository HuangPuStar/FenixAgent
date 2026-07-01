import * as z from "zod/v4";

/** Web 模块成功响应：成功且携带业务数据。 */
export const WebOkSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

/** Web 模块失败响应。 */
export const WebErrSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

/** Web 模块通用响应（成功或失败）。 */
export const WebResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.union([WebOkSchema(dataSchema), WebErrSchema]);

/** Elysia error() 辅助函数返回的错误结构 */
export const ApiErrorSchema = z.object({
  error: z.object({
    type: z.string(),
    message: z.string(),
  }),
});

/** 通用分页参数：内部 API 默认优先使用 page / pageSize。 */
export const PaginationParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional().default(1),
  pageSize: z.coerce.number().int().positive().max(100).optional().default(20),
});

/** 通用排序参数：内部 API 默认优先使用 sortBy / sortOrder。 */
export const SortParamsSchema = z.object({
  sortBy: z.string().min(1).optional(),
  sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
});

/** 通用分页 + 排序参数组合。 */
export const PaginationSortParamsSchema = PaginationParamsSchema.extend({
  sortBy: SortParamsSchema.shape.sortBy,
  sortOrder: SortParamsSchema.shape.sortOrder,
});

export type PaginationParams = z.infer<typeof PaginationParamsSchema>;
export type PaginationSortParams = z.infer<typeof PaginationSortParamsSchema>;
export type SortParams = z.infer<typeof SortParamsSchema>;
export type WebErr = z.infer<typeof WebErrSchema>;
