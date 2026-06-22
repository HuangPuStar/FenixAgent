import type { ApiResult } from "@fenix/sdk";

/**
 * 将 SDK 的 ApiResult 统一解包为 data。
 * 页面层统一在这里把 `ok: false` 转为可展示的 Error，避免把失败结果误当成功分支继续执行。
 */
export function unwrapApiResult<T>(result: ApiResult<T>): T {
  if (result.ok) {
    return result.data;
  }
  throw new Error(result.error.message || "Unknown API error");
}
