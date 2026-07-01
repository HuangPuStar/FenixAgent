# 前端适配 workspace fs API 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将前端 `FileTreeTab` 及预览组件从旧 `user/*` / `user-file/*` API 切换到新的 `fs/*` API。

**Architecture:** 新增 `web/src/api/fs.ts` 对偶模块，修改 `FileTreeTab.tsx` 将所有 `fileApi`/`userFileApi` 调用替换为 `fsApi`，修改 `buildPreviewUrl` 使用 `fs/` 路径。

**Tech Stack:** TypeScript + React 19 + TanStack Router

**前提:** 后端 `fs/*` API 已实现完毕（commit `1b70f728` ~ `ee63f8bf`）

---

### Task 1: 新增 `fsApi` 前端模块

**Files:**
- Create: `web/src/api/fs.ts`

- [ ] **Step 1: 创建 `web/src/api/fs.ts`**

镜像现有 `files.ts` 的结构，将端点从 `user/*` / `user-file/*` 切换到 `fs/*`：

```typescript
/**
 * fs.ts — workspace 文件系统 API 模块
 *
 * 封装基于环境（environment）的 workspace 全目录文件浏览、读写、上传和文件树管理操作。
 * 后端路由前缀为 /web/environments/:id/fs，本模块内部拼接完整路径。
 */

import { request } from "./request";

/** 目录列表单条记录 */
interface FileEntry {
  name: string;
  path: string;
  type: "dir" | "file";
  size: number;
  modifiedAt: number;
}

/** 目录列表响应 */
interface FileListResponse {
  entries: FileEntry[];
}

/** 文件内容响应 */
interface FileContent {
  name: string;
  path: string;
  content: string;
  size: number;
  encoding: string;
}

/** 文件上传响应 */
interface FileUploadResponse {
  files: Array<{ name: string; path: string; size: number }>;
}

/** 文件写入响应 */
interface FileWriteResult {
  name: string;
  path: string;
  size: number;
}

/** 文件树响应 */
interface TreeResponse {
  paths: string[];
  mtimes?: Record<string, number>;
}

/** 重命名响应 */
interface RenameResponse {
  oldPath: string;
  newPath: string;
}

/** 创建目录响应 */
interface MkdirResponse {
  path: string;
}

/** 批量删除响应 */
interface BatchDeleteResponse {
  deleted: string[];
  failed: Array<{ path: string; error: string }>;
}

export const fsApi = {
  /**
   * 递归获取 workspace 完整文件树（黑名单过滤）。
   * @param id - 环境 ID
   */
  tree: (id: string) => request<TreeResponse>("/web/environments/:id/fs/tree", { params: { id } }),

  /**
   * 获取 workspace 指定路径的目录列表。
   * @param id - 环境 ID
   * @param subpath - 可选的子目录路径（默认为 workspace 根）
   */
  listDir: (id: string, subpath?: string) =>
    request<FileListResponse>("/web/environments/:id/fs", {
      params: { id },
      query: subpath ? { path: subpath } : undefined,
    }),

  /**
   * 读取 workspace 指定路径的文件内容。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 workspace 根）
   */
  readFile: (id: string, subpath: string) =>
    request<FileContent | undefined>(`/web/environments/:id/fs/${subpath}`, { params: { id } }),

  /**
   * 上传文件到 workspace 指定目录。
   * @param id - 环境 ID
   * @param fd - 包含文件及相关路径信息的 FormData 对象
   */
  upload: (id: string, fd: FormData) =>
    request<FileUploadResponse>("/web/environments/:id/fs", {
      method: "POST",
      params: { id },
      body: fd,
    }),

  /**
   * 写入文本内容到 workspace 的指定文件。
   * @param id - 环境 ID
   * @param subpath - 文件路径（相对于 workspace 根）
   * @param content - 要写入的文本内容
   */
  writeFile: (id: string, subpath: string, content: string) =>
    request<FileWriteResult>(`/web/environments/:id/fs/${subpath}`, {
      method: "PUT",
      params: { id },
      body: { content },
    }),

  /**
   * 重命名或移动 workspace 中的文件或目录。
   * @param id - 环境 ID
   * @param oldPath - 原路径
   * @param newPath - 新路径（完整路径，非仅文件名）
   */
  rename: (id: string, oldPath: string, newPath: string) =>
    request<RenameResponse>("/web/environments/:id/fs/rename", {
      method: "POST",
      params: { id },
      body: { oldPath, newPath },
    }),

  /**
   * 在 workspace 中创建新目录。
   * @param id - 环境 ID
   * @param path - 要创建的目录路径（相对于 workspace 根）
   */
  mkdir: (id: string, path: string) =>
    request<MkdirResponse>("/web/environments/:id/fs/mkdir", {
      method: "POST",
      params: { id },
      body: { path },
    }),

  /**
   * 批量删除 workspace 中的文件。
   * @param id - 环境 ID
   * @param paths - 待删除的文件路径数组
   */
  batchDelete: (id: string, paths: string[]) =>
    request<BatchDeleteResponse>("/web/environments/:id/fs/batch", {
      method: "DELETE",
      params: { id },
      body: { paths },
    }),
};
```

**与旧 `fileApi`/`userFileApi` 的差异**：
- `tree` 端点从 `user-file/tree` → `fs/tree`
- `rename` 的 `newPath` 参数直接接受完整路径（不再内部拼接 parentDir）
- 所有端点路径从 `user/*` → `fs/*`

- [ ] **Step 2: 运行 TypeScript 检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx tsc --noEmit web/src/api/fs.ts 2>&1 | head -20
```

- [ ] **Step 3: 提交**

```bash
git add web/src/api/fs.ts
git commit -m "feat(fs): 新增前端 fsApi 模块"
```

---

### Task 2: 更新 `buildPreviewUrl` 使用 `fs/` 路径

**Files:**
- Modify: `web/src/components/agent-panel/preview/utils.ts:185-189`

- [ ] **Step 1: 修改 `buildPreviewUrl` 函数**

当前代码（约第 185 行）：
```typescript
export function buildPreviewUrl(envId: string, filePath: string): string {
  const withUserPrefix = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
  const encoded = withUserPrefix.split("/").map(encodePathSegment).join("/");
  return `/web/environments/${envId}/user/${encoded}?preview=true`;
}
```

替换为：
```typescript
export function buildPreviewUrl(envId: string, filePath: string): string {
  const encoded = filePath.split("/").map(encodePathSegment).join("/");
  return `/web/environments/${envId}/fs/${encoded}?preview=true`;
}
```

原因：新 API 的 tree 返回完整路径（如 `user/hello.txt`、`scripts/run.sh`），不再需要补 `user/` 前缀。

- [ ] **Step 2: 运行预检查**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

- [ ] **Step 3: 提交**

```bash
git add web/src/components/agent-panel/preview/utils.ts
git commit -m "feat(fs): buildPreviewUrl 切换到 /fs/ 路径"
```

---

### Task 3: 更新 FileTreeTab 切换到 fsApi

**Files:**
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`

- [ ] **Step 1: 修改 import 语句**

当前第 10 行：
```typescript
import { fileApi, userFileApi } from "@/src/api/files";
```

替换为：
```typescript
import { fsApi } from "@/src/api/fs";
```

- [ ] **Step 2: 修改文件树加载（tree）**

当前第 123 行：
```typescript
const { loading, refresh: refreshTree } = useRequest(() => unwrap(userFileApi.tree(envId!)), {
```

替换为：
```typescript
const { loading, refresh: refreshTree } = useRequest(() => unwrap(fsApi.tree(envId!)), {
```

- [ ] **Step 3: 修改上传调用**

当前第 141 行：
```typescript
const { run: runUpload, loading: uploading } = useRequest((fd: FormData) => unwrap(fileApi.upload(envId!, fd)), {
```

替换为：
```typescript
const { run: runUpload, loading: uploading } = useRequest((fd: FormData) => unwrap(fsApi.upload(envId!, fd)), {
```

- [ ] **Step 4: 修改重命名调用**

当前第 157 行：
```typescript
const { run: runRename } = useRequest(
  (oldPath: string, newName: string) => unwrap(userFileApi.rename(envId!, oldPath, newName)),
```

替换为：
```typescript
const { run: runRename } = useRequest(
  (oldPath: string, newName: string) => {
    // fsApi.rename 接受完整新路径，不再内部拼接 parentDir
    const parentDir = oldPath.includes("/") ? oldPath.substring(0, oldPath.lastIndexOf("/")) : "";
    const newPath = parentDir ? `${parentDir}/${newName}` : newName;
    return unwrap(fsApi.rename(envId!, oldPath, newPath));
  },
```

- [ ] **Step 5: 修改删除调用**

当前第 167 行：
```typescript
const { run: runDelete } = useRequest((path: string) => unwrap(userFileApi.batchDelete(envId!, [path])), {
```

替换为：
```typescript
const { run: runDelete } = useRequest((path: string) => unwrap(fsApi.batchDelete(envId!, [path])), {
```

- [ ] **Step 6: 修改 mkdir 调用**

当前第 180 行：
```typescript
const { run: runMkdir } = useRequest((path: string) => unwrap(userFileApi.mkdir(envId!, path)), {
```

替换为：
```typescript
const { run: runMkdir } = useRequest((path: string) => unwrap(fsApi.mkdir(envId!, path)), {
```

- [ ] **Step 7: 修改 newFile 调用**

当前第 187 行：
```typescript
const { run: runNewFile } = useRequest((path: string) => unwrap(fileApi.writeFile(envId!, path, "")), {
```

替换为：
```typescript
const { run: runNewFile } = useRequest((path: string) => unwrap(fsApi.writeFile(envId!, path, "")), {
```

- [ ] **Step 8: 修改 uploadFiles 中的 XHR URL**

当前第 199~207 行：
```typescript
const targetDir = selectedDir || "user";
...
const url = `/web/environments/${envId}/user/${targetDir}`;
```

替换为：
```typescript
const targetDir = selectedDir || "";
...
const url = targetDir
  ? `/web/environments/${envId}/fs/${targetDir}`
  : `/web/environments/${envId}/fs`;
```

- [ ] **Step 9: 修改 download-zip URL**

当前第 422~424 行：
```typescript
const withUserPrefix = nodePath.startsWith("user/") ? nodePath : `user/${nodePath}`;
url = `/web/environments/${envId}/user-file/download-zip?path=${encodePathSegment(withUserPrefix)}`;
```

替换为：
```typescript
url = `/web/environments/${envId}/fs/download-zip?path=${encodePathSegment(nodePath)}`;
```

- [ ] **Step 10: 运行预检查 + 前端构建**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck && bun run build:web
```

- [ ] **Step 11: 提交**

```bash
git add web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat(fs): FileTreeTab 切换到 fsApi"
```
