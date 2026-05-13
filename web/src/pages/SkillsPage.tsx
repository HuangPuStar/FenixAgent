import { useState, useCallback, useEffect, useRef, useMemo, type ChangeEvent } from "react";
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
  apiListSkillSources,
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
  SkillSourceInfo,
  SkillSourceStatus,
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

const statusConfig: Record<SkillSourceStatus, { badge: "configured" | "disabled" | "unconfigured"; label: string }> = {
  online: { badge: "configured", label: "在线" },
  offline: { badge: "disabled", label: "离线" },
  timeout: { badge: "unconfigured", label: "扫描超时" },
};

function SourceStatusBadge({ status }: { status: SkillSourceStatus }) {
  const cfg = statusConfig[status];
  return <StatusBadge status={cfg.badge} label={cfg.label} />;
}

// --- SkillSubrow: 展开后显示的 skill 列表 ---

function SkillSubrow({
  source,
  onRefresh,
}: {
  source: SkillSourceInfo;
  onRefresh: () => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [createMode, setCreateMode] = useState<CreateMode>("text");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; path: string } | null>(null);
  const [workspaceEditConfirmOpen, setWorkspaceEditConfirmOpen] = useState(false);
  const [pendingEditSkill, setPendingEditSkill] = useState<SkillInfo | null>(null);
  const [selected, setSelected] = useState<SkillInfo[]>([]);
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

  const isWorkspace = source.type === "workspace";
  const sourceArg = isWorkspace ? "workspace" : undefined;
  const workspaceIdArg = source.id;

  const resetUploadState = useCallback(() => {
    setUploadItems([]);
    setUploadError(null);
    setConflicts([]);
    setConflictStrategy(null);
    setUploadPending(false);
    setOverwriteConfirmOpen(false);
  }, []);

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
    if (isWorkspace) {
      setPendingEditSkill(skill);
      setWorkspaceEditConfirmOpen(true);
      return;
    }
    setEditingSkill(skill);
    setCreateMode("text");
    resetUploadState();
    try {
      const detail = await apiGetSkill(skill.name, sourceArg, workspaceIdArg);
      setFormName(detail.name);
      setFormDescription(detail.description);
      setFormContent(detail.content);
      setDialogOpen(true);
    } catch {
      toast.error("加载技能详情失败");
    }
  };

  const confirmWorkspaceEdit = async () => {
    if (!pendingEditSkill) return;
    setWorkspaceEditConfirmOpen(false);
    setEditingSkill(pendingEditSkill);
    setPendingEditSkill(null);
    setCreateMode("text");
    resetUploadState();
    try {
      const detail = await apiGetSkill(pendingEditSkill.name, sourceArg, workspaceIdArg);
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
      await apiSetSkill(formName, { description: formDescription, content: formContent }, sourceArg, workspaceIdArg);
      toast.success(editingSkill ? "技能已更新" : "技能已创建");
      setDialogOpen(false);
      onRefresh();
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
      const result = await apiUploadSkills(buildSkillUploadFormData(uploadItems, strategy), sourceArg, workspaceIdArg);
      toast.success(getUploadResultMessage(result.imported.length, result.skipped.length));
      setDialogOpen(false);
      resetUploadState();
      onRefresh();
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
      onRefresh();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const handleDeleteClick = (skill: SkillInfo) => {
    if (isWorkspace) {
      setDeleteTarget({ name: skill.name, path: `${source.path}/.agents/skills/${skill.name}` });
    } else {
      setDeleteTarget({ name: skill.name, path: skill.name });
    }
    setConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await apiDeleteSkill(deleteTarget.name, sourceArg, workspaceIdArg);
      toast.success("技能已删除");
      setConfirmOpen(false);
      onRefresh();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  const confirmBatchDelete = async () => {
    try {
      await Promise.all(selected.map((s) => apiDeleteSkill(s.name, sourceArg, workspaceIdArg)));
      toast.success(`已删除 ${selected.length} 个技能`);
      setBatchConfirmOpen(false);
      setSelected([]);
      onRefresh();
      dispatchConfigChange("skills");
    } catch (e) {
      toast.error("批量删除失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  return (
    <>
      <div className="space-y-2">
        {source.skills.length === 0 ? (
          <div className="py-6 text-center text-sm text-text-muted">暂无技能</div>
        ) : (
          <div className="grid gap-2">
            {source.skills.map((skill) => (
              <div key={skill.name} className="group flex items-center gap-3 rounded-lg border border-border-light bg-surface-1 px-3 py-2.5 transition-colors hover:border-border-active hover:shadow-sm">
                <input
                  type="checkbox"
                  checked={selected.some((s) => s.name === skill.name)}
                  onChange={(e) => {
                    if (e.target.checked) setSelected([...selected, skill]);
                    else setSelected(selected.filter((s) => s.name !== skill.name));
                  }}
                  className="h-4 w-4 rounded border-border-light text-brand focus:ring-brand/30"
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-medium text-text-bright truncate">{skill.name}</span>
                    {isWorkspace && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface-2 text-text-muted">
                        ({source.name})
                      </span>
                    )}
                  </div>
                  {skill.description && (
                    <p className="mt-0.5 text-xs text-text-secondary line-clamp-1">{skill.description}</p>
                  )}
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  {!isWorkspace && (
                    <Button size="xs" variant="outline" onClick={() => handleToggle(skill)}>
                      {skill.enabled ? "禁用" : "启用"}
                    </Button>
                  )}
                  <Button size="xs" variant="outline" onClick={() => handleOpenEdit(skill)}>编辑</Button>
                  <Button size="xs" variant="destructive" onClick={() => handleDeleteClick(skill)}>删除</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {selected.length > 0 && (
        <BatchActionBar
          selectedCount={selected.length}
          onClear={() => setSelected([])}
          actions={[
            { label: "批量删除", variant: "destructive", onClick: () => setBatchConfirmOpen(true) },
          ]}
        />
      )}
      <div className="flex gap-2 pt-2">
        <Button size="sm" variant="outline" className="w-full border-dashed" onClick={() => handleOpenCreate("text")}>
          + 新建技能
        </Button>
        <Button size="sm" variant="outline" className="w-full border-dashed" onClick={() => handleOpenCreate("upload")}>
          上传技能
        </Button>
      </div>

      {/* FormDialog */}
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
        disabled={!editingSkill && createMode === "upload" && uploadItems.filter((i) => i.hasSkillMd).length === 0}
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
                    <Button type="button" variant="ghost" size="xs" onClick={() => {
                      setUploadItems([]);
                      setUploadError(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                      fileInputRef.current?.click();
                    }}>
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

      {/* Delete confirm */}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="确认删除"
        description={isWorkspace && deleteTarget
          ? `此操作将永久删除项目文件：\n${deleteTarget.path}\n\n此操作不可撤销。确定要继续吗？`
          : `此操作不可逆。确定要删除技能 "${deleteTarget?.name}" 吗？`}
        variant="destructive"
        onConfirm={confirmDelete}
      />

      {/* Workspace edit confirmation */}
      <ConfirmDialog
        open={workspaceEditConfirmOpen}
        onOpenChange={setWorkspaceEditConfirmOpen}
        title="编辑工作区技能"
        description={`你正在编辑工作区「${source.name}」中的技能「${pendingEditSkill?.name}」，修改将直接影响项目文件：${source.path}/.agents/skills/${pendingEditSkill?.name}。确定继续吗？`}
        onConfirm={confirmWorkspaceEdit}
      />

      {/* Batch delete confirm */}
      <ConfirmDialog
        open={batchConfirmOpen}
        onOpenChange={setBatchConfirmOpen}
        title="批量删除确认"
        description={`确定要删除选中的 ${selected.length} 个技能吗？${isWorkspace ? "此操作将永久删除项目文件，不可撤销。" : "此操作不可逆。"}`}
        variant="destructive"
        onConfirm={confirmBatchDelete}
      />

      {/* Overwrite confirm */}
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
    </>
  );
}

// --- Main Page ---

export function SkillsPage() {
  const [sources, setSources] = useState<SkillSourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");

  const loadSources = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiListSkillSources();
      setSources(data);
    } catch (e) {
      toast.error("加载技能列表失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSources();
  }, [loadSources]);

  const filteredSources = useMemo(() => {
    if (!searchQuery.trim()) return sources;
    const q = searchQuery.toLowerCase();
    return sources
      .map((s) => ({
        ...s,
        skills: s.skills.filter((sk) =>
          sk.name.toLowerCase().includes(q) || sk.description.toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.skills.length > 0 || s.name.toLowerCase().includes(q));
  }, [sources, searchQuery]);

  const columns: Column<SkillSourceInfo>[] = [
    {
      key: "name",
      header: "来源",
      sortable: true,
      filterable: true,
      render: (row) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-text-bright">{row.name}</span>
          {row.type === "workspace" && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium bg-surface-2 text-text-muted truncate max-w-[240px]">
              {row.path}
            </span>
          )}
        </div>
      ),
    },
    {
      key: "status",
      header: "状态",
      filterable: true,
      render: (row) => {
        if (row.type === "global") return <StatusBadge status="configured" label="全局" />;
        return <SourceStatusBadge status={row.status} />;
      },
    },
    {
      key: "skills",
      header: "技能数",
      sortable: true,
      render: (row) => (
        <span className={`inline-flex items-center justify-center min-w-[24px] h-5 px-1.5 rounded-full text-xs font-medium ${
          row.skills.length > 0
            ? "bg-brand-subtle text-brand dark:text-brand-light"
            : "bg-surface-2 text-text-muted"
        }`}>
          {row.skills.length}
        </span>
      ),
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
          <h2 className="text-xl font-semibold text-text-bright">技能管理</h2>
          <p className="text-sm text-text-muted mt-0.5">管理 AI Agent 可用的技能模板</p>
        </div>
      </div>
      <div className="relative">
        <svg className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
        </svg>
        <Input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="搜索技能..."
          className="pl-9"
        />
      </div>
      <DataTable<SkillSourceInfo>
        columns={columns}
        data={filteredSources}
        rowKey={(row) => row.type === "global" ? "__global__" : row.id!}
        expandableRow={(row) => <SkillSubrow source={row} onRefresh={loadSources} />}
        defaultExpandAll
        emptyMessage={'暂无技能'}
      />
    </div>
  );
}
