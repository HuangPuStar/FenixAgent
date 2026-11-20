import { spawn } from "node:child_process";
import { link, lstat, mkdir, readdir, realpath, rename, rm, rmdir, stat, unlink } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { opRead, opReadBinary, opStat, opUpload, opWrite } from "./file-content-operations";
import { FileOpError, type FileOpResult, isErrnoException } from "./file-operation-errors";
import { isWithinRoot, resolveAndValidate, shouldHideWorkspaceEntry } from "./file-operation-paths";

export { setUploadBeforeWriteHookForTest } from "./file-content-operations";

import { buildWorkspaceZipEnv } from "./workspace-zip-env.js";

// 双向Base64消息共用128MiB预算，原文件为协议元信息保留余量。
const MAX_DOWNLOAD_BYTES = 92 * 1024 * 1024;

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
  op_id?: string;
  type: "file_op";
  request_id: string;
  operation: string;
  params: Record<string, unknown>;
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

// ============================================================================
// Helpers
// ============================================================================

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

async function opDelete(workspace: string, params: Record<string, unknown>): Promise<{ ok: boolean }> {
  const filePath = resolveAndValidate(workspace, params.path as string);
  if (!filePath) throw new Error("Invalid path: path traversal detected");

  await rm(filePath, { recursive: true, force: true });
  return { ok: true };
}

let directoryRenameBeforeMoveHook: ((destination: string) => Promise<void>) | undefined;

/** 仅供目录占位后的并发冲突与清理行为测试注入变更。 */
export function setDirectoryRenameBeforeMoveHookForTest(hook?: (destination: string) => Promise<void>): void {
  directoryRenameBeforeMoveHook = hook;
}

async function opRename(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ oldPath: string; newPath: string }> {
  const oldFilePath = resolveAndValidate(workspace, params.oldPath as string);
  const newFilePath = resolveAndValidate(workspace, params.newPath as string);
  if (!oldFilePath) throw new Error("Invalid oldPath: path traversal detected");
  if (!newFilePath) throw new Error("Invalid newPath: path traversal detected");

  if (oldFilePath === newFilePath) return { oldPath: params.oldPath as string, newPath: params.newPath as string };
  const source = await lstat(oldFilePath);
  if (newFilePath.startsWith(`${oldFilePath}${sep}`)) throw new Error("Cannot move a directory into itself");
  await mkdir(resolve(newFilePath, ".."), { recursive: true });
  if (!source.isDirectory()) {
    await link(oldFilePath, newFilePath);
    await unlink(oldFilePath);
  } else {
    await mkdir(newFilePath);
    const reservation = await lstat(newFilePath);
    try {
      await directoryRenameBeforeMoveHook?.(newFilePath);
      await rename(oldFilePath, newFilePath);
    } catch (error) {
      try {
        const current = await lstat(newFilePath);
        if (current.dev === reservation.dev && current.ino === reservation.ino) await rmdir(newFilePath);
      } catch (cleanupError) {
        if (!isErrnoException(cleanupError) || !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(cleanupError.code ?? "")) {
          throw new AggregateError([error, cleanupError], "Directory rename failed; target reservation retained");
        }
      }
      throw error;
    }
  }

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
): Promise<{
  paths: string[];
  mtimes?: Record<string, number>;
  sizes?: Record<string, number>;
  errors?: { path: string; message: string }[];
}> {
  const rawPath = (params.path as string) || "";
  const rootDir = resolveAndValidate(workspace, rawPath) ?? workspace;
  const paths: string[] = [];
  const mtimes: Record<string, number> = {};
  const sizes: Record<string, number> = {};
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
          const info = await lstat(fullPath);
          mtimes[relPath] = info.mtimeMs;
          if (info.isFile()) sizes[relPath] = info.size;
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
    return { paths, mtimes, sizes, errors: errors.length > 0 ? errors : undefined };
  }

  return { paths, mtimes, sizes, errors: errors.length > 0 ? errors : undefined };
}

const MAX_ZIP_BYTES = MAX_DOWNLOAD_BYTES;
const ZIP_TIMEOUT_MS = 101_000;
const MAX_CONCURRENT_ZIPS = 1;
const activeFileOps = new Map<string, { controller: AbortController; operation: string }>();
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
    // 按用途白名单构造环境（§5.4）：脚本内的 zip/find/grep 靠 PATH，且不得继承 ZIPOPT 等宿主变量
    env: buildWorkspaceZipEnv(),
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
          reject(new FileOpError("ZIP archive exceeds 92MB; select a smaller directory", "payload_too_large", 413));
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
        data = await opWrite(workspace, params, msg.op_id, controller.signal);
        break;
      case "upload":
        data = await opUpload(workspace, params, msg.op_id, controller.signal);
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
    if (isErrnoException(err) && (err.code === "EEXIST" || err.code === "ENOTEMPTY")) {
      return {
        type: "file_op_result",
        request_id,
        status: "error",
        error: "Target file or directory already exists; original content was not overwritten",
        error_code: "path_conflict",
        status_code: 409,
      };
    }
    return {
      type: "file_op_result",
      request_id,
      status: "error",
      error: (err as Error).message,
      ...(err instanceof FileOpError
        ? { error_code: err.errorCode, status_code: err.statusCode, ...(err.details ? { data: err.details } : {}) }
        : {}),
    };
  } finally {
    activeFileOps.delete(request_id);
  }
}
