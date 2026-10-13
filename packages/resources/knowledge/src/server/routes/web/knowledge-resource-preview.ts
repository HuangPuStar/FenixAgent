/**
 * 知识资源文件预览的协议支撑：MIME 表、本地文件响应、Office → PDF 转换。
 *
 * 这些能力与知识库领域无关（不读表、不认识 actor），但也不属于任何一条端点的编排，因此从路由文件里
 * 单独拆出来：资源路由只留协议分支（状态码、错误码、响应形状），预览相关的实现细节集中在这里。PDF 转换
 * 是有外部依赖的本地适配（Gotenberg HTTP 优先，LibreOffice CLI 兜底），失败一律返回 `null` 由调用方
 * 映射成 501（转换服务不可用），不抛错。
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { getKnowledgeConfig } from "../../config";
import { buildOfficeConvertEnv } from "../../office-convert-env";

/** 文件扩展名 → MIME 类型映射，用于资源文件预览时设置正确的 Content-Type */
const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".jsx": "text/javascript",
  ".json": "application/json",
  ".xml": "application/xml",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".yaml": "text/plain",
  ".yml": "text/plain",
  ".py": "text/plain",
  ".go": "text/plain",
  ".rs": "text/plain",
  ".sh": "text/plain",
  ".bash": "text/plain",
  ".sql": "text/plain",
  ".csv": "text/csv",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  // —— 视频格式 ——
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".ogg": "video/ogg",
  ".ogv": "video/ogg",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".wmv": "video/x-ms-wmv",
  ".m4v": "video/x-m4v",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  // —— 补充图片格式 ——
  ".avif": "image/avif",
  ".tiff": "image/tiff",
  ".tif": "image/tiff",
};

/** 可转换为 PDF 的 Office 文件扩展名 */
const OFFICE_EXTENSIONS = new Set([".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx"]);

/** PDF 转换缓存目录 */
const PDF_CACHE_DIR = join(process.cwd(), "data/knowledge-pdf-cache");

/** 按文件名推断预览用的 MIME 类型；未知扩展名退化为二进制流。 */
export function mimeTypeOf(fileName: string): string {
  return MIME_TYPES[extname(fileName).toLowerCase()] || "application/octet-stream";
}

/** 是否为可转 PDF 的 Office 文档。 */
export function isOfficeFile(fileName: string): boolean {
  return OFFICE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

/** 本地文件的内联预览响应（文件名按 RFC 5987 编码，避免中文名破坏响应头）。 */
export function localFileResponse(path: string, fileName: string, size: number): Response {
  const file = Bun.file(path);
  return new Response(file.stream(), {
    headers: {
      "Content-Type": mimeTypeOf(fileName),
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}

/** PDF 预览响应。 */
export function pdfResponse(path: string, fileName: string, size: number): Response {
  const file = Bun.file(path);
  return new Response(file.stream(), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Length": String(size),
      "Content-Disposition": `inline; filename="${encodeURIComponent(fileName)}"`,
    },
  });
}

/**
 * 将 Office 文件转换为 PDF 并返回 PDF 文件路径。
 * 优先级：Gotenberg (Docker HTTP API) → LibreOffice CLI → null。
 * 结果缓存在 PDF_CACHE_DIR 中，转换失败时返回 null。
 */
export async function convertToPdf(sourcePath: string, sourceName: string, resourceId: string): Promise<string | null> {
  const { gotenbergUrl } = getKnowledgeConfig();
  await mkdir(PDF_CACHE_DIR, { recursive: true });
  const outputPdf = join(PDF_CACHE_DIR, `${resourceId}.pdf`);

  // 缓存命中：PDF 已存在且比源文件新
  if (existsSync(outputPdf)) {
    try {
      const [pdfStat, srcStat] = await Promise.all([stat(outputPdf), stat(sourcePath)]);
      if (pdfStat.mtime >= srcStat.mtime) {
        return outputPdf;
      }
    } catch {
      // 状态检查失败，重新转换
    }
  }

  // — 方式 1：Gotenberg Docker 服务 —
  try {
    const fileBuffer = await import("node:fs/promises").then((m) => m.readFile(sourcePath));
    const formData = new FormData();
    formData.append("files", new Blob([fileBuffer]), sourceName);

    const resp = await fetch(`${gotenbergUrl}/forms/libreoffice/convert`, {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(60000),
    });

    if (resp.ok) {
      const pdfBuffer = Buffer.from(await resp.arrayBuffer());
      await writeFile(outputPdf, pdfBuffer);
      return outputPdf;
    }
    console.warn("Gotenberg conversion returned non-OK", { status: resp.status, sourceName });
  } catch {
    console.warn("Gotenberg not available, trying LibreOffice CLI", { sourceName });
  }

  // — 方式 2：LibreOffice CLI 本地命令 —
  for (const cmd of ["libreoffice", "soffice"]) {
    try {
      await new Promise<void>((resolve, reject) => {
        execFile(
          cmd,
          ["--headless", "--convert-to", "pdf", "--outdir", PDF_CACHE_DIR, sourcePath],
          // 子进程只拿到白名单环境：LibreOffice 处理的是用户上传文档，不能继承宿主密钥（§5.4）
          { timeout: 60000, env: buildOfficeConvertEnv() },
          (err) => {
            if (err) reject(err);
            else resolve();
          },
        );
      });

      // LibreOffice 生成的 PDF 文件名基于源文件名，需要重命名为缓存 key
      const generatedName = sourceName.replace(extname(sourceName), ".pdf");
      const generatedPath = join(PDF_CACHE_DIR, generatedName);
      if (existsSync(generatedPath) && generatedPath !== outputPdf) {
        const { rename } = await import("node:fs/promises");
        await rename(generatedPath, outputPdf);
      }

      if (existsSync(outputPdf)) {
        return outputPdf;
      }
    } catch {
      // 当前命令不可用，尝试下一个
    }
  }

  console.warn("All PDF conversion methods unavailable", { sourceName, resourceId });
  return null;
}
