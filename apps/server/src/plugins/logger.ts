/**
 * Elysia 请求日志 — 基于 pino logger + AsyncLocalStorage
 *
 * 功能：
 *   - 每个请求分配唯一 requestId 并注入 ALS（等价 Java MDC.put）
 *   - 后续所有 logger.info/error 自动携带 requestId，无需手动传参
 *   - 耗时和慢请求判断由标准 OTel 指标承担，访问日志不另计时
 *   - /health 端点静默
 *
 * 注意：不使用 Elysia 插件封装（derive 在 .use() 中作用域被隔离，不会触发），
 * 而是导出函数直接挂到主 app。
 */

import { extname } from "node:path";
import { createLogger, requestAls } from "@fenix/logger";
import { ElysiaCustomStatusResponse, ValidationError } from "elysia";

const logger = createLogger("http");

// ─── 高频轮询路径 ────────────────────────────────────────
// 这些路径被前端 sidebar 15s 轮询，日志降为 debug 级别避免刷屏
const POLLING_PATHS = ["/web/config/agents", "/web/environments", "/web/config/models"];

function isPollingPath(pathname: string): boolean {
  if (POLLING_PATHS.includes(pathname)) return true;
  // /web/environments/{id}/instances
  if (pathname.startsWith("/web/environments/") && pathname.endsWith("/instances")) return true;
  return false;
}

// ─── requestId 生成 ─────────────────────────────────────

function nextRequestId(): string {
  return crypto.randomUUID();
}

function isNotFoundLikeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "NotFoundError" || "status" in error || "code" in error;
}

/**
 * `/ctrl/*` 的前端深链会先被静态文件层尝试命中文件，再由 SPA fallback 接管。
 * 这类无扩展名路径的 404 属于可恢复流程，不应作为 error 日志输出。
 */
export function isRecoverableCtrlSpa404(request: Request, error: unknown, status: number): boolean {
  if (status !== 404 || !isNotFoundLikeError(error)) return false;

  const url = new URL(request.url);
  if (!url.pathname.startsWith("/ctrl/")) return false;
  if (extname(url.pathname)) return false;

  return true;
}

// ─── 日志钩子函数 ───────────────────────────────────────
// 直接挂到 Elysia 主 app 上，不通过 .use(plugin) 封装

const requestIds = new WeakMap<Request, string>();

/** 请求 ID 与 OTel trace ID 分离，不接受客户端标识作为授权依据。 */
export function deriveRequestId({ request }: { request: Request }) {
  const requestId = nextRequestId();
  requestAls.enterWith({ requestId });
  requestIds.set(request, requestId);
  return { requestId };
}

/** 每次响应只写一条访问日志；耗时由官方 OTel 插件唯一计量。 */
export function logResponse({
  request,
  set,
  responseValue,
  response,
}: {
  request: Request;
  set: { status?: number | string };
  responseValue?: unknown;
  response?: unknown;
}) {
  const status = resolveResponseStatus(set.status, responseValue ?? response);
  const pathname = new URL(request.url).pathname;
  if (pathname === "/health") return;
  const fields = { method: request.method, status, requestId: requestIds.get(request) };
  if (status >= 500) logger.error("HTTP 响应", fields);
  else if (status >= 400) logger.warn("HTTP 响应", fields);
  else if (isPollingPath(pathname)) logger.debug("HTTP 响应", fields);
  else logger.info("HTTP 响应", fields);
}

/**
 * 从统一响应日志层解析最终状态码。
 *
 * `logResponse` 挂在 `onAfterHandle`：此时 Elysia 尚未把处理器返回值的状态映射到 `set.status`（仍是默认
 * 的 200），真实状态只存在于返回值上——`status(code, body)` 的容器（`ElysiaCustomStatusResponse`）与
 * 原生 `Response`。因此必须先读返回值，再回退到显式设置的 `set.status`，否则这些 4xx/5xx 会被记成 200。
 */
export function resolveResponseStatus(setStatus: number | string | undefined, responseValue: unknown): number {
  if (responseValue instanceof ElysiaCustomStatusResponse && typeof responseValue.code === "number") {
    return responseValue.code;
  }
  if (responseValue instanceof Response) return responseValue.status;
  if (typeof setStatus === "number") return setStatus;
  return 200;
}

/**
 * 向响应注入 X-Request-Id 响应头和 JSON 响应体中的 requestId 字段。
 * 挂到主 app 的 onAfterHandle 上（紧接 logResponse 之后）。
 */
export function injectRequestId({
  request,
  set,
}: {
  request: Request;
  set: { headers: Record<string, string | number> };
}) {
  const requestId = requestIds.get(request);
  if (!requestId) return;
  set.headers["X-Request-Id"] = requestId;
}

function isDatabaseError(error: Error): boolean {
  if (error.name === "DrizzleQueryError") return true;
  const record = error as Error & { query?: unknown; params?: unknown };
  return typeof record.query === "string" || Array.isArray(record.params);
}

/**
 * 数据库驱动错误会附带 query、params 与 cause；params 可能包含 token、Header 或完整配置。
 * HTTP 边界仅保留稳定错误类别，不把原始数据库错误交给 pino 序列化。
 */
export function sanitizeErrorForLog(error: Error): Error {
  if (!isDatabaseError(error)) return error;
  const sanitized = new Error("Database operation failed");
  sanitized.name = error.name;
  return sanitized;
}

/** 请求错误日志。挂到主 app 的 onError 上。 */
export function logError({
  request,
  error: err,
  set,
}: {
  request: Request;
  error: unknown;
  set: { status?: number | string; headers: Record<string, string | number> };
}) {
  const id = requestIds.get(request);
  const status = typeof set.status === "number" ? set.status : 500;
  const url = new URL(request.url);
  if (id) {
    set.headers["X-Request-Id"] = id;
  }

  if (isRecoverableCtrlSpa404(request, err, status)) {
    logger.info(`${request.method} ${url.pathname} ${status} [${id ?? "n/a"}] SPA_FALLBACK`);
    return;
  }

  // 校验错误的 summary/value 可能包含输入正文，只保留协议字段位置。
  if (err instanceof ValidationError) {
    const firstError = err.all[0];
    const path = firstError?.path ?? "";
    logger.error("HTTP 协议校验失败", {
      method: request.method,
      status,
      requestId: id,
      validationType: err.type,
      field: path,
    });
    return;
  }

  logger.error(
    `${request.method} ${url.pathname} ${status} [${id ?? "n/a"}]`,
    err instanceof Error ? sanitizeErrorForLog(err) : new Error(String(err)),
  );
}
