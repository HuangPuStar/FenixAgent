import { lstat, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
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

/** 上传文件名必须是 workspace 目录内的规范相对路径。 */
function normalizeUploadRelativePath(value: string): string {
  if (!value || isAbsolute(value) || value.includes("\0") || value.includes("\\")) {
    throw new AppError("Invalid upload path", "VALIDATION_ERROR", 400);
  }
  const normalized = normalize(value).replace(/^\.\//, "");
  if (normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`)) {
    throw new AppError("Invalid upload path", "VALIDATION_ERROR", 400);
  }
  return normalized;
}

async function ensureSafeUploadParent(root: string, destination: string): Promise<void> {
  const parentRelative = relative(root, dirname(destination));
  let current = root;
  for (const segment of parentRelative.split(sep).filter(Boolean)) {
    current = join(current, segment);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new AppError("Upload path crosses a symbolic link", "VALIDATION_ERROR", 400);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
    }
  }

  try {
    if ((await lstat(destination)).isSymbolicLink()) {
      throw new AppError("Upload destination is a symbolic link", "VALIDATION_ERROR", 400);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

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
  await deps.getOwnedEnvironment(environmentId, ctx.organizationId, ctx.userId);

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

  const uploadPaths = files.map((file, index) => normalizeUploadRelativePath(relativePaths[index] ?? file.name));

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
          relativePath: uploadPaths[index]!,
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
  if ((await lstat(resolved.resolved)).isSymbolicLink()) {
    throw new AppError("Workspace path is a symbolic link", "VALIDATION_ERROR", 400);
  }
  const uploaded: WorkspaceFileUploadResult["files"] = [];
  const displayBase = dirPath.replace(/\/+$/, "");

  for (let index = 0; index < files.length; index++) {
    const file = files[index]!;
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > 50 * 1024 * 1024) {
      throw new AppError(`File ${file.name} exceeds 50MB limit`, "PAYLOAD_TOO_LARGE", 413);
    }

    const relPath = uploadPaths[index]!;
    const destination = join(resolved.resolved, relPath);
    const destinationRelative = relative(resolved.resolved, destination);
    if (destinationRelative.startsWith(`..${sep}`) || isAbsolute(destinationRelative)) {
      throw new AppError("Invalid upload path", "VALIDATION_ERROR", 400);
    }
    await ensureSafeUploadParent(resolved.resolved, destination);
    await writeFile(destination, buffer, { flag: "w" });

    uploaded.push({
      name: file.name,
      path: `${displayBase}/${relPath}`.replace(/\/+/g, "/"),
      size: buffer.length,
    });
  }

  return { environmentId, files: uploaded };
}
