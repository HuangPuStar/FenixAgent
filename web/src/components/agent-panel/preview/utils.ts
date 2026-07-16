export type FileCategory = "code" | "image" | "pdf" | "binary" | "table" | "markdown" | "html" | "office";

/** encodeURIComponent 不编码 ()，需额外处理，用于 URL 路径 */
export function encodePathSegment(seg: string) {
  return encodeURIComponent(seg).split("(").join("%28").split(")").join("%29");
}

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
 * 构建文件预览 URL。
 * 按路径段分别 encodeURIComponent，避免中文等非 ASCII 字符在浏览器→Vite 代理→后端
 * 的链路上产生编码歧义。分隔符 / 不编码，保持路径结构。
 */
export function buildPreviewUrl(envId: string, filePath: string): string {
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  return `/web/environments/${envId}/fs/${encodedPath}?preview=true`;
}

/**
 * 把 Agent 工具调用上报的任意格式路径规范化为 workspace 相对路径，
 * 与后端文件树 API 返回的路径格式保持一致。
 *
 * Agent 的 cwd 即 workspace 根目录，上报的 path 已经是相对于 workspace 的路径，
 * 无需额外添加 `user/` 前缀。后端 `resolveWorkspacePath` 会自行处理路径解析。
 *
 * Agent 上报的 path 可能是：
 * 1. workspace 相对路径（`src/foo.ts`、`user/foo.txt`）——直接返回
 * 2. workspace 绝对路径含 /user/ 段（`/workspaces/{org}/{user}/{env}/user/src/foo.ts`）
 * 3. workspace 绝对路径不含 /user/ 段（`/workspaces/{org}/{user}/{env}/src/foo.ts`）
 * 4. 空串 —— 兜底为 `user/`
 *
 * 规范化策略：
 * - 已带 `user/` 前缀的路径：直接保持原样
 * - 空字符串、纯粹 "user" / "user/"：统一为 `user/`
 * - 绝对路径命中 env_* 段：取其后部分作为 workspace 相对路径，
 *   保留原始 user/ 或非 user/ 前缀状态，不额外添加前缀
 * - 绝对路径无 env_* 段：原样返回让 server 兜底
 * - 纯相对路径：直接返回（agent 工作目录即 workspace 根，路径已正确）
 *
 * 这样可与文件树 tree API 返回的路径格式对齐，
 * 同一文件不会因为路径来源不同而出现两个 tab。
 */
export function normalizeToUserPath(rawPath: string): string {
  // 统一去除尾部斜杠（目录形态），保留前导斜杠判断用于绝对路径分支
  const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (trimmed === "") return "user/";

  // 完全等于 "user" / 已带 user/ 前缀：保持不变
  if (trimmed === "user" || trimmed === "user/") return "user/";
  if (trimmed.startsWith("user/")) return trimmed;

  // 绝对路径分支（以 / 开头）：用 env_*/ 分隔符切分 workspace 路径
  // workspace 路径结构固定为 .../env_{envId}/<相对路径>，
  // 用 env_*/ 切分即可提取 workspace 相对路径，不依赖 server 上下文。
  if (trimmed.startsWith("/")) {
    const envMatch = trimmed.match(/\/env_[^/]+\//);
    if (envMatch && envMatch.index !== undefined) {
      const afterEnv = trimmed.slice(envMatch.index + envMatch[0].length);
      if (afterEnv) return afterEnv;
      return "user/";
    }
    // 非 workspace 路径（无 env_*/ 段）：原样返回让 server 兜底
    return trimmed;
  }

  // 纯相对路径：直接返回（agent 工作目录即 workspace 根，路径已正确）
  return trimmed;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
