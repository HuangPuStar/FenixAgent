import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { sessionApi } from "@/src/api/sdk";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import type { Environment, Session } from "../types";

const newSessionSchema = z.object({
  title: z.string(),
  envId: z.string(),
});
type NewSessionFormValues = z.infer<typeof newSessionSchema>;

interface NewSessionDialogProps {
  open: boolean;
  environments: Environment[];
  onClose: () => void;
  onCreated: (session: Session) => void;
}

export function NewSessionDialog({ open, environments, onClose, onCreated }: NewSessionDialogProps) {
  const { t } = useTranslation("components");
  const [creating, setCreating] = useState(false);

  const form = useForm<NewSessionFormValues>({
    resolver: zodResolver(newSessionSchema),
    defaultValues: { title: "", envId: "" },
  });

  const handleCreate = form.handleSubmit(async (values) => {
    setCreating(true);
    const body: Record<string, string> = {};
    if (values.title.trim()) body.title = values.title.trim();
    if (values.envId) body.environment_id = values.envId;
    const { data, error } = await sessionApi.create(body);
    if (error) {
      form.setError("root", {
        message: error.message ?? t("newSession.createFailed"),
      });
    } else {
      onCreated(data as Session);
    }
    setCreating(false);
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          form.reset();
          onClose();
        }
      }}
    >
      <DialogContent className="max-w-md rounded-2xl border-border bg-surface-1 p-6 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-semibold text-text-primary">
            {t("newSession.title")}
          </DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleCreate} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="mb-1 block text-sm text-text-secondary">{t("newSession.titleLabel")}</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder={t("newSession.titlePlaceholder")}
                      className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
                      {...field}
                    />
                  </FormControl>
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="envId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="mb-1 block text-sm text-text-secondary">
                    {t("newSession.environment")}
                  </FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary">
                        <SelectValue placeholder={t("newSession.noneOption")} />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {environments.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.machine_name || env.id} ({env.branch || t("newSession.noBranch")})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FormItem>
              )}
            />

            {form.formState.errors.root && (
              <div className="text-sm text-status-error">{form.formState.errors.root.message}</div>
            )}
          </form>
        </Form>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onClose}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text-secondary hover:bg-surface-2 transition-colors"
          >
            {t("newSession.cancel")}
          </Button>
          <Button
            type="submit"
            onClick={handleCreate}
            disabled={creating}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-light disabled:opacity-50 transition-colors"
          >
            {creating ? t("newSession.creating") : t("newSession.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
