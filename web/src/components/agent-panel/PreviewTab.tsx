import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/sdk";
import { NS } from "../../i18n";
import { BinaryInfoPreview } from "./preview/BinaryInfoPreview";
import { CodePreview } from "./preview/CodePreview";
import { ImagePreview } from "./preview/ImagePreview";
import { PdfPreview } from "./preview/PdfPreview";
import { classifyFile } from "./preview/utils";

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

    // 图片和 PDF 不需要通过 readFile API，直接由子组件构造 URL
    if (cat === "image" || cat === "pdf") {
      setContent(null);
      setFileName(filePath.split("/").pop() ?? filePath);
      setError(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    const normalized = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
    const { data, error: err } = await fileApi.readFile({ id: envId, path: normalized });
    if (err) {
      console.error("Failed to load file:", err);
      setError(t("fileTree.preview.fetchFailed"));
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
      setError(t("fileTree.preview.notTextFile"));
      setFileName(normalized.split("/").pop() || normalized);
    }
    setLoading(false);
  }, [envId, filePath, t]);

  useEffect(() => {
    loadFile();
  }, [loadFile]);

  const displayName = fileName ?? (filePath ? filePath.split("/").pop() : null);

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      {displayName && (
        <div className="px-3 py-2 border-b border-border text-xs text-text-muted font-display truncate">
          {displayName}
        </div>
      )}
      <div className="flex-1 overflow-auto flex flex-col">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {!loading && error && <div className="p-4 text-center text-sm text-status-error">{error}</div>}
        {!loading && !error && !filePath && !fileName && (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</div>
        )}
        {!loading && !error && category === "code" && content !== null && (
          <CodePreview content={content} filePath={filePath!} />
        )}
        {!loading && !error && category === "image" && envId && <ImagePreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "pdf" && envId && <PdfPreview envId={envId} filePath={filePath!} />}
        {!loading && !error && category === "binary" && <BinaryInfoPreview filePath={filePath!} fileSize={fileSize} />}
      </div>
    </div>
  );
}
