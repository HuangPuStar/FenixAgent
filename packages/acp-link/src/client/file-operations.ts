import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

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

    // Hide .opencode at workspace root
    if (basename(fullPath) === ".opencode" && resolve(fullPath, "..") === workspace) continue;

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

async function opUpload(
  workspace: string,
  params: Record<string, unknown>,
): Promise<{ files: Array<{ name: string; path: string; size: number }> }> {
  const dirPath = resolveAndValidate(workspace, (params.dir as string) || "");
  if (!dirPath) throw new Error("Invalid dir: path traversal detected");

  const files = params.files as Array<{ name: string; content: string; relativePath?: string }>;
  const results: Array<{ name: string; path: string; size: number }> = [];

  for (const file of files) {
    const relPath = file.relativePath ?? file.name;
    const targetDir = resolve(dirPath, relPath, "..");
    await mkdir(targetDir, { recursive: true });

    const targetPath = resolve(dirPath, relPath);
    // Validate target stays within workspace
    if (!targetPath.startsWith(`${dirPath}/`) && targetPath !== dirPath) {
      throw new Error(`Invalid file path: ${relPath} escapes target directory`);
    }

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

async function opTree(workspace: string, params: Record<string, unknown>): Promise<{ paths: string[] }> {
  const rawPath = (params.path as string) || "";
  const rootDir = resolveAndValidate(workspace, rawPath) ?? workspace;
  const paths: string[] = [];

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      // Hide .opencode at workspace root
      if (basename(fullPath) === ".opencode" && resolve(fullPath, "..") === workspace) continue;

      const relPath = relative(workspace, fullPath);
      paths.push(entry.isDirectory() ? `${relPath}/` : relPath);

      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  try {
    await walk(rootDir);
  } catch {
    // dir may not exist yet
  }

  return { paths };
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

  const workspace = getWorkspaceSync(environmentId);
  if (!workspace) {
    return {
      type: "file_op_result",
      request_id,
      status: "error",
      error: `Workspace not found for environment: ${environmentId}`,
    };
  }

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
    };
  }
}
