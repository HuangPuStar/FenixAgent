import * as z from "zod/v4";

/** Hindsight 已启用时的状态数据 */
export const HindsightEnabledStatusSchema = z
  .object({
    enabled: z.literal(true).describe("Hindsight 服务是否已启用。"),
    url: z.string().describe("当前配置的 Hindsight MCP 服务地址。"),
    bankId: z.string().nullable().describe("当前用户在活跃组织下映射得到的 Hindsight bank ID；无法解析时为 null。"),
  })
  .describe("Hindsight 已启用时的状态信息。");

/** Hindsight 未启用时的状态数据 */
export const HindsightDisabledStatusSchema = z
  .object({
    enabled: z.literal(false).describe("Hindsight 服务未启用。"),
  })
  .describe("Hindsight 未启用时的状态信息。");

/** GET /web/hindsight/status 响应 */
export const HindsightStatusResponseSchema = z
  .object({
    success: z.literal(true).describe("请求是否成功。"),
    data: z.union([HindsightEnabledStatusSchema, HindsightDisabledStatusSchema]).describe("Hindsight 当前可用状态。"),
  })
  .describe("Hindsight 状态查询响应。");

export type HindsightStatusResponse = z.infer<typeof HindsightStatusResponseSchema>;
