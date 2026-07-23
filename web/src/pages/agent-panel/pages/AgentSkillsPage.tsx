import { useRequest } from "ahooks";
import { ChevronDown, FileText, Plus, Search, Share2, Sparkles, Upload } from "lucide-react";
import { type ChangeEvent, useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { MetaAgentPanel } from "@/components/MetaAgentPanel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

import { Textarea } from "@/components/ui/textarea";
import { unwrap } from "@/src/api/request";
import { skillConfigApi } from "@/src/api/skills";
import { useMetaAgent } from "@/src/hooks/useMetaAgent";
import { NS } from "../../../i18n";
import { dispatchConfigChange } from "../../../lib/config-events";
import {
  canManageSkillSharing,
  canWriteSkill,
  getSkillKey,
  getSkillLookupKey,
  getSkillOptionLabel,
} from "../../../lib/skill-resource-access";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../../../lib/skill-upload";
import type {
  ResourceAccess,
  SkillUploadConflictResponse,
  SkillUploadConflictStrategy,
  UploadSkillSummary,
} from "../../../types/config";
import { AgentPageHeader } from "../shared/AgentPageHeader";
import { getSkillFormValidationError } from "./agent-skills-utils";

type SkillInfo = { id?: string; name: string; description?: string; resourceAccess?: ResourceAccess };
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
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode>("text");
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadItems, setUploadItems] = useState<UploadSkillSummary[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SkillUploadConflictResponse["conflicts"]>([]);
  const [_conflictStrategy, setConflictStrategy] = useState<SkillUploadConflictStrategy | null>(null);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const [downloadingSkillKey, setDownloadingSkillKey] = useState<string | null>(null);
  const editingReadOnly = editingSkill ? !canWriteSkill(editingSkill) : false;

  const resetUploadState = useCallback(() => {
    setUploadItems([]);
    setUploadError(null);
    setConflicts([]);
    setConflictStrategy(null);
    setOverwriteConfirmOpen(false);
  }, []);

  // skill 列表查询
  const {
    data: listData,
    loading,
    refresh,
    refreshAsync,
  } = useRequest(() => unwrap(skillConfigApi.list()), {
    onError: (err) => {
      console.error(t("toast.loadListFailed"), err);
      toast.error(t("toast.loadListFailedWith", { message: err.message }));
    },
  });
  const skills = listData?.skills ?? [];

  // 创建 skill（成功 toast）
  const { run: runCreate, loading: creating } = useRequest(
    (params: { name: string; description: string; content: string }) =>
      unwrap(skillConfigApi.create(params.name, { description: params.description, content: params.content })),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("toast.skillCreated"));
        setDialogOpen(false);
        refresh();
        dispatchConfigChange("skills");
      },
      onError: (err) => toast.error(t("toast.saveFailedWith", { message: err.message })),
    },
  );

  // 更新 skill（静默，不弹 toast）
  const { run: runUpdate, loading: updating } = useRequest(
    (params: { name: string; description: string; content: string }) =>
      unwrap(skillConfigApi.update(params.name, { description: params.description, content: params.content })),
    {
      manual: true,
      onSuccess: () => {
        setDialogOpen(false);
        refresh();
        dispatchConfigChange("skills");
      },
      onError: (err) => toast.error(t("toast.saveFailedWith", { message: err.message })),
    },
  );

  // 上传 skill（FormData，直接处理 ApiResponse 以支持冲突检测）
  const { run: runUpload, loading: uploading } = useRequest((formData: FormData) => skillConfigApi.upload(formData), {
    manual: true,
    onSuccess: (response) => {
      if (response.success) {
        const result = normalizeSkillUploadResult(response.data);
        toast.success(
          result.skipped.length > 0
            ? t("toast.importResultWithSkipped", { imported: result.imported.length, skipped: result.skipped.length })
            : t("toast.importResult", { imported: result.imported.length }),
        );
        setDialogOpen(false);
        resetUploadState();
        refresh();
        dispatchConfigChange("skills");
        setOverwriteConfirmOpen(false);
      } else {
        const conflictData = getUploadConflictData(response.error);
        if (conflictData) {
          setConflicts(conflictData.conflicts);
          setConflictStrategy(null);
          toast.error(t("conflict.detected"));
        } else {
          toast.error(t("toast.importFailedWith", { message: response.error?.message ?? "" }));
        }
      }
    },
  });

  // 删除 skill（静默，不弹 toast）
  const { run: runDelete } = useRequest((name: string) => unwrap(skillConfigApi.del(name)), {
    manual: true,
    onSuccess: () => {
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
      dispatchConfigChange("skills");
    },
    onError: (err) => {
      console.error(t("toast.deleteFailed"), err);
      toast.error(t("toast.deleteFailedWith", { message: err.message }));
    },
  });

  const [searchQuery, setSearchQuery] = useState("");

  // 搜索过滤辅助函数
  const searchFn = useCallback(
    (s: SkillInfo, q: string) =>
      getSkillOptionLabel(s).toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q) ||
      (s.description ?? "").toLowerCase().includes(q),
    [],
  );

  // 按 ownership 分组，同时应用搜索过滤
  const { privateSkills, sharedSkills } = useMemo(() => {
    const priv = skills.filter((s) => s.resourceAccess?.ownership !== "external");
    const shared = skills.filter((s) => s.resourceAccess?.ownership === "external");
    if (!searchQuery.trim()) return { privateSkills: priv, sharedSkills: shared };
    const q = searchQuery.toLowerCase();
    return {
      privateSkills: priv.filter((s) => searchFn(s, q)),
      sharedSkills: shared.filter((s) => searchFn(s, q)),
    };
  }, [skills, searchQuery, searchFn]);

  const { metaAgentId, chatOpen, setChatOpen } = useMetaAgent({ storageKey: "skills:chat-open" });

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
    try {
      const detail = await unwrap(skillConfigApi.get(getSkillLookupKey(skill)));
      setFormName(detail.name ?? "");
      setFormDescription(detail.description ?? "");
      setFormContent(detail.content ?? "");
    } catch {
      toast.error(t("toast.loadDetailFailed"));
    }
    setDialogOpen(true);
  };

  const handleToggleSharing = async (skill: SkillInfo) => {
    if (!canManageSkillSharing(skill)) return;
    const nextPublicReadable = !skill.resourceAccess?.publicReadable;
    try {
      const detail = await unwrap(skillConfigApi.get(getSkillLookupKey(skill)));
      await unwrap(
        skillConfigApi.update(skill.name, {
          description: detail.description ?? skill.description ?? "",
          content: detail.content ?? "",
          metadata: detail.metadata ?? {},
          publicReadable: nextPublicReadable,
        }),
      );
      toast.success(nextPublicReadable ? tComponents("resource.makePublic") : tComponents("resource.makePrivate"));
      refresh();
      dispatchConfigChange("skills");
    } catch (err) {
      toast.error(t("toast.saveFailedWith", { message: (err as Error).message }));
    }
  };

  const handleUploadSelection = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    const items = parseSkillUploadFiles(files);
    setUploadItems(items);
    setUploadError(validateUploadBatch(items));
    setConflicts([]);
    setConflictStrategy(null);
  };

  // 上传（可带冲突策略）
  const doUpload = (strategy?: SkillUploadConflictStrategy) => {
    const validationError = validateUploadBatch(uploadItems);
    if (validationError) {
      setUploadError(validationError);
      toast.error(validationError);
      return;
    }
    const formData = buildSkillUploadFormData(uploadItems, strategy);
    runUpload(formData);
  };

  // dialog 提交分发：根据模式调用 create / update / upload
  const handleDialogSubmit = () => {
    if (editingSkill) {
      const validationError = getSkillFormValidationError(formName, formContent);
      if (validationError) {
        toast.error(t(validationError));
        return;
      }
      runUpdate({ name: editingSkill.name, description: formDescription, content: formContent });
      return;
    }
    if (createMode === "text") {
      const validationError = getSkillFormValidationError(formName, formContent);
      if (validationError) {
        toast.error(t(validationError));
        return;
      }
      runCreate({ name: formName, description: formDescription, content: formContent });
      return;
    }
    // upload 模式
    doUpload();
  };

  const handleDeleteClick = (skill: SkillInfo) => {
    setDeleteTarget(skill.name);
    setConfirmOpen(true);
  };

  const handleDownload = useCallback(
    async (skill: SkillInfo) => {
      const skillKey = getSkillKey(skill);
      setDownloadingSkillKey(skillKey);
      try {
        const response = await fetch(`/web/config/skills/${encodeURIComponent(getSkillLookupKey(skill))}/download`, {
          credentials: "include",
        });
        if (!response.ok) {
          throw new Error(`Download failed: ${response.status}`);
        }

        const blob = await response.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = blobUrl;
        link.download = `${skill.name}.zip`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
      } catch (error) {
        console.error(t("toast.downloadFailed"), error);
        toast.error(t("toast.downloadFailed"));
      } finally {
        setDownloadingSkillKey(null);
      }
    },
    [t],
  );

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 bg-[#f4f7fb]">
        <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
          <div className="mb-3 flex items-start justify-between gap-4">
            <div>
              <Skeleton className="h-[22px] w-28 rounded-md" />
              <Skeleton className="mt-1.5 h-3 w-56 rounded-md" />
            </div>
            <div className="flex items-center gap-2">
              <Skeleton className="h-10 w-28 rounded-lg" />
              <Skeleton className="h-10 w-32 rounded-lg" />
            </div>
          </div>
          <div className="mb-3.5 h-px bg-[#e8edf4]" />
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              <Skeleton key={i} className="h-36 w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }
  const overwriteConflictNames = conflicts.map((conflict) => conflict.name).join(", ");

  // 卡片渲染函数（两个区域复用）
  // 私有区域直接展示技能名（不带组织前缀），共享区域保留组织前缀
  const renderSkillCard = (skill: SkillInfo, showOrgPrefix: boolean) => {
    const writable = skill.resourceAccess?.writable !== false;
    const manageable = skill.resourceAccess?.manageable === true;
    const skillKey = getSkillKey(skill);
    const downloading = downloadingSkillKey === skillKey;

    return (
      <div className="group relative flex min-h-[138px] flex-col rounded-xl border border-[#e5ebf3] bg-white p-4 shadow-[0_6px_18px_rgba(38,65,103,0.04)] transition-all hover:-translate-y-0.5 hover:border-[#cddceb] hover:shadow-[0_14px_30px_rgba(38,65,103,0.08)]">
        {writable ? (
          <div className="absolute right-3 bottom-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[#69788f]"
              disabled={downloading}
              onClick={() => void handleDownload(skill)}
            >
              {t("btn.download")}
            </Button>
            <Button size="xs" variant="ghost" className="h-6 px-2 text-[#69788f]" onClick={() => handleOpenEdit(skill)}>
              {t("btn.edit")}
            </Button>
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[#e5484d] hover:bg-[#fff0f0]"
              onClick={() => handleDeleteClick(skill)}
            >
              {t("btn.delete")}
            </Button>
          </div>
        ) : (
          <div className="absolute right-3 bottom-3 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button
              size="xs"
              variant="ghost"
              className="h-6 px-2 text-[#69788f]"
              disabled={downloading}
              onClick={() => void handleDownload(skill)}
            >
              {t("btn.download")}
            </Button>
            <Button size="xs" variant="ghost" className="h-6 px-2 text-[#69788f]" onClick={() => handleOpenEdit(skill)}>
              {t("btn.view")}
            </Button>
          </div>
        )}
        {/* 内容区域：图标+名称+描述，可弹性伸缩 */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            {showOrgPrefix ? (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#eef5ff] text-[#477bff]">
                <Share2 className="h-3.5 w-3.5" />
              </div>
            ) : (
              <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#f0f5ff] text-[#6b6ff7]">
                <Sparkles className="h-3.5 w-3.5" />
              </div>
            )}
            <span className="min-w-0 flex-1 truncate font-mono text-[13px] font-semibold text-[#1a2944]">
              {showOrgPrefix ? getSkillOptionLabel(skill) : skill.name}
            </span>
            <span className="min-w-[34px] shrink-0 whitespace-nowrap rounded-full bg-[#eef3f8] px-1.5 py-1 text-center text-[10px] font-medium leading-none text-[#8a98ab] [word-break:keep-all] [writing-mode:horizontal-tb]">
              {showOrgPrefix ? tComponents("resource.external") : tComponents("resource.internal")}
            </span>
          </div>
          <p className="mt-3 line-clamp-3 text-[12px] leading-5 text-[#718198]">{skill.description || "—"}</p>
        </div>
        {/* 底部固定区域：公开开关 / 只读标签，始终贴底 */}
        <div className="mt-auto pr-24 pt-3">
          {manageable && (
            <span className="inline-flex items-center gap-2 text-[12px] text-[#8a98ab]">
              <Switch
                aria-label={tComponents("resource.public")}
                checked={Boolean(skill.resourceAccess?.publicReadable)}
                onCheckedChange={() => void handleToggleSharing(skill)}
              />
              {tComponents("resource.public")}
            </span>
          )}
          {!writable && <p className="text-[12px] font-medium text-[#8a98ab]">{tComponents("resource.readOnly")}</p>}
        </div>
      </div>
    );
  };

  // 区域标题组件
  const sectionTitle = (label: string, count: number) => (
    <div className="mb-3 flex items-center gap-2 border-b border-[#d6dde8] pb-2 text-[13px] font-medium text-[#6b788e]">
      <span>{label}</span>
      <span className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-[#e9eff7] px-2 py-0.5 text-center text-[11px] text-[#7b899d]">
        {count}
      </span>
    </div>
  );

  return (
    <div className="flex min-h-0 flex-1 bg-[#f4f7fb]">
      <div className="min-h-0 flex-1 overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <AgentPageHeader
          title={t("title")}
          subtitle={t("subtitle")}
          actions={
            <>
              <Button
                variant="outline"
                className="h-10 shrink-0 gap-2 rounded-lg px-4 text-[13px] font-semibold"
                onClick={() => handleOpenCreate("upload")}
              >
                <Upload className="h-4 w-4" />
                {t("btn.uploadSkill")}
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button className="h-10 shrink-0 gap-1.5 rounded-lg px-4 text-[13px] font-semibold">
                    <Plus className="h-4 w-4" />
                    {t("btn.createSkill")}
                    <ChevronDown className="h-3.5 w-3.5 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-40">
                  <DropdownMenuItem onClick={() => handleOpenCreate("text")}>
                    <FileText className="mr-2 h-4 w-4" />
                    {t("btn.manualCreate")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setChatOpen(true)}>
                    <Sparkles className="mr-2 h-4 w-4" />
                    {t("btn.conversationCreate")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          }
        />

        {/* 搜索框 */}
        <div className="mb-7 flex items-center gap-2">
          <div className="relative w-full max-w-md">
            <Search className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-[#98a8bd]" />
            <input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t("search")}
              className="h-10 w-full rounded-lg border border-[#dce5ef] bg-white pl-10 pr-4 text-[13px] text-[#1a2944] outline-none transition placeholder:text-[#99a8bc] focus:border-[#1677ff] focus:ring-4 focus:ring-[#1677ff]/10"
            />
          </div>
        </div>

        {/* 两区域滚动容器 */}
        <div>
          {/* 私有技能 */}
          <section>
            {sectionTitle(t("section.private"), privateSkills.length)}
            {privateSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#d8e2ef] bg-white/70 py-8 text-[#8a98ab]">
                <p className="text-sm">{t("section.privateEmpty")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {privateSkills.map((skill) => (
                  <div key={getSkillKey(skill)}>{renderSkillCard(skill, false)}</div>
                ))}
              </div>
            )}
          </section>

          {/* 共享技能 */}
          <section className="pt-6 pb-4">
            {sectionTitle(t("section.shared"), sharedSkills.length)}
            {sharedSkills.length === 0 ? (
              <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-[#d8e2ef] bg-white/70 py-8 text-[#8a98ab]">
                <p className="text-sm">{t("section.sharedEmpty")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {sharedSkills.map((skill) => (
                  <div key={getSkillKey(skill)}>{renderSkillCard(skill, true)}</div>
                ))}
              </div>
            )}
          </section>
        </div>

        <FormDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) resetUploadState();
          }}
          title={
            editingSkill
              ? editingReadOnly
                ? t("dialog.detailTitle")
                : t("dialog.editTitle")
              : createMode === "upload"
                ? t("dialog.uploadTitle")
                : t("dialog.createTitle")
          }
          onSubmit={handleDialogSubmit}
          submitLabel={editingSkill || createMode === "text" ? t("dialog.save") : t("dialog.startUpload")}
          loading={editingSkill ? updating : createMode === "text" ? creating : uploading}
          disabled={
            editingReadOnly ||
            (!editingSkill && createMode === "upload" && uploadItems.filter((i) => i.hasSkillMd).length === 0)
          }
          hideSubmit={editingReadOnly}
          width="sm:max-w-4xl"
        >
          {!editingSkill ? (
            createMode === "upload" ? (
              <div className="space-y-4">
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
                        onClick={() => doUpload("ignore")}
                        disabled={uploading}
                      >
                        {t("conflict.skipConflicts")}
                      </Button>
                      <Button
                        type="button"
                        variant="destructive"
                        size="sm"
                        onClick={() => setOverwriteConfirmOpen(true)}
                        disabled={uploading}
                      >
                        {t("conflict.overwriteExisting")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="space-y-4">
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
              </div>
            )
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
          onConfirm={() => deleteTarget && runDelete(deleteTarget)}
        />
        <ConfirmDialog
          open={overwriteConfirmOpen}
          onOpenChange={setOverwriteConfirmOpen}
          title={t("confirm.overwriteTitle")}
          description={t("confirm.overwriteDescription", { names: overwriteConflictNames })}
          variant="destructive"
          confirmLabel={t("confirm.overwriteConfirm")}
          onConfirm={() => doUpload("overwrite")}
          loading={uploading}
        />
      </div>
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={(open) => setChatOpen(open)}
        metaAgentId={metaAgentId}
        scenePrompt={undefined}
        onPromptComplete={refreshAsync}
        togglePosition="left"
      />
    </div>
  );
}
