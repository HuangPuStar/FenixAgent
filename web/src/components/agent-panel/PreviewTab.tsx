import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { fileApi } from "@/src/api/sdk";

interface PreviewTabProps {
  envId: string | null;
  filePath: string | null;
}

export function PreviewTab({ envId, filePath }: PreviewTabProps) {
  const { t } = useTranslation("components");
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);

  const loadFile = useCallback(async () => {
    if (!envId || !filePath) {
      setContent(null);
      setFileName(null);
      setError(null);
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
    } else if (data && typeof data.name === "string") {
      setContent(null);
      setError(t("fileTree.preview.notTextFile"));
      setFileName(data.name);
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

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      {fileName && (
        <div className="px-3 py-2 border-b border-border text-xs text-text-muted font-display truncate">{fileName}</div>
      )}
      <div className="flex-1 overflow-auto">
        {loading && (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          </div>
        )}
        {!loading && error && <div className="p-4 text-center text-sm text-status-error">{error}</div>}
        {!loading && !error && content === null && !fileName && (
          <div className="p-4 text-center text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</div>
        )}
        {!loading && !error && content !== null && (
          <pre className="p-4 text-xs text-text-primary font-mono whitespace-pre-wrap break-words leading-relaxed">
            {content}
          </pre>
        )}
      </div>
    </div>
  );
}
