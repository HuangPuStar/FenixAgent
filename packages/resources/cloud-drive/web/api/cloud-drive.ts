/**
 * 个人云盘域 API 模块：`/web/cloud-drive/*` 的唯一浏览器入口。
 *
 * 所有方法返回 `ApiResponse<T>`（`request()` 的契约），调用方必须 `unwrap()` 或显式判 `success`——
 * 4xx/5xx 在 `request()` 里是**正常返回的失败信封**，直接 `await` 并依赖 `catch` 会把失败当成功。
 *
 * 下载不经过本模块的 `request()`：浏览器要的是同源链接触发、由 `Content-Disposition` 决定文件名，
 * 因此只提供 URL 拼装（`contentUrl`），真正的字节流由服务端 `/web/cloud-drive/files/:id/content` 直出。
 */

import { request, UPLOAD_TIMEOUT_MS, unwrap } from "@fenix/web-runtime/api/request";
import type { CloudDriveUploadPort } from "../lib/upload";
import type {
  BeginCloudDriveUploadBody,
  CloudDriveConversionJob,
  CloudDriveFile,
  CloudDriveFilePage,
  CloudDriveMarkdownPage,
  CloudDriveMutation,
  CloudDrivePreviewManifest,
  CloudDrivePrincipal,
  CloudDriveSearchResultPage,
  CloudDriveTrashEntry,
  CloudDriveUpload,
  CloudDriveUploadResult,
  CloudDriveUploadStatus,
  CloudDriveVersion,
  CreateCloudDriveDirectoryBody,
  MoveCloudDriveFileBody,
  RestoreCloudDriveTrashBody,
  SearchCloudDriveBody,
} from "../types/cloud-drive";

export const cloudDriveApi = {
  /** 当前主体与配额。 */
  me: () => request<CloudDrivePrincipal>("/web/cloud-drive/me", { method: "GET" }),

  /** 列出目录内容；`parentId` 省略表示根目录。 */
  listFiles: (query: { parentId?: string; cursor?: string } = {}) =>
    request<CloudDriveFilePage>("/web/cloud-drive/files", { method: "GET", query }),

  /** 单个条目元数据。 */
  getFile: (id: string, options: { signal?: AbortSignal } = {}) =>
    request<CloudDriveFile>("/web/cloud-drive/files/:id", {
      method: "GET",
      params: { id },
      signal: options.signal,
    }),

  /** 文件历史版本。 */
  listVersions: (id: string) =>
    request<{ items: CloudDriveVersion[] }>("/web/cloud-drive/files/:id/versions", {
      method: "GET",
      params: { id },
    }),

  /**
   * markdown 预览的一页。
   *
   * `cursor` 原样回传上一页的 `nextCursor`；未转换时后端返回 404 `CLOUD_DRIVE_PREVIEW_NOT_READY`，
   * 调用方应轮询元数据而不是重试同一游标。
   */
  getMarkdown: (id: string, query: { cursor?: string } = {}, options: { signal?: AbortSignal } = {}) =>
    request<CloudDriveMarkdownPage>("/web/cloud-drive/files/:id/markdown", {
      method: "GET",
      params: { id },
      query,
      signal: options.signal,
    }),

  /** 栅格预览页清单（PDF / 图片）。Office 走 markdown，不调用这里。 */
  getPreview: (id: string, options: { signal?: AbortSignal } = {}) =>
    request<CloudDrivePreviewManifest>("/web/cloud-drive/files/:id/preview", {
      method: "GET",
      params: { id },
      signal: options.signal,
    }),

  /** 重新请求转换（失败重试）；正在转换或已就绪时后端返回 409。 */
  retryConversion: (id: string) =>
    request<CloudDriveConversionJob>("/web/cloud-drive/files/:id/conversions", {
      method: "POST",
      params: { id },
    }),

  /**
   * 页图地址：必须带 `versionId`，否则上游按 404 处理。
   *
   * 与下载一样用同源相对路径，由 `<img>` 直接加载（cookie 自动携带），不经 `request()`。
   */
  previewPageUrl: (id: string, page: number, versionId: string) =>
    `/web/cloud-drive/files/${encodeURIComponent(id)}/preview/pages/${page}?versionId=${encodeURIComponent(versionId)}`,

  /** 新建目录。 */
  createDirectory: (body: CreateCloudDriveDirectoryBody) =>
    request<CloudDriveMutation>("/web/cloud-drive/directories", { method: "POST", body }),

  /** 改名 / 移动（后端自动读取并提交当前 revision）。 */
  moveFile: (id: string, body: MoveCloudDriveFileBody) =>
    request<CloudDriveMutation>("/web/cloud-drive/files/:id/location", {
      method: "PATCH",
      params: { id },
      body,
    }),

  /** 移入回收站。 */
  deleteFile: (id: string) =>
    request<CloudDriveMutation>("/web/cloud-drive/files/:id", { method: "DELETE", params: { id } }),

  /** 回收站列表。 */
  listTrash: () => request<{ items: CloudDriveTrashEntry[] }>("/web/cloud-drive/trash", { method: "GET" }),

  /** 从回收站恢复；`expectedMetadataRevision` 取自条目的 `file.metadataRevision`。 */
  restoreTrash: (id: string, body: RestoreCloudDriveTrashBody) =>
    request<CloudDriveMutation>("/web/cloud-drive/trash/:id/restore", {
      method: "POST",
      params: { id },
      body,
    }),

  /** 关键词搜索（最终一致）。 */
  search: (body: SearchCloudDriveBody) =>
    request<CloudDriveSearchResultPage>("/web/cloud-drive/search", { method: "POST", body }),

  /** 创建 TUS 上传会话。 */
  beginUpload: (body: BeginCloudDriveUploadBody) =>
    request<CloudDriveUpload>("/web/cloud-drive/uploads", { method: "POST", body }),

  /** 查询上传进度（续传前的 offset 真相来源）。 */
  getUploadStatus: (uploadId: string) =>
    request<CloudDriveUploadStatus>("/web/cloud-drive/uploads/:id", {
      method: "GET",
      params: { id: uploadId },
    }),

  /**
   * 上传一个分片（原始 body）。
   *
   * `Content-Type` 由服务端固定；`Content-Length` 由浏览器根据 Blob 自动写入（前端无法也不应手动设置）。
   * `Upload-Offset` 必须与分片起点一致，否则服务端按 400 拒绝。
   */
  sendUploadChunk: (uploadId: string, offset: number, chunk: Blob) =>
    request<CloudDriveUploadStatus>("/web/cloud-drive/uploads/:id", {
      method: "PATCH",
      params: { id: uploadId },
      headers: { "upload-offset": String(offset) },
      body: chunk,
      timeout: UPLOAD_TIMEOUT_MS,
    }),

  /** 提交上传（幂等：已提交时返回同一结果）。 */
  finalizeUpload: (uploadId: string) =>
    request<CloudDriveUploadResult>("/web/cloud-drive/uploads/:id/finalize", {
      method: "POST",
      params: { id: uploadId },
    }),

  /** 放弃上传会话（失败或取消时调用；已结束的会话返回 404/410，调用方可忽略）。 */
  abandonUpload: (uploadId: string) =>
    request<{ uploadId: string; fileId: string; status: string }>("/web/cloud-drive/uploads/:id/abandon", {
      method: "POST",
      params: { id: uploadId },
    }),

  /**
   * 下载地址：同源相对路径，`Content-Disposition` 带真实文件名。
   *
   * 用相对路径而不是绝对 URL：控制台部署在 `/ctrl` 下、接口在站点根，相对路径天然跟随当前 origin，
   * 也不会把 cookie 送到别的域。
   */
  contentUrl: (id: string, versionId?: string) => {
    const query = versionId ? `?versionId=${encodeURIComponent(versionId)}` : "";
    return `/web/cloud-drive/files/${encodeURIComponent(id)}/content${query}`;
  },
};

/**
 * 把域 API 适配成分片上传编排的端口。
 *
 * 适配层只做 `unwrap()`（失败转 `ApiError`）；重试与续传策略在 `../lib/upload`，本模块不重复实现。
 */
export function createCloudDriveUploadPort(): CloudDriveUploadPort {
  return {
    begin: (input) => unwrap(cloudDriveApi.beginUpload(input)),
    status: (uploadId) => unwrap(cloudDriveApi.getUploadStatus(uploadId)),
    send: (uploadId, offset, chunk) => unwrap(cloudDriveApi.sendUploadChunk(uploadId, offset, chunk)),
    finalize: (uploadId) => unwrap(cloudDriveApi.finalizeUpload(uploadId)),
    abandon: async (uploadId) => {
      await unwrap(cloudDriveApi.abandonUpload(uploadId));
    },
  };
}

/** 域模块的公开类型出口，供跨包消费方按需取用（当前只有本包页面）。 */
export type { CloudDriveFile, CloudDriveFilePage, CloudDrivePrincipal };
