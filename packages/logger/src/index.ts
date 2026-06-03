/**
 * RCS 统一日志器 — 以 pino 为底层，全局拦截 console.* 调用
 *
 * 用法：
 *   import { createLogger } from "./logger"
 *   const logger = createLogger("scheduler")
 *   logger.info("task started", { taskId: "123" })
 *
 *   // 兼容旧 API
 *   import { log, error, warn } from "./logger"
 *   log("hello")              // → pino.info
 *   error("boom", new Error("x"))  // → pino.error
 *
 *   // 裸 console.log 也会被拦截（自动归入 [console] 模块）
 *   console.log("whatever")   // → 走 pino.info，输出结构化格式
 */

import pino from "pino";

// ─── 类型 ───────────────────────────────────────────────

export interface StructuredLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  module: string;
  message: string;
  requestId?: string;
  duration?: string;
  [key: string]: unknown;
}

export interface Logger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  /** @deprecated 兼容旧 API，内部调用 info */
  log: (...args: unknown[]) => void;
  /** 构造结构化日志条目（仅供测试断言） */
  formatEntry: (
    level: StructuredLogEntry["level"],
    message: string,
    extra?: Record<string, unknown>,
  ) => StructuredLogEntry;
}

// ─── pino 实例 ──────────────────────────────────────────

const isTest = process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST);
const logFormat = process.env.LOG_FORMAT ?? "pretty"; // "pretty" | "json"

// 默认 pretty（人类可读），设 LOG_FORMAT=json 切换为 JSON（日志采集系统）
const usePretty = logFormat !== "json";

const pinoInstance = pino({
  level: isTest ? "silent" : (process.env.LOG_LEVEL ?? "info"),
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level(label) {
      return { level: label };
    },
    bindings(bindings) {
      return { module: bindings.name ?? "rcs" };
    },
  },
  transport: usePretty
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
          ignore: "pid,hostname,module",
          messageFormat: "[{module}] {msg}",
        },
      }
    : undefined,
});

// ─── createLogger ───────────────────────────────────────

function argsToMsg(args: unknown[]): [string, Record<string, unknown>?] {
  const strings: string[] = [];
  const extras: Record<string, unknown> = {};
  let hasExtra = false;

  for (const a of args) {
    if (typeof a === "string") {
      strings.push(a);
    } else if (a instanceof Error) {
      // pino 的 err 序列化会自动输出 message + stack
      if (strings.length === 0) strings.push(a.message);
      extras.err = a;
      hasExtra = true;
    } else if (a !== undefined && a !== null) {
      try {
        strings.push(typeof a === "object" ? JSON.stringify(a) : String(a));
      } catch {
        strings.push(String(a));
      }
    }
  }

  const msg = strings.join(" ");
  return hasExtra ? [msg, extras] : [msg];
}

export function createLogger(module: string): Logger {
  const child = pinoInstance.child({ name: module });

  const makeEntry = (
    level: StructuredLogEntry["level"],
    message: string,
    extra?: Record<string, unknown>,
  ): StructuredLogEntry => ({
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...extra,
  });

  return {
    info: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.info(extras, msg);
    },
    warn: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.warn(extras, msg);
    },
    error: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.error(extras, msg);
    },
    debug: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.debug(extras, msg);
    },
    log: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.info(extras, msg);
    },
    formatEntry: (level, message, extra) => makeEntry(level, message, extra),
  };
}

// ─── 全局默认导出（兼容旧 import { log, error, warn }） ──

const defaultLogger = createLogger("rcs");

export function log(...args: unknown[]): void {
  defaultLogger.info(...args);
}
export function error(...args: unknown[]): void {
  defaultLogger.error(...args);
}
export function warn(...args: unknown[]): void {
  defaultLogger.warn(...args);
}

// ─── 全局 console 拦截 ─────────────────────────────────
//
// 将裸 console.log / console.warn / console.error 重定向到 pino，
// 保证项目中所有散落的 console 调用也走统一格式。
// 拦截归入 [console] 模块，方便在日志中区分。

const consoleLogger = createLogger("console");

export function interceptConsole(): void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  // biome-ignore lint/suspicious/noExplicitAny: console.log 接受任意参数
  console.log = (...args: any[]) => {
    if (isTest) return;
    consoleLogger.info(...args);
  };
  // biome-ignore lint/suspicious/noExplicitAny: console.warn 接受任意参数
  console.warn = (...args: any[]) => {
    if (isTest) return;
    consoleLogger.warn(...args);
  };
  // biome-ignore lint/suspicious/noExplicitAny: console.error 接受任意参数
  console.error = (...args: any[]) => {
    if (isTest) return;
    consoleLogger.error(...args);
  };

  // 保留原始引用，供内部需要真正 console 输出时使用
  // biome-ignore lint/suspicious/noExplicitAny: globalThis 扩展属性
  (globalThis as any).__originalConsole = { log: originalLog, warn: originalWarn, error: originalError };
}
