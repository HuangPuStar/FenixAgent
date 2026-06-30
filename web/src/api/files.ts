/**
 * files.ts — 会话文件操作 API 模块
 *
 * 封装基于会话（session）的文件浏览、读写、删除和用户文件树管理操作。
 * 后端路由前缀为 /web/sessions/:sessionId，本模块内部拼接完整路径。
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

/** 文件删除响应 */
interface FileDeleteResult {
  ok: true;
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
   * 获取会话工作区的目录列表。
   * @param params.sessionId - 会话 ID
   * @param query - 可选的目录路径筛选
   */
  listDir: (params: { sessionId: string }, query?: { path?: string }) =>
    request<FileListResponse>("/web/sessions/:sessionId/files", { params, query }),

  /**
   * 读取会话工作区中指定路径的文件内容。
   * @param params.sessionId - 会话 ID
   * @param query - 可选参数（如 path 指定文件路径）
   */
  readFile: (params: { sessionId: string }, query?: { path?: string }) =>
    request<FileContent>("/web/sessions/:sessionId/files/read", { params, query }),

  /**
   * 上传文件到会话工作区。使用 FormData 作为请求体以支持多文件上传。
   * @param params.sessionId - 会话 ID
   * @param formData - 包含文件及相关路径信息的 FormData 对象
   */
  upload: (params: { sessionId: string }, formData: FormData) =>
    request<FileUploadResponse>("/web/sessions/:sessionId/files/upload", {
      method: "POST",
      params,
      body: formData,
    }),

  /**
   * 写入文本内容到会话工作区的指定文件。
   * @param params.sessionId - 会话 ID
   * @param body.content - 要写入的文本内容
   */
  writeFile: (params: { sessionId: string }, body: { content: string }) =>
    request<FileWriteResult>("/web/sessions/:sessionId/files/write", {
      method: "POST",
      params,
      body,
    }),

  /**
   * 删除会话工作区中指定路径的文件。
   * @param params.sessionId - 会话 ID
   * @param params.path - 要删除的文件路径
   */
  deleteFile: (params: { sessionId: string; path: string }) =>
    request<FileDeleteResult>("/web/sessions/:sessionId/files", {
      method: "DELETE",
      params: { sessionId: params.sessionId },
      body: { path: params.path },
    }),
};

export const userFileApi = {
  /**
   * 递归获取会话工作区 user/ 目录的完整文件树。
   * @param params.sessionId - 会话 ID
   */
  tree: (params: { sessionId: string }) => request<TreeResponse>("/web/sessions/:sessionId/user/tree", { params }),

  /**
   * 重命名或移动 user/ 目录中的文件或目录。
   * @param params.sessionId - 会话 ID
   * @param body.oldPath - 原路径
   * @param body.newPath - 新路径
   */
  rename: (params: { sessionId: string }, body: { oldPath: string; newPath: string }) =>
    request<RenameResponse>("/web/sessions/:sessionId/user/rename", {
      method: "POST",
      params,
      body,
    }),

  /**
   * 在 user/ 目录下创建新目录。
   * @param params.sessionId - 会话 ID
   * @param body.path - 要创建的目录路径
   */
  mkdir: (params: { sessionId: string }, body: { path: string }) =>
    request<MkdirResponse>("/web/sessions/:sessionId/user/mkdir", {
      method: "POST",
      params,
      body,
    }),

  /**
   * 批量删除 user/ 目录下的文件，分别返回成功和失败结果。
   * @param params.sessionId - 会话 ID
   * @param body.paths - 待删除的文件路径数组
   */
  batchDelete: (params: { sessionId: string }, body: { paths: string[] }) =>
    request<BatchDeleteResponse>("/web/sessions/:sessionId/user/batch-delete", {
      method: "POST",
      params,
      body,
    }),
};
