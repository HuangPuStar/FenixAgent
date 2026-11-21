import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import {
  readWorkspaceFileSnapshot,
  resolveWorkspaceFileParent,
  uploadWorkspaceFile,
} from "@fenix/plugin-sdk/secure-workspace-upload";
import { FileOpError, isErrnoException, mapContentError } from "./file-operation-errors";
import {
  getMimeType,
  isTextSnapshot,
  isWithinRoot,
  normalizeUploadRelativePath,
  resolveAndValidate,
} from "./file-operation-paths";

const MAX_BYTES = 92 * 1024 * 1024;
let uploadBeforeWriteHook: ((targetPath: string) => Promise<void>) | undefined;

/** Inject a deterministic upload race for filesystem regression tests. */
export function setUploadBeforeWriteHookForTest(hook?: (targetPath: string) => Promise<void>): void {
  uploadBeforeWriteHook = hook;
}

/** Preserve explicit rejection of links introduced while an upload was staged. */
async function assertUploadDestination(workspace: string, destination: string): Promise<void> {
  let current = workspace;
  for (const part of relative(workspace, destination).split(sep)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new FileOpError("Upload target contains a symbolic link", "unsafe_symlink", 503);
    } catch (error) {
      if (!isErrnoException(error) || error.code !== "ENOENT") throw error;
      break;
    }
  }
  if (!isWithinRoot(await realpath(workspace), await realpath(dirname(destination))))
    throw new FileOpError("Upload target resolves outside workspace", "unsafe_symlink", 503);
}

/** File stat computes a content version only when explicitly requested. */
export async function opStat(workspace: string, params: Record<string, unknown>) {
  const path = resolveAndValidate(workspace, params.path as string);
  if (!path) throw new FileOpError("Invalid path: path traversal detected", "validation_error", 400);
  try {
    const info = await stat(path);
    if (params.includeVersion === true && !info.isDirectory()) {
      const snapshot = await readWorkspaceFileSnapshot(workspace, params.path as string);
      return {
        size: snapshot.content.byteLength,
        isDirectory: false,
        modifiedAt: snapshot.modifiedAt,
        version: snapshot.version,
      };
    }
    return { size: info.size, isDirectory: info.isDirectory(), modifiedAt: info.mtimeMs };
  } catch (error) {
    throw mapContentError(error);
  }
}

/** Read a text snapshot; its version hashes the exact UTF-8 bytes represented by the response. */
export async function opRead(workspace: string, params: Record<string, unknown>) {
  const path = resolveAndValidate(workspace, params.path as string);
  if (!path) throw new FileOpError("Invalid path: path traversal detected", "validation_error", 400);
  if (params.includeVersion === true) {
    try {
      const snapshot = await readWorkspaceFileSnapshot(workspace, params.path as string);
      if (!isTextSnapshot(path, snapshot.content))
        throw new FileOpError("This file is not a supported text file", "validation_error", 400);
      const content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot.content);
      return {
        name: basename(path),
        path: relative(workspace, path),
        content,
        size: snapshot.content.byteLength,
        encoding: "utf-8",
        version: snapshot.version,
      };
    } catch (error) {
      throw mapContentError(error);
    }
  }
  const content = await readFile(path, "utf8");
  return {
    name: basename(path),
    path: relative(workspace, path),
    content,
    size: Buffer.byteLength(content),
    encoding: "utf-8",
  };
}

/** Binary snapshots hash the same bytes placed in the base64 payload. */
export async function opReadBinary(workspace: string, params: Record<string, unknown>) {
  const path = resolveAndValidate(workspace, params.path as string);
  if (!path) throw new FileOpError("Invalid path: path traversal detected", "validation_error", 400);
  let content: Buffer, version: string | undefined;
  if (params.includeVersion === true) {
    try {
      const snapshot = await readWorkspaceFileSnapshot(workspace, params.path as string);
      content = snapshot.content;
      version = snapshot.version;
    } catch (error) {
      throw mapContentError(error);
    }
  } else {
    if ((await stat(path)).size > MAX_BYTES)
      throw new FileOpError("File exceeds 92MB download limit", "payload_too_large", 413);
    content = await readFile(path);
    if (content.byteLength > MAX_BYTES)
      throw new FileOpError("File exceeds 92MB download limit", "payload_too_large", 413);
  }
  return {
    name: basename(path),
    path: relative(workspace, path),
    data: content.toString("base64"),
    size: content.byteLength,
    mimeType: getMimeType(path),
    ...(version ? { version } : {}),
  };
}

/** Text writes share the upload replacement execution path and retry receipts. */
export async function opWrite(workspace: string, params: Record<string, unknown>, opId?: string, signal?: AbortSignal) {
  const path = params.path as string;
  if (!resolveAndValidate(workspace, path) || typeof params.content !== "string")
    throw new FileOpError("Invalid write parameters", "validation_error", 400);
  try {
    const result = await uploadWorkspaceFile(
      workspace,
      await resolveWorkspaceFileParent(workspace, path),
      Buffer.from(params.content),
      {
        overwrite: !params.createOnly,
        expectedVersion: params.expectedVersion as string | undefined,
        opId,
        signal,
      },
    );
    return { name: basename(path), path, size: Buffer.byteLength(params.content), version: result.version };
  } catch (error) {
    throw mapContentError(error);
  }
}

/** Execute a validated upload batch and retain completed-file details on the first failure. */
export async function opUpload(
  workspace: string,
  params: Record<string, unknown>,
  opId?: string,
  signal?: AbortSignal,
) {
  const dir = (params.dir as string) ?? "";
  const dirPath = resolveAndValidate(workspace, dir);
  if (
    !dirPath ||
    (params.overwrite !== undefined && typeof params.overwrite !== "boolean") ||
    !Array.isArray(params.files) ||
    !params.files.length
  )
    throw new FileOpError("Invalid upload parameters", "validation_error", 400);
  const targets = new Set<string>();
  const files = (
    params.files as Array<{ name: string; content: string; relativePath?: string; expectedVersion?: string }>
  ).map((file) => {
    const relPath = normalizeUploadRelativePath(file.relativePath) || normalizeUploadRelativePath(file.name);
    if (
      !relPath ||
      normalizeUploadRelativePath(file.relativePath) === null ||
      typeof file.content !== "string" ||
      (file.expectedVersion !== undefined && (!params.overwrite || !/^[a-f0-9]{64}$/.test(file.expectedVersion)))
    )
      throw new FileOpError(
        "Invalid upload path: expected a non-blank relative path without '..' or control characters",
        "validation_error",
        400,
      );
    const target = resolveAndValidate(workspace, relative(workspace, resolve(dirPath, relPath)));
    if (!target || !isWithinRoot(dirPath, target) || targets.has(target))
      throw new FileOpError("Invalid or duplicate upload target", "validation_error", 400);
    targets.add(target);
    const content = Buffer.from(file.content, "base64");
    if (content.byteLength > MAX_BYTES)
      throw new FileOpError("File exceeds 92MB upload limit", "payload_too_large", 413);
    return { file, target, path: relative(workspace, target), content };
  });
  if (files.reduce((sum, item) => sum + item.content.byteLength, 0) > MAX_BYTES)
    throw new FileOpError("Upload batch exceeds 92MB limit", "payload_too_large", 413);
  const completed: Array<{ name: string; path: string; size: number; version?: string }> = [];
  for (const [index, item] of files.entries()) {
    try {
      const result = await uploadWorkspaceFile(
        workspace,
        item.path,
        item.content,
        { overwrite: params.overwrite === true, expectedVersion: item.file.expectedVersion, opId, signal },
        async () => {
          await uploadBeforeWriteHook?.(item.target);
          if (item.file.expectedVersion === undefined) await assertUploadDestination(workspace, item.target);
        },
      );
      completed.push({
        name: basename(item.target),
        path: item.path,
        size: item.content.byteLength,
        ...(params.overwrite ? { version: result.version } : {}),
      });
    } catch (error) {
      const failure = mapContentError(error);
      throw new FileOpError(
        failure.message,
        failure.errorCode,
        failure.statusCode,
        params.overwrite
          ? {
              completedFiles: completed,
              failedFile: item.path,
              remainingFiles: files.slice(index + 1).map((next) => next.path),
            }
          : undefined,
      );
    }
  }
  return { files: completed };
}
