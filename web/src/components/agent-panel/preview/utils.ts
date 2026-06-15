export type FileCategory = "code" | "image" | "pdf" | "binary" | "table" | "markdown" | "html";

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

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "ico", "bmp"]);

const TABLE_EXTENSIONS = new Set(["csv", "xlsx", "xls", "xlsm"]);

const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

const HTML_EXTENSIONS = new Set(["html", "htm"]);

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
  properties: "properties",
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
  if (TABLE_EXTENSIONS.has(ext)) return "table";
  if (HTML_EXTENSIONS.has(ext)) return "html";
  if (MARKDOWN_EXTENSIONS.has(ext)) return "markdown";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "binary";
}

export function getShikiLanguage(filePath: string): string | undefined {
  const ext = getExtension(filePath);
  return EXT_TO_SHIKI_LANG[ext];
}

/**
 * 构建文件预览 URL。
 * 远程节点的 tree 返回路径如 "user/hello.html"，已经带 user/ 前缀；
 * 本地节点 tree 也返回 "user/hello.html"。
 * 路由 /:id/user/* 的通配符不包含 "user/"，所以需要确保 filePath 带 user/ 前缀。
 */
export function buildPreviewUrl(envId: string, filePath: string): string {
  const withUserPrefix = filePath.startsWith("user/") ? filePath : `user/${filePath}`;
  const encoded = withUserPrefix.split("/").map(encodePathSegment).join("/");
  return `/web/environments/${envId}/user/${encoded}?preview=true`;
}

/**
 * 把 Agent 工具调用上报的任意格式路径规范化为「相对 user/ 的路径」（带 user/ 前缀），
 * 与后端 `isUserPath` 校验保持一致。
 *
 * Agent 上报的 path 可能是：
 * 1. 相对路径（`src/foo.ts`）—— Agent 工作目录为 workspace 时常见
 * 2. 已带 user/ 前缀的相对路径（`user/src/foo.ts`）
 * 3. workspace 绝对路径（`/Users/.../workspaces/{org}/{user}/{env}/user/src/foo.ts`）
 *
 * 规范化策略：
 * - 命中 `/user/` 段（绝对路径场景）：取最后一个 `/user/` 之后的部分（兼容路径中其它 user/ 目录），补回 `user/` 前缀
 * - 已带 `user/` 前缀：保持不变
 * - 纯相对路径：统一加 `user/` 前缀（兼容前导 `/`，如 `/src/foo.ts`）
 *
 * 这样可与文件树 tree API 返回的路径格式（`user/foo/bar.html`）对齐，
 * 同一文件不会因为路径来源不同而出现两个 tab。
 */
export function normalizeToUserPath(rawPath: string): string {
  // 统一去除尾部斜杠（目录形态），保留前导斜杠判断用于绝对路径分支
  const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (trimmed === "") return "user/";

  // 绝对路径分支：命中 "/user/" 取最后一段（避免路径中存在多个 user/ 目录时取错）
  const absIdx = trimmed.lastIndexOf("/user/");
  if (absIdx >= 0) {
    const afterUser = trimmed.slice(absIdx + "/user/".length);
    return `user/${afterUser}`;
  }
  // 完全等于 "user" / 已带 user/ 前缀：保持不变
  if (trimmed === "user" || trimmed === "user/") return "user/";
  if (trimmed.startsWith("user/")) return trimmed;

  // 纯相对路径分支：去掉前导斜杠（如 /src/foo.ts）后补 user/ 前缀
  const stripped = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return `user/${stripped}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
