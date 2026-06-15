import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { getOwnedEnvironment } from "./environment-core";
import { getRemoteMachineId, remoteUploadFiles } from "./remote-file-service";
import { isUserPath, normalizeUserRoutePath, resolveWorkspacePath } from "./workspace-fs";

type WorkspaceDeps = {
  getOwnedEnvironment: typeof getOwnedEnvironment;
  getRemoteMachineId: typeof getRemoteMachineId;
  isUserPath: typeof isUserPath;
  normalizeUserRoutePath: typeof normalizeUserRoutePath;
  remoteUploadFiles: typeof remoteUploadFiles;
  resolveWorkspacePath: typeof resolveWorkspacePath;
};

const defaultDeps: WorkspaceDeps = {
  getOwnedEnvironment,
  getRemoteMachineId,
  isUserPath,
  normalizeUserRoutePath,
  remoteUploadFiles,
  resolveWorkspacePath,
};

let deps: WorkspaceDeps = defaultDeps;

/**
 * 测试覆盖 workspace service 依赖，避免路由测试触达真实文件系统和远程节点。
 */
export function setApiWorkspaceDeps(overrides: Partial<WorkspaceDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

export interface WorkspaceFileUploadResult {
  environmentId: string;
  files: Array<{
    name: string;
    path: string;
    size: number;
  }>;
}

/**
 * 上传文件到 Environment workspace 下的 user 目录。
 * 文件语义保持 environment 级共享，而不是 session 私有文件。
 */
export async function uploadWorkspaceFiles(
  ctx: AuthContext,
  environmentId: string,
  formData: FormData,
): Promise<WorkspaceFileUploadResult> {
  await deps.getOwnedEnvironment(environmentId, ctx.organizationId);

  const files = formData
    .getAll("files")
    .filter((file): file is File => typeof File !== "undefined" && file instanceof File);
  if (files.length === 0) {
    throw new AppError("No files provided", "VALIDATION_ERROR", 400);
  }

  const rawPath = formData.get("path");
  const targetPath = typeof rawPath === "string" && rawPath.trim().length > 0 ? rawPath : "user";
  const dirPath = deps.normalizeUserRoutePath(targetPath);
  if (!deps.isUserPath(dirPath)) {
    throw new AppError("Only user/ paths are writable", "VALIDATION_ERROR", 400);
  }

  const rawRelativePaths = formData.get("relativePaths");
  let relativePaths: string[] = [];
  if (typeof rawRelativePaths === "string" && rawRelativePaths.trim().length > 0) {
    try {
      const parsed = JSON.parse(rawRelativePaths);
      relativePaths = Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      throw new AppError("relativePaths must be valid JSON", "VALIDATION_ERROR", 400);
    }
  }

  const machineId = await deps.getRemoteMachineId(environmentId);
  if (machineId) {
    const remoteFiles = await Promise.all(
      files.map(async (file, index) => {
        const buffer = Buffer.from(await file.arrayBuffer());
        if (buffer.length > 50 * 1024 * 1024) {
          throw new AppError(`File ${file.name} exceeds 50MB limit`, "PAYLOAD_TOO_LARGE", 413);
        }
        return {
          name: file.name,
          content: buffer.toString("base64"),
          relativePath: relativePaths[index] || file.name,
        };
      }),
    );

    const remoteDir = dirPath.replace(/^user\/?/, "");
    const result = await deps.remoteUploadFiles(machineId, environmentId, remoteDir, remoteFiles);
    return {
      environmentId,
      files: result.files.map((file) => ({
        ...file,
        path: file.path.startsWith("user/") ? file.path : deps.normalizeUserRoutePath(file.path),
      })),
    };
  }

  const resolved = await deps.resolveWorkspacePath(environmentId, dirPath);
  if (!resolved) {
    throw new AppError("Environment not found", "NOT_FOUND", 404);
  }

  await mkdir(resolved.resolved, { recursive: true });
  const uploaded: WorkspaceFileUploadResult["files"] = [];
  const displayBase = dirPath.replace(/\/+$/, "");

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > 50 * 1024 * 1024) {
      throw new AppError(`File ${file.name} exceeds 50MB limit`, "PAYLOAD_TOO_LARGE", 413);
    }

    const relPath = relativePaths[index] || file.name;
    const destination = join(resolved.resolved, relPath);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, buffer);

    uploaded.push({
      name: file.name,
      path: `${displayBase}/${relPath}`.replace(/\/+/g, "/"),
      size: buffer.length,
    });
  }

  return { environmentId, files: uploaded };
}
