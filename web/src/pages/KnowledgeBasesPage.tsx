import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type Column, DataTable } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { kbApi } from "@/src/api/sdk";
import type {
  KnowledgeBaseDetail,
  KnowledgeBaseInfo,
  KnowledgeResourceInfo,
  KnowledgeUploadResponse,
} from "../types/knowledge";

export async function loadKnowledgeBasesData() {
  const { data } = await kbApi.list();
  return data as KnowledgeBaseInfo[];
}

export async function loadKnowledgeBaseDetailData(knowledgeBaseId: string) {
  const [detailResult, resourcesResult] = await Promise.all([
    kbApi.get({ id: knowledgeBaseId }),
    kbApi.listResources({ id: knowledgeBaseId }),
  ]);
  const detail = detailResult.data as KnowledgeBaseDetail;
  const resources = Array.isArray(resourcesResult.data) ? (resourcesResult.data as KnowledgeResourceInfo[]) : [];
  return {
    detail,
    resources,
  };
}

export async function uploadKnowledgeBaseFiles(
  knowledgeBaseId: string,
  files: File[],
): Promise<KnowledgeUploadResponse> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  const { data } = await kbApi.uploadResources({ id: knowledgeBaseId }, formData);
  return data as unknown as KnowledgeUploadResponse;
}

export function summarizeKnowledgeDetail(detail: KnowledgeBaseDetail, resources: KnowledgeResourceInfo[]) {
  return {
    lastError: detail.lastError ?? resources.find((item) => item.lastError)?.lastError ?? null,
    resourcesCount: resources.length,
    resourceNames: resources.map((item) => item.sourceName),
  };
}

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString();
}

export function KnowledgeBasesPage() {
  const { t } = useTranslation("knowledge");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<KnowledgeBaseInfo[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [resources, setResources] = useState<KnowledgeResourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<KnowledgeBaseInfo | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseInfo | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [importingUrl, setImportingUrl] = useState(false);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formSlug, setFormSlug] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [urlSourceName, setUrlSourceName] = useState("");

  const loadItems = useCallback(async () => {
    setLoading(true);
    try {
      const list = await loadKnowledgeBasesData();
      setItems(list);
      const nextId = selectedId && list.some((item) => item.id === selectedId) ? selectedId : (list[0]?.id ?? null);
      setSelectedId(nextId);
    } catch (error) {
      console.error(t("loadFailed"), error);
      toast.error(`${t("loadFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
    } finally {
      setLoading(false);
    }
  }, [selectedId, t]);

  const loadDetail = useCallback(
    async (knowledgeBaseId: string) => {
      setDetailLoading(true);
      try {
        const data = await loadKnowledgeBaseDetailData(knowledgeBaseId);
        setSelectedDetail(data.detail as unknown as KnowledgeBaseDetail);
        setResources(data.resources);
      } catch (error) {
        console.error(t("loadDetailFailed"), error);
        toast.error(`${t("loadDetailFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
      } finally {
        setDetailLoading(false);
      }
    },
    [t],
  );

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (selectedId) {
      loadDetail(selectedId);
      return;
    }
    setSelectedDetail(null);
    setResources([]);
  }, [selectedId, loadDetail]);

  const columns: Column<KnowledgeBaseInfo>[] = [
    { key: "name", header: t("columns.name"), sortable: true, filterable: true },
    {
      key: "status",
      header: t("columns.status"),
      filterable: true,
      render: (row) => <StatusBadge status={row.status} />,
    },
    { key: "resourcesCount", header: t("columns.resourcesCount"), sortable: true },
    {
      key: "updatedAt",
      header: t("columns.updatedAt"),
      sortable: true,
      render: (row) => formatTimestamp(row.updatedAt),
    },
    { key: "bindingsCount", header: t("columns.bindingsCount"), sortable: true },
  ];

  const handleOpenCreate = () => {
    setEditingItem(null);
    setFormName("");
    setFormSlug("");
    setFormDescription("");
    setDialogOpen(true);
  };

  const handleOpenEdit = () => {
    if (!selectedDetail) return;
    setEditingItem(selectedDetail);
    setFormName(selectedDetail.name);
    setFormSlug(selectedDetail.slug);
    setFormDescription(selectedDetail.description ?? "");
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!formName.trim() || !formSlug.trim()) {
      toast.error(t("nameAndSlugRequired"));
      return;
    }
    setSaving(true);
    try {
      if (editingItem) {
        await kbApi.update({ id: editingItem.id }, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
        } as unknown as Parameters<typeof kbApi.update>[1]);
        toast.success(t("knowledgeBaseUpdated"));
      } else {
        await kbApi.create({
          name: formName.trim(),
          slug: formSlug.trim(),
          description: formDescription.trim() || undefined,
        } as unknown as Parameters<typeof kbApi.create>[0]);
        toast.success(t("knowledgeBaseCreated"));
      }
      setDialogOpen(false);
      await loadItems();
    } catch (error) {
      console.error(t("saveFailed"), error);
      toast.error(`${t("saveFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await kbApi.delete({ id: deleteTarget.id });
      toast.success(t("knowledgeBaseDeleted"));
      setConfirmOpen(false);
      if (selectedId === deleteTarget.id) {
        setSelectedId(null);
      }
      await loadItems();
    } catch (error) {
      console.error(t("deleteFailed"), error);
      toast.error(`${t("deleteFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    if (!selectedId) return;
    const files = Array.from(event.target.files ?? []);
    if (files.length === 0) return;
    setUploading(true);
    try {
      await uploadKnowledgeBaseFiles(selectedId, files);
      toast.success(t("filesUploaded", { count: files.length }));
      await loadDetail(selectedId);
      await loadItems();
    } catch (error) {
      console.error(t("uploadFailed"), error);
      toast.error(`${t("uploadFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  const handleImportUrl = async () => {
    if (!selectedId || !urlValue.trim()) {
      toast.error(t("enterResourceUrl"));
      return;
    }
    setImportingUrl(true);
    try {
      await kbApi.importUrl(
        { id: selectedId },
        {
          url: urlValue.trim(),
          sourceName: urlSourceName.trim() || undefined,
        },
      );
      toast.success(t("urlResourceSubmitted"));
      setUrlValue("");
      setUrlSourceName("");
      await loadDetail(selectedId);
      await loadItems();
    } catch (error) {
      console.error(t("importFailed"), error);
      toast.error(`${t("importFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
    } finally {
      setImportingUrl(false);
    }
  };

  const handleDeleteResource = async (resourceId: string) => {
    if (!selectedId) return;
    setDeletingResourceId(resourceId);
    try {
      await kbApi.deleteResource({ id: selectedId, resourceId });
      toast.success(t("resourceDeleted"));
      await loadDetail(selectedId);
      await loadItems();
    } catch (error) {
      console.error(t("deleteResourceFailed"), error);
      toast.error(`${t("deleteResourceFailed")}: ${error instanceof Error ? error.message : t("saveFailed")}`);
    } finally {
      setDeletingResourceId(null);
    }
  };

  const detailSummary = selectedDetail ? summarizeKnowledgeDetail(selectedDetail, resources) : null;

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-40" />
        <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
          <Skeleton className="h-[420px] w-full" />
          <Skeleton className="h-[420px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-text-bright">{t("title")}</h2>
          <p className="mt-0.5 text-sm text-text-muted">{t("subtitle")}</p>
        </div>
        <Button onClick={handleOpenCreate}>{t("newKnowledgeBase")}</Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="rounded-xl border border-border-subtle bg-surface-0 p-4">
          <DataTable<KnowledgeBaseInfo>
            columns={columns}
            data={items}
            searchable
            searchPlaceholder={t("table.searchPlaceholder")}
            emptyMessage={t("table.emptyMessage")}
            actions={(row) => (
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant={row.id === selectedId ? "default" : "outline"}
                  onClick={() => setSelectedId(row.id)}
                >
                  {t("actions.detail")}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    setSelectedId(row.id);
                    setTimeout(() => fileInputRef.current?.click(), 0);
                  }}
                >
                  {t("actions.upload")}
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(row);
                    setConfirmOpen(true);
                  }}
                >
                  {t("actions.delete")}
                </Button>
              </div>
            )}
          />
        </div>

        <div className="rounded-xl border border-border-subtle bg-surface-0 p-4">
          {detailLoading ? (
            <div className="space-y-3">
              <Skeleton className="h-6 w-32" />
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-40 w-full" />
            </div>
          ) : selectedDetail ? (
            <div className="space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-text-bright">{selectedDetail.name}</h3>
                  <p className="text-xs text-text-muted">
                    {t("detail.slug")}: {selectedDetail.slug}
                  </p>
                </div>
                <Button size="sm" variant="outline" onClick={handleOpenEdit}>
                  {t("detail.edit")}
                </Button>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <StatusBadge status={selectedDetail.status} />
                  <span className="text-text-muted">
                    {t("detail.boundAgents", { count: selectedDetail.bindingsCount })}
                  </span>
                </div>
                <p className="text-text-secondary">{selectedDetail.description || t("detail.noDescription")}</p>
                {detailSummary?.lastError && (
                  <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                    {t("detail.recentError")}: {detailSummary.lastError}
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-bright">{t("detail.uploadResources")}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={uploading}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    {uploading ? t("detail.uploading") : t("detail.selectFile")}
                  </Button>
                </div>
                <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileChange} />
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <Input
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    placeholder={t("detail.importUrlPlaceholder")}
                  />
                  <Button size="sm" disabled={importingUrl} onClick={handleImportUrl}>
                    {importingUrl ? t("detail.importing") : t("detail.importUrl")}
                  </Button>
                </div>
                <Input
                  value={urlSourceName}
                  onChange={(e) => setUrlSourceName(e.target.value)}
                  placeholder={t("detail.sourceNamePlaceholder")}
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium text-text-bright">{t("detail.resourceList")}</span>
                  <span className="text-xs text-text-muted">
                    {t("detail.resourceCount", { count: detailSummary?.resourcesCount ?? 0 })}
                  </span>
                </div>
                <div className="max-h-[320px] space-y-2 overflow-y-auto">
                  {resources.length === 0 ? (
                    <p className="text-sm text-text-muted">{t("detail.noResources")}</p>
                  ) : (
                    resources.map((resource) => (
                      <div key={resource.id} className="rounded-lg border border-border-subtle px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <p className="truncate text-sm font-medium text-text-bright">{resource.sourceName}</p>
                          <div className="flex items-center gap-2">
                            <StatusBadge status={resource.status} />
                            <Button
                              size="xs"
                              variant="outline"
                              disabled={deletingResourceId === resource.id}
                              onClick={() => void handleDeleteResource(resource.id)}
                            >
                              {deletingResourceId === resource.id ? t("detail.deleting") : t("detail.delete")}
                            </Button>
                          </div>
                        </div>
                        <p className="mt-1 text-xs text-text-muted">
                          {resource.sourceType} · {formatTimestamp(resource.updatedAt)}
                        </p>
                        {resource.lastError && <p className="mt-2 text-xs text-red-600">{resource.lastError}</p>}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          ) : (
            <p className="text-sm text-text-muted">{t("detail.selectToView")}</p>
          )}
        </div>
      </div>

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingItem ? t("form.editTitle") : t("form.createTitle")}
        onSubmit={handleSave}
        loading={saving}
      >
        <div className="space-y-4">
          <div>
            <Label>{t("form.name")}</Label>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("form.namePlaceholder")}
            />
          </div>
          <div>
            <Label>{t("form.slug")}</Label>
            <Input
              value={formSlug}
              onChange={(e) => setFormSlug(e.target.value)}
              placeholder={t("form.slugPlaceholder")}
            />
          </div>
          <div>
            <Label>{t("form.description")}</Label>
            <Textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              rows={4}
              placeholder={t("form.descriptionPlaceholder")}
            />
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.title")}
        description={t("confirm.description", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
