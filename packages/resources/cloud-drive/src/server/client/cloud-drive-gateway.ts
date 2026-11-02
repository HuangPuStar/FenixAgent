import type {
  CloudDriveAbandonResult,
  CloudDriveConversionJob,
  CloudDriveFile,
  CloudDriveFilePage,
  CloudDriveMarkdownPage,
  CloudDriveMutation,
  CloudDrivePreviewManifest,
  CloudDrivePrincipal,
  CloudDriveSearchPage,
  CloudDriveTrashPage,
  CloudDriveUpload,
  CloudDriveUploadResult,
  CloudDriveUploadStatus,
  CloudDriveVersionPage,
} from "../schemas/cloud-drive.schema";

/**
 * CloudDrive 出站能力的窄接口（Facade 的依赖面）。
 *
 * 每个方法都显式接收 `subject`：调用方只能把**服务端会话派生**的 Fenix userId 传进来，路由参数 /
 * 请求体 / 查询串都没有进入这里的通道。Facade 只依赖本接口，测试用内存替身即可覆盖 actor 隔离，
 * 不需要起 HTTP 服务。
 */
export interface CloudDriveGateway {
  getMe(subject: string, signal?: AbortSignal): Promise<CloudDrivePrincipal>;
  listFiles(subject: string, input: ListFilesInput, signal?: AbortSignal): Promise<CloudDriveFilePage>;
  getFile(subject: string, fileId: string, signal?: AbortSignal): Promise<CloudDriveFile>;
  listVersions(subject: string, fileId: string, signal?: AbortSignal): Promise<CloudDriveVersionPage>;
  getMarkdown(
    subject: string,
    fileId: string,
    input: MarkdownInput,
    signal?: AbortSignal,
  ): Promise<Omit<CloudDriveMarkdownPage, "conversionStatus" | "truncated">>;
  getPreview(
    subject: string,
    fileId: string,
    signal?: AbortSignal,
  ): Promise<Omit<CloudDrivePreviewManifest, "conversionStatus">>;
  openPreviewPage(subject: string, fileId: string, input: PreviewPageInput, signal?: AbortSignal): Promise<Response>;
  requestConversion(
    subject: string,
    fileId: string,
    input: RequestConversionInput,
    signal?: AbortSignal,
  ): Promise<CloudDriveConversionJob>;
  openContent(subject: string, fileId: string, input: ContentInput, signal?: AbortSignal): Promise<Response>;
  createDirectory(subject: string, input: CreateDirectoryInput, signal?: AbortSignal): Promise<CloudDriveMutation>;
  moveFile(subject: string, fileId: string, input: MoveFileInput, signal?: AbortSignal): Promise<CloudDriveMutation>;
  deleteFile(
    subject: string,
    fileId: string,
    input: DeleteFileInput,
    signal?: AbortSignal,
  ): Promise<CloudDriveMutation>;
  listTrash(subject: string, signal?: AbortSignal): Promise<CloudDriveTrashPage>;
  restoreTrash(
    subject: string,
    trashId: string,
    input: RestoreTrashInput,
    signal?: AbortSignal,
  ): Promise<CloudDriveMutation>;
  search(subject: string, input: SearchInput, signal?: AbortSignal): Promise<CloudDriveSearchPage>;
  beginUpload(subject: string, input: BeginUploadInput, signal?: AbortSignal): Promise<CloudDriveUpload>;
  statUpload(subject: string, uploadId: string, signal?: AbortSignal): Promise<CloudDriveUploadStatus>;
  patchUpload(
    subject: string,
    uploadId: string,
    input: PatchUploadInput,
    signal?: AbortSignal,
  ): Promise<CloudDriveUploadStatus>;
  finalizeUpload(subject: string, uploadId: string, signal?: AbortSignal): Promise<CloudDriveUploadResult>;
  abandonUpload(subject: string, uploadId: string, signal?: AbortSignal): Promise<CloudDriveAbandonResult>;
}

export interface ListFilesInput {
  readonly parentId?: string;
  readonly cursor?: string;
}

export interface ContentInput {
  /** 下载指定历史版本；省略表示当前版本。 */
  readonly versionId?: string;
  /** 单个字节区间（`bytes=start-end`）；上游不支持多段与后缀区间。 */
  readonly range?: string;
}

export interface MarkdownInput {
  /** 上一页返回的 `next_cursor`；省略表示第一页。 */
  readonly cursor?: string;
}

export interface PreviewPageInput {
  /** 页号，从 1 开始。 */
  readonly page: number;
  /**
   * 上游必须收到 `version_id`，缺失会按 404 处理。
   * 该值由 Facade 从元数据 `currentVersionId` 补齐，不能依赖调用方总是传入。
   */
  readonly versionId: string;
}

export interface RequestConversionInput {
  readonly idempotencyKey: string;
}

export interface CreateDirectoryInput {
  readonly name: string;
  /** 省略或 null 表示根目录。 */
  readonly parentId?: string | null;
  readonly idempotencyKey: string;
}

export interface MoveFileInput {
  readonly name: string;
  /** 目标父目录；null 表示根目录。 */
  readonly parentId: string | null;
  readonly expectedMetadataRevision: number;
  readonly idempotencyKey: string;
}

export interface DeleteFileInput {
  readonly expectedMetadataRevision: number;
  readonly idempotencyKey: string;
}

export interface RestoreTrashInput {
  readonly expectedMetadataRevision: number;
  readonly parentId?: string | null;
  readonly name?: string;
  readonly idempotencyKey: string;
}

export interface SearchInput {
  readonly query: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface BeginUploadInput {
  readonly name: string;
  readonly sizeBytes: number;
  readonly contentType?: string;
  readonly parentId?: string | null;
  /** 覆盖写目标；存在时必须同时给出 expectedVersionId / expectedMetadataRevision。 */
  readonly fileId?: string;
  readonly expectedVersionId?: string;
  readonly expectedMetadataRevision?: number;
  readonly idempotencyKey: string;
}

export interface PatchUploadInput {
  readonly offset: number;
  /** 本片原始字节；长度必须等于请求的 Content-Length。 */
  readonly chunk: Uint8Array<ArrayBuffer>;
}
