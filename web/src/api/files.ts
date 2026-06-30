/**
 * files.ts — 环境文件操作 API 模块
 *
 * 封装基于环境（environment）的文件浏览、读写、上传和用户文件树管理操作。
 * 后端路由前缀为 /web/environments/:id，本模块内部拼接完整路径。
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

export const fileApi = {
  /**
   * 获取环境工作区的目录列表。
   * @param id - 环境 ID
   * @param subpath - 可选的子目录路径
   */
  listDir: (id: string, subpath?: string) =>
    request<FileListResponse>("/web/environments/:id/user", {
      params: { id },
      query: subpath ? { path: subpath } : undefined,
    }),

  /**
   * 读取环境工作区中指定路径的文件内容。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 user/ 目录）
   */
  readFile: (id: string, subpath: string) =>
    request<FileContent>(`/web/environments/:id/user/${subpath}`, { params: { id } }),

  /**
   * 上传文件到环境工作区。使用 FormData 作为请求体以支持多文件上传。
   * @param id - 环境 ID
   * @param fd - 包含文件及相关路径信息的 FormData 对象
   */
  upload: (id: string, fd: FormData) =>
    request<FileUploadResponse>("/web/environments/:id/user", {
      method: "POST",
      params: { id },
      body: fd,
    }),

  /**
   * 写入文本内容到环境工作区的指定文件。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 user/ 目录）
   * @param content - 要写入的文本内容
   */
  writeFile: (id: string, subpath: string, content: string) =>
    request<FileWriteResult>(`/web/environments/:id/user/${subpath}`, {
      method: "PUT",
      params: { id },
      body: { content },
    }),
};

export const userFileApi = {
  /**
   * 递归获取环境工作区 user/ 目录的完整文件树。
   * @param id - 环境 ID
   */
  tree: (id: string) => request<TreeResponse>("/web/environments/:id/user-file/tree", { params: { id } }),

  /**
   * 重命名或移动 user/ 目录中的文件或目录。
   * @param id - 环境 ID
   * @param path - 原路径
   * @param newName - 新文件名（仅文件名，不含目录部分）
   */
  rename: (id: string, path: string, newName: string) => {
    const parentDir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : "";
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    return request<RenameResponse>("/web/environments/:id/user-file/rename", {
      method: "POST",
      params: { id },
      body: { oldPath: path, newPath },
    });
  },

  /**
   * 在 user/ 目录下创建新目录。
   * @param id - 环境 ID
   * @param path - 要创建的目录路径
   */
  mkdir: (id: string, path: string) =>
    request<MkdirResponse>("/web/environments/:id/user-file/mkdir", {
      method: "POST",
      params: { id },
      body: { path },
    }),

  /**
   * 批量删除 user/ 目录下的文件，分别返回成功和失败结果。
   * @param id - 环境 ID
   * @param paths - 待删除的文件路径数组
   */
  batchDelete: (id: string, paths: string[]) =>
    request<BatchDeleteResponse>("/web/environments/:id/user-file/batch", {
      method: "DELETE",
      params: { id },
      body: { paths },
    }),
};
