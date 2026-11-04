import { once } from "node:events";
import { posix } from "node:path";
import { Readable } from "node:stream";
import { error as logError } from "@fenix/logger";
import { AppError, ValidationError } from "@fenix/platform-sdk";
import {
  assertSafePath,
  createAgentFileService,
  mapFileError,
  normalizeUploadRelativePath,
} from "./agent-file-service";
import { FileServiceError, LOCAL_UPLOAD_MAX_BYTES } from "./file-types";

const defaults = { createAgentFileService };
let overrides: Partial<typeof defaults> | null = null;
/** Replace the shared execution collaborator in transport tests. */
export function setApiWorkspaceDeps(next: Partial<typeof defaults> | null): void {
  overrides = next;
}
/** Stable upload result using Environment-relative paths. */
export interface WorkspaceFileUploadResult {
  environmentId: string;
  files: Array<{ name: string; path: string; size: number }>;
}

/** 下载执行结果；协议层负责转换流与附件响应头。 */
export interface WorkspaceFileDownloadResult {
  name: string;
  stream: Readable;
}

/** v1 文件树只暴露工作区相对路径与脱敏遍历错误。 */
export interface WorkspaceFileTreeResult {
  environmentId: string;
  paths: string[];
  mtimes?: Record<string, number>;
  errors?: Array<{ path: string; message: string }>;
}

/** 查询已授权工作区的完整文件树，保留遍历失败提示而不暴露内部错误。 */
export async function getWorkspaceFileTree(environmentId: string, actorId: string): Promise<WorkspaceFileTreeResult> {
  const service = (overrides?.createAgentFileService ?? defaults.createAgentFileService)({
    environmentId,
    actorId,
    source: "api",
  });
  const result = await service.tree();
  if (result.errors?.length) logError("[api-workspace] Incomplete file tree", result.errors);
  return {
    environmentId,
    paths: [...result.paths],
    ...(result.mtimes ? { mtimes: { ...result.mtimes } } : {}),
    ...(result.errors?.length
      ? { errors: result.errors.map(({ path }) => ({ path, message: "Directory could not be read" })) }
      : {}),
  };
}

/** 以二进制模式读取已授权工作区内的单个文件，保留原始字节。 */
export async function downloadWorkspaceFile(
  environmentId: string,
  path: string,
  actorId: string,
): Promise<WorkspaceFileDownloadResult> {
  const service = (overrides?.createAgentFileService ?? defaults.createAgentFileService)({
    environmentId,
    actorId,
    source: "api",
  });
  const result = await service.read(path, "binary");
  if (result.type !== "binary" || !(result.stream instanceof Readable))
    throw new AppError("Unexpected file download result", "INTERNAL_ERROR", 500);
  const stream = result.stream;
  stream.on("error", (error) => logError("[api-workspace] Download stream failed", error));
  try {
    // createReadStream 延迟打开文件；首个 readable 确认打开成功且不消费字节，避免先发 200 再报打开失败。
    if (stream.readableLength === 0 && !stream.readableEnded) await once(stream, "readable");
  } catch (error) {
    stream.destroy();
    throw mapFileError(error);
  }
  return { name: result.name, stream: result.stream };
}

/** Validate the entire v1 batch before delegating to the common local/remote execution plane. */
export async function uploadWorkspaceFiles(
  environmentId: string,
  formData: FormData,
  actorId: string,
): Promise<WorkspaceFileUploadResult> {
  const entries = formData.getAll("files");
  if (entries.length === 0 || entries.some((file) => !(file instanceof File)))
    throw new ValidationError("Files required");
  const files = entries as File[];
  const rawDir = formData.get("path") ?? "user";
  if (typeof rawDir !== "string") throw new ValidationError("Invalid path");
  assertSafePath(rawDir);
  const normalizedDir = posix.normalize(rawDir).replace(/\/$/, "");
  const dir = normalizedDir === "." ? "" : normalizedDir;
  let paths: string[] | undefined;
  const rawPaths = formData.get("relativePaths");
  if (rawPaths !== null) {
    try {
      const parsed: unknown = JSON.parse(String(rawPaths));
      if (!Array.isArray(parsed) || parsed.length !== files.length || parsed.some((path) => typeof path !== "string"))
        throw new Error("invalid");
      paths = parsed;
    } catch {
      throw new ValidationError("relativePaths must match files");
    }
  }
  const targets = new Set<string>();
  const validated = files.map((file, index) => {
    const path = paths?.[index] ?? file.name;
    if (!normalizeUploadRelativePath(file.name) || !normalizeUploadRelativePath(path))
      throw new ValidationError("Invalid upload path");
    const normalized = posix.normalize(path);
    if (targets.has(normalized)) throw new ValidationError("Duplicate upload target");
    targets.add(normalized);
    if (file.size > LOCAL_UPLOAD_MAX_BYTES) throw new AppError("Single file limit is 92 MiB", "PAYLOAD_TOO_LARGE", 413);
    return { file, path: normalized };
  });
  const inputs = await Promise.all(
    validated.map(async ({ file, path }) => ({
      name: file.name,
      relativePath: path,
      content: new Uint8Array(await file.arrayBuffer()),
    })),
  );
  const service = (overrides?.createAgentFileService ?? defaults.createAgentFileService)({
    environmentId,
    actorId,
    source: "api",
  });
  try {
    const result = await service.upload(dir, inputs);
    return { environmentId, files: result.files };
  } catch (error) {
    if (error instanceof FileServiceError)
      throw new AppError(
        error.statusCode >= 500 ? "File service unavailable" : error.message,
        error.type.toUpperCase(),
        error.statusCode,
      );
    throw error;
  }
}
