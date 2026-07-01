/**
 * request.ts — 前端统一请求基础设施
 *
 * 所有域模块共享同一个 request() 函数，统一管理 credentials、header 注入、
 * 错误标准化、超时、日志。组件和域模块不直接调 fetch。
 */

/** 统一错误码体系 */
export type ErrorCode =
  | "NETWORK_ERROR" // 网络不通、CORS、超时
  | "SERVER_ERROR" // 5xx
  | "NOT_FOUND" // 404
  | "VALIDATION_ERROR" // 参数校验失败
  | "UNAUTHORIZED" // 401/403
  | "UNKNOWN"; // 兜底

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
  if (!success) throw new ApiError(error?.message ?? "请求失败", error?.code ?? "UNKNOWN");
  return data as T;
}

interface RequestOptions extends Omit<RequestInit, "body"> {
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
}

const DEFAULT_TIMEOUT = 30_000;

/** 统一请求函数。自动处理路径参数、查询参数、JSON 序列化、超时、错误标准化。 */
export async function request<T>(url: string, options: RequestOptions = {}): Promise<ApiResponse<T>> {
  const { params, query, body, timeout = DEFAULT_TIMEOUT, signal: externalSignal, ...init } = options;

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

  // 超时控制 + 外部 AbortSignal 合并
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  const combinedSignal = externalSignal ? anySignal(controller.signal, externalSignal) : controller.signal;

  // 请求体序列化：普通对象 → JSON，FormData/Blob 直传
  let resolvedBody: BodyInit | undefined;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob) {
      resolvedBody = body;
    } else {
      headers["content-type"] = "application/json";
      resolvedBody = JSON.stringify(body);
    }
  }

  try {
    const r = await fetch(resolvedUrl, {
      credentials: "include",
      signal: combinedSignal,
      headers: { ...headers, ...Object.fromEntries(new Headers(init.headers).entries()) },
      ...init,
      body: resolvedBody,
    });
    clearTimeout(timeoutId);

    // 非 JSON 响应（如文件下载）不解析 body
    const ct = r.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      if (!r.ok) {
        console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl} ${r.status}`);
        return { success: false, error: { code: statusToCode(r.status), message: `请求失败 (${r.status})` } };
      }
      return { success: true, data: undefined as unknown as T };
    }

    const json: Record<string, unknown> = await r.json();
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
    clearTimeout(timeoutId);
    if ((err as Error).name === "AbortError") {
      return { success: false, error: { code: "NETWORK_ERROR", message: "请求超时或已取消" } };
    }
    console.error(`[request] ${init.method ?? "GET"} ${resolvedUrl}`, err);
    return { success: false, error: { code: "NETWORK_ERROR", message: "网络异常，请检查连接" } };
  }
}

/**
 * 将后端错误响应标准化为 { code, message } 格式。
 * /web/* 规范使用 code；未提供 code 时回退到 HTTP status 映射。
 */
function normalizeErrorResponse(err: unknown, status: number): { code: ErrorCode; message: string } {
  const obj = err as { code?: string; message?: string } | undefined;
  const code = normalizeErrorCode(obj?.code, status);
  return { code, message: obj?.message ?? `请求失败 (${status})` };
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
  return statusToCode(status);
}

function statusToCode(status: number): ErrorCode {
  if (status === 401 || status === 403) return "UNAUTHORIZED";
  if (status === 404) return "NOT_FOUND";
  if (status === 422) return "VALIDATION_ERROR";
  if (status >= 500) return "SERVER_ERROR";
  return "UNKNOWN";
}

/** 合并两个 AbortSignal，任一 abort 都会触发合并后的 signal */
function anySignal(a: AbortSignal, b: AbortSignal): AbortSignal {
  const c = new AbortController();
  const onAbort = (reason: unknown) => c.abort(reason);
  if (a.aborted) {
    c.abort(a.reason);
    return c.signal;
  }
  if (b.aborted) {
    c.abort(b.reason);
    return c.signal;
  }
  a.addEventListener("abort", () => onAbort(a.reason), { once: true });
  b.addEventListener("abort", () => onAbort(b.reason), { once: true });
  return c.signal;
}
