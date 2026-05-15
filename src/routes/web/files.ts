import Elysia from "elysia";
import { createReadStream } from "node:fs";
import {
    mkdir,
    open,
    readFile,
    readdir,
    stat,
    unlink,
    writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { authGuardPlugin } from "../../plugins/auth";
import { environmentRepo, sessionRepo } from "../../repositories";
import { resolveExistingSessionId } from "../../services/session";
import {
    FileListResponseSchema,
    FileContentSchema,
    FileUploadResponseSchema,
    FileWriteResultSchema,
    WriteFileRequestSchema,
} from "../../schemas/file.schema";

const TEXT_EXTENSIONS = new Set([
    ".txt", ".md", ".json", ".yaml", ".yml", ".ts", ".js", ".tsx", ".jsx",
    ".py", ".go", ".rs", ".css", ".html", ".xml", ".toml", ".ini", ".cfg",
    ".sh", ".bash", ".zsh", ".sql", ".env",
]);

const MIME_TYPES: Record<string, string> = {
    ".html": "text/html", ".htm": "text/html", ".css": "text/css",
    ".js": "text/javascript", ".ts": "text/typescript", ".tsx": "text/typescript",
    ".jsx": "text/javascript", ".json": "application/json", ".xml": "application/xml",
    ".txt": "text/plain", ".md": "text/plain", ".yaml": "text/plain", ".yml": "text/plain",
    ".py": "text/plain", ".go": "text/plain", ".rs": "text/plain", ".sh": "text/plain",
    ".bash": "text/plain", ".zsh": "text/plain", ".sql": "text/plain", ".csv": "text/csv",
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp", ".ico": "image/x-icon",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mp3": "audio/mpeg", ".wav": "audio/wav",
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
    if (!normalized) return "user";
    if (normalized === "user" || normalized.startsWith("user/")) return normalized;
    if (normalized.startsWith(".")) return normalized;
    return `user/${normalized}`;
}

async function resolveWorkspacePath(
    sessionId: string,
    relativePath: string,
): Promise<ResolvedWorkspacePath | null> {
    const internalId = await resolveExistingSessionId(sessionId);
    const session = internalId ? await sessionRepo.getById(internalId) : undefined;
    const envId = session?.environmentId;
    if (!envId) return null;
    const env = await environmentRepo.getById(envId);
    if (!env) return null;

    const workspaceDir = env.workspacePath;
    const userDir = join(workspaceDir, "user");
    await mkdir(userDir, { recursive: true });

    const normalizedInput = relativePath.trim();
    const userScoped = isUserPath(normalizedInput);
    const baseDir = userScoped ? userDir : workspaceDir;

    let cleanPath = normalizedInput;
    if (userScoped) {
        if (cleanPath.startsWith("user/")) cleanPath = cleanPath.slice(5);
        else if (cleanPath === "user") cleanPath = "";
    }

    const resolved = resolve(baseDir, cleanPath);
    if (!resolved.startsWith(`${baseDir}/`) && resolved !== baseDir) return null;

    const relativeToBase = relative(baseDir, resolved);
    const displayPath = userScoped
        ? relativeToBase ? `user/${relativeToBase}` : "user"
        : relativeToBase || ".";

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
    if (inUserDir) return false;
    return entryPath.endsWith("/.opencode") || entryPath.endsWith("/.opencode/");
}

const app = new Elysia({ name: "web-files", prefix: "/web/sessions" })
  .use(authGuardPlugin)
  .model({
    "file-list-response": FileListResponseSchema,
    "file-content": FileContentSchema,
    "file-upload-response": FileUploadResponseSchema,
    "file-write-result": FileWriteResultSchema,
    "write-file-request": WriteFileRequestSchema,
  });

app.get("/:id/user", async ({ store, params, query, error }) => {
    const sessionId = params.id;
    const queryPath = (query as any)?.path || "";
    const result = await resolveWorkspacePath(sessionId, queryPath);
    if (!result) return error(404, { error: { type: "not_found", message: "Session or environment not found" } });

    const { userDir, workspaceDir, resolved } = result;
    const info = await stat(resolved);
    if (!info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Not a directory" } });

    const entries = await readdir(resolved, { withFileTypes: true });
    const visibleEntries = entries.filter(
        (entry) => !shouldHideWorkspaceEntry(join(resolved, entry.name), userDir),
    );
    const items = await Promise.all(
        visibleEntries.map(async (entry) => {
            const entryPath = join(resolved, entry.name);
            const statInfo = await stat(entryPath);
            const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
            const relPath = relative(inUserDir ? userDir : workspaceDir, entryPath);
            const path = inUserDir
                ? entry.isDirectory() ? `user/${relPath}/` : `user/${relPath}`
                : entry.isDirectory() ? `${relPath}/` : relPath;
            return {
                name: entry.name,
                path,
                type: entry.isDirectory() ? "dir" : "file",
                size: entry.isFile() ? statInfo.size : 0,
                modifiedAt: statInfo.mtimeMs,
            };
        }),
    );
    return { entries: items };
}, { sessionAuth: true });

app.get("/:id/user/*", async ({ store, params, query, error, set }) => {
    const sessionId = params.id;
    const filePath = normalizeUserRoutePath((params as any)["*"]);
    const preview = (query as any)?.preview === "true";

    const result = await resolveWorkspacePath(sessionId, filePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Session or environment not found" } });

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
        const mimeType = MIME_TYPES[ext] || "application/octet-stream";
        set.headers["Content-Type"] = mimeType;
        set.headers["Content-Security-Policy"] =
            "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:; script-src * 'unsafe-inline' 'unsafe-eval' blob:; style-src * 'unsafe-inline'; img-src * data: blob:; font-src * data:; media-src * blob:; connect-src *";
        return new Response(createReadStream(resolved) as any);
    }

    const textFile = TEXT_EXTENSIONS.has(ext) || (!ext && (await isTextFile(resolved)));
    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);

    if (textFile) {
        const content = await readFile(resolved, "utf-8");
        return { name: fileName, path: displayPath, content, size: info.size, encoding: "utf-8" };
    }

    set.headers["Content-Disposition"] = `attachment; filename="${fileName}"`;
    set.headers["Content-Type"] = "application/octet-stream";
    return new Response(createReadStream(resolved) as any);
}, { sessionAuth: true });

app.post("/:id/user/*", async ({ store, params, request, error }) => {
    const sessionId = params.id;
    const dirPath = normalizeUserRoutePath((params as any)["*"] || "");

    if (!isUserPath(dirPath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

    const result = await resolveWorkspacePath(sessionId, dirPath);
    if (!result) return error(404, { error: { type: "not_found", message: "Session or environment not found" } });

    const { resolved } = result;
    await mkdir(resolved, { recursive: true });

    const formData = await request.formData();
    const files = formData.getAll("files") as File[];
    if (!files || files.length === 0)
        return error(400, { error: { type: "validation_error", message: "No files provided" } });

    const uploaded: Array<{ name: string; path: string; size: number }> = [];
    for (const file of files) {
        const buffer = Buffer.from(await file.arrayBuffer());
        if (buffer.length > 50 * 1024 * 1024) {
            return error(413, { error: { type: "validation_error", message: `File ${file.name} exceeds 50MB limit` } });
        }
        const destPath = join(resolved, file.name);
        await writeFile(destPath, buffer);
        uploaded.push({
            name: file.name,
            path: `user/${dirPath ? `${dirPath.replace(/^user\/?/, "")}/` : ""}${file.name}`.replace("user//", "user/"),
            size: buffer.length,
        });
    }
    return { files: uploaded };
}, { sessionAuth: true });

app.put("/:id/user/*", async ({ store, params, body, error }) => {
    const sessionId = params.id;
    const filePath = normalizeUserRoutePath((params as any)["*"]);

    if (!isUserPath(filePath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

    const b = body as { content?: string };
    if (typeof b.content !== "string")
        return error(400, { error: { type: "validation_error", message: "content field required" } });

    if (b.content.length > 100 * 1024 * 1024)
        return error(413, { error: { type: "validation_error", message: "Content exceeds 100MB limit" } });

    const result = await resolveWorkspacePath(sessionId, filePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Session or environment not found" } });

    const { resolved } = result;
    await mkdir(resolve(resolved, ".."), { recursive: true });
    await writeFile(resolved, b.content, "utf-8");

    const fileName = filePath.substring(filePath.lastIndexOf("/") + 1);
    const normalizedPath = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
    return { name: fileName, path: normalizedPath, size: Buffer.byteLength(b.content) };
}, { sessionAuth: true, body: "write-file-request" });

app.delete("/:id/user/*", async ({ store, params, error }) => {
    const sessionId = params.id;
    const filePath = normalizeUserRoutePath((params as any)["*"]);

    if (!isUserPath(filePath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

    const result = await resolveWorkspacePath(sessionId, filePath);
    if (!result) return error(404, { error: { type: "not_found", message: "Session or environment not found" } });

    const { resolved } = result;
    let info;
    try { info = await stat(resolved); } catch {
        return error(404, { error: { type: "not_found", message: "File not found" } });
    }
    if (info.isDirectory())
        return error(400, { error: { type: "validation_error", message: "Cannot delete directories" } });

    await unlink(resolved);
    return { ok: true as const };
}, { sessionAuth: true });

export default app;
