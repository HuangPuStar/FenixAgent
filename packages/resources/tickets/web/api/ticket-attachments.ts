/**
 * 附件域模块（`/web/tickets/:projectId/:number/attachments`）。
 *
 * 类型逐字段对应后端 `TicketAttachmentViewSchema` / `TicketAttachmentListResponseSchema` /
 * `TicketAttachmentResponseSchema`（本包 `src/schemas/ticket-attachment.schema.ts`）。三条只有附件才有的
 * 协议事实：
 *
 * - 视图只到 `attachmentId` 为止，**没有下载地址**：上游的内容地址带服务账号凭据，内容一律经本服务的下载
 *   端点代理，因此界面拿到的永远是本服务的 URL（`downloadUrl` 也只按本服务路径拼）。
 * - 上传是 multipart 单文件（字段名 `file`）：一次请求一个文件、一个幂等键，多文件必须由调用方拆请求——
 *   服务端对多文件 part 直接 400，不猜用户意图。
 * - 下载是字节流而不是 `/web` 信封：`request()` 会把响应体按 JSON 解析，没有二进制落点（既有能力缺口，
 *   `@fenix/resource-machine` 的 `web/api/fs.ts` 同样用裸 fetch 绕开），因此下载走本模块的独立函数。
 *
 * 与评论域同口径：幂等键由调用方（用户动作层）持有并跨重试复用，域模块不生成——否则每次调用都是新键，
 * 服务端的去重账本永远命中不了同一次动作。
 */

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import { ApiError, request } from "@fenix/web-runtime/api/request";
import { TICKET_ATTACHMENT_TIMEOUT_MS } from "../lib/ticket-attachment-limits";
import type { TicketWriteAccepted } from "./tickets";

/** 附件视图：`size` 是字节数，`createdAt` 可空（上游可能不给时间）。 */
export interface TicketAttachment {
  attachmentId: string;
  name: string;
  size: number;
  createdAt: string | null;
}

/** 上传成功（201）：附件本体 + 操作账本 ID。 */
export interface TicketAttachmentUploadOutcome {
  attachment: TicketAttachment;
  operationId: string;
}

/** 上传响应：201 附件本体，202 受理体（判别复用 T02 的类型守卫 `isUncertainAccepted`）。 */
export type TicketAttachmentUploadResult = TicketAttachmentUploadOutcome | TicketWriteAccepted;

/** 列表路径（与 `request()` 的 `:param` 插值口径一致）。 */
const ATTACHMENTS_PATH = "/web/tickets/:projectId/:number/attachments";

/** 下载端点的裸 URL（不经 `request()`：它只处理 `/web` 信封与 JSON）。 */
export function ticketAttachmentDownloadPath(projectId: string, number: string, attachmentId: string): string {
  const base = `/web/tickets/${encodeURIComponent(projectId)}/${encodeURIComponent(number)}/attachments`;
  return `${base}/${encodeURIComponent(attachmentId)}`;
}

/**
 * 上传表单：字段名固定 `file`，文件名原样带上（服务端会归一：取基名、去控制字符、限长）。
 *
 * 单独导出供用例断言字段名与文件名不被改写：multipart 的字段名与 `filename` 是这条协议里唯一由前端决定
 * 的部分，写错不会有类型错误，只会在上传时收到一个「缺少上传字段 file」的 400。
 */
export function buildTicketAttachmentForm(file: File): FormData {
  const form = new FormData();
  form.append("file", file, file.name);
  return form;
}

export const ticketAttachmentsApi = {
  /**
   * 取该工单的全部附件。列表**回源托管平台**：上游不可用时服务端报 503，不会退化成空列表，因此调用方
   * 必须保留失败态与重试入口。
   */
  list: (projectId: string, number: string): Promise<ApiResponse<{ items: TicketAttachment[] }>> =>
    request<{ items: TicketAttachment[] }>(ATTACHMENTS_PATH, { params: { projectId, number } }),

  /**
   * 上传单个附件。`idempotencyKey` 由调用方持有并跨重试复用（同键同内容返回原操作，同键不同内容 409）；
   * `signal` 用于用户主动取消——取消后服务端那次写入可能仍在途，因此取消不重发、由待确认态接管。
   */
  upload: (
    projectId: string,
    number: string,
    file: File,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResponse<TicketAttachmentUploadResult>> =>
    request<TicketAttachmentUploadResult>(ATTACHMENTS_PATH, {
      method: "POST",
      params: { projectId, number },
      body: buildTicketAttachmentForm(file),
      headers: { "Idempotency-Key": idempotencyKey },
      timeout: TICKET_ATTACHMENT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    }),
};

/**
 * 下载附件字节：成功返回 `Blob`（由调用方落盘），失败抛 `ApiError`（页面以 toast 呈现原因）。
 *
 * 取消与超时合并成一个 signal：用户离开页面或取消下载时立刻释放连接，不让一次 10 MiB 的传输在后台跑完。
 * 错误响应尽量取 `/web` 信封的稳定文案，取不到（网关错误页）时退回状态码——不把响应体原文当文案上屏。
 */
export async function downloadTicketAttachment(
  projectId: string,
  number: string,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const timeoutSignal = AbortSignal.timeout(TICKET_ATTACHMENT_TIMEOUT_MS);
  const response = await fetch(ticketAttachmentDownloadPath(projectId, number, attachmentId), {
    credentials: "include",
    signal: signal === undefined ? timeoutSignal : AbortSignal.any([signal, timeoutSignal]),
  });
  if (!response.ok) {
    let message = `下载失败 (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: { message?: string } };
      const detail = payload.error?.message;
      if (typeof detail === "string" && detail.length > 0) message = detail;
    } catch {
      // 非 JSON 响应保留状态码兜底文案。
    }
    throw new ApiError(message, response.status >= 500 ? "SERVER_ERROR" : "UNKNOWN");
  }
  return response.blob();
}

/** 把 Blob 落盘为 `name`：`<a download>` 是唯一不换页、也不经 XHR 的保存方式。 */
export function saveBlobAsFile(blob: Blob, name: string): void {
  const blobUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  try {
    anchor.href = blobUrl;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(blobUrl);
  }
}
