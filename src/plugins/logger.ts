/**
 * Elysia 请求日志插件 — 基于 pino logger
 *
 * 功能：
 *   - 每个请求分配唯一 requestId
 *   - HTTP 方法 / 状态码着色（开发环境）
 *   - 请求耗时 + 响应体大小
 *   - 慢请求告警（>1s warn，>5s error）
 *   - /health 端点静默
 */

import { createLogger } from "@fenix/logger";
import Elysia from "elysia";

const logger = createLogger("http");

// ─── 颜色工具 ──────────────────────────────────────────

const isDev = process.env.NODE_ENV !== "production";

function colorize(text: string, code: number): string {
  return isDev ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const methodColors: Record<string, number> = {
  GET: 32, // green
  POST: 33, // yellow
  PUT: 36, // cyan
  PATCH: 36, // cyan
  DELETE: 31, // red
  OPTIONS: 90, // gray
  HEAD: 90,
};

function fmtMethod(method: string): string {
  return colorize(method.padEnd(7), methodColors[method] ?? 0);
}

function fmtStatus(status: number): string {
  if (status >= 500) return colorize(String(status), 31); // red
  if (status >= 400) return colorize(String(status), 33); // yellow
  if (status >= 300) return colorize(String(status), 36); // cyan
  return colorize(String(status), 32); // green
}

function fmtDuration(ms: number): string {
  if (ms >= 5000) return colorize(`${ms.toFixed(0)}ms`, 31); // red
  if (ms >= 1000) return colorize(`${ms.toFixed(0)}ms`, 33); // yellow
  return `${ms.toFixed(2)}ms`;
}

// ─── requestId 生成 ─────────────────────────────────────

let _seq = 0;

function nextRequestId(): string {
  _seq = (_seq + 1) % 1_000_000;
  const ts = Date.now().toString(36);
  const seq = _seq.toString(36).padStart(4, "0");
  return `req-${ts}-${seq}`;
}

// ─── 插件 ───────────────────────────────────────────────

export const loggerPlugin = new Elysia({ name: "logger" })
  .derive(({ request }) => {
    const requestId = nextRequestId();
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    (request as any).__requestId = requestId;
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    (request as any).__startTime = performance.now();
    return { requestId };
  })
  .onBeforeHandle(({ request }) => {
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    const id = (request as any).__requestId as string;
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      logger.info(`${fmtMethod(request.method)} ${url.pathname} [${id}]`);
    }
  })
  .onAfterHandle(({ request, set }) => {
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    const start = (request as any).__startTime as number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    const id = (request as any).__requestId as string;
    const ms = start != null ? performance.now() - start : -1;
    const duration = fmtDuration(ms);
    const status = set.status ?? 200;
    const url = new URL(request.url);
    if (url.pathname !== "/health") {
      logger.info(
        `${fmtMethod(request.method)} ${url.pathname} ${fmtStatus(typeof status === "number" ? status : 200)} ${duration} [${id}]`,
      );
      if (ms >= 5000) {
        logger.error(`SLOW REQUEST ${request.method} ${url.pathname} ${ms.toFixed(0)}ms [${id}]`);
      } else if (ms >= 1000) {
        logger.warn(`SLOW REQUEST ${request.method} ${url.pathname} ${ms.toFixed(0)}ms [${id}]`);
      }
    }
  })
  .onError(({ request, error: err, set }) => {
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    const start = (request as any).__startTime as number | undefined;
    // biome-ignore lint/suspicious/noExplicitAny: custom request property
    const id = (request as any).__requestId as string;
    const ms = start != null ? performance.now() - start : -1;
    const duration = fmtDuration(ms);
    const status = set.status ?? 500;
    const url = new URL(request.url);
    logger.error(
      `${fmtMethod(request.method)} ${url.pathname} ${fmtStatus(typeof status === "number" ? status : 500)} ${duration} [${id}]`,
      err instanceof Error ? err : new Error(String(err)),
    );
  });
