import { useRequest } from "ahooks";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { kbApi } from "@/src/api/knowledge-bases";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedDetail, setSelectedDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [resources, setResources] = useState<KnowledgeResourceInfo[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseInfo | null>(null);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [editingItem, setEditingItem] = useState<KnowledgeBaseInfo | null>(null);

  // 列表查询
  const {
    data: listData,
    loading,
    refresh,
  } = useRequest(() => unwrap(kbApi.list()), {
    onError: (err) => {
      console.error("Failed to load knowledge bases", err);
      toast.error(err instanceof Error ? err.message : t("loadError"));
    },
  });
  const items: KnowledgeBaseInfo[] = Array.isArray(listData) ? listData : [];

  // 详情查询（手动触发）
  const { run: runLoadDetail, loading: detailLoading } = useRequest(
    (id: string) => Promise.all([unwrap(kbApi.get({ id })), unwrap(kbApi.listResources({ id }))]),
    {
      manual: true,
      onSuccess: ([detail, resList]) => {
        setSelectedDetail(detail);
        setResources(Array.isArray(resList) ? resList : []);
      },
      onError: (err) => {
        console.error("Failed to load detail", err);
        toast.error(err instanceof Error ? err.message : t("loadDetailError"));
      },
    },
  );

  // 创建知识库
  const { run: runCreate, loading: createSaving } = useRequest(
    (payload: { name: string; slug: string; description?: string }) => unwrap(kbApi.create(payload)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.created"));
        setDialogOpen(false);
        refresh();
      },
      onError: (err) => {
        console.error("Create failed", err);
        toast.error(err instanceof Error ? err.message : t("toast.saveFailed"));
      },
    },
  );

  // 更新知识库（静默操作，不弹 toast）
  const { run: runUpdate, loading: updateSaving } = useRequest(
    (id: string, payload: { name: string; description?: string }) => unwrap(kbApi.update({ id }, payload)),
    {
      manual: true,
      onSuccess: () => {
        setDialogOpen(false);
        refresh();
      },
      onError: (err) => {
        console.error("Update failed", err);
        toast.error(err instanceof Error ? err.message : t("toast.saveFailed"));
      },
    },
  );

  const saving = createSaving || updateSaving;

  // 删除知识库（静默操作，不弹 toast）
  const { run: runDelete } = useRequest((id: string) => unwrap(kbApi.del({ id })), {
    manual: true,
    onSuccess: (_data, [id]) => {
      setConfirmOpen(false);
      if (selectedId === id) {
        setSelectedId(null);
        setSelectedDetail(null);
        setResources([]);
      }
      setDeleteTarget(null);
      refresh();
    },
    onError: (err) => {
      console.error("Delete failed", err);
      toast.error(err instanceof Error ? err.message : t("toast.deleteFailed"));
    },
  });

  // 上传资源
  const { run: runUpload, loading: uploading } = useRequest(
    (id: string, formData: FormData) => unwrap(kbApi.uploadResources({ id }, formData)),
    {
      manual: true,
      onSuccess: (_data, [id]) => {
        toast.success(t("toast.uploaded"));
        runLoadDetail(id as string);
      },
      onError: (err) => {
        console.error("Upload failed", err);
        toast.error(err instanceof Error ? err.message : t("toast.uploadFailed"));
      },
    },
  );

  // 删除资源（静默操作，不弹 toast）
  const { run: runDeleteResource } = useRequest(
    (kbId: string, resourceId: string) => unwrap(kbApi.deleteResource({ kbId, resourceId })),
    {
      manual: true,
      onSuccess: (_data, [kbId]) => {
        setDeletingResourceId(null);
        runLoadDetail(kbId as string);
      },
      onError: (err) => {
        console.error("Delete resource failed", err);
        setDeletingResourceId(null);
        toast.error(err instanceof Error ? err.message : t("toast.deleteResourceFailed"));
      },
    },
  );

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
        actions={
          <Button
            onClick={() => {
              setEditingItem(null);
              setFormName("");
              setFormDescription("");
              setDialogOpen(true);
            }}
          >
            {t("btn.create")}
          </Button>
        }
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
                onClick={() => {
                  setSelectedId(kb.id);
                  runLoadDetail(kb.id);
                }}
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
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0 && selectedId) {
                          const formData = new FormData();
                          for (const file of e.target.files) {
                            formData.append("files", file);
                          }
                          runUpload(selectedId, formData);
                        }
                      }}
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
                        onClick={() => {
                          setDeletingResourceId(r.id);
                          runDeleteResource(selectedId!, r.id);
                        }}
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
        onSubmit={() => {
          if (!formName.trim()) {
            toast.error(t("validation.nameRequired"));
            return;
          }
          const name = formName.trim();
          const description = formDescription.trim() || undefined;
          if (editingItem) {
            // 更新时只传 name 和 description，slug 保持不变
            runUpdate(editingItem.id, { name, description });
          } else {
            // 创建时根据名称自动生成 slug（kebab-case）
            const slug = name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "");
            runCreate({ name, slug, description });
          }
        }}
        loading={saving}
      >
        <div className="space-y-4">
          <div>
            <Label>{t("form.name")}</Label>
            <Input value={formName} onChange={(e) => setFormName(e.target.value)} className="mt-1" />
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
        onConfirm={() => {
          if (deleteTarget) runDelete(deleteTarget.id);
        }}
      />
    </div>
  );
}
