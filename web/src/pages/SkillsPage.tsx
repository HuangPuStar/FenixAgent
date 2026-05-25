import { Search, Upload } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type Column, DataTable } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { skillConfigApi } from "@/src/api/sdk";
import { dispatchConfigChange } from "../lib/config-events";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../lib/skill-upload";
import type { SkillUploadConflictResponse, SkillUploadConflictStrategy, UploadSkillSummary } from "../types/config";

type SkillInfo = {
  id: string;
  name: string;
  description: string;
};

type CreateMode = "text" | "upload";

type SkillUploadResult = {
  imported: unknown[];
  skipped: unknown[];
};

export function validateSkillForm(name: string, content: string, t: (key: string) => string): string | null {
  if (!name.trim()) return t("form.nameRequired");
  if (!content.trim()) return t("form.contentRequired");
  return null;
}

export function getUploadResultMessage(
  imported: number,
  skipped: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string {
  if (skipped > 0) {
    return t("toast.importResultWithSkipped", { imported, skipped });
  }
  return t("toast.importResult", { imported });
}

export function normalizeSkillUploadResult(response: unknown): SkillUploadResult {
  const data = response as Partial<SkillUploadResult> | null;
  return {
    imported: Array.isArray(data?.imported) ? data.imported : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
  };
}

export function getUploadConflictData(error: unknown): SkillUploadConflictResponse | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    (error as { code?: string }).code !== "SKILL_CONFLICT"
  ) {
    return null;
  }
  const data = (error as { data?: SkillUploadConflictResponse }).data;
  if (!data || !Array.isArray(data.conflicts) || !Array.isArray(data.allowedStrategies)) {
    return null;
  }
  return data;
}

export function getUploadItemSummaries(
  items: UploadSkillSummary[],
  t: (key: string, opts?: Record<string, unknown>) => string,
): string[] {
  return items.map((item) =>
    item.hasSkillMd
      ? t("upload.itemSummary", {
          name: item.skillName,
          count: item.fileCount,
        })
      : t("upload.itemSummaryMissing", {
          name: item.skillName,
          count: item.fileCount,
        }),
  );
}

export function getInvalidUploadSkillNames(items: UploadSkillSummary[]): string[] {
  return items.filter((item) => !item.hasSkillMd).map((item) => item.skillName);
}

function UploadItemCard({ item }: { item: UploadSkillSummary }) {
  const { t } = useTranslation("skills");
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
        item.hasSkillMd
          ? "border-border-light bg-surface-1 hover:border-border"
          : "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20"
      }`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium text-text-bright truncate">{item.skillName}</span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface-2 text-text-muted">
            {t("upload.files", { count: item.fileCount })}
          </span>
        </div>
      </div>
      {!item.hasSkillMd && (
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium whitespace-nowrap">
          {t("upload.missingSkillMd")}
        </span>
      )}
      {item.hasSkillMd && <span className="text-xs text-status-active font-medium">{t("upload.importable")}</span>}
    </div>
  );
}

const directoryInputProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

// --- Main Page ---

export function SkillsPage() {
  const { t } = useTranslation("skills");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillInfo[]>([]);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [createMode, setCreateMode] = useState<CreateMode>("text");
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadItems, setUploadItems] = useState<UploadSkillSummary[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SkillUploadConflictResponse["conflicts"]>([]);
  const [_conflictStrategy, setConflictStrategy] = useState<SkillUploadConflictStrategy | null>(null);
  const [uploadPending, setUploadPending] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);

  const resetUploadState = useCallback(() => {
    setUploadItems([]);
    setUploadError(null);
    setConflicts([]);
    setConflictStrategy(null);
    setUploadPending(false);
    setOverwriteConfirmOpen(false);
  }, []);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    const { data: res, error } = await skillConfigApi.list();
    if (error) {
      console.error(t("toast.loadListFailed"), error);
      toast.error(
        t("toast.loadListFailedWith", {
          message: error.message,
        }),
      );
    } else {
      setSkills((Array.isArray(res) ? res : []) as unknown as SkillInfo[]);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter((s) => s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q));
  }, [skills, searchQuery]);

  const handleOpenCreate = (mode: CreateMode) => {
    setEditingSkill(null);
    setCreateMode(mode);
    setFormName("");
    setFormDescription("");
    setFormContent("");
    resetUploadState();
    setDialogOpen(true);
  };

  const handleOpenEdit = async (skill: SkillInfo) => {
    setEditingSkill(skill);
    setCreateMode("text");
    resetUploadState();
    const { data: detail, error } = await skillConfigApi.get(skill.name);
    if (error) {
      toast.error(t("toast.loadDetailFailed"));
    } else {
      setFormName(((detail as Record<string, unknown>)?.name as string) ?? "");
      setFormDescription(((detail as Record<string, unknown>)?.description as string) ?? "");
      setFormContent(((detail as Record<string, unknown>)?.content as string) ?? "");
    }
    setDialogOpen(true);
  };

  const handleTextSave = async () => {
    const err = validateSkillForm(formName, formContent, t);
    if (err) {
      toast.error(err);
      return;
    }
    setFormSaving(true);
    const { error } = await skillConfigApi.set(formName, { description: formDescription, content: formContent });
    if (error) {
      toast.error(
        t("toast.saveFailedWith", {
          message: error.message,
        }),
      );
    } else {
      toast.success(editingSkill ? t("toast.skillUpdated") : t("toast.skillCreated"));
      setDialogOpen(false);
      loadSkills();
      dispatchConfigChange("skills");
    }
    setFormSaving(false);
  };

  const handleUploadSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const items = parseSkillUploadFiles(files);
    const error = validateUploadBatch(items);
    setUploadItems(items);
    setUploadError(error);
    setConflicts([]);
    setConflictStrategy(null);
  };

  const handleUploadSubmit = async (strategy?: SkillUploadConflictStrategy) => {
    const validationError = validateUploadBatch(uploadItems);
    if (validationError) {
      setUploadError(validationError);
      toast.error(validationError);
      return;
    }
    setUploadPending(true);
    const formData = buildSkillUploadFormData(uploadItems, strategy);
    const { data: uploadResult, error: uploadError } = await skillConfigApi.upload(formData);
    if (uploadError) {
      const conflictData = getUploadConflictData(uploadError);
      if (conflictData) {
        console.error(t("toast.importFailed"), uploadError);
        setConflicts(conflictData.conflicts);
        setConflictStrategy(strategy ?? null);
        toast.error(t("conflict.detected"));
      } else {
        console.error(t("toast.importFailed"), uploadError);
        toast.error(
          t("toast.importFailedWith", {
            message: uploadError.message,
          }),
        );
      }
    } else {
      const result = normalizeSkillUploadResult(uploadResult);
      toast.success(getUploadResultMessage(result.imported.length, result.skipped.length, t));
      setDialogOpen(false);
      resetUploadState();
      loadSkills();
      dispatchConfigChange("skills");
    }
    setUploadPending(false);
    setOverwriteConfirmOpen(false);
  };

  const handleDialogSubmit = async () => {
    if (editingSkill || createMode === "text") {
      await handleTextSave();
      return;
    }
    await handleUploadSubmit();
  };

  const handleDeleteClick = (skill: SkillInfo) => {
    setDeleteTarget(skill.name);
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { error } = await skillConfigApi.delete(deleteTarget);
    if (error) {
      console.error(t("toast.deleteFailed"), error);
      toast.error(
        t("toast.deleteFailedWith", {
          message: error.message,
        }),
      );
      return;
    }
    toast.success(t("toast.skillDeleted"));
    setConfirmOpen(false);
    loadSkills();
    dispatchConfigChange("skills");
  };

  const confirmBatchDelete = async () => {
    await Promise.all(selected.map((s) => skillConfigApi.delete(s.name)));
    toast.success(t("toast.batchDeleted", { count: selected.length }));
    setBatchConfirmOpen(false);
    setSelected([]);
    loadSkills();
    dispatchConfigChange("skills");
  };

  const columns: Column<SkillInfo>[] = [
    {
      key: "name",
      header: t("column.name"),
      sortable: true,
      filterable: true,
      render: (row) => <span className="font-mono text-sm font-medium text-text-bright">{row.name}</span>,
    },
    {
      key: "description",
      header: t("column.description"),
      render: (row) => <span className="text-sm text-text-secondary line-clamp-1">{row.description || "—"}</span>,
    },
  ];

  if (loading) {
    return (
      <div className="p-6 space-y-4">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-bright">{t("title")}</h2>
          <p className="text-sm text-text-muted mt-0.5">{t("subtitle")}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => handleOpenCreate("upload")}>
            {t("btn.uploadSkill")}
          </Button>
          <Button onClick={() => handleOpenCreate("text")}>{t("btn.createSkill")}</Button>
        </div>
      </div>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" />
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder={t("search")}
          className="pl-9"
        />
      </div>
      <DataTable<SkillInfo>
        columns={columns}
        data={filteredSkills}
        rowKey={(row) => row.id}
        selectable
        onSelectionChange={setSelected}
        emptyMessage={t("empty")}
        actions={(row) => (
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={() => handleOpenEdit(row)}>
              {t("btn.edit")}
            </Button>
            <Button size="xs" variant="destructive" onClick={() => handleDeleteClick(row)}>
              {t("btn.delete")}
            </Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[
            {
              label: t("btn.batchDelete"),
              variant: "destructive",
              onClick: () => setBatchConfirmOpen(true),
            },
          ]}
        />
      )}

      {/* FormDialog */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetUploadState();
        }}
        title={editingSkill ? t("dialog.editTitle") : t("dialog.createTitle")}
        onSubmit={handleDialogSubmit}
        submitLabel={editingSkill || createMode === "text" ? t("dialog.save") : t("dialog.startUpload")}
        loading={editingSkill || createMode === "text" ? formSaving : uploadPending}
        disabled={!editingSkill && createMode === "upload" && uploadItems.filter((i) => i.hasSkillMd).length === 0}
        width="sm:max-w-4xl"
      >
        {!editingSkill ? (
          <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as CreateMode)} className="min-h-0">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload">{t("dialog.uploadTab")}</TabsTrigger>
              <TabsTrigger value="text">{t("dialog.createTab")}</TabsTrigger>
            </TabsList>
            <TabsContent value="upload" className="space-y-4">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleUploadSelection}
                className="hidden"
                {...directoryInputProps}
              />
              {uploadItems.length === 0 ? (
                <div
                  className="rounded-xl border-2 border-dashed border-border-light bg-surface-2/30 p-8 text-center cursor-pointer transition-colors hover:border-brand/40 hover:bg-brand-subtle/30"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-surface-2">
                    <Upload className="h-6 w-6 text-text-muted" strokeWidth={1.5} />
                  </div>
                  <p className="text-sm font-medium text-text-primary">{t("upload.selectFolder")}</p>
                  <p className="mt-1 text-xs text-text-muted">{t("upload.selectFolderHint")}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {t("upload.selectedDirs", {
                        count: uploadItems.length,
                      })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setUploadItems([]);
                        setUploadError(null);
                        if (fileInputRef.current) fileInputRef.current.value = "";
                        fileInputRef.current?.click();
                      }}
                    >
                      {t("btn.reselect")}
                    </Button>
                  </div>
                  <div className="grid gap-2 max-h-48 overflow-y-auto">
                    {uploadItems.map((item) => (
                      <UploadItemCard key={item.skillName} item={item} />
                    ))}
                  </div>
                </div>
              )}
              {uploadError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive">
                  {uploadError}
                </div>
              )}
              {conflicts.length > 0 && (
                <div className="space-y-3 rounded-lg border border-warning-border bg-warning-bg px-4 py-3 text-sm">
                  <div className="font-medium text-warning-text">{t("conflict.title")}</div>
                  <div className="space-y-1">
                    {conflicts.map((conflict) => (
                      <div key={conflict.name} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-text-primary">{conflict.name}</span>
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => handleUploadSubmit("ignore")}
                      disabled={uploadPending}
                    >
                      {t("conflict.skipConflicts")}
                    </Button>
                    <Button
                      type="button"
                      variant="destructive"
                      size="sm"
                      onClick={() => setOverwriteConfirmOpen(true)}
                      disabled={uploadPending}
                    >
                      {t("conflict.overwriteExisting")}
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="text" className="space-y-4">
              <div>
                <label className="text-sm font-medium text-text-primary">{t("form.name")}</label>
                <Input
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="my-skill"
                  className="mt-1 font-mono text-sm"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-text-primary">{t("form.description")}</label>
                <Textarea
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="mt-1 min-h-[80px] text-sm"
                  placeholder={t("form.descriptionPlaceholder")}
                />
              </div>
              <div>
                <label className="text-sm font-medium text-text-primary">{t("form.content")}</label>
                <p className="text-xs text-text-muted mb-1.5">{t("form.contentHint")}</p>
                <Textarea
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                  className="min-h-[300px] font-mono text-sm"
                  placeholder={t("form.contentPlaceholder")}
                />
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-text-primary">{t("form.name")}</label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                disabled
                className="mt-1 font-mono text-sm text-text-muted"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("form.description")}</label>
              <Textarea
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                className="mt-1 min-h-[80px] text-sm"
                placeholder={t("form.descriptionPlaceholder")}
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">{t("form.content")}</label>
              <p className="text-xs text-text-muted mb-1.5">{t("form.contentHint")}</p>
              <Textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
                placeholder={t("form.contentPlaceholder")}
              />
            </div>
          </div>
        )}
      </FormDialog>

      {/* Delete confirm */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", {
          name: deleteTarget ?? "",
        })}
        variant="destructive"
        onConfirm={confirmDelete}
      />

      {/* Batch delete confirm */}
      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title={t("confirm.batchDeleteTitle")}
        description={t("confirm.batchDeleteDescription", {
          count: selected.length,
          workspaceHint: t("confirm.batchDeleteHint"),
        })}
        variant="destructive"
        onConfirm={confirmBatchDelete}
      />

      {/* Overwrite confirm */}
      <ConfirmDialog
        open={overwriteConfirmOpen}
        onOpenChange={setOverwriteConfirmOpen}
        title={t("confirm.overwriteTitle")}
        description={t("confirm.overwriteDescription")}
        variant="destructive"
        confirmLabel={t("confirm.overwriteConfirm")}
        onConfirm={() => void handleUploadSubmit("overwrite")}
        loading={uploadPending}
      />
    </div>
  );
}
