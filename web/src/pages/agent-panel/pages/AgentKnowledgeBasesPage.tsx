import { useNavigate, useSearch } from "@tanstack/react-router";
import { useRequest } from "ahooks";
import { BookOpen, Braces, Cpu, Download, File, Globe, Layers, Plus, RefreshCw, Scissors } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { FormDialog } from "@/components/config/FormDialog";
import { ResourcePreviewDialog } from "@/components/knowledge/ResourcePreviewDialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { kbApi } from "@/src/api/knowledge-bases";
import { unwrap } from "@/src/api/request";
import { AppHeader } from "@/src/components/layout/app-header";
import { AppPage } from "@/src/components/layout/app-page";
import { NS } from "@/src/i18n";
import { ChunkDetailSheet } from "@/src/pages/agent-panel/components/ChunkDetailSheet";
import { EmbeddingModelManager } from "@/src/pages/agent-panel/components/EmbeddingModelManager";
import { KnowledgeGraphPanel } from "@/src/pages/agent-panel/components/KnowledgeGraphPanel";
import { RetrievalTestPanel } from "@/src/pages/agent-panel/components/RetrievalTestPanel";
import { AgentMasterDetailWorkspace } from "@/src/pages/agent-panel/shared/agent-master-detail-workspace";
import { useOrg } from "../../../contexts/OrgContext";
import { useSession } from "../../../lib/auth-client";
import type {
  KnowledgeBaseDetail,
  KnowledgeBaseInfo,
  KnowledgeFormOptions,
  KnowledgeParseMethod,
  KnowledgeResourceInfo,
  UnassociatedKnowledgeBase,
} from "../../../types/knowledge";
import { AgentKnowledgeDirectory } from "./agent-knowledge-directory";
import { AgentKnowledgeResources } from "./agent-knowledge-resources";
import "./agent-knowledge.css";

/** 资源状态 → 语义色 badge 样式 */
function getStatusBadge(status: string) {
  switch (status) {
    case "ready":
      return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
    case "processing":
    case "pending":
    case "indexing":
      return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
    case "error":
      return "bg-red-50 text-red-700 ring-1 ring-red-200";
    default:
      return "bg-surface-2 text-text-muted";
  }
}

/** 知识库状态 → 圆点装饰色 */
function getStatusDot(status: string) {
  switch (status) {
    case "ready":
      return "bg-emerald-500";
    case "processing":
    case "pending":
    case "indexing":
      return "bg-amber-500";
    case "error":
      return "bg-red-500";
    default:
      return "bg-slate-300";
  }
}

export function AgentKnowledgeBasesPage() {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const { data: session } = useSession();
  const { role: orgRole } = useOrg();

  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { kbId?: string };
  const kbId = typeof search.kbId === "string" && search.kbId ? search.kbId : null;
  const pushKbId = useCallback(
    (id: string | null) => {
      void navigate({
        to: "/agent/knowledge-bases",
        search: (previous) => {
          const next = { ...previous } as Record<string, unknown>;
          if (id) next.kbId = id;
          else delete next.kbId;
          return next;
        },
      });
    },
    [navigate],
  );

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isOrgOwner = orgRole === "owner";
  const [selectedDetail, setSelectedDetail] = useState<KnowledgeBaseDetail | null>(null);
  const [resources, setResources] = useState<KnowledgeResourceInfo[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<KnowledgeBaseInfo | null>(null);
  const [deletingResourceId, setDeletingResourceId] = useState<string | null>(null);
  const [resourceDeleteConfirmOpen, setResourceDeleteConfirmOpen] = useState(false);
  const [resourceDeleteTarget, setResourceDeleteTarget] = useState<{
    kbId: string;
    resourceId: string;
    name: string;
  } | null>(null);
  const [reparsingResourceId, setReparsingResourceId] = useState<string | null>(null);
  const [reparseTarget, setReparseTarget] = useState<KnowledgeResourceInfo | null>(null);
  const [reparseConfirmOpen, setReparseConfirmOpen] = useState(false);
  const [reparseDeleteOld, setReparseDeleteOld] = useState(false);
  const [overwriteConfirmOpen, setOverwriteConfirmOpen] = useState(false);
  const pendingOverwriteRef = useRef<{ kbId: string; formData: FormData; dupNames: string[] } | null>(null);
  const [detailTab, setDetailTab] = useState<"documents" | "graph" | "retrieval">("documents");
  const [detailError, setDetailError] = useState<string | null>(null);
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [previewResource, setPreviewResource] = useState<KnowledgeResourceInfo | null>(null);
  const [selectedChunkResource, setSelectedChunkResource] = useState<KnowledgeResourceInfo | null>(null);
  // 表单字段
  const [formName, setFormName] = useState("");
  const [formDescription, setFormDescription] = useState("");
  const [formEmbeddingModel, setFormEmbeddingModel] = useState("");
  const [formParseMethod, setFormParseMethod] = useState<KnowledgeParseMethod>("builtin");
  const [formChunkMethod, setFormChunkMethod] = useState("");
  const [formPipeline, setFormPipeline] = useState("");
  const [editingItem, setEditingItem] = useState<KnowledgeBaseInfo | null>(null);
  // 导入对话框
  const [importDialogOpen, setImportDialogOpen] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [unassociatedList, setUnassociatedList] = useState<UnassociatedKnowledgeBase[]>([]);
  const [importingRemoteId, setImportingRemoteId] = useState<string | null>(null);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<UnassociatedKnowledgeBase | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // 列表查询
  const {
    data: listData,
    loading,
    error: listError,
    refresh,
  } = useRequest(() => unwrap(kbApi.list()), {
    onError: (err) => {
      console.error("Failed to load knowledge bases", err);
      toast.error(err instanceof Error ? err.message : t("loadError"));
    },
  });

  // 组件卸载时清理轮询
  useEffect(() => {
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);
  const items: KnowledgeBaseInfo[] = Array.isArray(listData) ? listData : [];

  const { data: formOptions, refresh: refreshFormOptions } = useRequest(() => unwrap(kbApi.getFormOptions()), {
    refreshDeps: [],
    onError: (err) => {
      // 选项拉取失败仅记录，不弹 toast——表单仍可用（分块方法是静态兜底）
      console.error("Failed to load knowledge form options", err);
    },
  });
  const options: KnowledgeFormOptions | null = formOptions ?? null;

  // 详情查询（手动触发）
  const { run: runLoadDetail, loading: detailLoading } = useRequest(
    (id: string) => Promise.all([unwrap(kbApi.get({ id })), unwrap(kbApi.listResources({ id }))]),
    {
      manual: true,
      onSuccess: ([detail, resList], [requestedId]) => {
        if (requestedId !== kbId) return;
        setSelectedDetail(detail);
        setResources(Array.isArray(resList) ? resList : []);
        setDetailError(null);
      },
      onError: (err, [requestedId]) => {
        if (requestedId !== kbId) return;
        console.error("Failed to load detail", err);
        setSelectedDetail(null);
        setResources([]);
        setDetailError(err instanceof Error ? err.message : t("loadDetailError"));
        toast.error(err instanceof Error ? err.message : t("loadDetailError"));
      },
    },
  );

  // kbId 变化时自动加载/清除详情（支持浏览器前进后退及直接访问带 kbId 的 URL）
  useEffect(() => {
    setSelectedDetail(null);
    setResources([]);
    setDetailError(null);
    if (kbId) {
      setDetailTab("documents");
      runLoadDetail(kbId);
    }
  }, [kbId, runLoadDetail]);

  // 创建知识库
  const { run: runCreate, loading: createSaving } = useRequest(
    (payload: {
      name: string;
      slug?: string;
      description?: string;
      embeddingModel?: string | null;
      parseMethod?: KnowledgeParseMethod | null;
      pipelineId?: string | null;
      chunkMethod?: string | null;
    }) => unwrap(kbApi.create(payload)),
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
      onSuccess: (updated, [id]) => {
        setDialogOpen(false);
        // 用后端返回的最新数据同步详情头部，避免改名/改描述后需刷新才生效
        setSelectedDetail((prev) => (prev && prev.id === id ? { ...prev, ...updated } : prev));
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
      if (kbId === id) {
        pushKbId(null);
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
    (id: string, formData: FormData, overwrite?: boolean) => unwrap(kbApi.uploadResources({ id, overwrite }, formData)),
    {
      manual: true,
      onSuccess: (_data, params) => {
        toast.success(t("toast.uploaded"));
        runLoadDetail(params[0]);
        // 上传后异步解析，轮询刷新直到解析完成
        startStatusPoll(params[0]);
      },
      onError: (err) => {
        console.error("Upload failed", err);
        toast.error(err instanceof Error ? err.message : t("toast.uploadFailed"));
      },
    },
  );

  /** 上传/重新解析后轮询刷新资源状态，直到所有文档解析完成 */
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startStatusPoll = (kbId: string) => {
    // 先清理之前的轮询
    if (pollingRef.current) clearInterval(pollingRef.current);
    let ticks = 0;
    pollingRef.current = setInterval(async () => {
      try {
        ticks += 1;
        const resList = await unwrap(kbApi.listResources({ id: kbId }));
        if (!Array.isArray(resList)) return;
        setResources(resList);
        // 所有文档都已不在解析中（DONE/FAIL/空），停止轮询
        const hasRunning = resList.some((r) => r.runStatus === "RUNNING" || r.runStatus === "UNSTART");
        if (!hasRunning || ticks > 150) {
          // 最多轮询 5 分钟 (150 * 2s)
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
          runLoadDetail(kbId);
        }
      } catch {
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    }, 2000);
  };

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

  // 重新解析轮询：每隔 2s 刷新资源列表，直到 runStatus 为 DONE/FAIL（最多 5 分钟）
  const reparseAndPoll = (kbId: string, resourceId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    let ticks = 0;
    pollingRef.current = setInterval(async () => {
      try {
        ticks += 1;
        const resList = await unwrap(kbApi.listResources({ id: kbId }));
        if (!Array.isArray(resList)) return;
        setResources(resList);
        const target = resList.find((r) => r.id === resourceId);
        if (!target || target.runStatus === "DONE" || target.runStatus === "FAIL" || ticks > 150) {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
          setReparsingResourceId(null);
          if (target) runLoadDetail(kbId);
          return;
        }
      } catch {
        clearInterval(pollingRef.current!);
        pollingRef.current = null;
        setReparsingResourceId(null);
      }
    }, 2000);
  };

  // 进入详情
  const handleSelect = (kb: KnowledgeBaseInfo) => {
    if (kb.remoteExists === false) {
      toast.error("该知识库已在 RAGFlow 中被删除，无法查看详情");
      return;
    }
    setDetailTab("documents");
    pushKbId(kb.id);
  };

  // 打开创建弹窗：先检查 RAGFlow key，未配置则直接拦截
  const openCreateDialog = async () => {
    setEditingItem(null);
    setFormName("");
    setFormDescription("");
    setFormEmbeddingModel("");
    setFormParseMethod("builtin");
    setFormChunkMethod("");
    setFormPipeline("");
    setDialogOpen(true);
  };

  // 打开编辑弹窗：仅 name/description 可改，配置字段不展示
  const openEditDialog = () => {
    const found = items.find((i) => i.id === kbId);
    setEditingItem(found ?? null);
    setFormName(selectedDetail?.name ?? "");
    setFormDescription(selectedDetail?.description ?? "");
    setDialogOpen(true);
  };

  // 打开导入对话框
  const openImportDialog = async () => {
    setImportDialogOpen(true);
    setImportLoading(true);
    setUnassociatedList([]);
    try {
      const list = await unwrap(kbApi.listUnassociated());
      setUnassociatedList(list);
    } catch (err) {
      toast.error(`获取未关联知识库失败: ${(err as Error).message}`);
    } finally {
      setImportLoading(false);
    }
  };

  // 导入单个知识库
  const handleImport = async (remoteId: string, name: string) => {
    setImportingRemoteId(remoteId);
    try {
      await unwrap(kbApi.import(remoteId, name));
      toast.success(`「${name}」导入成功`);
      setUnassociatedList((prev) => prev.filter((ds) => ds.id !== remoteId));
      setRenameDialogOpen(false);
      setRenameTarget(null);
      refresh();
    } catch (err) {
      toast.error(`导入失败: ${(err as Error).message}`);
    } finally {
      setImportingRemoteId(null);
    }
  };

  // 加载中骨架屏
  if (loading) {
    return (
      <AppPage className="agent-knowledge-page" busy>
        <div className="knowledge-page-header-skeleton">
          <div>
            <Skeleton className="h-7 w-28 rounded-lg" />
            <Skeleton className="mt-2 h-3.5 w-56 rounded-md" />
          </div>
          <Skeleton className="h-9 w-[260px] rounded-lg" />
        </div>
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => `kb-skeleton-${i}`).map((placeholderKey) => (
            <div
              key={placeholderKey}
              className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-inset ring-[#e8edf4]/80 overflow-hidden"
            >
              <div className="h-1 w-full bg-[#e2e8f0]" />
              <div className="flex items-center gap-4 p-5 pt-4">
                <Skeleton className="h-14 w-14 rounded-2xl" />
                <div className="flex-1 space-y-2.5">
                  <Skeleton className="h-4 w-3/4 rounded-md" />
                  <Skeleton className="h-3 w-1/2 rounded-md" />
                  <Skeleton className="h-5 w-20 rounded-full" />
                </div>
              </div>
            </div>
          ))}
        </div>
      </AppPage>
    );
  }

  // 解析方法可读文案（详情只读展示用）
  const parseMethodLabel = (pm: KnowledgeParseMethod | null) => {
    if (pm === "builtin") return t("detailConfig.parseMethodBuiltin");
    if (pm === "pipeline") return t("detailConfig.parseMethodPipeline");
    return t("detailConfig.notSet");
  };

  const chunkMethodLabel = (value: string | null) => {
    if (!value) return t("detailConfig.notSet");
    const matched = options?.chunkMethods.find((c) => c.value === value);
    if (matched?.label) return matched.label;
    if (matched?.labelKey) return t(matched.labelKey);
    return value;
  };

  // 权限控制：owner 有管理权限
  const canManage = isOrgOwner;

  // 当前选中的知识库是否可管理（编辑/删除/上传/重新解析/启用等操作）
  const canManageDetail = selectedDetail ? session?.user?.id === selectedDetail.userId || isOrgOwner : false;

  return (
    <AppPage className="agent-knowledge-page" busy>
      <AppHeader
        title={t("title")}
        subtitle={t("subtitle")}
        actions={
          canManage ? (
            <>
              <Button onClick={openCreateDialog}>
                <Plus />
                {t("btn.create")}
              </Button>
              <Button onClick={() => setModelDialogOpen(true)} variant="outline">
                <Cpu />
                {t("toolbar.embeddingModels")}
              </Button>
              <Button onClick={openImportDialog} variant="outline">
                <Download />
                {t("toolbar.importRagflow")}
              </Button>
            </>
          ) : undefined
        }
      />

      <AgentMasterDetailWorkspace
        className="knowledge-workspace flex-1"
        index={
          <AgentKnowledgeDirectory
            items={items}
            selectedId={kbId}
            loading={loading}
            error={listError}
            canManage={canManage}
            onRetry={refresh}
            onSelect={handleSelect}
            onDelete={(item) => {
              setDeleteTarget(item);
              setConfirmOpen(true);
            }}
          />
        }
      >
        {!kbId ? (
          <div className="grid min-h-full place-items-center p-8 text-center">
            <div>
              <BookOpen className="mx-auto h-10 w-10 text-[#94a3b8]" />
              <p className="mt-4 text-sm font-medium text-[#475569]">{t("selectHint")}</p>
            </div>
          </div>
        ) : detailLoading ? (
          <div className="space-y-4 p-7" aria-busy="true">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-72 w-full" />
          </div>
        ) : detailError ? (
          <div className="grid min-h-full place-items-center p-8 text-center" role="alert">
            <div>
              <p className="text-sm font-medium text-red-600">{detailError}</p>
              <Button className="mt-4" variant="outline" onClick={() => kbId && runLoadDetail(kbId)}>
                <RefreshCw className="h-4 w-4" />
                {t("actions.retry")}
              </Button>
            </div>
          </div>
        ) : null}

        {/* ===== 详情视图 ===== */}
        {selectedDetail && (
          <div className="flex flex-col flex-1 min-h-0">
            {/* 加载中 */}
            {detailLoading && (
              <div className="flex items-center justify-center h-64">
                <div className="flex flex-col items-center gap-3">
                  <div className="h-10 w-10 rounded-full border-[3px] border-[#e2e8f0] border-t-[#1677ff] animate-spin shadow-sm" />
                  <p className="text-[13px] text-[#94a3b8]">{t("detail.loading")}</p>
                </div>
              </div>
            )}

            {!detailLoading && (
              <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                <div className="knowledge-detail">
                  <section className="knowledge-detail-header">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={`size-2 rounded-full ${getStatusDot(selectedDetail.status)}`} />
                          <h2 className="truncate text-xl font-semibold text-[#17233a]">{selectedDetail.name}</h2>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${getStatusBadge(selectedDetail.status)}`}
                          >
                            {t(`status.${selectedDetail.status}`, { defaultValue: selectedDetail.status })}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[11px] text-[#94a3b8]">{selectedDetail.slug}</p>
                        {selectedDetail.description && (
                          <p className="mt-2 max-w-3xl text-[13px] leading-5 text-[#64748b]">
                            {selectedDetail.description}
                          </p>
                        )}
                        <div className="mt-3 flex flex-wrap items-center gap-3 text-[12px] text-[#64748b]">
                          <span className="inline-flex items-center gap-1.5">
                            <File className="size-3.5" />
                            {t("card.resourcesUnit", { count: selectedDetail.resourcesCount })}
                          </span>
                          {selectedDetail.bindingsCount > 0 && (
                            <span className="inline-flex items-center gap-1.5">
                              <Braces className="size-3.5" />
                              {t("detail.boundAgents", { count: selectedDetail.bindingsCount })}
                            </span>
                          )}
                          {selectedDetail.remoteId && (
                            <span className="inline-flex min-w-0 items-center gap-1.5 text-[#94a3b8]">
                              <Globe className="size-3.5 shrink-0" />
                              <span className="truncate">Remote ID: {selectedDetail.remoteId}</span>
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Button size="sm" variant="outline" disabled={!canManageDetail} onClick={openEditDialog}>
                          {t("btn.edit")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-red-500 hover:bg-red-50 hover:text-red-600"
                          disabled={!canManageDetail}
                          onClick={() => {
                            const found = items.find((i) => i.id === kbId);
                            setDeleteTarget(found ?? null);
                            setConfirmOpen(true);
                          }}
                        >
                          {t("btn.delete")}
                        </Button>
                      </div>
                    </div>
                    <div className="knowledge-detail-summary">
                      <ConfigItem
                        icon={<Cpu className="size-4 text-[#4f7edb]" />}
                        label={t("detailConfig.embeddingModel")}
                      >
                        {selectedDetail.embeddingModel ?? t("detailConfig.notSet")}
                      </ConfigItem>
                      <ConfigItem
                        icon={<Layers className="size-4 text-[#6f72d9]" />}
                        label={t("detailConfig.parseMethod")}
                      >
                        {parseMethodLabel(selectedDetail.parseMethod)}
                      </ConfigItem>
                      <ConfigItem
                        icon={<Scissors className="size-4 text-[#23a67a]" />}
                        label={t("detailConfig.chunkMethod")}
                      >
                        {chunkMethodLabel(selectedDetail.chunkMethod)}
                      </ConfigItem>
                    </div>
                  </section>

                  {/* Tab 切换：文档 | 检索测试 */}
                  <Tabs
                    value={detailTab}
                    onValueChange={(v) => setDetailTab(v as "documents" | "graph" | "retrieval")}
                    className="knowledge-tabs"
                  >
                    <TabsList>
                      <TabsTrigger value="documents">{t("tabs.documents")}</TabsTrigger>
                      <TabsTrigger value="graph">{t("tabs.graph")}</TabsTrigger>
                      <TabsTrigger value="retrieval">{t("tabs.retrievalTest")}</TabsTrigger>
                    </TabsList>

                    <TabsContent value="documents" className="flex flex-col flex-1 min-h-0 space-y-6">
                      <AgentKnowledgeResources
                        resources={resources}
                        canManage={canManageDetail}
                        uploading={uploading}
                        deletingResourceId={deletingResourceId}
                        reparsingResourceId={reparsingResourceId}
                        fileInputRef={fileInputRef}
                        onFilesSelected={(files) => {
                          if (!kbId) return;
                          const formData = new FormData();
                          for (const file of files) formData.append("files", file);
                          const existingNames = new Set(resources.map((resource) => resource.sourceName));
                          const dupNames = files.map((file) => file.name).filter((name) => existingNames.has(name));
                          if (dupNames.length > 0) {
                            pendingOverwriteRef.current = { kbId, formData, dupNames };
                            setOverwriteConfirmOpen(true);
                            if (fileInputRef.current) fileInputRef.current.value = "";
                            return;
                          }
                          runUpload(kbId, formData);
                        }}
                        onOpenChunks={setSelectedChunkResource}
                        onToggleEnabled={(resource, enabled) => {
                          if (!kbId) return;
                          kbApi
                            .toggleResourceEnabled({ kbId, resourceId: resource.id }, { enabled })
                            .then(() => runLoadDetail(kbId))
                            .catch((error) => {
                              toast.error(`操作失败: ${error instanceof Error ? error.message : "未知错误"}`);
                              runLoadDetail(kbId);
                            });
                        }}
                        onReparse={(resource) => {
                          setReparseDeleteOld(false);
                          setReparseTarget(resource);
                          setReparseConfirmOpen(true);
                        }}
                        onPreview={setPreviewResource}
                        onDelete={(resource) => {
                          if (!kbId) return;
                          setResourceDeleteTarget({ kbId, resourceId: resource.id, name: resource.sourceName });
                          setResourceDeleteConfirmOpen(true);
                        }}
                      />
                    </TabsContent>

                    <TabsContent value="graph" forceMount className="data-[state=inactive]:hidden">
                      {detailTab === "graph" && selectedDetail && (
                        <div className="rounded-2xl bg-white p-6 shadow-sm ring-1 ring-inset ring-[#e8edf4]/80">
                          <KnowledgeGraphPanel knowledgeBaseId={selectedDetail.id} canManage={canManageDetail} />
                        </div>
                      )}
                    </TabsContent>

                    {/* 检索测试 Tab — 仅在切换到此 tab 时挂载 */}
                    <TabsContent value="retrieval" forceMount className="data-[state=inactive]:hidden">
                      {detailTab === "retrieval" && selectedDetail && (
                        <RetrievalTestPanel knowledgeBaseId={selectedDetail.id} />
                      )}
                    </TabsContent>
                  </Tabs>
                </div>
              </div>
            )}
          </div>
        )}
      </AgentMasterDetailWorkspace>

      {/* 向量模型管理弹窗 */}
      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="knowledge-model-dialog">
          <DialogHeader className="knowledge-model-dialog__header">
            <DialogTitle className="knowledge-model-dialog__title">
              <span className="knowledge-model-dialog__icon">
                <Cpu />
              </span>
              {t("toolbar.embeddingModelManager")}
            </DialogTitle>
            <DialogDescription>{t("toolbar.embeddingModelDescription")}</DialogDescription>
          </DialogHeader>
          <div className="knowledge-model-dialog__body">
            <EmbeddingModelManager canManage={canManage} inDialog onModelsChanged={refreshFormOptions} />
          </div>
        </DialogContent>
      </Dialog>

      {/* ===== 创建/编辑弹窗 ===== */}
      <FormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title={editingItem ? t("dialog.editTitle") : t("dialog.createTitle")}
        onSubmit={async () => {
          if (!formName.trim()) {
            toast.error(t("validation.nameRequired"));
            return;
          }
          const name = formName.trim();
          const description = formDescription.trim() || undefined;
          if (editingItem) {
            // 编辑模式：仅 name/description 可改，配置字段创建时已锁定
            runUpdate(editingItem.id, { name, description });
            return;
          }
          // 创建模式：透传嵌入模型 / 解析方法 / 分块方法
          const embeddingModel = formEmbeddingModel || null;
          if (!embeddingModel) {
            toast.error(t("validation.embeddingModelRequired"));
            return;
          }
          // 前端校验：嵌入模型必须含 @（RagFlow v0.26 要求 model@provider 格式）
          if (!embeddingModel.includes("@")) {
            toast.error(t("validation.embeddingModelFormat") || "向量模型格式不对，必须包含@");
            return;
          }
          const slug = name
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "");
          runCreate({
            name,
            slug,
            description,
            embeddingModel,
            parseMethod: formParseMethod,
            pipelineId: formParseMethod === "pipeline" ? formPipeline || null : null,
            chunkMethod: formParseMethod === "builtin" ? formChunkMethod || null : null,
          });
        }}
        loading={saving}
      >
        <div className="space-y-4">
          {/* 名称 */}
          <FieldGroup required label={t("form.name")} hint={t("form.nameHint")}>
            <Input
              value={formName}
              onChange={(e) => setFormName(e.target.value)}
              placeholder={t("form.namePlaceholder")}
              autoFocus
              className="h-10"
            />
          </FieldGroup>

          {/* 描述 */}
          <FieldGroup label={t("form.description")} hint={t("form.descriptionHint")}>
            <Textarea
              value={formDescription}
              onChange={(e) => setFormDescription(e.target.value)}
              placeholder={t("form.descriptionPlaceholder")}
              className="min-h-[72px] resize-none"
            />
          </FieldGroup>

          {/* 解析配置（仅创建模式） */}
          {!editingItem && (
            <>
              <p className="text-[12px] text-[#94a3b8]">{t("form.configLockedAfterCreate")}</p>

              {/* 嵌入模型 */}
              <FieldGroup label={t("form.embeddingModel")} hint={t("form.embeddingModelHint")} required>
                <Select
                  value={formEmbeddingModel}
                  onValueChange={setFormEmbeddingModel}
                  disabled={(options?.embeddingModels?.length ?? 0) === 0}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue placeholder={t("form.embeddingModelPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-[320px]">
                    {(() => {
                      const models = options?.embeddingModels ?? [];
                      const grouped = new Map<string, Map<string, typeof models>>();
                      for (const m of models) {
                        const prov = m.provider || "Unknown";
                        const inst = m.instance || "default";
                        if (!grouped.has(prov)) grouped.set(prov, new Map());
                        const instMap = grouped.get(prov)!;
                        if (!instMap.has(inst)) instMap.set(inst, []);
                        instMap.get(inst)!.push(m);
                      }
                      const providers = Array.from(grouped.entries());
                      return providers.length === 0 ? (
                        <div className="px-2 py-4 text-center text-[13px] text-muted-foreground">
                          {t("form.noEmbeddingModels")}
                        </div>
                      ) : (
                        providers.map(([provider, instMap], providerIdx) => (
                          <SelectGroup key={provider}>
                            <SelectLabel
                              className={
                                "px-2 text-[11px] font-semibold uppercase tracking-wider text-[#64748b]" +
                                (providerIdx > 0 ? " mt-1 border-t border-[#eef2f8] pt-2.5" : "")
                              }
                            >
                              {provider}
                            </SelectLabel>
                            {Array.from(instMap.entries()).map(([instance, items]) => (
                              <Fragment key={instance}>
                                <SelectLabel className="pl-5 text-[11px] font-medium text-[#94a3b8]">
                                  {instance}
                                </SelectLabel>
                                {items.map((m) => (
                                  <SelectItem key={m.name} value={m.name} className="pl-8 text-[13px]">
                                    {m.name.split("@")[0] || m.name}
                                  </SelectItem>
                                ))}
                              </Fragment>
                            ))}
                          </SelectGroup>
                        ))
                      );
                    })()}
                  </SelectContent>
                </Select>
              </FieldGroup>

              {/* 解析方法 */}
              <FieldGroup label={t("form.parseMethod")} hint={t("form.parseMethodHint")}>
                <div className="flex gap-6">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md text-[13px] text-foreground select-none">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="builtin"
                      checked={formParseMethod === "builtin"}
                      onChange={() => setFormParseMethod("builtin")}
                      className="h-4 w-4 accent-[#1677ff]"
                    />
                    {t("form.parseMethodBuiltin")}
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md text-[13px] text-foreground select-none">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="pipeline"
                      checked={formParseMethod === "pipeline"}
                      onChange={() => setFormParseMethod("pipeline")}
                      className="h-4 w-4 accent-[#1677ff]"
                    />
                    {t("form.parseMethodPipeline")}
                  </label>
                </div>
              </FieldGroup>

              {/* 内置分块方法 */}
              {formParseMethod === "builtin" && (
                <FieldGroup required label={t("form.chunkMethod")} hint={t("form.chunkMethodHint")}>
                  <Select value={formChunkMethod} onValueChange={setFormChunkMethod}>
                    <SelectTrigger className="h-10 w-full">
                      <SelectValue placeholder={t("form.chunkMethodPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(options?.chunkMethods ?? []).map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label ?? t(c.labelKey ?? "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldGroup>
              )}

              {/* Pipeline 选择 */}
              {formParseMethod === "pipeline" && (
                <FieldGroup label={t("form.pipeline")} hint={t("form.pipelineHint")}>
                  {(options?.pipelines?.length ?? 0) === 0 ? (
                    <div className="rounded-xl border border-dashed border-[#cbd5e1] bg-[#f8fafc] px-5 py-5 text-center shadow-sm">
                      <p className="text-[13px] font-medium text-[#64748b]">{t("form.noPipelines")}</p>
                      <p className="mt-1 text-[12px] text-[#94a3b8]">{t("form.noPipelinesHint")}</p>
                    </div>
                  ) : (
                    <Select value={formPipeline} onValueChange={setFormPipeline}>
                      <SelectTrigger className="h-10 w-full">
                        <SelectValue placeholder={t("form.pipelinePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {(options?.pipelines ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FieldGroup>
              )}
            </>
          )}
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

      {/* 资源删除确认 */}
      <ConfirmDialog
        open={resourceDeleteConfirmOpen}
        onOpenChange={setResourceDeleteConfirmOpen}
        title={t("confirm.deleteResourceTitle")}
        description={t("confirm.deleteResourceDescription", { name: resourceDeleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={() => {
          if (resourceDeleteTarget) {
            setDeletingResourceId(resourceDeleteTarget.resourceId);
            runDeleteResource(resourceDeleteTarget.kbId, resourceDeleteTarget.resourceId);
          }
        }}
      />

      {/* 同名文件覆盖确认 */}
      <ConfirmDialog
        open={overwriteConfirmOpen}
        onOpenChange={setOverwriteConfirmOpen}
        title="覆盖同名文件"
        description={`以下文件已存在，上传将覆盖原有文件：\n${(pendingOverwriteRef.current?.dupNames ?? []).join("、")}`}
        onConfirm={() => {
          const pending = pendingOverwriteRef.current;
          if (pending) {
            runUpload(pending.kbId, pending.formData, true);
            pendingOverwriteRef.current = null;
          }
        }}
      />

      {/* 重新解析确认：checkbox 选择是否删除已有分块 */}
      <AlertDialog open={reparseConfirmOpen} onOpenChange={setReparseConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("reparse.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("reparse.confirmDescription", { name: reparseTarget?.sourceName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-2 py-2">
            <Checkbox
              id="reparse-delete"
              checked={reparseDeleteOld}
              onCheckedChange={(v) => setReparseDeleteOld(!!v)}
            />
            <label htmlFor="reparse-delete" className="text-[13px] cursor-pointer">
              {t("reparse.deleteCheckbox")}
            </label>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setReparseDeleteOld(false)}>{t("common:cancel")}</AlertDialogCancel>
            <Button
              onClick={() => {
                if (!reparseTarget || !kbId) return;
                setReparseConfirmOpen(false);
                setReparsingResourceId(reparseTarget.id);
                kbApi
                  .reparseResource({ kbId: kbId, resourceId: reparseTarget.id }, { delete: reparseDeleteOld })
                  .then(() => {
                    toast.success(t("reparse.started"));
                    reparseAndPoll(kbId, reparseTarget.id);
                    setReparseDeleteOld(false);
                  })
                  .catch((err) => {
                    toast.error(err instanceof Error ? err.message : t("reparse.failed"));
                    setReparsingResourceId(null);
                    setReparseDeleteOld(false);
                  });
              }}
            >
              {t("reparse.startBtn")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {previewResource && kbId && (
        <ResourcePreviewDialog
          open={previewResource !== null}
          onOpenChange={(open) => {
            if (!open) setPreviewResource(null);
          }}
          resource={previewResource}
          kbId={kbId}
        />
      )}

      {/* 切片详情 Sheet */}
      {selectedChunkResource && kbId && (
        <ChunkDetailSheet
          open={selectedChunkResource !== null}
          onClose={() => setSelectedChunkResource(null)}
          kbId={kbId}
          resource={selectedChunkResource}
        />
      )}

      {/* ===== 导入知识库弹窗 ===== */}
      <Dialog open={importDialogOpen} onOpenChange={setImportDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>从 RAGFlow 导入知识库</DialogTitle>
            <DialogDescription>选择下方未关联的知识库导入到当前平台空间</DialogDescription>
          </DialogHeader>
          <div className="max-h-[400px] overflow-y-auto -mx-6 px-6">
            {importLoading ? (
              <div className="flex items-center justify-center py-16">
                <div className="flex flex-col items-center gap-3">
                  <div className="h-8 w-8 rounded-full border-[3px] border-[#e2e8f0] border-t-[#6366f1] animate-spin" />
                  <p className="text-[13px] text-[#94a3b8]">正在获取 RAGFlow 知识库列表...</p>
                </div>
              </div>
            ) : unassociatedList.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-4">
                <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#f1f5f9] to-[#e2e8f0] shadow-inner">
                  <BookOpen className="h-7 w-7 text-[#94a3b8]" />
                </div>
                <p className="text-[14px] font-medium text-[#64748b]">没有可导入的知识库</p>
                <p className="text-[12px] text-[#94a3b8] max-w-[300px] text-center">
                  RAGFlow 上暂无未关联的知识库，或所有知识库已在平台中关联
                </p>
              </div>
            ) : (
              <div className="space-y-2 py-2">
                {unassociatedList.map((ds) => (
                  <div
                    key={ds.id}
                    className="flex items-center justify-between rounded-xl border border-[#e2e8f0] bg-white px-4 py-3 transition-colors hover:border-[#6366f1]/30 hover:bg-[#f8f9ff]"
                  >
                    <div className="flex items-center gap-3 flex-1 min-w-0">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-50 to-violet-50 ring-1 ring-inset ring-[#6366f1]/10">
                        <BookOpen className="h-4 w-4 text-[#6366f1]" />
                      </div>
                      <span className="text-[14px] font-medium text-[#0f172a] break-all">{ds.name}</span>
                    </div>
                    <Button
                      size="sm"
                      disabled={importingRemoteId === ds.id}
                      onClick={() => {
                        setRenameTarget(ds);
                        setRenameValue(ds.name);
                        setRenameDialogOpen(true);
                      }}
                      className="h-8 gap-1.5 text-[12px] rounded-lg shrink-0 ml-3"
                    >
                      <Download className="h-3.5 w-3.5" />
                      导入
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* ===== 重命名导入弹窗 ===== */}
      <Dialog open={renameDialogOpen} onOpenChange={setRenameDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>导入知识库</DialogTitle>
            <DialogDescription>为知识库设置一个名称，方便在平台中识别</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-[13px] font-medium text-[#475569]">知识库名称</label>
              <Input
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && renameValue.trim()) {
                    handleImport(renameTarget!.id, renameValue.trim());
                  }
                }}
                placeholder="输入知识库名称"
                className="h-10 text-[14px]"
                autoFocus
                onFocus={(e) => e.target.select()}
              />
            </div>
            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => {
                  setRenameDialogOpen(false);
                  setRenameTarget(null);
                }}
                className="h-9 text-[13px] rounded-lg"
              >
                取消
              </Button>
              <Button
                disabled={importingRemoteId === renameTarget?.id || !renameValue.trim()}
                onClick={() => {
                  if (renameTarget && renameValue.trim()) {
                    handleImport(renameTarget.id, renameValue.trim());
                  }
                }}
                className="h-9 text-[13px] rounded-lg"
              >
                {importingRemoteId === renameTarget?.id ? (
                  <>
                    <div className="h-3.5 w-3.5 rounded-full border-2 border-white border-t-transparent animate-spin" />
                    导入中
                  </>
                ) : (
                  "确认导入"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}

/** 详情头部配置项：图标 + 标签 + 值 */
function ConfigItem({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-lg bg-[#f7f9fc] px-3 py-2.5">
      <div className="grid size-8 shrink-0 place-items-center rounded-md border border-[#e2e8f0] bg-white">{icon}</div>
      <div className="min-w-0">
        <div className="text-[10px] font-medium uppercase tracking-[0.06em] text-[#94a3b8]">{label}</div>
        <div className="mt-0.5 truncate text-[12px] font-medium text-[#334155]" title={String(children)}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ───────── 表单辅助组件 ─────────

/** 字段组：label + hint + children */
function FieldGroup({
  label,
  hint,
  required,
  icon,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon && <span className="shrink-0 text-[#1677ff]">{icon}</span>}
        <span className="text-[13px] font-semibold text-[#0f172a]">{label}</span>
        {required && <span className="text-[13px] text-red-500">*</span>}
      </div>
      {hint && <p className="mb-2 text-[12px] leading-relaxed text-[#94a3b8]">{hint}</p>}
      {children}
    </div>
  );
}

/** 解析方法卡片选择器 */
