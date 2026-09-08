import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

// ============================================================================
// Types
// ============================================================================

export interface FileEntry {
  name: string;
  path: string; // relative path with user/ prefix
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

interface FileOpMessage {
  type: "file_op";
  request_id: string;
  operation: string;
  params: Record<string, unknown>;
}

interface FileOpResult {
  type: "file_op_result";
  request_id: string;
  status: "ok" | "error";
  data?: unknown;
  error?: string;
  error_code?: "payload_too_large" | "operation_timeout" | "unsafe_symlink" | "busy";
  status_code?: 413 | 429 | 503;
}

class FileOpError extends Error {
  constructor(
    message: string,
    readonly errorCode: NonNullable<FileOpResult["error_code"]>,
    readonly statusCode: NonNullable<FileOpResult["status_code"]>,
  ) {
    super(message);
    this.name = "FileOpError";
  }
}

// ============================================================================
// Workspace Registry (delegated to workspace-registry.ts)
// ============================================================================

import { getWorkspaceSync } from "./workspace-registry.js";

// 重新导出供 instance-manager 使用
export { registerWorkspace, unregisterWorkspace } from "./workspace-registry.js";

// ============================================================================
// Path Safety
// ============================================================================

/**
 * Resolve a relative path against workspace root and validate it stays within bounds.
 * - "user/xxx" → {workspace}/user/xxx（兼容旧调用）
 * - ".claude/xxx" → {workspace}/.claude/xxx
 * - "" → {workspace}
 * Returns the absolute resolved path, or null if path escapes workspace.
 */
function resolveAndValidate(workspace: string, relativePath: string): string | null {
  const resolved = resolve(workspace, relativePath);

  // Path traversal check: resolved must start with workspace
  if (!resolved.startsWith(`${workspace}/`) && resolved !== workspace) {
    return null;
  }

  return resolved;
}

// ============================================================================
// Helpers
// ============================================================================

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".lua",
  ".pl",
  ".r",
  ".sql",
  ".csv",
  ".log",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".biome",
  ".tsconfig",
  ".makefile",
  ".cmake",
  ".gradle",
  ".properties",
  ".lock",
  ".map",
  ".wasm",
  ".vue",
  ".svelte",
]);

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".xml": "text/xml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

/**
 * @deprecated 文件树展示过滤已统一下沉到主服务 `src/routes/web/fs.ts`；
 * 如果后续主服务的过滤没有问题，这里可以移除。
 */
const HIDDEN_WORKSPACE_ENTRIES = new Set([".opencode", ".claude", ".peri", "CLAUDE.md"]);

/**
 * @deprecated 文件树展示过滤已统一下沉到主服务 `src/routes/web/fs.ts`；
 * 如果后续主服务的过滤没有问题，这里可以移除。
 */
function shouldHideWorkspaceEntry(fullPath: string): boolean {
  const name = basename(fullPath);
  return HIDDEN_WORKSPACE_ENTRIES.has(name);
}

/**
 * Check if a file is text by reading first 8KB and looking for null bytes.
 * Uses extension hint as a fast path.
 */
async function _isTextFile(filePath: string): Promise<boolean> {
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  if (TEXT_EXTENSIONS.has(ext)) return true;

  try {
    const _buffer = Buffer.alloc(8192);
    const handle = await readFile(filePath);
    const chunk = handle.subarray(0, 8192);
    // Check for null bytes (binary indicator)
    for (let i = 0; i < chunk.length; i++) {
      if (chunk[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** Get MIME type from file extension */
function getMimeType(filePath: string): string {
  const ext = filePath.lastIndexOf(".") >= 0 ? filePath.slice(filePath.lastIndexOf(".")).toLowerCase() : "";
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

// ============================================================================
// Operations
// ============================================================================

async function opList(workspace: string, params: Record<string, unknown>): Promise<{ entries: FileEntry[] }> {
  const rawPath = (params.path as string) || "";
  const dirPath = resolveAndValidate(workspace, rawPath);
  if (!dirPath) throw new Error("Invalid path: path traversal detected");

  const names = await readdir(dirPath, { withFileTypes: true });

  const entries: FileEntry[] = [];
  for (const entry of names) {
    const fullPath = join(dirPath, entry.name);

    if (shouldHideWorkspaceEntry(fullPath)) continue;

    const entryPath = relative(workspace, fullPath);

    if (entry.isDirectory()) {
      entries.push({ name: entry.name, path: entryPath, type: "dir", size: 0, modifiedAt: 0 });
    } else if (entry.isFile()) {
      const info = await stat(fullPath);
      entries.push({
        name: entry.name,
        path: entryPath,
        type: "file",
        size: info.size,
        modifiedAt: info.mtimeMs,
      });
    }
  }

  return { entries };
}

async function opStat(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ size: number; isDirectory: boolean; modifiedAt: number }> {
  const filePath = resolveAndValidate(workspace, params.path as string);
  if (!filePath) throw new Error("Invalid path: path traversal detected");

  const info = await stat(filePath);
  return { size: info.size, isDirectory: info.isDirectory(), modifiedAt: info.mtimeMs };
}

async function opRead(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ name: string; path: string; content: string; size: number; encoding: string }> {
  const filePath = resolveAndValidate(workspace, params.path as string);
  if (!filePath) throw new Error("Invalid path: path traversal detected");

  const content = await readFile(filePath, "utf-8");
  const info = await stat(filePath);
  const name = basename(filePath);
  const relPath = relative(workspace, filePath);

  return { name, path: relPath, content, size: info.size, encoding: "utf-8" };
}

async function opReadBinary(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ name: string; path: string; data: string; size: number; mimeType: string }> {
  const filePath = resolveAndValidate(workspace, params.path as string);
  if (!filePath) throw new Error("Invalid path: path traversal detected");

  const buffer = await readFile(filePath);
  const info = await stat(filePath);
  const name = basename(filePath);
  const relPath = relative(workspace, filePath);

  return {
    name,
    path: relPath,
    data: buffer.toString("base64"),
    size: info.size,
    mimeType: getMimeType(filePath),
  };
}

async function opWrite(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ name: string; path: string; size: number }> {
  const filePath = resolveAndValidate(workspace, params.path as string);
  if (!filePath) throw new Error("Invalid path: path traversal detected");

  const content = params.content as string;
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf-8");

  const name = basename(filePath);
  const relPath = relative(workspace, filePath);

  return { name, path: relPath, size: Buffer.byteLength(content, "utf-8") };
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function normalizeUploadRelativePath(value: unknown): string | null {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !value.trim() || value === ".") return null;
  if (isAbsolute(value) || win32.isAbsolute(value)) return null;
  for (const segment of value.split(/[\\/]+/)) {
    if (segment === "..") return null;
    for (const char of segment) {
      const code = char.charCodeAt(0);
      if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) return null;
    }
  }
  return value;
}

async function assertUploadDestination(workspace: string, destination: string): Promise<void> {
  const workspaceRealPath = await realpath(workspace);
  if (!isWithinRoot(workspace, destination)) throw new Error("Invalid file path: target escapes workspace");

  const rel = relative(workspace, destination);
  let current = workspace;
  for (const segment of rel.split(sep).slice(0, -1)) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new FileOpError("Upload target contains a symbolic link", "unsafe_symlink", 503);
      }
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      break;
    }
  }

  const parentRealPath = await realpath(resolve(destination, ".."));
  if (!isWithinRoot(workspaceRealPath, parentRealPath)) {
    throw new FileOpError("Upload target resolves outside workspace", "unsafe_symlink", 503);
  }
  try {
    if ((await lstat(destination)).isSymbolicLink()) {
      throw new FileOpError("Upload target is a symbolic link", "unsafe_symlink", 503);
    }
  } catch (error) {
    if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
  }
}

async function opUpload(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ files: Array<{ name: string; path: string; size: number }> }> {
  const dirPath = resolveAndValidate(workspace, (params.dir as string) || "");
  if (!dirPath) throw new Error("Invalid dir: path traversal detected");

  const files = params.files as Array<{ name: string; content: string; relativePath?: string }>;
  const normalizedFiles = files.map((file) => {
    const normalizedRelativePath = normalizeUploadRelativePath(file.relativePath);
    const normalizedName = normalizeUploadRelativePath(file.name);
    if (normalizedRelativePath === null || normalizedName === null) {
      throw new Error("Invalid upload path: expected a non-blank relative path without '..' or control characters");
    }
    return { file, relPath: normalizedRelativePath || normalizedName };
  });
  const results: Array<{ name: string; path: string; size: number }> = [];

  for (const { file, relPath } of normalizedFiles) {
    const targetPath = resolve(dirPath, relPath);
    if (!isWithinRoot(dirPath, targetPath)) {
      throw new Error(`Invalid file path: ${relPath} escapes target directory`);
    }

    await mkdir(resolve(targetPath, ".."), { recursive: true });
    await uploadBeforeWriteHook?.(targetPath);
    await assertUploadDestination(workspace, targetPath);

    const buffer = Buffer.from(file.content, "base64");
    await writeFile(targetPath, buffer);

    const name = basename(targetPath);
    const displayPath = relative(workspace, targetPath);
    results.push({ name, path: displayPath, size: buffer.length });
  }

  return { files: results };
}

async function opDelete(workspace: string, params: Record<string, unknown>): Promise<{ ok: boolean }> {
  const filePath = resolveAndValidate(workspace, params.path as string);
  if (!filePath) throw new Error("Invalid path: path traversal detected");

  await rm(filePath, { recursive: true, force: true });
  return { ok: true };
}

async function opRename(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ oldPath: string; newPath: string }> {
  const oldFilePath = resolveAndValidate(workspace, params.oldPath as string);
  const newFilePath = resolveAndValidate(workspace, params.newPath as string);
  if (!oldFilePath) throw new Error("Invalid oldPath: path traversal detected");
  if (!newFilePath) throw new Error("Invalid newPath: path traversal detected");

  // Ensure parent dir exists
  await mkdir(resolve(newFilePath, ".."), { recursive: true });
  await rename(oldFilePath, newFilePath);

  return { oldPath: params.oldPath as string, newPath: params.newPath as string };
}

async function opMkdir(workspace: string, params: Record<string, unknown>): Promise<{ path: string }> {
  const dirPath = resolveAndValidate(workspace, params.path as string);
  if (!dirPath) throw new Error("Invalid path: path traversal detected");

  await mkdir(dirPath, { recursive: true });
  return { path: params.path as string };
}

async function opTree(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ paths: string[]; mtimes?: Record<string, number>; errors?: { path: string; message: string }[] }> {
  const rawPath = (params.path as string) || "";
  const rootDir = resolveAndValidate(workspace, rawPath) ?? workspace;
  const paths: string[] = [];
  const mtimes: Record<string, number> = {};
  const errors: { path: string; message: string }[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (shouldHideWorkspaceEntry(fullPath)) continue;

      const relPath = relative(workspace, fullPath);
      paths.push(entry.isDirectory() ? `${relPath}/` : relPath);

      if (entry.isDirectory()) {
        try {
          await walk(fullPath);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push({ path: relPath, message });
        }
      } else {
        try {
          const info = await stat(fullPath);
          mtimes[relPath] = info.mtimeMs;
        } catch {
          // Skip mtime for unreadable files, path is still included
        }
      }
    }
  }

  try {
    await walk(rootDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    errors.push({ path: relative(workspace, rootDir) || ".", message });
    return { paths, mtimes, errors: errors.length > 0 ? errors : undefined };
  }

  return { paths, mtimes, errors: errors.length > 0 ? errors : undefined };
}

const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const ZIP_TIMEOUT_MS = 65_000;
const MAX_CONCURRENT_ZIPS = 1;
const activeFileOps = new Map<string, { controller: AbortController; operation: string }>();
let uploadBeforeWriteHook: ((targetPath: string) => Promise<void>) | undefined;
let zipBeforeSpawnHook: (() => Promise<void>) | undefined;

const ZIP_FROM_CWD_SCRIPT = `
workspace=$1
cwd=$(pwd -P) || exit 73
case "$cwd/" in
  "$workspace/"*) ;;
  *) printf '%s' 'ZIP target resolves outside workspace' >&2; exit 73 ;;
esac
if find -P . -type l -print -quit | grep -q .; then
  printf '%s' 'ZIP archive cannot contain symbolic links' >&2
  exit 74
fi
exec zip -r -y -q - .
`;

function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertZipTreeHasNoSymlinks(directory: string): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isSymbolicLink() || (await lstat(entryPath)).isSymbolicLink()) {
      throw new FileOpError("ZIP archive cannot contain symbolic links", "unsafe_symlink", 503);
    }
    if (entry.isDirectory()) await assertZipTreeHasNoSymlinks(entryPath);
  }
}

/** 仅供上传竞态回归测试在 mkdir 和落点复检之间稳定替换路径。 */
export function setUploadBeforeWriteHookForTest(hook?: (targetPath: string) => Promise<void>): void {
  uploadBeforeWriteHook = hook;
}

/** 仅供竞态回归测试在校验和 spawn 之间稳定替换路径。 */
export function setZipBeforeSpawnHookForTest(hook?: () => Promise<void>): void {
  zipBeforeSpawnHook = hook;
}

export function cancelFileOp(requestId: string): void {
  activeFileOps.get(requestId)?.controller.abort();
}

export function cancelAllFileOps(): void {
  for (const { controller } of activeFileOps.values()) controller.abort();
}

async function opZip(workspace: string, params: Record<string, unknown>, signal: AbortSignal): Promise<string> {
  const directory = resolveAndValidate(workspace, params.path as string);
  if (!directory) throw new Error("Invalid path: path traversal detected");
  const [workspaceRealPath, directoryInfo] = await Promise.all([realpath(workspace), lstat(directory)]);
  if (directoryInfo.isSymbolicLink()) {
    throw new FileOpError("ZIP target cannot be a symbolic link", "unsafe_symlink", 503);
  }
  if (!directoryInfo.isDirectory()) throw new Error("Target path is not a directory");
  const directoryRealPath = await realpath(directory);
  if (!isWithinRoot(workspaceRealPath, directoryRealPath)) {
    throw new FileOpError("ZIP target resolves outside workspace", "unsafe_symlink", 503);
  }
  await assertZipTreeHasNoSymlinks(directoryRealPath);
  if (signal.aborted) throw new FileOpError("ZIP operation cancelled", "operation_timeout", 503);
  await zipBeforeSpawnHook?.();
  if (signal.aborted) throw new FileOpError("ZIP operation cancelled", "operation_timeout", 503);

  // spawn 可能在校验后才解析 cwd。子进程先从内核已打开的 cwd 获取物理路径并校验，
  // 随后始终归档 "."；即使路径层级被并发替换，也不会再按不可信 archivePath 查找目标。
  // cwd 在进程创建后由内核引用，后续 rename 不会将它切换到攻击者替换的新目录。
  const child = spawn("/bin/sh", ["-c", ZIP_FROM_CWD_SCRIPT, "zip-from-cwd", workspaceRealPath], {
    cwd: directoryRealPath,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const chunks: Buffer[] = [];
  const errors: Buffer[] = [];
  let outputBytes = 0;
  let timedOut = false;
  const killChild = () => child.kill("SIGKILL");
  signal.addEventListener("abort", killChild, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    killChild();
  }, ZIP_TIMEOUT_MS);

  try {
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_ZIP_BYTES) {
        killChild();
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));

    const childEvents = child as unknown as NodeJS.EventEmitter;
    await new Promise<void>((resolveProcess, reject) => {
      childEvents.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "ENOENT" || err.code === "ENOTDIR" || err.code === "ELOOP") {
          reject(new FileOpError("ZIP path changed during archive creation", "unsafe_symlink", 503));
          return;
        }
        reject(err);
      });
      childEvents.once("close", (code: number | null) => {
        if (outputBytes > MAX_ZIP_BYTES) {
          reject(new FileOpError("ZIP archive exceeds 20MB; select a smaller directory", "payload_too_large", 413));
        } else if (timedOut) {
          reject(new FileOpError("ZIP operation timed out", "operation_timeout", 503));
        } else if (signal.aborted) {
          reject(new FileOpError("ZIP operation cancelled", "operation_timeout", 503));
        } else if (code === 73 || code === 74) {
          reject(
            new FileOpError(
              Buffer.concat(errors).toString("utf-8").trim() || "ZIP path changed during archive creation",
              "unsafe_symlink",
              503,
            ),
          );
        } else if (code === 0) resolveProcess();
        else reject(new Error(Buffer.concat(errors).toString("utf-8").trim() || `zip exited with code ${code}`));
      });
    });
    return Buffer.concat(chunks, outputBytes).toString("base64");
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", killChild);
  }
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle a file_op message from RCS.
 * Returns a file_op_result message.
 */
export async function handleFileOp(msg: FileOpMessage): Promise<FileOpResult> {
  const { request_id, operation, params } = msg;
  const environmentId = params.environmentId as string;
  const controller = new AbortController();

  const workspace = getWorkspaceSync(environmentId);
  if (!workspace) {
    return {
      type: "file_op_result",
      request_id,
      status: "error",
      error: `Workspace not found for environment: ${environmentId}`,
    };
  }

  if (
    operation === "zip" &&
    [...activeFileOps.values()].filter((active) => active.operation === "zip").length >= MAX_CONCURRENT_ZIPS
  ) {
    return {
      type: "file_op_result",
      request_id,
      status: "error",
      error: "Another ZIP operation is already running",
      error_code: "busy",
      status_code: 429,
    };
  }
  activeFileOps.set(request_id, { controller, operation });
  try {
    let data: unknown;

    switch (operation) {
      case "list":
        data = await opList(workspace, params);
        break;
      case "stat":
        data = await opStat(workspace, params);
        break;
      case "read":
        data = await opRead(workspace, params);
        break;
      case "read_binary":
        data = await opReadBinary(workspace, params);
        break;
      case "write":
        data = await opWrite(workspace, params);
        break;
      case "upload":
        data = await opUpload(workspace, params);
        break;
      case "delete":
        data = await opDelete(workspace, params);
        break;
      case "rename":
        data = await opRename(workspace, params);
        break;
      case "mkdir":
        data = await opMkdir(workspace, params);
        break;
      case "tree":
        data = await opTree(workspace, params);
        break;
      case "zip":
        data = await opZip(workspace, params, controller.signal);
        break;
      default:
        return {
          type: "file_op_result",
          request_id,
          status: "error",
          error: `Unknown operation: ${operation}`,
        };
    }

    return { type: "file_op_result", request_id, status: "ok", data };
  } catch (err) {
    return {
      type: "file_op_result",
      request_id,
      status: "error",
      error: (err as Error).message,
      ...(err instanceof FileOpError ? { error_code: err.errorCode, status_code: err.statusCode } : {}),
    };
  } finally {
    activeFileOps.delete(request_id);
  }
}
