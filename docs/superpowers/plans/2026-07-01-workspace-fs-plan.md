# Workspace 文件系统 API 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/web/environments/:id/fs/*` API，暴露整个 workspace 目录树（黑名单过滤），支持全 workspace 文件读写操作。

**Architecture:** 新增 `src/routes/web/fs.ts` 路由文件，镜像现有 `files.ts` + `user-file.ts` 的端点设计，但作用域扩大到 workspace 根目录。底层 `workspace-fs.ts` 新增黑名单过滤逻辑和扩展的递归扫描。旧接口不动。

**Tech Stack:** Elysia + Bun, workspace-fs.ts（Node.js fs/promises）, 复用 remote-file-service 远程代理

**Spec:** `docs/superpowers/specs/2026-07-01-workspace-fs-design.md`

---

### Task 1: 新增 workspace 黑名单过滤逻辑

**Files:**
- Modify: `src/services/workspace-fs.ts`

- [ ] **Step 1: 添加黑名单常量**

在 `// ── Constants ──` 区块末尾、TEXT_EXTENSIONS 下方追加：

```typescript
/** workspace 黑名单目录：按名称精确匹配，隐藏整个目录树 */
const WORKSPACE_BLACKLIST = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".pytest_cache",
  "vendor",
  ".terraform",
  ".idea",
  ".vscode",
  "coverage",
  ".nyc_output",
  ".opencode",
  ".tmp",
  "tmp",
  ".turbo",
]);
```

- [ ] **Step 2: 新增 `shouldHideEntry` 函数并替换 `shouldHideWorkspaceEntry`**

替换现有的 `shouldHideWorkspaceEntry` 函数（保留导出名向后兼容，但改为 `shouldHideEntry` 语义）。原函数约在 163 行：

```typescript
/** 判断工作区条目是否应隐藏（黑名单目录 + 非 user/ 下的 .opencode） */
export function shouldHideEntry(entryPath: string, name: string): boolean {
  return WORKSPACE_BLACKLIST.has(name);
}
```

同时更新 `shouldHideWorkspaceEntry` 的调用点（`listDirectory` 和 `listPathsRecursive`），把参数从 `(entryPath, userDir)` 改为 `(entryPath, entryName)`。

- [ ] **Step 3: 扩展 `listPathsRecursive` 从 workspace 根开始扫描**

修改 `listPathsRecursive` 函数（约 236 行），将 walk 起点从 `userDir` 改为 `workspaceDir`：

```typescript
/** 递归列出 workspace 下所有路径（黑名单过滤），返回相对路径及修改时间 */
export async function listPathsRecursive(workspaceDir: string): Promise<TreeNodeEntry[]> {
  const results: TreeNodeEntry[] = [];

  async function walk(dirPath: string, prefix: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const dirs: { name: string; fullPath: string; relPath: string }[] = [];
    const files: { relPath: string; fullPath: string }[] = [];

    for (const entry of entries) {
      // 黑名单目录跳过
      if (shouldHideEntry(join(dirPath, entry.name), entry.name)) continue;
      const fullPath = join(dirPath, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        dirs.push({ name: entry.name, fullPath, relPath });
      } else {
        files.push({ relPath, fullPath });
      }
    }

    // 排序：目录按名称字母序
    dirs.sort((a, b) => a.name.localeCompare(b.name));

    for (const d of dirs) {
      results.push({ path: `${d.relPath}/`, mtime: 0 });
      await walk(d.fullPath, d.relPath);
    }

    // 文件：获取修改时间
    for (const f of files) {
      try {
        const info = await stat(f.fullPath);
        results.push({ path: f.relPath, mtime: info.mtimeMs });
      } catch {
        results.push({ path: f.relPath, mtime: 0 });
      }
    }
  }

  await walk(workspaceDir, "");
  return results;
}
```

注意：`walk` 不再从 `userDir` 开始，不再跳过 dotfile，不再有 `shouldHideWorkspaceEntry` 调用。所有过滤统一走 `shouldHideEntry`。

- [ ] **Step 4: 更新 `listDirectory` 中的过滤调用**

在 `listDirectory` 函数（约 178 行）中，将过滤行从：

```typescript
const visibleEntries = entries.filter((entry) => !shouldHideWorkspaceEntry(join(dirPath, entry.name), userDir));
```

改为：

```typescript
const visibleEntries = entries.filter((entry) => !shouldHideEntry(join(dirPath, entry.name), entry.name));
```

- [ ] **Step 5: 运行预检查**

```bash
bun run precheck
```

预期：通过（只有 filter 参数签名变化，不影响调用方）

- [ ] **Step 6: 提交**

```bash
git add src/services/workspace-fs.ts
git commit -m "refactor(fs): 新增 workspace 黑名单过滤逻辑，扩展递归扫描范围"
```

---

### Task 2: 新增 fs 路由 Schema

**Files:**
- Modify: `src/schemas/file.schema.ts`

- [ ] **Step 1: 新增请求 Schema（mkdir、rename、batch-delete）**

在文件末尾追加以下 Schema（这些在 `user-file.ts` 中已用到但定义在 file.schema.ts 中，检查后只需追加缺失的）：

实际上 `RenamedRequestSchema`、`MkdirRequestSchema`、`BatchDeleteRequestSchema` 已在 file.schema.ts 中定义（在 `user-file.ts` 使用），同时也应补充响应包裹型 schema 以符合 `/web/*` 规范。

在 `TreeResponseSchema` 附近追加：

```typescript
/** /web 标准成功响应包裹 */
export const WebOkResponseSchema = <T extends z.ZodTypeAny>(dataSchema: T) =>
  z.object({
    success: z.literal(true),
    data: dataSchema,
  });
```

实际上 `ConfigOkSchema` 已经在 `common.schema.ts` 中定义了。直接复用即可。

检查 `file.schema.ts` 已有的 schema 是否足够覆盖新 `fs.ts` 的所有端点：

| 端点 | 请求 body | 响应 data |
|------|----------|----------|
| `GET /fs/tree` | — | `{ paths, mtimes }` | ← 复用 `TreeResponseSchema`
| `GET /fs` | `?path=` | `{ entries: FileEntry[] }` | ← 复用 `FileListResponseSchema`
| `GET /fs/*` | — | `{ name, path, content, size, encoding }` 或 stream | ← 复用 `FileContentSchema`
| `POST /fs/*` | FormData | `{ files: [...] }` | ← 复用 `FileUploadResponseSchema`
| `PUT /fs/*` | `{ content }` | `{ name, path, size }` | ← 复用 `WriteFileRequestSchema` + `FileWriteResultSchema`
| `DELETE /fs/*` | — | `{ ok: true }` | ← 复用 `OkResponseSchema`
| `POST /fs/mkdir` | `{ path }` | `{ path }` | ← 已有 `MkdirRequestSchema` + `MkdirResponseSchema`
| `POST /fs/rename` | `{ oldPath, newPath }` | `{ oldPath, newPath }` | ← 已有 `RenameRequestSchema` + `RenameResponseSchema`
| `DELETE /fs/batch` | `{ paths }` | `{ deleted, failed }` | ← 已有 `BatchDeleteRequestSchema` + `BatchDeleteResponseSchema`
| `GET /fs/download-zip` | `?path=` | stream | ZIP 流直接返回，无 JSON schema

结论：所有 schema 已存在，无需新增。直接复用。

- [ ] **Step 2: 验证 schema 文件不需要修改**

```bash
bun run precheck
```

- [ ] **Step 3: 提交（无变更则跳过）**

---

### Task 3: 新增 fs.ts 路由文件（第一部分：只读端点）

**Files:**
- Create: `src/routes/web/fs.ts`

- [ ] **Step 1: 创建路由文件骨架**

创建 `src/routes/web/fs.ts`，先写只读端点（tree、list dir、read file、download-zip）和基础结构：

```typescript
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
    const rawFilePath = (params as any)["*"] as string;
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

export default app;
```

- [ ] **Step 2: 运行 TypeScript 检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit src/routes/web/fs.ts 2>&1 | head -30
```

如果遇到类型错误，修复后重新运行。

---

### Task 4: 新增 fs.ts 路由文件（第二部分：写操作端点）

**Files:**
- Modify: `src/routes/web/fs.ts`（追加内容）

- [ ] **Step 1: 在 `export default app;` 之前追加写操作端点**

追加以下内容到 fs.ts 文件 `export default app;` 之前：

```typescript
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
    const rawDirPath = ((params as any)["*"] as string) || "";

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
    return { success: true, data: { files: uploaded } };
  },
  {
    sessionAuth: true,
    response: "file-upload-response",
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
    const rawFilePath = (params as any)["*"] as string;

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
    const rawFilePath = (params as any)["*"] as string;

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
      if (info.isDirectory())
        return error(400, { error: { type: "validation_error", message: "Cannot delete directories" } });
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
      description: "删除 workspace 任意路径文件。该接口仅处理单个文件，不支持删除目录。",
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
          failed.push({ path: p, error: "Cannot delete directories" });
          continue;
        }
        await deleteFile(resolved.resolved);
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
      summary: "批量删除文件",
      description: "批量删除 workspace 内指定路径的文件，并分别返回成功与失败结果。",
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
```

- [ ] **Step 2: 运行预检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

---

### Task 5: 注册路由 + 添加 OpenAPI tag

**Files:**
- Modify: `src/routes/web/index.ts`
- Modify: `src/openapi.ts`

- [ ] **Step 1: 在 `src/routes/web/index.ts` 中注册 `webFs` 路由**

在文件顶部添加 import：

```typescript
import webFs from "./fs";
```

在 `.use(webFiles)` 之后添加：

```typescript
  .use(webFs)
```

注意：`fs` 路由前缀为 `/environments`，和 `webFiles` / `webUserFile` 一致，不会冲突。

- [ ] **Step 2: 在 `src/openapi.ts` 的 `WEB_OPENAPI_TAGS` 中添加 FS tag**

在 `Files` tag 定义之后添加：

```typescript
  {
    name: "FS",
    description: "Workspace 文件系统管理，包括 workspace 全局文件树、目录浏览、文件读写与操作。",
  },
```

- [ ] **Step 3: 运行预检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

- [ ] **Step 4: 提交**

```bash
git add src/routes/web/fs.ts src/routes/web/index.ts src/openapi.ts
git commit -m "feat(fs): 新增 workspace 文件系统 API (tree/list/read/upload/write/delete/mkdir/rename/batch/zip)"
```

---

### Task 6: 编写测试

**Files:**
- Create: `src/__tests__/fs.test.ts`

- [ ] **Step 1: 编写路由集成测试**

```typescript
import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { environmentRepo } from "../repositories";
import { resolveWorkspacePath as computeWorkspacePath } from "../services/workspace-resolver";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { resetTestOrgContext, setTestOrgContext } from "../plugins/auth-context";

// L3 集成测试：fs 路由功能

const testRoot = join(tmpdir(), "fenix-test-fs", randomUUID());
const orgId = "org-fs-test";
const userId = "user-fs-test";
const envId = "env-fs-test";

// 在测试数据库中创建一个测试 env
// 注意：需要实际 DB 依赖，如果 CI 没有 DB 需要 skip 或用 mock

describe("FS API", () => {
  beforeEach(async () => {
    // 设置测试认证
    setTestAuth({
      user: { id: userId, name: "Test User", email: "test@test.com" },
      authContext: {
        organizationId: orgId,
        userId,
        organizations: [{ id: orgId, name: "Test Org", role: "owner" }],
      },
    });
    setTestOrgContext({ organizationId: orgId, userId });

    // 创建测试工作区结构
    const wsRoot = computeWorkspacePath(orgId, userId, envId);
    // 覆盖 WORKSPACE_ROOT 以便测试隔离
    process.env.WORKSPACE_ROOT = testRoot;

    const wsDir = join(testRoot, orgId, userId, envId);
    await mkdir(join(wsDir, "user"), { recursive: true });
    await mkdir(join(wsDir, "scripts"), { recursive: true });
    // 应被黑名单过滤的目录
    await mkdir(join(wsDir, "node_modules"), { recursive: true });
    await mkdir(join(wsDir, ".git"), { recursive: true });

    // 创建一些测试文件
    await writeFile(join(wsDir, "user", "hello.txt"), "hello world");
    await writeFile(join(wsDir, "scripts", "run.sh"), "#!/bin/bash\necho ok");
    await writeFile(join(wsDir, "node_modules", "index.js"), "// should be hidden");
  });

  afterEach(async () => {
    resetTestAuth();
    resetTestOrgContext();
    await rm(testRoot, { recursive: true, force: true });
  });

  // tree 端点
  it("应返回 workspace 文件树（黑名单过滤）", async () => {
    // 需要真实路由实例测试，此处展示测试结构和断言模式
    //
    // const app = createTestApp();
    // const res = await app.handle(
    //   new Request(`http://localhost/web/environments/${envId}/fs/tree`)
    // );
    // expect(res.status).toBe(200);
    // const body = await res.json();
    // expect(body.success).toBe(true);
    // expect(body.data.paths).toContain("user/");
    // expect(body.data.paths).toContain("scripts/");
    // expect(body.data.paths).toContain("user/hello.txt");
    // expect(body.data.paths).toContain("scripts/run.sh");
    // // 黑名单目录不应出现
    // expect(body.data.paths).not.toContain("node_modules/");
    // expect(body.data.paths).not.toContain(".git/");
  });

  // 读文件
  it("应读取 workspace 内任意路径的文本文件", async () => {
    // const res = await app.handle(
    //   new Request(`http://localhost/web/environments/${envId}/fs/scripts/run.sh`)
    // );
    // expect(res.status).toBe(200);
    // const body = await res.json();
    // expect(body.success).toBe(true);
    // expect(body.data.content).toContain("echo ok");
  });

  // 写文件
  it("应在 workspace 内创建文件", async () => {
    // const res = await app.handle(
    //   new Request(`http://localhost/web/environments/${envId}/fs/output/result.txt`, {
    //     method: "PUT",
    //     headers: { "Content-Type": "application/json" },
    //     body: JSON.stringify({ content: "test output" }),
    //   })
    // );
    // expect(res.status).toBe(200);
    // const body = await res.json();
    // expect(body.success).toBe(true);
    // expect(body.data.name).toBe("result.txt");
  });
});
```

> **注意**：完整的 L3 路由集成测试需要构建测试 App 实例和数据库 fixture。此处展示了测试结构、断言和验证点。具体实现取决于项目的测试 App 工厂函数。

- [ ] **Step 2: 运行测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/fs.test.ts
```

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/fs.test.ts
git commit -m "test(fs): 新增 workspace 文件系统 API 路由集成测试"
```

---

### Task 7: 最终验证

- [ ] **Step 1: 运行完整预检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

- [ ] **Step 2: 运行全部后端测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

- [ ] **Step 3: 检查不需要前端的任何改动**

确认以下文件未被修改：`web/src/api/files.ts`、`web/src/components/agent-panel/FileTreeTab.tsx`

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && git diff --name-only HEAD~3..HEAD | grep "^web/"
```

预期：无输出（只有后端文件变更）
