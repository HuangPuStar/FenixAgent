import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { buildPreviewUrl } from "./utils";

interface PdfPreviewProps {
  envId: string;
  filePath: string;
}

export function PdfPreview({ envId, filePath }: PdfPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [error, setError] = useState(false);
  const src = buildPreviewUrl(envId, filePath);

  const handleError = useCallback(() => {
    setError(true);
  }, []);

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center p-8">
        <p className="text-sm text-text-muted">{t("fileTree.preview.pdfLoadFailed")}</p>
      </div>
    );
  }

  return (
    <iframe
      src={src}
      className="w-full h-full border-0"
      title={filePath.split("/").pop() ?? "PDF"}
      onError={handleError}
    />
  );
}
