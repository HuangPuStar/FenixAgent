import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CLOUD_DRIVE_NS } from "../../i18n/namespace";

interface CloudDriveNameDialogProps {
  open: boolean;
  mode: "create" | "rename";
  initialName?: string;
  loading?: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (name: string) => void;
}

/** 名称校验与服务端 `CloudDriveFileNameSchema` 同口径，提前给出可读提示而不是等 422。 */
function validateName(value: string, t: (key: string) => string): string | null {
  const name = value.trim();
  if (!name) return t("validation.nameRequired");
  if (name.length > 255) return t("validation.nameTooLong");
  if (name === "." || name === ".." || name.includes("/") || name.includes("\\")) {
    return t("validation.nameInvalid");
  }
  return null;
}

/** 新建目录与重命名共用同一个名称弹窗（两者只差标题与初始值）。 */
export function CloudDriveNameDialog({
  open,
  mode,
  initialName = "",
  loading = false,
  onOpenChange,
  onSubmit,
}: CloudDriveNameDialogProps) {
  const { t } = useTranslation(CLOUD_DRIVE_NS);
  const [value, setValue] = useState(initialName);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(initialName);
    setError(null);
  }, [open, initialName]);

  const submit = () => {
    const message = validateName(value, (key) => String(t(key)));
    if (message) {
      setError(message);
      return;
    }
    setError(null);
    onSubmit(value.trim());
  };

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={mode === "create" ? t("dialogs.newFolderTitle") : t("dialogs.renameTitle")}
      submitLabel={mode === "create" ? t("actions.create") : t("actions.save")}
      onSubmit={submit}
      loading={loading}
    >
      <div className="space-y-2">
        <Label htmlFor="cloud-drive-name">{t("dialogs.nameLabel")}</Label>
        <Input
          id="cloud-drive-name"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder={t("dialogs.namePlaceholder")}
          aria-invalid={error !== null}
          aria-describedby={error ? "cloud-drive-name-error" : undefined}
          autoFocus
        />
        {error && (
          <p id="cloud-drive-name-error" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </FormDialog>
  );
}
