import { useNavigate } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { ExternalLink, MoreHorizontal, Pencil, Plus, RefreshCw, Search, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { EmptyState } from "@/components/config/EmptyState";
import { FormDialog } from "@/components/config/FormDialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { agentSitesApi } from "@/src/api/sites";
import { NS } from "@/src/i18n";
import { AgentPageHeader } from "../shared/AgentPageHeader";

interface SiteItem {
  id: string;
  organizationId: string;
  userId: string;
  remoteAppId: string;
  name: string;
  description: string | null;
  visibility: "private" | "org" | "authenticated" | "public";
  /** 创建者 agent config id。null 表示创建者已删除，所有绑定 agent 均可操作。 */
  createdByAgentConfigId?: string | null;
  /** 创建者 agent config 名称（用于前端展示）。 */
  createdByAgentConfigName?: string | null;
  createdAt: number;
  updatedAt: number;
}

const VISIBILITY_LABELS: Record<string, string> = {
  private: "仅自己",
  org: "组织内",
  authenticated: "已登录用户",
  public: "公开",
};

const VISIBILITY_BADGE_VARIANT: Record<string, "destructive" | "secondary" | "outline" | "default"> = {
  private: "destructive",
  org: "secondary",
  authenticated: "outline",
  public: "default",
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

const DEFAULT_PAGE_SIZE = 20;

export function AgentSitesPage() {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const navigate = useNavigate();

  // 筛选 + 分页状态
  const [searchKeyword, setSearchKeyword] = useState("");
  const [visibilityFilter, setVisibilityFilter] = useState<"all" | "private" | "org" | "authenticated" | "public">(
    "all",
  );
  const [page, setPage] = useState(1);

  // 数据加载
  const {
    data: apps = [],
    loading,
    refresh,
  } = useRequest(async () => {
    const raw = await unwrap(agentSitesApi.list());
    return raw as SiteItem[];
  });

  // 客户端筛选
  const filtered = useMemo(() => {
    const q = searchKeyword.trim().toLowerCase();
    return apps.filter((app) => {
      if (q && !app.name.toLowerCase().includes(q) && !app.remoteAppId.toLowerCase().includes(q)) return false;
      if (visibilityFilter !== "all" && app.visibility !== visibilityFilter) return false;
      return true;
    });
  }, [apps, searchKeyword, visibilityFilter]);

  // 客户端分页
  const totalPages = Math.max(1, Math.ceil(filtered.length / DEFAULT_PAGE_SIZE));
  const paged = filtered.slice((page - 1) * DEFAULT_PAGE_SIZE, page * DEFAULT_PAGE_SIZE);

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingApp, setEditingApp] = useState<SiteItem | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SiteItem | null>(null);

  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formVisibility, setFormVisibility] = useState<"private" | "org" | "authenticated" | "public">("private");

  // 保存（创建/更新）
  const { run: runSave, loading: formSaving } = useRequest(
    async () => {
      const error = validateForm(formName);
      if (error) {
        toast.error(error);
        return;
      }
      if (editingApp) {
        await unwrap(
          agentSitesApi.update(editingApp.id, {
            name: formName.trim(),
            description: formDescription.trim() || undefined,
            visibility: formVisibility,
          }),
        );
        toast.success("App 已更新");
      } else {
        await unwrap(
          agentSitesApi.create({
            name: formName.trim(),
            description: formDescription.trim() || undefined,
            visibility: formVisibility,
          }),
        );
        toast.success("App 创建成功");
      }
      setDialogOpen(false);
      refresh();
    },
    {
      manual: true,
      onError: (err) => toast.error(err instanceof Error ? err.message : "保存失败"),
    },
  );

  // 删除
  const { run: runDelete } = useRequest(
    async (id: string) => {
      await unwrap(agentSitesApi.delete(id));
      toast.success("App 已删除");
      setConfirmOpen(false);
      setDeleteTarget(null);
      refresh();
    },
    {
      manual: true,
      onError: (err) => toast.error(err instanceof Error ? err.message : "删除失败"),
    },
  );

  // 重签 token
  const { run: runRotateToken } = useRequest(
    async (app: SiteItem) => {
      await unwrap(agentSitesApi.rotateToken(app.id));
      toast.success("Token 已重签");
    },
    {
      manual: true,
      onError: (err) => toast.error(err instanceof Error ? err.message : "重签失败"),
    },
  );

  function resetForm() {
    setFormName("");
    setFormDescription("");
    setFormVisibility("private");
  }

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

  const handleNavigateToCreator = async (agentConfigId: string) => {
    try {
      const envList = await unwrap(envApi.list());
      const env = Array.isArray(envList) ? envList.find((e) => e.agentConfigId === agentConfigId) : undefined;
      if (env) {
        void navigate({ to: "/agent/$agentId", params: { agentId: env.id } });
      } else {
        toast.error("该智能体暂未激活，无法跳转");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "跳转失败");
    }
  };

  const handleOpenSite = (remoteAppId: string) => {
    window.open(`/web/site/deploy/${remoteAppId}/`, "_blank");
  };

  if (loading) {
    return (
      <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
        <AgentPageHeader
          title="Agent Sites"
          subtitle={t("sites")}
          actions={<Skeleton className="h-9 w-28 rounded-lg" />}
        />
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
            <Skeleton key={i} className="h-12 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      {/* ── 标题栏 ── */}
      <AgentPageHeader
        title="Agent Sites"
        subtitle={t("sites")}
        actions={
          <Button onClick={handleOpenCreate}>
            <Plus className="mr-1 size-3.5" />
            创建 App
          </Button>
        }
      />

      {/* ── 搜索 + 可见性筛选 ── */}
      <div className="mb-4 flex items-center gap-3">
        <div className="relative flex-1 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-text-muted" />
          <Input
            placeholder="搜索 app..."
            value={searchKeyword}
            onChange={(e) => {
              setSearchKeyword(e.target.value);
              setPage(1);
            }}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <Tabs
          value={visibilityFilter}
          onValueChange={(v) => {
            setVisibilityFilter(v as typeof visibilityFilter);
            setPage(1);
          }}
        >
          <TabsList>
            <TabsTrigger
              value="all"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              全部
            </TabsTrigger>
            <TabsTrigger
              value="private"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              仅自己
            </TabsTrigger>
            <TabsTrigger
              value="org"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              组织内
            </TabsTrigger>
            <TabsTrigger
              value="authenticated"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              已登录
            </TabsTrigger>
            <TabsTrigger
              value="public"
              className="text-xs h-7 data-[state=active]:text-text-bright data-[state=inactive]:text-text-muted"
            >
              公开
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* ── 站点表格 ── */}
      {paged.length === 0 ? (
        searchKeyword.trim() || visibilityFilter !== "all" ? (
          <div className="py-12 text-center text-sm text-text-muted">暂无匹配的 app</div>
        ) : (
          <EmptyState
            icon={<Plus className="w-10 h-10" />}
            title="暂无 App"
            description={"点击「创建 App」开始"}
            action={{ label: "创建 App", onClick: handleOpenCreate }}
          />
        )
      ) : (
        <>
          <div className="rounded-lg border border-border/40 bg-white overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="text-xs">名称</TableHead>
                  <TableHead className="text-xs w-[80px]">可见性</TableHead>
                  <TableHead className="text-xs">remoteAppId</TableHead>
                  <TableHead className="text-xs">创建者</TableHead>
                  <TableHead className="text-xs w-[140px]">创建时间</TableHead>
                  <TableHead className="text-xs w-[120px] text-right">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paged.map((app) => (
                  <TableRow key={app.id}>
                    {/* 名称 + 描述 */}
                    <TableCell>
                      <button
                        type="button"
                        className="text-left cursor-pointer hover:underline"
                        onClick={() => handleOpenEdit(app)}
                      >
                        <span className="text-sm font-medium text-text-bright">{app.name}</span>
                      </button>
                      {app.description && (
                        <p className="text-xs text-text-muted truncate max-w-[240px]">{app.description}</p>
                      )}
                    </TableCell>

                    {/* 可见性 */}
                    <TableCell>
                      <Badge
                        variant={VISIBILITY_BADGE_VARIANT[app.visibility] ?? "outline"}
                        className="text-[11px] h-5"
                      >
                        {VISIBILITY_LABELS[app.visibility] ?? app.visibility}
                      </Badge>
                    </TableCell>

                    {/* remoteAppId */}
                    <TableCell>
                      <code className="text-xs text-text-secondary font-mono truncate max-w-[180px] block">
                        {app.remoteAppId}
                      </code>
                    </TableCell>

                    {/* 创建者 */}
                    <TableCell>
                      {app.createdByAgentConfigId ? (
                        <button
                          type="button"
                          className="text-xs text-text-dim hover:text-primary hover:underline cursor-pointer"
                          onClick={() => handleNavigateToCreator(app.createdByAgentConfigId!)}
                        >
                          {app.createdByAgentConfigName || app.createdByAgentConfigId}
                        </button>
                      ) : (
                        <span className="text-xs text-text-muted">—</span>
                      )}
                    </TableCell>

                    {/* 创建时间 */}
                    <TableCell>
                      <span className="text-xs text-text-muted">{formatTimestamp(app.createdAt)}</span>
                    </TableCell>

                    {/* 操作 */}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        {/* 打开站点 */}
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-7 p-0"
                          onClick={() => handleOpenSite(app.remoteAppId)}
                          title="打开"
                        >
                          <ExternalLink className="size-3.5" />
                        </Button>

                        {/* 更多菜单 */}
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="size-7 p-0">
                              <MoreHorizontal className="size-3.5" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => runRotateToken(app)}>
                              <RefreshCw className="size-3.5" />
                              重签 Token
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => handleOpenEdit(app)}>
                              <Pencil className="size-3.5" />
                              编辑
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => {
                                setDeleteTarget(app);
                                setConfirmOpen(true);
                              }}
                            >
                              <Trash2 className="size-3.5" />
                              删除
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          {/* ── 分页控件 ── */}
          {totalPages > 1 && (
            <div className="mt-4 flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                上一页
              </Button>
              <span className="text-xs text-text-muted">
                {page} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                下一页
              </Button>
            </div>
          )}
        </>
      )}

      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingApp ? "编辑 App" : "创建 App"}
        onSubmit={() => runSave()}
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
            <Select value={formVisibility} onValueChange={(v) => setFormVisibility(v as typeof formVisibility)}>
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
        onConfirm={() => deleteTarget && runDelete(deleteTarget.id)}
      />
    </div>
  );
}
