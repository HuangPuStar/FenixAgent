# 文件 Tab 增强计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 补齐文件 Tab 的基础操作能力：上传按钮、下载、新建空文件、上传到当前目录、上传进度反馈。

**Architecture:** 纯前端改动，后端 API 已全部就绪（`FileApi` + `UserFileApi`）。在 `FileTreeTab` 的工具栏增加按钮，利用已有 API 实现功能。下载通过 `preview=true` query param 让后端直接返回文件流，前端构造 `<a>` 标签触发下载。

**Tech Stack:** React 19 + TypeScript + Tailwind CSS + react-i18next + lucide-react

---

## File Structure

- **Modify:** `web/src/components/agent-panel/FileTreeTab.tsx` — 工具栏按钮、上传/下载/新建文件逻辑
- **Modify:** `web/src/i18n/locales/en/components.json` — 新增 fileTree 相关 i18n key
- **Modify:** `web/src/i18n/locales/zh/components.json` — 新增 fileTree 相关 i18n key

---

### Task 1: 添加 i18n key

**Files:**
- Modify: `web/src/i18n/locales/en/components.json` (fileTree 部分)
- Modify: `web/src/i18n/locales/zh/components.json` (fileTree 部分)

- [ ] **Step 1: 在两个 locale 文件的 fileTree 对象中添加新 key**

`en/components.json` fileTree 部分新增：

```json
"upload": "Upload",
"download": "Download",
"newFile": "New File",
"newFileName": "New file name",
"uploadProgress": "Uploading {{current}}/{{total}}...",
"uploadSuccess": "Uploaded {{count}} file(s)",
"uploadFailed": "Upload failed",
"downloadFailed": "Download failed"
```

`zh/components.json` fileTree 部分新增：

```json
"upload": "上传",
"download": "下载",
"newFile": "新建文件",
"newFileName": "新文件名",
"uploadProgress": "上传中 {{current}}/{{total}}...",
"uploadSuccess": "已上传 {{count}} 个文件",
"uploadFailed": "上传失败",
"downloadFailed": "下载失败"
```

- [ ] **Step 2: 验证构建**

Run: `bun run build:web`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json
git commit -m "feat(i18n): 添加文件 Tab 上传/下载/新建文件的 i18n key"
```

---

### Task 2: 添加上传按钮（点击选择文件）+ 上传到当前选中目录 + 进度提示

**Files:**
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`

当前 `FileTreeTab` 只支持拖拽上传且路径写死为 `user/`。改为：
1. 工具栏增加 Upload 按钮（`Upload` icon from lucide-react）
2. 隐藏 `<input type="file">` 由按钮触发
3. 上传目录取当前选中的目录（如果有选中文件则取其父目录）
4. 上传中显示 toast 进度

- [ ] **Step 1: 添加 Upload icon import 和 state**

在 `FileTreeTab.tsx` 顶部的 lucide-react import 中添加 `Upload`。

添加 state：
- `selectedDir: string | null` — 当前选中的目录路径（用于确定上传目标）
- `uploading: boolean` — 上传中状态
- `fileInputRef: React.RefObject<HTMLInputElement>` — 隐藏 file input 的 ref

- [ ] **Step 2: 在 handleSelect 中记录选中路径**

在现有的 `handleSelect` 回调中，当点击文件时记录其父目录到 `selectedDir`，当点击目录时记录目录自身：

```tsx
const handleSelect = useCallback(
  (nodeId: string | null, node: TreeNodeData) => {
    if (!nodeId) return;
    // 记录当前选中的目录
    const parsed = findNodeByPath(treeDataRef.current, nodeId);
    if (parsed?.isDir) {
      setSelectedDir(nodeId);
    } else {
      const parentDir = nodeId.substring(0, nodeId.lastIndexOf("/"));
      setSelectedDir(parentDir || null);
    }
    if (node.hasChildren === false || node.hasChildren === undefined) {
      onPreviewFile(nodeId);
    }
  },
  [onPreviewFile],
);
```

- [ ] **Step 3: 添加按钮点击上传逻辑**

在组件中添加上传处理函数和隐藏 input：

```tsx
const fileInputRef = useRef<HTMLInputElement>(null);

const handleUploadClick = useCallback(() => {
  fileInputRef.current?.click();
}, []);

const handleFileInputChange = useCallback(
  async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!envId) return;
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setUploading(true);
    try {
      const targetDir = selectedDir || "user";
      const formData = new FormData();
      for (const file of Array.from(files)) {
        formData.append("files", file);
      }
      const { error: uploadErr } = await fileApi.upload({ id: envId, path: targetDir }, formData);
      if (uploadErr) {
        toast.error(t("fileTree.uploadFailed"));
      } else {
        toast.success(t("fileTree.uploadSuccess", { count: files.length }));
        await loadTree();
      }
    } catch {
      toast.error(t("fileTree.uploadFailed"));
    } finally {
      setUploading(false);
      // 重置 input 以便重复选择同一文件
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  },
  [envId, selectedDir, loadTree, t],
);
```

需要在顶部 import `toast` from `"sonner"`。

- [ ] **Step 4: 修改拖拽上传路径**

将现有 `handleDrop` 中硬编码的 `targetSubdir = "user"` 改为使用 `selectedDir`：

```tsx
const handleDrop = useCallback(
  async (e: React.DragEvent) => {
    e.preventDefault();
    if (!envId) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    const targetSubdir = selectedDir || "user";
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      await fileApi.upload({ id: envId, path: targetSubdir }, formData);
      toast.success(t("fileTree.uploadSuccess", { count: files.length }));
      await loadTree();
    } catch {
      toast.error(t("fileTree.uploadFailed"));
    }
  },
  [envId, selectedDir, loadTree, t],
);
```

- [ ] **Step 5: 在工具栏添加 Upload 按钮**

在工具栏（`<div className="flex items-center gap-2 px-2 py-1.5 ...">`）的 RefreshCw 按钮后面添加 Upload 按钮：

```tsx
<button
  type="button"
  onClick={handleUploadClick}
  disabled={uploading || !envId}
  className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
  title={t("fileTree.upload")}
>
  <Upload className="h-3.5 w-3.5" />
</button>
<input
  ref={fileInputRef}
  type="file"
  multiple
  style={{ display: "none" }}
  onChange={handleFileInputChange}
/>
```

- [ ] **Step 6: 验证构建并 Commit**

Run: `bun run build:web`
Expected: 构建成功

```bash
git add web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat(file-tab): 添加上传按钮，支持上传到当前选中目录"
```

---

### Task 3: 添加下载功能

**Files:**
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`

后端 `GET /:id/user/*` 对非文本文件会返回 `Content-Disposition: attachment` header，可直接触发下载。对文本文件则返回 JSON。下载策略：构造带 `preview=true` 的 URL 让浏览器直接下载（后端会返回 stream + 正确 Content-Type），对于文本文件使用 Blob 下载。

- [ ] **Step 1: 添加 Download icon import**

在 lucide-react import 中添加 `Download`。

- [ ] **Step 2: 添加下载逻辑**

在组件中添加 `selectedFile: string | null` state（记录当前选中的文件路径），并在 `handleSelect` 中更新。然后添加下载函数：

```tsx
const [selectedFile, setSelectedFile] = useState<string | null>(null);

// 在 handleSelect 中添加 setSelectedFile(nodeId) 当点击文件时
```

下载函数：

```tsx
const handleDownload = useCallback(async () => {
  if (!envId || !selectedFile) return;
  try {
    // 使用 preview=true 让后端返回原始文件流
    const url = `/web/environments/${envId}/user/${selectedFile}?preview=true`;
    const a = document.createElement("a");
    a.href = url;
    a.download = selectedFile.split("/").pop() || "file";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } catch {
    toast.error(t("fileTree.downloadFailed"));
  }
}, [envId, selectedFile, t]);
```

注意：preview 模式需要 cookie 认证，`<a>` 标签发起的请求会自动携带 cookie，因此无需额外处理。

- [ ] **Step 3: 在工具栏添加 Download 按钮**

在 Upload 按钮后面添加：

```tsx
<button
  type="button"
  onClick={handleDownload}
  disabled={!selectedFile || !envId}
  className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
  title={t("fileTree.download")}
>
  <Download className="h-3.5 w-3.5" />
</button>
```

- [ ] **Step 4: 验证构建并 Commit**

Run: `bun run build:web`
Expected: 构建成功

```bash
git add web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat(file-tab): 添加文件下载按钮"
```

---

### Task 4: 添加新建空文件功能

**Files:**
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`

利用已有的 `fileApi.writeFile()` API（PUT `/web/environments/:id/user/*`），传入空字符串创建空文件。

- [ ] **Step 1: 添加 FilePlus icon import**

在 lucide-react import 中添加 `FilePlus`。

- [ ] **Step 2: 添加新建文件逻辑**

在组件中添加新建文件函数：

```tsx
const handleNewFile = useCallback(async () => {
  if (!envId) return;
  const name = window.prompt(t("fileTree.newFileName"));
  if (!name) return;
  const parentDir = selectedDir || "user";
  const fullPath = `${parentDir}/${name}`;
  const { error: writeErr } = await fileApi.writeFile({ id: envId, path: fullPath }, { content: "" });
  if (writeErr) {
    console.error("New file failed:", writeErr);
  } else {
    await loadTree();
  }
}, [envId, selectedDir, loadTree, t]);
```

- [ ] **Step 3: 在工具栏添加 New File 按钮**

在 Download 按钮后面添加：

```tsx
<button
  type="button"
  onClick={handleNewFile}
  disabled={!envId}
  className="h-7 w-7 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors disabled:opacity-50"
  title={t("fileTree.newFile")}
>
  <FilePlus className="h-3.5 w-3.5" />
</button>
```

- [ ] **Step 4: 在右键菜单中也添加新建文件选项**

在右键菜单的 "New Folder" 按钮后面，添加 "New File" 选项（仅在目录上显示）：

```tsx
{contextMenu.isDir && (
  <button
    type="button"
    className="flex w-full items-center gap-2 px-3 py-1.5 text-sm rounded-md transition-colors text-text-primary hover:bg-surface-2"
    onClick={() => {
      if (!envId) return;
      const name = window.prompt(t("fileTree.newFileName"));
      if (!name) return;
      const fullPath = `${contextMenu.path}/${name}`;
      fileApi.writeFile({ id: envId, path: fullPath }, { content: "" }).then(({ error: writeErr }) => {
        if (writeErr) console.error("New file failed:", writeErr);
        else loadTree();
      });
      setContextMenu(null);
    }}
  >
    {t("fileTree.newFile")}
  </button>
)}
```

- [ ] **Step 5: 验证构建并 Commit**

Run: `bun run build:web`
Expected: 构建成功

```bash
git add web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat(file-tab): 添加新建空文件功能（工具栏+右键菜单）"
```
