import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { environmentRepo } from "../repositories";
import { resolveWorkspacePath as computeWorkspacePath } from "./workspace-resolver";

// ── Constants ────────────────────────────────────────────────────────────────

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".ts",
  ".js",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".css",
  ".html",
  ".xml",
  ".toml",
  ".ini",
  ".properties",
  ".cfg",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".env",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".sh": "text/plain",
  ".bash": "text/plain",
  ".zsh": "text/plain",
  ".sql": "text/plain",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

/** workspace 黑名单目录：按目录名精确匹配，隐藏整个目录树 */
const WORKSPACE_BLACKLIST = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".pytest_cache",
  "vendor",
  ".terraform",
  ".idea",
  ".vscode",
  "coverage",
  ".nyc_output",
  ".opencode",
  ".tmp",
  "tmp",
  ".turbo",
]);

// ── Pure functions ───────────────────────────────────────────────────────────

/**
 * 路径是否属于 user/ 作用域。
 * 除 resolveWorkspacePath 内部 user/ 分支外，仍被对外稳定 API
 * `/api/workspaces`（api-workspace.ts）用于上传路径校验，属对外契约，不得删除。
 */
export function isUserPath(path: string): boolean {
  return path === "" || path === "user" || path.startsWith("user/");
}

/**
 * 将路由通配符路径规范化为 user/ 作用域。
 * 12 号文件服务 v2 重构后 v1 路由（files.ts / user-file.ts）已删除，
 * 此处保留是因为对外稳定 API `/api/workspaces`（api-workspace.ts）仍依赖此转换，
 * 属对外契约，不得删除；待该 API 迁移后随契约一并下线。
 */
export function normalizeUserRoutePath(path: string): string {
  // 解码 URL 编码的字符（如 %28 → (, %E5%9F%83 → 埃）
  let normalized: string;
  try {
    normalized = decodeURIComponent(path.trim());
  } catch {
    normalized = path.trim();
  }
  if (!normalized) return "user";
  if (normalized === "user" || normalized.startsWith("user/")) return normalized;
  if (normalized.startsWith(".")) return normalized;
  return `user/${normalized}`;
}

/** 根据扩展名获取 MIME 类型 */
export function getMimeType(ext: string): string {
  return MIME_TYPES[ext] || "application/octet-stream";
}

/** 扩展名是否为文本类型 */
export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext);
}

// ── ETag 指纹（§4.2 条件请求；W13' 读侧，跨 plan 契约）─────────────

/** 稳定字符串 hash（sha1 仅作变更指纹，非安全用途，不涉及敏感数据） */
function hashOf(input: string): string {
  return createHash("sha1").update(input).digest("hex");
}

/**
 * tree 指纹：路径排序 hash + max(mtimeMs) + 路径数。
 * 路径集合参与 hash 使 rename 必然改变指纹（修复"仅 max mtime + 条数"下
 * rename 前后 mtime 恰巧相同导致的 304 误判）；max(mtimeMs) 是内容变更的
 * 弱校验（文件内容变化但 mtime 未更新的极端场景无法感知，属 §4.2 接受的边界）。
 * mtimes 缺失（远程弱指纹：机器端暂不返回 mtime，补全属跨仓库增强）时退化为
 * 路径 hash + 路径数，max 恒 0——格式与强指纹一致，机器端补齐后 ETag 自然失效一次。
 * 返回值即 HTTP ETag 标准格式（带引号）。
 */
export function computeTreeFingerprint(paths: string[], mtimes?: Record<string, number>): string {
  const pathHash = hashOf([...paths].sort().join("\n"));
  let maxMtime = 0;
  if (mtimes) for (const t of Object.values(mtimes)) if (t > maxMtime) maxMtime = t;
  return `"${pathHash}-${maxMtime}-${paths.length}"`;
}

/**
 * list 指纹：hash(name+type+size+modifiedAt) + 条数。
 * modifiedAt 全部为 0/缺失（远程弱指纹）时退化为 hash(name+type+size) + 条数；
 * 同一来源的条目不会出现混合状态，按"存在任一 >0 的 modifiedAt"整体判定即可。
 * 返回值即 HTTP ETag 标准格式（带引号）。
 */
export function computeListFingerprint(
  entries: Array<{ name: string; type: string; size: number; modifiedAt?: number }>,
): string {
  const hasMtime = entries.some((e) => (e.modifiedAt ?? 0) > 0);
  const lines = entries.map((e) => {
    const base = `${e.name}|${e.type}|${e.size}`;
    return hasMtime ? `${base}|${e.modifiedAt ?? 0}` : base;
  });
  return `"${hashOf(lines.join("\n"))}-${lines.length}"`;
}

/**
 * read 指纹："<size>-<mtimeMs>"（标准文件指纹）。
 * mtimeMs 缺失（远程数据源无 mtime，机器端补全属跨仓库增强）时退化为 size-only
 * 弱指纹 "<size>"——同一大小内容变更无法感知，属 §4.2 接受的边界。
 * 返回值即 HTTP ETag 标准格式（带引号）。
 */
export function computeReadFingerprint(size: number, mtimeMs?: number): string {
  return mtimeMs !== undefined && mtimeMs > 0 ? `"${size}-${mtimeMs}"` : `"${size}"`;
}

// ── Path resolution ──────────────────────────────────────────────────────────

export type ResolvedWorkspacePath = {
  workspaceDir: string;
  userDir: string;
  resolved: string;
  displayPath: string;
};

/**
 * 将环境 ID + 相对路径解析为绝对文件系统路径。
 * 返回 null 表示环境不存在或路径越界（含 symlink 逃逸）。
 */
export async function resolveWorkspacePath(
  environmentId: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath | null> {
  const env = await environmentRepo.getById(environmentId);
  if (!env) return null;

  const workspaceDir = computeWorkspacePath(env.organizationId ?? env.userId ?? "", env.userId ?? "", env.id);
  const userDir = join(workspaceDir, "user");
  await mkdir(userDir, { recursive: true });

  const normalizedInput = relativePath.trim();
  const userScoped = isUserPath(normalizedInput);
  const baseDir = userScoped ? userDir : workspaceDir;

  let cleanPath = normalizedInput;
  if (userScoped) {
    if (cleanPath.startsWith("user/")) cleanPath = cleanPath.slice(5);
    else if (cleanPath === "user") cleanPath = "";
  }

  const resolvedPath = resolve(baseDir, cleanPath);
  const relativeToBase = relative(baseDir, resolvedPath);
  if (relativeToBase.startsWith("..") || isAbsolute(relativeToBase)) return null;

  // symlink 逃逸防护：词法包含检查无法识别 `user/link → /tmp/outside` 这类重定向，
  // 必须以 realpath 真实路径校验（基准本身用 realpath 规范化，WORKSPACE_ROOT 可能为 symlink）
  const realBase = await realpath(workspaceDir);
  if (!(await isRealPathInside(realBase, resolvedPath))) return null;

  const displayPath = userScoped ? (relativeToBase ? `user/${relativeToBase}` : "user") : relativeToBase || ".";

  return { workspaceDir, userDir, resolved: resolvedPath, displayPath };
}

/** fs 系统错误（携带 errno code，如 ENOENT/EACCES）的类型守卫 */
function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

/**
 * 校验目标真实路径（跟随 symlink）是否落在 realBase 目录树内，防 symlink 逃逸。
 * - 目标存在（读/stat/list）：直接 realpath 目标，解析结果须等于 realBase 或在
 *   `realBase/` 前缀内；
 * - 目标不存在（写/upload/mkdir/delete 目标）：逐级向上找最近存在的祖先，祖先的
 *   真实位置即创建操作的落点，同样须落在 realBase 内；
 * - broken symlink（存在但 realpath 失败）或非 ENOENT 系统错误（EACCES 等）：
 *   真实落点无法确认，保守拒绝。
 * 返回 false 表示越界或无法确认；调用方沿用 resolveWorkspacePath 的 null 契约。
 */
async function isRealPathInside(realBase: string, resolved: string): Promise<boolean> {
  let probe = resolved;
  for (;;) {
    try {
      const real = await realpath(probe);
      return real === realBase || real.startsWith(`${realBase}${sep}`);
    } catch (err) {
      // 仅路径段缺失（ENOENT/ENOTDIR）可向上回溯；其余错误保守拒绝
      if (!isErrnoException(err) || (err.code !== "ENOENT" && err.code !== "ENOTDIR")) return false;
      try {
        await lstat(probe);
        // probe 存在但 realpath 失败 → broken symlink，真实落点无法确认
        return false;
      } catch {
        // probe 不存在，继续向上找最近存在祖先
      }
      const parent = dirname(probe);
      if (parent === probe) return false;
      probe = parent;
    }
  }
}

// ── File operations ──────────────────────────────────────────────────────────

/** 检测文件是否为文本文件（前 8KB 无 NULL 字节） */
export async function isTextFile(filePath: string): Promise<boolean> {
  try {
    const buffer = Buffer.alloc(8192);
    const file = await open(filePath, "r");
    const { bytesRead } = await file.read(buffer, 0, 8192, 0);
    await file.close();
    return !buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  }
}

/** 判断工作区条目是否在黑名单中 */
export function shouldHideEntry(_entryPath: string, name: string): boolean {
  return WORKSPACE_BLACKLIST.has(name);
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

/** 列出目录内容，过滤隐藏条目并构建 FileEntry 数组 */
export async function listDirectory(dirPath: string, userDir: string, workspaceDir: string): Promise<FileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !shouldHideEntry(join(dirPath, entry.name), entry.name));
  return Promise.all(
    visibleEntries.map(async (entry) => {
      const entryPath = join(dirPath, entry.name);
      const statInfo = await stat(entryPath);
      const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
      const relPath = relative(inUserDir ? userDir : workspaceDir, entryPath);
      const path = inUserDir
        ? entry.isDirectory()
          ? `user/${relPath}/`
          : `user/${relPath}`
        : entry.isDirectory()
          ? `${relPath}/`
          : relPath;
      return {
        name: entry.name,
        path,
        type: (entry.isDirectory() ? "dir" : "file") as "dir" | "file",
        size: entry.isFile() ? statInfo.size : 0,
        modifiedAt: statInfo.mtimeMs,
      };
    }),
  );
}

/** 读取文本文件内容和大小 */
export async function readFileContent(filePath: string): Promise<{ content: string; size: number }> {
  const content = await readFile(filePath, "utf-8");
  const info = await stat(filePath);
  return { content, size: info.size };
}

/** 写入文本文件，自动创建父目录 */
export async function writeFileContent(filePath: string, content: string): Promise<void> {
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

/** 删除单个文件 */
export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}

/** 删除任意节点（文件直接删除，目录递归删除） */
export async function deleteNode(filePath: string): Promise<void> {
  await rm(filePath, { recursive: true, force: true });
}

/** 创建文件读取流（用于二进制文件下载或预览） */
export function createFileStream(filePath: string): NodeJS.ReadableStream {
  return createReadStream(filePath);
}

/** 树节点信息（含修改时间用于排序） */
export interface TreeNodeEntry {
  path: string;
  /** 文件修改时间（毫秒时间戳），目录为 0 */
  mtime: number;
}

/** 递归列出 workspace 下所有路径（黑名单过滤），返回相对路径及修改时间 */
export async function listPathsRecursive(workspaceDir: string): Promise<{
  entries: TreeNodeEntry[];
  errors: { path: string; message: string }[];
}> {
  const results: TreeNodeEntry[] = [];
  const errors: { path: string; message: string }[] = [];

  async function walk(dirPath: string, prefix: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const dirs: { name: string; fullPath: string; relPath: string }[] = [];
    const files: { relPath: string; fullPath: string }[] = [];

    for (const entry of entries) {
      // 黑名单目录跳过
      if (shouldHideEntry(join(dirPath, entry.name), entry.name)) continue;
      const fullPath = join(dirPath, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, fullPath, relPath });
      } else {
        files.push({ relPath, fullPath });
      }
    }

    // 排序：目录按名称字母序
    dirs.sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      results.push({ path: `${d.relPath}/`, mtime: 0 });
      try {
        await walk(d.fullPath, d.relPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ path: d.relPath, message });
      }
    }

    // 文件：获取修改时间
    for (const f of files) {
      try {
        const info = await stat(f.fullPath);
        results.push({ path: f.relPath, mtime: info.mtimeMs });
      } catch {
        results.push({ path: f.relPath, mtime: 0 });
      }
    }
  }

  await walk(workspaceDir, "");
  return { entries: results, errors };
}

/** 重命名文件或目录，自动创建目标父目录 */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  await mkdir(resolve(newPath, ".."), { recursive: true });
  await rename(oldPath, newPath);
}

/** 递归创建目录（等同于 mkdir -p） */
export async function mkdirp(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
