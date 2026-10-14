/**
 * 附件的**协议层公共设施**（`/web/tickets/:projectId/:number/attachments*` 与 `/api/system/tickets/...` 共用）：
 * multipart 上传的读取与下载响应的头组装。
 *
 * 为什么单独成文件而不是各面各写一份：这里全是**安全相关**的边界，两份实现会立刻分叉出两个不同的上限或两个
 * 不同的响应头。
 *
 * 1. **上传是 multipart，没有 body schema**。字段名固定 `file`，一次请求**只收一个文件**：一次请求对应一次
 *    远端写入与一个幂等键（账本的不变量），多文件必须先拆成多请求——否则「第 3 个文件被上游拒绝」会让前两个
 *    的落库状态无处安放（既不是全成功也不是全失败）。每次最多 5 个、并发最多 2 个是**前端**的组合规则
 *    （`ticket-limits.ts` 的两个常量），服务端只把住单次请求的形状与单文件大小。
 * 2. **文件名由服务端归一**（`sanitizeAttachmentName`，在领域服务里）：multipart 的 filename 是客户端输入，
 *    它会进上游的 `?name=` 与下载响应的 `Content-Disposition`。路由只做搬运，归一与上限都在领域服务里。
 * 3. **下载是字节流而不是信封**：`Content-Disposition` 在这里组装（附件名可能来自上游、含引号或中文），并把
 *    上游的 `Content-Type` 原样透传 + `nosniff`，让浏览器按真实类型保存文件而不是按我们猜的类型；
 *    `Content-Disposition: attachment` 同时封死「在站点源上内联渲染用户上传的 HTML」这条路。
 *
 * 归属校验不在协议层：附件编号在**该工单的**元数据端点下读取（上游对不属于该工单的编号直接 404），因此
 * 「越权下载」在协议层无分支可写，判据只有一处。
 */

import { ValidationError } from "@fenix/platform-sdk";
import { TICKET_ATTACHMENT_MAX_BYTES } from "../services/ticket-limits";
import type { TicketUploadRequest } from "./ticket-request-protocol";

/** 表单字段名（与前端约定，也是本模块唯一接受的字段）。 */
export const UPLOAD_FIELD = "file";

/** 给用户看的大小上限文案；由字节上限推导，避免两处各写一个「10」。 */
export const MAX_SIZE_MB = Math.floor(TICKET_ATTACHMENT_MAX_BYTES / (1024 * 1024));

/** 单文件上传的领域输入；`contentType` 缺席表示上游 multipart 没给类型（浏览器可以不给）。 */
export interface AttachmentUploadInput {
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
export async function readAttachmentUpload(request: TicketUploadRequest): Promise<AttachmentUploadInput> {
  let form: Awaited<ReturnType<TicketUploadRequest["formData"]>>;
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
 * 附件响应的 `Content-Disposition`：ASCII 回退 + RFC 5987 的 UTF-8 形式。
 *
 * 两个值都给的理由：只给 `filename*` 时老客户端会存成 URL 编码的乱码，只给 ASCII 回退时中文名会变成一串
 * 下划线。附件名来自上游（可能是别人直接在托管平台上挂的），因此这里按不可信输入处理：控制字符与非 ASCII
 * 在回退值里一律替换，`filename*` 走 `encodeURIComponent`（它会把 CR/LF 也编码掉，响应头注入随之封死）。
 *
 * `disposition` 由调用方按用途给出：`attachment` 是下载（`/web` 面的既有口径），`inline` 只用于**预览**
 * ——管理面的凭据是 `Authorization` 头，`<img src>` 带不上，前端只能先取回字节再展示，因此那条路径需要
 * 「不强制下载」的语义（见 `system-ticket-attachments.ts` 的文件头）。两种取值都封死在枚举里，不接受任意
 * 头值：`Content-Disposition` 是响应头，写入不受控字符串等于开放响应头注入面。
 */
export function attachmentContentDisposition(name: string, disposition: "attachment" | "inline"): string {
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${disposition}; filename="${fallback.length === 0 ? "attachment" : fallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 上游给的 MIME 只透传「像媒体类型」的值：头值里出现控制字符会让 `Headers.set` 直接抛错（500）。 */
export function safeContentType(value: string | null): string {
  if (value === null || !/^[\x20-\x7e]+$/.test(value)) return "application/octet-stream";
  return value;
}
