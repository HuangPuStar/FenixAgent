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
 * fsApi.tree() 返回完整的工作区相对路径（如 "user/hello.html"、"scripts/run.sh"），
 * 路由 /:id/fs/* 直接透传，无需额外加 user/ 前缀。
 */
export function buildPreviewUrl(envId: string, filePath: string): string {
  const encoded = filePath.split("/").map(encodePathSegment).join("/");
  return `/web/environments/${envId}/fs/${encoded}?preview=true`;
}

/**
 * 把 Agent 工具调用上报的任意格式路径规范化为「相对 user/ 的路径」（带 user/ 前缀），
 * 与后端 `isUserPath` 校验保持一致。
 *
 * Agent 上报的 path 可能是：
 * 1. 相对路径（`src/foo.ts`）—— Agent 工作目录为 workspace 时常见
 * 2. 已带 user/ 前缀的相对路径（`user/src/foo.ts`）
 * 3. workspace 绝对路径含 /user/ 段（`/workspaces/{org}/{user}/{env}/user/src/foo.ts`）
 * 4. workspace 绝对路径不含 /user/ 段（`/workspaces/{org}/{user}/{env}/src/foo.ts`）
 *
 * 规范化策略：
 * - 已带 `user/` 前缀的路径：直接保持原样
 * - 绝对路径命中 `/user/` 段：取最后一个 `/user/` 之后的部分，补回 `user/` 前缀
 * - 绝对路径无 `/user/` 段：去掉前导 `/` 后直接返回（不添加 user/ 前缀），
 *   认为文件位于 workspace 根目录
 * - 纯相对路径：统一加 `user/` 前缀（兼容前导 `/`，如 `/src/foo.ts`）
 *
 * 这样可与文件树 tree API 返回的路径格式（`user/foo/bar.html`）对齐，
 * 同一文件不会因为路径来源不同而出现两个 tab。
 */
export function normalizeToUserPath(rawPath: string): string {
  // 统一去除尾部斜杠（目录形态），保留前导斜杠判断用于绝对路径分支
  const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (trimmed === "") return "user/";

  // 完全等于 "user" / 已带 user/ 前缀：保持不变
  if (trimmed === "user" || trimmed === "user/") return "user/";
  if (trimmed.startsWith("user/")) return trimmed;

  // 绝对路径分支（以 / 开头）：尝试提取 workspace 内的 /user/ 段
  // Agent 上报的绝对路径形如 /workspaces/{org}/{user}/{env}/user/src/foo.ts，
  // 需要提取 user/ 之后的相对路径。
  if (trimmed.startsWith("/")) {
    const absIdx = trimmed.lastIndexOf("/user/");
    if (absIdx >= 0) {
      const afterUser = trimmed.slice(absIdx + "/user/".length);
      if (afterUser) return `user/${afterUser}`;
    }
    // 绝对路径中无 /user/ 段：文件在 workspace 根目录（非 user/ 下），
    // 去掉前导 / 后作为工作区相对路径返回，不添加 user/ 前缀。
    // 注意：这里无法得知 workspace 根路径前缀，完整绝对路径在被
    // /fs/* 路由解析时会 404。理想方案是由调用方传入 workspace 根路径
    // 来精确裁剪，当前版本仅在最小代价下避免路径错误拼接。
    return trimmed.slice(1);
  }

  // 纯相对路径分支：统一加 user/ 前缀（兼容前导 /，如 /src/foo.ts）
  const stripped = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  return `user/${stripped}`;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
