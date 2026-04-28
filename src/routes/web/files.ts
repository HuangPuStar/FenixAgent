import { Hono } from "hono";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { sessionAuth } from "../../auth/middleware";
import { storeGetEnvironment, storeGetSession, storeListEnvironmentsByUserId } from "../../store";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".json", ".yaml", ".yml", ".ts", ".js", ".tsx", ".jsx",
  ".py", ".go", ".rs", ".css", ".html", ".xml", ".toml", ".ini", ".cfg",
  ".sh", ".bash", ".zsh", ".sql", ".env",
]);

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".sh": "text/plain",
  ".bash": "text/plain",
  ".zsh": "text/plain",
  ".sql": "text/plain",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

type ResolvedWorkspacePath = {
  workspaceDir: string;
  userDir: string;
  resolved: string;
  displayPath: string;
};

function isUserPath(path: string): boolean {
  return path === "" || path === "user" || path.startsWith("user/");
}

function normalizeUserRoutePath(path: string): string {
  const normalized = path.trim();
  if (!normalized) {
    return "user";
  }
  if (normalized === "user" || normalized.startsWith("user/")) {
    return normalized;
  }
  if (normalized.startsWith(".")) {
    return normalized;
  }
  return `user/${normalized}`;
}

async function resolveWorkspacePath(
  sessionId: string,
  relativePath: string,
  userId?: string,
): Promise<ResolvedWorkspacePath | null> {
  const session = storeGetSession(sessionId);
  let envId = session?.environmentId;

  if (!envId && userId) {
    const environments = storeListEnvironmentsByUserId(userId);
    if (environments.length > 0) {
      envId = environments[0].id;
    }
  }

  if (!envId) {
    return null;
  }

  const env = storeGetEnvironment(envId);
  if (!env) {
    return null;
  }

  const workspaceDir = env.workspacePath;
  const userDir = join(workspaceDir, "user");
  await mkdir(userDir, { recursive: true });

  const normalizedInput = relativePath.trim();
  const userScoped = isUserPath(normalizedInput);
  const baseDir = userScoped ? userDir : workspaceDir;

  let cleanPath = normalizedInput;
  if (userScoped) {
    if (cleanPath.startsWith("user/")) {
      cleanPath = cleanPath.slice(5);
    } else if (cleanPath === "user") {
      cleanPath = "";
    }
  }

  const resolved = resolve(baseDir, cleanPath);
  if (!resolved.startsWith(`${baseDir}/`) && resolved !== baseDir) {
    return null;
  }

  const relativeToBase = relative(baseDir, resolved);
  const displayPath = userScoped
    ? (relativeToBase ? `user/${relativeToBase}` : "user")
    : (relativeToBase || ".");

  return { workspaceDir, userDir, resolved, displayPath };
}

async function isTextFile(filePath: string): Promise<boolean> {
  try {
    const buffer = Buffer.alloc(8192);
    const file = await open(filePath, "r");
    const { bytesRead } = await file.read(buffer, 0, 8192, 0);
    await file.close();
    return !buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  }
}

function shouldHideWorkspaceEntry(entryPath: string, userDir: string): boolean {
  const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
  if (inUserDir) {
    return false;
  }

  return entryPath.endsWith("/.opencode") || entryPath.endsWith("/.opencode/");
}

const app = new Hono();

app.get("/:sessionId/user", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId")!;
  const queryPath = c.req.query("path") || "";
  const result = await resolveWorkspacePath(sessionId, queryPath, user.id);
  if (!result) return c.json({ error: { type: "not_found", message: "Session or environment not found" } }, 404);

  const { userDir, workspaceDir, resolved } = result;
  const info = await stat(resolved);
  if (!info.isDirectory()) return c.json({ error: { type: "validation_error", message: "Not a directory" } }, 400);

  const entries = await readdir(resolved, { withFileTypes: true });
  const visibleEntries = entries.filter((entry) => !shouldHideWorkspaceEntry(join(resolved, entry.name), userDir));
  const items = await Promise.all(visibleEntries.map(async (entry) => {
    const entryPath = join(resolved, entry.name);
    const statInfo = await stat(entryPath);
    const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
    const relPath = relative(inUserDir ? userDir : workspaceDir, entryPath);
    const path = inUserDir
      ? (entry.isDirectory() ? `user/${relPath}/` : `user/${relPath}`)
      : (entry.isDirectory() ? `${relPath}/` : relPath);

    return {
      name: entry.name,
      path,
      type: entry.isDirectory() ? "dir" : "file",
      size: entry.isFile() ? statInfo.size : 0,
      modifiedAt: statInfo.mtimeMs,
    };
  }));
  return c.json({ entries: items });
});

app.get("/:sessionId/user/:filePath{.+}", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId")!;
  const filePath = normalizeUserRoutePath(c.req.param("filePath")!);
  const preview = c.req.query("preview") === "true";

  const result = await resolveWorkspacePath(sessionId, filePath, user.id);
  if (!result) return c.json({ error: { type: "not_found", message: "Session or environment not found" } }, 404);

  const { resolved, displayPath } = result;
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return c.json({ error: { type: "not_found", message: "File not found" } }, 404);
  }
  if (info.isDirectory()) return c.json({ error: { type: "validation_error", message: "Path is a directory, use list endpoint" } }, 400);

  const lastDot = filePath.lastIndexOf(".");
  const lastSlash = filePath.lastIndexOf("/");
  const ext = lastDot > lastSlash ? filePath.substring(lastDot) : "";

  if (preview) {
    const mimeType = MIME_TYPES[ext] || "application/octet-stream";
    c.header("Content-Type", mimeType);
    c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    return c.body(createReadStream(resolved) as any);
  }

  const textFile = TEXT_EXTENSIONS.has(ext) || (!ext && await isTextFile(resolved));
  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);

  if (textFile) {
    const content = await readFile(resolved, "utf-8");
    return c.json({ name: fileName, path: displayPath, content, size: info.size, encoding: "utf-8" });
  }

  c.header("Content-Disposition", `attachment; filename="${fileName}"`);
  c.header("Content-Type", "application/octet-stream");
  return c.body(createReadStream(resolved) as any);
});

app.post("/:sessionId/user/:dirPath{.*}", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId")!;
  const dirPath = normalizeUserRoutePath(c.req.param("dirPath") || "");

  if (!isUserPath(dirPath)) {
    return c.json({ error: { type: "validation_error", message: "Only user/ paths are writable" } }, 400);
  }

  const result = await resolveWorkspacePath(sessionId, dirPath, user.id);
  if (!result) return c.json({ error: { type: "not_found", message: "Session or environment not found" } }, 404);

  const { resolved } = result;
  await mkdir(resolved, { recursive: true });

  const formData = await c.req.formData();
  const files = formData.getAll("files") as File[];
  if (!files || files.length === 0) return c.json({ error: { type: "validation_error", message: "No files provided" } }, 400);

  const uploaded: Array<{ name: string; path: string; size: number }> = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > 50 * 1024 * 1024) {
      return c.json({ error: { type: "validation_error", message: `File ${file.name} exceeds 50MB limit` } }, 413);
    }
    const destPath = join(resolved, file.name);
    await writeFile(destPath, buffer);
    uploaded.push({ name: file.name, path: `user/${dirPath ? `${dirPath.replace(/^user\/?/, "")}/` : ""}${file.name}`.replace("user//", "user/"), size: buffer.length });
  }
  return c.json({ files: uploaded });
});

app.put("/:sessionId/user/:filePath{.+}", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId")!;
  const filePath = normalizeUserRoutePath(c.req.param("filePath")!);

  if (!isUserPath(filePath)) {
    return c.json({ error: { type: "validation_error", message: "Only user/ paths are writable" } }, 400);
  }

  const body = await c.req.json();
  if (typeof body.content !== "string") return c.json({ error: { type: "validation_error", message: "content field required" } }, 400);

  if (body.content.length > 100 * 1024 * 1024) {
    return c.json({ error: { type: "validation_error", message: "Content exceeds 100MB limit" } }, 413);
  }

  const result = await resolveWorkspacePath(sessionId, filePath, user.id);
  if (!result) return c.json({ error: { type: "not_found", message: "Session or environment not found" } }, 404);

  const { resolved } = result;
  await mkdir(resolve(resolved, ".."), { recursive: true });
  await writeFile(resolved, body.content, "utf-8");

  const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
  const normalizedPath = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
  return c.json({ name: fileName, path: normalizedPath, size: Buffer.byteLength(body.content) });
});

app.delete("/:sessionId/user/:filePath{.+}", sessionAuth, async (c) => {
  const user = c.get("user")!;
  const sessionId = c.req.param("sessionId")!;
  const filePath = normalizeUserRoutePath(c.req.param("filePath")!);

  if (!isUserPath(filePath)) {
    return c.json({ error: { type: "validation_error", message: "Only user/ paths are writable" } }, 400);
  }

  const result = await resolveWorkspacePath(sessionId, filePath, user.id);
  if (!result) return c.json({ error: { type: "not_found", message: "Session or environment not found" } }, 404);

  const { resolved } = result;
  let info;
  try {
    info = await stat(resolved);
  } catch {
    return c.json({ error: { type: "not_found", message: "File not found" } }, 404);
  }
  if (info.isDirectory()) return c.json({ error: { type: "validation_error", message: "Cannot delete directories" } }, 400);

  await unlink(resolved);
  return c.json({ ok: true });
});

export default app;
