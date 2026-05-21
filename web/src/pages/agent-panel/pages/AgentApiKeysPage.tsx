import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { apiPost } from "../../../api/client";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface ApiKeyInfo {
  id: string;
  name: string;
  prefix: string;
  createdAt: number;
  expiresAt: number | null;
}

export function AgentApiKeysPage() {
  const { t } = useTranslation("apikey");
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    setLoading(true);
    try {
      const list = await apiPost<ApiKeyInfo[]>("/web/apiKeys", { action: "list" });
      setKeys(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
      toast.error(t("toast.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleCreate = () => {
    setFormName("");
    setNewKeyValue(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameRequired"));
      return;
    }
    setFormSaving(true);
    try {
      const result = await apiPost<{ key?: string }>("/web/apiKeys", { action: "create", name: formName.trim() });
      if (result?.key) {
        setNewKeyValue(result.key);
      }
      toast.success(t("toast.created"));
      loadKeys();
    } catch (err) {
      console.error(err);
      toast.error(t("toast.createFailed"));
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiPost("/web/apiKeys", { action: "delete", id: deleteTarget });
      toast.success(t("toast.deleted"));
      setConfirmOpen(false);
      setDeleteTarget(null);
      loadKeys();
    } catch (err) {
      console.error(err);
      toast.error(t("toast.deleteFailed"));
    }
  };

  const formatDate = (ts: number | null) => {
    if (!ts) return "—";
    return new Date(ts).toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="flex flex-col flex-1 min-h-0">
        <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
        <div className="flex-1 overflow-y-auto p-6 space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={<Button onClick={handleCreate}>{t("btn.create")}</Button>}
      />
      <AgentCardList
        items={keys}
        cardKey={(k) => k.id}
        searchPlaceholder={t("searchPlaceholder")}
        searchFn={(k, q) => k.name.toLowerCase().includes(q)}
        emptyMessage={t("emptyMessage")}
        renderCard={(key) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-bright">{key.name}</span>
                  <span className="font-mono text-xs text-text-muted bg-surface-2 px-1.5 py-0.5 rounded">
                    {key.prefix}...
                  </span>
                </div>
                <p className="text-xs text-text-dim mt-1">
                  {t("column.created")}: {formatDate(key.createdAt)}
                  {key.expiresAt && ` · ${t("column.expires")}: ${formatDate(key.expiresAt)}`}
                </p>
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(key.id);
                    setConfirmOpen(true);
                  }}
                >
                  {t("btn.revoke")}
                </Button>
              </div>
            </div>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setNewKeyValue(null);
        }}
        title={t("dialog.createTitle")}
        onSubmit={handleSave}
        loading={formSaving}
      >
        <div className="space-y-4">
          {newKeyValue ? (
            <div className="space-y-3">
              <p className="text-sm text-text-secondary">{t("dialog.keyCreated")}</p>
              <div className="rounded-lg border bg-surface-2 p-3">
                <code className="text-sm font-mono text-text-bright break-all">{newKeyValue}</code>
              </div>
              <p className="text-xs text-text-muted">{t("dialog.keyWarning")}</p>
            </div>
          ) : (
            <div>
              <Label>{t("form.name")}</Label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} className="mt-1" />
            </div>
          )}
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.revokeTitle")}
        description={t("confirm.revokeDescription")}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
