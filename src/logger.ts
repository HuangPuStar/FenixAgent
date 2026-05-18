const isTest = process.env.NODE_ENV === "test" || (typeof Bun !== "undefined" && !!Bun.env.BUN_TEST);

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
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  formatEntry: (
    level: StructuredLogEntry["level"],
    message: string,
    extra?: Record<string, unknown>,
  ) => StructuredLogEntry;
}

function formatLog(entry: StructuredLogEntry): string {
  const { timestamp, level, module, message, ...rest } = entry;
  const base = `${timestamp} [${level.toUpperCase()}] [${module}] ${message}`;
  const extras = Object.entries(rest).filter(([, v]) => v !== undefined);
  if (extras.length === 0) return base;
  return `${base} ${JSON.stringify(Object.fromEntries(extras))}`;
}

export function createLogger(module: string): Logger {
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
    log: (...args: unknown[]) => {
      if (isTest) return;
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      const entry = makeEntry("info", msg);
      console.log(formatLog(entry));
    },
    error: (...args: unknown[]) => {
      if (isTest) return;
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      const entry = makeEntry("error", msg);
      console.error(formatLog(entry));
    },
    warn: (...args: unknown[]) => {
      if (isTest) return;
      const msg = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
      const entry = makeEntry("warn", msg);
      console.warn(formatLog(entry));
    },
    formatEntry: (level, message, extra) => makeEntry(level, message, extra),
  };
}

/** 全局默认 logger — 兼容现有 log()/error() 调用 */
const defaultLogger = createLogger("rcs");

export function log(...args: unknown[]): void {
  defaultLogger.log(...args);
}

export function error(...args: unknown[]): void {
  defaultLogger.error(...args);
}

export function warn(...args: unknown[]): void {
  defaultLogger.warn(...args);
}
