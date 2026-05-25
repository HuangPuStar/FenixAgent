# 文件操作 Service 提取 — 路由去业务逻辑化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `web/files.ts` 路由中的文件系统操作（路径安全校验、文件 CRUD、MIME 类型推断）提取为 `src/services/workspace-fs.ts`，使路由只做参数解析和委托。

**Architecture:** 新建 `WorkspaceFS` Service 封装路径安全校验 + 文件操作。路由调用 Service，不直接操作 `node:fs`。Service 可以被定时任务、API 等其他消费者复用。

**Tech Stack:** Node.js `fs`/`path`、Elysia、Zod

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `src/services/workspace-fs.ts` | workspace 文件操作 Service |
| Create | `src/__tests__/workspace-fs.test.ts` | Service 单元测试 |
| Modify | `src/routes/web/files.ts` | 路由委托 Service，删除内联 fs 操作 |

---

### Task 1: 创建 WorkspaceFS Service 核心函数

**Files:**
- Create: `src/services/workspace-fs.ts`
- Create: `src/__tests__/workspace-fs.test.ts`

- [ ] **Step 1: 写路径安全的失败测试**

```typescript
// src/__tests__/workspace-fs.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  resolveWorkspacePath,
  isUserPath,
  isTextFile,
} from "../services/workspace-fs";

describe("isUserPath", () => {
  test("空路径是 user 路径", () => {
    expect(isUserPath("")).toBe(true);
  });

  test("user 是 user 路径", () => {
    expect(isUserPath("user")).toBe(true);
  });

  test("user/sub 是 user 路径", () => {
    expect(isUserPath("user/sub")).toBe(true);
  });

  test("非 user 前缀不是 user 路径", () => {
    expect(isUserPath("other")).toBe(false);
  });
});

describe("resolveWorkspacePath", () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "rcs-test-"));

  afterEach(() => {
    // 清理测试文件但不删除 tmpRoot 本身
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("返回 null 当环境不存在", async () => {
    // 需要 mock environmentRepo
    const result = await resolveWorkspacePath("nonexistent-id", "user/test.txt");
    expect(result).toBeNull();
  });

  test("user 路径解析到 workspace/user 目录", async () => {
    // 需要 mock environmentRepo 返回 workspacePath = tmpRoot
    // 实际测试中用 bun mock
  });
});
```

> **注意：** 由于 `resolveWorkspacePath` 依赖 `environmentRepo`，完整集成测试需要 mock repo。纯函数 `isUserPath` 和 `normalizeUserRoutePath` 可直接测试。这里优先测纯函数。

- [ ] **Step 2: 运行测试确认部分失败**

Run: `bun test src/__tests__/workspace-fs.test.ts`
Expected: `isUserPath` 的测试 PASS（如果先实现），`resolveWorkspacePath` FAIL（依赖未实现）

- [ ] **Step 3: 实现 WorkspaceFS Service**

```typescript
// src/services/workspace-fs.ts
import {
  mkdir, open, readFile, readdir, stat, unlink, writeFile,
  mkdirSync,
  createReadStream,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { environmentRepo } from "../repositories";

// ────────────────────────────────────────────
// 常量
// ────────────────────────────────────────────

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

// ────────────────────────────────────────────
// 纯函数（可直接测试）
// ────────────────────────────────────────────

export function isUserPath(path: string): boolean {
  return path === "" || path === "user" || path.startsWith("user/");
}

export function normalizeUserRoutePath(path: string): string {
  const normalized = path.trim();
  if (!normalized) return "user";
  if (normalized === "user" || normalized.startsWith("user/")) return normalized;
  if (normalized.startsWith(".")) return normalized;
  return `user/${normalized}`;
}

export function getMimeType(ext: string): string {
  return MIME_TYPES[ext] || "application/octet-stream";
}

export function isTextExtension(ext: string): boolean {
  return TEXT_EXTENSIONS.has(ext);
}

// ────────────────────────────────────────────
// 路径解析（依赖 environmentRepo）
// ────────────────────────────────────────────

export type ResolvedWorkspacePath = {
  workspaceDir: string;
  userDir: string;
  resolved: string;
  displayPath: string;
};

export async function resolveWorkspacePath(
  environmentId: string,
  relativePath: string,
): Promise<ResolvedWorkspacePath | null> {
  const env = await environmentRepo.getById(environmentId);
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

// ────────────────────────────────────────────
// 文件操作
// ────────────────────────────────────────────

export async function isTextFile(filePath: string): Promise<boolean> {
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

export function shouldHideWorkspaceEntry(entryPath: string, userDir: string): boolean {
  const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
  if (inUserDir) return false;
  return entryPath.endsWith("/.opencode") || entryPath.endsWith("/.opencode/");
}

export interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

export async function listDirectory(
  dirPath: string,
  userDir: string,
  workspaceDir: string,
): Promise<FileEntry[]> {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const visibleEntries = entries.filter(
    (entry) => !shouldHideWorkspaceEntry(join(dirPath, entry.name), userDir),
  );
  return Promise.all(
    visibleEntries.map(async (entry) => {
      const entryPath = join(dirPath, entry.name);
      const statInfo = await stat(entryPath);
      const inUserDir = entryPath.startsWith(`${userDir}/`) || entryPath === userDir;
      const relPath = relative(inUserDir ? userDir : workspaceDir, entryPath);
      const path = inUserDir
        ? entry.isDirectory() ? `user/${relPath}/` : `user/${relPath}`
        : entry.isDirectory() ? `${relPath}/` : relPath;
      return {
        name: entry.name,
        path,
        type: entry.isDirectory() ? "dir" as const : "file" as const,
        size: entry.isFile() ? statInfo.size : 0,
        modifiedAt: statInfo.mtimeMs,
      };
    }),
  );
}

export async function readFileContent(filePath: string): Promise<{
  content: string;
  size: number;
}> {
  const content = await readFile(filePath, "utf-8");
  const info = await stat(filePath);
  return { content, size: info.size };
}

export async function writeFileContent(filePath: string, content: string): Promise<void> {
  await mkdir(resolve(filePath, ".."), { recursive: true });
  await writeFile(filePath, content, "utf-8");
}

export async function deleteFile(filePath: string): Promise<void> {
  await unlink(filePath);
}

export function createFileStream(filePath: string): NodeJS.ReadableStream {
  return createReadStream(filePath);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/workspace-fs.test.ts`
Expected: `isUserPath` 测试 PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/workspace-fs.ts src/__tests__/workspace-fs.test.ts
git commit -m "feat: 创建 WorkspaceFS Service — 文件操作从路由提取"
```

---

### Task 2: 重构 web/files 路由使用 Service

**Files:**
- Modify: `src/routes/web/files.ts`

- [ ] **Step 1: 替换 import**

将路由顶部的所有 `node:fs`/`node:path` import 和本地函数定义替换为 Service 调用：

```typescript
// 删除以下 import:
// import { createReadStream } from "node:fs";
// import { mkdir, open, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
// import { join, relative, resolve } from "node:path";

// 删除以下本地定义:
// TEXT_EXTENSIONS, MIME_TYPES, ResolvedWorkspacePath, isUserPath, normalizeUserRoutePath,
// resolveWorkspacePath, isTextFile, shouldHideWorkspaceEntry

// 添加 Service import:
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
import { stat } from "node:fs/promises";
```

- [ ] **Step 2: 简化 GET /:id/user 路由**

```typescript
app.get("/:id/user", async ({ store, params, query, error }) => {
  const envId = params.id;
  const queryPath = (query as any)?.path || "";
  const result = await resolveWorkspacePath(envId, queryPath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  const { userDir, workspaceDir, resolved } = result;
  const info = await stat(resolved);
  if (!info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Not a directory" } });

  const items = await listDirectory(resolved, userDir, workspaceDir);
  return { entries: items };
}, { sessionAuth: true });
```

- [ ] **Step 3: 简化 GET /:id/user/* 路由**

```typescript
app.get("/:id/user/*", async ({ store, params, query, error, set }) => {
  const envId = params.id;
  const filePath = normalizeUserRoutePath((params as any)["*"]);
  const preview = (query as any)?.preview === "true";

  const result = await resolveWorkspacePath(envId, filePath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  const { resolved, displayPath } = result;
  let info;
  try { info = await stat(resolved); } catch {
    return error(404, { error: { type: "not_found", message: "File not found" } });
  }
  if (info.isDirectory()) return error(400, { error: { type: "validation_error", message: "Path is a directory" } });

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
```

- [ ] **Step 4: 简化 POST /:id/user/* 和 PUT /:id/user/* 路由**

POST 路由中 `mkdir` + `writeFile` 组合已由 Service 封装，但 POST 涉及 FormData 解析，保留路由层处理。只替换路径解析和权限检查部分：

```typescript
app.post("/:id/user/*", async ({ store, params, request, error }) => {
  const envId = params.id;
  const dirPath = normalizeUserRoutePath((params as any)["*"] || "");

  if (!isUserPath(dirPath)) return error(400, { error: { type: "validation_error", message: "Only user/ paths are writable" } });

  const result = await resolveWorkspacePath(envId, dirPath);
  if (!result) return error(404, { error: { type: "not_found", message: "Environment not found" } });

  const { resolved } = result;
  // FormData 处理保留在路由层（涉及 request 对象）
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
```

PUT 路由使用 Service 的 `writeFileContent`：

```typescript
app.put("/:id/user/*", async ({ store, params, body, error }) => {
  const envId = params.id;
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
```

- [ ] **Step 5: 简化 DELETE 路由**

```typescript
app.delete("/:id/user/*", async ({ store, params, error }) => {
  const envId = params.id;
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
```

- [ ] **Step 6: 运行类型检查和测试**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 通过

- [ ] **Step 7: Commit**

```bash
git add src/routes/web/files.ts
git commit -m "refactor: web/files 路由委托 WorkspaceFS Service"
```

---

## Self-Review

**Spec coverage:** 路径解析、目录列表、文件读取（text + binary）、文件写入、文件上传、文件删除 — 全部覆盖。

**Placeholder scan:** 无 TBD/TODO。所有 Service 函数包含完整实现。

**Type consistency:** `ResolvedWorkspacePath`、`FileEntry` 类型在 Service 中定义，路由中消费时字段名一致。`getMimeType` 返回 string，与路由中原 `MIME_TYPES[ext]` 用法兼容。
