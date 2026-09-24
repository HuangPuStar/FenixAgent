/**
 * 文件预览的「源判定」工具集（自 apps/web 的 `agent-panel/preview/utils.ts` 抽取并纯化）。
 *
 * 抽取时的纯化取舍：
 * 1. 只取源实现的扩展名分类表、`classifyFile`、`getPreviewMimeType`、`shouldLoadPreviewAsBlob`、
 *    `loadByteAccuratePreviewSource`。`buildPreviewUrl` 硬编码宿主路由，改为 `FileViewerPreview`
 *    的可选 prop 默认值；`encodePathSegment` 只有宿主路由实现需要，两处都已随宿主副本删除。
 * 2. **宿主副本已删除**（2026-09-22 前端去重）：`apps/web/src/components/agent-panel/preview/utils.ts`
 *    的对应段落原本逐字保留，但它当时已无生产消费方（`ArtifactsPanel` 走 `PreviewTab` → 本包），
 *    留下只会让扩展名分类表出现两份真相。该文件现在只剩宿主专有的 `normalizeToUserPath`。
 * 3. 本模块不依赖 React、路由和请求单例；`loadByteAccuratePreviewSource` 的取数函数由调用方注入
 *    （**没有全局 `fetch` 兜底**，见 `PreviewFetch`），因此可独立测试，也不会把宿主的鉴权/代理策略带进包内。
 */

/**
 * 预览源文件的取数函数，由宿主注入（`FileViewerPreview` 的 `fetchPreview`）。
 *
 * **为什么必须注入、且不给全局 `fetch` 兜底**：预览 URL 指向后端的文件代理路由，取数属后端调用；
 * 本包是纯展示包、依赖矩阵不允许它依赖 `@fenix/web-runtime`，兜底会让组件重新直连后端并自行拼 URL
 * （§5.8：禁止在组件中裸调 `fetch` / 拼装后端 URL）。宿主的实现见 `apps/web/src/api/fs.ts` 的
 * `readPreviewSource`（能力缺口登记在 §5.3）。
 */
export type PreviewFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FileCategory = "code" | "image" | "pdf" | "binary" | "table" | "markdown" | "html" | "office";

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

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "bmp",
  "svg",
  "tiff",
  "tif",
  "heic",
  "heif",
]);

const TABLE_EXTENSIONS = new Set(["csv", "xlsx", "xls", "xlsm", "xlsb"]);

const OFFICE_EXTENSIONS = new Set(["docx", "doc", "pptx", "ppt", "odt", "odp", "ods", "rtf", "wps", "et", "dps"]);

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

const HTML_EXTENSIONS = new Set(["html", "htm"]);

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
  if (TABLE_EXTENSIONS.has(ext)) return "table";
  if (OFFICE_EXTENSIONS.has(ext)) return "office"; // officePlugin 支持，不属于 binary
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "binary";
}

/**
 * 获取预览组件使用的文本 MIME 类型。
 * @open-file-viewer 会把文件名中的 # 当作 URL fragment，导致 #123.txt 的扩展名丢失；
 * 显式传入文本 MIME 后仍能匹配 textPlugin，同时不需要修改用户看到的原始文件名。
 */
export function getPreviewMimeType(filePath: string): string | undefined {
  const ext = getExtension(filePath);
  if (MARKDOWN_EXTENSIONS.has(ext)) return "text/markdown";
  if (HTML_EXTENSIONS.has(ext)) return "text/html";
  if (CODE_EXTENSIONS.has(ext)) return "text/plain";
  return;
}

/**
 * URL 形式的文本源会让 @open-file-viewer 在元数据缺失时退化为 `text.length`，
 * 把字符数误显示为字节数。HTML 需要保留 URL 供 sandbox iframe 渲染，因此不在此转换。
 */
export function shouldLoadPreviewAsBlob(filePath: string): boolean {
  const category = classifyFile(filePath);
  return category === "code" || category === "markdown";
}

/**
 * 预览源加载失败：**结构化错误，带 HTTP 状态码**。
 *
 * 为什么不是抛一条文案：本模块是纯逻辑模块，不 import UI i18n（§9.3），而错误是要给用户看的——
 * 2026-09-23（第 19 轮）之前这里抛的是写死的中文 `文件预览加载失败 (500)`，调用方只能原样上屏
 * （既固定中文、又把原始消息当界面文案）。现在文案由调用方按当前语言取字典
 * （`FileViewerPreview` 用 `fileTree.preview.loadFailed` 插 `status`），`message` 只留给日志与调试。
 */
export class PreviewSourceError extends Error {
  /** 触发失败的 HTTP 状态码（响应非 2xx 时的 `response.status`）。 */
  readonly status: number;

  constructor(status: number) {
    super(`preview source request failed (HTTP ${status})`);
    this.name = "PreviewSourceError";
    this.status = status;
  }
}

/**
 * 将文本预览响应保留为 Blob，使预览器使用原始响应字节数并自行按 BOM 解码。
 * 非成功响应必须在进入预览器前显式失败，避免把错误页当作文件内容展示。
 */
export async function loadByteAccuratePreviewSource(
  previewUrl: string,
  fetchPreview: PreviewFetch,
  init?: RequestInit,
): Promise<Blob> {
  const response = await fetchPreview(previewUrl, init);
  if (!response.ok) throw new PreviewSourceError(response.status);
  return response.blob();
}
