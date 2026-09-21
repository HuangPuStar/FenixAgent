import { FilePickerPanel } from "@fenix/ui-components/chat/shell/FilePickerPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { useTranslation } from "react-i18next";
import { fsApi, uploadChatFiles } from "@/src/api/fs";
import { unwrap } from "@/src/api/request";
import type { FileInfo } from "../types";

interface FilePickerDialogProps {
  open: boolean;
  envId: string;
  onClose: () => void;
  onSelect: (file: FileInfo) => void;
}

export function FilePickerDialog({ open, envId, onClose, onSelect }: FilePickerDialogProps) {
  const { t } = useTranslation("components");

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-lg rounded-2xl border-border bg-surface-1 p-0 shadow-2xl overflow-hidden">
        <DialogHeader className="px-4 pt-4 pb-2">
          <DialogTitle className="font-display text-lg font-semibold text-text-primary">
            {t("filePicker.title")}
          </DialogTitle>
        </DialogHeader>
        {/* 面板已迁 `@fenix/ui-components/chat/shell/FilePickerPanel`（§1.6 T6b）：包内不持有
            envId 与 API 客户端，目录列表与上传由宿主在此注入（包内 props 文档的同款示例）。 */}
        <FilePickerPanel
          listDir={(dirPath) => unwrap(fsApi.listDir(envId, dirPath || undefined))}
          uploadFiles={(files) => uploadChatFiles(envId, files)}
          onSelect={onSelect}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  );
}
