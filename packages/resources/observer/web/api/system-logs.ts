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

/** 日志检索入参；`limit` 为服务端返回条数上限（缺省 500）。 */
export interface SystemLogSearchInput {
  file: string;
  q: string;
  errorOnly: boolean;
  limit?: number;
}

/** acp-link 之外的系统日志域模块出口（§5.5：单一 `*Api` 对象）。 */
export const systemLogsApi = {
  /** 拉取可读日志文件列表（Bearer master key）。 */
  fetchFiles: (): Promise<{ files: SystemLogFile[] }> =>
    unwrap(request<{ files: SystemLogFile[] }>("/api/system/logs/", { bearerToken: getAdminKey() ?? undefined })),

  /** 在指定日志文件内检索（limit 为服务端返回条数上限，默认 500）。 */
  search: (input: SystemLogSearchInput): Promise<SystemLogSearchResult> =>
    unwrap(
      request<SystemLogSearchResult>("/api/system/logs/search", {
        query: { ...input, limit: input.limit ?? 500 },
        bearerToken: getAdminKey() ?? undefined,
        timeout: 60_000,
      }),
    ),

  /**
   * 拉取日志文件内容（调用方负责落盘）。
   *
   * 返回响应体 `Blob` 而不自己触发下载：按前端规范 5.1「组件负责：调用域模块 → 处理结果 → 更新 UI」，
   * 创建锚点、`click()` 与用完 `revokeObjectURL` 都是 UI 职责，由调用方（`pages/admin/AdminLogsPage.tsx`）
   * 承担；本方法只做取数与错误归一。这与沙箱域 `systemSandboxApi.cluster.downloadTunnelConfig`
   * （同样只回内容、由 `ClusterPanel` 落盘）是同一分工，域模块内不再出现任何 DOM 调用。
   *
   * 为什么这里保留裸 `fetch`（**`request()` 的能力缺口，不是本模块的取巧**）：下载端点的成功响应是
   * `text/plain` 流，而 `request()` 只解 `{ success, data }` JSON 信封——非 JSON 分支会先把 body 读成
   * 文本再按 `success` 字段判形，二进制内容在那一步就被消费掉并归一为 SERVER_ERROR（实现见
   * `web-runtime/web/api/request.ts` 的非 JSON 分支）。该缺口记在前端规范 5.3「非标准响应适配」的
   * 「已知能力缺口」里，规范给的修法是**给 `request()` 补 blob/流响应能力，不是在调用点继续手写**。
   * 因此本方法是这一处缺口的临时收容点：全模块的裸 `fetch` 只此一处；`request()` 支持 blob 后，
   * 本方法应整体退回 `request()` + `unwrap()`，不要在这里新增第二套下载路径。
   *
   * 失败语义与统一层一致：非 2xx 一律抛 `ApiError`，code 与 `unwrap()` 同源（取 `/api/system/*` 的
   * `{ error: { code, message } }` 信封），信封不可用时按状态码兜底成 UNAUTHORIZED / SERVER_ERROR，
   * 这样 401 → UNAUTHORIZED 的归一化与其它 `/api/system/*` 调用完全相同，调用方不必为下载单写一条
   * 鉴权失败分支（见 `buildDownloadError` 的说明）。
   *
   * 抛错即契约：调用方必须接住（`useRequest` 的 onError 或 try/catch）。本方法不吞错、也不自己弹提示——
   * 用户可见文案归页面（`t()`），这里只提供可分类的错误。
   */
  download: async (file: string): Promise<Blob> => {
    const response = await fetch(`/api/system/logs/download?file=${encodeURIComponent(file)}`, {
      credentials: "include",
      headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` },
    });
    if (!response.ok) throw await buildDownloadError(response);

    return response.blob();
  },
};

/**
 * 把下载失败响应归一为统一错误。
 *
 * 为什么不直接 `unwrap()`：`unwrap()` 只看得见响应体里的信封，看不到 HTTP 状态；而下载端点的失败
 * 既可能是错误信封（400/404/500），也可能是网关/代理直接回的 HTML。只靠信封取码会把后者落到
 * UNKNOWN，丢掉 401/403 → UNAUTHORIZED 这条调用方依赖的分类。因此这里与 `unwrap()` 取**同一处**
 * 信封码，仅在信封缺失时用状态码兜底——不是另立一套取码规则。
 *
 * 错误体解析会抛错（非 JSON）时记下状态与异常作为诊断上下文，再以状态码兜底（401/403 归
 * UNAUTHORIZED，其余归 SERVER_ERROR）。兜底码刻意保守——未知失败按服务端错误处理，
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
