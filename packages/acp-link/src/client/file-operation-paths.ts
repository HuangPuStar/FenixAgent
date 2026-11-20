import { isAbsolute, relative, resolve, sep, win32 } from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".xml": "text/xml",
  ".zip": "application/zip",
  ".tar": "application/x-tar",
  ".gz": "application/gzip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".eot": "application/vnd.ms-fontobject",
};

/** Resolve an untrusted workspace-relative path. */
export function resolveAndValidate(workspace: string, path: string): string | null {
  if (
    typeof path !== "string" ||
    isAbsolute(path) ||
    win32.isAbsolute(path) ||
    path.split(/[\\/]+/).includes("..") ||
    [...path].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )
    return null;
  const target = resolve(workspace, path);
  return isWithinRoot(workspace, target) ? target : null;
}
/** True when a resolved target stays under its trusted root. */
export function isWithinRoot(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
/** MIME hint for file responses. */
export function getMimeType(path: string): string {
  const dot = path.lastIndexOf(".");
  return MIME_TYPES[dot >= 0 ? path.slice(dot).toLowerCase() : ""] ?? "application/octet-stream";
}
/** Validate upload paths without changing legal whitespace. */
export function normalizeUploadRelativePath(value: unknown): string | null {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !value.trim() || value === "." || isAbsolute(value) || win32.isAbsolute(value))
    return null;
  if (
    value.split(/[\\/]+/).includes("..") ||
    [...value].some((char) => {
      const code = char.charCodeAt(0);
      return code <= 31 || (code >= 127 && code <= 159);
    })
  )
    return null;
  return value;
}
/** Hide internal workspace entries from existing tree/list projections. */
export function shouldHideWorkspaceEntry(path: string): boolean {
  return new Set([".opencode", ".claude", ".peri", "CLAUDE.md"]).has(path.slice(path.lastIndexOf("/") + 1));
}

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonc",
  ".js",
  ".ts",
  ".tsx",
  ".jsx",
  ".css",
  ".html",
  ".xml",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".sh",
  ".bash",
  ".zsh",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".lua",
  ".pl",
  ".r",
  ".sql",
  ".log",
  ".env",
  ".gitignore",
  ".dockerignore",
  ".editorconfig",
  ".properties",
  ".lock",
  ".map",
  ".vue",
  ".svelte",
]);
/** Text previews accept known editor formats or extensionless UTF-8 files. */
export function isTextSnapshot(path: string, content: Uint8Array): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return TEXT_EXTENSIONS.has(dot >= 0 ? name.slice(dot).toLowerCase() : "") || (dot < 0 && !content.includes(0));
}
