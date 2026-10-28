import type * as z from "zod/v4";
import type { CloudDriveModuleConfig } from "../config";
import {
  CloudDriveError,
  invalidResponseError,
  notConfiguredError,
  transportError,
  upstreamError,
} from "./cloud-drive-error";
import type {
  BeginUploadInput,
  CloudDriveContent,
  CloudDriveGateway,
  ContentInput,
  CreateDirectoryInput,
  DeleteFileInput,
  ListFilesInput,
  MoveFileInput,
  PatchUploadInput,
  RestoreTrashInput,
  SearchInput,
} from "./cloud-drive-gateway";
import {
  createTimeoutSignal,
  parseJsonText,
  parseWire,
  readBoundedText,
  readTusHeaders,
  SUBJECT_PATTERN,
} from "./cloud-drive-http";
import {
  toCloudDriveAbandonResult,
  toCloudDriveFile,
  toCloudDriveFilePage,
  toCloudDriveMutation,
  toCloudDrivePrincipal,
  toCloudDriveSearchPage,
  toCloudDriveTrashPage,
  toCloudDriveUpload,
  toCloudDriveUploadResult,
  toCloudDriveVersionPage,
} from "./cloud-drive-mappers";
import {
  WireAbandonResultSchema,
  WireFilePageSchema,
  WireFileResponseSchema,
  WireMeSchema,
  WireMutationSchema,
  WireSearchPageSchema,
  WireTrashPageSchema,
  WireUploadResultSchema,
  WireUploadSchema,
  WireVersionPageSchema,
} from "./cloud-drive-wire";

/** 解析后的出站配置：基址与 master key 必填。 */
export interface CloudDriveClientConfig {
  readonly baseUrl: string;
  readonly masterKey: string;
  readonly keyId?: string;
  readonly timeoutMs: number;
}

/** 诊断事件；只含调用元数据，**不含** headers、body、master key 或下载票据。 */
export interface CloudDriveDiagnostic {
  readonly operation: string;
  readonly subject: string;
  readonly durationMs: number;
  readonly outcome: "ok" | "error";
  readonly status?: number;
  readonly code?: string;
}

export type CloudDriveDiagnosticHandler = (diagnostic: CloudDriveDiagnostic) => void;

/** fetch 的窄签名：`typeof fetch` 还带 `preconnect` 等静态成员，注入实现时无需伪造它们。 */
export type CloudDriveFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface CloudDriveClientOptions {
  readonly config: CloudDriveClientConfig;
  /** 注入 fetch 供单测替换；生产用全局 fetch。 */
  readonly fetchImpl?: CloudDriveFetch;
  readonly onDiagnostic?: CloudDriveDiagnosticHandler;
}

/** 把模块配置解析成 client 配置；缺基址或密钥时抛 `not-configured`。 */
export function resolveCloudDriveClientConfig(config: CloudDriveModuleConfig): CloudDriveClientConfig {
  const baseUrl = config.baseUrl?.trim();
  const masterKey = config.masterKey?.trim();
  if (!baseUrl || !masterKey) throw notConfiguredError();
  return {
    baseUrl,
    masterKey,
    keyId: config.keyId?.trim() || undefined,
    timeoutMs: config.timeoutMs,
  };
}

/**
 * CloudDrive REST 客户端。
 *
 * 无状态、可安全地按请求创建；所有认证头都在 {@link CloudDriveClient.baseHeaders} 一处生成，调用方
 * 无法覆盖 `Authorization` / `X-On-Behalf-Of`。超时与错误分类语义见 `cloud-drive-http` 与
 * `cloud-drive-error`。
 */
export class CloudDriveClient implements CloudDriveGateway {
  private readonly baseUrl: string;
  private readonly masterKey: string;
  private readonly keyId: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: CloudDriveFetch;
  private readonly onDiagnostic: CloudDriveDiagnosticHandler | undefined;

  constructor(options: CloudDriveClientOptions) {
    this.baseUrl = options.config.baseUrl.replace(/\/+$/, "");
    this.masterKey = options.config.masterKey;
    this.keyId = options.config.keyId;
    this.timeoutMs = options.config.timeoutMs;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.onDiagnostic = options.onDiagnostic;
  }

  async getMe(subject: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(subject, "getMe", { method: "GET", path: "/v1/me", signal }, WireMeSchema);
    return toCloudDrivePrincipal(wire);
  }

  async listFiles(subject: string, input: ListFilesInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "listFiles",
      {
        method: "GET",
        path: "/v1/files",
        query: { parent_id: input.parentId, cursor: input.cursor },
        signal,
      },
      WireFilePageSchema,
    );
    return toCloudDriveFilePage(wire);
  }

  async getFile(subject: string, fileId: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "getFile",
      { method: "GET", path: `/v1/files/${encodeURIComponent(fileId)}`, signal },
      WireFileResponseSchema,
    );
    return toCloudDriveFile(wire);
  }

  async listVersions(subject: string, fileId: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "listVersions",
      { method: "GET", path: `/v1/files/${encodeURIComponent(fileId)}/versions`, signal },
      WireVersionPageSchema,
    );
    return toCloudDriveVersionPage(wire);
  }

  async createDirectory(subject: string, input: CreateDirectoryInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "createDirectory",
      {
        method: "POST",
        path: "/v1/directories",
        body: {
          name: input.name,
          ...(input.parentId ? { parent_id: input.parentId } : {}),
          idempotency_key: input.idempotencyKey,
        },
        signal,
      },
      WireMutationSchema,
    );
    return toCloudDriveMutation(wire);
  }

  async moveFile(subject: string, fileId: string, input: MoveFileInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "moveFile",
      {
        method: "PATCH",
        path: `/v1/files/${encodeURIComponent(fileId)}/location`,
        body: {
          ...(input.parentId ? { parent_id: input.parentId } : {}),
          name: input.name,
          expected_metadata_revision: input.expectedMetadataRevision,
          idempotency_key: input.idempotencyKey,
        },
        signal,
      },
      WireMutationSchema,
    );
    return toCloudDriveMutation(wire);
  }

  async deleteFile(subject: string, fileId: string, input: DeleteFileInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "deleteFile",
      {
        method: "DELETE",
        path: `/v1/files/${encodeURIComponent(fileId)}`,
        body: {
          expected_metadata_revision: input.expectedMetadataRevision,
          idempotency_key: input.idempotencyKey,
        },
        signal,
      },
      WireMutationSchema,
    );
    return toCloudDriveMutation(wire);
  }

  async listTrash(subject: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "listTrash",
      { method: "GET", path: "/v1/trash", signal },
      WireTrashPageSchema,
    );
    return toCloudDriveTrashPage(wire);
  }

  async restoreTrash(subject: string, trashId: string, input: RestoreTrashInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "restoreTrash",
      {
        method: "POST",
        path: `/v1/trash/${encodeURIComponent(trashId)}/restore`,
        body: {
          expected_metadata_revision: input.expectedMetadataRevision,
          idempotency_key: input.idempotencyKey,
          // null 与省略语义不同：null = 恢复到根目录，省略 = 恢复到原目录。
          ...(input.parentId !== undefined ? { parent_id: input.parentId } : {}),
          ...(input.name ? { name: input.name } : {}),
        },
        signal,
      },
      WireMutationSchema,
    );
    return toCloudDriveMutation(wire);
  }

  async search(subject: string, input: SearchInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "search",
      {
        method: "POST",
        path: "/v1/search",
        body: { query: input.query, cursor: input.cursor, limit: input.limit },
        signal,
      },
      WireSearchPageSchema,
    );
    return toCloudDriveSearchPage(wire);
  }

  async beginUpload(subject: string, input: BeginUploadInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "beginUpload",
      {
        method: "POST",
        path: "/v1/uploads",
        body: {
          name: input.name,
          size_bytes: input.sizeBytes,
          ...(input.contentType ? { content_type: input.contentType } : {}),
          ...(input.parentId ? { parent_id: input.parentId } : {}),
          ...(input.fileId ? { file_id: input.fileId } : {}),
          ...(input.expectedVersionId ? { expected_version_id: input.expectedVersionId } : {}),
          ...(input.expectedMetadataRevision !== undefined
            ? { expected_metadata_revision: input.expectedMetadataRevision }
            : {}),
          idempotency_key: input.idempotencyKey,
        },
        signal,
      },
      WireUploadSchema,
    );
    return toCloudDriveUpload(wire);
  }

  async finalizeUpload(subject: string, uploadId: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "finalizeUpload",
      { method: "POST", path: `/v1/uploads/${encodeURIComponent(uploadId)}/finalize`, signal },
      WireUploadResultSchema,
    );
    return toCloudDriveUploadResult(wire);
  }

  async abandonUpload(subject: string, uploadId: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "abandonUpload",
      { method: "POST", path: `/v1/uploads/${encodeURIComponent(uploadId)}/abandon`, signal },
      WireAbandonResultSchema,
    );
    return toCloudDriveAbandonResult(wire);
  }

  /** 读取上传进度（TUS HEAD：状态与 offset 在响应头里，没有 body）。 */
  async statUpload(subject: string, uploadId: string, signal?: AbortSignal) {
    return this.tusRequest(subject, "statUpload", uploadId, { method: "HEAD", signal });
  }

  /** 转发一片 TUS 分片；`Content-Length` 按实际字节数强制发送，调用方无法省略。 */
  async patchUpload(subject: string, uploadId: string, input: PatchUploadInput, signal?: AbortSignal) {
    return this.tusRequest(subject, "patchUpload", uploadId, {
      method: "PATCH",
      signal,
      chunk: input,
    });
  }

  /**
   * 打开文件内容流。
   *
   * 超时只覆盖到响应头：大文件传输本身不应被请求超时打断；调用方的 `AbortSignal`（客户端断开）仍会
   * 中止整个请求。
   */
  async openContent(
    subject: string,
    fileId: string,
    input: ContentInput,
    signal?: AbortSignal,
  ): Promise<CloudDriveContent> {
    const startedAt = Date.now();
    const timeout = createTimeoutSignal(signal, this.timeoutMs);
    let status: number | undefined;
    let code: string | undefined;
    try {
      const headers = this.baseHeaders(subject);
      headers.Accept = "*/*";
      if (input.range) headers.Range = input.range;
      const response = await this.fetchImpl(
        this.url(
          `/v1/files/${encodeURIComponent(fileId)}/content`,
          input.versionId ? { version_id: input.versionId } : undefined,
        ),
        { method: "GET", headers, signal: timeout.signal },
      );
      status = response.status;
      if (!response.ok) throw upstreamError(response.status, parseJsonText(await readBoundedText(response)));
      if (!response.body) throw invalidResponseError();
      return response;
    } catch (error) {
      const failure = failureOf(error, timeout);
      code = failure.code;
      throw failure;
    } finally {
      // 只停计时器：下载流可能持续数分钟，客户端断开（外部 signal）仍要中止上游连接。
      timeout.clearTimeout();
      this.report({ operation: "openContent", subject, status, code, durationMs: Date.now() - startedAt });
    }
  }

  /** TUS HEAD/PATCH 的共同实现：认证头 + 进度头 + 统一错误分类。 */
  private async tusRequest(
    subject: string,
    operation: "statUpload" | "patchUpload",
    uploadId: string,
    request: { readonly method: "HEAD" | "PATCH"; readonly signal?: AbortSignal; readonly chunk?: PatchUploadInput },
  ) {
    const startedAt = Date.now();
    const timeout = createTimeoutSignal(request.signal, this.timeoutMs);
    let status: number | undefined;
    let code: string | undefined;
    try {
      const headers = this.baseHeaders(subject);
      const init: RequestInit = { method: request.method, headers, signal: timeout.signal };
      if (request.chunk) {
        headers["Tus-Resumable"] = "1.0.0";
        headers["Upload-Offset"] = String(request.chunk.offset);
        headers["Content-Type"] = "application/offset+octet-stream";
        headers["Content-Length"] = String(request.chunk.chunk.byteLength);
        init.body = request.chunk.chunk;
      }
      const response = await this.fetchImpl(this.url(`/v1/tus/${encodeURIComponent(uploadId)}`), init);
      status = response.status;
      if (!response.ok) throw upstreamError(response.status, parseJsonText(await readBoundedText(response)));
      return { uploadId, ...readTusHeaders(response) };
    } catch (error) {
      const failure = failureOf(error, timeout);
      code = failure.code;
      throw failure;
    } finally {
      timeout.clear();
      this.report({ operation, subject, status, code, durationMs: Date.now() - startedAt });
    }
  }

  /**
   * JSON 请求的统一入口：构造认证头、计时、错误分类与上游形状校验只在这里发生一次。
   *
   * 计时覆盖到响应体读完为止：JSON 响应很小，body 卡住同样属于失败。
   */
  private async jsonRequest<TSchema extends z.ZodType>(
    subject: string,
    operation: string,
    request: {
      readonly method: string;
      readonly path: string;
      readonly query?: Record<string, string | undefined>;
      readonly body?: unknown;
      readonly signal?: AbortSignal;
    },
    schema: TSchema,
  ): Promise<z.output<TSchema>> {
    const startedAt = Date.now();
    const timeout = createTimeoutSignal(request.signal, this.timeoutMs);
    let status: number | undefined;
    let code: string | undefined;
    try {
      const headers = this.baseHeaders(subject);
      headers.Accept = "application/json";
      const hasBody = request.body !== undefined;
      if (hasBody) headers["Content-Type"] = "application/json";
      const response = await this.fetchImpl(this.url(request.path, request.query), {
        method: request.method,
        headers,
        body: hasBody ? JSON.stringify(request.body) : undefined,
        signal: timeout.signal,
      });
      status = response.status;
      if (!response.ok) {
        throw upstreamError(response.status, parseJsonText(await readBoundedText(response)));
      }
      const text = await response.text();
      timeout.clear();
      const payload = parseJsonText(text);
      if (payload === undefined) throw invalidResponseError();
      return parseWire(schema, payload);
    } catch (error) {
      const failure = failureOf(error, timeout);
      code = failure.code;
      throw failure;
    } finally {
      timeout.clear();
      this.report({ operation, subject, status, code, durationMs: Date.now() - startedAt });
    }
  }

  /** 认证头：master key 与主体断言只在这里出现，调用方无法覆盖。 */
  private baseHeaders(subject: string): Record<string, string> {
    if (!SUBJECT_PATTERN.test(subject)) {
      throw new CloudDriveError("invalid", "CLOUD_DRIVE_SUBJECT_INVALID", "当前用户标识不适用于 CloudDrive");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.masterKey}`,
      "X-On-Behalf-Of": subject,
    };
    if (this.keyId) headers["X-Key-Id"] = this.keyId;
    return headers;
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== "") url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private report(event: Omit<CloudDriveDiagnostic, "outcome">): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic({ ...event, outcome: event.code ? "error" : "ok" });
    } catch {
      // 诊断回调是旁路：日志实现出错不得改变请求结果。
    }
  }
}

/** 已是 CloudDriveError 就原样返回，否则按网络/超时归类。 */
function failureOf(error: unknown, timeout: { didTimeout(): boolean }): CloudDriveError {
  return error instanceof CloudDriveError ? error : transportError(error, timeout.didTimeout());
}
