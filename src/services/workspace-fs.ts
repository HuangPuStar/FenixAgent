import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { environmentRepo } from "../repositories";

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

// ── Pure functions ───────────────────────────────────────────────────────────

/** 路径是否属于 user/ 作用域 */
export function isUserPath(path: string): boolean {
  return path === "" || path === "user" || path.startsWith("user/");
}

/** 将路由通配符路径规范化为 user/ 作用域 */
export function normalizeUserRoutePath(path: string): string {
  const normalized = path.trim();
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

// ── Path resolution ──────────────────────────────────────────────────────────

export type ResolvedWorkspacePath = {
  workspaceDir: string;
  userDir: string;
  resolved: string;
  displayPath: string;
};

/**
 * 将环境 ID + 相对路径解析为绝对文件系统路径。
 * 返回 null 表示环境不存在或路径越界。
 */
export async function resolveWorkspacePath(
  environmentId: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath | null> {
  const env = await environmentRepo.getById(environmentId);
  if (!env) return null;

  const workspaceDir = env.workspacePath;
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
  if (!resolvedPath.startsWith(`${baseDir}/`) && resolvedPath !== baseDir) return null;

  const relativeToBase = relative(baseDir, resolvedPath);
  const displayPath = userScoped ? (relativeToBase ? `user/${relativeToBase}` : "user") : relativeToBase || ".";

  return { workspaceDir, userDir, resolved: resolvedPath, displayPath };
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

/** 判断工作区条目是否应隐藏（非 user/ 作用域下的 .opencode 目录） */
export function shouldHideWorkspaceEntry(entryPath: string, userDir: string): boolean {
  const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
  if (inUserDir) return false;
  return entryPath.endsWith("/.opencode") || entryPath.endsWith("/.opencode/");
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
  const visibleEntries = entries.filter((entry) => !shouldHideWorkspaceEntry(join(dirPath, entry.name), userDir));
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

/** 创建文件读取流（用于二进制文件下载或预览） */
export function createFileStream(filePath: string): NodeJS.ReadableStream {
  return createReadStream(filePath);
}

/** 递归列出 user/ 下所有文件和目录，返回相对路径（目录以 / 结尾） */
export async function listPathsRecursive(workspaceDir: string): Promise<string[]> {
  const userDir = join(workspaceDir, "user");
  await mkdir(userDir, { recursive: true });

  const results: string[] = [];

  async function walk(dirPath: string, prefix: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const dirs: { name: string; fullPath: string; relPath: string }[] = [];
    const files: string[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = join(dirPath, entry.name);
      if (shouldHideWorkspaceEntry(fullPath, userDir)) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, fullPath, relPath });
      } else {
        files.push(relPath);
      }
    }

    // 排序：目录按名称字母序，文件按名称字母序
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort();

    for (const d of dirs) {
      results.push(`${d.relPath}/`);
      await walk(d.fullPath, d.relPath);
    }

    results.push(...files);
  }

  await walk(userDir, "");
  return results;
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
