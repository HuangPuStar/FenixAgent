import { Sparkles } from "lucide-react";
import { type ChangeEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { skillConfigApi } from "@/src/api/sdk";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillLookupKey,
  getSkillOptionLabel,
  getSkillResourceBadgeKey,
} from "../../../lib/skill-resource-access";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../../../lib/skill-upload";
import type {
  ResourceAccess,
  SkillDetail,
  SkillUploadConflictResponse,
  SkillUploadConflictStrategy,
  UploadSkillSummary,
} from "../../../types/config";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

type SkillInfo = { id: string; name: string; description: string; resourceAccess?: ResourceAccess };
type CreateMode = "text" | "upload";
type SkillUploadResult = { imported: unknown[]; skipped: unknown[] };

function normalizeSkillUploadResult(response: unknown): SkillUploadResult {
  const data = response as Partial<SkillUploadResult> | null;
  return {
    imported: Array.isArray(data?.imported) ? data.imported : [],
    skipped: Array.isArray(data?.skipped) ? data.skipped : [],
  };
}

function getUploadConflictData(error: unknown): SkillUploadConflictResponse | null {
  if (
    !error ||
    typeof error !== "object" ||
    !("code" in error) ||
    (error as { code?: string }).code !== "SKILL_CONFLICT"
  )
    return null;
  const data = (error as { data?: SkillUploadConflictResponse }).data;
  if (!data || !Array.isArray(data.conflicts) || !Array.isArray(data.allowedStrategies)) return null;
  return data;
}

function UploadItemCard({ item }: { item: UploadSkillSummary }) {
  const { t } = useTranslation(NS.SKILLS);
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${item.hasSkillMd ? "border-border-light bg-surface-1" : "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20"}`}
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

export function AgentSkillsPage() {
  const { t } = useTranslation(NS.SKILLS);
  const { t: tComponents } = useTranslation(NS.COMPONENTS);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
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
  const editingReadOnly = editingSkill ? !canWriteSkill(editingSkill) : false;

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
    const { data, error } = await skillConfigApi.list();
    if (error) {
      console.error(t("toast.loadListFailed"), error);
      toast.error(t("toast.loadListFailedWith", { message: error.message }));
    } else {
      const d = ((data as unknown as Record<string, unknown>) ?? {}) as { skills?: SkillInfo[] };
      setSkills(Array.isArray(d?.skills) ? d.skills : []);
    }
    setLoading(false);
  }, [t]);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const [searchQuery, _setSearchQuery] = useState("");
  const filteredSkills = useMemo(() => {
    if (!searchQuery.trim()) return skills;
    const q = searchQuery.toLowerCase();
    return skills.filter(
      (s) =>
        getSkillOptionLabel(s).toLowerCase().includes(q) ||
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q),
    );
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
    const { data: detail, error } = await skillConfigApi.get(getSkillLookupKey(skill));
    if (error) {
      toast.error(t("toast.loadDetailFailed"));
    } else {
      const d = detail as unknown as SkillDetail;
      setFormName((d?.name as string) ?? "");
      setFormDescription((d?.description as string) ?? "");
      setFormContent((d?.content as string) ?? "");
    }
    setDialogOpen(true);
  };

  const handleTextSave = async () => {
    if (!formName.trim() || !formContent.trim()) {
      toast.error(t("form.nameRequired"));
      return;
    }
    setFormSaving(true);
    const { error } = await skillConfigApi.set(formName, { description: formDescription, content: formContent });
    if (error) {
      toast.error(t("toast.saveFailedWith", { message: error.message }));
    } else {
      toast.success(editingSkill ? t("toast.skillUpdated") : t("toast.skillCreated"));
      setDialogOpen(false);
      loadSkills();
      dispatchConfigChange("skills");
    }
    setFormSaving(false);
  };

  const handleToggleSharing = async (skill: SkillInfo) => {
    if (!canManageSkillSharing(skill)) return;
    const nextPublicReadable = !skill.resourceAccess?.publicReadable;
    const { data: detail, error: detailError } = await skillConfigApi.get(getSkillLookupKey(skill));
    if (detailError) {
      toast.error(t("toast.loadDetailFailed"));
      return;
    }
    const d = detail as unknown as SkillDetail;
    const { error } = await skillConfigApi.set(skill.name, {
      description: d.description ?? skill.description ?? "",
      content: d.content ?? "",
      metadata: d.metadata ?? {},
      publicReadable: nextPublicReadable,
    });
    if (error) {
      toast.error(t("toast.saveFailedWith", { message: error.message }));
      return;
    }
    toast.success(nextPublicReadable ? tComponents("resource.makePublic") : tComponents("resource.makePrivate"));
    loadSkills();
    dispatchConfigChange("skills");
  };

  const handleUploadSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const items = parseSkillUploadFiles(files);
    setUploadItems(items);
    setUploadError(validateUploadBatch(items));
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
        setConflicts(conflictData.conflicts);
        setConflictStrategy(strategy ?? null);
        toast.error(t("conflict.detected"));
      } else {
        toast.error(t("toast.importFailedWith", { message: uploadError.message }));
      }
    } else {
      const result = normalizeSkillUploadResult(uploadResult);
      toast.success(
        result.skipped.length > 0
          ? t("toast.importResultWithSkipped", { imported: result.imported.length, skipped: result.skipped.length })
          : t("toast.importResult", { imported: result.imported.length }),
      );
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
      toast.error(t("toast.deleteFailedWith", { message: error.message }));
      return;
    }
    toast.success(t("toast.skillDeleted"));
    setConfirmOpen(false);
    loadSkills();
    dispatchConfigChange("skills");
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
  const overwriteConflictNames = conflicts.map((conflict) => conflict.name).join(", ");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentPageHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => handleOpenCreate("upload")}>
              {t("btn.uploadSkill")}
            </Button>
            <Button onClick={() => handleOpenCreate("text")}>{t("btn.createSkill")}</Button>
          </div>
        }
      />
      <AgentCardList
        items={filteredSkills}
        cardKey={getSkillKey}
        searchPlaceholder={t("search")}
        searchFn={(s, q) =>
          getSkillOptionLabel(s).toLowerCase().includes(q) ||
          s.name.toLowerCase().includes(q) ||
          s.description.toLowerCase().includes(q)
        }
        emptyMessage={t("empty")}
        gridCols="grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
        renderCard={(skill) => {
          const writable = skill.resourceAccess?.writable !== false;
          const manageable = skill.resourceAccess?.manageable === true;

          return (
            <div className="group relative rounded-xl border border-border-light bg-surface-1 p-4 transition-all hover:border-border-active hover:shadow-md flex flex-col min-h-[140px]">
              {writable ? (
                <div className="absolute top-3 right-3 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="xs" variant="outline" onClick={() => handleOpenEdit(skill)}>
                    {t("btn.edit")}
                  </Button>
                  <Button size="xs" variant="destructive" onClick={() => handleDeleteClick(skill)}>
                    {t("btn.delete")}
                  </Button>
                </div>
              ) : (
                <div className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="xs" variant="outline" onClick={() => handleOpenEdit(skill)}>
                    {t("btn.view")}
                  </Button>
                </div>
              )}
              <div className="flex-1 min-w-0 pr-20">
                <div className="flex items-center gap-2">
                  <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-brand-subtle text-brand shrink-0">
                    <Sparkles className="w-3.5 h-3.5" />
                  </div>
                  <span className="font-mono text-sm font-semibold text-text-bright truncate">
                    {getSkillOptionLabel(skill)}
                  </span>
                  <span className="inline-flex shrink-0 whitespace-nowrap rounded border border-border-subtle px-1.5 py-0.5 text-[10px] font-medium leading-none text-text-muted">
                    {tComponents(getSkillResourceBadgeKey(skill))}
                  </span>
                </div>
                <p className="text-xs text-text-secondary line-clamp-3 mt-2 leading-relaxed">
                  {skill.description || "—"}
                </p>
                {manageable && (
                  <label className="mt-3 flex items-center gap-2 text-xs text-text-muted">
                    <Switch
                      checked={Boolean(skill.resourceAccess?.publicReadable)}
                      onCheckedChange={() => void handleToggleSharing(skill)}
                    />
                    {tComponents("resource.public")}
                  </label>
                )}
                {!writable && (
                  <p className="mt-3 text-xs font-medium text-text-muted">{tComponents("resource.readOnly")}</p>
                )}
              </div>
            </div>
          );
        }}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetUploadState();
        }}
        title={
          editingSkill ? (editingReadOnly ? t("dialog.detailTitle") : t("dialog.editTitle")) : t("dialog.createTitle")
        }
        onSubmit={handleDialogSubmit}
        submitLabel={editingSkill || createMode === "text" ? t("dialog.save") : t("dialog.startUpload")}
        loading={editingSkill || createMode === "text" ? formSaving : uploadPending}
        disabled={
          editingReadOnly ||
          (!editingSkill && createMode === "upload" && uploadItems.filter((i) => i.hasSkillMd).length === 0)
        }
        hideSubmit={editingReadOnly}
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
                  <p className="text-sm font-medium text-text-primary">{t("upload.selectFolder")}</p>
                  <p className="mt-1 text-xs text-text-muted">{t("upload.selectFolderHint")}</p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      {t("upload.selectedDirs", { count: uploadItems.length })}
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
                    {conflicts.map((c) => (
                      <div key={c.name} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-text-primary">{c.name}</span>
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
            {editingReadOnly && (
              <p className="rounded-lg border border-border-subtle bg-surface-2 px-3 py-2 text-sm text-text-muted">
                {tComponents("resource.readOnly")}
              </p>
            )}
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
                disabled={editingReadOnly}
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
                disabled={editingReadOnly}
                className="min-h-[300px] font-mono text-sm"
                placeholder={t("form.contentPlaceholder")}
              />
            </div>
          </div>
        )}
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={t("confirm.deleteTitle")}
        description={t("confirm.deleteDescription", { name: deleteTarget ?? "" })}
        variant="destructive"
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={overwriteConfirmOpen}
        onOpenChange={setOverwriteConfirmOpen}
        title={t("confirm.overwriteTitle")}
        description={t("confirm.overwriteDescription", { names: overwriteConflictNames })}
        variant="destructive"
        confirmLabel={t("confirm.overwriteConfirm")}
        onConfirm={() => void handleUploadSubmit("overwrite")}
        loading={uploadPending}
      />
    </div>
  );
}
