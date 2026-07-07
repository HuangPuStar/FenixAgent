import { stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import Elysia from "elysia";
import * as z from "zod/v4";
import { NotFoundError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import { WebErrSchema, WebOkSchema } from "../../schemas/common.schema";
import {
  FileContentSchema,
  FileListResponseSchema,
  FileUploadResponseSchema,
  FileWriteResultSchema,
  WriteFileRequestSchema,
} from "../../schemas/file.schema";
import { getOwnedEnvironment } from "../../services/environment-core";
import {
  getRemoteMachineId,
  remoteDeleteFile,
  remoteListDir,
  remoteReadBinaryFile,
  remoteReadFile,
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
  isUserPath,
  listDirectory,
  normalizeUserRoutePath,
  readFileContent,
  resolveWorkspacePath,
  writeFileContent,
} from "../../services/workspace-fs";

const app = new Elysia({ name: "web-files", prefix: "/environments" }).use(authGuardPlugin).model({
  "delete-file-response": WebOkSchema(z.null()).describe("删除文件后的成功响应。"),
  "file-list-response": FileListResponseSchema,
  "file-content": FileContentSchema,
  "file-upload-response": FileUploadResponseSchema,
  "file-write-result": FileWriteResultSchema,
  "write-file-request": WriteFileRequestSchema,
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
      return errorFn(404, { success: false, error: { code: "not_found", message: "环境不存在" } });
    }
    throw e;
  }
}

// GET /:id/user — List directory
app.get(
  "/:id/user",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, query, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    const queryPath = (query as Record<string, string | undefined>)?.path || "";

    // 远程环境：通过 file-ws 代理
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      try {
        const entries = await remoteListDir(machineId, envId, queryPath);
        return { success: true as const, data: { entries } };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { success: false, error: { code: "remote_error", message } });
      }
    }

    const result = await resolveWorkspacePath(envId, queryPath);
    if (!result) return error(404, { success: false, error: { code: "not_found", message: "Environment not found" } });

    const { userDir, workspaceDir, resolved } = result;
    const info = await stat(resolved);
    if (!info.isDirectory())
      return error(400, { success: false, error: { code: "validation_error", message: "Not a directory" } });

    const items = await listDirectory(resolved, userDir, workspaceDir);
    return { success: true as const, data: { entries: items } };
  },
  {
    sessionAuth: true,
    response: {
      200: "file-list-response",
      400: WebErrSchema,
      404: WebErrSchema,
      503: WebErrSchema,
    },
    detail: {
      tags: ["Files"],
      summary: "获取目录列表",
      description: "返回指定环境工作区目录下的文件和目录列表，用于文件树浏览。",
    },
  },
);

// GET /:id/user/* — Read file
app.get(
  "/:id/user/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, query, error, set }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const rawFilePath = (params as any)["*"] as string;
    const preview = (query as Record<string, string | undefined>)?.preview === "true";

    // 远程环境：路由通配符不含 "user/" 前缀，需补全后发给远程节点
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      const filePath = normalizeUserRoutePath(rawFilePath);
      try {
        if (preview) {
          const binResult = await remoteReadBinaryFile(machineId, envId, filePath);
          const buffer = Buffer.from(binResult.data, "base64");
          set.headers["Content-Type"] = binResult.mimeType || "application/octet-stream";
          set.headers["Content-Security-Policy"] =
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
          return new Response(buffer);
        }
        // 非预览：先尝试文本，失败则走二进制下载
        try {
          const textResult = await remoteReadFile(machineId, envId, filePath);
          return {
            success: true as const,
            data: {
              name: textResult.name,
              path: textResult.path,
              content: textResult.content,
              size: textResult.size,
              encoding: "utf-8",
            },
          };
        } catch {
          const binResult = await remoteReadBinaryFile(machineId, envId, filePath);
          const buffer = Buffer.from(binResult.data, "base64");
          set.headers["Content-Disposition"] = `attachment; filename="${binResult.name}"`;
          set.headers["Content-Type"] = "application/octet-stream";
          return new Response(buffer);
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { success: false, error: { code: "remote_error", message } });
      }
    }

    const filePath = normalizeUserRoutePath(rawFilePath);
    const result = await resolveWorkspacePath(envId, filePath);
    if (!result) return error(404, { success: false, error: { code: "not_found", message: "Environment not found" } });

    const { resolved, displayPath } = result;
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(resolved);
    } catch {
      return error(404, { success: false, error: { code: "not_found", message: "File not found" } });
    }
    if (info.isDirectory())
      return error(400, {
        success: false,
        error: { code: "validation_error", message: "Path is a directory, use list endpoint" },
      });

    const lastDot = filePath.lastIndexOf(".");
    const lastSlash = filePath.lastIndexOf("/");
    const ext = lastDot > lastSlash ? filePath.substring(lastDot) : "";

    if (preview) {
      set.headers["Content-Type"] = getMimeType(ext);
      set.headers["Content-Security-Policy"] =
        "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
      // biome-ignore lint/suspicious/noExplicitAny: ReadableStream type mismatch with Response constructor
      return new Response(createFileStream(resolved) as any);
    }

    const textFile = isTextExtension(ext) || (!ext && (await isTextFile(resolved)));
    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);

    if (textFile) {
      const { content, size } = await readFileContent(resolved);
      return { success: true as const, data: { name: fileName, path: displayPath, content, size, encoding: "utf-8" } };
    }

    // 中文文件名需要用 RFC 5987 编码，否则 HTTP header 非法
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
    response: {
      200: "file-content",
      400: WebErrSchema,
      404: WebErrSchema,
      503: WebErrSchema,
    },
    detail: {
      tags: ["Files"],
      summary: "读取文件内容",
      description:
        "读取指定文件。文本文件默认返回 JSON 内容；当 preview=true 或目标为二进制文件时，接口会直接返回文件流而不是 JSON。",
    },
  },
);

// POST /:id/user/* — Upload files (支持文件夹上传，通过 relativePaths 字段传递相对路径)
app.post(
  "/:id/user/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, request, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const rawDirPath = ((params as any)["*"] as string) || "";

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0)
      return error(400, { success: false, error: { code: "validation_error", message: "No files provided" } });

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
      // 远程节点支持 workspace 全路径
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
        return { success: true as const, data: result };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { success: false, error: { code: "remote_error", message } });
      }
    }

    const dirPath = normalizeUserRoutePath(rawDirPath);
    if (!isUserPath(dirPath))
      return error(400, {
        success: false,
        error: { code: "validation_error", message: "Only user/ paths are writable" },
      });

    const result = await resolveWorkspacePath(envId, dirPath);
    if (!result) return error(404, { success: false, error: { code: "not_found", message: "Environment not found" } });

    const { resolved } = result;
    const { mkdir, writeFile: writeFileAsync } = await import("node:fs/promises");
    await mkdir(resolved, { recursive: true });

    const uploaded: Array<{ name: string; path: string; size: number }> = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const buffer = Buffer.from(await file.arrayBuffer());
      if (buffer.length > 100 * 1024 * 1024) {
        return error(413, {
          success: false,
          error: { code: "validation_error", message: `File ${file.name} exceeds 100MB limit` },
        });
      }

      // 如果有对应的相对路径，保留目录结构；否则直接用文件名
      const relPath = relativePaths[i] || file.name;
      const destPath = join(resolved, relPath);
      const destDir = dirname(destPath);
      await mkdir(destDir, { recursive: true });
      await writeFileAsync(destPath, buffer);

      uploaded.push({
        name: file.name,
        path: `user/${dirPath ? `${dirPath.replace(/^user\/?/, "")}/` : ""}${relPath}`.replace("user//", "user/"),
        size: buffer.length,
      });
    }
    return { success: true, data: { files: uploaded } };
  },
  {
    sessionAuth: true,
    response: {
      200: "file-upload-response",
      400: WebErrSchema,
      404: WebErrSchema,
      413: WebErrSchema,
      503: WebErrSchema,
    },
    detail: {
      tags: ["Files"],
      summary: "上传文件",
      description: "向指定环境目录上传一个或多个文件；支持通过 relativePaths 保留文件夹层级。",
    },
  },
);

// PUT /:id/user/* — Write file content
app.put(
  "/:id/user/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, body, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const rawFilePath = (params as any)["*"] as string;

    const b = body as { content?: string };
    if (typeof b.content !== "string")
      return error(400, { success: false, error: { code: "validation_error", message: "content field required" } });

    if (b.content.length > 100 * 1024 * 1024)
      return error(413, {
        success: false,
        error: { code: "validation_error", message: "Content exceeds 100MB limit" },
      });

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      // 远程节点支持 workspace 全路径，不强制 user/ 前缀
      try {
        const result = await remoteWriteFile(machineId, envId, rawFilePath, b.content);
        return { success: true as const, data: result };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { success: false, error: { code: "remote_error", message } });
      }
    }

    const filePath = normalizeUserRoutePath(rawFilePath);
    if (!isUserPath(filePath))
      return error(400, {
        success: false,
        error: { code: "validation_error", message: "Only user/ paths are writable" },
      });

    const result = await resolveWorkspacePath(envId, filePath);
    if (!result) return error(404, { success: false, error: { code: "not_found", message: "Environment not found" } });

    await writeFileContent(result.resolved, b.content);

    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
    const normalizedPath = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
    return {
      success: true as const,
      data: { name: fileName, path: normalizedPath, size: Buffer.byteLength(b.content) },
    };
  },
  {
    sessionAuth: true,
    body: "write-file-request",
    response: {
      200: "file-write-result",
      400: WebErrSchema,
      404: WebErrSchema,
      413: WebErrSchema,
      503: WebErrSchema,
    },
    detail: {
      tags: ["Files"],
      summary: "写入文件内容",
      description: "将文本内容写入指定文件；本地环境仅允许写入 user/ 目录，远程环境按远程节点能力处理。",
    },
  },
);

// DELETE /:id/user/* — Delete file
app.delete(
  "/:id/user/*",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 response schema + error 分支组合下类型推断不稳定
  async ({ store, params, error }: any) => {
    const authCtx = store.authContext!;
    const user = store.user!;
    const envId = params.id;
    await requireEnv(envId, authCtx.organizationId, user.id, error);
    // biome-ignore lint/suspicious/noExplicitAny: Elysia splat param not typed
    const rawFilePath = (params as any)["*"] as string;

    // 远程环境
    const machineId = await getRemoteMachineId(envId);
    if (machineId) {
      // 远程节点支持 workspace 全路径
      try {
        await remoteDeleteFile(machineId, envId, rawFilePath);
        return { success: true as const, data: null };
      } catch (e) {
        const message = e instanceof Error ? e.message : "Remote file operation failed";
        return error(503, { success: false, error: { code: "remote_error", message } });
      }
    }

    const filePath = normalizeUserRoutePath(rawFilePath);
    if (!isUserPath(filePath))
      return error(400, {
        success: false,
        error: { code: "validation_error", message: "Only user/ paths are writable" },
      });

    const result = await resolveWorkspacePath(envId, filePath);
    if (!result) return error(404, { success: false, error: { code: "not_found", message: "Environment not found" } });

    try {
      const info = await stat(result.resolved);
      if (info.isDirectory()) {
        await deleteNode(result.resolved);
        return { success: true as const, data: null };
      }
    } catch {
      return error(404, { success: false, error: { code: "not_found", message: "File not found" } });
    }

    await deleteFile(result.resolved);
    return { success: true as const, data: null };
  },
  {
    sessionAuth: true,
    response: {
      200: "delete-file-response",
      400: WebErrSchema,
      404: WebErrSchema,
      503: WebErrSchema,
    },
    detail: {
      tags: ["Files"],
      summary: "删除文件",
      description: "删除 workspace 任意路径的文件或目录（目录将递归删除）。",
    },
  },
);

export default app;
