/** API 错误信息 */
interface ApiError {
  /** 错误码，如 "NOT_FOUND"、"VALIDATION_ERROR" */
  code: string;
  /** 人类可读的错误消息 */
  message: string;
  /** HTTP 状态码 */
  status?: number;
  /** 服务端随错误返回的结构化上下文 */
  data?: unknown;
}

/** API 成功响应 */
interface ApiOk<T> {
  readonly ok: true;
  readonly data: T;
}

/** API 失败响应 */
interface ApiErr {
  readonly ok: false;
  readonly error: ApiError;
}

/** API 调用结果 — 联合类型，支持 TS 类型收窄 */
export type ApiResult<T> = ApiOk<T> | ApiErr;

/** 构造成功结果 */
export function ok<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

/** 构造失败结果 */
export function err(code: string, message: string, status?: number, data?: unknown): ApiErr {
  return { ok: false, error: { code, message, status, ...(data !== undefined ? { data } : {}) } };
}

/**
 * 将 ApiResult 统一解包为 data。
 * 页面层统一在这里把 `ok: false` 转为可展示的 Error，避免把失败结果误当成功分支继续执行。
 */
export function unwrapApiResult<T>(result: ApiResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message || "Unknown API error");
}
