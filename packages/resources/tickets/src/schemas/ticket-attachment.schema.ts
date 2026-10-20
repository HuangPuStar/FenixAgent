import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import { TicketDetailParamsSchema } from "./ticket.schema";

/**
 * 附件（`/web/tickets/:projectId/:number/attachments`）的请求、查询与响应 schema。
 *
 * 与其它资源不同，附件**没有请求体 schema**：上传是 `multipart/form-data`（字段 `file`），由路由在
 * handler 里经 `request.formData()` 读取后逐字段校验（文件名、大小、条数）——把 multipart 交给 Elysia 的
 * body 校验会在进入 handler 之前把请求体读成普通对象，文件字节与 `File` 语义随之丢失。
 *
 * 因此这里只声明**响应**与路径参数：响应是上传/列表对外唯一的契约面，必须逐字段固定，避免把上游的
 * `browser_download_url`、`uuid` 这类带凭据或纯内部字段流出去（视图只到 `attachmentId` 为止）。
 */

/** 附件视图：`size` 是字节数；不含任何下载地址（内容一律经本服务代理，见 `ticket-view.ts` 的注释）。 */
export const TicketAttachmentViewSchema = z.object({
  attachmentId: z.string(),
  name: z.string(),
  size: z.number().int().nonnegative(),
  createdAt: z.string().nullable(),
});

export const TicketAttachmentListResponseSchema = WebOkSchema(z.object({ items: TicketAttachmentViewSchema.array() }));

export const TicketAttachmentResponseSchema = WebOkSchema(
  z.object({ attachment: TicketAttachmentViewSchema, operationId: z.string() }),
);

/**
 * 下载路径参数：`attachmentId` 是 Forgejo 的附件编号（十进制字符串）。
 *
 * 非法值在路由 schema 就 400，不进入适配器的归属判定——「不是数字」与「不是这个工单的附件」是两回事，
 * 前者是协议错误（400），后者是资源不存在（404）。
 */
export const TicketAttachmentParamsSchema = TicketDetailParamsSchema.extend({
  attachmentId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .describe("附件 ID（十进制字符串）"),
});
