# ArtifactsPanel 拖拽文件上传 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在右侧 ArtifactsPanel 区域实现拖拽文件上传，带覆盖层提示和上传进度显示。

**Architecture:** ArtifactsPanel 管理拖拽状态和覆盖层 UI，通过 ref 调用 FileTreeTab 暴露的 `uploadFiles` 方法。上传使用 XMLHttpRequest 获取进度事件，现有按钮上传逻辑不受影响。

**Tech Stack:** React 19, forwardRef + useImperativeHandle, XMLHttpRequest (progress), lucide-react, i18next, sonner toast

---

### Task 1: 添加 Progress 组件

**Files:**
- Create: `web/components/ui/progress.tsx`

- [ ] **Step 1: 用 shadcn CLI 添加 Progress 组件**

Run:
```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx shadcn@latest add progress
```

Expected: `web/components/ui/progress.tsx` 被创建

- [ ] **Step 2: 验证文件存在**

Run:
```bash
ls -la web/components/ui/progress.tsx
```

Expected: 文件存在，无报错

- [ ] **Step 3: 提交**

```bash
git add web/components/ui/progress.tsx
git commit -m "feat(ui): 添加 shadcn Progress 组件"
```

---

### Task 2: 添加 i18n 翻译 key

**Files:**
- Modify: `web/src/i18n/locales/en/components.json`
- Modify: `web/src/i18n/locales/zh/components.json`

- [ ] **Step 1: 在 `en/components.json` 的 `fileTree` 对象中添加新 key**

在 `"uploadFailed": "Upload failed"` 之后、`"downloadZip"` 之前，添加：

```json
"dropToUpload": "Drop files to upload",
"uploadTo": "Upload to: {{path}}",
"uploadingFile": "Uploading {{name}}...",
"uploadingProgress": "{{percent}}%"
```

完整 `fileTree` 部分变为：
```json
"fileTree": {
  "refresh": "Refresh",
  "emptyState": "No files in workspace",
  "upload": "Upload",
  "download": "Download",
  "newFile": "New File",
  "newFileName": "New file name",
  "uploadFolder": "Upload Folder",
  "uploadSuccess": "Uploaded {{count}} file(s)",
  "uploadFailed": "Upload failed",
  "dropToUpload": "Drop files to upload",
  "uploadTo": "Upload to: {{path}}",
  "uploadingFile": "Uploading {{name}}...",
  "uploadingProgress": "{{percent}}%",
  "downloadZip": "Download ZIP",
  "downloadFailed": "Download failed",
  "contextMenu": {
    ...
  },
  ...
}
```

- [ ] **Step 2: 在 `zh/components.json` 的 `fileTree` 对象中添加对应中文 key**

同样在 `"uploadFailed"` 之后、`"downloadZip"` 之前：

```json
"dropToUpload": "释放文件以上传",
"uploadTo": "上传到: {{path}}",
"uploadingFile": "正在上传 {{name}}...",
"uploadingProgress": "{{percent}}%"
```

- [ ] **Step 3: 验证 JSON 格式正确**

Run:
```bash
python3 -c "import json; json.load(open('web/src/i18n/locales/en/components.json')); print('en OK')"
python3 -c "import json; json.load(open('web/src/i18n/locales/zh/components.json')); print('zh OK')"
```

Expected: 两个输出 `OK`

- [ ] **Step 4: 提交**

```bash
git add web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json
git commit -m "feat(i18n): 添加拖拽上传相关翻译 key"
```

---

### Task 3: FileTreeTab 暴露 uploadFiles 方法

**Files:**
- Modify: `web/src/components/agent-panel/FileTreeTab.tsx`

- [ ] **Step 1: 添加 forwardRef 包装和 FileTreeTabHandle 接口**

在文件顶部导入区添加 `forwardRef` 和 `useImperativeHandle`：

```typescript
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
```

在 `FileTreeTab` 组件定义之前（`parsePathsToTree` 和 `parsedToTreeNodeData` 函数之后），添加接口：

```typescript
export interface FileTreeTabHandle {
  uploadFiles: (files: File[], onProgress?: (percent: number) => void) => Promise<void>;
}
```

- [ ] **Step 2: 将 `FileTreeTab` 函数改为 `forwardRef` 包装**

将：
```typescript
export function FileTreeTab({ envId, onPreviewFile, onReferenceFile }: FileTreeTabProps) {
```

改为：
```typescript
export const FileTreeTab = forwardRef<FileTreeTabHandle, FileTreeTabProps>(
  function FileTreeTab({ envId, onPreviewFile, onReferenceFile }, ref) {
```

在组件函数体内部（所有 state 声明之后），添加 `useImperativeHandle`：

```typescript
useImperativeHandle(ref, () => ({
  uploadFiles: async (files: File[], onProgress?: (percent: number) => void) => {
    if (!envId || files.length === 0) return;

    const targetDir = selectedDir || "user";
    const formData = new FormData();
    for (const file of files) {
      formData.append("files", file);
    }

    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      const url = `/web/environments/${envId}/user/${targetDir}`;

      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`));
        }
      };

      xhr.onerror = () => reject(new Error("Upload network error"));
      xhr.open("POST", url);
      xhr.withCredentials = true;
      xhr.send(formData);
    });

    await loadTree();
  },
}), [envId, selectedDir, loadTree]);
```

在组件函数末尾，将闭合 `}` 改为 `}`) 完成前向引用包装。

- [ ] **Step 3: 验证 TypeScript 编译**

Run:
```bash
cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20
```

Expected: 无错误或仅有无关的错误

- [ ] **Step 4: 提交**

```bash
git add web/src/components/agent-panel/FileTreeTab.tsx
git commit -m "feat(file-tree): 暴露 uploadFiles 方法支持外部拖拽上传"
```

---

### Task 4: ArtifactsPanel 添加拖拽覆盖层

**Files:**
- Modify: `web/src/pages/agent-panel/ArtifactsPanel.tsx`

- [ ] **Step 1: 添加导入**

在 `ArtifactsPanel.tsx` 顶部导入区添加：

```typescript
import { Upload } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
```

同时添加 `FileTreeTab` 的 handle 类型和 Progress 组件导入：

```typescript
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { Progress } from "@/components/ui/progress";
```

注意：移除原有的 `FolderTree` 导入（如果不再直接使用），保留其他不变。`FolderTree` 仍在 tab bar 中使用所以保留。

- [ ] **Step 2: 添加拖拽和进度状态**

在 `ArtifactsPanel` 函数体内，`const [previewFilePath, setPreviewFilePath]` 之后添加：

```typescript
const [isDragging, setIsDragging] = useState(false);
const [uploadProgress, setUploadProgress] = useState<{
  active: boolean;
  percent: number;
  fileName: string;
}>({ active: false, percent: 0, fileName: "" });
const dragCounterRef = useRef(0);
const fileTreeRef = useRef<FileTreeTabHandle>(null);
```

- [ ] **Step 3: 添加拖拽事件处理函数**

在 `handleReferenceFile` 之后、`if (collapsed)` 之前添加：

```typescript
const handleDragEnter = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  dragCounterRef.current++;
  setIsDragging(true);
}, []);

const handleDragOver = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
}, []);

const handleDragLeave = useCallback((e: React.DragEvent) => {
  e.preventDefault();
  dragCounterRef.current--;
  if (dragCounterRef.current <= 0) {
    dragCounterRef.current = 0;
    setIsDragging(false);
  }
}, []);

const handleDrop = useCallback(
  async (e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    setUploadProgress({ active: true, percent: 0, fileName: files[0].name });

    try {
      await fileTreeRef.current?.uploadFiles(files, (percent) => {
        setUploadProgress((prev) => ({ ...prev, percent }));
      });
      toast.success(t("fileTree.uploadSuccess", { count: files.length }));
    } catch {
      toast.error(t("fileTree.uploadFailed"));
    } finally {
      setUploadProgress({ active: false, percent: 0, fileName: "" });
    }
  },
  [t],
);
```

注意需要在顶部添加 `toast` 导入：`import { toast } from "sonner";`

- [ ] **Step 4: 将拖拽事件绑定到面板容器，传递 ref 给 FileTreeTab**

在 JSX 中，将最外层 `<div className="relative flex shrink-0">` 添加拖拽事件：

```tsx
<div
  className="relative flex shrink-0"
  onDragEnter={handleDragEnter}
  onDragOver={handleDragOver}
  onDragLeave={handleDragLeave}
  onDrop={handleDrop}
>
```

将 `<FileTreeTab>` 改为接收 ref：

```tsx
<FileTreeTab ref={fileTreeRef} envId={envId} onPreviewFile={handlePreviewFile} onReferenceFile={handleReferenceFile} />
```

- [ ] **Step 5: 添加覆盖层 JSX**

在面板容器 `<div className="relative flex shrink-0">` 的关闭标签之前、即 `</div>` 之前，添加覆盖层：

```tsx
{/* 拖拽覆盖层 */}
{(isDragging || uploadProgress.active) && (
  <div className="absolute inset-0 z-20 flex flex-col items-center justify-center rounded-lg bg-background/80 backdrop-blur-sm">
    {uploadProgress.active ? (
      <>
        <Upload className="h-8 w-8 mb-3 text-brand animate-pulse" />
        <p className="text-sm text-text-primary mb-2">
          {t("fileTree.uploadingFile", { name: uploadProgress.fileName })}
        </p>
        <div className="w-48">
          <Progress value={uploadProgress.percent} className="h-1.5" />
        </div>
        <p className="text-xs text-text-muted mt-1">
          {t("fileTree.uploadingProgress", { percent: uploadProgress.percent })}
        </p>
      </>
    ) : (
      <>
        <Upload className="h-10 w-10 mb-3 text-brand" />
        <p className="text-sm font-medium text-text-primary mb-1">
          {t("fileTree.dropToUpload")}
        </p>
        <p className="text-xs text-text-muted">
          {t("fileTree.uploadTo", { path: "user/" })}
        </p>
      </>
    )}
  </div>
)}
```

- [ ] **Step 6: 验证 TypeScript 编译**

Run:
```bash
cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20
```

Expected: 无错误

- [ ] **Step 7: 提交**

```bash
git add web/src/pages/agent-panel/ArtifactsPanel.tsx
git commit -m "feat(artifacts-panel): 拖拽文件上传覆盖层和进度显示"
```

---

### Task 5: 运行 precheck 验证

**Files:** 无新改动

- [ ] **Step 1: 运行 precheck**

Run:
```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

Expected: 全部通过（格式化、import 排序、tsc、biome check）

- [ ] **Step 2: 如有自动修复，确认改动合理后提交**

如果 `biome format --write` 或 `biome check --write` 修改了文件，检查 diff 确认是格式化修复，然后：

```bash
git add -A
git commit -m "style: precheck 自动修复格式"
```
