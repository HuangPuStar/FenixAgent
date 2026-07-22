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
import { ValidationError } from "elysia";

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

/**
 * 向响应注入 X-Request-Id 响应头和 JSON 响应体中的 requestId 字段。
 * 挂到主 app 的 onAfterHandle 上（紧接 logResponse 之后）。
 */
// biome-ignore lint/suspicious/noExplicitAny: Elysia AfterHandler context 签名与 set.headers 不兼容
export function injectRequestId({ request, set }: any) {
  const requestId = request.__requestId as string | undefined;
  if (!requestId) return;
  set.headers["X-Request-Id"] = requestId;
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
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const start = (request as any).__startTime as number | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: custom request property
  const id = (request as any).__requestId as string;
  const ms = start != null ? performance.now() - start : -1;
  const status = typeof set.status === "number" ? set.status : 500;
  const url = new URL(request.url);
  if (id) {
    set.headers["X-Request-Id"] = id;
  }

  // Elysia schema 校验失败 — ValidationError.message 默认是 ZodError 完整序列化 JSON
  // （含 unionErrors 所有分支的 issues），直接打印会刷屏。
  // 这里改成单行诊断日志：type（request/response）+ path + 响应数据形状摘要，
  // 既能定位是哪个 schema 不匹配，又能保留排查线索。
  if (err instanceof ValidationError) {
    const firstError = err.all[0];
    const path = firstError?.path ?? "";
    const summary = firstError?.summary ?? firstError?.message ?? "validation failed";
    logger.error(
      `${request.method} ${url.pathname} ${status} ${ms.toFixed(2)}ms [${id ?? "n/a"}] ` +
        `VALIDATION type='${err.type}' path='${path}' summary='${summary}' value=${describeValue(err.value)}`,
    );
    return;
  }

  logger.error(
    `${request.method} ${url.pathname} ${status} ${ms.toFixed(2)}ms [${id ?? "n/a"}]`,
    err instanceof Error ? err : new Error(String(err)),
  );
}

/**
 * 把响应/请求值压缩成单行形状描述，方便日志定位 schema 不匹配根因。
 * 数组额外打印首元素 JSON（截断 300 字符），用于直接看到字段名和可疑值。
 */
function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value)) {
    if (value.length === 0) return "array[0]";
    const first = value[0];
    if (first && typeof first === "object") {
      const keys = Object.keys(first).slice(0, 8).join(",");
      const sample = safeJsonStringify(first, 300);
      return `array[${value.length}]{${keys}} first=${sample}`;
    }
    return `array[${value.length}]<${typeof first}>`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).slice(0, 8).join(",");
    return `object{${keys}}`;
  }
  const s = String(value);
  return `${typeof value}:${s.length > 50 ? `${s.slice(0, 50)}...` : s}`;
}

/** JSON.stringify 但捕获循环引用和截断超长输出。 */
function safeJsonStringify(value: unknown, maxLen: number): string {
  try {
    const s = JSON.stringify(value);
    return s.length > maxLen ? `${s.slice(0, maxLen)}...` : s;
  } catch {
    return "<unserializable>";
  }
}
