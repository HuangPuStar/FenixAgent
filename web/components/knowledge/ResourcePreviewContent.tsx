import { useRequest } from "ahooks";
import { Loader2 } from "lucide-react";
import mammoth from "mammoth";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { kbApi } from "@/src/api/knowledge-bases";
import { NS } from "@/src/i18n";
import type { KnowledgeResourceInfo } from "../../src/types/knowledge";

/** 视频扩展名 → MIME 类型映射 */
function getVideoMimeType(ext: string): string {
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
function parseCSV(text: string): string[][] {
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
function normalizeRows(rows: string[][], maxCols: number): string[][] {
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
type FileCategory = "pdf" | "image" | "markdown" | "text" | "html" | "office" | "spreadsheet" | "video" | "other";

/** Office 文档子类型，用于 PDF 转换不可用时的降级预览（仅 Word/PPT 走 office 流程） */
type OfficeKind = "word" | "powerpoint";

export function getFileCategory(filename: string): FileCategory {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

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
function getOfficeKind(filename: string): OfficeKind {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "docx" || ext === "doc") return "word";
  return "powerpoint";
}

/** Office 预览模式：checking → loading → pdf 可用 → mammoth(仅 docx) → download 降级 */
type OfficeMode = "checking" | "pdf" | "docxHtml" | "fallback";

interface ResourcePreviewContentProps {
  /** 要预览的知识库资源 */
  resource: KnowledgeResourceInfo;
  /** 知识库 ID，用于构造文件 URL */
  kbId: string;
}

/**
 * 可复用的文档预览内容组件。
 *
 * 从 ResourcePreviewDialog 中提取，支持 PDF/图片/视频/Markdown/文本/HTML/Excel(表格)/Office 预览。
 * 不包含外层 Dialog/Sheet 容器，仅渲染预览区域，可在 Dialog、Sheet 或全屏布局中复用。
 *
 * 预览策略：
 * - PDF/图片/视频：直接 URL 渲染
 * - Markdown/文本/HTML：fetch 内容后渲染
 * - 表格(xlsx/xls/csv)：用 xlsx 库前端解析为 HTML 表格
 * - Office(Word/PPT)：优先服务端 PDF 转换，不可用时 docx 用 mammoth，其余降级为下载
 */
export function ResourcePreviewContent({ resource, kbId }: ResourcePreviewContentProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const category = getFileCategory(resource.sourceName);
  const fileUrl = kbApi.getFileUrl({ kbId, resourceId: resource.id });

  // —— 文本 / Markdown 内容加载 ——
  const needsFetch = category === "markdown" || category === "text" || category === "html";
  const [fetchedContent, setFetchedContent] = useState<string | null>(null);

  const {
    loading: fetchLoading,
    error: fetchError,
    run: runFetch,
  } = useRequest(
    async () => {
      const response = await fetch(fileUrl, { credentials: "include" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.text();
    },
    {
      manual: true,
      onSuccess: setFetchedContent,
      onError: (err) => {
        console.error("Failed to fetch preview content", err);
        toast.error(t("preview.loadError"));
      },
    },
  );

  // —— Office 文档预览：先尝试 PDF 转换，不可用时用 mammoth(docx) 或降级 ——
  const isOffice = category === "office";
  const officeKind = isOffice ? getOfficeKind(resource.sourceName) : "word";
  const pdfUrl = isOffice ? kbApi.getPdfUrl({ kbId, resourceId: resource.id }) : "";
  const [officeMode, setOfficeMode] = useState<OfficeMode>("checking");
  const [docxHtml, setDocxHtml] = useState<string | null>(null);

  // 检查 PDF 转换端点是否可用
  const { loading: officeLoading, run: runOfficeCheck } = useRequest(
    async (): Promise<OfficeMode> => {
      const resp = await fetch(pdfUrl, { credentials: "include" });
      if (resp.ok && resp.headers.get("content-type")?.includes("pdf")) {
        return "pdf";
      }
      // PDF 不可用，对 Word 文档尝试 mammoth 客户端转换
      if (officeKind === "word") {
        try {
          const fileResp = await fetch(fileUrl, { credentials: "include" });
          if (!fileResp.ok) throw new Error(`HTTP ${fileResp.status}`);
          const arrayBuffer = await fileResp.arrayBuffer();
          const result = await mammoth.convertToHtml({ arrayBuffer });
          setDocxHtml(result.value);
          return "docxHtml";
        } catch (mammothErr) {
          console.error("mammoth conversion failed", mammothErr);
        }
      }
      return "fallback";
    },
    {
      manual: true,
      onSuccess: (mode) => setOfficeMode(mode),
      onError: () => setOfficeMode("fallback"),
    },
  );

  const needsOfficeCheck = isOffice;

  const startOfficeCheck = useCallback(() => {
    setOfficeMode("checking");
    setDocxHtml(null);
    runOfficeCheck();
  }, [runOfficeCheck]);

  // 资源变化时触发加载
  // biome-ignore lint/correctness/useExhaustiveDependencies: resource.id 故意保留——同类型资源切换时 needsFetch/needsOfficeCheck 不变，必须依赖 resource.id 才会重新拉取预览
  useEffect(() => {
    setFetchedContent(null);
    setOfficeMode("checking");
    setDocxHtml(null);
    if (needsFetch) {
      runFetch();
    }
    if (needsOfficeCheck) {
      startOfficeCheck();
    }
  }, [needsFetch, needsOfficeCheck, resource.id, runFetch, startOfficeCheck]);

  // ── 渲染各类型预览内容 ──
  const renderContent = () => {
    switch (category) {
      case "pdf":
        return (
          <iframe
            src={`${fileUrl}#navpanes=0`}
            title={resource.sourceName}
            className="w-full h-full min-h-0 rounded-md border border-border"
          />
        );

      case "video": {
        const ext = resource.sourceName.split(".").pop()?.toLowerCase() ?? "mp4";
        return (
          <div className="flex-1 flex items-center justify-center bg-black/90 rounded-md p-4 min-h-0">
            <video controls preload="metadata" style={{ maxWidth: "100%", maxHeight: "100%", borderRadius: 8 }}>
              <source src={fileUrl} type={getVideoMimeType(ext)} />
            </video>
          </div>
        );
      }

      case "spreadsheet":
        return <SpreadsheetPreview url={fileUrl} filename={resource.sourceName} />;

      case "image":
        return (
          <div className="flex-1 flex items-center justify-center bg-[#f8fafc] rounded-md p-4 min-h-0 overflow-auto">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={fileUrl}
              alt={resource.sourceName}
              className="max-w-full max-h-full object-contain rounded-lg shadow-md"
            />
          </div>
        );

      case "markdown":
        if (fetchLoading) return <MarkdownSkeleton />;
        if (fetchError || !fetchedContent) return <ErrorPlaceholder message={t("preview.loadError")} />;
        return (
          <div className="flex-1 overflow-auto p-6">
            <div className="prose prose-sm max-w-none dark:prose-invert prose-headings:text-text-primary prose-p:text-text-primary prose-strong:text-text-primary prose-li:text-text-primary [&_pre]:bg-surface-2 [&_pre]:rounded-lg [&_pre]:p-4 [&_pre]:text-text-primary [&_code]:bg-surface-2 [&_code]:rounded [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-text-primary [&_code]:text-xs [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-text-primary [&_table]:w-full [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:bg-surface-2 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_img]:max-w-full [&_img]:rounded-lg [&_blockquote]:border-l-4 [&_blockquote]:border-primary/30 [&_blockquote]:pl-4 [&_blockquote]:text-text-muted [&_hr]:border-border [&_a]:text-primary [&_a]:underline">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{fetchedContent}</ReactMarkdown>
            </div>
          </div>
        );

      case "text":
        if (fetchLoading) return <TextSkeleton />;
        if (fetchError || !fetchedContent) return <ErrorPlaceholder message={t("preview.loadError")} />;
        return (
          <pre className="flex-1 overflow-auto m-0 p-4 bg-surface-2 text-text-primary text-xs font-mono whitespace-pre-wrap break-all rounded-md border border-border">
            {fetchedContent}
          </pre>
        );

      case "html":
        if (fetchLoading) return <TextSkeleton />;
        if (fetchError || !fetchedContent) return <ErrorPlaceholder message={t("preview.loadError")} />;
        return (
          <iframe
            srcDoc={fetchedContent}
            title={resource.sourceName}
            sandbox="allow-scripts allow-same-origin"
            className="w-full h-full min-h-0 rounded-md border border-border bg-white"
          />
        );

      case "office": {
        // Office 文档：优先级 PDF 转换 > mammoth(docx) > 下载
        if (officeMode === "checking" || officeLoading) {
          return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted">
              <div className="h-10 w-10 rounded-full border-[3px] border-[#e2e8f0] border-t-[#6366f1] animate-spin shadow-sm" />
              <p className="text-sm">{t("preview.converting")}</p>
            </div>
          );
        }

        if (officeMode === "pdf") {
          return (
            <iframe
              src={`${pdfUrl}#navpanes=0`}
              title={resource.sourceName}
              className="w-full h-full min-h-0 rounded-md border border-border"
            />
          );
        }

        if (officeMode === "docxHtml" && docxHtml) {
          return (
            <div className="flex-1 overflow-auto p-6">
              <div
                className="prose prose-sm max-w-none dark:prose-invert [&_table]:w-full [&_th]:border [&_th]:border-border [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:bg-surface-2 [&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_img]:max-w-full [&_img]:rounded-lg"
                // biome-ignore lint/security/noDangerouslySetInnerHtml: mammoth outputs sanitized HTML
                dangerouslySetInnerHTML={{ __html: docxHtml }}
              />
            </div>
          );
        }

        // fallback：PDF 转换不可用且非 Word 文档（或 mammoth 也失败）
        return (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted">
            <p className="text-sm">{t("preview.unsupported")}</p>
            <Button variant="outline" size="sm" asChild>
              <a href={fileUrl} download={resource.sourceName} target="_blank" rel="noreferrer">
                {t("preview.download")}
              </a>
            </Button>
          </div>
        );
      }

      default:
        return (
          <div className="flex-1 flex flex-col items-center justify-center gap-3 text-text-muted">
            <p className="text-sm">{t("preview.unsupported")}</p>
            <Button variant="outline" size="sm" asChild>
              <a href={fileUrl} download={resource.sourceName} target="_blank" rel="noreferrer">
                {t("preview.download")}
              </a>
            </Button>
          </div>
        );
    }
  };

  return <div className="flex flex-col h-full min-h-0">{renderContent()}</div>;
}

// ── 骨架屏 / 错误占位组件 ──

function MarkdownSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-4">
      <Skeleton className="h-5 w-2/3 rounded-lg" />
      <Skeleton className="h-4 w-full rounded-lg" />
      <Skeleton className="h-4 w-[90%] rounded-lg" />
      <Skeleton className="h-4 w-[85%] rounded-lg" />
      <Skeleton className="h-4 w-3/4 rounded-lg" />
      <div className="pt-2 space-y-3">
        <Skeleton className="h-4 w-[70%] rounded-lg" />
        <Skeleton className="h-4 w-full rounded-lg" />
        <Skeleton className="h-4 w-[80%] rounded-lg" />
      </div>
    </div>
  );
}

function TextSkeleton() {
  return (
    <div className="flex-1 p-6 space-y-3">
      <Skeleton className="h-3 w-full rounded-md" />
      <Skeleton className="h-3 w-[85%] rounded-md" />
      <Skeleton className="h-3 w-[92%] rounded-md" />
      <Skeleton className="h-3 w-[70%] rounded-md" />
      <Skeleton className="h-3 w-[78%] rounded-md" />
      <div className="pt-2 space-y-3">
        <Skeleton className="h-3 w-full rounded-md" />
        <Skeleton className="h-3 w-[88%] rounded-md" />
        <Skeleton className="h-3 w-[65%] rounded-md" />
        <Skeleton className="h-3 w-[75%] rounded-md" />
      </div>
    </div>
  );
}

function ErrorPlaceholder({ message }: { message: string }) {
  return <div className="flex-1 flex items-center justify-center text-text-muted text-sm">{message}</div>;
}

// ── 表格预览组件：支持 xlsx/xls/csv，用 xlsx 库前端解析 ──

interface SpreadsheetPreviewProps {
  url: string;
  filename: string;
}

/**
 * 表格文件预览组件。
 *
 * xlsx/xls：fetch 二进制 → xlsx 库解析第一个 sheet → HTML 表格
 * csv：fetch 文本 → CSV 解析 → HTML 表格
 * 最多渲染 500 行，超出部分显示截断提示。
 */
function SpreadsheetPreview({ url, filename }: SpreadsheetPreviewProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows(null);

    (async () => {
      try {
        if (ext === "csv") {
          // CSV：fetch 文本内容后解析
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          const parsed = parseCSV(text);
          const maxCols = Math.max(...parsed.map((r) => r.length), 0);
          if (!cancelled) setRows(normalizeRows(parsed, maxCols));
        } else {
          // xlsx / xls / xlsm：fetch 二进制后用 xlsx 库解析
          const res = await fetch(url, { credentials: "include" });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
          const firstSheet = wb.SheetNames[0];
          if (!firstSheet) {
            if (!cancelled) setError(t("preview.emptyTable"));
            return;
          }
          const sheet = wb.Sheets[firstSheet];
          const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 }) as string[][];
          const stringRows = data.map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
          const maxCols = Math.max(...stringRows.map((r) => r.length), 0);
          if (!cancelled) setRows(normalizeRows(stringRows, maxCols));
        }
      } catch (err) {
        console.error("Failed to load spreadsheet:", err);
        if (!cancelled) setError(t("preview.loadError"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [url, ext, t]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  if (error) {
    return <ErrorPlaceholder message={error} />;
  }

  if (!rows || rows.length === 0) {
    return <ErrorPlaceholder message={t("preview.emptyTable")} />;
  }

  const maxRows = Math.min(rows.length, 500);

  return (
    <div className="flex-1 overflow-auto">
      <div className="inline-block min-w-full align-middle">
        <table className="w-full border-collapse text-xs font-mono">
          <thead>
            <tr className="bg-surface-2 sticky top-0 z-10">
              <th className="border border-border px-2 py-1 text-text-muted w-10 text-right select-none">#</th>
              {renderHeaderCells(rows[0])}
            </tr>
          </thead>
          <tbody>{renderBodyRows(rows, maxRows)}</tbody>
        </table>
      </div>
      {rows.length > maxRows && (
        <div className="p-2 text-center text-xs text-text-muted">
          {t("preview.tableTruncated", { shown: maxRows, total: rows.length })}
        </div>
      )}
    </div>
  );
}

/** 渲染表头单元格，使用列索引作为 key（表格列位置固定） */
function renderHeaderCells(headerRow: string[]) {
  return headerRow.map((cell, colIdx) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: table column index is positional and stable
    <th key={`h-${colIdx}`} className="border border-border px-3 py-1 text-text-primary text-left whitespace-nowrap">
      {cell}
    </th>
  ));
}

/** 渲染单个数据行的所有单元格 */
function renderRowCells(row: string[], rowIdx: number) {
  return row.map((cell, colIdx) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: table cell index is positional and stable
    <td key={`c-${rowIdx}-${colIdx}`} className="border border-border px-3 py-0.5 text-text-primary whitespace-nowrap">
      {cell}
    </td>
  ));
}

/** 渲染表格数据行，使用行索引作为 key（表格位置固定） */
function renderBodyRows(rows: string[][], maxRows: number) {
  return rows.slice(1, maxRows).map((row, rowIdx) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: table row index is positional and stable
    <tr key={`r-${rowIdx}`} className="hover:bg-surface-2/50">
      <td className="border border-border px-2 py-0.5 text-text-muted text-right select-none">{rowIdx + 2}</td>
      {renderRowCells(row, rowIdx)}
    </tr>
  ));
}
