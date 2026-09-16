import { createReadStream, type Stats } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const LOG_FILE_PATTERN = /^[^/\\\0]+\.log$/i;
const MAX_SEARCH_FILE_BYTES = 50 * 1024 * 1024;
const MAX_LINE_LENGTH = 8_000;

export interface SystemLogFile {
  name: string;
  size: number;
  modifiedAt: string;
  isErrorLog: boolean;
}

export interface SystemLogEntry {
  timestamp: string | null;
  level: string | null;
  module: string | null;
  requestId: string | null;
  message: string;
  error: { type: string | null; message: string | null; stack: string | null } | null;
}

export interface SystemLogSearchResult {
  file: SystemLogFile;
  entries: SystemLogEntry[];
  totalMatches: number;
  truncated: boolean;
}

export interface SystemLogService {
  listFiles(): Promise<SystemLogFile[]>;
  searchFile(input: {
    fileName: string;
    query?: string;
    errorOnly?: boolean;
    limit: number;
  }): Promise<SystemLogSearchResult>;
  resolveDownload(fileName: string): Promise<{ path: string; file: SystemLogFile }>;
}

export class InvalidLogFileError extends Error {}
export class LogFileNotFoundError extends Error {}
export class LogFileTooLargeError extends Error {}

function toLogFile(name: string, info: Stats): SystemLogFile {
  return {
    name,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
    isErrorLog: /(?:^|[._-])err(?:or)?(?:[._-]|$)/i.test(name),
  };
}

function parseLogEntry(line: string): SystemLogEntry {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");

    const record = value as Record<string, unknown>;
    const error =
      typeof record.err === "object" && record.err !== null && !Array.isArray(record.err) ? record.err : null;
    const errorRecord = error as Record<string, unknown> | null;
    return {
      timestamp: typeof record.time === "string" ? record.time : null,
      level: typeof record.level === "string" ? record.level : null,
      module: typeof record.module === "string" ? record.module : null,
      requestId: typeof record.requestId === "string" ? record.requestId : null,
      message: typeof record.msg === "string" ? record.msg : line,
      error: errorRecord
        ? {
            type: typeof errorRecord.type === "string" ? errorRecord.type : null,
            message: typeof errorRecord.message === "string" ? errorRecord.message : null,
            stack: typeof errorRecord.stack === "string" ? errorRecord.stack : null,
          }
        : null,
    };
  } catch {
    return { timestamp: null, level: null, module: null, requestId: null, message: line, error: null };
  }
}

function entryMatchesQuery(entry: SystemLogEntry, query: string): boolean {
  return !query || JSON.stringify(entry).toLocaleLowerCase().includes(query);
}

function isErrorEntry(entry: SystemLogEntry): boolean {
  return entry.level?.toLocaleLowerCase() === "error" || /error/i.test(entry.message);
}

/** 创建只允许访问日志根目录直属 .log 文件的系统日志服务。 */
export function createSystemLogService(logRoot = resolve(process.cwd(), "logs")): SystemLogService {
  const resolveFile = async (fileName: string) => {
    if (!LOG_FILE_PATTERN.test(fileName)) throw new InvalidLogFileError("Invalid log file name");

    const path = resolve(logRoot, fileName);
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new LogFileNotFoundError("Log file not found");
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new LogFileNotFoundError("Log file not found");
    return { path, file: toLogFile(fileName, info) };
  };

  return {
    async listFiles() {
      const entries = await readdir(logRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
      const files = await Promise.all(
        entries
          .filter((entry) => entry.isFile() && LOG_FILE_PATTERN.test(entry.name))
          .map(async (entry) => {
            const info = await stat(resolve(logRoot, entry.name));
            return toLogFile(entry.name, info);
          }),
      );
      return files.sort((left, right) => right.modifiedAt.localeCompare(left.modifiedAt));
    },

    async searchFile({ fileName, query = "", errorOnly = false, limit }) {
      const resolved = await resolveFile(fileName);
      if (resolved.file.size > MAX_SEARCH_FILE_BYTES) {
        throw new LogFileTooLargeError("Log file is too large to search");
      }

      const normalizedQuery = query.trim().toLocaleLowerCase();
      const entries: SystemLogEntry[] = [];
      let totalMatches = 0;
      const reader = createInterface({ input: createReadStream(resolved.path), crlfDelay: Infinity });

      for await (const line of reader) {
        const entry = parseLogEntry(line.slice(0, MAX_LINE_LENGTH));
        if (!entryMatchesQuery(entry, normalizedQuery)) continue;
        if (errorOnly && !isErrorEntry(entry)) continue;

        totalMatches += 1;
        entries.push(entry);
        if (entries.length > limit) entries.shift();
      }

      return {
        file: resolved.file,
        entries,
        totalMatches,
        truncated: totalMatches > entries.length,
      };
    },

    resolveDownload,
  };

  async function resolveDownload(fileName: string) {
    return resolveFile(fileName);
  }
}

export const systemLogService = createSystemLogService();
