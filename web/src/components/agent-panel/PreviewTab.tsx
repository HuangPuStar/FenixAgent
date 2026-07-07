import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { FileViewerPreview } from "./preview/FileViewerPreview";

interface PreviewTabProps {
  envId: string | null;
  filePath: string | null;
}

export function PreviewTab({ envId, filePath }: PreviewTabProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  if (!envId || !filePath) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col h-full">
        <div className="flex-1 flex items-center justify-center p-4">
          {!filePath ? (
            <p className="text-sm text-text-muted">{t("fileTree.preview.noFileSelected")}</p>
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden flex flex-col h-full">
      <FileViewerPreview key={filePath} envId={envId} filePath={filePath} />
    </div>
  );
}
