import { CloudDriveError, invalidRequestError } from "../client/cloud-drive-error";
import type { CloudDriveGateway } from "../client/cloud-drive-gateway";
import type {
  CloudDriveConversionJob,
  CloudDriveFile,
  CloudDriveMarkdownPage,
  CloudDrivePreviewManifest,
} from "../schemas/cloud-drive.schema";

/**
 * 预览类动作的应用编排：markdown 分页、栅格清单、页图与重新转换。
 *
 * 这些动作共同依赖「先读元数据」：上游对未转换、跨版本、已删除一律返回 404，只有结合元数据的
 * `conversion.status` / `currentVersionId` 才能把同一种 404 翻译成前端可区分的错误码，并把页图请求
 * 必须的 `version_id` 补齐。写成独立模块而不是继续堆进 `cloud-drive-facade.ts`，是为了让「预览契约」
 * 与其它 CRUD 编排各自保持可读。
 */

/** 单次 markdown 响应的字节上限；上游每页约 64KiB，256KiB 只用于防御上游分页契约漂移。 */
export const MAX_MARKDOWN_PAGE_BYTES = 256 * 1024;

export interface MarkdownCommand {
  /** 上一页返回的 nextCursor；省略表示第一页。 */
  readonly cursor?: string;
}

export interface PreviewPageCommand {
  /** 页号，从 1 开始。 */
  readonly page: number;
  /** 显式版本；省略时用元数据的 currentVersionId。 */
  readonly versionId?: string;
}

/** 页图响应与缓存依据。 */
export interface CloudDrivePreviewPageContent {
  readonly response: Response;
  readonly versionId: string;
  /**
   * 只有调用方显式给出版本时才能按版本缓存：用当前版本补齐的 URL 不含版本号，缓存会跨版本命中。
   */
  readonly cacheable: boolean;
}

/**
 * 按 UTF-8 字节截断 markdown 一页。
 *
 * 正常不会触发（上游页约 64KiB）；一旦上游改变分页契约，截断至少能保证响应体有界。截断时保留上游
 * 游标，前端继续取下一页，不会陷入「同一页反复截断」。
 */
export function capMarkdownPage(
  markdown: string,
  maxBytes: number = MAX_MARKDOWN_PAGE_BYTES,
): { readonly content: string; readonly truncated: boolean } {
  const encoder = new TextEncoder();
  if (encoder.encode(markdown).byteLength <= maxBytes) return { content: markdown, truncated: false };

  // 二分查找「不超过上限的最长前缀」；代价是一次编码全量 + log(n) 次前缀编码。
  let low = 0;
  let high = markdown.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(markdown.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // 不要把代理对切成孤立的高位代理，否则前端会渲染出替换字符。
  if (low > 0 && isHighSurrogate(markdown.charCodeAt(low - 1))) low -= 1;
  return { content: markdown.slice(0, low), truncated: true };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

/** 读元数据并拒绝目录：预览只对文件有意义。 */
async function readPreviewableFile(
  gateway: CloudDriveGateway,
  subject: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<CloudDriveFile> {
  const file = await gateway.getFile(subject, fileId, signal);
  if (file.kind !== "file") throw invalidRequestError("CLOUD_DRIVE_NOT_A_FILE", "目录不支持预览");
  return file;
}

/**
 * 把「产物不存在」翻译成可区分的原因。
 *
 * 上游对未转换与转换失败都返回 404；转换失败（如缺 OCR 的图片）重试不会成功，前端应展示原因而不是
 * 继续轮询。已删除/跨用户的 404 在元数据读取阶段就已失败，不会走到这里。
 */
function explainArtifactMissing(error: unknown, file: CloudDriveFile): unknown {
  if (!(error instanceof CloudDriveError) || error.kind !== "not-found") return error;
  const details = { cause: error, upstreamStatus: error.upstreamStatus, upstreamCode: error.upstreamCode };
  const status = file.conversion?.status ?? null;
  if (status === "failed" || status === "blocked") {
    return new CloudDriveError("unprocessable", "CLOUD_DRIVE_PREVIEW_FAILED", "文件无法转换为可预览内容", details);
  }
  return new CloudDriveError("not-found", "CLOUD_DRIVE_PREVIEW_NOT_READY", "文件尚未转换完成", details);
}

/** 读取 markdown 一页：元数据用于补齐转换状态与解释 404，正文交给上游分页。 */
export async function readMarkdownPage(
  gateway: CloudDriveGateway,
  subject: string,
  fileId: string,
  command: MarkdownCommand,
  signal?: AbortSignal,
): Promise<CloudDriveMarkdownPage> {
  const file = await readPreviewableFile(gateway, subject, fileId, signal);
  let page: Omit<CloudDriveMarkdownPage, "conversionStatus" | "truncated">;
  try {
    page = await gateway.getMarkdown(subject, fileId, { cursor: command.cursor }, signal);
  } catch (error) {
    throw explainArtifactMissing(error, file);
  }
  const capped = capMarkdownPage(page.content);
  return {
    content: capped.content,
    nextCursor: page.nextCursor,
    versionId: page.versionId,
    conversionStatus: file.conversion?.status ?? null,
    truncated: capped.truncated,
  };
}

/** 读取栅格页清单；页图 URL 不下发，前端只拿页号。 */
export async function readPreviewManifest(
  gateway: CloudDriveGateway,
  subject: string,
  fileId: string,
  signal?: AbortSignal,
): Promise<CloudDrivePreviewManifest> {
  const file = await readPreviewableFile(gateway, subject, fileId, signal);
  let manifest: Omit<CloudDrivePreviewManifest, "conversionStatus">;
  try {
    manifest = await gateway.getPreview(subject, fileId, signal);
  } catch (error) {
    throw explainArtifactMissing(error, file);
  }
  return { ...manifest, conversionStatus: file.conversion?.status ?? null };
}

/** 打开页图；版本号缺失时用元数据的 currentVersionId 补齐。 */
export async function openPreviewPage(
  gateway: CloudDriveGateway,
  subject: string,
  fileId: string,
  command: PreviewPageCommand,
  signal?: AbortSignal,
): Promise<CloudDrivePreviewPageContent> {
  const file = await readPreviewableFile(gateway, subject, fileId, signal);
  if (!Number.isInteger(command.page) || command.page < 1) {
    throw invalidRequestError("CLOUD_DRIVE_PAGE_INVALID", "预览页码必须是正整数");
  }
  const explicitVersion = command.versionId?.trim() ?? "";
  const versionId = explicitVersion || file.currentVersionId;
  if (!versionId) throw invalidRequestError("CLOUD_DRIVE_NO_VERSION", "文件没有可预览的版本");

  try {
    const response = await gateway.openPreviewPage(subject, fileId, { page: command.page, versionId }, signal);
    return { response, versionId, cacheable: explicitVersion !== "" };
  } catch (error) {
    if (error instanceof CloudDriveError && error.kind === "not-found") {
      throw new CloudDriveError("not-found", "CLOUD_DRIVE_PREVIEW_PAGE_NOT_FOUND", "预览页不存在或尚未生成", {
        cause: error,
        upstreamStatus: error.upstreamStatus,
        upstreamCode: error.upstreamCode,
      });
    }
    throw error;
  }
}

/**
 * 为失败或未完成的转换重新排队。
 *
 * 正在转换或已经就绪时拒绝：前者会造成重复任务，后者没有意义。上游只接受 `idempotency_key`，
 * 任务进度只能通过轮询文件元数据观察（`GET /v1/operations/{job}` 实测 404）。
 */
export async function retryConversion(
  gateway: CloudDriveGateway,
  subject: string,
  fileId: string,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<CloudDriveConversionJob> {
  const file = await readPreviewableFile(gateway, subject, fileId, signal);
  if (!file.currentVersionId) throw invalidRequestError("CLOUD_DRIVE_NO_VERSION", "文件没有可转换的版本");
  const status = file.conversion?.status ?? null;
  if (status === "queued" || status === "processing") {
    throw new CloudDriveError("conflict", "CLOUD_DRIVE_CONVERSION_IN_PROGRESS", "文件正在转换中，请稍候");
  }
  if (status === "ready") {
    throw new CloudDriveError("conflict", "CLOUD_DRIVE_CONVERSION_NOT_NEEDED", "文件已转换完成，无需重新转换");
  }
  return gateway.requestConversion(subject, fileId, { idempotencyKey }, signal);
}
