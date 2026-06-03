/**
 * 兼容桥接 — 重导出 @fenix/logger
 * 新代码请直接使用: import { createLogger } from "@fenix/logger"
 */
export { createLogger, error, interceptConsole, type Logger, log, type StructuredLogEntry, warn } from "@fenix/logger";
