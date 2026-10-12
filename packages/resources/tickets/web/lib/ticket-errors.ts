/**
 * 工单失败分类：把「无权限」与「不存在」从通用失败里分出来。
 *
 * **这是仓内第 5 份 `isUnauthorizedError` 副本**（既有四份：`@fenix/resource-mcp`、
 * `@fenix/resource-plugin-market`、`@fenix/resource-task`、`@fenix/resource-workflow-v2`）。
 * `@fenix/web-runtime` 今天没有承载这类判定的出口，故按前端规范 §4.1「抽象延迟到第二个真实用例」的反面
 * ——用例已足够多——仍不在此批新建跨包契约：下沉它要同时改五个包的 import 与各自的用例，属独立重构，
 * 与本批目标（工单功能）无关。
 *
 * **下沉触发条件**（届时按此收敛到 `@fenix/web-runtime/api/error-classify` 一类的窄口）：出现第 6 个
 * 消费方，或需要按错误码做除「有没有权限」以外的判别（如 `TICKETS_PAUSED` 这类可重试 503）时，
 * 由 `web-runtime` 拥有分类表，各包只调用。
 */

import { ApiError } from "@fenix/web-runtime/api/request";

/**
 * 无权限码。两个都要认：`UNAUTHORIZED` 是 `request()` 在响应体没有 code 时对 401/403 的归一值，
 * `FORBIDDEN` 是服务端 `ForbiddenError` 透传的业务码（`request()` 只在无 code 时才按 HTTP 状态归一，
 * 因此不能只看状态码）。
 */
const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHORIZED"]);

/**
 * 判断失败是否属「无权限」。授权是持久状态，重试只会再拿一个 403，因此调用方对它**只展示原因、不给重试**；
 * 其余失败（网络、5xx、503 暂停）必须保留重试入口。
 */
export function isUnauthorizedError(error: unknown): boolean {
  return error instanceof ApiError && UNAUTHORIZED_CODES.has(error.code);
}

/** 判断失败是否「工单不存在或无权访问」（服务端对跨组织资源返回 404，与不存在同形）。 */
export function isNotFoundError(error: unknown): boolean {
  return error instanceof ApiError && error.code === "NOT_FOUND";
}
