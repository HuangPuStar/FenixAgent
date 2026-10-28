/**
 * 云盘错误的展示与分类。
 *
 * 口径（前端规范 §9.3）：**服务端错误信封的 `message` 优先上屏**，字典文案只在 message 为空时兜底。
 * 因此本模块只负责两件事：把 `ApiError.code` 映射成字典键（兜底文案），以及判断某个失败是否值得重试。
 */

import { ApiError } from "@fenix/web-runtime/api/request";

/**
 * 稳定业务 code → 字典键。
 *
 * 只收录服务端明确产出的 code（`src/server/client/cloud-drive-error.ts` 与路由层）；未知 code 一律
 * 落到 `errors.unknown`，不会把 code 原文显示给用户。
 */
const ERROR_KEY_BY_CODE: Readonly<Record<string, string>> = {
  CLOUD_DRIVE_NOT_CONFIGURED: "errors.notConfigured",
  CLOUD_DRIVE_UNAVAILABLE: "errors.unavailable",
  CLOUD_DRIVE_TIMEOUT: "errors.timeout",
  CLOUD_DRIVE_RATE_LIMITED: "errors.rateLimited",
  CLOUD_DRIVE_CONFLICT: "errors.conflict",
  NOT_FOUND: "errors.notFound",
  CLOUD_DRIVE_PAYLOAD_TOO_LARGE: "errors.payloadTooLarge",
  CLOUD_DRIVE_INVALID_INPUT: "errors.invalidInput",
  CLOUD_DRIVE_UPLOAD_GONE: "errors.uploadGone",
  CLOUD_DRIVE_UPLOAD_NOT_FOUND: "errors.uploadNotFound",
  NETWORK_ERROR: "errors.network",
  UNAUTHORIZED: "errors.unauthorized",
};

/** 可退避重试的失败：网络抖动、超时、限流、上游暂不可用。 */
const RETRYABLE_CODES = new Set([
  "NETWORK_ERROR",
  "SERVER_ERROR",
  "CLOUD_DRIVE_UNAVAILABLE",
  "CLOUD_DRIVE_TIMEOUT",
  "CLOUD_DRIVE_RATE_LIMITED",
  "CLOUD_DRIVE_UPSTREAM_ERROR",
]);

/** 错误的稳定 code；非 `ApiError` 一律 `UNKNOWN`。 */
export function cloudDriveErrorCode(error: unknown): string {
  return error instanceof ApiError ? error.code : "UNKNOWN";
}

/** 兜底字典键（调用方 `t()` 后得到用户可读文案）。 */
export function cloudDriveErrorKey(error: unknown): string {
  return ERROR_KEY_BY_CODE[cloudDriveErrorCode(error)] ?? "errors.unknown";
}

/** 优先返回服务端 message；为空时返回字典兜底。 */
export function cloudDriveErrorMessage(error: unknown, t: (key: string) => string): string {
  const message = error instanceof Error ? error.message.trim() : "";
  return message || t(cloudDriveErrorKey(error));
}

/** 上传会话已结束（410）：必须停止续传并重新建会话，而不是当成上游故障重试。 */
export function isUploadGone(error: unknown): boolean {
  return cloudDriveErrorCode(error) === "CLOUD_DRIVE_UPLOAD_GONE";
}

/** 上传会话不存在（404 且 code 明确指向会话）：同样不能续传。 */
export function isUploadMissing(error: unknown): boolean {
  return cloudDriveErrorCode(error) === "CLOUD_DRIVE_UPLOAD_NOT_FOUND";
}

/** 是否值得原地重试（页面级、分片级共用）。 */
export function isRetryableCloudDriveError(error: unknown): boolean {
  return RETRYABLE_CODES.has(cloudDriveErrorCode(error));
}

/** 用户主动取消（`AbortController`）不是失败，调用方据此展示「已取消」而不是错误。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
