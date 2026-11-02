import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";

interface CloudDriveDeleteDialogProps {
  open: boolean;
  targetName: string;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}

/** 删除确认：云盘删除是「移入回收站」，文案明确这一点，降低误操作的不可逆感。 */
export function CloudDriveDeleteDialog({
  open,
  targetName,
  loading = false,
  onOpenChange,
  onConfirm,
}: CloudDriveDeleteDialogProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("dialogs.deleteTitle")}
      description={t("dialogs.deleteDescription", { name: targetName })}
      confirmLabel={t("dialogs.confirmDelete")}
      variant="destructive"
      loading={loading}
      onConfirm={onConfirm}
    />
  );
}
