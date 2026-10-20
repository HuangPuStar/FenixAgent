/**
 * `/web/tickets/:projectId/:number/attachments*` 协议层：列出、上传与流式下载（方案 §8 的路由表，T05）。
 *
 * 附件独有的三条协议事实（multipart 无 body schema、文件名归一在领域服务、下载是字节流而不是信封）以及
 * 上限、`Content-Disposition`、`nosniff` 的口径，都写在 `../ticket-attachment-protocol.ts` 的文件头——那份
 * 实现被 `/web` 与管理面（`routes/api/system-ticket-attachments.ts`）共用，两个面不得各写一份。
 *
 * 本文件只做：把已校验的路径参数交给附件 Facade、把结果映射成 `/web` 信封或字节流响应。**授权一律不在这里**
 * ——能不能读写附件由项目可见性决定（跨组织/不存在同形 404），项目暂停在写路径报 503。
 */

import { WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketDetailParamsSchema, TicketUncertainResponseSchema } from "../../../schemas/ticket.schema";
import {
  TicketAttachmentListResponseSchema,
  TicketAttachmentParamsSchema,
  TicketAttachmentResponseSchema,
} from "../../../schemas/ticket-attachment.schema";
import { getTicketsServerModule } from "../../runtime";
import {
  attachmentContentDisposition,
  MAX_SIZE_MB,
  readAttachmentUpload,
  safeContentType,
  UPLOAD_FIELD,
} from "../ticket-attachment-protocol";
import { requireTicketIdempotencyKey, TicketIdempotencyHeadersSchema } from "../ticket-request-protocol";
import { ticketHandler, ticketStreamHandler } from "./web-error";

export function registerTicketAttachmentRoutes(app: AnyElysia): void {
  // ── GET /tickets/:projectId/:number/attachments ──
  app.get(
    "/tickets/:projectId/:number/attachments",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>>(async (route, actor) => ({
      data: await getTicketsServerModule().attachments.list(actor, route.params.projectId, route.params.number),
    })),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      response: {
        200: TicketAttachmentListResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        404: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "列出工单附件",
        description:
          "返回该工单的全部附件（最新在前由前端决定，服务端按上游顺序返回）：附件编号、文件名、字节数与创建时间。列表回源托管平台，项目或工单不存在返回 404，托管平台不可用返回 503（不返回空列表）。响应不含任何下载地址：内容一律经 GET /web/tickets/:projectId/:number/attachments/:attachmentId 代理。",
      },
    },
  );

  // ── POST /tickets/:projectId/:number/attachments ──
  app.post(
    "/tickets/:projectId/:number/attachments",
    ticketHandler<z.infer<typeof TicketDetailParamsSchema>>(async (route, actor) => {
      const idempotencyKey = requireTicketIdempotencyKey(route.headers);
      const upload = await readAttachmentUpload(route.request);
      const outcome = await getTicketsServerModule().attachments.upload(
        actor,
        route.params.projectId,
        route.params.number,
        upload,
        idempotencyKey,
      );
      if (outcome.kind === "uncertain") {
        return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" } };
      }
      return { status: 201, data: { attachment: outcome.attachment, operationId: outcome.operationId } };
    }),
    {
      sessionAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      response: {
        201: TicketAttachmentResponseSchema,
        202: TicketUncertainResponseSchema,
        400: WebErrSchema,
        401: WebErrSchema,
        403: WebErrSchema,
        404: WebErrSchema,
        409: WebErrSchema,
        503: WebErrSchema,
      },
      detail: {
        tags: ["Tickets"],
        summary: "上传工单附件",
        description: `以 multipart/form-data 上传单个附件到该工单（字段名 ${UPLOAD_FIELD}，一次一个文件；单文件上限 ${MAX_SIZE_MB} MB，空文件拒绝）。请求必须带 Idempotency-Key：缺失 400 IDEMPOTENCY_KEY_REQUIRED、格式非法 400 IDEMPOTENCY_KEY_INVALID、同键不同内容（文件名或字节不同）409 IDEMPOTENCY_CONFLICT、同键同内容重放返回原结果。扩展名不在托管平台白名单或超出上游大小上限返回 400（确定拒绝，不会写入）。上游写入结果未定返回 202，调用方据 operationId 复核而不重发。附件挂在工单上（不是评论上），因此上传只需工单存在。`,
      },
    },
  );

  // ── GET /tickets/:projectId/:number/attachments/:attachmentId ──
  app.get(
    "/tickets/:projectId/:number/attachments/:attachmentId",
    ticketStreamHandler<z.infer<typeof TicketAttachmentParamsSchema>>(async (route, actor) => {
      const download = await getTicketsServerModule().attachments.download(
        actor,
        route.params.projectId,
        route.params.number,
        route.params.attachmentId,
      );
      const headers = new Headers({
        "Content-Disposition": attachmentContentDisposition(download.attachment.name, "attachment"),
        "Content-Type": safeContentType(download.contentType),
        // 附件是用户内容：禁止浏览器按内容嗅探类型，也禁止中间层缓存带凭据取得的字节。
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      if (download.contentLength !== null) headers.set("Content-Length", String(download.contentLength));
      return new Response(download.stream, { status: 200, headers });
    }),
    {
      sessionAuth: true,
      params: TicketAttachmentParamsSchema,
      detail: {
        tags: ["Tickets"],
        summary: "下载工单附件",
        description:
          "校验附件确属该工单后流式返回其内容（不落盘、不缓存）。内容经本服务代理：托管平台的内容地址带服务账号凭据，绝不发给浏览器。附件编号不属于该工单或已被删除返回 404（同形），托管平台不可用返回 503。",
      },
    },
  );
}
