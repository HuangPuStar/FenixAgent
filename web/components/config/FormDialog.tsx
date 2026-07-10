import { zodResolver } from "@hookform/resolvers/zod";
import { FormProvider, useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import type { z } from "zod";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog";

export interface FormDialogFormConfig {
  schema: z.ZodType<Record<string, unknown>>;
  defaultValues: Record<string, unknown>;
  onFormSubmit: (data: Record<string, unknown>) => void;
}

interface FormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: React.ReactNode;
  onSubmit?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  hideSubmit?: boolean;
  width?: string;
  formConfig?: FormDialogFormConfig;
}

export function FormDialog({
  open,
  onOpenChange,
  title,
  children,
  onSubmit,
  submitLabel,
  cancelLabel,
  loading,
  disabled,
  hideSubmit,
  width = "sm:max-w-lg",
  formConfig,
}: FormDialogProps) {
  const { t } = useTranslation("components");
  const sbmLabel = submitLabel ?? t("formDialog.save");
  const cnlLabel = cancelLabel ?? t("formDialog.cancel");
  const methods = useForm<Record<string, unknown>>({
    // biome-ignore lint/suspicious/noExplicitAny: shadcn/react-hook-form zodResolver requires ZodTypeAny
    resolver: formConfig?.schema ? zodResolver(formConfig.schema as any) : undefined,
    defaultValues: formConfig?.defaultValues,
  });

  const handleFormSubmit = formConfig
    ? methods.handleSubmit(formConfig.onFormSubmit)
    : (e: React.FormEvent) => {
        e.preventDefault();
        onSubmit?.();
      };

  const formContent = (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto pr-1">{children}</div>
      <DialogFooter className="shrink-0 border-t bg-background pt-4">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {cnlLabel}
        </Button>
        {!hideSubmit && (
          <Button type="submit" disabled={loading || disabled}>
            {loading ? t("formDialog.saving") : sbmLabel}
          </Button>
        )}
      </DialogFooter>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={`${width} flex max-h-[85vh] flex-col`}>
        <DialogHeader className="shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {formConfig ? (
          <FormProvider {...methods}>
            <form onSubmit={handleFormSubmit} className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
              {formContent}
            </form>
          </FormProvider>
        ) : (
          <form
            onSubmit={handleFormSubmit as React.FormEventHandler}
            className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden"
          >
            {formContent}
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
