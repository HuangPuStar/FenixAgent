/**
 * request.ts — 前端统一请求基础设施
 *
 * 所有域模块共享同一个 request() 函数，统一管理 credentials、header 注入、
 * 错误标准化、超时、日志。组件和域模块不直接调 fetch。
 */

/** 已知的统一错误码体系 */
type KnownErrorCode =
  | "NETWORK_ERROR" // 网络不通、CORS、超时
  | "SERVER_ERROR" // 5xx
  | "NOT_FOUND" // 404
  | "VALIDATION_ERROR" // 参数校验失败
  | "UNAUTHORIZED" // 401/403
  | "UNKNOWN"; // 兜底

/** 统一错误码体系，同时兼容后端透传的自定义业务错误码。 */
export type ErrorCode = KnownErrorCode | (string & {});

/** 统一 API 响应类型 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  /** 失败时携带错误码与消息，部分接口（如 Skill 冲突检测）会通过 data 提供附加信息 */
  error?: { code: ErrorCode; message: string; data?: unknown };
}

/** 统一分页响应结构。page/pageSize 为可选字段，因为并非所有后端分页端点都返回这两个字段。 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page?: number;
  pageSize?: number;
}

/** 统一 API 错误类，携带错误码便于上层分类处理 */
export class ApiError extends Error {
  constructor(
    message: string,
    public code: ErrorCode = "UNKNOWN",
    public data?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 解包 ApiResponse：成功返回 data，失败抛 ApiError。
 * 省去每个域模块/组件中手动 if (!success) throw 的样板代码。
 */
export async function unwrap<T>(resp: Promise<ApiResponse<T>>): Promise<T> {
  const { success, data, error } = await resp;
  if (!success) throw new ApiError(error?.message ?? "请求失败", error?.code ?? "UNKNOWN", error?.data);
  return data as T;
}

/**
 * 将后端返回的 snake_case 键名转换为 camelCase，供各域 API 模块共用。
 * 只递归数组元素（如实例列表项）；嵌套的普通对象保持原样——这是既有行为，改了会动响应形状。
 */
export function toCamelKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
    // 递归转换嵌套对象（如 instances 数组中的对象）
    if (Array.isArray(value)) {
      result[camelKey] = value.map((item) =>
        item && typeof item === "object" ? toCamelKeys(item as Record<string, unknown>) : item,
      );
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

/** 将完整响应中的 data 字段进行键名转换（data 为对象或数组时均转换，其余原样返回） */
export async function camelResponse<T>(resp: Promise<ApiResponse<T>>): Promise<ApiResponse<T>> {
  const r = await resp;
  if (r.success && r.data) {
    if (Array.isArray(r.data)) {
      r.data = r.data.map((item) =>
        item && typeof item === "object" ? toCamelKeys(item as Record<string, unknown>) : item,
      ) as unknown as T;
    } else if (typeof r.data === "object") {
      r.data = toCamelKeys(r.data as Record<string, unknown>) as unknown as T;
    }
  }
  return r;
}

interface RequestOptions extends Omit<RequestInit, "body" | "headers"> {
  /** 路径参数 :id 插值 */
  params?: Record<string, string>;
  /** 查询参数自动拼装 */
  query?: object;
  /** JSON 对象（除 FormData/Blob 外均 JSON.stringify）或 FormData/Blob 直传 */
  body?: BodyInit | object;
  /** 超时 ms，默认 30000 */
  timeout?: number;
  /** 外部取消信号 */
  signal?: AbortSignal;
  /**
   * 文件写操作幂等 ID，透传 X-File-Op-Id 头（docs/arch/12-files.md §7.2）。
   * 本层**不自动重试**（重试是调用方策略）：调用方自行重试时须复用同一 opId，服务端据此去重；
   * 这里只把调用方给的值原样透传，不改写、不重新生成。
   */
  opId?: string;
  /**
   * Bearer token 注入（如系统 Master Key，docs/arch/21 §5）。置入时自动加
   * `Authorization: Bearer <token>`；它属内部头，调用方 `headers` 覆盖不了（要换 token 就换本字段）。
   * 不设置时行为完全不变。
   */
  bearerToken?: string;
  /**
   * 请求头透传（如 If-None-Match 条件请求）。与内部注入头合并，**内部头优先**：
   * `content-type` / `x-file-op-id` / `authorization` 由基建决定，调用方只能补内部未设置的头。
   */
  headers?: HeadersInit;
}

const DEFAULT_TIMEOUT = 30_000;

/**
 * 文件写操作超时（ms）。与后端 file_op 60s 对齐并留有余量，
 * 写操作前端超时不得短于后端，否则慢写会被前端提前掐断（docs/arch/12-files.md §10 P1-12 D19）。
 */
export const WRITE_TIMEOUT_MS = 120_000;

/** 文件上传超时（ms）。与后端 upload 120s 对齐（docs/arch/12-files.md §10 P1-12 D19）。 */
export const UPLOAD_TIMEOUT_MS = 120_000;

/** 统一请求函数。自动处理路径参数、查询参数、JSON 序列化、超时、错误标准化。 */
export async function request<T>(url: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const {
    params,
    query,
    body,
    timeout = DEFAULT_TIMEOUT,
    signal: externalSignal,
    opId,
    bearerToken,
    // headers 必须从 init 里解构排除：留在 init 里会被 `...init` 展开覆盖内部头（§5.2）
    headers: callerHeaders,
    ...init
  } = options;

  // 路径参数插值：/web/tasks/:id → /web/tasks/abc
  let resolvedUrl = url;
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      resolvedUrl = resolvedUrl.replace(`:${key}`, encodeURIComponent(value));
    }
  }

  // 查询参数拼装
  if (query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) sp.set(k, String(v));
    }
    const qs = sp.toString();
    if (qs) resolvedUrl += `?${qs}`;
  }

  // 请求体序列化：普通对象 → JSON，FormData/Blob 直传
  let resolvedBody: BodyInit | undefined;
  // 内部头由基建决定（幂等键 / 鉴权 / JSON 内容类型），调用方的 headers 只能补空缺，不能覆盖
  const headers = new Headers();
  // opId 透传 X-File-Op-Id：写操作幂等契约的 HTTP 载体（docs/arch/12-files.md §7.2）
  if (opId) headers.set("x-file-op-id", opId);
  if (bearerToken) headers.set("authorization", `Bearer ${bearerToken}`);
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob) {
      resolvedBody = body;
    } else {
      headers.set("content-type", "application/json");
      resolvedBody = JSON.stringify(body);
    }
  }
  // 调用方透传头合并：Headers.has 大小写不敏感，内部已设置的头一律不被覆盖
  for (const [key, value] of new Headers(callerHeaders).entries()) {
    if (!headers.has(key)) headers.set(key, value);
  }

  /**
   * 单次请求执行。网络错误/超时抛 NetworkError，由外层归一为失败结果（本层不重试）；
   * HTTP 错误状态码与业务错误走正常返回路径。
   */
  const execute = async (): Promise<ApiResponse<T>> => {
    // 超时控制 + 外部 AbortSignal 合并
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeout);
    const combined = externalSignal ? anySignal(controller.signal, externalSignal) : undefined;

    try {
      const r = await fetch(resolvedUrl, {
        credentials: "include",
        signal: combined ? combined.signal : controller.signal,
        headers,
        ...init,
        body: resolvedBody,
      });

      // 非 JSON Content-Type（如文件下载）通常不解析 body，但部分接口（如 FormData 上传）
      // 后端可能遗漏 Content-Type，此时仍尝试按 JSON 解析。
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        if (!r.ok) {
          console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl} ${r.status}`);
          return {
            success: false,
            error: {
              code: statusToCode(r.status),
              message: `请求失败 (${r.status})`,
            },
          };
        }
        // 试探性 JSON 解析：后端可能在二进制上传响应中漏掉 Content-Type
        try {
          const text = await r.text();
          const json = JSON.parse(text) as Record<string, unknown>;
          if (typeof json.success === "boolean") {
            if (json.success === false) {
              console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl}`, json?.error);
              return {
                success: false,
                error: normalizeErrorResponse(json?.error, r.status),
              };
            }
            return {
              success: true,
              data: ("data" in json ? json.data : json) as unknown as T,
            };
          }
        } catch (err) {
          // 不是 JSON（JSON.parse 的 SyntaxError）才继续后续错误处理；
          // 读响应体时的 abort/网络异常要交给外层按 transport 错误归一，不能被当成「格式异常」
          if (!(err instanceof SyntaxError)) throw err;
        }
        // 响应虽然是 200 但既不是 JSON 也没带 success 字段，视为服务端异常
        console.error(
          `[request] ${init.method ?? "GET"} ${resolvedUrl} ${r.status} — 响应格式异常，Content-Type: ${ct}`,
        );
        return {
          success: false,
          error: {
            code: "SERVER_ERROR",
            message: `服务器返回了意外的响应格式`,
          },
        };
      }

      let json: Record<string, unknown>;
      try {
        json = await r.json();
      } catch (err) {
        // JSON 语法损坏是服务端响应问题；读取响应体时的 abort/网络异常仍交给外层按 transport 错误处理。
        if (!(err instanceof SyntaxError)) throw err;
        console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl} ${r.status} — JSON 响应格式异常`);
        if (!r.ok) {
          return {
            success: false,
            error: normalizeErrorResponse(undefined, r.status),
          };
        }
        return {
          success: false,
          error: {
            code: "SERVER_ERROR",
            message: `服务器返回了意外的响应格式`,
          },
        };
      }
      if (!r.ok || json.success === false) {
        console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl}`, json?.error);
        const baseError = normalizeErrorResponse(json?.error, r.status);
        // 保留后端附加的 data 字段（如 Skill 上传冲突的 conflicts + allowedStrategies）
        return {
          success: false,
          error: json?.data !== undefined ? { ...baseError, data: json.data } : baseError,
        };
      }
      // 统一解包 data 字段，兼容无 data 包裹的响应。
      // 使用 "data" in json 而非 json.data ?? json，因为在 data 为 null 时（如 getRunStatus、getOutput），
      // ?? 会错误地回退到整个响应对象，导致调用方收到非 null 值而产生逻辑错误。
      return { success: true, data: ("data" in json ? json.data : json) as T };
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        // 外部主动取消与超时都表现为 AbortError，靠 timedOut 区分：外部取消不是网络类错误
        if (!timedOut) {
          return {
            success: false,
            error: { code: "NETWORK_ERROR", message: "请求超时或已取消" },
          };
        }
        throw new NetworkError("请求超时");
      }
      throw new NetworkError("网络异常，请检查连接");
    } finally {
      // 定时器与合并监听器在请求**完整结束**（含 body 消费）后才释放：
      // 收到响应头就清定时器会让慢 json()/text() 逃出超时约束（§5.2）；
      // 监听器挂在调用方的 signal 上，不摘除会累积到该 signal 被 abort（长生命周期 signal 泄漏）。
      clearTimeout(timeoutId);
      combined?.dispose();
    }
  };

  try {
    return await execute();
  } catch (err) {
    // 到这里只剩传输类失败（网络不通 / 超时）；busy/4xx/5xx 等 HTTP 错误与业务失败走正常返回路径。
    // 本层**不自动重试**：重试是调用方策略——带 opId 的写操作若由调用方重试，须复用同一 opId 才能幂等去重
    const message = err instanceof NetworkError ? err.message : "网络异常，请检查连接";
    console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl}`, err);
    return { success: false, error: { code: "NETWORK_ERROR", message } };
  }
}

/**
 * 网络类可重试错误（超时或网络不通），由 request 内部抛出并消费；
 * HTTP 错误状态码与业务错误走正常返回路径，不属于此类。
 */
class NetworkError extends Error {}

/**
 * 将后端错误响应标准化为 { code, message } 格式。
 * /web/* 规范使用 code；未提供 code 时回退到 HTTP status 映射。
 */
function normalizeErrorResponse(err: unknown, status: number): { code: ErrorCode; message: string } {
  const fallbackMessage = `请求失败 (${status})`;
  if (typeof err === "string") {
    return {
      code: statusToCode(status),
      message: err.trim() ? err : fallbackMessage,
    };
  }

  const code = normalizeErrorCode(
    typeof err === "object" && err !== null && "code" in err && typeof err.code === "string" ? err.code : undefined,
    status,
  );
  const message =
    typeof err === "object" && err !== null && "message" in err && typeof err.message === "string" && err.message.trim()
      ? err.message
      : fallbackMessage;
  return { code, message };
}

/**
 * 将后端错误类型字符串映射为前端 ErrorCode。
 * 后端使用 snake_case 类型名（如 "not_found"、"validation_error"），
 * 部分模块直接透传 ErrorCode 常量值。
 */
function normalizeErrorCode(raw: string | undefined, status: number): ErrorCode {
  if (!raw) return statusToCode(status);
  const upper = raw.toUpperCase();
  if (upper === "NOT_FOUND") return "NOT_FOUND";
  if (upper === "VALIDATION_ERROR") return "VALIDATION_ERROR";
  if (upper === "REMOTE_ERROR" || upper === "SERVER_ERROR") return "SERVER_ERROR";
  if (upper === "UNAUTHORIZED") return "UNAUTHORIZED";
  if (upper === "NETWORK_ERROR") return "NETWORK_ERROR";
  // backend may return raw ErrorCode values directly
  if (["NOT_FOUND", "SERVER_ERROR", "VALIDATION_ERROR", "UNAUTHORIZED", "NETWORK_ERROR", "UNKNOWN"].includes(upper)) {
    return upper as ErrorCode;
  }
  return raw as ErrorCode;
}

function statusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "VALIDATION_ERROR";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

/**
 * 合并两个 AbortSignal，任一 abort 都会触发合并后的 signal。
 *
 * 返回的 `dispose()` 必须由调用方在请求结束后执行：监听器挂在**入参**信号上（外部 signal 由调用方
 * 持有、生命周期可能远长于本次请求），不摘除就会随每次请求累积到该 signal 被 abort。
 */
function anySignal(a: AbortSignal, b: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const c = new AbortController();
  const onAbortA = () => c.abort(a.reason);
  const onAbortB = () => c.abort(b.reason);
  if (a.aborted) {
    c.abort(a.reason);
    return { signal: c.signal, dispose: () => {} };
  }
  if (b.aborted) {
    c.abort(b.reason);
    return { signal: c.signal, dispose: () => {} };
  }
  a.addEventListener("abort", onAbortA, { once: true });
  b.addEventListener("abort", onAbortB, { once: true });
  return {
    signal: c.signal,
    dispose: () => {
      a.removeEventListener("abort", onAbortA);
      b.removeEventListener("abort", onAbortB);
    },
  };
}
