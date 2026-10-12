import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import { TICKET_COMMENT_DEFAULT_LIMIT, TICKET_LIST_MAX_LIMIT } from "../server/services/ticket-limits";
import { TicketActorViewSchema } from "./ticket.schema";

/**
 * 评论（`/web/tickets/:projectId/:number/comments`）的请求、查询与响应 schema。
 *
 * 游标语义与工单列表**不同源**，因此刻意不复用工单的 `cursor` 定义：工单列表游标是末条工单号
 * （数值降序的排他上界），评论游标是**更早一页的页码**（适配器的 `Link` 口径：首屏不带游标取末页，之后由
 * `nextCursor` 逐页递减，配合评论区“先给最新一页”的倒序分页）。两者复用同一个正则只是巧合，合并定义会让
 * 「评论游标被当成工单号」这类串味在类型上不可见，前端提示文案也随之不同（backend contract §1.1 要点 1）。
 *
 * 视图只允许出现服务端真实返回的字段：`author` 复用 `TicketActorViewSchema`（`id === null` 即来源不可信，
 * 前端不得据此授予编辑入口，判定一律在服务端）。
 */

/** 评论列表查询：游标是**更早一页的页码**（倒序分页，首屏不传），与工单列表游标（末条工单号）不同源。 */
export const TicketCommentListQuerySchema = z.object({
  cursor: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_LIST_MAX_LIMIT).default(TICKET_COMMENT_DEFAULT_LIMIT),
});

/** 评论作者视图与工单共用（`TicketActorViewSchema`）：`id === null` 即来源不可信、不得编辑。 */
export const TicketCommentViewSchema = z.object({
  commentId: z.string(),
  issueNumber: z.string(),
  body: z.string(),
  author: TicketActorViewSchema,
  version: z.string(),
  providerUpdatedAt: z.string().nullable(),
});

export const TicketCommentListResponseSchema = WebOkSchema(
  z.object({ items: TicketCommentViewSchema.array(), nextCursor: z.string().nullable() }),
);

/** 创建评论：`strictObject`，多传任何字段（含伪造 author / messageId）当场 400（T02-§9.2 同口径）。 */
export const TicketCommentCreateRequestSchema = z.strictObject({
  body: z.string().min(1).describe("评论正文（Markdown；服务端负责加身份头）"),
});

/** 修改评论：必须带 expectedVersion（方案 §8），形状是内容指纹的 sha256 十六进制。 */
export const TicketCommentUpdateRequestSchema = z.strictObject({
  body: z.string().min(1),
  expectedVersion: z.string().regex(/^[0-9a-f]{64}$/),
});

export const TicketCommentResponseSchema = WebOkSchema(
  z.object({ comment: TicketCommentViewSchema, operationId: z.string() }),
);

/** 评论路径参数：`commentId` 是 Forgejo 的评论 ID，校验挡在适配器的 `decimalId` 之前（非法值 400 而不是 404）。 */
export const TicketCommentParamsSchema = z.object({
  projectId: z.string().uuid(),
  number: z.string().regex(/^[1-9]\d*$/),
  commentId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .describe("评论 ID（十进制字符串）"),
});
