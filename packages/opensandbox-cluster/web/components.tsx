import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { type ComponentProps, type ReactNode, useId, useState } from "react";
import { t } from "./i18n";

export { Button, Input, Textarea };

/** Labeled native controls share the existing UI primitives and accessible associations. */
export function Field({
  label,
  children,
  ...input
}: ComponentProps<typeof Input> & { label: string; children?: ReactNode }) {
  const id = useId();
  return (
    <label className="grid gap-2 text-sm" htmlFor={id}>
      <span className="font-medium">{label}</span>
      {children ?? <Input id={id} {...input} />}
    </label>
  );
}
/** Native selects keep compact management forms usable with keyboards. */
export function Select(props: ComponentProps<"select">) {
  return (
    <select
      {...props}
      className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
    />
  );
}
/** Consistent inline network feedback with an explicit retry action. */
export function Feedback({ loading, error, retry }: { loading?: boolean; error?: string; retry?: () => void }) {
  if (error)
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800"
      >
        <span className="min-w-0 break-words">{error}</span>
        {retry && (
          <Button variant="outline" size="sm" onClick={retry}>
            {t("重试")}
          </Button>
        )}
      </div>
    );
  return loading ? (
    <p role="status" className="py-4 text-sm text-muted-foreground">
      {t("加载中…")}
    </p>
  ) : null;
}
/** Form dialog retains input and reports failures without closing the user's form. */
export function Editor({
  title,
  description,
  close,
  save,
  children,
}: {
  title: string;
  description?: string;
  close: () => void;
  save: () => Promise<void>;
  children: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogContent
        className="max-h-[90vh] overflow-y-auto sm:max-w-xl"
        disableOverlayClose={busy}
        disableEscapeClose={busy}
        showCloseButton={!busy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? t("填写配置后保存。")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            try {
              await save();
              close();
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : t("操作失败"));
            } finally {
              setBusy(false);
            }
          }}
        >
          <fieldset disabled={busy} className="grid min-w-0 gap-4">
            {children}
          </fieldset>
          <Feedback error={error} />
          <div className="flex justify-end gap-2">
            <Button variant="outline" disabled={busy} onClick={close}>
              {t("取消")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? t("处理中…") : t("确认")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
/** Read-only details use escaped text and never render server data as HTML. */
export function Details({ title, value, close }: { title: string; value: unknown; close: () => void }) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t("当前接口返回的详情")}</DialogDescription>
        </DialogHeader>
        <pre className="overflow-auto rounded-lg bg-muted p-4 text-xs leading-relaxed">
          {JSON.stringify(value, null, 2)}
        </pre>
      </DialogContent>
    </Dialog>
  );
}
/** Status labels are shared by table cells and details. */
export function Status({ value }: { value: string }) {
  const good = ["active", "healthy", "Running", "connected"].includes(value);
  return (
    <span
      className={`inline-flex rounded-full px-2 py-1 text-xs ${good ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}
    >
      {value}
    </span>
  );
}
