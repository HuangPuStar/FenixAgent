import * as z from "zod/v4";

/**
 * `/web/*` 控制台接口的共享响应信封与通用分页/排序参数。
 *
 * 该信封由身份、资源等多个模块共同贡献，契约只能有一个定义处：平台模块（如 identity）不得
 * 导入宿主 `apps/server`，转发 shim 被「删除优于兼容」原则禁止，复制定义会让形状漂移。因此
 * 定义在平台契约包，由 `@fenix/platform-sdk` 根入口导出给宿主与各模块消费。
 */

/** Web 模块成功响应：成功且携带业务数据。 */
export const WebOkSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });

/** 通用确认型成功响应：仅返回 ok 标记，无具体业务数据。 */
export const OkResponseSchema = WebOkSchema(z.object({ ok: z.literal(true) }));

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
