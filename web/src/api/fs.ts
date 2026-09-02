/**
 * fs.ts — workspace 文件系统 API 模块
 *
 * 封装基于环境（environment）的 workspace 全目录文件浏览、读写、上传和文件树管理操作。
 * 后端路由前缀为 /web/environments/:id/fs，本模块内部拼接完整路径。
 */

import { randomUUID } from "../lib/utils";
import { ApiError, request, UPLOAD_TIMEOUT_MS, unwrap, WRITE_TIMEOUT_MS } from "./request";

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

/** Chat 用户文件固定写入的 workspace 相对目录。 */
const CHAT_UPLOAD_DIRECTORY = "user";

/** 文件上传请求参数。 */
export interface UploadFilesOptions {
  targetDir?: string;
  relativePaths?: string[];
  onProgress?: (percent: number) => void;
}

/** 构造统一上传表单，文件夹层级仅通过 relativePaths 表达。 */
export function buildUploadFormData(files: File[], relativePaths?: string[]): FormData {
  const formData = new FormData();
  for (const file of files) formData.append("files", file);
  if (relativePaths) formData.append("relativePaths", JSON.stringify(relativePaths));
  return formData;
}

/**
 * 统一上传 workspace 文件。普通上传复用 request；需要进度时在 API 层封装 XHR，
 * 组件不得自行拼 URL、FormData、opId 或处理响应协议。
 */
export async function uploadFiles(
  environmentId: string,
  files: File[],
  options: UploadFilesOptions = {},
): Promise<FileUploadResponse> {
  const formData = buildUploadFormData(files, options.relativePaths);
  if (!options.onProgress) {
    return unwrap(
      request<FileUploadResponse>(buildUploadUrl(environmentId, options.targetDir), {
        method: "POST",
        body: formData,
        timeout: UPLOAD_TIMEOUT_MS,
        opId: randomUUID(),
      }),
    );
  }

  return new Promise<FileUploadResponse>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) options.onProgress?.(Math.round((event.loaded / event.total) * 100));
    };
    xhr.onload = () => {
      let payload: { success?: boolean; data?: FileUploadResponse; error?: { code?: string; message?: string } } = {};
      try {
        payload = JSON.parse(xhr.responseText) as typeof payload;
      } catch {
        reject(new ApiError(`请求失败 (${xhr.status})`, xhr.status >= 500 ? "SERVER_ERROR" : "UNKNOWN"));
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300 && payload.success && payload.data) {
        resolve(payload.data);
        return;
      }
      reject(new ApiError(payload.error?.message ?? `请求失败 (${xhr.status})`, payload.error?.code ?? "UNKNOWN"));
    };
    xhr.onerror = () => reject(new ApiError("网络异常，请检查连接", "NETWORK_ERROR"));
    xhr.timeout = UPLOAD_TIMEOUT_MS;
    xhr.ontimeout = () => reject(new ApiError("请求超时", "NETWORK_ERROR"));
    xhr.open("POST", buildUploadUrl(environmentId, options.targetDir));
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-file-op-id", randomUUID());
    xhr.send(formData);
  });
}

/** 将文件名转换为 Chat 用户文件区域中的 workspace 相对路径。 */
export function getChatUploadPath(fileName: string): string {
  return `${CHAT_UPLOAD_DIRECTORY}/${fileName}`;
}

/** Chat 三类上传入口的唯一 API：目标目录固定为 workspace 的 user/ 用户文件区域。 */
export function uploadChatFiles(environmentId: string, files: File[]): Promise<FileUploadResponse> {
  return uploadFiles(environmentId, files, { targetDir: CHAT_UPLOAD_DIRECTORY });
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
 * 避免 "/docs" 这类输入产生双斜杠。统一上传 helper 复用本函数，保证 fetch 与进度上传的 URL 拼装行为一致。
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
      opId: randomUUID(),
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
      opId: randomUUID(),
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
      opId: randomUUID(),
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
      opId: randomUUID(),
    }),
};
