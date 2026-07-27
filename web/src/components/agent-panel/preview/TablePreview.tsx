import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import * as XLSX from "xlsx";
import { NS } from "../../../i18n";
import { buildPreviewUrl } from "./utils";

interface TablePreviewProps {
  envId: string;
  filePath: string;
  /** CSV 文本内容（来自 readFile），xlsx 时为 null */
  content: string | null;
}

/** 简单 CSV 解析，支持引号包裹字段 */
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
      } else {
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
          fields.push(current.trim());
          current = "";
        } else {
          current += ch;
        }
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

export function TablePreview({ envId, filePath, content }: TablePreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [rows, setRows] = useState<string[][] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const ext = filePath.split(".").pop()?.toLowerCase();

  const loadTable = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      if (ext === "csv") {
        // CSV: 使用传入的 content 或 fetch 文本
        let text = content;
        if (text === null) {
          const src = buildPreviewUrl(envId, filePath);
          const res = await fetch(src, { credentials: "include" });
          text = await res.text();
        }
        const parsed = parseCSV(text);
        const maxCols = Math.max(...parsed.map((r) => r.length), 0);
        setRows(normalizeRows(parsed, maxCols));
      } else {
        // xlsx / xls / xlsm
        const src = buildPreviewUrl(envId, filePath);
        const res = await fetch(src, { credentials: "include" });
        const buf = await res.arrayBuffer();
        const wb = XLSX.read(new Uint8Array(buf), { type: "array" });
        const firstSheet = wb.SheetNames[0];
        if (!firstSheet) {
          setError(t("fileTree.preview.emptyTable"));
          return;
        }
        const sheet = wb.Sheets[firstSheet];
        const data = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 }) as string[][];
        const stringRows = data.map((row) => row.map((cell) => (cell == null ? "" : String(cell))));
        const maxCols = Math.max(...stringRows.map((r) => r.length), 0);
        setRows(normalizeRows(stringRows, maxCols));
      }
    } catch (err) {
      console.error("Failed to load table file:", err);
      setError(t("fileTree.preview.tableLoadFailed"));
    } finally {
      setLoading(false);
    }
  }, [envId, filePath, content, ext, t]);

  useEffect(() => {
    loadTable();
  }, [loadTable]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-sm text-status-error">{error}</p>
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className="flex items-center justify-center h-full p-4">
        <p className="text-sm text-text-muted">{t("fileTree.preview.emptyTable")}</p>
      </div>
    );
  }

  const maxRows = Math.min(rows.length, 500);

  return (
    <div className="flex-1 overflow-auto">
      <div className="inline-block min-w-full align-middle">
        <table className="w-full border-collapse text-xs font-mono">
          <thead>
            <tr className="bg-surface-2 sticky top-0 z-10">
              <th className="border border-border px-2 py-1 text-text-muted w-10 text-right select-none">#</th>
              {rows[0].map((cell, colIdx) => (
                <th
                  key={`h-${colIdx}`}
                  className="border border-border px-3 py-1 text-text-primary text-left whitespace-nowrap"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1, maxRows).map((row, rowIdx) => (
              <tr key={`r-${rowIdx}`} className="hover:bg-surface-2/50">
                <td className="border border-border px-2 py-0.5 text-text-muted text-right select-none">
                  {rowIdx + 2}
                </td>
                {row.map((cell, colIdx) => (
                  <td
                    key={`${rowIdx}-${colIdx}`}
                    className="border border-border px-3 py-0.5 text-text-primary whitespace-nowrap"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > maxRows && (
        <div className="p-2 text-center text-xs text-text-muted">
          {t("fileTree.preview.tableTruncated", { shown: maxRows, total: rows.length })}
        </div>
      )}
    </div>
  );
}
