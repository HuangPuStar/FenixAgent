#!/usr/bin/env node

/**
 *
 * bun run --bun migrate-workspace-layout.ts --src /app/workspaces --out /app/workspaces-2 --threads ~/.peri/threads/threads.db --force
 *
 *
 * peri 工作区数据 → 新宿主机目录结构迁移脚本（一次性）
 *
 * 背景：RCS 的沙盒工作区持久化结构调整。沙盒内看到的目录格式不变——仍然保持
 * 旧的 {orgId}/{userId}/{envId} 三层 id 目录（以前沙盒把整个 workspaces 根挂到
 * /app/workspaces，现在改为把每个用户的 workspace 目录挂到 /app/workspace），
 * 宿主机层改为按用户聚合：
 *
 *   宿主机 workspace 根（--out）
 *   └── {userId}/
 *       ├── workspace/              沙盒挂载点 /app/workspace
 *       │   └── {orgId}/{userId}/{envId}/   保留旧三层目录格式，沙盒内看到的东西不变
 *       └── peri-global/threads/threads.db  该用户的 peri 会话数据（按用户拆分）
 *
 * 迁移内容（两部分）：
 *   1. 工作区文件：把旧布局 {src}/{orgId}/{userId}/{envId}/* 的整棵
 *      {orgId}/{userId}/{envId} 子树复制到 {out}/{userId}/workspace/ 下，
 *      三层目录格式原样保留（同一用户的多个 org / env 归集到同一 workspace，
 *      各 env 目录互不合并、互不冲突）。
 *   2. peri 会话数据：从源 threads.db 按 cwd 归属拆分——cwd 落在
 *      {src}/{org}/{userId} 前缀下的 thread 归属该 userId；cwd 路径段恰好等于
 *      已知 userId 的（旧 tmp 根时期的残留路径）同样归属；其余 thread 无法归属，
 *      保留在源库中不迁移。
 *
 * 用法（零依赖，bun 或 Node >= 22.5 均可运行）：
 *   bun run scripts/migrate-workspace-layout.ts [选项]
 *
 * 选项：
 *   --src <dir>       源 workspaces 根（默认 ./workspaces，只读扫描，绝不修改）
 *   --out <dir>       目标根（默认 ./workspaces-v2；必须为空/不存在，除非 --force）
 *   --threads <file>  peri threads.db 源（默认 ~/.peri/threads/threads.db，只读打开）
 *   --dry-run         只输出迁移计划，不写任何文件
 *   --force           允许覆盖已存在的目标（文件冲突覆盖 / threads.db 重建）
 *   -h, --help        显示帮助
 *
 * 安全保证：
 *   1. 源目录与源数据库只读访问，任何情况都不写入源；迁移是"复制"，不移动不删除。
 *   2. 拒绝 --out 等于 --src 或位于 --src 内部（防止自毁）。
 *   3. --out 已存在且非空时必须显式 --force 才继续。
 *   4. 合并冲突策略：目标文件已存在时比较内容（大小 + SHA-1），内容相同则跳过
 *      （幂等重跑友好）；内容不同则报错退出（提示 --force 覆盖），绝不静默覆盖。
 *      正常情况下不同 org / env 的子树路径独立，不会触发冲突。
 *   5. 符号链接按链接复制（保留目标），不跟随（防止循环与逃逸）。
 *   6. 文件名兼容：readdir 使用 Buffer 编码保留原始字节，无效 UTF-8 / 乱码文件名
 *      也能正确复制；单条目复制失败（权限、并发删除等）时警告并跳过，不中断迁移。
 *   7. .opencode（opencode 项目配置）与 .DS_Store 不参与迁移，整体忽略。
 */

import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

// ─── CLI 解析 ──────────────────────────────────────────────────────────────────

interface Options {
  src: string;
  out: string;
  threads: string;
  dryRun: boolean;
  force: boolean;
}

function usage(): never {
  console.error(
    [
      "用法: bun run scripts/migrate-workspace-layout.ts [选项]",
      "",
      "  --src <dir>       源 workspaces 根（默认 ./workspaces，只读扫描）",
      "  --out <dir>       目标根（默认 ./workspaces-v2，必须为空，除非 --force）",
      "  --threads <file>  peri threads.db 源（默认 ~/.peri/threads/threads.db，只读）",
      "  --dry-run         只输出迁移计划，不写任何文件",
      "  --force           允许覆盖已存在的目标（文件冲突覆盖 / threads.db 重建）",
      "  -h, --help        显示帮助",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    src: join(process.cwd(), "workspaces"),
    out: join(process.cwd(), "workspaces-v2"),
    threads: join(homedir(), ".peri", "threads", "threads.db"),
    dryRun: false,
    force: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) {
        console.error(`缺少参数值: ${arg}`);
        usage();
      }
      return argv[++i];
    };
    switch (arg) {
      case "--src":
        opts.src = next();
        break;
      case "--out":
        opts.out = next();
        break;
      case "--threads":
        opts.threads = next();
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "-h":
      case "--help":
        usage();
        break;
      default:
        console.error(`未知参数: ${arg}`);
        usage();
    }
  }
  return opts;
}

// ─── 工具函数 ──────────────────────────────────────────────────────────────────

/** 规范化路径：转绝对路径并去掉尾部分隔符（用于前缀匹配与保护检查） */
function norm(p: string): string {
  return resolve(p).replace(/[/\\]+$/, "") || resolve(p);
}

/** 计算文件 SHA-1（路径可为 Buffer，兼容无效 UTF-8 文件名；用于合并冲突时判断内容是否相同） */
function sha1File(file: string | Buffer): Promise<string> {
  return new Promise((res, rej) => {
    const hash = createHash("sha1");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => res(hash.digest("hex")));
    stream.on("error", rej);
  });
}

/**
 * 不参与迁移的条目名：
 *  - .DS_Store：macOS 系统噪声文件
 *  - .opencode：opencode 时代的项目配置（含 node_modules，每 env 约 60MB），
 *    新架构已不用 opencode，整体忽略
 */
const SKIP_FILES = new Set([".DS_Store", ".opencode"]);

// ─── 工作区文件迁移 ───────────────────────────────────────────────────────────

interface UserEnv {
  org: string;
  userId: string;
  envDir: string;
}

/** 扫描源根，收集 {org}/{userId}/{envDir} 三元组（只统计目录，忽略杂项文件） */
async function scanWorkspaces(src: string): Promise<UserEnv[]> {
  const { readdir } = await import("node:fs/promises");
  const result: UserEnv[] = [];
  const orgs = (await readdir(src, { withFileTypes: true }))
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
  for (const org of orgs) {
    const orgPath = join(src, org);
    const users = (await readdir(orgPath, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    for (const userId of users) {
      const userPath = join(orgPath, userId);
      const envs = (await readdir(userPath, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
      for (const env of envs) {
        result.push({ org, userId, envDir: join(userPath, env) });
      }
    }
  }
  return result;
}

/** 复制统计（供汇总输出） */
interface CopyStats {
  copied: number;
  identical: number;
  overwritten: number;
  skipped: number;
  bytes: number;
}

/**
 * Buffer 路径拼接。Linux 上文件名可以是任意字节（无效 UTF-8），
 * readdir 用 encoding:"buffer" 保留原始字节后，必须用 Buffer 级拼接路径，
 * 否则被 U+FFFD 替换过的名字在 statx 时找不到文件。
 */
function bufJoin(base: Buffer, name: Buffer): Buffer {
  return Buffer.concat([base, Buffer.from("/"), name]);
}

/** 已打印的跳过警告条数（限制刷屏） */
let skipWarnCount = 0;

/** 单文件跳过警告：最多打印 20 条明细 */
function warnSkipped(path: Buffer | string, err: unknown): void {
  if (skipWarnCount < 20) {
    console.warn(`    跳过异常文件: ${path.toString()}（${String(err).split("\n")[0]}）`);
  } else if (skipWarnCount === 20) {
    console.warn("    ...（后续跳过明细不再打印）");
  }
  skipWarnCount++;
}

/**
 * 逐级创建目录（不使用 mkdir recursive 标志）。
 *
 * 背景：生产环境曾出现"全新空目标根 + 全新路径链"下 mkdir(recursive) 报 ENOENT
 * （本地 macOS 与本地 Linux 容器均无法复现，怀疑是生产环境 Bun 版本对
 * recursive + Buffer 路径的实现差异）。改为逐级 mkdir 后完全绕开该实现，
 * 且每级错误码精确、诊断信息明确：
 *  - EEXIST：条目已存在 → stat（跟随符号链接）确认是否为目录；是则继续，
 *    否则视为残留（上次中断迁移的产物），--force 时清除重建，否则报错。
 *  - ENOENT：父级刚创建仍缺失（并发删除等）→ 字符串路径兜底 + 重试一次；
 *    仍失败则打印该级完整路径链诊断后抛出。
 *  - 其余错误：打印该级路径与 errno 后抛出，便于定位（挂载 / 权限 / 特殊 fs）。
 */
async function mkdirRecursive(destP: Buffer, force: boolean): Promise<void> {
  const { mkdir, rm, lstat, stat } = await import("node:fs/promises");
  // 拆出从根到目标的完整路径链（绝对路径，从 "/" 到 destP 逐级排列）
  const chain: Buffer[] = [];
  let cur: Buffer = destP;
  for (;;) {
    chain.unshift(cur);
    const idx = cur.lastIndexOf(47);
    if (idx <= 0) break;
    cur = cur.subarray(0, idx);
  }
  for (const part of chain) {
    try {
      await mkdir(part);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // 已存在：跟随符号链接判断是否目录（symlink → 目录视为可继续）
        let isDir = false;
        try {
          isDir = (await stat(part)).isDirectory();
        } catch {
          // stat 失败：悬空符号链接或竞态删除，视为残留
        }
        if (isDir) continue;
        if (force) {
          console.warn(`    清除目标残留（非目录条目）: ${part.toString()}`);
          await rm(part, { recursive: true, force: true });
          await mkdir(part);
          continue;
        }
        throw new Error(
          `目标路径 ${part.toString()} 已存在但不是目录（疑似上次迁移残留），` +
            `请清理该条目后重试，或使用 --force 自动清除。`,
        );
      }
      // 字符串路径兜底（Bun 个别版本对 Buffer 路径 mkdir 的兼容问题）
      try {
        await mkdir(part.toString("utf8"));
        continue;
      } catch {
        // 保留原始错误，走下方诊断
      }
      if (code === "ENOENT") {
        // 父级刚创建仍 ENOENT：重试一次（防并发删除 / 挂载同步延迟）
        try {
          await mkdir(part);
          continue;
        } catch {
          // 落到下方诊断
        }
      }
      // 打印该级精确诊断后抛出：每个路径组件的存在性与类型
      console.error(`mkdir 失败: ${part.toString()}（errno=${code ?? "unknown"}）`);
      let p: Buffer | null = part;
      while (p && p.length > 1) {
        try {
          const st = await lstat(p);
          const kind = st.isDirectory() ? "目录" : st.isFile() ? "文件" : st.isSymbolicLink() ? "符号链接" : "其他";
          console.error(`  [存在] ${p.toString()}（${kind}，mode=${st.mode.toString(8)}）`);
        } catch {
          console.error(`  [不存在] ${p.toString()}`);
        }
        const idx = p.lastIndexOf(47);
        if (idx <= 0) break;
        p = p.subarray(0, idx);
      }
      throw e;
    }
  }
}

/**
 * 递归复制 src 目录树到 dest，遵循合并冲突策略：
 *  - 目标不存在 → 复制
 *  - 目标存在且内容相同（大小 + SHA-1）→ 跳过（幂等）
 *  - 目标存在且内容不同 → force 时覆盖（计入 overwritten），否则抛错
 *  - 符号链接按链接复制，不跟随（防止循环与逃逸）
 *  - 单个条目失败（乱码文件名等）→ 警告并跳过，不中断整体迁移
 */
async function copyTree(src: string | Buffer, dest: string | Buffer, force: boolean, stats: CopyStats): Promise<void> {
  const { readdir, copyFile, chmod, symlink, lstat, readlink } = await import("node:fs/promises");
  const srcP = Buffer.isBuffer(src) ? src : Buffer.from(src);
  const destP = Buffer.isBuffer(dest) ? dest : Buffer.from(dest);
  const sStat = await lstat(srcP);
  if (sStat.isSymbolicLink()) {
    const link = await readlink(srcP);
    await ensureEntry(
      destP,
      async () => false,
      force,
      stats,
      async () => {
        await symlink(link, destP);
      },
    );
    return;
  }
  if (sStat.isDirectory()) {
    // readdir 以 Buffer 编码返回，保留文件名的原始字节（Linux 上可能是无效 UTF-8）。
    // Bun 返回的是 Uint8Array（非 Buffer 实例），先统一转 Buffer 再使用。
    const names = (await readdir(srcP, { encoding: "buffer" }))
      .map((n) => Buffer.from(n.buffer, n.byteOffset, n.byteLength))
      .filter((n) => !SKIP_FILES.has(n.toString()))
      .sort((a, b) => a.compare(b));
    await mkdirRecursive(destP, force);
    for (const name of names) {
      const entrySrc = bufJoin(srcP, name);
      const entryDest = bufJoin(destP, name);
      try {
        await copyTree(entrySrc, entryDest, force, stats);
      } catch (e) {
        // 单条目失败（无效 UTF-8 文件名等）不中断整体迁移，警告后跳过
        stats.skipped++;
        warnSkipped(entryDest, e);
      }
    }
    return;
  }
  if (sStat.isFile()) {
    await ensureEntry(
      destP,
      async () => {
        try {
          const d = await lstat(destP);
          return d.isFile() && (await sha1File(srcP)) === (await sha1File(destP));
        } catch {
          return false;
        }
      },
      force,
      stats,
      async () => {
        await copyFile(srcP, destP);
        // 保留源文件的可执行位等模式
        await chmod(destP, sStat.mode);
      },
    );
    stats.bytes += sStat.size;
    return;
  }
  // 其余特殊文件（fifo/socket 等）跳过
}

/**
 * 目标条目的合并仲裁：不存在 → 执行写入；存在且 isSame() 为真 → 跳过（幂等）；
 * 存在且不同 → 无 --force 报错退出，有 --force 删除后重写。
 */
async function ensureEntry(
  dest: string | Buffer,
  isSame: () => Promise<boolean>,
  force: boolean,
  stats: CopyStats,
  write: () => Promise<void>,
): Promise<void> {
  const { lstat, rm } = await import("node:fs/promises");
  let exists = true;
  try {
    await lstat(dest);
  } catch {
    exists = false;
  }
  if (!exists) {
    await write();
    stats.copied++;
    return;
  }
  if (await isSame()) {
    stats.identical++;
    return;
  }
  if (!force) {
    throw new Error(
      `目标已存在且内容不同: ${dest.toString()}\n若确认覆盖，请使用 --force 重跑（相同内容会在无 --force 时自动跳过）。`,
    );
  }
  await rm(dest, { recursive: true, force: true });
  await write();
  stats.overwritten++;
}

// ─── peri 会话数据拆分 ─────────────────────────────────────────────────────────

/** 从源库读取 schema DDL（表 / 索引 / 触发器，排除 sqlite_ 内部对象） */
function schemaSql(db: Database): string[] {
  const rows = db
    .prepare(
      `SELECT type, sql FROM sqlite_master
       WHERE type IN ('table','index','trigger') AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL
       ORDER BY rowid`,
    )
    .all() as { type: string; sql: string }[];
  // 表先建（外键依赖），再建索引与触发器
  return [
    ...rows.filter((r) => r.type === "table").map((r) => r.sql),
    ...rows.filter((r) => r.type !== "table").map((r) => r.sql),
  ];
}

/** 读取表的所有列名（保证 INSERT 与源库列集合一致，容忍 schema 演进） */
function tableColumns(db: Database, table: string): string[] {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

interface ThreadRef {
  id: string;
  cwd: string;
}

/** 按 cwd 归属：规则 1 = 前缀 {src}/{org}/{userId}；规则 2 = cwd 路径段恰好等于 userId */
function attributeThreads(
  threads: ThreadRef[],
  srcAbs: string,
  users: Map<string, string[]>,
): { byUser: Map<string, Set<string>>; unowned: number; byPathSegment: number } {
  const byUser = new Map<string, Set<string>>();
  const userIds = [...users.keys()].sort();
  // 规则 1：每个用户在该源根下出现的所有 org 前缀
  const prefixes = new Map<string, string[]>();
  for (const userId of userIds) {
    prefixes.set(
      userId,
      users.get(userId)!.map((org) => norm(join(srcAbs, org, userId))),
    );
  }
  let unowned = 0;
  let byPathSegment = 0;
  for (const t of threads) {
    const cwd = norm(t.cwd || "");
    let owner: string | null = null;
    for (const userId of userIds) {
      for (const prefix of prefixes.get(userId)!) {
        if (cwd === prefix || cwd.startsWith(prefix + sep)) {
          owner = userId;
          break;
        }
      }
      if (owner) break;
    }
    if (!owner) {
      // 规则 2：路径段恰好等于已知 userId（旧 tmp 根时期的残留路径）
      const segments = cwd.split(sep).filter(Boolean);
      owner = userIds.find((u) => segments.includes(u)) ?? null;
      if (owner) byPathSegment++;
    }
    if (owner) {
      const set = byUser.get(owner) ?? new Set<string>();
      set.add(t.id);
      byUser.set(owner, set);
    } else {
      unowned++;
    }
  }
  return { byUser, unowned, byPathSegment };
}

/**
 * 为单个用户生成 {out}/{userId}/peri-global/threads/threads.db：
 * 沿用源库 DDL 与列集合，仅保留该用户的 threads 及其 messages。
 */
async function writeUserThreadsDb(
  srcDb: Database,
  out: string,
  userId: string,
  threadIds: Set<string>,
  force: boolean,
): Promise<{ threads: number; messages: number }> {
  const { rm } = await import("node:fs/promises");
  const target = join(out, userId, "peri-global", "threads", "threads.db");
  if (force) {
    await rm(target, { force: true });
  }
  await mkdirRecursive(Buffer.from(dirname(target)), force);

  const ids = [...threadIds];
  const threadsCols = tableColumns(srcDb, "threads");
  const messagesCols = tableColumns(srcDb, "messages");
  const selThread = srcDb.prepare(
    `SELECT ${threadsCols.join(",")} FROM threads WHERE id IN (${ids.map(() => "?").join(",")})`,
  );
  const threadRows = ids.length ? (selThread.all(...ids) as Record<string, unknown>[]) : [];

  // messages 按 thread_id 分块查询（IN 子句长度受限）
  const selMessages = srcDb.prepare(
    `SELECT ${messagesCols.join(",")} FROM messages WHERE thread_id IN (${Array(400).fill("?").join(",")})`,
  );
  const messageRows: Record<string, unknown>[] = [];
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    if (chunk.length < 400) {
      const sql = `SELECT ${messagesCols.join(",")} FROM messages WHERE thread_id IN (${chunk.map(() => "?").join(",")})`;
      messageRows.push(...(srcDb.prepare(sql).all(...chunk) as Record<string, unknown>[]));
    } else {
      messageRows.push(...(selMessages.all(...chunk) as Record<string, unknown>[]));
    }
  }

  const outDb = new Database(target);
  try {
    for (const sql of schemaSql(srcDb)) outDb.exec(sql);
    outDb.exec("BEGIN");
    try {
      const insThread = outDb.prepare(
        `INSERT INTO threads (${threadsCols.join(",")}) VALUES (${threadsCols.map(() => "?").join(",")})`,
      );
      for (const row of threadRows) insThread.run(...threadsCols.map((c) => row[c]));
      const insMessage = outDb.prepare(
        `INSERT INTO messages (${messagesCols.join(",")}) VALUES (${messagesCols.map(() => "?").join(",")})`,
      );
      for (const row of messageRows) insMessage.run(...messagesCols.map((c) => row[c]));
      outDb.exec("COMMIT");
    } catch (e) {
      outDb.exec("ROLLBACK");
      throw e;
    }
    // 保持默认 journal 模式（delete）：WAL 模式下干净关闭后缺少 -shm 文件，
    // 后续以只读方式打开会报 SQLITE_CANTOPEN，沙盒挂载与只读校验都会受影响。
  } finally {
    outDb.close();
  }
  return { threads: threadRows.length, messages: messageRows.length };
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { readdir, stat } = await import("node:fs/promises");

  const srcAbs = norm(opts.src);
  const outAbs = norm(opts.out);
  const threadsAbs = resolve(opts.threads);

  // ── 安全保护 1：目标不得位于源内部或等于源 ──
  if (outAbs === srcAbs || outAbs.startsWith(srcAbs + sep)) {
    console.error(`拒绝执行：目标目录 ${outAbs} 位于源目录 ${srcAbs} 内部。\n为避免误操作，请指定其他目标目录。`);
    process.exit(1);
  }

  // ── 源检查 ──
  try {
    if (!(await stat(srcAbs)).isDirectory()) throw new Error("不是目录");
  } catch {
    console.error(`源目录不存在或不可读: ${srcAbs}`);
    process.exit(1);
  }
  try {
    if (!(await stat(threadsAbs)).isFile()) throw new Error("不是文件");
  } catch {
    console.error(`threads.db 源不存在或不可读: ${threadsAbs}`);
    process.exit(1);
  }

  // ── 安全保护 2：目标已存在且非空 → 需 --force ──
  if (!opts.dryRun) {
    let nonEmpty = false;
    try {
      nonEmpty = (await readdir(outAbs)).length > 0;
    } catch {
      // 不存在则视为空
    }
    if (nonEmpty && !opts.force) {
      console.error(
        `目标目录 ${outAbs} 已存在且非空。\n为保护已有数据，请先确认后使用 --force 重跑（相同内容自动跳过，不同内容覆盖）。`,
      );
      process.exit(1);
    }
  }

  // ── 扫描并汇总 ──
  const envs = await scanWorkspaces(srcAbs);
  // 每个用户的 org 列表（去重）：该用户出现的所有 {orgId}/{userId}/{envId} 子树
  const userOrgMap = new Map<string, string[]>();
  for (const e of envs) {
    const list = userOrgMap.get(e.userId) ?? [];
    if (!list.includes(e.org)) list.push(e.org);
    userOrgMap.set(e.userId, list);
  }
  const userIds = [...userOrgMap.keys()].sort();
  if (userIds.length === 0) {
    console.error(`源目录 ${srcAbs} 下未发现 {org}/{userId}/{envId} 结构，无事可做。`);
    process.exit(1);
  }

  console.log(`源 workspaces: ${srcAbs}`);
  console.log(`源 threads.db: ${threadsAbs}（只读）`);
  console.log(`目标根: ${outAbs}${opts.dryRun ? "（dry-run，不写入）" : ""}`);
  console.log("");

  // ── threads 归属统计 ──
  const srcDb = new Database(threadsAbs, { readonly: true });
  const allThreads = (srcDb.prepare("SELECT id, cwd FROM threads").all() as { id: string; cwd: string }[]).map((r) => ({
    id: r.id,
    cwd: r.cwd ?? "",
  }));
  const { byUser, unowned, byPathSegment } = attributeThreads(allThreads, srcAbs, userOrgMap);

  // ── 输出计划 / 执行 ──
  let totalCopied = 0;
  let totalIdentical = 0;
  let totalSkipped = 0;
  let totalBytes = 0;
  const conflicts: string[] = [];

  for (const userId of userIds) {
    const orgList = userOrgMap.get(userId)!;
    const threads = byUser.get(userId)?.size ?? 0;
    console.log(`▸ ${userId}`);
    console.log(`    复制 ${orgList.length} 个 org 子树 → ${join(outAbs, userId, "workspace")}`);
    console.log(`    threads.db: ${threads} 个会话 → ${join(outAbs, userId, "peri-global", "threads", "threads.db")}`);

    if (opts.dryRun) continue;

    const stats: CopyStats = { copied: 0, identical: 0, overwritten: 0, skipped: 0, bytes: 0 };
    // 整棵 {orgId}/{userId}/{envId} 子树原样复制，保留旧三层目录格式
    for (const org of orgList) {
      await copyTree(join(srcAbs, org, userId), join(outAbs, userId, "workspace", org, userId), opts.force, stats);
    }
    const threadResult = await writeUserThreadsDb(
      srcDb,
      outAbs,
      userId,
      byUser.get(userId) ?? new Set<string>(),
      opts.force,
    );
    totalCopied += stats.copied;
    totalIdentical += stats.identical;
    totalSkipped += stats.skipped;
    totalBytes += stats.bytes;
    if (stats.overwritten > 0) conflicts.push(`${userId}: 覆盖 ${stats.overwritten} 个`);
    console.log(
      `    已复制 ${stats.copied} 个文件（${(stats.bytes / 1024 / 1024).toFixed(1)} MB），` +
        `相同跳过 ${stats.identical} 个${stats.overwritten > 0 ? `，覆盖 ${stats.overwritten} 个` : ""}${stats.skipped > 0 ? `，异常跳过 ${stats.skipped} 个` : ""}，` +
        `会话 ${threadResult.threads} 个 / 消息 ${threadResult.messages} 条`,
    );
  }
  srcDb.close();

  console.log("");
  console.log(`汇总: ${userIds.length} 个用户, ${envs.length} 个 env 目录`);
  if (!opts.dryRun) {
    console.log(
      `工作区文件: 复制 ${totalCopied} 个（${(totalBytes / 1024 / 1024).toFixed(1)} MB），相同跳过 ${totalIdentical} 个${totalSkipped > 0 ? `，异常跳过 ${totalSkipped} 个` : ""}`,
    );
    if (conflicts.length) console.log(`冲突（--force 已覆盖）: ${conflicts.join("; ")}`);
  }
  console.log(
    `threads.db: 共 ${allThreads.length} 个会话，归属用户 ${allThreads.length - unowned} 个（其中 ${byPathSegment} 个按路径段归属），` +
      `未归属保留在源库 ${unowned} 个`,
  );
}

await main();
