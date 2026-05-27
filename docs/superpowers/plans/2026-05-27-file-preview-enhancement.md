# 文件预览增强实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 增强 ArtifactsPanel 中 PreviewTab 的文件预览能力，支持代码语法高亮（shiki）、图片内联预览、PDF iframe 预览、二进制文件信息展示。

**Architecture:** 按文件类型拆分为独立预览子组件（`CodePreview`/`ImagePreview`/`PdfPreview`/`BinaryInfoPreview`），`PreviewTab` 作为路由组件根据扩展名分发。文件类型分类逻辑集中在 `preview/utils.ts` 工具函数中。

**Tech Stack:** React 19, TypeScript, shiki 4.1 (已有依赖), lucide-react, react-i18next, Tailwind CSS v4

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/src/components/agent-panel/preview/utils.ts` | 文件类型分类 + shiki 语言映射 |
| Create | `web/src/components/agent-panel/preview/CodePreview.tsx` | shiki 语法高亮渲染 |
| Create | `web/src/components/agent-panel/preview/ImagePreview.tsx` | 图片内联预览 |
| Create | `web/src/components/agent-panel/preview/PdfPreview.tsx` | PDF iframe 预览 |
| Create | `web/src/components/agent-panel/preview/BinaryInfoPreview.tsx` | 二进制文件信息卡片 |
| Modify | `web/src/components/agent-panel/PreviewTab.tsx` | 文件类型路由分发 |
| Modify | `web/src/i18n/locales/en/components.json` | 英文翻译 |
| Modify | `web/src/i18n/locales/zh/components.json` | 中文翻译 |

---

### Task 1: 添加 i18n 翻译键

**Files:**
- Modify: `web/src/i18n/locales/en/components.json`
- Modify: `web/src/i18n/locales/zh/components.json`

- [ ] **Step 1: 在 en/components.json 的 fileTree.preview 对象中添加新键**

将 `fileTree.preview` 对象替换为：

```json
    "preview": {
      "title": "Preview",
      "loading": "Loading...",
      "notTextFile": "Cannot preview binary file",
      "fetchFailed": "Failed to load file content",
      "noFileSelected": "Select a file to preview",
      "modifiedAt": "Modified",
      "unsupportedType": "This file type cannot be previewed",
      "fileSize": "File size",
      "fileType": "File type",
      "pdfLoadFailed": "Failed to load PDF"
    }
```

- [ ] **Step 2: 在 zh/components.json 的 fileTree.preview 对象中添加新键**

将 `fileTree.preview` 对象替换为：

```json
    "preview": {
      "title": "预览",
      "loading": "加载中...",
      "notTextFile": "无法预览二进制文件",
      "fetchFailed": "加载文件内容失败",
      "noFileSelected": "选择文件以预览",
      "modifiedAt": "修改时间",
      "unsupportedType": "此文件类型不支持预览",
      "fileSize": "文件大小",
      "fileType": "文件类型",
      "pdfLoadFailed": "加载 PDF 失败"
    }
```

- [ ] **Step 3: 验证 JSON 格式正确**

Run: `bun -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/en/components.json','utf8')); JSON.parse(require('fs').readFileSync('web/src/i18n/locales/zh/components.json','utf8')); console.log('OK')"`

Expected: `OK`

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/locales/en/components.json web/src/i18n/locales/zh/components.json
git commit -m "feat: 添加文件预览增强 i18n 翻译键"
```

---

### Task 2: 创建文件类型分类工具函数

**Files:**
- Create: `web/src/components/agent-panel/preview/utils.ts`

- [ ] **Step 1: 创建 utils.ts**

```typescript
export type FileCategory = "code" | "image" | "pdf" | "binary";

const CODE_EXTENSIONS = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "go",
  "rs",
  "rb",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "cs",
  "swift",
  "kt",
  "r",
  "scala",
  "lua",
  "perl",
  "sh",
  "bash",
  "zsh",
  "fish",
  "ps1",
  "json",
  "jsonc",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "css",
  "scss",
  "less",
  "sass",
  "html",
  "htm",
  "xml",
  "svg",
  "vue",
  "svelte",
  "md",
  "mdx",
  "sql",
  "graphql",
  "gql",
  "proto",
  "dockerfile",
  "makefile",
  "cmake",
  "gradle",
  "lock",
  "log",
  "txt",
  "env",
  "gitignore",
  "editorconfig",
  "prettierrc",
  "eslintrc",
  "properties",
  "tf",
  "hcl",
  "dart",
  "zig",
  "nim",
  "ex",
  "exs",
  "erl",
  "hs",
  "ml",
  "fs",
  "clj",
  "lisp",
  "v",
  "vhd",
  "asm",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"]);

const EXT_TO_SHIKI_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  c: "c",
  cpp: "cpp",
  h: "c",
  hpp: "cpp",
  cs: "csharp",
  swift: "swift",
  kt: "kotlin",
  r: "r",
  scala: "scala",
  lua: "lua",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  fish: "shell",
  ps1: "powershell",
  json: "json",
  jsonc: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  xml: "xml",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  mdx: "mdx",
  sql: "sql",
  graphql: "graphql",
  gql: "graphql",
  proto: "protobuf",
  dart: "dart",
  zig: "zig",
  nim: "nim",
  ex: "elixir",
  exs: "elixir",
  hs: "haskell",
  tf: "hcl",
  hcl: "hcl",
};

function getExtension(filePath: string): string {
  const segments = filePath.split("/");
  const fileName = segments[segments.length - 1] ?? "";
  const dotIndex = fileName.lastIndexOf(".");
  if (dotIndex === -1 || dotIndex === 0) return fileName.toLowerCase();
  return fileName.slice(dotIndex + 1).toLowerCase();
}

export function classifyFile(filePath: string): FileCategory {
  const ext = getExtension(filePath);
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "binary";
}

export function getShikiLanguage(filePath: string): string | undefined {
  const ext = getExtension(filePath);
  return EXT_TO_SHIKI_LANG[ext];
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/preview/utils.ts
git commit -m "feat: 添加文件类型分类和 shiki 语言映射工具函数"
```

---

### Task 3: 创建 BinaryInfoPreview 组件

**Files:**
- Create: `web/src/components/agent-panel/preview/BinaryInfoPreview.tsx`

- [ ] **Step 1: 创建 BinaryInfoPreview 组件**

```tsx
import { File } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { formatFileSize } from "./utils";

interface BinaryInfoPreviewProps {
  filePath: string;
  fileSize?: number;
}

export function BinaryInfoPreview({ filePath, fileSize }: BinaryInfoPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const fileName = filePath.split("/").pop() ?? filePath;
  const ext = filePath.split(".").pop()?.toUpperCase() ?? "FILE";

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3 max-w-xs text-center">
        <div className="w-16 h-16 rounded-xl bg-surface-2 flex items-center justify-center">
          <File className="h-8 w-8 text-text-muted" />
        </div>
        <p className="text-sm font-medium text-text-primary break-all">{fileName}</p>
        <div className="flex flex-col gap-1 text-xs text-text-muted">
          <span>
            {t("fileTree.preview.fileType")}: {ext}
          </span>
          {fileSize !== undefined && (
            <span>
              {t("fileTree.preview.fileSize")}: {formatFileSize(fileSize)}
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted mt-2">{t("fileTree.preview.unsupportedType")}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/preview/BinaryInfoPreview.tsx
git commit -m "feat: 添加 BinaryInfoPreview 二进制文件信息卡片组件"
```

---

### Task 4: 创建 ImagePreview 组件

**Files:**
- Create: `web/src/components/agent-panel/preview/ImagePreview.tsx`

- [ ] **Step 1: 创建 ImagePreview 组件**

图片通过后端文件 API 的 HTTP URL 直接加载（`/web/environments/:id/user/:path`），不经过 `readFile` API。

```tsx
import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";

interface ImagePreviewProps {
  envId: string;
  filePath: string;
}

export function ImagePreview({ envId, filePath }: ImagePreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const src = `/web/environments/${envId}/user/${filePath}`;

  const handleLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setError(true);
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
      {loading && (
        <Loader2 className="h-6 w-6 animate-spin text-text-muted" />
      )}
      {error && (
        <p className="text-sm text-status-error">{t("fileTree.preview.fetchFailed")}</p>
      )}
      <img
        src={src}
        alt={filePath.split("/").pop() ?? ""}
        onLoad={handleLoad}
        onError={handleError}
        className="max-w-full max-h-full object-contain"
        style={{ display: loading || error ? "none" : "block" }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/preview/ImagePreview.tsx
git commit -m "feat: 添加 ImagePreview 图片内联预览组件"
```

---

### Task 5: 创建 PdfPreview 组件

**Files:**
- Create: `web/src/components/agent-panel/preview/PdfPreview.tsx`

- [ ] **Step 1: 创建 PdfPreview 组件**

```tsx
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";

interface PdfPreviewProps {
  envId: string;
  filePath: string;
}

export function PdfPreview({ envId, filePath }: PdfPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [error, setError] = useState(false);
  const src = `/web/environments/${envId}/user/${filePath}`;

  const handleError = useCallback(() => {
    setError(true);
  }, []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-text-muted">{t("fileTree.preview.pdfLoadFailed")}</p>
      </div>
    );
  }

  return (
    <iframe
      src={src}
      className="w-full h-full border-0"
      title={filePath.split("/").pop() ?? "PDF"}
      onError={handleError}
    />
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/preview/PdfPreview.tsx
git commit -m "feat: 添加 PdfPreview iframe 预览组件"
```

---

### Task 6: 创建 CodePreview 组件

**Files:**
- Create: `web/src/components/agent-panel/preview/CodePreview.tsx`

- [ ] **Step 1: 创建 CodePreview 组件**

shiki v4 的 `codeToHtml` API：`codeToHtml(code, { lang, theme })` 返回 `Promise<string>`，输出带语法高亮的 HTML。行号通过 CSS counter 实现（shiki 输出的每行带有 `class="line"` 的 `<span>`）。

```tsx
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { codeToHtml } from "shiki";
import { getShikiLanguage } from "./utils";

interface CodePreviewProps {
  content: string;
  filePath: string;
}

export function CodePreview({ content, filePath }: CodePreviewProps) {
  const [html, setHtml] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const highlight = useCallback(async () => {
    setLoading(true);
    try {
      const lang = getShikiLanguage(filePath) ?? "text";
      const result = await codeToHtml(content, {
        lang,
        theme: "github-dark-default",
      });
      setHtml(result);
    } catch {
      // fallback: 纯文本带手动换行
      const escaped = content
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
      setHtml(escaped);
    } finally {
      setLoading(false);
    }
  }, [content, filePath]);

  useEffect(() => {
    highlight();
  }, [highlight]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto">
      <style>{`
        .shiki-preview {
          counter-reset: line;
          font-size: 12px;
          line-height: 1.6;
          padding: 16px;
          margin: 0;
          background: transparent !important;
        }
        .shiki-preview .line {
          counter-increment: line;
          display: block;
          padding-left: 3.5em;
          position: relative;
          min-height: 1.6em;
        }
        .shiki-preview .line::before {
          content: counter(line);
          position: absolute;
          left: 0;
          width: 2.5em;
          text-align: right;
          color: rgba(255, 255, 255, 0.25);
          user-select: none;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
      {/* eslint-disable-next-line react/no-danger */}
      <pre
        className="shiki-preview font-mono whitespace-pre-wrap break-words"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki 输出的可信 HTML
        dangerouslySetInnerHTML={{ __html: html ?? "" }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/preview/CodePreview.tsx
git commit -m "feat: 添加 CodePreview shiki 语法高亮组件"
```

---

### Task 7: 改造 PreviewTab 为文件类型路由

**Files:**
- Modify: `web/src/components/agent-panel/PreviewTab.tsx`

- [ ] **Step 1: 重写 PreviewTab**

将现有 `PreviewTab.tsx` 完整替换为以下内容。核心变化：根据 `classifyFile()` 分发到对应预览子组件，代码文件仍走 `readFile` API 获取 content，图片/PDF 直接构造 URL，二进制文件走 API 获取元信息。

```tsx
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/sdk";
import { NS } from "../../i18n";
import { BinaryInfoPreview } from "./preview/BinaryInfoPreview";
import { CodePreview } from "./preview/CodePreview";
import { ImagePreview } from "./preview/ImagePreview";
import { PdfPreview } from "./preview/PdfPreview";
import { classifyFile } from "./preview/utils";

interface PreviewTabProps {
  envId: string | null;
  filePath: string | null;
}

export function PreviewTab({ envId, filePath }: PreviewTabProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [content, setContent] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const category = filePath ? classifyFile(filePath) : null;

  const loadFile = useCallback(async () => {
    if (!envId || !filePath) {
      setContent(null);
      setFileName(null);
      setError(null);
      setFileSize(undefined);
      return;
    }

    const cat = classifyFile(filePath);

    // 图片和 PDF 不需要通过 readFile API，直接由子组件构造 URL
    if (cat === "image" || cat === "pdf") {
      setContent(null);
      setFileName(filePath.split("/").pop() ?? filePath);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const normalized = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
    const { data, error: err } = await fileApi.readFile({ id: envId, path: normalized });
    if (err) {
      console.error("Failed to load file:", err);
      setError(t("fileTree.preview.fetchFailed"));
      setContent(null);
    } else if (data && typeof data.content === "string") {
      setContent(data.content);
      setFileName(data.name || normalized.split("/").pop() || normalized);
      setFileSize(data.size);
    } else if (data && typeof data.name === "string") {
      setContent(null);
      setFileName(data.name);
      setFileSize(data.size);
    } else {
      setContent(null);
      setError(t("fileTree.preview.notTextFile"));
      setFileName(normalized.split("/").pop() || normalized);
    }
    setLoading(false);
  }, [envId, filePath, t]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  // 读取文件名（供 header 显示）
  const displayName = fileName ?? (filePath ? filePath.split("/").pop() : null);

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      {displayName && (
        <div className="px-3 py-2 border-b border-border text-xs text-text-muted font-display truncate">
          {displayName}
        </div>
      )}
      <div className="flex-1 overflow-auto flex flex-col">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {!loading && error && <div className="p-4 text-center text-sm text-status-error">{error}</div>}
        {!loading && !error && !filePath && !fileName && (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</div>
        )}
        {!loading && !error && category === "code" && content !== null && (
          <CodePreview content={content} filePath={filePath!} />
        )}
        {!loading && !error && category === "image" && envId && (
          <ImagePreview envId={envId} filePath={filePath!} />
        )}
        {!loading && !error && category === "pdf" && envId && (
          <PdfPreview envId={envId} filePath={filePath!} />
        )}
        {!loading && !error && category === "binary" && (
          <BinaryInfoPreview filePath={filePath!} fileSize={fileSize} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/components/agent-panel/PreviewTab.tsx
git commit -m "feat: 改造 PreviewTab 为文件类型路由分发"
```

---

### Task 8: 运行 precheck 验证代码质量

**Files:**
- 无新文件

- [ ] **Step 1: 运行 biome 格式化**

Run: `npx biome format --write web/src/components/agent-panel/preview/ web/src/components/agent-panel/PreviewTab.tsx`

- [ ] **Step 2: 运行 biome import 排序**

Run: `npx biome check --write --linter-enabled=false web/src/components/agent-panel/preview/ web/src/components/agent-panel/PreviewTab.tsx`

- [ ] **Step 3: 运行 tsc 类型检查**

Run: `npx tsc --noEmit -p web/tsconfig.json`

Expected: 无错误

- [ ] **Step 4: 运行 biome lint**

Run: `npx biome check web/src/components/agent-panel/preview/ web/src/components/agent-panel/PreviewTab.tsx`

Expected: 无错误

- [ ] **Step 5: 如有自动修复，提交修正**

```bash
git add -A
git commit -m "style: 文件预览组件代码格式化与 lint 修正" || true
```

---

### Task 9: 构建前端并验证

**Files:**
- 无新文件

- [ ] **Step 1: 构建前端**

Run: `bun run build:web`

Expected: 构建成功，无错误

- [ ] **Step 2: 提交构建产物（如有变更）**

```bash
git add -A
git commit -m "build: 文件预览增强前端构建" || true
```

---

## Self-Review

### Spec Coverage

| Spec 需求 | 对应 Task |
|-----------|-----------|
| 代码文件 shiki 语法高亮 | Task 6 (CodePreview) |
| shiki 自动语言识别 | Task 2 (utils.ts getShikiLanguage) |
| 显示行号 | Task 6 (CSS counter) |
| 图片内联预览 | Task 4 (ImagePreview) |
| PDF iframe 预览 | Task 5 (PdfPreview) |
| 二进制文件信息卡片 | Task 3 (BinaryInfoPreview) |
| PreviewTab 文件类型路由 | Task 7 |
| 文件类型分类工具函数 | Task 2 (utils.ts classifyFile) |
| i18n 翻译 | Task 1 |
| precheck 验证 | Task 8 |
| 构建验证 | Task 9 |

### Placeholder Scan

无 TBD/TODO/待定内容。所有步骤含完整代码。

### Type Consistency

- `classifyFile` 返回 `'code' | 'image' | 'pdf' | 'binary'` — Task 2 定义，Task 7 使用 — 一致
- `getShikiLanguage` 返回 `string | undefined` — Task 2 定义，Task 6 使用 — 一致
- `CodePreview` props: `content: string, filePath: string` — Task 6 定义，Task 7 传入 — 一致
- `ImagePreview` props: `envId: string, filePath: string` — Task 4 定义，Task 7 传入 — 一致
- `PdfPreview` props: `envId: string, filePath: string` — Task 5 定义，Task 7 传入 — 一致
- `BinaryInfoPreview` props: `filePath: string, fileSize?: number` — Task 3 定义，Task 7 传入 — 一致
- `formatFileSize` 参数 `bytes: number` — Task 2 定义，Task 3 使用 — 一致
