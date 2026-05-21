import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";

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
    try {
      const normalized = filePath.endsWith("/") ? filePath.slice(0, -1) : filePath;
      const result = await api<{ content?: string; name?: string }>("GET", `/web/environments/${envId}/user/${normalized}`);
      if (result && typeof result.content === "string") {
        setContent(result.content);
        setFileName(result.name || normalized.split("/").pop() || normalized);
      } else if (result && typeof result.name === "string") {
        setContent(null);
        setError(t("fileTree.preview.notTextFile"));
        setFileName(result.name);
      } else {
        setContent(null);
        setError(t("fileTree.preview.notTextFile"));
        setFileName(normalized.split("/").pop() || normalized);
      }
    } catch (err) {
      console.error("Failed to load file:", err);
      setError(t("fileTree.preview.fetchFailed"));
      setContent(null);
    } finally {
      setLoading(false);
    }
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
