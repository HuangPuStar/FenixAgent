/**
 * 文件预览的「源判定」工具集（自 apps/web 的 `agent-panel/preview/utils.ts` 抽取并纯化）。
 *
 * 抽取时的纯化取舍：
 * 1. 只取源实现的扩展名分类表、`classifyFile`、`getPreviewMimeType`、`shouldLoadPreviewAsBlob`、
 *    `loadByteAccuratePreviewSource`。`buildPreviewUrl` 硬编码宿主路由，改为 `FileViewerPreview`
 *    的可选 prop 默认值；`encodePathSegment` 只有宿主路由实现需要，两处都已随宿主副本删除。
 * 2. **宿主副本已删除**（2026-09-22 前端去重）：`apps/web/src/shell/artifacts/preview/utils.ts`
 *    的对应段落原本逐字保留，但它当时已无生产消费方（`ArtifactsPanel` 走 `PreviewTab` → 本包），
 *    留下只会让扩展名分类表出现两份真相。该文件当时只剩 `normalizeToUserPath`，2026-09-24 随台账 D2
 *    整份迁入 `@fenix/resource-machine/web` 的 `web/lib/normalize-to-user-path.ts`，宿主不再保留该路径。
 * 3. 本模块不依赖 React、路由和请求单例；`loadByteAccuratePreviewSource` 的取数函数由调用方注入
 *    （**没有全局 `fetch` 兜底**，见 `PreviewFetch`），因此可独立测试，也不会把宿主的鉴权/代理策略带进包内。
 */

/**
 * 预览源文件的取数函数，由宿主注入（`FileViewerPreview` 的 `fetchPreview`）。
 *
 * **为什么必须注入、且不给全局 `fetch` 兜底**：预览 URL 指向后端的文件代理路由，取数属后端调用；
 * 本包是纯展示包、依赖矩阵不允许它依赖 `@fenix/web-runtime`，兜底会让组件重新直连后端并自行拼 URL
 * （§5.8：禁止在组件中裸调 `fetch` / 拼装后端 URL）。文件域 owner 包的实现见
 * `@fenix/resource-machine/web` 的 `web/api/fs.ts` 的 `readPreviewSource`（2026-09-24 随台账 D2 从
 * 宿主 `apps/web/src/api/fs.ts` 迁入；能力缺口登记在 §5.3）。
 */
export type PreviewFetch = (url: string, init?: RequestInit) => Promise<Response>;

export type FileCategory = "code" | "image" | "pdf" | "binary" | "table" | "markdown" | "html" | "office" | "latex";

/** 需要「渲染而非原样展示」的文档类别（预览走 `DocumentPreview`，见其文件头注释）。 */
export type DocumentCategory = Extract<FileCategory, "markdown" | "latex">;

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

/**
 * LaTeX 扩展名。`.tex` 是正文，`.latex` / `.ltx` 是同族写法。
 *
 * 这三个扩展名在 `@open-file-viewer` 里只会落到 Prism 高亮的源码视图（它的
 * `mimeLangMap` 把 `application/x-tex` 映射为 `latex`），本包因此把 latex 单独分类，
 * 交给 `DocumentPreview` 的 LaTeX 渲染分支，不再转交 `FileViewer`。
 */
const LATEX_EXTENSIONS = new Set(["tex", "latex", "ltx"]);

const HTML_EXTENSIONS = new Set(["html", "htm"]);

/**
 * 文档类预览（markdown / LaTeX）的渲染字节上限，超过后只做源码展示。
 *
 * 取 512 KB 的理由：这两类渲染都是「整篇同步解析」（markdown 交给 previewer 的 marked，
 * LaTeX 走本包的结构解析 + 逐条 KaTeX），没有增量窗口；正常文档远小于该值，再往上只会让
 * 预览面板长时间无响应。上限按**字节**判定（预览源是 Blob，保留响应原始字节数）。
 */
export const PREVIEW_MAX_DOCUMENT_BYTES = 512 * 1024;

/** 文档是否按渲染模式展示；超出 `PREVIEW_MAX_DOCUMENT_BYTES` 时退回源码展示。 */
export function shouldRenderDocumentContent(byteLength: number): boolean {
  return byteLength <= PREVIEW_MAX_DOCUMENT_BYTES;
}

/**
 * 扩展名是否为 markdown。
 *
 * 导出给 markdown 数学插件复用：插件的 `match` 拿到的是 `@open-file-viewer` 归一化后的
 * `file.extension`（无点、已小写），口径必须与本模块的分类表一致，不能再维护第二份清单。
 */
export function isMarkdownExtension(extension: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extension.toLowerCase());
}

/** 扩展名是否为 LaTeX（口径同上，与 `classifyFile` 共用一份清单）。 */
export function isLatexExtension(extension: string): boolean {
  return LATEX_EXTENSIONS.has(extension.toLowerCase());
}

/** `classifyFile` 的类别是否为文档类（markdown / LaTeX）。 */
export function isDocumentCategory(category: FileCategory): category is DocumentCategory {
  return category === "markdown" || category === "latex";
}

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
  if (LATEX_EXTENSIONS.has(ext)) return "latex";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "binary";
}

/**
 * 获取预览组件使用的文本 MIME 类型。
 * @open-file-viewer 会把文件名中的 # 当作 URL fragment，导致 #123.txt 的扩展名丢失；
 * 显式传入文本 MIME 后仍能匹配 textPlugin，同时不需要修改用户看到的原始文件名。
 *
 * LaTeX 不在其中：它不走 `FileViewer`（见 `DocumentPreview` 的 LaTeX 分支），预览器不消费它的 MIME。
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
 *
 * 文档类（markdown / LaTeX）也按 Blob 加载：文档预览需要用**响应原始字节数**判定大小上限与空文件，
 * 这两个判定都要在渲染前完成。
 */
export function shouldLoadPreviewAsBlob(filePath: string): boolean {
  const category = classifyFile(filePath);
  return category === "code" || category === "markdown" || category === "latex";
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

/**
 * 把文档字节解码为文本（`DocumentPreview` 的源码视图与 LaTeX 渲染都用它）。
 *
 * 为什么不用 `Blob.text()`：它固定按 UTF-8 解码，UTF-16 的 `.md` / `.tex`（Windows 记事本另存为的
 * 常见形态）会整篇乱码，而这里拿到的正是未经解析的响应字节。按 BOM 分流；
 * UTF-8 分支依赖 `TextDecoder` 的默认行为剥掉 BOM（否则首行会出现一个零宽字符）。
 */
export async function decodePreviewText(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  return new TextDecoder("utf-8").decode(bytes);
}
