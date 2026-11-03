import { posix } from "node:path";
import { AppError, ValidationError } from "@fenix/platform-sdk";
import { assertSafePath, createAgentFileService, normalizeUploadRelativePath } from "./agent-file-service";
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
  const dir = posix.normalize(rawDir).replace(/\/$/, "");
  if (dir !== "user" && !dir.startsWith("user/")) throw new ValidationError("Only user/ paths are writable");
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
