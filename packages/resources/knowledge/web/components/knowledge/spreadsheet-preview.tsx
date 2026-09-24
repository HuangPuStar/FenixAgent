// web/components/knowledge/spreadsheet-preview.tsx
// 表格文件预览（xlsx / xls / xlsm / csv）：自带取数与解析的自足组件——xlsx 读二进制后用 xlsx 库解析
// 第一个 sheet，csv 读文本后本地解析，两者都整形为列数统一的二维数组再渲染成 HTML 表格。
//
// 从 `ResourcePreviewContent.tsx` 拆出（§4.7）：它有自己的取数、失败态与截断口径，与外壳的
// 「按类别分发」是两件事；解析用的纯函数在 `resource-preview-model.ts`，失败占位复用
// `resource-preview-placeholders.tsx`。

import { getFileExtension } from "@fenix/ui-components/components/file-icon-helper";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as XLSX from "xlsx";
import { fetchResourceFileBinary, fetchResourceFileText } from "../../api/knowledge-bases";
import { normalizeRows, parseCSV } from "./resource-preview-model";
import { PreviewPlaceholder } from "./resource-preview-placeholders";

interface SpreadsheetPreviewProps {
  kbId: string;
  resourceId: string;
  filename: string;
}

/**
 * 表格文件预览组件。
 *
 * xlsx/xls：读取二进制 → xlsx 库解析第一个 sheet → HTML 表格
 * csv：读取文本 → CSV 解析 → HTML 表格
 * 最多渲染 500 行，超出部分显示截断提示。
 */
export function SpreadsheetPreview({ kbId, resourceId, filename }: SpreadsheetPreviewProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ext = getFileExtension(filename);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows(null);

    (async () => {
      try {
        if (ext === "csv") {
          // CSV：读取文本内容后解析
          const text = await fetchResourceFileText({ kbId, resourceId });
          const parsed = parseCSV(text);
          const maxCols = Math.max(...parsed.map((r) => r.length), 0);
          if (!cancelled) setRows(normalizeRows(parsed, maxCols));
        } else {
          // xlsx / xls / xlsm：读取二进制后用 xlsx 库解析
          const buf = await fetchResourceFileBinary({ kbId, resourceId });
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
  }, [kbId, resourceId, ext, t]);

  if (loading) {
    return <Spinner variant="panel" size="sm" />;
  }

  if (error) {
    return <PreviewPlaceholder message={error} />;
  }

  if (!rows || rows.length === 0) {
    return <PreviewPlaceholder message={t("preview.emptyTable")} tone="neutral" />;
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

/** 渲染表头单元格：列位置即语义（第 N 列），用列索引作 key */
function renderHeaderCells(headerRow: string[]) {
  return headerRow.map((cell, colIdx) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 表格是内容快照的整表重绘（不重排、不增量插入），列位置即语义；表头文本可重复，内容派生键会撞键
    <th key={`h-${colIdx}`} className="border border-border px-3 py-1 text-text-primary text-left whitespace-nowrap">
      {cell}
    </th>
  ));
}

/** 渲染单个数据行的所有单元格：单元格位置由「行号 + 列号」确定 */
function renderRowCells(row: string[], rowIdx: number) {
  return row.map((cell, colIdx) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 同上——单元格无领域标识且内容可重复（空单元格成片出现），位置键是唯一稳定键
    <td key={`c-${rowIdx}-${colIdx}`} className="border border-border px-3 py-0.5 text-text-primary whitespace-nowrap">
      {cell}
    </td>
  ));
}

/** 渲染表格数据行：行位置即语义（第 N 行），用行索引作 key */
function renderBodyRows(rows: string[][], maxRows: number) {
  return rows.slice(1, maxRows).map((row, rowIdx) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: 同上——表格整表重绘且行内容可完全重复（空白行），位置键不会引起元素错位
    <tr key={`r-${rowIdx}`} className="hover:bg-surface-2/50">
      <td className="border border-border px-2 py-0.5 text-text-muted text-right select-none">{rowIdx + 2}</td>
      {renderRowCells(row, rowIdx)}
    </tr>
  ));
}
