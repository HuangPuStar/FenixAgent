import * as z from "zod/v4";

/**
 * 外部 API 的统一错误响应。
 * 所有 `/api/*` 路由都应至少返回稳定的 code/message 结构。
 */
export const ApiErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().describe("错误码。"),
      message: z.string().describe("错误描述。"),
    }),
  })
  .describe("统一错误响应。");

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
