import type { GlyphType } from "react-file-icon";
import { FileIcon } from "react-file-icon";

/**
 * 从文件名中提取扩展名（不含点号前缀），无扩展名返回空字符串。
 * 仅处理最后一个点号之后的部分。
 */
export function getFileExtension(filename: string): string {
  const lastDot = filename.lastIndexOf(".");
  if (lastDot === -1 || lastDot === filename.length - 1) return "";
  return filename.slice(lastDot + 1).toLowerCase();
}

/** 文件图标颜色配置 */
interface FileIconStyle {
  color: string;
  labelColor?: string;
  labelTextColor?: string;
  foldColor?: string;
  glyphColor?: string;
  type?: GlyphType;
}

/** 离散调色板，用于确保无预设的扩展名也有不同颜色（淡色调） */
const PALETTE = [
  "#F2C6C6",
  "#C5D9F0",
  "#D0E3C4",
  "#EAD7C0",
  "#E3CCF2",
  "#C5E4E8",
  "#F2E4C8",
  "#E0BCB8",
  "#CBE3ED",
  "#F5F0C3",
  "#B8D4E0",
  "#B5E4F0",
  "#F6D0B3",
  "#CEEAB5",
  "#D0B0B0",
  "#B0CEB0",
  "#F0D0B8",
  "#BCC8E0",
  "#F5C0F0",
  "#B8DEC4",
  "#D8C8E8",
  "#F2D8C8",
  "#C4D6B8",
  "#B8D8EC",
  "#C8C0E0",
  "#C8D0E0",
  "#F5CEB0",
  "#B8E8D4",
  "#F5F0D0",
  "#D0C0F0",
  "#E2D0B8",
  "#C0C8E0",
];

/** 扩展名 → 自定义颜色 / glyph 类型映射（淡色调） */
const EXT_COLORS: Record<string, FileIconStyle> = {
  // 前端代码
  js: { color: "#F5F0C3", labelTextColor: "#555", foldColor: "#E8E0A8", type: "code" },
  jsx: { color: "#B8F0FF", labelTextColor: "#335", foldColor: "#90D0E8", type: "code" },
  ts: { color: "#B8D4E0", type: "code" },
  tsx: { color: "#B8D4E0", foldColor: "#98B8C8", type: "code" },
  mjs: { color: "#F5F0C3", labelTextColor: "#555", type: "code" },
  cjs: { color: "#F5F0C3", labelTextColor: "#555", type: "code" },
  // 样式
  css: { color: "#C8C0E0", type: "code" },
  scss: { color: "#E8C8D8", type: "code" },
  less: { color: "#B0C0E0", type: "code" },
  sass: { color: "#E8C8D8", type: "code" },
  // 标记 / 数据
  html: { color: "#F0C0B0", type: "code" },
  htm: { color: "#F0C0B0", type: "code" },
  vue: { color: "#B8DEC8", foldColor: "#98C8A8", type: "code" },
  svelte: { color: "#FFC8B8", type: "code" },
  xml: { color: "#B0C8E8", type: "code" },
  svg: { color: "#F5D8B0", foldColor: "#E0C090", type: "vector" },
  // 后端代码
  py: { color: "#C0D8F0", type: "code" },
  rb: { color: "#E8B8B0", type: "code" },
  go: { color: "#B5E4F0", type: "code" },
  rs: { color: "#F2D8C8", foldColor: "#D8C0B0", type: "code" },
  java: { color: "#E2D0B8", foldColor: "#C8B898", type: "code" },
  php: { color: "#C0C8E0", type: "code" },
  c: { color: "#C0C0C0", type: "code" },
  cpp: { color: "#F0C8D8", type: "code" },
  cs: { color: "#B0CEB0", type: "code" },
  swift: { color: "#F6D0B3", type: "code" },
  kt: { color: "#D0C0F5", type: "code" },
  scala: { color: "#E8B8C0", type: "code" },
  dart: { color: "#B0E8E0", type: "code" },
  lua: { color: "#B0B0E0", type: "code" },
  r: { color: "#B8D8F5", type: "code" },
  ex: { color: "#D0C0E0", type: "code" },
  exs: { color: "#D0C0E0", type: "code" },
  // 配置 / 数据
  json: { color: "#C8D0E0", foldColor: "#B0B8C8", type: "code" },
  yaml: { color: "#E8C0C0", type: "code" },
  yml: { color: "#E8C0C0", type: "code" },
  toml: { color: "#E0C0B0", type: "code" },
  ini: { color: "#C8C8C8", type: "settings" },
  env: { color: "#F8E890", labelTextColor: "#555", foldColor: "#E0D070", type: "settings" },
  lock: { color: "#C8C8C8", type: "settings" },
  cfg: { color: "#C8C8C8", type: "settings" },
  conf: { color: "#C8C8C8", type: "settings" },
  // Shell / 脚本
  sh: { color: "#CEEAB5", foldColor: "#B0D090", labelTextColor: "#445", type: "code" },
  bash: { color: "#CEEAB5", labelTextColor: "#445", type: "code" },
  zsh: { color: "#CEEAB5", labelTextColor: "#445", type: "code" },
  ps1: { color: "#B0C0E8", type: "code" },
  bat: { color: "#E0F0B8", labelTextColor: "#555", type: "code" },
  cmd: { color: "#E0F0B8", labelTextColor: "#555", type: "code" },
  // 文档
  md: { color: "#B0C8F0", type: "document" },
  txt: { color: "#C8D0D8", type: "document" },
  pdf: { color: "#E8C0C0", foldColor: "#D0A0A0", type: "acrobat" },
  doc: { color: "#C0D0E8", foldColor: "#A8B8D0", glyphColor: "rgba(255,255,255,0.4)", type: "document" },
  docx: { color: "#C0D0E8", foldColor: "#A8B8D0", glyphColor: "rgba(255,255,255,0.4)", type: "document" },
  xls: { color: "#B8D8C8", foldColor: "#98C0A8", glyphColor: "rgba(255,255,255,0.4)", type: "spreadsheet" },
  xlsx: { color: "#B8D8C8", foldColor: "#98C0A8", glyphColor: "rgba(255,255,255,0.4)", type: "spreadsheet" },
  ppt: { color: "#F0C8B8", foldColor: "#D8A898", glyphColor: "rgba(255,255,255,0.4)", type: "presentation" },
  pptx: { color: "#F0C8B8", foldColor: "#D8A898", glyphColor: "rgba(255,255,255,0.4)", type: "presentation" },
  csv: { color: "#B8D8C8", type: "spreadsheet" },
  // 字体
  ttf: { color: "#EAD7C0", type: "font" },
  otf: { color: "#EAD7C0", type: "font" },
  woff: { color: "#EAD7C0", type: "font" },
  woff2: { color: "#EAD7C0", type: "font" },
  eot: { color: "#EAD7C0", type: "font" },
  // 图片
  png: { color: "#B8E0C8", type: "image" },
  jpg: { color: "#B8E0C8", foldColor: "#98C8A8", type: "image" },
  jpeg: { color: "#B8E0C8", type: "image" },
  gif: { color: "#B8E0C8", type: "image" },
  bmp: { color: "#B8E0C8", type: "image" },
  webp: { color: "#B8E0C8", type: "image" },
  ico: { color: "#B8E0C8", type: "image" },
  heic: { color: "#B8E0C8", type: "image" },
  // 音视频
  mp3: { color: "#E0BCB8", type: "audio" },
  wav: { color: "#E0BCB8", type: "audio" },
  flac: { color: "#E0BCB8", type: "audio" },
  aac: { color: "#E0BCB8", type: "audio" },
  ogg: { color: "#E0BCB8", type: "audio" },
  mp4: { color: "#E8C0C0", type: "video" },
  avi: { color: "#E8C0C0", type: "video" },
  mov: { color: "#E8C0C0", type: "video" },
  mkv: { color: "#E8C0C0", type: "video" },
  webm: { color: "#E8C0C0", type: "video" },
  flv: { color: "#E8C0C0", type: "video" },
  wmv: { color: "#E8C0C0", type: "video" },
  // 压缩
  zip: { color: "#F0E4B0", type: "compressed" },
  tar: { color: "#F0E4B0", type: "compressed" },
  gz: { color: "#F0E4B0", type: "compressed" },
  rar: { color: "#F0E4B0", type: "compressed" },
  "7z": { color: "#F0E4B0", type: "compressed" },
  bz2: { color: "#F0E4B0", type: "compressed" },
  xz: { color: "#F0E4B0", type: "compressed" },
  // 数据库
  sql: { color: "#F5D8B0", type: "code" },
  db: { color: "#F5D8B0", type: "settings" },
  sqlite: { color: "#F5D8B0", type: "settings" },
  // Docker
  dockerfile: { color: "#B8E8F0", type: "settings" },
  // Git
  gitignore: { color: "#F5C8B8", type: "settings" },
  gitattributes: { color: "#F5C8B8", type: "settings" },
  // 许可 / 注意事项
  license: { color: "#C8D0D8", type: "document" },
};

/** 根据扩展名推断 glyph 类型 */
function guessType(ext: string): GlyphType | undefined {
  const codeExts = new Set([
    "js",
    "jsx",
    "ts",
    "tsx",
    "mjs",
    "cjs",
    "css",
    "scss",
    "less",
    "sass",
    "html",
    "htm",
    "vue",
    "svelte",
    "xml",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "php",
    "c",
    "cpp",
    "cs",
    "swift",
    "kt",
    "scala",
    "dart",
    "lua",
    "r",
    "ex",
    "exs",
    "json",
    "yaml",
    "yml",
    "toml",
    "sh",
    "bash",
    "zsh",
    "ps1",
    "bat",
    "cmd",
    "sql",
    "graphql",
    "gql",
    "prisma",
    "proto",
  ]);
  const imgExts = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "ico", "heic", "tiff", "tif"]);
  const audioExts = new Set(["mp3", "wav", "flac", "aac", "ogg", "wma", "m4a", "mid"]);
  const videoExts = new Set(["mp4", "avi", "mov", "mkv", "webm", "flv", "wmv", "m4v", "mpg", "mpeg"]);
  const fontExts = new Set(["ttf", "otf", "woff", "woff2", "eot"]);
  const compressedExts = new Set(["zip", "tar", "gz", "rar", "7z", "bz2", "xz", "tgz"]);
  const docExts = new Set(["md", "txt", "rst", "adoc", "tex"]);
  const sheetExts = new Set(["csv", "tsv", "ods", "xls", "xlsx"]);
  const slideExts = new Set(["ppt", "pptx", "odp"]);

  if (codeExts.has(ext)) return "code";
  if (imgExts.has(ext)) return "image";
  if (audioExts.has(ext)) return "audio";
  if (videoExts.has(ext)) return "video";
  if (fontExts.has(ext)) return "font";
  if (compressedExts.has(ext)) return "compressed";
  if (docExts.has(ext)) return "document";
  if (sheetExts.has(ext)) return "spreadsheet";
  if (slideExts.has(ext)) return "presentation";
  return undefined;
}

/** 对字符串做简单 hash，映射到调色板 */
function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) & 0xffffffff;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

/**
 * 根据文件名渲染对应的 react-file-icon 文件类型图标。
 * 替换通用的 File 图标，按扩展名展示不同颜色和类型的文件图标。
 * 已知扩展名使用预定义配色，未知扩展名使用哈希颜色确保区分度。
 */
export function FileTypeIcon({ filename }: { filename: string }) {
  const ext = getFileExtension(filename);

  if (!ext) {
    return <FileIcon type="document" color="#78909C" />;
  }

  const custom = EXT_COLORS[ext];
  if (custom) {
    return <FileIcon extension={ext} {...custom} />;
  }

  // 无预设的扩展名：用 hash 取色 + 推断 glyph 类型
  const color = hashColor(ext);
  const type = guessType(ext);

  return <FileIcon extension={ext} color={color} type={type} />;
}
