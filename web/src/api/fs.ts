/**
 * fs.ts — workspace 文件系统 API 模块
 *
 * 封装基于环境（environment）的 workspace 全目录文件浏览、读写、上传和文件树管理操作。
 * 后端路由前缀为 /web/environments/:id/fs，本模块内部拼接完整路径。
 */

import { request, UPLOAD_TIMEOUT_MS, WRITE_TIMEOUT_MS } from "./request";

/**
 * 单次上传大小上限（100MB），与后端保持一致的同源常量。
 * 业务侧统一引用本常量，禁止硬编码（docs/arch/12-files.md §10 P1-12 ⑤）。
 */
export const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024;

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

/**
 * 拼接文件上传 URL（/web/environments/:id/fs 子路径）。
 *
 * Elysia splat 路由不匹配空段：targetDir 为空（上传到 workspace 根）时必须保留尾斜杠
 * （以 /fs/ 结尾而非 /fs），否则后端返回 404；非空 targetDir 去除前导斜杠后拼接，
 * 避免 "/docs" 这类输入产生双斜杠。FileTreeTab 的原生 XHR 上传复用本函数，
 * 保证两条上传路径的 URL 拼装行为一致。
 * @param id - 环境 ID
 * @param targetDir - 目标目录（相对于 workspace 根），缺省或空串表示 workspace 根
 */
export function buildUploadUrl(id: string, targetDir?: string): string {
  const dir = targetDir ? targetDir.replace(/^\/+/, "") : "";
  return `/web/environments/${encodeURIComponent(id)}/fs/${dir}`;
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
    request<FileContent | undefined>(`/web/environments/:id/fs/${subpath}`, {
      params: { id },
    }),

  /**
   * 上传文件到 workspace 指定目录。
   * 上传超时与后端对齐（120s），并携带自动生成的 opId 供断网重试幂等去重。
   * @param id - 环境 ID
   * @param fd - 包含文件及相关路径信息的 FormData 对象
   * @param targetDir - 目标目录（相对于 workspace 根），缺省或空串表示 workspace 根
   */
  upload: (id: string, fd: FormData, targetDir?: string) =>
    request<FileUploadResponse>(buildUploadUrl(id, targetDir), {
      method: "POST",
      body: fd,
      timeout: UPLOAD_TIMEOUT_MS,
      opId: crypto.randomUUID(),
    }),

  /**
   * 写入文本内容到 workspace 的指定文件。
   * 写操作超时与后端 file_op 对齐（120s），并携带自动生成的 opId 供断网重试幂等去重。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 workspace 根）
   * @param content - 要写入的文本内容
   */
  writeFile: (id: string, subpath: string, content: string) =>
    request<FileWriteResult>(`/web/environments/:id/fs/${subpath}`, {
      method: "PUT",
      params: { id },
      body: { content },
      timeout: WRITE_TIMEOUT_MS,
      opId: crypto.randomUUID(),
    }),

  /**
   * 重命名或移动 workspace 中的文件或目录。
   * 写操作超时与后端对齐（120s），并携带自动生成的 opId 供断网重试幂等去重。
   * @param id - 环境 ID
   * @param oldPath - 原路径
   * @param newPath - 新路径（完整路径，非仅文件名）
   */
  rename: (id: string, oldPath: string, newPath: string) =>
    request<RenameResponse>("/web/environments/:id/fs/rename", {
      method: "POST",
      params: { id },
      body: { oldPath, newPath },
      timeout: WRITE_TIMEOUT_MS,
      opId: crypto.randomUUID(),
    }),

  /**
   * 在 workspace 中创建新目录。
   * 写操作超时与后端对齐（120s），并携带自动生成的 opId 供断网重试幂等去重。
   * @param id - 环境 ID
   * @param path - 要创建的目录路径（相对于 workspace 根）
   */
  mkdir: (id: string, path: string) =>
    request<MkdirResponse>("/web/environments/:id/fs/mkdir", {
      method: "POST",
      params: { id },
      body: { path },
      timeout: WRITE_TIMEOUT_MS,
      opId: crypto.randomUUID(),
    }),

  /**
   * 批量删除 workspace 中的文件。
   * 写操作超时与后端对齐（120s），并携带自动生成的 opId 供断网重试幂等去重。
   * @param id - 环境 ID
   * @param paths - 待删除的文件路径数组
   */
  batchDelete: (id: string, paths: string[]) =>
    request<BatchDeleteResponse>("/web/environments/:id/fs/batch", {
      method: "DELETE",
      params: { id },
      body: { paths },
      timeout: WRITE_TIMEOUT_MS,
      opId: crypto.randomUUID(),
    }),
};
