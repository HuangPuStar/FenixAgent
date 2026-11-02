import type * as z from "zod/v4";
import type { CloudDriveModuleConfig } from "../config";
import { notConfiguredError } from "./cloud-drive-error";
import type {
  BeginUploadInput,
  CloudDriveGateway,
  ContentInput,
  CreateDirectoryInput,
  DeleteFileInput,
  ListFilesInput,
  MarkdownInput,
  MoveFileInput,
  PatchUploadInput,
  PreviewPageInput,
  RequestConversionInput,
  RestoreTrashInput,
  SearchInput,
} from "./cloud-drive-gateway";
import {
  toCloudDriveAbandonResult,
  toCloudDriveConversionJob,
  toCloudDriveFile,
  toCloudDriveFilePage,
  toCloudDriveMarkdownPage,
  toCloudDriveMutation,
  toCloudDrivePreviewManifest,
  toCloudDrivePrincipal,
  toCloudDriveSearchPage,
  toCloudDriveTrashPage,
  toCloudDriveUpload,
  toCloudDriveUploadResult,
  toCloudDriveVersionPage,
} from "./cloud-drive-mappers";
import {
  type CloudDriveDiagnostic,
  type CloudDriveDiagnosticHandler,
  type CloudDriveFetch,
  CloudDriveTransport,
  type JsonRequest,
} from "./cloud-drive-transport";
import {
  WireAbandonResultSchema,
  WireConversionJobSchema,
  WireFilePageSchema,
  WireFileResponseSchema,
  WireMarkdownSchema,
  WireMeSchema,
  WireMutationSchema,
  WirePreviewSchema,
  WireSearchPageSchema,
  WireTrashPageSchema,
  WireUploadResultSchema,
  WireUploadSchema,
  WireVersionPageSchema,
} from "./cloud-drive-wire";

export type { CloudDriveDiagnostic, CloudDriveDiagnosticHandler, CloudDriveFetch };

/** 解析后的出站配置：基址与 master key 必填。 */
export interface CloudDriveClientConfig {
  readonly baseUrl: string;
  readonly masterKey: string;
  readonly keyId?: string;
  readonly timeoutMs: number;
}

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
 * 无状态、可安全地按请求创建；认证头、超时、错误分类与响应形状校验全部在
 * {@link CloudDriveTransport}（所有出站请求的唯一通道）。本类只负责端点路径与线上形状 → Fenix DTO
 * 的映射。
 */
export class CloudDriveClient implements CloudDriveGateway {
  private readonly transport: CloudDriveTransport;

  constructor(options: CloudDriveClientOptions) {
    this.transport = new CloudDriveTransport({
      ...options.config,
      fetchImpl: options.fetchImpl,
      onDiagnostic: options.onDiagnostic,
    });
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

  async getMarkdown(subject: string, fileId: string, input: MarkdownInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "getMarkdown",
      {
        method: "GET",
        path: `/v1/files/${encodeURIComponent(fileId)}/markdown`,
        query: { cursor: input.cursor },
        signal,
      },
      WireMarkdownSchema,
    );
    return toCloudDriveMarkdownPage(wire);
  }

  async getPreview(subject: string, fileId: string, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "getPreview",
      { method: "GET", path: `/v1/preview/${encodeURIComponent(fileId)}`, signal },
      WirePreviewSchema,
    );
    return toCloudDrivePreviewManifest(wire);
  }

  /** 打开页图流；上游必须收到 `version_id`，缺失会返回 404。 */
  async openPreviewPage(
    subject: string,
    fileId: string,
    input: PreviewPageInput,
    signal?: AbortSignal,
  ): Promise<Response> {
    return this.transport.openStream(subject, "openPreviewPage", {
      path: `/v1/preview/${encodeURIComponent(fileId)}/pages/${encodeURIComponent(String(input.page))}`,
      query: { version_id: input.versionId },
      accept: "image/png",
      signal,
    });
  }

  async requestConversion(subject: string, fileId: string, input: RequestConversionInput, signal?: AbortSignal) {
    const wire = await this.jsonRequest(
      subject,
      "requestConversion",
      {
        method: "POST",
        path: `/v1/files/${encodeURIComponent(fileId)}/conversions`,
        body: { idempotency_key: input.idempotencyKey },
        signal,
      },
      WireConversionJobSchema,
    );
    return toCloudDriveConversionJob(wire);
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
    return this.transport.tusRequest(subject, "statUpload", uploadId, { method: "HEAD", signal });
  }

  /** 转发一片 TUS 分片；`Content-Length` 按实际字节数强制发送，调用方无法省略。 */
  async patchUpload(subject: string, uploadId: string, input: PatchUploadInput, signal?: AbortSignal) {
    return this.transport.tusRequest(subject, "patchUpload", uploadId, {
      method: "PATCH",
      signal,
      chunk: input,
    });
  }

  /** 打开文件内容流；超时只覆盖到响应头。 */
  async openContent(subject: string, fileId: string, input: ContentInput, signal?: AbortSignal): Promise<Response> {
    return this.transport.openStream(subject, "openContent", {
      path: `/v1/files/${encodeURIComponent(fileId)}/content`,
      query: input.versionId ? { version_id: input.versionId } : undefined,
      accept: "*/*",
      range: input.range,
      signal,
    });
  }

  private jsonRequest<TSchema extends z.ZodType>(
    subject: string,
    operation: string,
    request: JsonRequest,
    schema: TSchema,
  ): Promise<z.output<TSchema>> {
    return this.transport.jsonRequest(subject, operation, request, schema);
  }
}
