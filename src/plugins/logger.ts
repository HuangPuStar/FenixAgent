/**
 * Elysia 请求日志 — 基于 pino logger + AsyncLocalStorage
 *
 * 功能：
 *   - 每个请求分配唯一 requestId 并注入 ALS（等价 Java MDC.put）
 *   - 后续所有 logger.info/error 自动携带 requestId，无需手动传参
 *   - 请求耗时 + 慢请求告警（>1s warn，>5s error）
 *   - /health 端点静默
 *
 * 注意：不使用 Elysia 插件封装（derive 在 .use() 中作用域被隔离，不会触发），
 * 而是导出函数直接挂到主 app。
 */

import { createLogger, requestAls } from "@fenix/logger";

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

// ─── 日志钩子函数 ───────────────────────────────────────
// 直接挂到 Elysia 主 app 上，不通过 .use(plugin) 封装

/** 注入 requestId + ALS 上下文。挂到主 app 的 derive 上。 */
export function deriveRequestId({ request }: { request: Request }) {
  const requestId = nextRequestId();

  // 注入 ALS 上下文 — 等价 Java Filter 里的 MDC.put("requestId", id)
  requestAls.enterWith({ requestId });

  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  (request as any).__requestId = requestId;
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  (request as any).__startTime = performance.now();
  return { requestId };
}

/** 请求开始日志。挂到主 app 的 onBeforeHandle 上。 */
export function logRequest({ request }: { request: Request }) {
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const id = (request as any).__requestId as string;
  const url = new URL(request.url);
  if (url.pathname === "/health") return;
  if (isPollingPath(url.pathname)) {
    logger.debug(`${request.method} ${url.pathname} [${id}]`);
  } else {
    logger.info(`${request.method} ${url.pathname} [${id}]`);
  }
}

/** 请求结束日志。挂到主 app 的 onAfterHandle 上。 */
export function logResponse({ request, set }: { request: Request; set: { status?: number | string } }) {
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const start = (request as any).__startTime as number | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const id = (request as any).__requestId as string;
  const ms = start != null ? performance.now() - start : -1;
  const status = typeof set.status === "number" ? set.status : 200;
  const url = new URL(request.url);
  if (url.pathname === "/health") return;

  const msg = `${request.method} ${url.pathname} ${status} ${ms.toFixed(2)}ms [${id}]`;
  if (isPollingPath(url.pathname)) {
    logger.debug(msg);
  } else {
    logger.info(msg);
    if (ms >= 5000) {
      logger.error(`SLOW REQUEST ${request.method} ${url.pathname} ${ms.toFixed(0)}ms [${id}]`);
    } else if (ms >= 1000) {
      logger.warn(`SLOW REQUEST ${request.method} ${url.pathname} ${ms.toFixed(0)}ms [${id}]`);
    }
  }
}

/** 请求错误日志。挂到主 app 的 onError 上。 */
export function logError({
  request,
  error: err,
  set,
}: {
  request: Request;
  error: unknown;
  set: { status?: number | string };
}) {
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const start = (request as any).__startTime as number | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const id = (request as any).__requestId as string;
  const ms = start != null ? performance.now() - start : -1;
  const status = typeof set.status === "number" ? set.status : 500;
  const url = new URL(request.url);
  logger.error(
    `${request.method} ${url.pathname} ${status} ${ms.toFixed(2)}ms [${id ?? "n/a"}]`,
    err instanceof Error ? err : new Error(String(err)),
  );
}
