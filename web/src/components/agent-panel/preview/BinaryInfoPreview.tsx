import { File } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { formatFileSize } from "./utils";

interface BinaryInfoPreviewProps {
  filePath: string;
  fileSize?: number;
}

export function BinaryInfoPreview({ filePath, fileSize }: BinaryInfoPreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const fileName = filePath.split("/").pop() ?? filePath;
  const ext = filePath.split(".").pop()?.toUpperCase() ?? "FILE";

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="flex flex-col items-center gap-3 max-w-xs text-center">
        <div className="w-16 h-16 rounded-xl bg-surface-2 flex items-center justify-center">
          <File className="h-8 w-8 text-text-muted" />
        </div>
        <p className="text-sm font-medium text-text-primary break-all">{fileName}</p>
        <div className="flex flex-col gap-1 text-xs text-text-muted">
          <span>
            {t("fileTree.preview.fileType")}: {ext}
          </span>
          {fileSize !== undefined && (
            <span>
              {t("fileTree.preview.fileSize")}: {formatFileSize(fileSize)}
            </span>
          )}
        </div>
        <p className="text-xs text-text-muted mt-2">{t("fileTree.preview.unsupportedType")}</p>
      </div>
    </div>
  );
}
