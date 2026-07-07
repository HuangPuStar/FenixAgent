import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import Elysia from "elysia";
import { NotFoundError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import { OkResponseSchema } from "../../schemas/common.schema";
import {
  BatchDeleteRequestSchema,
  BatchDeleteResponseSchema,
  FileContentSchema,
  FileListResponseSchema,
  FileUploadResponseSchema,
  FileWriteResultSchema,
  MkdirRequestSchema,
  MkdirResponseSchema,
  RenameRequestSchema,
  RenameResponseSchema,
  TreeResponseSchema,
  WriteFileRequestSchema,
} from "../../schemas/file.schema";
import { getOwnedEnvironment } from "../../services/environment-core";
import {
  getRemoteMachineId,
  remoteDeleteFile,
  remoteListDir,
  remoteMkdir,
  remoteReadBinaryFile,
  remoteReadFile,
  remoteRename,
  remoteTree,
  remoteUploadFiles,
  remoteWriteFile,
} from "../../services/remote-file-service";
import {
  createFileStream,
  deleteFile,
  deleteNode,
  getMimeType,
  isTextExtension,
  isTextFile,
  listDirectory,
  listPathsRecursive,
  mkdirp,
  readFileContent,
  renamePath,
  resolveWorkspacePath,
  writeFileContent,
} from "../../services/workspace-fs";

const app = new Elysia({ name: "web-fs", prefix: "/environments" }).use(authGuardPlugin).model({
  "tree-response": TreeResponseSchema,
  "file-list-response": FileListResponseSchema,
  "file-content": FileContentSchema,
  "file-upload-response": FileUploadResponseSchema,
  "file-write-result": FileWriteResultSchema,
  "write-file-request": WriteFileRequestSchema,
  "delete-file-response": OkResponseSchema,
  "rename-request": RenameRequestSchema,
  "rename-response": RenameResponseSchema,
  "mkdir-request": MkdirRequestSchema,
  "mkdir-response": MkdirResponseSchema,
  "batch-delete-request": BatchDeleteRequestSchema,
  "batch-delete-response": BatchDeleteResponseSchema,
});

async function requireEnv(
  envId: string,
  orgId: string,
  userId: string,
  errorFn: (status: number, body: unknown) => Response,
) {
  try {
    return await getOwnedEnvironment(envId, orgId, userId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return errorFn(404, { error: { type: "not_found", message: "环境不存在" } });
    }
    throw e;
  }
}

// GET /:id/fs/tree — 递归扫描 workspace 树（黑名单过滤）
app.get(
  "/:id/fs/tree",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const env = await requireEnv(params.id, authCtx.organizationId, user.id, error);
    if (env instanceof Response) return env;

    // 远程环境：通过 file-ws 代理
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      try {
        const paths = await remoteTree(machineId, params.id);
        return { success: true, data: { paths } };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote tree operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const resolved = await resolveWorkspacePath(params.id, ".");
    if (!resolved) return error(404, { error: { type: "not_found", message: "工作区不存在" } });
    const entries = await listPathsRecursive(resolved.workspaceDir);
    const paths = entries.map((e) => e.path);
    const mtimes: Record<string, number> = {};
    for (const e of entries) {
      if (e.mtime > 0) mtimes[e.path] = e.mtime;
    }
    return { success: true, data: { paths, mtimes } };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "获取 workspace 文件树",
      description: "递归返回整个 workspace 目录的文件与目录路径（黑名单过滤），用于构建完整文件树。",
    },
  },
);

// GET /:id/fs — 列目录
app.get(
  "/:id/fs",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    const queryPath = (query as Record<string, string | undefined>)?.path || ".";

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const entries = await remoteListDir(machineId, envId, queryPath);
        return { success: true, data: { entries } };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const result = await resolveWorkspacePath(envId, queryPath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    const info = await stat(result.resolved);
    if (!info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Not a directory" } });

    const items = await listDirectory(result.resolved, result.userDir, result.workspaceDir);
    return { success: true, data: { entries: items } };
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "获取 workspace 目录列表",
      description: "返回指定环境 workspace 目录下的文件和目录列表（黑名单过滤）。",
    },
  },
);

// GET /:id/fs/* — 读文件
app.get(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, query, error, set }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawFilePath = (params as any)["*"] as string;
    // 浏览器发送的 URL 中非 ASCII 字符会被 percent-encode，Elysia 的 memoirist 路由
    // 在某些版本下可能不会自动解码通配符 * 的值，这里做一层安全的 decodeURIComponent
    // 兜底。如果已解码则 catch 保留原值（解码后的中文会 throw URIError）。
    try {
      rawFilePath = decodeURIComponent(rawFilePath);
    } catch {
      // 已经解码，直接使用
    }
    const preview = (query as Record<string, string | undefined>)?.preview === "true";

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        if (preview) {
          const binResult = await remoteReadBinaryFile(machineId, envId, rawFilePath);
          const buffer = Buffer.from(binResult.data, "base64");
          set.headers["Content-Type"] = binResult.mimeType || "application/octet-stream";
          set.headers["Content-Security-Policy"] =
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
          return new Response(buffer);
        }
        // 非预览：先尝试文本，失败则走二进制下载
        try {
          const textResult = await remoteReadFile(machineId, envId, rawFilePath);
          return {
            success: true,
            data: {
              name: textResult.name,
              path: textResult.path,
              content: textResult.content,
              size: textResult.size,
              encoding: "utf-8",
            },
          };
        } catch {
          const binResult = await remoteReadBinaryFile(machineId, envId, rawFilePath);
          const buffer = Buffer.from(binResult.data, "base64");
          set.headers["Content-Disposition"] = `attachment; filename="${binResult.name}"`;
          set.headers["Content-Type"] = "application/octet-stream";
          return new Response(buffer);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const result = await resolveWorkspacePath(envId, rawFilePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    const { resolved, displayPath } = result;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch {
      return error(404, { error: { type: "not_found", message: "File not found" } });
    }
    if (info.isDirectory())
      return error(400, { error: { type: "validation_error", message: "Path is a directory, use list endpoint" } });

    const lastDot = rawFilePath.lastIndexOf(".");
    const lastSlash = rawFilePath.lastIndexOf("/");
    const ext = lastDot > lastSlash ? rawFilePath.substring(lastDot) : "";

    if (preview) {
      set.headers["Content-Type"] = getMimeType(ext);
      set.headers["Content-Security-Policy"] =
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
      // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch with Response constructor
      return new Response(createFileStream(resolved) as any);
    }

    const textFile = isTextExtension(ext) || (!ext && (await isTextFile(resolved)));
    const fileName = rawFilePath.substring(rawFilePath.lastIndexOf("/") + 1);

    if (textFile) {
      const { content, size } = await readFileContent(resolved);
      return { success: true, data: { name: fileName, path: displayPath, content, size, encoding: "utf-8" } };
    }

    // 中文文件名 RFC 5987 编码
    const hasNonAscii = [...fileName].some((c) => c.charCodeAt(0) > 127);
    const encodedFileName = encodeURIComponent(fileName);
    const contentDisp = hasNonAscii
      ? `attachment; filename*=UTF-8''${encodedFileName}`
      : `attachment; filename="${fileName}"`;
    set.headers["Content-Disposition"] = contentDisp;
    set.headers["Content-Type"] = "application/octet-stream";
    // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch with Response constructor
    return new Response(createFileStream(resolved) as any);
  },
  {
    sessionAuth: true,
    response: "file-content",
    detail: {
      tags: ["FS"],
      summary: "读取 workspace 文件内容",
      description:
        "读取指定文件。文本文件默认返回 JSON 内容；当 preview=true 或目标为二进制文件时，接口会直接返回文件流而不是 JSON。",
    },
  },
);

// POST /:id/fs/* — 上传文件
app.post(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, request, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawDirPath = ((params as any)["*"] as string) || "";
    try {
      rawDirPath = decodeURIComponent(rawDirPath);
    } catch {
      /* 已解码 */
    }

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0)
      return error(400, { error: { type: "validation_error", message: "No files provided" } });

    // 解析相对路径数组（文件夹上传时由前端传入）
    const rawPaths = formData.get("relativePaths");
    let relativePaths: string[] = [];
    if (rawPaths && typeof rawPaths === "string") {
      try {
        relativePaths = JSON.parse(rawPaths);
      } catch {
        relativePaths = [];
      }
    }

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const remoteFiles = await Promise.all(
          files.map(async (file, i) => {
            const buffer = Buffer.from(await file.arrayBuffer());
            if (buffer.length > 100 * 1024 * 1024) throw new Error(`File ${file.name} exceeds 100MB limit`);
            return {
              name: file.name,
              content: buffer.toString("base64"),
              relativePath: relativePaths[i] || file.name,
            };
          }),
        );
        const result = await remoteUploadFiles(machineId, envId, rawDirPath, remoteFiles);
        return { success: true, data: result };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const result = await resolveWorkspacePath(envId, rawDirPath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    const { resolved } = result;
    const { mkdir, writeFile: writeFileAsync } = await import("node:fs/promises");
    await mkdir(resolved, { recursive: true });

    const uploaded: Array<{ name: string; path: string; size: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length > 100 * 1024 * 1024) {
        return error(413, { error: { type: "validation_error", message: `File ${file.name} exceeds 100MB limit` } });
      }

      // 如果有对应的相对路径，保留目录结构；否则直接用文件名
      const relPath = relativePaths[i] || file.name;
      const destPath = join(resolved, relPath);
      const destDir = dirname(destPath);
      await mkdir(destDir, { recursive: true });
      await writeFileAsync(destPath, buffer);

      uploaded.push({
        name: file.name,
        path: rawDirPath ? `${rawDirPath}/${relPath}` : relPath,
        size: buffer.length,
      });
    }
    return new Response(JSON.stringify({ success: true, data: { files: uploaded } }), {
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "上传文件",
      description: "向 workspace 指定目录上传一个或多个文件；支持通过 relativePaths 保留文件夹层级。",
    },
  },
);

// PUT /:id/fs/* — 写入文件内容
app.put(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawFilePath = (params as any)["*"] as string;
    try {
      rawFilePath = decodeURIComponent(rawFilePath);
    } catch {
      /* 已解码 */
    }

    const b = body as { content?: string };
    if (typeof b.content !== "string")
      return error(400, { error: { type: "validation_error", message: "content field required" } });

    if (b.content.length > 100 * 1024 * 1024)
      return error(413, { error: { type: "validation_error", message: "Content exceeds 100MB limit" } });

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const result = await remoteWriteFile(machineId, envId, rawFilePath, b.content);
        return { success: true, data: result };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const result = await resolveWorkspacePath(envId, rawFilePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    await writeFileContent(result.resolved, b.content);

    const fileName = rawFilePath.substring(rawFilePath.lastIndexOf("/") + 1);
    return { success: true, data: { name: fileName, path: rawFilePath, size: Buffer.byteLength(b.content) } };
  },
  {
    sessionAuth: true,
    body: "write-file-request",
    response: "file-write-result",
    detail: {
      tags: ["FS"],
      summary: "写入文件内容",
      description: "将文本内容写入 workspace 任意路径文件。",
    },
  },
);

// DELETE /:id/fs/* — 删除文件
app.delete(
  "/:id/fs/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    let rawFilePath = (params as any)["*"] as string;
    try {
      rawFilePath = decodeURIComponent(rawFilePath);
    } catch {
      /* 已解码 */
    }

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        await remoteDeleteFile(machineId, envId, rawFilePath);
        return { success: true, data: { ok: true } };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const result = await resolveWorkspacePath(envId, rawFilePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

    try {
      const info = await stat(result.resolved);
      if (info.isDirectory()) {
        await deleteNode(result.resolved);
        return { success: true, data: { ok: true } };
      }
    } catch {
      return error(404, { error: { type: "not_found", message: "File not found" } });
    }

    await deleteFile(result.resolved);
    return { success: true, data: { ok: true } };
  },
  {
    sessionAuth: true,
    response: "delete-file-response",
    detail: {
      tags: ["FS"],
      summary: "删除文件",
      description: "删除 workspace 任意路径的文件或目录（目录将递归删除）。",
    },
  },
);

// POST /:id/fs/mkdir — 创建目录
app.post(
  "/:id/fs/mkdir",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    await requireEnv(params.id, authCtx.organizationId, user.id, error);
    const { path } = body as { path: string };

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      try {
        await remoteMkdir(machineId, params.id, path);
        return { success: true, data: { path } };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote mkdir operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const resolved = await resolveWorkspacePath(params.id, path);
    if (!resolved) return error(400, { error: { type: "validation_error", message: "Invalid path" } });

    await mkdirp(resolved.resolved);
    return { success: true, data: { path } };
  },
  {
    sessionAuth: true,
    body: "mkdir-request",
    detail: {
      tags: ["FS"],
      summary: "创建目录",
      description: "在 workspace 任意路径创建新目录。",
    },
  },
);

// POST /:id/fs/rename — 重命名/移动
app.post(
  "/:id/fs/rename",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    await requireEnv(params.id, authCtx.organizationId, user.id, error);
    const { oldPath, newPath } = body as { oldPath: string; newPath: string };

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      try {
        await remoteRename(machineId, params.id, oldPath, newPath);
        return { success: true, data: { oldPath, newPath } };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote rename operation failed";
        return error(503, { error: { type: "remote_error", message } });
      }
    }

    const oldResolved = await resolveWorkspacePath(params.id, oldPath);
    if (!oldResolved) return error(404, { error: { type: "not_found", message: "Source not found" } });

    try {
      await stat(oldResolved.resolved);
    } catch {
      return error(404, { error: { type: "not_found", message: "Source not found" } });
    }

    const newResolved = await resolveWorkspacePath(params.id, newPath);
    if (!newResolved) return error(400, { error: { type: "validation_error", message: "Invalid destination" } });

    await renamePath(oldResolved.resolved, newResolved.resolved);
    return { success: true, data: { oldPath, newPath } };
  },
  {
    sessionAuth: true,
    body: "rename-request",
    detail: {
      tags: ["FS"],
      summary: "重命名文件或目录",
      description: "在 workspace 内重命名或移动文件/目录。",
    },
  },
);

// DELETE /:id/fs/batch — 批量删除
app.delete(
  "/:id/fs/batch",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    await requireEnv(params.id, authCtx.organizationId, user.id, error);
    const { paths } = body as { paths: string[] };

    // 远程环境
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      const deleted: string[] = [];
      const failed: Array<{ path: string; error: string }> = [];
      for (const p of paths) {
        try {
          await remoteDeleteFile(machineId, params.id, p);
          deleted.push(p);
        } catch (e) {
          failed.push({ path: p, error: e instanceof Error ? e.message : "Unknown error" });
        }
      }
      return { success: true, data: { deleted, failed } };
    }

    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const p of paths) {
      try {
        const resolved = await resolveWorkspacePath(params.id, p);
        if (!resolved) {
          failed.push({ path: p, error: "Not found" });
          continue;
        }
        const info = await stat(resolved.resolved);
        if (info.isDirectory()) {
          await deleteNode(resolved.resolved);
        } else {
          await deleteFile(resolved.resolved);
        }
        deleted.push(p);
      } catch (e) {
        failed.push({ path: p, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }

    return { success: true, data: { deleted, failed } };
  },
  {
    sessionAuth: true,
    body: "batch-delete-request",
    detail: {
      tags: ["FS"],
      summary: "批量删除文件或目录",
      description: "批量删除 workspace 内指定路径的文件或目录（目录将递归删除），并分别返回成功与失败结果。",
    },
  },
);

// GET /:id/fs/download-zip — 打包下载目录
app.get(
  "/:id/fs/download-zip",
  async ({ store, params, query, error, set }) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const env = await requireEnv(params.id, authCtx.organizationId, user.id, error);
    if (env instanceof Response) return env;

    // 远程环境暂不支持打包下载
    const machineId = await getRemoteMachineId(params.id);
    if (machineId) {
      return error(501, {
        error: { type: "not_implemented", message: "远程环境暂不支持目录打包下载" },
      });
    }

    const path = (query as Record<string, string | undefined>)?.path;
    if (!path) return error(400, { error: { type: "validation_error", message: "path query parameter required" } });

    const resolved = await resolveWorkspacePath(params.id, path);
    if (!resolved) return error(404, { error: { type: "not_found", message: "Path not found" } });

    try {
      const info = await stat(resolved.resolved);
      if (!info.isDirectory())
        return error(400, { error: { type: "validation_error", message: "Path is not a directory" } });
    } catch {
      return error(404, { error: { type: "not_found", message: "Path not found" } });
    }

    const dirName = path.split("/").filter(Boolean).pop() || "download";
    set.headers["Content-Type"] = "application/zip";
    set.headers["Content-Disposition"] = `attachment; filename="${dirName}.zip"`;

    // 使用系统 zip 命令流式打包，零内存占用
    const zipProcess = spawn("zip", ["-r", "-q", "-", "."], {
      cwd: resolved.resolved,
      stdio: ["ignore", "pipe", "ignore"],
    });

    // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch
    return new Response(zipProcess.stdout as any);
  },
  {
    sessionAuth: true,
    detail: {
      tags: ["FS"],
      summary: "下载目录压缩包",
      description: "将 workspace 内指定目录打包为 zip 文件并直接返回下载流；当前仅支持本地环境。",
    },
  },
);

export default app;
