/**
 * 文件类型图标：按「目录 / 扩展名类别」映射到 `lucide-react` 图标。
 *
 * 不复用 `@fenix/ui-components` 的 `FileTypeIcon`：它依赖 `react-file-icon` 的整套 SVG 渲染，视觉上
 * 是彩色文件卡片，与本页的紧凑表格不匹配；这里只需要「能一眼区分类型」的线性图标，与侧栏导航同一套
 * 图标语言（`lucide-react`）。
 */

import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  type LucideIcon,
} from "lucide-react";

const CODE_EXTENSIONS = new Set([
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "json",
  "css",
  "scss",
  "less",
  "html",
  "xml",
  "yml",
  "yaml",
  "toml",
  "py",
  "go",
  "rs",
  "java",
  "sh",
  "sql",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "heic"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "avi", "mkv", "webm", "flv", "m4v"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma"]);
const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"]);
const SPREADSHEET_EXTENSIONS = new Set(["csv", "xls", "xlsx", "ods", "numbers"]);
const DOCUMENT_EXTENSIONS = new Set(["txt", "md", "pdf", "doc", "docx", "rtf", "odt", "pages"]);

/** 扩展名（小写、不含点）；无扩展名返回空串。 */
export function getExtension(name: string): string {
  const lastDot = name.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === name.length - 1) return "";
  return name.slice(lastDot + 1).toLowerCase();
}

/** 条目 → 图标组件；目录优先，其余按扩展名归类，未收录的扩展名退回通用文件图标。 */
export function fileTypeIcon(kind: "file" | "directory", name: string): LucideIcon {
  if (kind === "directory") return Folder;

  const extension = getExtension(name);
  if (CODE_EXTENSIONS.has(extension)) return FileCode;
  if (IMAGE_EXTENSIONS.has(extension)) return FileImage;
  if (VIDEO_EXTENSIONS.has(extension)) return FileVideo;
  if (AUDIO_EXTENSIONS.has(extension)) return FileAudio;
  if (ARCHIVE_EXTENSIONS.has(extension)) return FileArchive;
  if (SPREADSHEET_EXTENSIONS.has(extension)) return FileSpreadsheet;
  if (DOCUMENT_EXTENSIONS.has(extension)) return FileText;
  return File;
}
