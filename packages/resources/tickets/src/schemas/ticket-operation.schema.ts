import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";

/**
 * 操作类型的取值域：协议、领域与视图**共用**的唯一定义处。
 *
 * 为什么集中成一列而不是三处各写一份：`ticket_operations.kind` 是 `varchar`，新增取值不会在数据库层报错；
 * 漏改任何一处消费方（zod 响应校验、`toTicketOperationView` 的取值域收敛）都只在运行期显形，且失败形态是
 * 「500」或「前端按未知状态渲染」。领域类型 `TicketOperationKind` 与视图枚举都从本列表派生，新增一种操作
 * 只需改这里 + 同批实现其路径。
 */
export const TICKET_OPERATION_KINDS = [
  "issue.create",
  "project.provision",
  "issue.update",
  "issue.labels",
  "comment.create",
  "comment.update",
  "label.create",
  "label.update",
  "attachment.upload",
] as const;

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
  kind: z.enum(TICKET_OPERATION_KINDS),
  status: z.enum(["pending", "dispatching", "succeeded", "failed", "uncertain", "needs_review"]),
  /** 开通项目在成功前没有项目行。 */
  projectId: z.string().nullable(),
  /** 远端对象 ID（工单为 issue number、评论为评论 ID，按字符串承载）。 */
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
