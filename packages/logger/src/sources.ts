/**
 * 已知日志源的只读枚举——写入侧（`index.ts` 的 pino 多流）与读取侧（控制台日志投影）共用的唯一清单。
 *
 * 为什么单独成文件而不是让读取侧自己 `readdir`：控制台不得直读底层日志文件，它只能按服务端枚举出的
 * ID 取投影，而「枚举出什么」必须与「写入了什么」同源。两侧若各写一份命名规则，就会同时存在两种漂移：
 * 读取侧少一个前缀 → 实际写入的日志在投影面上静默消失；多认一类文件 → 目录里任意 `.log` 都变成可读
 * 对象。因此写入侧也从本文件的 `LOG_SOURCE_PREFIXES` 建流，读取侧只认 `parseLogSourceFileName` 认得的名字。
 *
 * 边界的另一侧：本模块**只**做命名与列举（纯 fs 读取），不含任何权限判断——可见性由调用方的路由守卫
 * 决定，`listLogSources` 对任何调用者都返回同样的结果。目录与文件名不经外部输入，`resolve` 只用于把
 * 枚举到的名字接到目录上。
 *
 * 该清单有意保持短：日志目录归 `@fenix/logger` 独占，别的进程（`acp-link` 等）有自己的目录，不在这里
 * 登记；未来若引入新的滚动文件，必须同时在本表登记并确认读取侧口径（投影面按 kind 白名单裁剪）。
 */

import { type Dirent, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** 日志源类别：`app` 是全量日志（前缀 `rcs`），`error` 是 error 及以上级别的独立文件（前缀 `rcs.err`）。 */
export type LogSourceKind = "app" | "error";

/**
 * 写入侧的分级前缀表：`{prefix}.{yyyy-MM-dd}.log`（见 `DailyRollingFileStream`）。
 *
 * `minLevel` 是写入侧的分级过滤——`null` 表示不过滤，`error` 表示只收 error 及以上。
 * 读取侧不用它做过滤（它描述的是写入行为），但两者的前缀必须来自同一张表。
 */
export const LOG_SOURCE_PREFIXES = [
  { prefix: "rcs", kind: "app", minLevel: null },
  { prefix: "rcs.err", kind: "error", minLevel: "error" },
] as const;

/** 日志文件名的日期段：与写入侧 `new Date().toISOString().slice(0, 10)` 同口径（UTC）。 */
const LOG_FILE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * 一个可读日志源。
 *
 * `id` 由服务端生成、是客户端唯一可回传的标识（`{kind}-{date}`，非路径形状，拼不出路径）；
 * `path` 只在服务端内部流转，不得进入任何响应或日志。
 */
export interface LogSourceDescriptor {
  id: string;
  kind: LogSourceKind;
  /** 日志日期（`yyyy-MM-dd`，UTC）。 */
  date: string;
  fileName: string;
  /** 绝对路径；仅供服务端读取，不对外暴露。 */
  path: string;
}

/**
 * 读取日志目录配置。
 *
 * `LOG_DIR` 的 owner 是本包（`scripts/lib/env-example-spec.ts` 亦登记为 `packages/logger` 消费）。
 * 其它模块需要日志目录时经 `resolveLogDir()` 取，不得另行解析同名环境变量。
 */
export function readLogDir(): string {
  return process.env.LOG_DIR ?? "logs";
}

/**
 * 日志目录的绝对路径。
 *
 * 写入侧用 `${baseDir}/${prefix}.${date}.log` 的相对形态（按写入时的 cwd 解析），读取侧解析成绝对路径；
 * cwd 在同一进程内不变时两者指向同一目录，这是当前唯一的偏差来源，不额外引入配置项。
 */
export function resolveLogDir(): string {
  return resolve(process.cwd(), readLogDir());
}

/** 由类别与日期生成日志源 ID，例如 `app-2026-09-20`、`error-2026-09-20`。 */
export function logSourceId(kind: LogSourceKind, date: string): string {
  return `${kind}-${date}`;
}

/** 全部类别（从写入表推导，避免与 `logSourceId` 的取值域各写一份后漂移）。 */
const LOG_SOURCE_KINDS: readonly LogSourceKind[] = LOG_SOURCE_PREFIXES.map((entry) => entry.kind);

/**
 * 日志源 ID 的形状：`{kind}-{yyyy-MM-dd}`。
 *
 * 这不是安全检查——真正的安全来自「ID 只能命中枚举结果」（见 observer 的日志投影服务：先枚举、再按
 * ID 命中，绝不由 ID 拼路径）。它只让「客户端传了文件名或路径」这类协议误用得到明确的 400，
 * 而不是含混的 404，从而把注入尝试变成可观测的信号。
 */
export const LOG_SOURCE_ID_PATTERN = new RegExp(`^(?:${LOG_SOURCE_KINDS.join("|")})-\\d{4}-\\d{2}-\\d{2}$`);

/**
 * 解析日志文件名；不是本包写入命名的（其它前缀、缺日期段、非 `.log` 扩展名）一律返回 `null`。
 *
 * 前缀按表逐项尝试而非按最长前缀匹配：表短且每项都以 `.` 收尾，`rcs.err.2026-09-20.log` 会被
 * `rcs.` 试出日期段 `err.2026-09-20` 不合法而落到 `rcs.err.` 项，结果与最长匹配一致。
 */
export function parseLogSourceFileName(fileName: string): { kind: LogSourceKind; date: string } | null {
  for (const entry of LOG_SOURCE_PREFIXES) {
    const prefix = `${entry.prefix}.`;
    if (!fileName.startsWith(prefix) || !fileName.endsWith(".log")) continue;
    const date = fileName.slice(prefix.length, -".log".length);
    if (LOG_FILE_DATE_PATTERN.test(date)) return { kind: entry.kind, date };
  }
  return null;
}

/**
 * 列出目录内由本包写入的日志源，按日期倒序（最近的在最前），同日期内 `app` 在 `error` 之前。
 *
 * 目录不存在按「还没有日志」返回空表：首次启动尚未写盘是正常状态，不是异常。
 * 只认常规文件（`isFile()`）：同名的目录与符号链接都不进入投影面——符号链接会把读取引到白名单之外。
 */
export function listLogSources(directory: string = resolveLogDir()): LogSourceDescriptor[] {
  let entries: Dirent[];
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const sources: LogSourceDescriptor[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseLogSourceFileName(entry.name);
    if (!parsed) continue;
    sources.push({
      id: logSourceId(parsed.kind, parsed.date),
      kind: parsed.kind,
      date: parsed.date,
      fileName: entry.name,
      path: resolve(directory, entry.name),
    });
  }

  return sources.sort((left, right) => right.date.localeCompare(left.date) || left.kind.localeCompare(right.kind));
}
