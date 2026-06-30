import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { agentSitesApi } from "@/src/api/sites";
import { NS } from "@/src/i18n";
import { AgentCardList } from "../shared/AgentCardList";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface SiteItem {
  id: string;
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description: string | null;
  visibility: "private" | "org" | "authenticated" | "public";
  createdAt: number;
  updatedAt: number;
}

const VISIBILITY_LABELS: Record<string, string> = {
  private: "仅自己",
  org: "组织内",
  authenticated: "已登录用户",
  public: "公开",
};

const VISIBILITY_BADGE_CLASSES: Record<string, string> = {
  private: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  org: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  authenticated: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  public: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
};

function validateForm(name: string): string | null {
  if (!name.trim()) return "名称不能为空";
  return null;
}

function formatTimestamp(ts: number): string {
  return new Date(ts * 1000).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AgentSitesPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [apps, setApps] = useState<SiteItem[]>([]);
  const [loading, setLoading] = useState(true);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<SiteItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SiteItem | null>(null);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formVisibility, setFormVisibility] = useState("private");
  const [formSaving, setFormSaving] = useState(false);

  const fetchApps = useCallback(async () => {
    setLoading(true);
    try {
      const res = await agentSitesApi.list();
      if (res.success) {
        setApps(Array.isArray(res.data) ? (res.data as unknown as SiteItem[]) : []);
      }
    } catch (error) {
      console.error("加载 app 列表失败", error);
      toast.error("加载 app 列表失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchApps();
  }, [fetchApps]);

  const resetForm = useCallback(() => {
    setFormName("");
    setFormDescription("");
    setFormVisibility("private");
  }, []);

  const handleOpenCreate = () => {
    setEditingApp(null);
    resetForm();
    setDialogOpen(true);
  };

  const handleOpenEdit = (app: SiteItem) => {
    setEditingApp(app);
    setFormName(app.name);
    setFormDescription(app.description ?? "");
    setFormVisibility(app.visibility);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const error = validateForm(formName);
    if (error) {
      toast.error(error);
      return;
    }
    setFormSaving(true);
    try {
      if (editingApp) {
        await agentSitesApi.update(editingApp.id, {
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          visibility: formVisibility,
        });
        toast.success("App 已更新");
      } else {
        await agentSitesApi.create({
          name: formName.trim(),
          description: formDescription.trim() || undefined,
          visibility: formVisibility,
        });
        toast.success("App 创建成功");
      }
      setDialogOpen(false);
      await fetchApps();
    } catch (saveError) {
      console.error("保存 app 失败", saveError);
      toast.error(saveError instanceof Error ? saveError.message : "保存失败");
    } finally {
      setFormSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await agentSitesApi.delete(deleteTarget.id);
      toast.success("App 已删除");
      setConfirmOpen(false);
      setDeleteTarget(null);
      await fetchApps();
    } catch (error) {
      console.error("删除 app 失败", error);
      toast.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  const handleRotateToken = async (app: SiteItem) => {
    try {
      await agentSitesApi.rotateToken(app.id);
      toast.success("Token 已重签");
    } catch (error) {
      console.error("重签 token 失败", error);
      toast.error(error instanceof Error ? error.message : "重签失败");
    }
  };

  const handleOpenSite = (remoteAppId: string) => {
    window.open(`/${remoteAppId}/`, "_blank");
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
            <Skeleton key={i} className="h-20 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <AgentPageHeader
        title="Agent Sites"
        subtitle={t("sites")}
        actions={<Button onClick={handleOpenCreate}>+ 创建 App</Button>}
      />
      <AgentCardList
        items={apps}
        cardKey={(app) => app.id}
        searchPlaceholder="搜索 app..."
        searchFn={(app, q) => app.name.toLowerCase().includes(q) || app.remoteAppId.toLowerCase().includes(q)}
        emptyMessage="暂无 app，点击「+ 创建 App」开始"
        renderCard={(app) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-bright">{app.name}</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${VISIBILITY_BADGE_CLASSES[app.visibility] ?? ""}`}
                  >
                    {VISIBILITY_LABELS[app.visibility] ?? app.visibility}
                  </span>
                </div>
                <div className="flex items-center gap-3 mt-1.5">
                  <code className="rounded bg-surface-2 px-1.5 py-0.5 text-xs text-text-muted font-mono">
                    {app.remoteAppId}
                  </code>
                  {app.description && (
                    <span className="text-xs text-text-muted truncate max-w-[300px]">{app.description}</span>
                  )}
                </div>
                <div className="mt-1 text-xs text-text-dim">{formatTimestamp(app.createdAt)}</div>
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button size="xs" variant="outline" onClick={() => handleOpenSite(app.remoteAppId)}>
                  打开
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleRotateToken(app)}>
                  重签 Token
                </Button>
                <Button size="xs" variant="outline" onClick={() => handleOpenEdit(app)}>
                  编辑
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => {
                    setDeleteTarget(app);
                    setConfirmOpen(true);
                  }}
                >
                  删除
                </Button>
              </div>
            </div>
          </div>
        )}
      />

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingApp ? "编辑 App" : "创建 App"}
        onSubmit={handleSave}
        loading={formSaving}
        width="sm:max-w-lg"
      >
        <div className="grid gap-4">
          <div className="grid gap-2">
            <Label htmlFor="site-name">名称</Label>
            <Input
              id="site-name"
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder="kebab-case（如 my-app）"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="site-description">描述</Label>
            <Textarea
              id="site-description"
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder="可选描述"
              rows={3}
            />
          </div>
          <div className="grid gap-2">
            <Label>可见性</Label>
            <Select value={formVisibility} onValueChange={setFormVisibility}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </FormDialog>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="确认删除"
        description={`确认删除 app「${deleteTarget?.name ?? ""}」？此操作不可撤销，将同时删除远程 app。`}
        variant="destructive"
        onConfirm={handleDelete}
      />
    </div>
  );
}
