import { ApiError, request, unwrap } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";

export interface SystemLogFile {
  name: string;
  size: number;
  modifiedAt: string;
  isErrorLog: boolean;
}

export interface SystemLogEntry {
  timestamp: string | null;
  level: string | null;
  module: string | null;
  requestId: string | null;
  message: string;
  error: { type: string | null; message: string | null; stack: string | null } | null;
}

export interface SystemLogSearchResult {
  file: SystemLogFile;
  entries: SystemLogEntry[];
  totalMatches: number;
  truncated: boolean;
}

export function fetchSystemLogFiles(): Promise<{ files: SystemLogFile[] }> {
  return unwrap(request<{ files: SystemLogFile[] }>("/api/system/logs/", { bearerToken: getAdminKey() ?? undefined }));
}

export function searchSystemLog(input: {
  file: string;
  q: string;
  errorOnly: boolean;
  limit?: number;
}): Promise<SystemLogSearchResult> {
  return unwrap(
    request<SystemLogSearchResult>("/api/system/logs/search", {
      query: { ...input, limit: input.limit ?? 500 },
      bearerToken: getAdminKey() ?? undefined,
      timeout: 60_000,
    }),
  );
}

/**
 * 下载日志文件。
 *
 * 为什么不走 `request()`：下载端点的成功响应是 `text/plain` 流，而 `request()` 对非 JSON 响应体
 * 会先把 body 读成文本再按 JSON 解包，二进制内容会在这一步被消费掉并归一为 SERVER_ERROR，
 * 因此响应体只能由这里直接读取。失败路径仍接回统一层：非 2xx 一律抛 `ApiError(message, code)`，
 * code 取自 `/api/system/*` 的错误信封（与 `unwrap()` 的取码规则一致），信封不可用时按状态码兜底。
 * 这样 401 → UNAUTHORIZED 的归一化与其它调用完全相同，调用方不必为下载单独写一套鉴权失败分支。
 *
 * 抛错即契约：调用方必须接住（`useRequest` 的 onError 或 try/catch）。本函数不吞错、也不自己弹提示——
 * 用户可见文案归页面（`t()`），这里只提供可分类的错误。
 */
export async function downloadSystemLog(file: string): Promise<void> {
  const response = await fetch(`/api/system/logs/download?file=${encodeURIComponent(file)}`, {
    credentials: "include",
    headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` },
  });
  if (!response.ok) throw await buildDownloadError(response);

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * 把下载失败响应归一为统一错误。
 *
 * 错误体是 `/api/system/*` 的 `{ error: { code, message } }` 信封；被网关/代理拦截时可能返回 HTML，
 * 那时解析会抛错。解析失败不掩盖原始失败：记下响应状态与解析异常作为诊断上下文，再以状态码兜底
 * （401/403 仍归 UNAUTHORIZED，其余归 SERVER_ERROR）。兜底码刻意保守——未知失败按服务端错误处理，
 * 不会把「凭据失效」误判成「服务异常」或反之。
 */
async function buildDownloadError(response: Response): Promise<ApiError> {
  try {
    const payload = (await response.json()) as { error?: { code?: string; message?: string } };
    if (payload.error?.code) {
      return new ApiError(payload.error.message ?? `请求失败 (${response.status})`, payload.error.code);
    }
  } catch (err) {
    console.error(`[system-logs] 下载失败响应无法按错误信封解析 (${response.status})`, err);
  }
  const fallbackCode = response.status === 401 || response.status === 403 ? "UNAUTHORIZED" : "SERVER_ERROR";
  return new ApiError(`请求失败 (${response.status})`, fallbackCode);
}
