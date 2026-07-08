/**
 * fs.ts — workspace 文件系统 API 模块
 *
 * 封装基于环境（environment）的 workspace 全目录文件浏览、读写、上传和文件树管理操作。
 * 后端路由前缀为 /web/environments/:id/fs，本模块内部拼接完整路径。
 */

import { request } from "./request";

/** 目录列表单条记录 */
interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

/** 目录列表响应 */
interface FileListResponse {
  entries: FileEntry[];
}

/** 文件内容响应 */
interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  encoding: string;
}

/** 文件上传响应 */
interface FileUploadResponse {
  files: Array<{ name: string; path: string; size: number }>;
}

/** 文件写入响应 */
interface FileWriteResult {
  name: string;
  path: string;
  size: number;
}

/** 文件树响应 */
interface TreeResponse {
  paths: string[];
  mtimes?: Record<string, number>;
}

/** 重命名响应 */
interface RenameResponse {
  oldPath: string;
  newPath: string;
}

/** 创建目录响应 */
interface MkdirResponse {
  path: string;
}

/** 批量删除响应 */
interface BatchDeleteResponse {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

export const fsApi = {
  /**
   * 递归获取 workspace 完整文件树（黑名单过滤）。
   * @param id - 环境 ID
   */
  tree: (id: string) => request<TreeResponse>("/web/environments/:id/fs/tree", { params: { id } }),

  /**
   * 获取 workspace 指定路径的目录列表。
   * @param id - 环境 ID
   * @param subpath - 可选的子目录路径（默认为 workspace 根）
   */
  listDir: (id: string, subpath?: string) =>
    request<FileListResponse>("/web/environments/:id/fs", {
      params: { id },
      query: subpath ? { path: subpath } : undefined,
    }),

  /**
   * 读取 workspace 指定路径的文件内容。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 workspace 根）
   */
  readFile: (id: string, subpath: string) =>
    request<FileContent | undefined>(`/web/environments/:id/fs/${subpath}`, { params: { id } }),

  /**
   * 上传文件到 workspace 指定目录。
   * @param id - 环境 ID
   * @param fd - 包含文件及相关路径信息的 FormData 对象
   */
  upload: (id: string, fd: FormData, targetDir?: string) =>
    request<FileUploadResponse>(`/web/environments/:id/fs/${targetDir ? targetDir.replace(/^\/+/, "") : ""}`, {
      method: "POST",
      params: { id },
      body: fd,
    }),

  /**
   * 写入文本内容到 workspace 的指定文件。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 workspace 根）
   * @param content - 要写入的文本内容
   */
  writeFile: (id: string, subpath: string, content: string) =>
    request<FileWriteResult>(`/web/environments/:id/fs/${subpath}`, {
      method: "PUT",
      params: { id },
      body: { content },
    }),

  /**
   * 重命名或移动 workspace 中的文件或目录。
   * @param id - 环境 ID
   * @param oldPath - 原路径
   * @param newPath - 新路径（完整路径，非仅文件名）
   */
  rename: (id: string, oldPath: string, newPath: string) =>
    request<RenameResponse>("/web/environments/:id/fs/rename", {
      method: "POST",
      params: { id },
      body: { oldPath, newPath },
    }),

  /**
   * 在 workspace 中创建新目录。
   * @param id - 环境 ID
   * @param path - 要创建的目录路径（相对于 workspace 根）
   */
  mkdir: (id: string, path: string) =>
    request<MkdirResponse>("/web/environments/:id/fs/mkdir", {
      method: "POST",
      params: { id },
      body: { path },
    }),

  /**
   * 批量删除 workspace 中的文件。
   * @param id - 环境 ID
   * @param paths - 待删除的文件路径数组
   */
  batchDelete: (id: string, paths: string[]) =>
    request<BatchDeleteResponse>("/web/environments/:id/fs/batch", {
      method: "DELETE",
      params: { id },
      body: { paths },
    }),
};
