// web/components/knowledge/resource-preview-model.ts
// 资源预览的**纯模型**（§3.5 三层拆分的第一层）：按扩展名把文件归类成预览方式、判定 Office
// 子类型与视频 MIME，以及表格预览用的 CSV 解析与二维数组整形。零 React、零请求。
//
// 从 `ResourcePreviewContent.tsx` 拆出（§4.7）：那个文件原先把「归类判据 + 正文取数 + 各类型渲染 +
// 表格解析」挤在一处；这里留下的是其中与渲染无关的部分——判据只有一个所有者，渲染按 `category` 分发。

import { getFileExtension } from "@fenix/ui-components/components/file-icon-helper";

/** 视频扩展名 → MIME 类型映射 */
export function getVideoMimeType(ext: string): string {
  const map: Record<string, string> = {
    mp4: "video/mp4",
    webm: "video/webm",
    ogg: "video/ogg",
    mov: "video/quicktime",
    mkv: "video/x-matroska",
    avi: "video/x-msvideo",
    flv: "video/x-flv",
    wmv: "video/x-ms-wmv",
    m4v: "video/x-m4v",
  };
  return map[ext] ?? "video/mp4";
}

/** 简单 CSV 解析，支持引号包裹字段（与文件树 TablePreview 逻辑一致） */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const fields: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"') {
          if (i + 1 < line.length && line[i + 1] === '"') {
            current += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current.trim());
        current = "";
      } else {
        current += ch;
      }
    }
    fields.push(current.trim());
    rows.push(fields);
  }
  return rows;
}

/** 多维数组转单行数组，用于列数统一的表格 */
export function normalizeRows(rows: string[][], maxCols: number): string[][] {
  return rows.map((row) => {
    const filled = [...row];
    while (filled.length < maxCols) filled.push("");
    return filled.slice(0, maxCols);
  });
}

/**
 * 根据扩展名将文件归类为可预览的类别。
 * Excel/CSV 单独归类，在前端用 xlsx 库直接渲染表格（不走 PDF 转换，效果更佳）。
 */
export type FileCategory =
  | "pdf"
  | "image"
  | "markdown"
  | "text"
  | "html"
  | "office"
  | "spreadsheet"
  | "video"
  | "other";

/** Office 文档子类型，用于 PDF 转换不可用时的降级预览（仅 Word/PPT 走 office 流程） */
export type OfficeKind = "word" | "powerpoint";

export function getFileCategory(filename: string): FileCategory {
  const ext = getFileExtension(filename);

  if (ext === "pdf") return "pdf";

  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext)) return "image";

  if (["md", "markdown"].includes(ext)) return "markdown";

  if (["html", "htm"].includes(ext)) return "html";

  // 视频格式
  if (["mp4", "webm", "ogg", "mov", "mkv", "avi", "flv", "wmv", "m4v"].includes(ext)) return "video";

  // 表格格式：xlsx/xls/csv 单独处理，前端直接渲染
  if (["xlsx", "xls", "xlsm", "csv"].includes(ext)) return "spreadsheet";

  if (
    [
      "txt",
      "json",
      "xml",
      "yaml",
      "yml",
      "js",
      "ts",
      "tsx",
      "jsx",
      "py",
      "go",
      "rs",
      "sh",
      "bash",
      "sql",
      "css",
      "log",
      "env",
    ].includes(ext)
  )
    return "text";

  // Office：仅 Word/PPT 走 PDF 转换流程
  if (["docx", "pptx", "doc", "ppt"].includes(ext)) return "office";

  return "other";
}

/** 确定 Office 文档子类型（仅 Word/PPT） */
export function getOfficeKind(filename: string): OfficeKind {
  const ext = getFileExtension(filename);
  if (ext === "docx" || ext === "doc") return "word";
  return "powerpoint";
}
