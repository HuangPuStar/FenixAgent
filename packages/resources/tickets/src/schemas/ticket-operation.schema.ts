import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * 工单操作账本（`/web/ticket-operations/:operationId`）的响应 schema。
 *
 * 操作行是幂等与 202 状态的唯一可见载体：`status` 的取值集合与 `ticket_operations.status` 一一对应
 * （backend contract §8.2），T03/T04 新增取值时必须同批扩这里，否则视图会静默丢字段。
 *
 * `result` 是不定型摘要（成功时的 `issueNumber`/`messageId`/`version` 等），刻意保持 `record` 而不细化：
 * 它的形状随 kind 变化，收窄成联合类型只会让「新增一种 kind」变成协议破坏性变更。
 */
export const TicketOperationViewSchema = z.object({
  operationId: z.string(),
  kind: z.enum(["issue.create", "project.provision"]),
  status: z.enum(["pending", "dispatching", "succeeded", "failed", "uncertain", "needs_review"]),
  /** 开通项目在成功前没有项目行。 */
  projectId: z.string().nullable(),
  /** 远端对象 ID（工单为 issue number，按字符串承载）。 */
  targetId: z.string().nullable(),
  result: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 操作查询路径参数：operationId 是账本行主键（uuid），非法值由 Elysia 校验挡在 handler 之前。 */
export const TicketOperationParamsSchema = z.object({
  operationId: z.string().uuid().describe("操作记录 ID"),
});

/** 操作查询响应；可见性由 Facade 判定，非本人操作与不存在的操作同形返回 404。 */
export const TicketOperationResponseSchema = WebOkSchema(
  z.object({
    operation: TicketOperationViewSchema,
  }),
);
