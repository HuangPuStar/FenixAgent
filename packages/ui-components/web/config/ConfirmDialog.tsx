import { useTranslation } from "react-i18next";

import { cn } from "../lib/cn";
import { UI_COMPONENTS_NS } from "../lib/i18n";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../ui/alert-dialog";

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  onConfirm: () => void;
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = "default",
  onConfirm,
  loading,
}: ConfirmDialogProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const confLabel = confirmLabel ?? t("confirmDialog.confirm");
  const cnlLabel = cancelLabel ?? t("confirmDialog.cancel");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className={cn(variant === "destructive" && "text-destructive")}>
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={loading}>{cnlLabel}</AlertDialogCancel>
          <AlertDialogAction variant={variant} onClick={onConfirm} disabled={loading}>
            {loading ? t("confirmDialog.processing") : confLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
