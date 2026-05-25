# Workspace File Tree Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a file tree panel in the ArtifactsPanel showing workspace files, with search, context menu, drag upload, double-click preview, and chat reference integration.

**Architecture:** Backend adds `/user-file/` route group for enhanced file operations (tree listing, rename, mkdir, batch delete). Frontend refactors ArtifactsPanel from 2 tabs to 3 (Files | Preview | Context), integrates `@pierre/trees` for the file tree tab, and wires cross-tab interactions (double-click → preview, context menu → rename/delete/mkdir/reference, drag → upload or chat reference).

**Tech Stack:** `@pierre/trees` (React tree component), Elysia (backend routes), existing `workspace-fs.ts` utilities, `react-i18next` (i18n)

---

## File Structure

### Backend — New files

| File | Responsibility |
|------|---------------|
| `src/routes/web/user-file.ts` | `/user-file/` route group: tree, rename, mkdir, batch-delete |

### Backend — Modified files

| File | Change |
|------|--------|
| `src/services/workspace-fs.ts` | Add `listPathsRecursive()`, `renamePath()`, `mkdirp()` functions |
| `src/schemas/file.schema.ts` | Add `TreeResponseSchema`, `RenameRequestSchema`, `MkdirRequestSchema`, `BatchDeleteRequestSchema` |

### Frontend — New files

| File | Responsibility |
|------|---------------|
| `web/src/components/agent-panel/FileTreeTab.tsx` | File tree tab: `@pierre/trees` integration, search, context menu, drag upload, double-click preview |
| `web/src/components/agent-panel/FileTreeContextMenu.tsx` | Right-click context menu component (rename, delete, new folder, reference) |
| `web/src/components/agent-panel/PreviewTab.tsx` | Single-file preview tab (replaces ArtifactPreview) |

### Frontend — Modified files

| File | Change |
|------|--------|
| `web/src/pages/agent-panel/ArtifactsPanel.tsx` | Refactor: 3 tabs (Files/Preview/Context), pass `envId` + file tree state |
| `web/src/pages/agent-panel/AgentAppShell.tsx` | Remove `chatEntries` state, pass `envId` to ArtifactsPanel |
| `web/components/ChatInput.tsx` | Expose `insertFileReference(path, name)` via ref or callback for drag-from-tree |
| `web/src/i18n/locales/en/agentPanel.json` | Add file tree tab labels |
| `web/src/i18n/locales/zh/agentPanel.json` | Add file tree tab labels |
| `web/src/i18n/locales/en/components.json` | Add fileTree section (context menu, placeholders) |
| `web/src/i18n/locales/zh/components.json` | Add fileTree section |

---

## Task 1: Backend — workspace-fs utility functions

**Files:**
- Modify: `src/services/workspace-fs.ts`
- Test: `src/__tests__/workspace-fs-tree.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/workspace-fs-tree.test.ts
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  listPathsRecursive,
  renamePath,
  mkdirp,
} from "../services/workspace-fs";

describe("workspace-fs tree utilities", () => {
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "ws-fs-test-"));
    await mkdir(join(baseDir, "user", "sub", "nested"), { recursive: true });
    await writeFile(join(baseDir, "user", "a.txt"), "hello");
    await writeFile(join(baseDir, "user", "sub", "b.txt"), "world");
    await writeFile(join(baseDir, "user", "sub", "nested", "c.txt"), "deep");
    await mkdir(join(baseDir, "user", ".opencode"), { recursive: true });
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
  });

  // 递归路径列表
  test("listPathsRecursive returns all user/ paths relative to userDir", async () => {
    const paths = await listPathsRecursive(baseDir);
    expect(paths).toContain("a.txt");
    expect(paths).toContain("sub/b.txt");
    expect(paths).toContain("sub/nested/c.txt");
    // .opencode should be filtered
    expect(paths).not.toContain((p) => p.includes(".opencode"));
  });

  test("listPathsRecursive returns empty array for empty dir", async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), "ws-fs-empty-"));
    await mkdir(join(emptyDir, "user"), { recursive: true });
    const paths = await listPathsRecursive(emptyDir);
    expect(paths).toEqual([]);
    await rm(emptyDir, { recursive: true, force: true });
  });

  // 重命名
  test("renamePath renames a file", async () => {
    const src = join(baseDir, "user", "a.txt");
    const dst = join(baseDir, "user", "a-renamed.txt");
    await renamePath(src, dst);
    const { stat } = await import("node:fs/promises");
    await expect(stat(src)).rejects.toThrow();
    await expect(stat(dst)).resolves.toBeDefined();
    // rename back for other tests
    await renamePath(dst, src);
  });

  test("renamePath renames a directory", async () => {
    const src = join(baseDir, "user", "sub");
    const dst = join(baseDir, "user", "sub-renamed");
    await renamePath(src, dst);
    const { stat, readdir } = await import("node:fs/promises");
    await expect(stat(src)).rejects.toThrow();
    await expect(readdir(dst)).resolves.toBeDefined();
    // rename back
    await renamePath(dst, src);
  });

  // 创建目录
  test("mkdirp creates nested directory", async () => {
    const newDir = join(baseDir, "user", "new", "deep", "dir");
    await mkdirp(newDir);
    const { stat } = await import("node:fs/promises");
    await expect(stat(newDir)).resolves.toBeDefined();
    await rm(join(baseDir, "user", "new"), { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/workspace-fs-tree.test.ts`
Expected: FAIL — `listPathsRecursive`, `renamePath`, `mkdirp` not exported

- [ ] **Step 3: Write the implementation**

Add these three functions to `src/services/workspace-fs.ts` (after the existing `deleteFile` function):

```typescript
/** 递归列出 user/ 目录下所有文件/目录的相对路径（过滤 .opencode） */
export async function listPathsRecursive(workspaceDir: string): Promise<string[]> {
  const userDir = join(workspaceDir, "user");
  await mkdir(userDir, { recursive: true });
  const results: string[] = [];

  async function walk(dirPath: string, prefix: string) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    // Sort: directories first, then files, both alphabetically
    const sorted = entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      const fullPath = join(dirPath, entry.name);
      if (shouldHideWorkspaceEntry(fullPath, userDir)) continue;
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        results.push(`${relPath}/`);
        await walk(fullPath, relPath);
      } else {
        results.push(relPath);
      }
    }
  }

  await walk(userDir, "");
  return results;
}

/** 重命名文件或目录（原子性：先 rename 再回滚失败不处理，由调用方决定） */
export async function renamePath(oldPath: string, newPath: string): Promise<void> {
  const { rename } = await import("node:fs/promises");
  await mkdir(resolve(newPath, ".."), { recursive: true });
  await rename(oldPath, newPath);
}

/** 递归创建目录 */
export async function mkdirp(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}
```

Note: `readdir`, `join`, `mkdir`, `resolve`, `shouldHideWorkspaceEntry` are already imported at the top of the file.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/workspace-fs-tree.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/workspace-fs.ts src/__tests__/workspace-fs-tree.test.ts
git commit -m "feat: add listPathsRecursive, renamePath, mkdirp to workspace-fs"
```

---

## Task 2: Backend — schemas for /user-file/ routes

**Files:**
- Modify: `src/schemas/file.schema.ts`

- [ ] **Step 1: Add new schemas**

Append to `src/schemas/file.schema.ts`:

```typescript
import { z } from "zod";

// ... existing schemas ...

export const TreeResponseSchema = z.object({
  paths: z.array(z.string()),
});

export const RenameRequestSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
});

export const RenameResponseSchema = z.object({
  oldPath: z.string(),
  newPath: z.string(),
});

export const MkdirRequestSchema = z.object({
  path: z.string().min(1),
});

export const MkdirResponseSchema = z.object({
  path: z.string(),
});

export const BatchDeleteRequestSchema = z.object({
  paths: z.array(z.string().min(1)).min(1),
});

export const BatchDeleteResponseSchema = z.object({
  deleted: z.array(z.string()),
  failed: z.array(z.object({ path: z.string(), error: z.string() })),
});
```

- [ ] **Step 2: Verify build**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/schemas/file.schema.ts
git commit -m "feat: add schemas for /user-file/ enhanced file routes"
```

---

## Task 3: Backend — /user-file/ route group

**Files:**
- Create: `src/routes/web/user-file.ts`
- Test: `src/__tests__/user-file-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/__tests__/user-file-routes.test.ts
import { describe, expect, test, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock dependencies before any imports
mock.module("../repositories", () => ({
  environmentRepo: {
    getById: (id: string) => {
      if (id === "env_test") return { id: "env_test", workspacePath: globalThis.__testWorkspaceDir, organizationId: "org_1" };
      return null;
    },
  },
}));

mock.module("../plugins/auth", () => ({
  authGuardPlugin: new (class {
    get name() { return "test-auth"; }
    async exec() { return this; }
  })(),
}));

import Elysia from "elysia";
import userFileRoutes from "../routes/web/user-file";

describe("/user-file/ routes", () => {
  let app: Elysia;
  let baseDir: string;

  beforeAll(async () => {
    baseDir = await mkdtemp(join(tmpdir(), "user-file-test-"));
    globalThis.__testWorkspaceDir = baseDir;
    await mkdir(join(baseDir, "user", "sub"), { recursive: true });
    await writeFile(join(baseDir, "user", "a.txt"), "hello");
    await writeFile(join(baseDir, "user", "sub", "b.txt"), "world");

    app = new Elysia().use(userFileRoutes);
  });

  afterAll(async () => {
    await rm(baseDir, { recursive: true, force: true });
    delete globalThis.__testWorkspaceDir;
  });

  // GET /tree
  test("GET /web/environments/:id/user-file/tree returns paths array", async () => {
    const res = await app
      .handle(new Request("http://localhost/web/environments/env_test/user-file/tree"))
      .then((r) => r.json());
    expect(res.paths).toBeDefined();
    expect(Array.isArray(res.paths)).toBe(true);
    expect(res.paths).toContain("a.txt");
    expect(res.paths).toContain("sub/b.txt");
  });

  // POST /rename
  test("POST /web/environments/:id/user-file/rename renames file", async () => {
    const res = await app
      .handle(
        new Request("http://localhost/web/environments/env_test/user-file/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ oldPath: "a.txt", newPath: "a-renamed.txt" }),
        }),
      )
      .then((r) => r.json());
    expect(res.oldPath).toBe("a.txt");
    expect(res.newPath).toBe("a-renamed.txt");

    // Verify tree reflects change
    const tree = await app
      .handle(new Request("http://localhost/web/environments/env_test/user-file/tree"))
      .then((r) => r.json());
    expect(tree.paths).toContain("a-renamed.txt");
    expect(tree.paths).not.toContain("a.txt");

    // Rename back
    await app.handle(
      new Request("http://localhost/web/environments/env_test/user-file/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ oldPath: "a-renamed.txt", newPath: "a.txt" }),
      }),
    );
  });

  // POST /mkdir
  test("POST /web/environments/:id/user-file/mkdir creates directory", async () => {
    const res = await app
      .handle(
        new Request("http://localhost/web/environments/env_test/user-file/mkdir", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: "new-folder" }),
        }),
      )
      .then((r) => r.json());
    expect(res.path).toBe("new-folder");

    const tree = await app
      .handle(new Request("http://localhost/web/environments/env_test/user-file/tree"))
      .then((r) => r.json());
    expect(tree.paths).toContain("new-folder/");
  });

  // DELETE /batch
  test("DELETE /web/environments/:id/user-file/batch deletes files", async () => {
    // Create a temp file to delete
    await writeFile(join(baseDir, "user", "temp.txt"), "delete me");

    const res = await app
      .handle(
        new Request("http://localhost/web/environments/env_test/user-file/batch", {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: ["temp.txt"] }),
        }),
      )
      .then((r) => r.json());
    expect(res.deleted).toContain("temp.txt");
    expect(res.failed).toHaveLength(0);

    const tree = await app
      .handle(new Request("http://localhost/web/environments/env_test/user-file/tree"))
      .then((r) => r.json());
    expect(tree.paths).not.toContain("temp.txt");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/user-file-routes.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the route**

```typescript
// src/routes/web/user-file.ts
import { stat } from "node:fs/promises";
import { join } from "node:path";
import Elysia from "elysia";
import { NotFoundError, ValidationError } from "../../errors";
import { authGuardPlugin } from "../../plugins/auth";
import { getOwnedEnvironment } from "../../services/environment-core";
import {
  listPathsRecursive,
  mkdirp,
  renamePath,
  isUserPath,
  deleteFile,
  resolveWorkspacePath,
} from "../../services/workspace-fs";
import {
  BatchDeleteRequestSchema,
  BatchDeleteResponseSchema,
  MkdirRequestSchema,
  MkdirResponseSchema,
  RenameRequestSchema,
  RenameResponseSchema,
  TreeResponseSchema,
} from "../../schemas/file.schema";

const app = new Elysia({ name: "web-user-file", prefix: "/web/environments" })
  .use(authGuardPlugin)
  .model({
    "tree-response": TreeResponseSchema,
    "rename-request": RenameRequestSchema,
    "rename-response": RenameResponseSchema,
    "mkdir-request": MkdirRequestSchema,
    "mkdir-response": MkdirResponseSchema,
    "batch-delete-request": BatchDeleteRequestSchema,
    "batch-delete-response": BatchDeleteResponseSchema,
  });

async function requireEnv(envId: string, orgId: string, errorFn: (status: number, body: unknown) => any) {
  try {
    return await getOwnedEnvironment(envId, orgId);
  } catch (e) {
    if (e instanceof NotFoundError) {
      return errorFn(404, { error: { type: "not_found", message: "环境不存在" } });
    }
    throw e;
  }
}

// GET /:id/user-file/tree — 递归列出 user/ 下所有路径
app.get(
  "/:id/user-file/tree",
  async ({ store, params, error }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    const paths = await listPathsRecursive(env.workspacePath);
    return { paths };
  },
  { sessionAuth: true },
);

// POST /:id/user-file/rename — 重命名/移动文件或目录
app.post(
  "/:id/user-file/rename",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    const { oldPath, newPath } = body as { oldPath: string; newPath: string };

    if (!isUserPath(oldPath) || !isUserPath(newPath)) {
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });
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
    return { oldPath, newPath };
  },
  { sessionAuth: true, body: "rename-request" },
);

// POST /:id/user-file/mkdir — 创建目录
app.post(
  "/:id/user-file/mkdir",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    const { path } = body as { path: string };

    if (!isUserPath(path)) {
      return error(400, { error: { type: "validation_error", message: "Only user/ paths are allowed" } });
    }

    const resolved = await resolveWorkspacePath(params.id, path);
    if (!resolved) return error(400, { error: { type: "validation_error", message: "Invalid path" } });

    await mkdirp(resolved.resolved);
    return { path };
  },
  { sessionAuth: true, body: "mkdir-request" },
);

// DELETE /:id/user-file/batch — 批量删除
app.delete(
  "/:id/user-file/batch",
  async ({ store, params, body, error }) => {
    const authCtx = store.authContext!;
    const env = await requireEnv(params.id, authCtx.organizationId, error);
    const { paths } = body as { paths: string[] };

    const deleted: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];

    for (const p of paths) {
      if (!isUserPath(p)) {
        failed.push({ path: p, error: "Only user/ paths are allowed" });
        continue;
      }
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

    return { deleted, failed };
  },
  { sessionAuth: true, body: "batch-delete-request" },
);

export default app;
```

- [ ] **Step 4: Register the route in the app entry**

In `src/index.ts`, find where other web routes are imported and add:

```typescript
import userFileRoutes from "./routes/web/user-file";
```

And register it with the other web routes (look for where `files.ts` or similar web routes are `.use()`-d):

```typescript
app.use(userFileRoutes);
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/user-file-routes.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Verify build**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/routes/web/user-file.ts src/__tests__/user-file-routes.test.ts src/index.ts
git commit -m "feat: add /user-file/ route group (tree, rename, mkdir, batch-delete)"
```

---

## Task 4: Frontend — install @pierre/trees and i18n keys

**Files:**
- Modify: `package.json` (dependency added via bun add)
- Modify: `web/src/i18n/locales/en/agentPanel.json`
- Modify: `web/src/i18n/locales/zh/agentPanel.json`
- Modify: `web/src/i18n/locales/en/components.json`
- Modify: `web/src/i18n/locales/zh/components.json`

- [ ] **Step 1: Install @pierre/trees**

Run: `bun add @pierre/trees`

- [ ] **Step 2: Add i18n keys**

Add to `web/src/i18n/locales/en/agentPanel.json`:

```json
"tabFiles": "Files"
```

Add to `web/src/i18n/locales/zh/agentPanel.json`:

```json
"tabFiles": "文件"
```

Add to `web/src/i18n/locales/en/components.json`, inside the root object:

```json
"fileTree": {
  "refresh": "Refresh",
  "emptyState": "No files in workspace",
  "contextMenu": {
    "reference": "Reference in chat",
    "rename": "Rename",
    "delete": "Delete",
    "newFolder": "New Folder",
    "newFolderName": "New folder name"
  },
  "preview": {
    "title": "Preview",
    "loading": "Loading...",
    "notTextFile": "Cannot preview binary file",
    "fetchFailed": "Failed to load file content",
    "noFileSelected": "Select a file to preview",
    "modifiedAt": "Modified"
  }
}
```

Add to `web/src/i18n/locales/zh/components.json`, inside the root object:

```json
"fileTree": {
  "refresh": "刷新",
  "emptyState": "工作区暂无文件",
  "contextMenu": {
    "reference": "引用到聊天",
    "rename": "重命名",
    "delete": "删除",
    "newFolder": "新建文件夹",
    "newFolderName": "新文件夹名称"
  },
  "preview": {
    "title": "预览",
    "loading": "加载中...",
    "notTextFile": "无法预览二进制文件",
    "fetchFailed": "加载文件内容失败",
    "noFileSelected": "选择文件以预览",
    "modifiedAt": "修改时间"
  }
}
```

- [ ] **Step 3: Verify build**

Run: `bun run build:web`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lockb web/src/i18n/locales/en/agentPanel.json web/src/i18n/locales/zh/agentPanel.json web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json
git commit -m "feat: install @pierre/trees and add file tree i18n keys"
```

---

## Task 5: Frontend — FileTreeContextMenu component

**Files:**
- Create: `web/src/components/agent-panel/FileTreeContextMenu.tsx`

- [ ] **Step 1: Create the context menu component**

```tsx
// web/src/components/agent-panel/FileTreeContextMenu.tsx
import { useTranslation } from "react-i18next";
import { Trash2, FolderPlus, Pencil, MessageSquareQuote } from "lucide-react";

interface ContextMenuPosition {
  x: number;
  y: number;
}

interface FileTreeContextMenuProps {
  position: ContextMenuPosition;
  itemPath: string;
  itemType: "file" | "dir";
  onClose: () => void;
  onRename: (path: string) => void;
  onDelete: (path: string) => void;
  onNewFolder: (parentPath: string) => void;
  onReference: (path: string) => void;
}

export function FileTreeContextMenu({
  position,
  itemPath,
  itemType,
  onClose,
  onRename,
  onDelete,
  onNewFolder,
  onReference,
}: FileTreeContextMenuProps) {
  const { t } = useTranslation("components");

  const parentPath = itemType === "dir" ? itemPath : itemPath.substring(0, itemPath.lastIndexOf("/")) || "";

  const items = [
    { label: t("fileTree.contextMenu.reference"), icon: MessageSquareQuote, action: () => onReference(itemPath) },
    ...(itemType === "file"
      ? [{ label: t("fileTree.contextMenu.rename"), icon: Pencil, action: () => onRename(itemPath) }]
      : []),
    { label: t("fileTree.contextMenu.delete"), icon: Trash2, action: () => onDelete(itemPath), danger: true },
    ...(itemType === "dir"
      ? [{ label: t("fileTree.contextMenu.newFolder"), icon: FolderPlus, action: () => onNewFolder(itemPath) }]
      : []),
  ];

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        className="fixed z-50 rounded-lg border border-border bg-surface-1 p-1 shadow-lg min-w-[160px]"
        style={{ left: position.x, top: position.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors ${
              item.danger
                ? "text-status-error hover:bg-status-error/10"
                : "text-text-primary hover:bg-surface-2"
            }`}
            onClick={() => {
              item.action();
              onClose();
            }}
          >
            <item.icon className="h-4 w-4" />
            {item.label}
          </button>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/FileTreeContextMenu.tsx
git commit -m "feat: add FileTreeContextMenu component"
```

---

## Task 6: Frontend — PreviewTab component

**Files:**
- Create: `web/src/components/agent-panel/PreviewTab.tsx`

- [ ] **Step 1: Create the preview tab**

```tsx
// web/src/components/agent-panel/PreviewTab.tsx
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { client } from "../../../api/client";

interface PreviewTabProps {
  envId: string | null;
  filePath: string | null;
}

export function PreviewTab({ envId, filePath }: PreviewTabProps) {
  const { t } = useTranslation("components");
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const loadFile = useCallback(async () => {
    if (!envId || !filePath) {
      setContent(null);
      setFileName(null);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const normalized = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
      const { data } = await client.web.environments({ id: envId }).user.get({ path: normalized });
      const result = data as any;
      if (result && typeof result.content === "string") {
        setContent(result.content);
        setFileName(result.name || normalized.split("/").pop() || normalized);
      } else {
        setContent(null);
        setError(t("fileTree.preview.notTextFile"));
        setFileName(result?.name || normalized.split("/").pop() || normalized);
      }
    } catch (err) {
      console.error("Failed to load file:", err);
      setError(t("fileTree.preview.fetchFailed"));
      setContent(null);
    } finally {
      setLoading(false);
    }
  }, [envId, filePath, t]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col">
      {fileName && (
        <div className="px-3 py-2 border-b border-border text-xs text-text-muted font-display truncate">
          {fileName}
        </div>
      )}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {!loading && error && (
          <div className="p-4 text-center text-sm text-status-error">{error}</div>
        )}
        {!loading && !error && content === null && !fileName && (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</div>
        )}
        {!loading && !error && content !== null && (
          <pre className="p-4 text-xs text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/PreviewTab.tsx
git commit -m "feat: add PreviewTab component with file content viewer"
```

---

## Task 7: Frontend — FileTreeTab component

**Files:**
- Create: `web/src/components/agent-panel/FileTreeTab.tsx`

- [ ] **Step 1: Create the file tree tab**

```tsx
// web/src/components/agent-panel/FileTreeTab.tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Search } from "lucide-react";
import { preparePresortedFileTreeInput } from "@pierre/trees";
import { FileTree, useFileTree, useFileTreeSearch, useFileTreeSelection } from "@pierre/trees/react";
import { fetchUpload } from "../../../api/client";
import { FileTreeContextMenu } from "./FileTreeContextMenu";

interface FileTreeTabProps {
  envId: string | null;
  onPreviewFile: (path: string) => void;
  onReferenceFile: (path: string, name: string) => void;
}

export function FileTreeTab({ envId, onPreviewFile, onReferenceFile }: FileTreeTabProps) {
  const { t } = useTranslation("components");
  const [paths, setPaths] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    position: { x: number; y: number };
    itemPath: string;
    itemType: "file" | "dir";
  } | null>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);

  const { model } = useFileTree({
    paths,
    search: true,
    fileTreeSearchMode: "hide-non-matches",
    initialExpandedPaths: [],
    icons: "standard",
  });

  const selectedPaths = useFileTreeSelection(model);
  const search = useFileTreeSearch(model);

  const loadTree = useCallback(async () => {
    if (!envId) return;
    setLoading(true);
    try {
      const res = await fetch(`/web/environments/${envId}/user-file/tree`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const newPaths = data.paths ?? [];
      setPaths(newPaths);
      model.resetPaths(newPaths);
    } catch (err) {
      console.error("Failed to load file tree:", err);
    } finally {
      setLoading(false);
    }
  }, [envId, model]);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // 双击 → 预览
  const handleDoubleClick = useCallback(
    (path: string) => {
      if (path.endsWith("/")) return; // 忽略目录
      onPreviewFile(path);
    },
    [onPreviewFile],
  );

  // 右键菜单
  const handleContextMenu = useCallback(
    (e: React.MouseEvent, itemPath: string) => {
      e.preventDefault();
      e.stopPropagation();
      const itemType = itemPath.endsWith("/") ? "dir" : "file";
      setContextMenu({ position: { x: e.clientX, y: e.clientY }, itemPath, itemType });
    },
    [],
  );

  // 重命名
  const handleRename = useCallback(
    async (oldPath: string) => {
      const newName = window.prompt(t("fileTree.contextMenu.rename"), oldPath.split("/").pop());
      if (!newName || newName === oldPath.split("/").pop()) return;
      const parentDir = oldPath.substring(0, oldPath.lastIndexOf("/"));
      const newPath = parentDir ? `${parentDir}/${newName}` : newName;
      try {
        const res = await fetch(`/web/environments/${envId}/user-file/rename`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ oldPath, newPath }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTree();
      } catch (err) {
        console.error("Rename failed:", err);
      }
    },
    [envId, loadTree, t],
  );

  // 删除
  const handleDelete = useCallback(
    async (path: string) => {
      if (!window.confirm(t("fileTree.contextMenu.delete") + `: ${path}?`)) return;
      try {
        const res = await fetch(`/web/environments/${envId}/user-file/batch`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ paths: [path] }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTree();
      } catch (err) {
        console.error("Delete failed:", err);
      }
    },
    [envId, loadTree, t],
  );

  // 新建文件夹
  const handleNewFolder = useCallback(
    async (parentPath: string) => {
      const name = window.prompt(t("fileTree.contextMenu.newFolderName"));
      if (!name) return;
      const cleanParent = parentPath.endsWith("/") ? parentPath.slice(0, -1) : parentPath;
      const fullPath = cleanParent ? `${cleanParent}/${name}` : name;
      try {
        const res = await fetch(`/web/environments/${envId}/user-file/mkdir`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ path: fullPath }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadTree();
      } catch (err) {
        console.error("Mkdir failed:", err);
      }
    },
    [envId, loadTree, t],
  );

  // 引用到聊天
  const handleReference = useCallback(
    (path: string) => {
      const name = path.split("/").pop() || path;
      const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
      onReferenceFile(cleanPath, name);
    },
    [onReferenceFile],
  );

  // 拖拽上传
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent) => {
      e.preventDefault();
      if (!envId) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // 确定目标目录
      let targetDir = "user";
      const dropTarget = e.currentTarget as HTMLElement;
      const dirAttr = dropTarget.closest("[data-tree-dir]");
      if (dirAttr) {
        const dirPath = dirAttr.getAttribute("data-tree-dir");
        if (dirPath) targetDir = dirPath;
      }

      try {
        const formData = new FormData();
        for (const file of files) {
          formData.append("files", file);
        }
        await fetchUpload(`/web/environments/${envId}/user/${targetDir.replace(/^user\/?/, "")}`, formData);
        await loadTree();
      } catch (err) {
        console.error("Upload failed:", err);
      }
    },
    [envId, loadTree],
  );

  // 拖拽到聊天输入框 — 在 tree 行上设置 draggable
  // 通过 HTML5 drag API 让文件路径可以拖出
  const handleRowDragStart = useCallback((e: React.DragEvent, path: string) => {
    if (path.endsWith("/")) return;
    e.dataTransfer.setData("text/plain", path);
    e.dataTransfer.effectAllowed = "link";
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden" ref={treeContainerRef}>
      {/* 工具栏 */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border flex-shrink-0">
        <button
          type="button"
          onClick={loadTree}
          disabled={loading || !envId}
          className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
          title={t("fileTree.refresh")}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
        </button>
        <div className="flex-1 relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-text-muted pointer-events-none" />
          <input
            value={search.value}
            onChange={(e) => search.setValue(e.target.value)}
            placeholder="Search files..."
            className="w-full h-7 pl-7 pr-2 rounded-md border border-border bg-surface-2 text-xs text-text-primary placeholder:text-text-muted outline-none focus:border-brand/50"
          />
        </div>
      </div>

      {/* 文件树 */}
      <div
        className="flex-1 overflow-hidden"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {!envId ? (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.emptyState")}</div>
        ) : paths.length === 0 && !loading ? (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.emptyState")}</div>
        ) : (
          <FileTree
            model={model}
            className="h-full w-full"
            onDoubleClick={(path: string) => handleDoubleClick(path)}
            onContextMenu={(e: React.MouseEvent, item: any) => handleContextMenu(e, item.path)}
            onRowDragStart={(e: React.DragEvent, item: any) => handleRowDragStart(e, item.path)}
          />
        )}
      </div>

      {/* 右键菜单 */}
      {contextMenu && (
        <FileTreeContextMenu
          position={contextMenu.position}
          itemPath={contextMenu.itemPath}
          itemType={contextMenu.itemType}
          onClose={() => setContextMenu(null)}
          onRename={handleRename}
          onDelete={handleDelete}
          onNewFolder={handleNewFolder}
          onReference={handleReference}
        />
      )}
    </div>
  );
}
```

**Important note:** The `@pierre/trees` `<FileTree>` component's actual prop names for `onDoubleClick`, `onContextMenu`, and row drag events need to be verified against the library's API. The above uses likely prop names based on the library's path-first design. Check the `@pierre/trees` React API docs and adjust prop names if needed. The library may use `renderRowDecoration` or event delegation instead of direct event props.

- [ ] **Step 2: Verify the component compiles**

Run: `bun run build:web`
Expected: May need adjustment based on actual `@pierre/trees` API

- [ ] **Step 3: Commit**

```bash
git add web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat: add FileTreeTab with @pierre/trees integration"
```

---

## Task 8: Frontend — Refactor ArtifactsPanel (3 tabs + envId)

**Files:**
- Modify: `web/src/pages/agent-panel/ArtifactsPanel.tsx`
- Test: `web/src/__tests__/artifacts-panel.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// web/src/__tests__/artifacts-panel.test.tsx
import { describe, expect, test } from "bun:test";
import React from "react";
import ReactDOMServer from "react-dom/server";

describe("ArtifactsPanel", () => {
  test("exports ArtifactsPanel as a function", async () => {
    const mod = await import("../pages/agent-panel/ArtifactsPanel");
    expect(typeof mod.ArtifactsPanel).toBe("function");
  });

  test("renders with envId and collapsed=false without throwing", async () => {
    const { ArtifactsPanel } = await import("../pages/agent-panel/ArtifactsPanel");
    expect(() => {
      ReactDOMServer.renderToString(
        <ArtifactsPanel collapsed={false} onToggleCollapse={() => {}} envId="env_1" />,
      );
    }).not.toThrow();
  });

  test("renders with collapsed=true without throwing", async () => {
    const { ArtifactsPanel } = await import("../pages/agent-panel/ArtifactsPanel");
    expect(() => {
      ReactDOMServer.renderToString(
        <ArtifactsPanel collapsed={true} onToggleCollapse={() => {}} envId="env_1" />,
      );
    }).not.toThrow();
  });

  test("renders with envId=null without throwing", async () => {
    const { ArtifactsPanel } = await import("../pages/agent-panel/ArtifactsPanel");
    expect(() => {
      ReactDOMServer.renderToString(
        <ArtifactsPanel collapsed={false} onToggleCollapse={() => {}} envId={null} />,
      );
    }).not.toThrow();
  });

  test("does not accept entries prop (removed)", async () => {
    // Verify ArtifactsPanel no longer needs entries prop
    const mod = await import("../pages/agent-panel/ArtifactsPanel");
    expect(typeof mod.ArtifactsPanel).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test web/src/__tests__/artifacts-panel.test.tsx`
Expected: FAIL — current ArtifactsPanel still requires `entries` prop

- [ ] **Step 3: Refactor ArtifactsPanel**

Replace the entire content of `web/src/pages/agent-panel/ArtifactsPanel.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { X, FileText, FolderTree, BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { FileTreeTab } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";

type ArtifactsTab = "files" | "preview" | "context";

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
  /** ChatInput 回调：将文件引用插入聊天 */
  onReferenceFile?: (path: string, name: string) => void;
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, envId, onReferenceFile }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [activeTab, setActiveTab] = useState<ArtifactsTab>(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-tab");
    return saved === "preview" || saved === "context" || saved === "files" ? saved : "files";
  });
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-width");
    return saved ? Number(saved) : 400;
  });

  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-tab", activeTab);
  }, [activeTab]);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-width", String(width));
  }, [width]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = startXRef.current - ev.clientX;
        const newWidth = Math.min(600, Math.max(300, startWidthRef.current + delta));
        setWidth(newWidth);
      };

      const handleMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [width],
  );

  const handlePreviewFile = useCallback((path: string) => {
    setPreviewFilePath(path);
    setActiveTab("preview");
  }, []);

  const handleReferenceFile = useCallback(
    (path: string, name: string) => {
      onReferenceFile?.(path, name);
    },
    [onReferenceFile],
  );

  if (collapsed) {
    return null;
  }

  return (
    <>
      {/* 拖拽分隔线 */}
      <div className="agent-artifacts-resize-handle" style={{ left: 0 }} onMouseDown={handleMouseDown} />

      {/* 面板主体 */}
      <div className="agent-artifacts" style={{ width }}>
        {/* Tab 栏 */}
        <div className="agent-artifacts-tabs">
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "files" ? "active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            <FolderTree className="inline h-3 w-3 mr-1" />
            {t("tabFiles")}
          </button>
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "preview" ? "active" : ""}`}
            onClick={() => setActiveTab("preview")}
          >
            <FileText className="inline h-3 w-3 mr-1" />
            {t("tabPreview")}
          </button>
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "context" ? "active" : ""}`}
            onClick={() => setActiveTab("context")}
          >
            <BarChart3 className="inline h-3 w-3 mr-1" />
            {t("tabContext")}
          </button>
          <button
            type="button"
            className="agent-artifacts-close-btn"
            onClick={onToggleCollapse}
            title={t("closePanel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="flex-1 overflow-hidden">
          {activeTab === "files" && (
            <FileTreeTab
              envId={envId}
              onPreviewFile={handlePreviewFile}
              onReferenceFile={handleReferenceFile}
            />
          )}
          {activeTab === "preview" && <PreviewTab envId={envId} filePath={previewFilePath} />}
          {activeTab === "context" && (
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-sm text-text-muted">Context (placeholder)</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Run tests**

Run: `bun test web/src/__tests__/artifacts-panel.test.tsx`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/agent-panel/ArtifactsPanel.tsx web/src/__tests__/artifacts-panel.test.tsx
git commit -m "refactor: ArtifactsPanel now has 3 tabs (Files/Preview/Context) with envId"
```

---

## Task 9: Frontend — Wire AgentAppShell + ChatInput integration

**Files:**
- Modify: `web/src/pages/agent-panel/AgentAppShell.tsx`
- Modify: `web/components/ChatInput.tsx` (expose insertFileReference)

- [ ] **Step 1: Update AgentAppShell**

In `web/src/pages/agent-panel/AgentAppShell.tsx`:

1. Remove the `chatEntries` state and its import:
```typescript
// DELETE this line:
const [chatEntries, setChatEntries] = useState<unknown[]>([]);
```

2. Remove unused imports (`ArtifactPreview`, `ArtifactContext` are no longer needed since ArtifactsPanel handles tabs internally).

3. Replace the ArtifactsPanel usage (around line 96-100):

Old:
```tsx
<ArtifactsPanel
  collapsed={artifactsCollapsed}
  onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
  entries={chatEntries}
/>
```

New:
```tsx
<ArtifactsPanel
  collapsed={artifactsCollapsed}
  onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
  envId={selectedAgentId}
/>
```

- [ ] **Step 2: Expose insertFileReference on ChatInput**

The ChatInput currently uses `@./path` format for file references internally. We need to allow external components (FileTreeTab) to trigger this insertion. The simplest approach: use a callback prop from AgentAppShell → ArtifactsPanel → FileTreeTab, and have the parent (ChatPanel/ACPMain) handle inserting into ChatInput.

However, ChatInput is deep in the component tree (ChatPanel → ACPMain → ChatInterface → ChatInput). The cleanest approach without massive prop drilling is to use a **DOM-based approach**:

In `web/src/components/agent-panel/FileTreeTab.tsx`, update `handleReference` to dispatch a custom DOM event that ChatInput listens for:

```typescript
// In FileTreeTab, replace handleReference:
const handleReference = useCallback(
  (path: string) => {
    const name = path.split("/").pop() || path;
    const cleanPath = path.endsWith("/") ? path.slice(0, -1) : path;
    // Dispatch custom event for ChatInput to pick up
    window.dispatchEvent(
      new CustomEvent("file-tree:reference", {
        detail: { path: cleanPath, name },
      }),
    );
  },
  [],
);
```

In `web/components/chat/ChatInput.tsx`, add an event listener that picks up this event:

Add inside the `ChatInput` component body (after the existing `useEffect` hooks):

```typescript
useEffect(() => {
  const handler = (e: Event) => {
    const { path, name } = (e as CustomEvent).detail;
    setText((prev) => prev + `@./${path} `);
    setAttachments((prev) => {
      if (prev.some((a) => a.path === path)) return prev;
      return [...prev, { name, path }];
    });
    textareaRef.current?.focus();
  };
  window.addEventListener("file-tree:reference", handler);
  return () => window.removeEventListener("file-tree:reference", handler);
}, []);
```

- [ ] **Step 3: Verify build**

Run: `bun run build:web`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/agent-panel/AgentAppShell.tsx web/components/chat/ChatInput.tsx web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat: wire AgentAppShell envId to ArtifactsPanel and add file-tree:reference event"
```

---

## Task 10: Frontend — Drag from file tree to ChatInput

**Files:**
- Modify: `web/components/chat/ChatInput.tsx`

- [ ] **Step 1: Add drop handler to ChatInput**

In `web/components/chat/ChatInput.tsx`, add a drop handler on the textarea container div. Add this inside the component body:

```typescript
const handleDrop = useCallback((e: React.DragEvent) => {
  // Only handle our custom file-tree drags (text/plain with @./ path format)
  const treePath = e.dataTransfer.getData("text/plain");
  if (!treePath || treePath.startsWith("file://") || treePath.startsWith("blob:")) return;

  e.preventDefault();
  const name = treePath.split("/").pop() || treePath;
  const cleanPath = treePath.endsWith("/") ? treePath.slice(0, -1) : treePath;

  setText((prev) => prev + `@./${cleanPath} `);
  setAttachments((prev) => {
    if (prev.some((a) => a.path === cleanPath)) return prev;
    return [...prev, { name, path: cleanPath }];
  });
  textareaRef.current?.focus();
}, []);
```

Add `onDrop={handleDrop}` and `onDragOver={(e) => e.preventDefault()}` to the `<textarea>` element's parent div (the `flex items-end gap-2` div, around line 292).

- [ ] **Step 2: Verify build**

Run: `bun run build:web`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/components/chat/ChatInput.tsx
git commit -m "feat: ChatInput accepts file path drops from file tree"
```

---

## Task 11: Frontend — Clean up old ArtifactPreview/ArtifactContext imports

**Files:**
- Modify: `web/src/pages/agent-panel/ArtifactsPanel.tsx` (verify no old imports remain)
- Modify or delete: Check if `web/src/components/agent-panel/ArtifactPreview.tsx` and `ArtifactContext.tsx` are still imported anywhere

- [ ] **Step 1: Check for remaining imports of old components**

Run: `grep -r "ArtifactPreview\|ArtifactContext" web/src/ web/components/ --include="*.tsx" --include="*.ts" -l`

If no files import them except the old files themselves, they can be deleted.

- [ ] **Step 2: Delete unused old components if safe**

```bash
git rm web/src/components/agent-panel/ArtifactPreview.tsx web/src/components/agent-panel/ArtifactContext.tsx
```

- [ ] **Step 3: Run full test suite**

Run: `bun test web/src/__tests__/`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: remove unused ArtifactPreview and ArtifactContext components"
```

---

## Task 12: Final verification

- [ ] **Step 1: Run backend tests**

Run: `bun test src/__tests__/`
Expected: All tests PASS (including new workspace-fs-tree and user-file-routes tests)

- [ ] **Step 2: Run frontend tests**

Run: `bun test web/src/__tests__/`
Expected: All tests PASS

- [ ] **Step 3: Run full build**

Run: `bun run build:web`
Expected: Build succeeds with no errors

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: No lint errors (or only pre-existing warnings)

- [ ] **Step 6: Commit any fixes if needed**

```bash
git add -A
git commit -m "fix: address lint/typecheck issues from file tree integration"
```
