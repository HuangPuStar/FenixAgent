/**
 * 个人云盘的浏览器侧协议模型。
 *
 * 与服务端 `src/server/schemas/cloud-drive.schema.ts` 的 DTO 逐字段对应（camelCase、无上游内部标识）。
 * 这里刻意**不**从 `./server/schema` 转出类型：该出口会进入服务端 zod 模型，浏览器面不得依赖它
 * （依赖矩阵 `packages/resources/<resource>/web` 的禁则，见 engineering-standards §2.3）。
 *
 * 服务端新增字段时本文件需要同步——这是有意的双写：浏览器只依赖自己声明的契约，上游加列不会
 * 静默改变前端类型。
 */

/** 条目类型。 */
export type CloudDriveKind = "file" | "directory";

/** 条目生命周期；`active` 之外的状态对前端只读。 */
export type CloudDriveLifecycle = "active" | "deleting" | "trashed" | "restoring";

/** 文件或目录元数据。 */
export interface CloudDriveFile {
  id: string;
  parentId: string | null;
  name: string;
  path: string;
  kind: CloudDriveKind;
  lifecycle: CloudDriveLifecycle;
  sizeBytes: number;
  contentType: string;
  currentVersionId: string | null;
  metadataRevision: number;
  createdAt: string | null;
  updatedAt: string | null;
  conversion: {
    status: string | null;
    errorCode: string | null;
    completeness: Record<string, unknown> | null;
  } | null;
}

/** 目录列表的一页。 */
export interface CloudDriveFilePage {
  items: CloudDriveFile[];
  nextCursor: string | null;
}

/** 历史版本。 */
export interface CloudDriveVersion {
  id: string;
  fileId: string;
  versionSeq: number;
  sizeBytes: number;
  contentType: string;
  committedAt: string | null;
  conversionStatus: string | null;
}

/** 回收站条目。 */
export interface CloudDriveTrashEntry {
  id: string;
  rootFileId: string;
  originalParentId: string | null;
  originalName: string;
  originalPath: string;
  deletedAt: string | null;
  restoredAt: string | null;
  state: string;
  file: CloudDriveFile;
}

/** 片段内的命中区间；单位是 UTF-16 code unit，`[start, end)`。 */
export interface CloudDriveSearchSnippetMatch {
  start: number;
  end: number;
}

/** 纯文本片段；高亮由渲染层按 `matches` 切分，正文不含 HTML。 */
export interface CloudDriveSearchSnippet {
  text: string;
  matches: CloudDriveSearchSnippetMatch[];
  leadingEllipsis: boolean;
  trailingEllipsis: boolean;
}

/** 搜索命中的单个文件（服务端已把同一文件的多个 chunk 合并）。 */
export interface CloudDriveSearchFileResult {
  fileId: string;
  name: string;
  path: string;
  parentId: string | null;
  kind: CloudDriveKind;
  sizeBytes: number | null;
  updatedAt: string | null;
  snippets: CloudDriveSearchSnippet[];
  matchCount: number;
  location: { page: number | null; block: string | null };
  completeness: { status: string | null; missingTextPages: unknown };
  stale: boolean;
  currentVersionId: string | null;
  returnedVersionId: string | null;
  newerVersionStatus: string | null;
  snippet: string;
}

/** 搜索结果一页（按文件聚合）。 */
export interface CloudDriveSearchResultPage {
  items: CloudDriveSearchFileResult[];
  nextCursor: string | null;
  fileCount: number;
  matchCount: number;
}

/** 当前主体与配额（上限 / 已用 / 上传预留）。 */
export interface CloudDrivePrincipal {
  subject: string;
  quota: {
    limitBytes: number;
    usedBytes: number;
    reservedBytes: number;
    updatedAt: string | null;
  };
}

/** 变更类动作的结果；`state` 非 `committed` 表示尚未落定。 */
export interface CloudDriveMutation {
  operationId: string;
  fileId: string;
  state: "prepared" | "executing" | "outcome_unknown" | "remote_confirmed" | "committed" | "failed_confirmed";
  errorCode: string | null;
  compensated: boolean;
  message: string | null;
  file: CloudDriveFile | null;
}

/** 已创建的上传会话（刻意不含上游 `upload_url`）。 */
export interface CloudDriveUpload {
  uploadId: string;
  fileId: string;
  operationId: string;
  status: string;
  expiresAt: string | null;
}

/** 上传会话当前进度。 */
export interface CloudDriveUploadStatus {
  uploadId: string;
  offset: number;
  length: number;
}

/** 提交上传的结果。 */
export interface CloudDriveUploadResult {
  fileId: string;
  versionId: string;
  status: string;
}

/** 转换产物的 markdown 一页。 */
export interface CloudDriveMarkdownPage {
  content: string;
  nextCursor: string | null;
  versionId: string;
  conversionStatus: string | null;
  /** 服务端因单次响应上限截断；正常不会出现。 */
  truncated: boolean;
}

/** 栅格预览清单；页图请求必须带 `versionId`。 */
export interface CloudDrivePreviewManifest {
  versionId: string;
  pageCount: number;
  pages: number[];
  conversionStatus: string | null;
}

/** 重新转换任务摘要。 */
export interface CloudDriveConversionJob {
  jobId: string;
  state: string;
  sourceVersionId: string;
}

/** 面包屑节点；`id === null` 表示根目录。 */
export interface CloudDriveBreadcrumb {
  id: string | null;
  name: string;
}

/** 创建目录请求体。 */
export interface CreateCloudDriveDirectoryBody {
  name: string;
  parentId?: string | null;
}

/** 改名 / 移动请求体：两项至少给一项；`parentId: null` 表示根目录。 */
export interface MoveCloudDriveFileBody {
  name?: string;
  parentId?: string | null;
}

/** 从回收站恢复的请求体。 */
export interface RestoreCloudDriveTrashBody {
  expectedMetadataRevision: number;
  parentId?: string | null;
  name?: string;
}

/** 搜索请求体。 */
export interface SearchCloudDriveBody {
  query: string;
  cursor?: string;
  limit?: number;
}

/** 创建上传会话的请求体。 */
export interface BeginCloudDriveUploadBody {
  fileId?: string;
  parentId?: string | null;
  name?: string;
  sizeBytes: number;
  contentType?: string;
}
