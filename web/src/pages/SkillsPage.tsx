import { useState, useCallback, useEffect, useRef, type ChangeEvent } from "react";
import { toast } from "sonner";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  apiListSkills,
  apiGetSkill,
  apiSetSkill,
  apiDeleteSkill,
  apiEnableSkill,
  apiDisableSkill,
  apiUploadSkills,
} from "../api/client";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../lib/skill-upload";
import type {
  SkillInfo,
  SkillUploadConflictResponse,
  SkillUploadConflictStrategy,
  UploadSkillSummary,
} from "../types/config";
import { dispatchConfigChange } from "../lib/config-events";

type CreateMode = "text" | "upload";

export function validateSkillForm(name: string, content: string): string | null {
  if (!name.trim()) return "名称不能为空";
  if (!content.trim()) return "内容不能为空";
  return null;
}

export function getUploadResultMessage(imported: number, skipped: number): string {
  if (skipped > 0) {
    return `已导入 ${imported} 个技能，跳过 ${skipped} 个冲突技能`;
  }
  return `已导入 ${imported} 个技能`;
}

export function getUploadConflictData(error: unknown): SkillUploadConflictResponse | null {
  if (!error || typeof error !== "object" || !("code" in error) || (error as { code?: string }).code !== "SKILL_CONFLICT") {
    return null;
  }
  const data = (error as { data?: SkillUploadConflictResponse }).data;
  if (!data || !Array.isArray(data.conflicts) || !Array.isArray(data.allowedStrategies)) {
    return null;
  }
  return data;
}

export function getUploadItemSummaries(items: UploadSkillSummary[]): string[] {
  return items.map((item) =>
    item.hasSkillMd
      ? `${item.skillName} (${item.fileCount} 个文件)`
      : `${item.skillName} (${item.fileCount} 个文件，缺少 SKILL.md)`,
  );
}

export function getInvalidUploadSkillNames(items: UploadSkillSummary[]): string[] {
  return items.filter((item) => !item.hasSkillMd).map((item) => item.skillName);
}

function UploadItemCard({ item }: { item: UploadSkillSummary }) {
  return (
    <div className={`flex items-center gap-3 rounded-lg border px-3 py-2 transition-colors ${
      item.hasSkillMd
        ? "border-border-light bg-surface-1 hover:border-border"
        : "border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-900/20"
    }`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-medium text-text-bright truncate">{item.skillName}</span>
          <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface-2 text-text-muted">
            {item.fileCount} 文件
          </span>
        </div>
      </div>
      {!item.hasSkillMd && (
        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium whitespace-nowrap">缺少 SKILL.md</span>
      )}
      {item.hasSkillMd && (
        <span className="text-xs text-status-active font-medium">可导入</span>
      )}
    </div>
  );
}

const directoryInputProps = { webkitdirectory: "", directory: "" } as Record<string, string>;

export function SkillsPage() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode>("text");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillInfo[]>([]);
  const [batchAction, setBatchAction] = useState<"enable" | "disable" | "delete" | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formSaving, setFormSaving] = useState(false);
  const [uploadItems, setUploadItems] = useState<UploadSkillSummary[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<SkillUploadConflictResponse["conflicts"]>([]);
  const [conflictStrategy, setConflictStrategy] = useState<SkillUploadConflictStrategy | null>(null);
  const [uploadPending, setUploadPending] = useState(false);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiListSkills();
      setSkills(data);
    } catch (e) {
      toast.error("加载技能列表失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const resetUploadState = useCallback(() => {
    setUploadItems([]);
    setUploadError(null);
    setConflicts([]);
    setConflictStrategy(null);
    setUploadPending(false);
    setOverwriteConfirmOpen(false);
  }, []);

  const columns: Column<SkillInfo>[] = [
    { key: "name", header: "名称", sortable: true, filterable: true, render: (row) => (
      <span className="font-mono text-sm text-text-bright">{row.name}</span>
    )},
    {
      key: "description",
      header: "描述",
      render: (row) => (
        <span className="block max-w-[280px] truncate text-text-secondary text-sm" title={row.description}>
          {row.description || <span className="text-text-muted">无描述</span>}
        </span>
      ),
    },
    {
      key: "enabled",
      header: "状态",
      filterable: true,
      render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
    },
  ];

  const handleOpenCreate = () => {
    setEditingSkill(null);
    setCreateMode("upload");
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
      const detail = await apiGetSkill(skill.name);
      setFormName(detail.name);
      setFormDescription(detail.description);
      setFormContent(detail.content);
      setDialogOpen(true);
    } catch {
      toast.error("加载技能详情失败");
    }
  };

  const handleTextSave = async () => {
    const err = validateSkillForm(formName, formContent);
    if (err) {
      toast.error(err);
      return;
    }

    setFormSaving(true);
    try {
      await apiSetSkill(formName, {
        description: formDescription,
        content: formContent,
      });
      toast.success(editingSkill ? "技能已更新" : "技能已创建");
      setDialogOpen(false);
      await loadSkills();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setFormSaving(false);
    }
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
    try {
      const result = await apiUploadSkills(buildSkillUploadFormData(uploadItems, strategy));
      toast.success(getUploadResultMessage(result.imported.length, result.skipped.length));
      setDialogOpen(false);
      resetUploadState();
      await loadSkills();
      dispatchConfigChange("skills");
    } catch (error) {
      const conflictData = getUploadConflictData(error);
      if (conflictData) {
        setConflicts(conflictData.conflicts);
        setConflictStrategy(strategy ?? null);
        toast.error("检测到同名技能，请选择忽略或覆盖策略");
      } else {
        toast.error("导入失败: " + (error instanceof Error ? error.message : "未知错误"));
      }
    } finally {
      setUploadPending(false);
      setOverwriteConfirmOpen(false);
    }
  };

  const handleDialogSubmit = async () => {
    if (editingSkill || createMode === "text") {
      await handleTextSave();
      return;
    }
    await handleUploadSubmit();
  };

  const handleToggle = async (skill: SkillInfo) => {
    try {
      if (skill.enabled) {
        await apiDisableSkill(skill.name);
        toast.success(`已禁用 "${skill.name}"`);
      } else {
        await apiEnableSkill(skill.name);
        toast.success(`已启用 "${skill.name}"`);
      }
      await loadSkills();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteSkill(deleteTarget);
      toast.success("技能已删除");
      setConfirmOpen(false);
      await loadSkills();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleBatchAction = (action: "enable" | "disable" | "delete") => {
    setBatchAction(action);
    setBatchConfirmOpen(true);
  };

  const confirmBatchAction = async () => {
    try {
      if (batchAction === "delete") {
        await Promise.all(selected.map((s) => apiDeleteSkill(s.name)));
        toast.success(`已删除 ${selected.length} 个技能`);
      } else if (batchAction === "enable") {
        await Promise.all(selected.filter((s) => !s.enabled).map((s) => apiEnableSkill(s.name)));
        toast.success(`已启用 ${selected.length} 个技能`);
      } else {
        await Promise.all(selected.filter((s) => s.enabled).map((s) => apiDisableSkill(s.name)));
        toast.success(`已禁用 ${selected.length} 个技能`);
      }
      setBatchConfirmOpen(false);
      setSelected([]);
      await loadSkills();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("批量操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-32" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full rounded-none border-t" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold text-text-bright">技能管理</h2>
          <p className="text-sm text-text-muted mt-0.5">管理 AI Agent 可用的技能模板</p>
        </div>
        <Button onClick={handleOpenCreate}>新建技能</Button>
      </div>
      <DataTable<SkillInfo>
        columns={columns}
        data={skills}
        searchable
        searchPlaceholder="搜索技能..."
        selectable
        onSelectionChange={setSelected}
        actions={(row) => (
          <div className="flex gap-1.5">
            <Button size="xs" variant="outline" onClick={() => handleToggle(row)}>
              {row.enabled ? "禁用" : "启用"}
            </Button>
            <Button size="xs" variant="outline" onClick={() => handleOpenEdit(row)}>
              编辑
            </Button>
            <Button size="xs" variant="destructive" onClick={() => { setDeleteTarget(row.name); setConfirmOpen(true); }}>
              删除
            </Button>
          </div>
        )}
      />
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[
            { label: "批量启用", onClick: () => handleBatchAction("enable") },
            { label: "批量禁用", onClick: () => handleBatchAction("disable") },
            { label: "批量删除", variant: "destructive", onClick: () => handleBatchAction("delete") },
          ]}
        />
      )}
      <FormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) resetUploadState();
        }}
        title={editingSkill ? "编辑技能" : "新建技能"}
        onSubmit={handleDialogSubmit}
        submitLabel={editingSkill || createMode === "text" ? "保存" : "开始上传"}
        loading={editingSkill || createMode === "text" ? formSaving : uploadPending}
        width="sm:max-w-4xl"
      >
        {!editingSkill ? (
          <Tabs value={createMode} onValueChange={(value) => setCreateMode(value as CreateMode)} className="min-h-0">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="upload">上传技能</TabsTrigger>
              <TabsTrigger value="text">创建技能</TabsTrigger>
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
                    <svg className="h-6 w-6 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5" />
                    </svg>
                  </div>
                  <p className="text-sm font-medium text-text-primary">点击选择包含技能的文件夹</p>
                  <p className="mt-1 text-xs text-text-muted">
                    每个子目录将被识别为一个 skill，目录内需包含 SKILL.md
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-text-primary">
                      已选择 {uploadItems.length} 个目录
                    </span>
                    <Button type="button" variant="ghost" size="xs" onClick={() => { setUploadItems([]); setUploadError(null); }}>
                      重新选择
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
                  <div className="font-medium text-warning-text">检测到同名技能冲突</div>
                  <div className="space-y-1">
                    {conflicts.map((conflict) => (
                      <div key={conflict.name} className="flex items-center gap-2">
                        <span className="font-mono text-xs text-text-primary">{conflict.name}</span>
                        <StatusBadge status={conflict.enabled ? "enabled" : "disabled"} />
                      </div>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button type="button" variant="outline" size="sm" onClick={() => handleUploadSubmit("ignore")} disabled={uploadPending}>
                      跳过冲突项
                    </Button>
                    <Button type="button" variant="destructive" size="sm" onClick={() => setOverwriteConfirmOpen(true)} disabled={uploadPending}>
                      覆盖已有技能
                    </Button>
                  </div>
                </div>
              )}
            </TabsContent>
            <TabsContent value="text" className="space-y-4">
              <div>
                <label className="text-sm font-medium text-text-primary">技能名称</label>
                <Input value={formName} onChange={(e) => setFormName(e.target.value)} placeholder="my-skill" className="mt-1 font-mono text-sm" />
              </div>
              <div>
                <label className="text-sm font-medium text-text-primary">描述</label>
                <Textarea
                  value={formDescription}
                  onChange={(e) => setFormDescription(e.target.value)}
                  className="mt-1 min-h-[80px] text-sm"
                  placeholder="可选，简要描述技能用途"
                />
              </div>
              <div>
                <label className="text-sm font-medium text-text-primary">内容</label>
                <p className="text-xs text-text-muted mb-1.5">Markdown 格式的技能指令</p>
                <Textarea
                  value={formContent}
                  onChange={(e) => setFormContent(e.target.value)}
                  className="min-h-[300px] font-mono text-sm"
                  placeholder="输入 Markdown 内容..."
                />
              </div>
            </TabsContent>
          </Tabs>
        ) : (
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-text-primary">技能名称</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)} disabled className="mt-1 font-mono text-sm text-text-muted" />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">描述</label>
              <Textarea
                value={formDescription}
                onChange={(e) => setFormDescription(e.target.value)}
                className="mt-1 min-h-[80px] text-sm"
                placeholder="可选，简要描述技能用途"
              />
            </div>
            <div>
              <label className="text-sm font-medium text-text-primary">内容</label>
              <p className="text-xs text-text-muted mb-1.5">Markdown 格式的技能指令</p>
              <Textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                className="min-h-[300px] font-mono text-sm"
                placeholder="输入 Markdown 内容..."
              />
            </div>
          </div>
        )}
      </FormDialog>
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="确认删除"
        description={`此操作不可逆。确定要删除技能 "${deleteTarget}" 吗？`}
        variant="destructive"
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title={`批量${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}确认`}
        description={`确定要${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}选中的 ${selected.length} 个技能吗？${batchAction === "delete" ? "此操作不可逆。" : ""}`}
        variant={batchAction === "delete" ? "destructive" : "default"}
        onConfirm={confirmBatchAction}
      />
      <ConfirmDialog
        open={overwriteConfirmOpen}
        onOpenChange={setOverwriteConfirmOpen}
        title="确认覆盖冲突技能"
        description="覆盖会整目录替换已有技能内容，旧文件会被删除。确定继续吗？"
        variant="destructive"
        confirmLabel="确认覆盖"
        onConfirm={() => void handleUploadSubmit("overwrite")}
        loading={uploadPending}
      />
    </div>
  );
}
