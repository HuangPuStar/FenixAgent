/**
 * 云盘预览的类型矩阵。
 *
 * 上游只有两条可用的预览通路，且能力不重叠：
 * - **markdown**：文本与 Office（docx/xlsx 实测可用；缺 OCR 的图片不可用）；
 * - **栅格页图**：PDF 与图片；Office 栅格依赖（kkfileview）不可用时上游返回 503。
 *
 * 因此 Office 一律走 markdown，而不是「先试栅格再回退」——后者对每个 Office 文件都会先打一次必然
 * 失败的请求。`isOfficePreviewName` 只用于兜底：若某天 Office 被路由到栅格并收到 503，仍可回到
 * markdown，而不是把用户挡在「依赖不可用」。
 */

import { getExtension } from "./file-kind";

export type CloudDrivePreviewKind = "markdown" | "raster" | "unsupported";

/** markdown 可覆盖的文本与 Office 扩展名（实测 md/txt/csv/docx/xlsx 可用）。 */
const MARKDOWN_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "log",
  "csv",
  "tsv",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "rtf",
  "odt",
]);

/** 栅格页图可覆盖的 PDF 与图片（上游预览清单对这些类型可用）。 */
const RASTER_EXTENSIONS = new Set(["pdf", "png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff", "gif"]);

/** Office 家族：栅格 503 时可回退 markdown。 */
const OFFICE_EXTENSIONS = new Set(["doc", "docx", "xls", "xlsx", "ppt", "pptx", "rtf", "odt"]);

/** 按文件名选预览策略；未收录的扩展名明确提示不支持，而不是发一次必然失败的请求。 */
export function previewKindFor(name: string): CloudDrivePreviewKind {
  const extension = getExtension(name);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  if (RASTER_EXTENSIONS.has(extension)) return "raster";
  return "unsupported";
}

/** 是否 Office 文档（用于栅格 503 的 markdown 回退判断）。 */
export function isOfficePreviewName(name: string): boolean {
  return OFFICE_EXTENSIONS.has(getExtension(name));
}
