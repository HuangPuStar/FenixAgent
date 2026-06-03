# ArtifactsPanel 拖拽文件上传设计

## 概述

在 Agent 面板右侧 ArtifactsPanel 区域实现拖拽文件上传功能：用户从系统文件管理器拖拽文件到右侧面板时，显示全屏覆盖层提示，释放后上传文件到当前选中目录（默认 `user`），上传过程中显示进度条。

## 组件职责划分

| 组件 | 职责 |
|------|------|
| **ArtifactsPanel** | 管理 `isDragging` / `uploadProgress` 状态，渲染拖拽覆盖层 UI，drop 时委托给 FileTreeTab |
| **FileTreeTab** | 通过 `useImperativeHandle` 暴露 `uploadFiles(files, onProgress?)` 方法，封装带进度追踪的上传逻辑 |

## ArtifactsPanel 改动

### 新增状态

```typescript
const [isDragging, setIsDragging] = useState(false);
const [uploadProgress, setUploadProgress] = useState<{
  active: boolean;
  percent: number;
  fileName: string;
}>({ active: false, percent: 0, fileName: "" });
const dragCounterRef = useRef(0); // 处理子元素触发的 false dragLeave
const fileTreeRef = useRef<FileTreeTabHandle>(null);
```

### 拖拽事件处理

- `onDragEnter`：`dragCounterRef.current++`，设 `isDragging = true`
- `onDragOver`：`e.preventDefault()`，`e.dataTransfer.dropEffect = "copy"`
- `onDragLeave`：`dragCounterRef.current--`，计数器归零时设 `isDragging = false`
- `onDrop`：`dragCounterRef.current = 0`，`isDragging = false`，调用 `fileTreeRef.current.uploadFiles(files, onProgress)`

`onProgress` 回调更新 `uploadProgress` 状态。

### 覆盖层 UI

绑定到面板容器（`.agent-artifacts` 外层 div），两个状态：

**拖拽悬浮中**：
- 半透明背景：`bg-background/80 backdrop-blur-sm`
- 中心：Upload 图标 + "释放文件以上传" 文字 + 目标目录提示（如 "上传到: user/"）

**上传中**：
- 同一覆盖层切换为进度 UI
- 显示当前文件名 + 进度条 + 百分比数字
- 使用 shadcn `<Progress>` 组件

上传完成后覆盖层消失，toast 显示 "已上传 N 个文件"。

### 面板折叠状态

面板折叠时（`collapsed = true`）不渲染覆盖层，拖拽事件不绑定。

## FileTreeTab 改动

### 暴露 Handle

```typescript
export interface FileTreeTabHandle {
  uploadFiles: (files: File[], onProgress?: (percent: number) => void) => Promise<void>;
}
```

使用 `forwardRef` + `useImperativeHandle` 包装组件。

### uploadFiles 方法

1. 目标目录：取 `selectedDir`，默认 `"user"`
2. 用 `XMLHttpRequest` 替代 `fetch` 上传，以获取 `upload.onprogress` 事件
3. `onprogress` 中计算 `Math.round((loaded / total) * 100)` 并回调 `onProgress`
4. 上传完成后调用 `loadTree()` 刷新文件树
5. 错误时 throw，由 ArtifactsPanel 层捕获并 toast 提示

### 不改动的部分

- 现有按钮上传逻辑（file input / folder input）保持不变
- 现有文件树内拖拽上传（`handleDragOver` / `handleDrop`）保持不变
- 右键菜单、文件预览等逻辑不变

## i18n

在 `components` 命名空间下新增以下 key：

| key | en | zh |
|-----|----|----|
| `fileTree.dropToUpload` | Drop files to upload | 释放文件以上传 |
| `fileTree.uploadTo` | Upload to: {path} | 上传到: {path} |
| `fileTree.uploading` | Uploading... | 上传中... |
| `fileTree.uploadProgress` | {percent}% | {percent}% |

## 涉及文件

| 文件 | 改动类型 |
|------|---------|
| `web/src/pages/agent-panel/ArtifactsPanel.tsx` | 添加拖拽状态管理 + 覆盖层 UI |
| `web/src/components/agent-panel/FileTreeTab.tsx` | forwardRef + useImperativeHandle + uploadFiles 方法 |
| `web/src/i18n/locales/en/components.json` | 新增 i18n key |
| `web/src/i18n/locales/zh/components.json` | 新增 i18n key |
