import { useState } from "react";
import type { Environment, Session } from "../types";
import { client } from "../api/client";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../../components/ui/dialog";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "../../components/ui/form";
import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

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
  const [creating, setCreating] = useState(false);

  const form = useForm<NewSessionFormValues>({
    resolver: zodResolver(newSessionSchema),
    defaultValues: { title: "", envId: "" },
  });

  const handleCreate = form.handleSubmit(async (values) => {
    setCreating(true);
    try {
      const body: Record<string, string> = {};
      if (values.title.trim()) body.title = values.title.trim();
      if (values.envId) body.environment_id = values.envId;
      const { data: session, error: sessionErr } = await client.web.sessions.post(body as any);
      if (sessionErr) throw new Error(sessionErr.message ?? "Failed to create session");
      onCreated(session);
    } catch (err) {
      form.setError("root", {
        message: err instanceof Error ? err.message : "Failed to create session",
      });
    } finally {
      setCreating(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { form.reset(); onClose(); } }}>
      <DialogContent className="max-w-md rounded-2xl border-border bg-surface-1 p-6 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-semibold text-text-primary">New Session</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={handleCreate} className="space-y-4">
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="mb-1 block text-sm text-text-secondary">Title (optional)</FormLabel>
                  <FormControl>
                    <Input
                      type="text"
                      placeholder="My session"
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
                  <FormLabel className="mb-1 block text-sm text-text-secondary">Environment</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary">
                        <SelectValue placeholder="-- None --" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {environments.map((env) => (
                        <SelectItem key={env.id} value={env.id}>
                          {env.machine_name || env.id} ({env.branch || "no branch"})
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
            Cancel
          </Button>
          <Button
            type="submit"
            onClick={handleCreate}
            disabled={creating}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand-light disabled:opacity-50 transition-colors"
          >
            {creating ? "Creating..." : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
