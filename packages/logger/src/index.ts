/**
 * RCS 统一日志器 — 以 pino 为底层，全局拦截 console.* 调用
 *
 * 功能：
 *   - 控制台输出（pretty 着色 / JSON，由 LOG_FORMAT 控制）
 *   - 文件按天滚动（始终开启，同步写入，兼容 Bun）
 *   - error 及以上级别额外写入独立错误日志文件
 *   - 请求级上下文自动注入（AsyncLocalStorage，等价 Java MDC）
 *   - LOG_LEVEL / LOG_FORMAT / LOG_DIR 环境变量配置
 *
 * 日志级别策略：
 *   默认 LOG_LEVEL=info，控制台和文件统一输出。
 *   以下内容使用 debug 级别，默认不显示，设 LOG_LEVEL=debug 可查看：
 *
 *   debug 级别内容                                    | 来源
 *   ──────────────────────────────────────────────────|──────────────────────────
 *   前端轮询：/web/config/agents、/web/environments、  | src/plugins/logger.ts
 *     /web/config/models、/web/environments/{id}/instances |
 *   WebSocket 连接/注册/断连/消息路由                 | src/transport/ws-handler.ts
 *   ACP WebSocket 连接/注册/断连/消息路由             | src/transport/acp-ws-handler.ts
 *   File WebSocket 连接/注册/断连/文件操作            | src/transport/file-ws-handler.ts
 *
 * 用法：
 *   import { createLogger } from "@fenix/logger"
 *   const logger = createLogger("scheduler")
 *   logger.info("task started", { taskId: "123" })
 *   // 在请求上下文中，日志自动带 requestId / username / orgName
 *
 *   // 兼容旧 API
 *   import { log, error, warn } from "@fenix/logger"
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { Writable } from "node:stream";
import pino from "pino";
import pretty from "pino-pretty";

// ━━━━━ 类型 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 请求上下文（等价 Java MDC 的 key 集合） */
export interface RequestContext {
  requestId: string;
  userId?: string;
  username?: string;
  organizationId?: string;
  organizationName?: string;
}

export interface StructuredLogEntry {
  timestamp: string;
  level: "info" | "warn" | "error" | "debug";
  module: string;
  message: string;
  requestId?: string;
  userId?: string;
  username?: string;
  organizationId?: string;
  organizationName?: string;
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

// ━━━━━ 全局异步上下文存储 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 请求级上下文传播容器。
 *
 * Java 类比：相当于 ThreadLocal<Map<String, String>>（即 MDC 的底层）。
 * TS 单线程下用 AsyncLocalStorage 追踪异步链，效果等同：
 *   enterWith({ requestId })  ←→  MDC.put("requestId", id)
 *   getStore()                ←→  MDC.getCopyOfContextMap()
 *
 * 非请求上下文（定时任务、启动阶段）getStore() 返回 undefined，
 * logger 写入时自动跳过上下文字段，不影响输出。
 */
export const requestAls = new AsyncLocalStorage<RequestContext>();

// ━━━━━ 环境检测 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 仅 bun test 时自动静默，不做环境区分
const isTest = process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST);
const logFormat = process.env.LOG_FORMAT ?? "pretty";
const logLevel = isTest ? "silent" : (process.env.LOG_LEVEL ?? "info");
const logDir = process.env.LOG_DIR ?? "logs";
const logRetentionDays = parseInt(process.env.LOG_RETENTION_DAYS ?? "30", 10);
const usePretty = logFormat !== "json";

// ━━━━━ 按天滚动文件流 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 按日期滚动的文件写入流。
 *
 * 不依赖 pino-roll（其 worker thread 在 Bun 下有兼容问题），
 * 直接用 appendFileSync 同步写入，每次写入前检查日期，
 * 日期变更自动切换到新文件。
 *
 * 文件命名：{logDir}/{prefix}.{yyyy-MM-dd}.log
 * 等价 Java 的 TimeBasedRollingPolicy。
 */
class DailyRollingFileStream extends Writable {
  private currentDate = "";
  private filePath = "";
  private cleanedUp = false;

  constructor(
    private readonly baseDir: string,
    private readonly prefix: string,
  ) {
    super({ decodeStrings: true });
    mkdirSync(baseDir, { recursive: true });
  }

  /** 清理超过 retentionDays 的过期日志文件。只在首次日期切换时执行一次。 */
  private cleanupExpiredLogs(): void {
    if (this.cleanedUp || logRetentionDays <= 0) return;
    this.cleanedUp = true;
    try {
      const files = readdirSync(this.baseDir);
      const prefix = `${this.prefix}.`;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - logRetentionDays);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      for (const file of files) {
        if (!file.startsWith(prefix) || !file.endsWith(".log")) continue;
        const dateStr = file.slice(prefix.length, -".log".length);
        if (dateStr < cutoffStr) {
          unlinkSync(`${this.baseDir}/${file}`);
        }
      }
    } catch {
      // 清理失败不影响主流程
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: Writable _write signature
  _write(chunk: any, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      const today = new Date().toISOString().slice(0, 10); // yyyy-MM-dd
      if (today !== this.currentDate) {
        this.currentDate = today;
        this.filePath = `${this.baseDir}/${this.prefix}.${today}.log`;
        this.cleanupExpiredLogs();
      }
      appendFileSync(this.filePath, chunk);
      callback();
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
  }
}

// ━━━━━ pino 根实例 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// LOG_FORMAT 控制：
//   pretty（默认）→ 控制台着色 + 文件滚动
//   json          → 控制台 JSON + 文件滚动
// LOG_LEVEL 控制级别（默认 info）
// LOG_DIR  控制文件目录（默认 logs）

function buildPinoInstance() {
  const options = {
    level: logLevel,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label: string) => ({ level: label }),
      bindings: () => ({}),
    },
  } satisfies Parameters<typeof pino>[0];

  // 测试环境：静默
  if (isTest) {
    return pino(options);
  }

  // biome-ignore lint/suspicious/noExplicitAny: pino.multistream 接受任意 Writable 流
  const streams: any[] = [];

  // 控制台 + 文件统一级别（LOG_LEVEL 控制）
  if (usePretty) {
    streams.push(
      pretty({
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
        messageFormat: "[{module}] {msg}",
      }),
    );
  } else {
    streams.push(process.stdout);
  }

  streams.push(new DailyRollingFileStream(logDir, "rcs"));
  streams.push({
    level: "error",
    stream: new DailyRollingFileStream(logDir, "rcs.err"),
  });

  return pino(options, pino.multistream(streams));
}

const pinoInstance = buildPinoInstance();

// ━━━━━ ALS 上下文读取 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 从 ALS 读取当前请求上下文，合并进日志。
 *
 * Java 类比：
 *   MDC.get("requestId")  → String
 *   requestAls.getStore() → { requestId, username, orgName, ... }
 *
 * 不在请求上下文中（定时任务、启动阶段）时返回空对象，不影响输出。
 */
function getAlsContext(): Record<string, unknown> {
  const store = requestAls.getStore();
  if (!store) return {};
  const ctx: Record<string, unknown> = {};
  // 只写入有值的字段，避免日志中大量 undefined
  if (store.requestId) ctx.requestId = store.requestId;
  if (store.userId) ctx.userId = store.userId;
  if (store.username) ctx.username = store.username;
  if (store.organizationId) ctx.organizationId = store.organizationId;
  if (store.organizationName) ctx.organizationName = store.organizationName;
  return ctx;
}

// ━━━━━ createLogger ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

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
  const child = pinoInstance.child({ module });

  const makeEntry = (
    level: StructuredLogEntry["level"],
    message: string,
    extra?: Record<string, unknown>,
  ): StructuredLogEntry => ({
    timestamp: new Date().toISOString(),
    level,
    module,
    message,
    ...getAlsContext(),
    ...extra,
  });

  return {
    info: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.info({ ...getAlsContext(), ...extras }, msg);
    },
    warn: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.warn({ ...getAlsContext(), ...extras }, msg);
    },
    error: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.error({ ...getAlsContext(), ...extras }, msg);
    },
    debug: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.debug({ ...getAlsContext(), ...extras }, msg);
    },
    log: (...args: unknown[]) => {
      const [msg, extras] = argsToMsg(args);
      child.info({ ...getAlsContext(), ...extras }, msg);
    },
    formatEntry: (level, message, extra) => makeEntry(level, message, extra),
  };
}

// ━━━━━ 全局默认导出（兼容旧 import { log, error, warn }） ━━━

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

// ━━━━━ 全局 console 拦截 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
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
