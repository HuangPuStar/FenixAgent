/**
 * `/api/system/tickets/:projectId/:number/attachments*` 协议层（**平台管理面**）：列出、上传与字节读取。
 *
 * 与 `/web/tickets/:projectId/:number/attachments*` 逐字镜像：同一批 zod schema、同一组状态码语义、同一份
 * multipart 与响应头实现（`../ticket-attachment-protocol.ts`，两个面共用——上限、文件名归一与
 * `Content-Disposition` 的口径只有一份）。下载与上传的字节流、大小上限、一次一文件的不变量全部照旧。
 *
 * **一处本面独有的参数**：读取端点接受 `disposition=inline`（默认 `attachment`，与 `/web` 面同行为）。管理面
 * 的凭据是 `Authorization` 头，`<img src>` / `<a href>` 带不上，前端只能先 `fetch` 成 `Blob` 再展示——
 * 那条路径需要「不强制下载」的处置（见 `schemas/system-ticket.schema.ts` 的
 * `SystemTicketAttachmentDownloadQuerySchema`）。字节、`Content-Type` 与 `nosniff` 两种处置完全一致。
 *
 * 本文件只做协议适配；附件与工单的从属校验在领域服务侧（附件编号在该工单的元数据端点下读取，不属于此工单即
 * 上游 404），因此「越权下载」在这一面同样无分支可写。
 */

import { ApiSystemErrorResponseSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { SystemTicketAttachmentDownloadQuerySchema } from "../../../schemas/system-ticket.schema";
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
import { systemTicketHandler, systemTicketStreamHandler } from "./system-error";

export function registerSystemTicketAttachmentRoutes(app: AnyElysia): void {
  // ── GET /api/system/tickets/:projectId/:number/attachments ──
  app.get(
    "/:projectId/:number/attachments",
    systemTicketHandler<z.infer<typeof TicketDetailParamsSchema>>(async (route) => ({
      data: await getTicketsServerModule().platform.listAttachments(route.params.projectId, route.params.number),
    })),
    {
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      response: {
        200: TicketAttachmentListResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "列出跨组织工单附件（管理面）",
        description:
          "返回该工单的全部附件：附件编号、文件名、字节数与创建时间。列表回源托管平台，项目或工单不存在返回 404，托管平台不可用返回 503（不返回空列表）。响应不含任何下载地址：内容一律经 GET /api/system/tickets/:projectId/:number/attachments/:attachmentId 代理。",
      },
    },
  );

  // ── POST /api/system/tickets/:projectId/:number/attachments ──
  app.post(
    "/:projectId/:number/attachments",
    systemTicketHandler<z.infer<typeof TicketDetailParamsSchema>>(async (route) => {
      const idempotencyKey = requireTicketIdempotencyKey(route.headers);
      const upload = await readAttachmentUpload(route.request);
      const outcome = await getTicketsServerModule().platform.uploadAttachment(
        route.params.projectId,
        route.params.number,
        upload,
        idempotencyKey,
      );
      if (outcome.kind === "uncertain") {
        return { status: 202, data: { operationId: outcome.operationId, status: "uncertain" as const } };
      }
      return { status: 201, data: { attachment: outcome.attachment, operationId: outcome.operationId } };
    }),
    {
      systemApiKeyAuth: true,
      params: TicketDetailParamsSchema,
      headers: TicketIdempotencyHeadersSchema,
      response: {
        201: TicketAttachmentResponseSchema,
        202: TicketUncertainResponseSchema,
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        409: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "上传工单附件（管理面）",
        description: `以 multipart/form-data 上传单个附件到该工单（字段名 ${UPLOAD_FIELD}，一次一个文件；单文件上限 ${MAX_SIZE_MB} MB，空文件拒绝）。请求必须带 Idempotency-Key：缺失 400 IDEMPOTENCY_KEY_REQUIRED、格式非法 400 IDEMPOTENCY_KEY_INVALID、同键不同内容（文件名或字节不同）409 IDEMPOTENCY_CONFLICT、同键同内容重放返回原结果。扩展名不在托管平台白名单或超出上游大小上限返回 400（确定拒绝，不会写入）。上游写入结果未定返回 202。附件挂在工单上（不是评论上），因此上传只需工单存在。`,
      },
    },
  );

  // ── GET /api/system/tickets/:projectId/:number/attachments/:attachmentId ──
  app.get(
    "/:projectId/:number/attachments/:attachmentId",
    systemTicketStreamHandler<
      z.infer<typeof TicketAttachmentParamsSchema>,
      z.infer<typeof SystemTicketAttachmentDownloadQuerySchema>
    >(async (route) => {
      const download = await getTicketsServerModule().platform.downloadAttachment(
        route.params.projectId,
        route.params.number,
        route.params.attachmentId,
      );
      const headers = new Headers({
        // 默认 `attachment`（下载，与 `/web` 面同形）；`?disposition=inline` 供前端取回字节做预览。
        "Content-Disposition": attachmentContentDisposition(download.attachment.name, route.query.disposition),
        "Content-Type": safeContentType(download.contentType),
        // 附件是用户内容：禁止浏览器按内容嗅探类型，也禁止中间层缓存带凭据取得的字节。
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
      });
      if (download.contentLength !== null) headers.set("Content-Length", String(download.contentLength));
      return new Response(download.stream, { status: 200, headers });
    }),
    {
      systemApiKeyAuth: true,
      params: TicketAttachmentParamsSchema,
      query: SystemTicketAttachmentDownloadQuerySchema,
      response: {
        400: ApiSystemErrorResponseSchema,
        401: ApiSystemErrorResponseSchema,
        404: ApiSystemErrorResponseSchema,
        503: ApiSystemErrorResponseSchema,
      },
      detail: {
        tags: ["System Tickets"],
        summary: "读取工单附件内容（管理面）",
        description:
          "校验附件确属该工单后流式返回其内容（不落盘、不缓存）。内容经本服务代理：托管平台的内容地址带带服务账号凭据，绝不发给浏览器。`disposition` 默认 attachment（下载，与 `/web` 面同形）；传 inline 时同一份字节以「不强制下载」的处置返回，供前端取回 Blob 后做图片预览（本面凭据是 Authorization 头，`<img src>` 带不上）。`Content-Type` 透传上游的真实类型 + nosniff。附件编号不属于该工单或已被删除返回 404（同形），托管平台不可用返回 503。",
      },
    },
  );
}
