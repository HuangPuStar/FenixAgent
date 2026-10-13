/**
 * 控制台系统日志的**投影服务**（§7「只读取经过权限过滤的日志投影，不得直接暴露底层日志文件」）。
 *
 * 与改造前的分界：旧实现把日志目录当成可列举的「一堆文件」，客户端传文件名、服务端 `resolve` 后按行读、
 * 下载端点整文件流式回传。现在客户端只能传**服务端枚举出的日志源 ID**，且所有出口（列表、检索、导出）
 * 都经过 `./log-projection` 的字段投影与红线脱敏。
 *
 * 「权限过滤」在日志这条线上的现实口径：日志文件是进程级共享的，不按组织分目录，因此这里能做到的是
 *   - **可见范围**：只有本进程白名单化的日志源（`@fenix/logger` 的 `listLogSources`）能被检索与导出，
 *     目录里其它 `.log` / 子目录 / 符号链接都不进入投影面；
 *   - **内容裁剪**：出站字段固定为六项，凭据形状的内容按 §7 红线脱敏，单字段有长度上限；
 *   - **不暴露文件**：响应里没有路径、没有原始行，导出也是投影后的 JSON Lines。
 * 调用方身份（谁能访问本接口）由宿主注入的系统 key 守卫判定，本服务不做第二遍角色判定——两处各判一次
 * 正是「界面按旧规则放行、接口按新规则拒绝」这类漂移的来源。
 *
 * 路径注入在结构上不可达：`resolveSource` 先校验 ID 形状（让协议误用变成 400 而非含混 404），
 * 再**按 ID 命中枚举结果**——永不把客户端输入拼进路径。对外的 404 与 413 都不回显路径信息。
 */

import { createReadStream, type Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { createInterface } from "node:readline";
import {
  LOG_SOURCE_ID_PATTERN,
  type LogSourceDescriptor,
  type LogSourceKind,
  listLogSources,
  resolveLogDir,
} from "@fenix/logger";
import { type ProjectedLogEntry, projectLogLine } from "./log-projection";

/** 单次检索或导出的文件上限：超过即拒绝，避免把超大文件读进内存或长时间占用连接。 */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;

/** 日志源的对外形状；不含路径与原始文件名，只给投影面需要的身份与体量。 */
export interface SystemLogSource {
  id: string;
  kind: LogSourceKind;
  /** 日志日期（`yyyy-MM-dd`，UTC）。 */
  date: string;
  size: number;
  modifiedAt: string;
}

export interface SystemLogSearchResult {
  source: SystemLogSource;
  entries: ProjectedLogEntry[];
  totalMatches: number;
  truncated: boolean;
}

export interface SystemLogExport {
  source: SystemLogSource;
  /** 投影后的 JSON Lines 响应体（逐行产出，不缓冲整个文件）。 */
  body: ReadableStream<Uint8Array>;
}

export interface SystemLogService {
  listSources(): Promise<SystemLogSource[]>;
  search(input: {
    sourceId: string;
    query?: string;
    errorOnly?: boolean;
    limit: number;
  }): Promise<SystemLogSearchResult>;
  openExport(sourceId: string): Promise<SystemLogExport>;
}

/** ID 形状非法（客户端传了文件名、路径等）——协议误用，与「源不存在」区分开以便观测。 */
export class InvalidLogSourceError extends Error {}
/** 枚举结果里没有该 ID，或它在枚举后已被轮转清理。 */
export class LogSourceNotFoundError extends Error {}
/** 源超过单次读取上限。 */
export class LogSourceTooLargeError extends Error {}

function toSourceView(descriptor: LogSourceDescriptor, info: Stats): SystemLogSource {
  return {
    id: descriptor.id,
    kind: descriptor.kind,
    date: descriptor.date,
    size: info.size,
    modifiedAt: info.mtime.toISOString(),
  };
}

function entryMatchesQuery(entry: ProjectedLogEntry, query: string): boolean {
  return !query || JSON.stringify(entry).toLocaleLowerCase().includes(query);
}

function isErrorEntry(entry: ProjectedLogEntry): boolean {
  return entry.level?.toLocaleLowerCase() === "error" || /error/i.test(entry.message);
}

/**
 * 逐行投影文件内容。
 *
 * 句柄释放归这个生成器：调用方提前 `break`（达到 limit）或导出被取消时，`finally` 关掉 readline 与
 * 文件流——readline 提前关闭**不会**回收底层 fd，必须显式 `destroy()`，否则每条导出连接都会漏一个句柄。
 */
async function* projectLines(path: string): AsyncGenerator<ProjectedLogEntry> {
  const input = createReadStream(path);
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      yield projectLogLine(line);
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/**
 * 把日志源投影成 JSON Lines 流。
 *
 * 导出与检索共用 `projectLogLine`，因此两者的过滤口径不可能分叉——这正是「下载也要走投影层」的实现口径。
 * 逐行 `pull` 天然吃背压；流已开始后出错只能终结流（响应头已发出），这与改造前的文件流同形。
 */
function createProjectedJsonLineStream(path: string): ReadableStream<Uint8Array> {
  const entries = projectLines(path);
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await entries.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await entries.return(undefined);
    },
  });
}

/**
 * 创建日志投影服务。
 *
 * `logDir` 是测试 seam（包内用例指向临时目录）；缺省时按调用时点解析 `@fenix/logger` 的 `resolveLogDir()`，
 * 本包不读 `LOG_DIR`——该变量的 owner 是 logger，两处解析会让读写指向不同目录。
 */
export function createSystemLogService(logDir?: string): SystemLogService {
  const currentLogDir = () => logDir ?? resolveLogDir();

  /** 把客户端 ID 解析为服务端记录：ID → 枚举命中 → 复核 → 可读路径。任一步失败都不回显输入。 */
  async function resolveSource(sourceId: string): Promise<{ source: SystemLogSource; path: string }> {
    if (!LOG_SOURCE_ID_PATTERN.test(sourceId)) throw new InvalidLogSourceError("Invalid log source id");

    const descriptor = listLogSources(currentLogDir()).find((entry) => entry.id === sourceId);
    if (!descriptor) throw new LogSourceNotFoundError("Log source not found");

    // 枚举与打开之间文件可能已被轮转清理，或名字被换成符号链接（TOCTOU）：只认常规文件。
    const info = await lstat(descriptor.path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new LogSourceNotFoundError("Log source not found");
      throw error;
    });
    if (!info.isFile() || info.isSymbolicLink()) throw new LogSourceNotFoundError("Log source not found");

    return { source: toSourceView(descriptor, info), path: descriptor.path };
  }

  return {
    async listSources() {
      const descriptors = listLogSources(currentLogDir());
      const views = await Promise.all(
        descriptors.map(async (descriptor) => {
          try {
            const info = await lstat(descriptor.path);
            return info.isFile() && !info.isSymbolicLink() ? toSourceView(descriptor, info) : null;
          } catch (error) {
            // 枚举后被轮转清理属正常竞态：跳过这一条，不把整张列表打成 500。
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw error;
          }
        }),
      );
      return views.filter((view): view is SystemLogSource => view !== null);
    },

    async search({ sourceId, query = "", errorOnly = false, limit }) {
      const { source, path } = await resolveSource(sourceId);
      if (source.size > MAX_SOURCE_BYTES) throw new LogSourceTooLargeError("Log source is too large to search");

      const normalizedQuery = query.trim().toLocaleLowerCase();
      const entries: ProjectedLogEntry[] = [];
      let totalMatches = 0;

      for await (const entry of projectLines(path)) {
        if (!entryMatchesQuery(entry, normalizedQuery)) continue;
        if (errorOnly && !isErrorEntry(entry)) continue;

        totalMatches += 1;
        entries.push(entry);
        if (entries.length > limit) entries.shift();
      }

      return { source, entries, totalMatches, truncated: totalMatches > entries.length };
    },

    async openExport(sourceId) {
      const { source, path } = await resolveSource(sourceId);
      if (source.size > MAX_SOURCE_BYTES) throw new LogSourceTooLargeError("Log source is too large to export");
      return { source, body: createProjectedJsonLineStream(path) };
    },
  };
}

/** 进程级默认实例；目录按请求解析，进程启动后改动 `LOG_DIR` 无需重启（测试用 `createSystemLogService(dir)` 覆盖）。 */
export const systemLogService = createSystemLogService();
