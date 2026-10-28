/**
 * 文件预览对话框：只提供 dialog 语义（标题、描述、Esc/遮罩关闭、焦点陷阱）与布局，
 * 取数与状态在 `CloudDrivePreviewPanel`。
 */

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";
import type { CloudDriveFile } from "../../types/cloud-drive";
import { CloudDrivePreviewPanel } from "./cloud-drive-preview-panel";

interface CloudDrivePreviewDialogProps {
  open: boolean;
  file: CloudDriveFile | null;
  onOpenChange: (open: boolean) => void;
}

/** 控制台的文件预览入口；关闭即卸载面板，在途请求由 hook 的 AbortController 取消。 */
export function CloudDrivePreviewDialog({ open, file, onOpenChange }: CloudDrivePreviewDialogProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  return (
    <Dialog open={open && file !== null} onOpenChange={onOpenChange}>
      <DialogContent size="xl">
        <DialogHeader className="border-b p-4 pr-12">
          <DialogTitle className="truncate">{file?.name ?? t("preview.title")}</DialogTitle>
          <DialogDescription>{t("preview.description")}</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{file && <CloudDrivePreviewPanel file={file} />}</div>
      </DialogContent>
    </Dialog>
  );
}
