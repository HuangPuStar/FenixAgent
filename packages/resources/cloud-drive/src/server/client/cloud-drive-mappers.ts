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
  CloudDriveVersionPage,
} from "../schemas/cloud-drive.schema";
import type {
  WireAbandonResult,
  WireConversionJob,
  WireFile,
  WireFilePage,
  WireMarkdown,
  WireMe,
  WireMutation,
  WirePreview,
  WireSearchPage,
  WireTrashPage,
  WireUpload,
  WireUploadResult,
  WireVersionPage,
} from "./cloud-drive-wire";

/**
 * 上游行 → Fenix DTO。
 *
 * 边界在这里完成，而不是把 `to_jsonb` 的行原样透传：`owner_id` / `space_id` / `native_*` /
 * `reserved_location` / `operation_id` 等字段对前端没有意义，原样返回等于把 CloudDrive 的内部
 * 数据模型变成 Fenix 的对外契约，上游改表就会打断前端。
 */

/** 单个文件/目录。`size_bytes` 是上游为列表/详情补的别名，缺失时退回 `size`。 */
export function toCloudDriveFile(wire: WireFile): CloudDriveFile {
  return {
    id: wire.id,
    parentId: wire.parent_id ?? null,
    name: wire.name,
    path: wire.path,
    kind: wire.kind,
    lifecycle: wire.lifecycle,
    sizeBytes: wire.size_bytes ?? wire.size ?? 0,
    contentType: wire.content_type ?? "application/octet-stream",
    currentVersionId: wire.current_version_id ?? null,
    metadataRevision: wire.metadata_revision,
    createdAt: wire.created_at ?? null,
    updatedAt: wire.updated_at ?? null,
    conversion: wire.conversion
      ? {
          status: wire.conversion.status ?? null,
          errorCode: wire.conversion.error_code ?? null,
          completeness: wire.conversion.completeness ?? null,
        }
      : null,
  };
}

export function toCloudDriveFilePage(wire: WireFilePage): CloudDriveFilePage {
  return { items: wire.items.map(toCloudDriveFile), nextCursor: wire.next_cursor ?? null };
}

export function toCloudDriveVersionPage(wire: WireVersionPage): CloudDriveVersionPage {
  return {
    items: wire.items.map((version) => ({
      id: version.id,
      fileId: version.file_id,
      versionSeq: version.version_seq,
      sizeBytes: version.size ?? 0,
      contentType: version.content_type ?? "application/octet-stream",
      committedAt: version.committed_at ?? null,
      conversionStatus: version.conversion_status ?? null,
    })),
  };
}

/** markdown 一页；`conversionStatus` 与截断标记由 Facade 结合元数据补齐。 */
export function toCloudDriveMarkdownPage(
  wire: WireMarkdown,
): Omit<CloudDriveMarkdownPage, "conversionStatus" | "truncated"> {
  return { content: wire.markdown, nextCursor: wire.next_cursor ?? null, versionId: wire.version_id };
}

/** 页清单只保留页号：上游 `url` 含内部路径，浏览器一律经 `/web` 取图。 */
export function toCloudDrivePreviewManifest(wire: WirePreview): Omit<CloudDrivePreviewManifest, "conversionStatus"> {
  const pages = [...new Set(wire.pages.map((page) => page.page))].sort((left, right) => left - right);
  return { versionId: wire.version_id, pageCount: pages.length, pages };
}

export function toCloudDriveConversionJob(wire: WireConversionJob): CloudDriveConversionJob {
  return { jobId: wire.id, state: wire.state, sourceVersionId: wire.source_version_id };
}

export function toCloudDriveTrashPage(wire: WireTrashPage): CloudDriveTrashPage {
  return {
    items: wire.items.map((entry) => ({
      id: entry.id,
      rootFileId: entry.root_file_id,
      originalParentId: entry.original_parent_id ?? null,
      originalName: entry.original_name,
      originalPath: entry.original_path,
      deletedAt: entry.deleted_at ?? null,
      restoredAt: entry.restored_at ?? null,
      state: entry.state,
      file: toCloudDriveFile(entry.file),
    })),
  };
}

export function toCloudDriveSearchPage(wire: WireSearchPage): CloudDriveSearchPage {
  return {
    items: wire.items.map((hit) => ({
      fileId: hit.file_id,
      path: hit.path,
      snippet: hit.snippet,
      location: { page: hit.location.page ?? null, block: hit.location.block ?? null },
      completeness: {
        status: hit.completeness.status ?? null,
        missingTextPages: hit.completeness.missing_text_pages ?? null,
      },
      stale: hit.stale,
      currentVersionId: hit.current_version_id ?? null,
      returnedVersionId: hit.returned_version_id ?? null,
      newerVersionStatus: hit.newer_version_status ?? null,
    })),
    nextCursor: wire.next_cursor ?? null,
  };
}

/** `display_name` 在上游就是主体标识（Fenix userId），不是人类可读昵称。 */
export function toCloudDrivePrincipal(wire: WireMe): CloudDrivePrincipal {
  return {
    subject: wire.display_name ?? wire.id,
    quota: {
      limitBytes: wire.quota.limit_bytes,
      usedBytes: wire.quota.used_bytes,
      reservedBytes: wire.quota.reserved_bytes,
      updatedAt: wire.quota.updated_at ?? null,
    },
  };
}

export function toCloudDriveMutation(wire: WireMutation): CloudDriveMutation {
  return {
    operationId: wire.operation_id,
    fileId: wire.file_id,
    state: wire.state,
    errorCode: wire.error_code ?? null,
    compensated: wire.compensated === true,
    message: wire.message ?? null,
    file: wire.file ? toCloudDriveFile(wire.file) : null,
  };
}

export function toCloudDriveUpload(wire: WireUpload): CloudDriveUpload {
  return {
    uploadId: wire.id,
    fileId: wire.file_id,
    operationId: wire.operation_id,
    status: wire.status,
    expiresAt: wire.expires_at ?? null,
  };
}

export function toCloudDriveUploadResult(wire: WireUploadResult): CloudDriveUploadResult {
  return { fileId: wire.file_id, versionId: wire.version_id, status: wire.status };
}

export function toCloudDriveAbandonResult(wire: WireAbandonResult): CloudDriveAbandonResult {
  return { uploadId: wire.upload_id, fileId: wire.file_id, status: wire.status };
}
