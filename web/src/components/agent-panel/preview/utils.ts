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

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
