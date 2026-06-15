import { FileX, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/sdk";
import { NS } from "../../i18n";
import { BinaryInfoPreview } from "./preview/BinaryInfoPreview";
import { CodePreview } from "./preview/CodePreview";
import { HtmlPreview } from "./preview/HtmlPreview";
import { ImagePreview } from "./preview/ImagePreview";
import { MarkdownPreview } from "./preview/MarkdownPreview";
import { PdfPreview } from "./preview/PdfPreview";
import { TablePreview } from "./preview/TablePreview";
import { classifyFile, formatFileSize } from "./preview/utils";

interface PreviewTabProps {
  envId: string | null;
  filePath: string | null;
}

export function PreviewTab({ envId, filePath }: PreviewTabProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [content, setContent] = useState<string | null>(null);
  const [fileSize, setFileSize] = useState<number | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const category = filePath ? classifyFile(filePath) : null;

  const loadFile = useCallback(async () => {
    if (!envId || !filePath) {
      setContent(null);
      setFileName(null);
      setError(null);
      setFileSize(undefined);
      return;
    }

    const cat = classifyFile(filePath);

    // 图片、PDF、表格、HTML 不需要通过 readFile API，直接由子组件通过 URL 处理
    if (cat === "image" || cat === "pdf" || cat === "table" || cat === "html") {
      setContent(null);
      setFileName(filePath.split("/").pop() ?? filePath);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const normalized = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
    // 保留文件名用于错误提示卡片
    const fallbackName = normalized.split("/").pop() || normalized;
    setFileName(fallbackName);
    const { data, error: err } = await fileApi.readFile({ id: envId, path: normalized });
    if (err) {
      console.error("Failed to load file:", err);
      setError("unsupported");
      setContent(null);
    } else if (data && typeof data.content === "string") {
      setContent(data.content);
      setFileName(data.name || normalized.split("/").pop() || normalized);
      setFileSize(data.size);
    } else if (data && typeof data.name === "string") {
      setContent(null);
      setFileName(data.name);
      setFileSize(data.size);
    } else {
      setContent(null);
      setError("unsupported");
      setFileName(normalized.split("/").pop() || normalized);
    }
    setLoading(false);
  }, [envId, filePath]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      <div className="flex-1 overflow-auto flex flex-col">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {/* 加载失败：展示"暂不支持预览"卡片 */}
        {!loading && error && fileName && (
          <div className="flex-1 flex items-center justify-center p-8">
            <div className="flex flex-col items-center gap-3 max-w-xs text-center">
              <div className="w-16 h-16 rounded-xl bg-surface-2 flex items-center justify-center">
                <FileX className="h-8 w-8 text-text-muted" />
              </div>
              <p className="text-sm font-medium text-text-primary break-all">{fileName}</p>
              {fileSize !== undefined && <span className="text-xs text-text-muted">{formatFileSize(fileSize)}</span>}
              <p className="text-xs text-text-muted mt-1">{t("fileTree.preview.unsupportedType")}</p>
            </div>
          </div>
        )}
        {!loading && !error && !filePath && !fileName && (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</div>
        )}
        {!loading && !error && category === "code" && content !== null && (
          <CodePreview content={content} filePath={filePath!} />
        )}
        {!loading && !error && category === "markdown" && content !== null && <MarkdownPreview content={content} />}
        {!loading && !error && category === "image" && envId && <ImagePreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "html" && envId && <HtmlPreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "pdf" && envId && <PdfPreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "table" && envId && (
          <TablePreview envId={envId} filePath={filePath!} content={content} />
        )}
        {!loading && !error && category === "binary" && <BinaryInfoPreview filePath={filePath!} fileSize={fileSize} />}
      </div>
    </div>
  );
}
