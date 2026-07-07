import { useTranslation } from "react-i18next";
import { FilePickerPanel } from "../../components/chat/FilePickerPanel";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog";
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
        <FilePickerPanel envId={envId} onSelect={onSelect} onClose={onClose} />
      </DialogContent>
    </Dialog>
  );
}
