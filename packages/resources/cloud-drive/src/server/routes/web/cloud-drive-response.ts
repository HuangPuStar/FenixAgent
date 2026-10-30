import { WebErrSchema } from "@fenix/platform-sdk";
import type { CloudDriveFailureKind } from "../../client/cloud-drive-error";
import type { CloudDriveFailure, CloudDriveResult } from "../../facades/cloud-drive-result";

/**
 * `/web/cloud-drive/*` 的响应映射：Facade 结果 → `/web/*` 信封。
 *
 * 分类到状态码的对应关系只在这里出现一次（knowledge 的同名文件是同一套做法）。响应体的 `code` /
 * `message` 一律原样透传 Facade 给出的文案，本层不改写，也不补上游细节。
 *
 * 为什么 401/403 上游错误映射成 502 而不是 401：它们几乎总是 master key / 来源网段 / scope 这类
 * **部署凭据**问题，与用户会话无关。透出 401 会让前端把用户踢下线，把一次部署配置错误放大成全体
 * 用户登录失效。
 */
const STATUS_BY_KIND: Record<CloudDriveFailureKind, number> = {
  invalid: 400,
  "not-configured": 503,
  "not-found": 404,
  conflict: 409,
  "payload-too-large": 413,
  unavailable: 503,
  "rate-limited": 429,
  unprocessable: 422,
  gone: 410,
  upstream: 502,
};

/**
 * 各端点声明的错误响应模型（OpenAPI 与响应校验共用一份）。
 *
 * 不含 401：守卫在进入处理函数前就可能短路，它的响应形状属于宿主，不归本包声明。
 */
export const WEB_ERROR_RESPONSES = {
  400: WebErrSchema,
  404: WebErrSchema,
  409: WebErrSchema,
  413: WebErrSchema,
  410: WebErrSchema,
  416: WebErrSchema,
  422: WebErrSchema,
  429: WebErrSchema,
  502: WebErrSchema,
  503: WebErrSchema,
} as const;

/** Elysia 的 `error` 装饰器：按状态码构造响应。 */
export type WebErrorResponder = (status: number, body: unknown) => unknown;

/**
 * Elysia 路由上下文。
 *
 * `sessionAuth` 宏由宿主注入的守卫提供，包内拿不到它的 `store` / `body` / `params` 推断类型；
 * 逐处写 `any` 只会散落十几条 ignore，收成一个别名更清楚。
 */
// biome-ignore lint/suspicious/noExplicitAny: sessionAuth 宏由宿主守卫注入，包内无法推断上下文类型
export type WebRouteContext = any;

/** `/web/*` 成功信封。 */
export function webData<T>(data: T): { readonly success: true; readonly data: T } {
  return { success: true, data };
}

/** `/web/*` 失败信封。 */
export function webError(
  code: string,
  message: string,
): { readonly success: false; readonly error: { code: string; message: string } } {
  return { success: false, error: { code, message } };
}

/** 状态码选择只此一处：Facade 失败分类 → HTTP 数字。 */
export function statusForFailure(failure: CloudDriveFailure): number {
  return STATUS_BY_KIND[failure.kind];
}

/** 把 Facade 结果映射成控制台响应：成功走信封，失败按分类选状态码。 */
export function respondToWeb<T>(result: CloudDriveResult<T>, error: WebErrorResponder): unknown {
  if (result.ok) return webData(result.data);
  return error(statusForFailure(result.error), webError(result.error.code, result.error.message));
}

/** 未登录（守卫未写入 `authContext` 时的兜底；正常情况下守卫已提前拒绝）。 */
export function respondUnauthorized(error: WebErrorResponder): unknown {
  return error(401, webError("UNAUTHORIZED", "未登录"));
}
