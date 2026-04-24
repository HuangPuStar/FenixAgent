import { useState, useCallback, useEffect } from "react";
import { toast } from "sonner";
import Markdown from "react-markdown";
import { DataTable, type Column } from "@/components/config/DataTable";
import { FormDialog } from "@/components/config/FormDialog";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { BatchActionBar } from "@/components/config/BatchActionBar";
import { StatusBadge } from "@/components/config/StatusBadge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  apiListSkills, apiGetSkill, apiSetSkill, apiDeleteSkill, apiEnableSkill, apiDisableSkill,
} from "../api/client";
import type { SkillInfo } from "../types/config";

export function validateSkillForm(name: string, content: string): string | null {
  if (!name.trim()) return "名称不能为空";
  if (!content.trim()) return "内容不能为空";
  return null;
}

export function buildSkillMetadata(license: string, compatibility: string): Record<string, string> | undefined {
  const metadata: Record<string, string> = {};
  if (license) metadata.license = license;
  if (compatibility) metadata.compatibility = compatibility;
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export function SkillsPage() {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillInfo | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillInfo[]>([]);
  const [batchAction, setBatchAction] = useState<"enable" | "disable" | "delete" | null>(null);
  const [batchConfirmOpen, setBatchConfirmOpen] = useState(false);
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formLicense, setFormLicense] = useState("");
  const [formCompatibility, setFormCompatibility] = useState("");
  const [formContent, setFormContent] = useState("");
  const [formSaving, setFormSaving] = useState(false);

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

  useEffect(() => { loadSkills(); }, [loadSkills]);

  const columns: Column<SkillInfo>[] = [
    { key: "name", header: "名称", sortable: true, filterable: true },
    { key: "description", header: "描述" },
    {
      key: "enabled",
      header: "状态",
      filterable: true,
      render: (row) => <StatusBadge status={row.enabled ? "enabled" : "disabled"} />,
    },
  ];

  const handleOpenCreate = () => {
    setEditingSkill(null);
    setFormName(""); setFormDescription(""); setFormLicense("");
    setFormCompatibility(""); setFormContent("");
    setDialogOpen(true);
  };

  const handleOpenEdit = async (skill: SkillInfo) => {
    setEditingSkill(skill);
    try {
      const detail = await apiGetSkill(skill.name);
      setFormName(detail.name); setFormDescription(detail.description);
      setFormContent(detail.content);
      setFormLicense(detail.metadata?.license || "");
      setFormCompatibility(detail.metadata?.compatibility || "");
    } catch {
      toast.error("加载技能详情失败");
    }
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const err = validateSkillForm(formName, formContent);
    if (err) { toast.error(err); return; }
    setFormSaving(true);
    try {
      const metadata = buildSkillMetadata(formLicense, formCompatibility);
      await apiSetSkill(formName, {
        description: formDescription,
        content: formContent,
        metadata,
      });
      toast.success(editingSkill ? "技能已更新" : "技能已创建");
      setDialogOpen(false);
      loadSkills();
    } catch (e) {
      toast.error("保存失败: " + (e instanceof Error ? e.message : "未知错误"));
    } finally {
      setFormSaving(false);
    }
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
      loadSkills();
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
      loadSkills();
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
      loadSkills();
    } catch (e) {
      toast.error("批量操作失败: " + (e instanceof Error ? e.message : "未知错误"));
    }
  };

  if (loading) {
    return <div className="flex h-full items-center justify-center text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">技能管理</h2>
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
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => handleToggle(row)}>
              {row.enabled ? "禁用" : "启用"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleOpenEdit(row)}>编辑</Button>
            <Button size="sm" variant="destructive" onClick={() => { setDeleteTarget(row.name); setConfirmOpen(true); }}>删除</Button>
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
      <FormDialog open={dialogOpen} onOpenChange={setDialogOpen}
        title={editingSkill ? "编辑技能" : "新建技能"} onSubmit={handleSave}
        loading={formSaving} width="sm:max-w-4xl">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">名称</label>
              <Input value={formName} onChange={(e) => setFormName(e.target.value)}
                disabled={!!editingSkill} placeholder="技能名称" />
            </div>
            <div>
              <label className="text-sm font-medium">描述</label>
              <Input value={formDescription} onChange={(e) => setFormDescription(e.target.value)} placeholder="可选" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-sm font-medium">许可证</label>
              <Input value={formLicense} onChange={(e) => setFormLicense(e.target.value)} placeholder="可选" />
            </div>
            <div>
              <label className="text-sm font-medium">兼容性</label>
              <Input value={formCompatibility} onChange={(e) => setFormCompatibility(e.target.value)} placeholder="可选" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 border rounded-lg overflow-hidden min-h-[300px]">
            <div className="p-2 border-r">
              <label className="text-sm font-medium text-muted-foreground">编辑</label>
              <Textarea
                value={formContent}
                onChange={(e) => setFormContent(e.target.value)}
                className="min-h-[260px] font-mono text-sm border-0 focus-visible:ring-0 p-2"
                placeholder="输入 Markdown 内容..."
              />
            </div>
            <div className="p-2 overflow-y-auto bg-muted/30">
              <label className="text-sm font-medium text-muted-foreground">预览</label>
              <div className="prose prose-sm dark:prose-invert max-w-none mt-1">
                <Markdown>{formContent}</Markdown>
              </div>
            </div>
          </div>
        </div>
      </FormDialog>
      <ConfirmDialog open={confirmOpen} onOpenChange={setConfirmOpen}
        title="确认删除" description={`此操作不可逆。确定要删除技能 "${deleteTarget}" 吗？`}
        variant="destructive" onConfirm={confirmDelete} />
      <ConfirmDialog open={batchConfirmOpen} onOpenChange={setBatchConfirmOpen}
        title={`批量${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}确认`}
        description={`确定要${batchAction === "delete" ? "删除" : batchAction === "enable" ? "启用" : "禁用"}选中的 ${selected.length} 个技能吗？${batchAction === "delete" ? "此操作不可逆。" : ""}`}
        variant={batchAction === "delete" ? "destructive" : "default"}
        onConfirm={confirmBatchAction} />
    </div>
  );
}
