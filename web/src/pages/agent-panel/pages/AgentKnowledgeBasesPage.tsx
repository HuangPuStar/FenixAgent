import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { kbApi } from "@/src/api/sdk";
import { NS } from "@/src/i18n";
import { unwrapApiResult } from "@/src/lib/api-result";
import type { KnowledgeBaseDetail, KnowledgeBaseInfo, KnowledgeResourceInfo } from "../../../types/knowledge";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString();
}

export function AgentKnowledgeBasesPage() {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<KnowledgeBaseInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [resources, setResources] = useState<KnowledgeResourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [editingItem, setEditingItem] = useState<KnowledgeBaseInfo | null>(null);

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const data = unwrapApiResult(await kbApi.list());
      setItems((Array.isArray(data) ? data : []) as KnowledgeBaseInfo[]);
    } catch (e) {
      console.error("Failed to load knowledge bases", e);
      toast.error(e instanceof Error ? e.message : t("loadError"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const loadDetail = useCallback(
    async (id: string) => {
      setDetailLoading(true);
      try {
        const [detailData, resourceData] = await Promise.all([
          kbApi.get({ id }).then(unwrapApiResult),
          kbApi.listResources({ id }).then(unwrapApiResult),
        ]);
        setSelectedDetail((detailData ?? {}) as KnowledgeBaseDetail);
        setResources(Array.isArray(resourceData) ? (resourceData as KnowledgeResourceInfo[]) : []);
        setSelectedId(id);
      } catch (e) {
        console.error("Failed to load detail", e);
        toast.error(e instanceof Error ? e.message : t("loadDetailError"));
      } finally {
        setDetailLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  const handleCreate = () => {
    setEditingItem(null);
    setFormName("");
    setFormSlug("");
    setFormDescription("");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) {
      toast.error(t("validation.nameRequired"));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: formName.trim(),
        slug: formSlug.trim() || undefined,
        description: formDescription.trim() || undefined,
      };
      if (editingItem) {
        await kbApi.update({ id: editingItem.id }, payload).then(unwrapApiResult);
        toast.success(t("toast.updated"));
      } else {
        await kbApi.create(payload).then(unwrapApiResult);
        toast.success(t("toast.created"));
      }
      setDialogOpen(false);
      loadItems();
    } catch (e) {
      console.error("Save failed", e);
      toast.error(e instanceof Error ? e.message : t("toast.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await kbApi.delete({ id: deleteTarget.id }).then(unwrapApiResult);
      toast.success(t("toast.deleted"));
      setConfirmOpen(false);
      if (selectedId === deleteTarget.id) {
        setSelectedId(null);
        setSelectedDetail(null);
        setResources([]);
      }
      setDeleteTarget(null);
      loadItems();
    } catch (e) {
      console.error("Delete failed", e);
      toast.error(e instanceof Error ? e.message : t("toast.deleteFailed"));
    }
  };

  const handleUpload = async (files: FileList) => {
    if (!selectedId || files.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append("files", file);
      }
      await kbApi.uploadResources({ id: selectedId }, formData).then(unwrapApiResult);
      toast.success(t("toast.uploaded"));
      loadDetail(selectedId);
    } catch (e) {
      console.error("Upload failed", e);
      toast.error(e instanceof Error ? e.message : t("toast.uploadFailed"));
    } finally {
      setUploading(false);
    }
  };

  const handleDeleteResource = async (resourceId: string) => {
    if (!selectedId) return;
    setDeletingResourceId(resourceId);
    try {
      await kbApi.deleteResource({ id: selectedId, resourceId }).then(unwrapApiResult);
      toast.success(t("toast.resourceDeleted"));
      loadDetail(selectedId);
    } catch (e) {
      console.error("Delete resource failed", e);
      toast.error(e instanceof Error ? e.message : t("toast.deleteResourceFailed"));
    } finally {
      setDeletingResourceId(null);
    }
  };

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <div className="mb-3 flex items-start justify-between gap-4">
          <div>
            <Skeleton className="h-[22px] w-28 rounded-md" />
            <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-28 rounded-lg" />
        </div>
        <div className="mb-3.5 h-px bg-[#e8edf4]" />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-16 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={<Button onClick={handleCreate}>{t("btn.create")}</Button>}
      />
      <div className="flex flex-1 min-h-0">
        {/* Left: KB list */}
        <div className="w-[280px] border-r border-border-subtle flex flex-col">
          <AgentCardList
            items={items}
            cardKey={(item) => item.id}
            searchPlaceholder={t("searchPlaceholder")}
            searchFn={(item, q) =>
              item.name.toLowerCase().includes(q) || (item.slug?.toLowerCase().includes(q) ?? false)
            }
            emptyMessage={t("emptyMessage")}
            renderCard={(kb) => (
              <button
                type="button"
                onClick={() => loadDetail(kb.id)}
                className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                  kb.id === selectedId
                    ? "border-brand bg-brand-subtle"
                    : "border-border-light bg-surface-1 hover:border-border"
                }`}
              >
                <p className="text-sm font-medium text-text-bright truncate">{kb.name}</p>
                <p className="text-xs text-text-muted">{kb.slug}</p>
                {kb.description && <p className="text-xs text-text-secondary mt-1 line-clamp-1">{kb.description}</p>}
              </button>
            )}
          />
        </div>
        {/* Right: KB detail */}
        <div className="flex-1 overflow-y-auto p-6">
          {detailLoading && (
            <div className="flex items-center justify-center h-64">
              <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
            </div>
          )}
          {!detailLoading && !selectedDetail && (
            <div className="flex flex-col items-center justify-center h-64 text-text-muted">
              <p className="text-sm">{t("selectHint")}</p>
            </div>
          )}
          {!detailLoading && selectedDetail && (
            <div className="max-w-[720px] mx-auto space-y-6">
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-lg font-bold text-text-bright">{selectedDetail.name}</h2>
                  <p className="text-sm text-text-muted">{selectedDetail.slug}</p>
                  {selectedDetail.description && (
                    <p className="text-sm text-text-secondary mt-1">{selectedDetail.description}</p>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setEditingItem(items.find((i) => i.id === selectedId) ?? null);
                      setFormName(selectedDetail.name);
                      setFormSlug(selectedDetail.slug ?? "");
                      setFormDescription(selectedDetail.description ?? "");
                      setDialogOpen(true);
                    }}
                  >
                    {t("btn.edit")}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => {
                      setDeleteTarget(items.find((i) => i.id === selectedId) ?? null);
                      setConfirmOpen(true);
                    }}
                  >
                    {t("btn.delete")}
                  </Button>
                </div>
              </div>

              {/* Resources */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t("resources.title", { count: resources.length })}
                  </h3>
                  <div className="flex gap-2">
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      onChange={(e) => e.target.files && handleUpload(e.target.files)}
                      className="hidden"
                    />
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={uploading}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      {uploading ? t("btn.uploading") : t("btn.upload")}
                    </Button>
                  </div>
                </div>
                <div className="grid gap-2">
                  {resources.map((r) => (
                    <div
                      key={r.id}
                      className="group flex items-center gap-3 rounded-lg border border-border-light bg-surface-1 px-4 py-2.5"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-text-bright">{r.sourceName}</p>
                        <p className="text-xs text-text-muted">{formatTimestamp(r.createdAt)}</p>
                      </div>
                      <Button
                        size="xs"
                        variant="ghost"
                        className="opacity-0 group-hover:opacity-100 text-text-muted hover:text-destructive"
                        disabled={deletingResourceId === r.id}
                        onClick={() => handleDeleteResource(r.id)}
                      >
                        {t("btn.delete")}
                      </Button>
                    </div>
                  ))}
                  {resources.length === 0 && (
                    <p className="text-sm text-text-muted text-center py-4">{t("resources.empty")}</p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingItem ? t("dialog.editTitle") : t("dialog.createTitle")}
        onSubmit={handleSave}
        loading={saving}
      >
        <div className="space-y-4">
          <div>
            <Label>{t("form.name")}</Label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>{t("form.slug")}</Label>
            <Input value={formSlug} onChange={(e) => setFormSlug(e.target.value)} className="mt-1" />
          </div>
          <div>
            <Label>{t("form.description")}</Label>
            <Textarea value={formDescription} onChange={(e) => setFormDescription(e.target.value)} className="mt-1" />
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
