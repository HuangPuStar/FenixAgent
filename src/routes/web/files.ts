import Elysia from "elysia";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { authGuardPlugin } from "../../plugins/auth";
import {
  isUserPath,
  normalizeUserRoutePath,
  resolveWorkspacePath,
  isTextFile,
  isTextExtension,
  getMimeType,
  listDirectory,
  readFileContent,
  writeFileContent,
  deleteFile,
  createFileStream,
} from "../../services/workspace-fs";
import { getOwnedEnvironment } from "../../services/environment-core";
import { NotFoundError } from "../../errors";
import {
  FileListResponseSchema,
  FileContentSchema,
  FileUploadResponseSchema,
  FileWriteResultSchema,
  WriteFileRequestSchema,
} from "../../schemas/file.schema";
import { loadTeamContext } from "../../services/team-context";

const app = new Elysia({ name: "web-files", prefix: "/web/environments" })
  .use(authGuardPlugin)
  .model({
    "file-list-response": FileListResponseSchema,
    "file-content": FileContentSchema,
    "file-upload-response": FileUploadResponseSchema,
    "file-write-result": FileWriteResultSchema,
    "write-file-request": WriteFileRequestSchema,
  });

async function requireEnv(envId: string, teamId: string, errorFn: (status: number, body: unknown) => any) {
  try {
    return await getOwnedEnvironment(envId, teamId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return errorFn(404, { error: { type: "not_found", message: "环境不存在" } });
    }
    throw e;
  }
}

// GET /:id/user — List directory
app.get("/:id/user", async ({ store, params, query, error, request }) => {
  const authCtx = (await loadTeamContext(store.user!, request))!;
  const envId = params.id;
  await requireEnv(envId, authCtx.teamId, error);
  const queryPath = (query as any)?.path || "";
  const result = await resolveWorkspacePath(envId, queryPath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  const { userDir, workspaceDir, resolved } = result;
  const info = await stat(resolved);
  if (!info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Not a directory" } });

  const items = await listDirectory(resolved, userDir, workspaceDir);
  return { entries: items };
}, { sessionAuth: true });

// GET /:id/user/* — Read file
app.get("/:id/user/*", async ({ store, params, query, error, set, request }) => {
  const authCtx = (await loadTeamContext(store.user!, request))!;
  const envId = params.id;
  await requireEnv(envId, authCtx.teamId, error);
  const filePath = normalizeUserRoutePath((params as any)["*"]);
  const preview = (query as any)?.preview === "true";

  const result = await resolveWorkspacePath(envId, filePath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  const { resolved, displayPath } = result;
  let info;
  try { info = await stat(resolved); } catch {
    return error(404, { error: { type: "not_found", message: "File not found" } });
  }
  if (info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Path is a directory, use list endpoint" } });

  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = filePath.lastIndexOf("/");
  const ext = lastDot > lastSlash ? filePath.substring(lastDot) : "";

  if (preview) {
    set.headers["Content-Type"] = getMimeType(ext);
    set.headers["Content-Security-Policy"] =
      "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
    return new Response(createFileStream(resolved) as any);
  }

  const textFile = isTextExtension(ext) || (!ext && (await isTextFile(resolved)));
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);

  if (textFile) {
    const { content, size } = await readFileContent(resolved);
    return { name: fileName, path: displayPath, content, size, encoding: "utf-8" };
  }

  set.headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
  set.headers["Content-Type"] = "application/octet-stream";
  return new Response(createFileStream(resolved) as any);
}, { sessionAuth: true });

// POST /:id/user/* — Upload files
app.post("/:id/user/*", async ({ store, params, request, error }) => {
  const authCtx = (await loadTeamContext(store.user!, request))!;
  const envId = params.id;
  await requireEnv(envId, authCtx.teamId, error);
  const dirPath = normalizeUserRoutePath((params as any)["*"] || "");

  if (!isUserPath(dirPath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

  const result = await resolveWorkspacePath(envId, dirPath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  const { resolved } = result;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(resolved, { recursive: true });

  const formData = await request.formData();
  const files = formData.getAll("files") as File[];
  if (!files || files.length === 0)
    return error(400, { error: { type: "validation_error", message: "No files provided" } });

  const uploaded: Array<{ name: string; path: string; size: number }> = [];
  const { writeFile: writeFileAsync } = await import("node:fs/promises");
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > 50 * 1024 * 1024) {
      return error(413, { error: { type: "validation_error", message: `File ${file.name} exceeds 50MB limit` } });
    }
    const destPath = join(resolved, file.name);
    await writeFileAsync(destPath, buffer);
    uploaded.push({
      name: file.name,
      path: `user/${dirPath ? `${dirPath.replace(/^user\/?/, "")}/` : ""}${file.name}`.replace("user//", "user/"),
      size: buffer.length,
    });
  }
  return { files: uploaded };
}, { sessionAuth: true });

// PUT /:id/user/* — Write file content
app.put("/:id/user/*", async ({ store, params, body, error, request }) => {
  const authCtx = (await loadTeamContext(store.user!, request))!;
  const envId = params.id;
  await requireEnv(envId, authCtx.teamId, error);
  const filePath = normalizeUserRoutePath((params as any)["*"]);

  if (!isUserPath(filePath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

  const b = body as { content?: string };
  if (typeof b.content !== "string")
    return error(400, { error: { type: "validation_error", message: "content field required" } });

  if (b.content.length > 100 * 1024 * 1024)
    return error(413, { error: { type: "validation_error", message: "Content exceeds 100MB limit" } });

  const result = await resolveWorkspacePath(envId, filePath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  await writeFileContent(result.resolved, b.content);

  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  const normalizedPath = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
  return { name: fileName, path: normalizedPath, size: Buffer.byteLength(b.content) };
}, { sessionAuth: true, body: "write-file-request" });

// DELETE /:id/user/* — Delete file
app.delete("/:id/user/*", async ({ store, params, error, request }) => {
  const authCtx = (await loadTeamContext(store.user!, request))!;
  const envId = params.id;
  await requireEnv(envId, authCtx.teamId, error);
  const filePath = normalizeUserRoutePath((params as any)["*"]);

  if (!isUserPath(filePath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

  const result = await resolveWorkspacePath(envId, filePath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  try {
    const info = await stat(result.resolved);
    if (info.isDirectory())
      return error(400, { error: { type: "validation_error", message: "Cannot delete directories" } });
  } catch {
    return error(404, { error: { type: "not_found", message: "File not found" } });
  }

  await deleteFile(result.resolved);
  return { ok: true as const };
}, { sessionAuth: true });

export default app;
