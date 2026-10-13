/**
 * `/web/tickets/:projectId/:number/attachments*` 协议层：列出、上传与流式下载（方案 §8 的路由表，T05）。
 *
 * 三条只有附件才有的协议事实：
 *
 * 1. **上传是 multipart，没有 body schema**。字段名固定 `file`，一次请求**只收一个文件**：一次请求对应一次
 *    远端写入与一个幂等键（账本的不变量），多文件必须先拆成多请求——否则「第 3 个文件被上游拒绝」会让前两个
 *    的落库状态无处安放（既不是全成功也不是全失败）。每次最多 5 个、并发最多 2 个是**前端**的组合规则
 *    （`ticket-limits.ts` 的两个常量），服务端只把住单次请求的形状与单文件大小。
 * 2. **文件名由服务端归一**（`sanitizeAttachmentName`）：multipart 的 filename 是客户端输入，它会进上游的
 *    `?name=` 与下载响应的 `Content-Disposition`。路由只做搬运，归一与上限都在领域服务里。
 * 3. **下载是字节流而不是 `/web` 信封**：`Content-Disposition` 在这里组装（附件名可能来自上游、含引号或
 *    中文），并把上游的 `Content-Type` 原样透传 + `nosniff`，让浏览器按真实类型保存文件而不是按我们
 *    猜的类型；`Content-Disposition: attachment` 同时封死「在站点源上内联渲染用户上传的 HTML」这条路。
 *
 * 归属校验不在本层：附件编号在**该工单的**元数据端点下读取（上游对不属于该工单的编号直接 404），因此
 * 「越权下载」在协议层无分支可写，判据只有一处。
 */

import { ValidationError, WebErrSchema } from "@fenix/platform-sdk";
import type { AnyElysia } from "elysia";
import type * as z from "zod/v4";
import { TicketDetailParamsSchema, TicketUncertainResponseSchema } from "../../../schemas/ticket.schema";
import {
  TicketAttachmentListResponseSchema,
  TicketAttachmentParamsSchema,
  TicketAttachmentResponseSchema,
} from "../../../schemas/ticket-attachment.schema";
import { getTicketsServerModule } from "../../runtime";
import { TICKET_ATTACHMENT_MAX_BYTES } from "../../services/ticket-limits";
import {
  requireTicketIdempotencyKey,
  TicketIdempotencyHeadersSchema,
  type TicketUploadFormData,
  type TicketUploadRequest,
  ticketHandler,
  ticketStreamHandler,
} from "./web-error";

/** 表单字段名（与前端约定，也是本路由唯一接受的字段）。 */
const UPLOAD_FIELD = "file";

/** 给用户看的大小上限文案；由字节上限推导，避免两处各写一个「10」。 */
const MAX_SIZE_MB = Math.floor(TICKET_ATTACHMENT_MAX_BYTES / (1024 * 1024));

/** 单文件上传的领域输入；`contentType` 缺席表示上游 multipart 没给类型（浏览器可以不给）。 */
interface AttachmentUploadInput {
  readonly name: string;
  readonly content: Uint8Array;
  readonly contentType?: string;
}

/**
 * 读取上传表单：恰好一个 `file` 部件。
 *
 * 读文件字节**之前**先按 `size` 判上限：超限时立即拒绝，不把 10 MiB 以上的内容读进内存再判——上限的意义
 * 一半就在这里。表单缺字段、多文件、出现纯字符串部件都当场 400（不猜用户意图）。
 */
async function readAttachmentUpload(request: TicketUploadRequest): Promise<AttachmentUploadInput> {
  let form: TicketUploadFormData;
  try {
    form = await request.formData();
  } catch {
    throw new ValidationError("上传表单解析失败：请以 multipart/form-data 提交");
  }

  const files = form.getAll(UPLOAD_FIELD).filter((item) => typeof item !== "string");
  if (files.length === 0) throw new ValidationError(`缺少上传字段 ${UPLOAD_FIELD}`);
  if (files.length > 1) throw new ValidationError(`一次请求只能上传一个文件（字段 ${UPLOAD_FIELD}）`);

  const file = files[0];
  if (file.size > TICKET_ATTACHMENT_MAX_BYTES) {
    throw new ValidationError(`附件超过大小上限（${MAX_SIZE_MB} MB）`);
  }
  // Bun 对空 multipart filename 返回 undefined（而非空串），兜底为空串让服务的归一校验给出 400 而不是 500。
  const name = file.name ?? "";
  const contentType = file.type.length > 0 ? file.type : undefined;
  return {
    name,
    content: new Uint8Array(await file.arrayBuffer()),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

/**
 * 下载响应的 `Content-Disposition`：ASCII 回退 + RFC 5987 的 UTF-8 形式。
 *
 * 两个值都给的理由：只给 `filename*` 时老客户端会存成 URL 编码的乱码，只给 ASCII 回退时中文名会变成一串
 * 下划线。附件名来自上游（可能是别人直接在托管平台上挂的），因此这里按不可信输入处理：控制字符与非 ASCII
 * 在回退值里一律替换，`filename*` 走 `encodeURIComponent`（它会把 CR/LF 也编码掉，响应头注入随之封死）。
 */
function contentDispositionAttachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${fallback.length === 0 ? "attachment" : fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 上游给的 MIME 只透传「像媒体类型」的值：头值里出现控制字符会让 `Headers.set` 直接抛错（500）。 */
function safeContentType(value: string | null): string {
  if (value === null || !/^[\x20-\x7e]+$/.test(value)) return "application/octet-stream";
  return value;
}

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
        "Content-Disposition": contentDispositionAttachment(download.attachment.name),
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
