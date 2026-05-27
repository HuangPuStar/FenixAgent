import { Loader2 } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";

interface ImagePreviewProps {
  envId: string;
  filePath: string;
}

export function ImagePreview({ envId, filePath }: ImagePreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const src = `/web/environments/${envId}/user/${filePath}`;

  const handleLoad = useCallback(() => {
    setLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setError(true);
  }, []);

  return (
    <div className="flex-1 flex items-center justify-center p-4 overflow-auto">
      {loading && <Loader2 className="h-6 w-6 animate-spin text-text-muted" />}
      {error && <p className="text-sm text-status-error">{t("fileTree.preview.fetchFailed")}</p>}
      <img
        src={src}
        alt={filePath.split("/").pop() ?? ""}
        onLoad={handleLoad}
        onError={handleError}
        className="max-w-full max-h-full object-contain"
        style={{ display: loading || error ? "none" : "block" }}
      />
    </div>
  );
}
