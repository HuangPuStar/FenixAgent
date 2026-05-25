import { zodResolver } from "@hookform/resolvers/zod";
import { Check, Copy, Eye, EyeOff, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "../../components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormMessage } from "../../components/ui/form";
import { Input } from "../../components/ui/input";
import type { TokenEntry } from "../hooks/useTokens";

const addTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  label: z.string(),
});
type AddTokenFormValues = z.infer<typeof addTokenSchema>;

interface TokenManagerDialogProps {
  open: boolean;
  onClose: () => void;
  tokens: TokenEntry[];
  activeTokenId: string | null;
  onSetActive: (id: string) => void;
  onAdd: (token: string, label: string) => string | null;
  onRemove: (id: string) => void;
  onUpdate: (id: string, label: string) => void;
}

export function TokenManagerDialog({
  open,
  onClose,
  tokens,
  activeTokenId,
  onSetActive,
  onAdd,
  onRemove,
  onUpdate,
}: TokenManagerDialogProps) {
  const { t } = useTranslation("components");
  const addForm = useForm<AddTokenFormValues>({
    resolver: zodResolver(addTokenSchema),
    defaultValues: { token: "", label: "" },
  });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [visibleTokenId, setVisibleTokenId] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const handleCopy = (id: string, token: string) => {
    navigator.clipboard.writeText(token).then(() => {
      setCopiedId(id);
      setTimeout(() => setCopiedId(null), 1500);
    });
  };

  const handleAdd = addForm.handleSubmit((values) => {
    const error = onAdd(values.token, values.label);
    if (error) {
      addForm.setError("token", { message: error });
      return;
    }
    addForm.reset();
  });

  const handleStartEdit = (entry: TokenEntry) => {
    setEditingId(entry.id);
    setEditLabel(entry.label);
  };

  const handleSaveEdit = (id: string) => {
    onUpdate(id, editLabel.trim() || t("tokenManager.unnamed"));
    setEditingId(null);
  };

  const handleSwitch = (id: string) => {
    onSetActive(id);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="max-w-md rounded-2xl border-border bg-surface-1 p-6 shadow-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-lg font-semibold text-text-primary">
            {t("tokenManager.title")}
          </DialogTitle>
          <DialogDescription className="text-sm text-text-muted">{t("tokenManager.description")}</DialogDescription>
        </DialogHeader>

        {/* Token list */}
        <div className="space-y-1 max-h-64 overflow-y-auto">
          {tokens.map((entry) => (
            <div key={entry.id} className="group flex items-center gap-1">
              {editingId === entry.id ? (
                <div className="flex flex-1 items-center gap-2 rounded-lg bg-surface-2 px-3 py-1.5">
                  <Input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleSaveEdit(entry.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 rounded border border-border bg-surface-1 px-2 py-1 text-sm text-text-primary focus:border-brand focus:outline-none"
                    autoFocus
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-brand hover:text-brand-light"
                    onClick={() => handleSaveEdit(entry.id)}
                  >
                    <Check className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-text-muted hover:text-text-primary"
                    onClick={() => setEditingId(null)}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <Button
                    variant="ghost"
                    onClick={() => handleSwitch(entry.id)}
                    className={`flex flex-1 items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                      activeTokenId === entry.id ? "bg-brand/10 text-brand" : "text-text-secondary hover:bg-surface-2"
                    }`}
                  >
                    <div className="flex flex-col items-start min-w-0">
                      <span className="font-medium truncate w-full">{entry.label}</span>
                      <span className="text-xs text-text-muted font-mono">
                        {visibleTokenId === entry.id ? entry.token : `${entry.token.slice(0, 6)}${"\u2022".repeat(6)}`}
                      </span>
                    </div>
                    {activeTokenId === entry.id && <Check className="h-4 w-4 flex-shrink-0" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary transition-all"
                    onClick={() => setVisibleTokenId(visibleTokenId === entry.id ? null : entry.id)}
                    title={t("tokenManager.toggleVisibility")}
                  >
                    {visibleTokenId === entry.id ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary transition-all"
                    onClick={() => handleCopy(entry.id, entry.token)}
                    title={t("tokenManager.copyToken")}
                  >
                    {copiedId === entry.id ? (
                      <Check className="h-3.5 w-3.5 text-status-active" />
                    ) : (
                      <Copy className="h-3.5 w-3.5" />
                    )}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:text-text-primary transition-all"
                    onClick={() => handleStartEdit(entry)}
                    title={t("tokenManager.editLabel")}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 rounded p-1 text-text-muted opacity-0 group-hover:opacity-100 hover:text-status-error transition-all"
                    onClick={() => onRemove(entry.id)}
                    title={t("tokenManager.deleteToken")}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </>
              )}
            </div>
          ))}

          {tokens.length === 0 && (
            <div className="py-4 text-center text-sm text-text-muted">{t("tokenManager.noTokens")}</div>
          )}
        </div>

        {/* Add form */}
        <div className="border-t border-border pt-4 space-y-3">
          <div className="text-sm font-medium text-text-secondary">{t("tokenManager.addToken")}</div>
          <Form {...addForm}>
            <form onSubmit={handleAdd} className="space-y-2">
              <FormField
                control={addForm.control}
                name="token"
                render={({ field }) => (
                  <FormItem>
                    <FormControl>
                      <Input
                        type="text"
                        placeholder={t("tokenManager.tokenPlaceholder")}
                        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted font-mono"
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleAdd();
                        }}
                        {...field}
                      />
                    </FormControl>
                    <FormMessage className="text-xs text-status-error" />
                  </FormItem>
                )}
              />
              <div className="flex gap-2">
                <FormField
                  control={addForm.control}
                  name="label"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormControl>
                        <Input
                          type="text"
                          placeholder={t("tokenManager.labelPlaceholder")}
                          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted"
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleAdd();
                          }}
                          {...field}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
                <Button
                  type="submit"
                  size="icon"
                  disabled={!addForm.watch("token")?.trim()}
                  className="rounded-lg bg-brand px-3 py-2 text-white hover:bg-brand-light disabled:opacity-50 transition-colors flex-shrink-0"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
