import { useRequest } from "ahooks";
import {
  BookOpen,
  Braces,
  ChevronLeft,
  Cpu,
  Download,
  ExternalLink,
  File,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Globe,
  Layers,
  Plus,
  Presentation,
  RefreshCw,
  Scissors,
  Search,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useEffect, useRef, useState } from "react";
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
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { kbApi } from "@/src/api/knowledge-bases";
import { orgApi } from "@/src/api/organizations";
import { ragflowKeyApi } from "@/src/api/ragflow-key";
import { unwrap } from "@/src/api/request";
import { NS } from "@/src/i18n";
import { ChunkDetailSheet } from "@/src/pages/agent-panel/components/ChunkDetailSheet";
import { EmbeddingModelManager } from "@/src/pages/agent-panel/components/EmbeddingModelManager";
import { KnowledgeGraphPanel } from "@/src/pages/agent-panel/components/KnowledgeGraphPanel";
import { RetrievalTestPanel } from "@/src/pages/agent-panel/components/RetrievalTestPanel";
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

/** 系统管理员邮箱，与后端 isSystemAdmin 判断一致 */
const SYSTEM_ADMIN_EMAIL = "admin@fenix.com";

function formatTimestamp(timestamp: number | null | undefined): string {
  if (!timestamp) return "—";
  return new Date(timestamp * 1000).toLocaleString();
}

/** 根据文件扩展名返回对应的 lucide 图标组件 */
function getFileIcon(filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"].includes(ext))
    return <FileImage className="h-4 w-4 text-blue-500" />;
  if (["pdf"].includes(ext)) return <FileText className="h-4 w-4 text-red-500" />;
  if (["docx", "doc"].includes(ext)) return <FileText className="h-4 w-4 text-blue-600" />;
  if (["xlsx", "xls", "csv"].includes(ext)) return <FileSpreadsheet className="h-4 w-4 text-green-600" />;
  if (["pptx", "ppt"].includes(ext)) return <Presentation className="h-4 w-4 text-orange-500" />;
  if (["md", "markdown", "txt", "json", "xml", "yaml", "yml", "log", "env"].includes(ext))
    return <FileCode className="h-4 w-4 text-gray-500" />;
  if (["html", "htm", "js", "ts", "tsx", "jsx", "css", "py", "go", "rs", "sh", "sql"].includes(ext))
    return <FileCode className="h-4 w-4 text-purple-500" />;
  return <File className="h-4 w-4 text-text-muted" />;
}

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

/**
 * 头像配色板：浅底 + 深字，适配浅色主题。
 * 不同知识库按名称 hash 分配稳定颜色，避免每次渲染抖动。
 */
const AVATAR_COLORS = [
  "bg-blue-50 text-blue-600",
  "bg-emerald-50 text-emerald-600",
  "bg-violet-50 text-violet-600",
  "bg-amber-50 text-amber-600",
  "bg-rose-50 text-rose-600",
  "bg-cyan-50 text-cyan-600",
  "bg-indigo-50 text-indigo-600",
  "bg-orange-50 text-orange-600",
];

/** 根据名称稳定地取一个头像配色（bg + text 组合类名） */
function pickAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  }
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

/** 取名称首字符作为头像文字（支持中英文，统一取第一个码点） */
function getInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = Array.from(trimmed)[0] ?? "?";
  return first.toUpperCase();
}

interface KbCardProps {
  kb: KnowledgeBaseInfo;
  onClick: () => void;
  onDelete?: () => void;
}

function KbCard({ kb, onClick, onDelete }: KbCardProps) {
  const isDeleted = kb.remoteExists === false;
  const isKeyMissing = false;
  const isDisabled = isDeleted || isKeyMissing;
  const color = pickAvatarColor(kb.name);
  // 从头像颜色类名中提取色相用于顶部装饰条
  const baseColor = color.split(" ")[0]?.replace("bg-", "").replace("-50", "") ?? "blue";
  const accentMap: Record<string, string> = {
    blue: "from-blue-400 to-indigo-500",
    emerald: "from-emerald-400 to-teal-500",
    violet: "from-violet-400 to-purple-500",
    amber: "from-amber-400 to-orange-500",
    rose: "from-rose-400 to-pink-500",
    cyan: "from-cyan-400 to-sky-500",
    indigo: "from-indigo-400 to-blue-500",
    orange: "from-orange-400 to-red-500",
  };
  const accentGradient = accentMap[baseColor] ?? "from-blue-400 to-indigo-500";
  return (
    <button
      type="button"
      onClick={isDisabled ? undefined : onClick}
      className={`group relative flex w-full flex-col rounded-2xl bg-white text-left shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] ring-1 ring-inset ring-[#e8edf4]/80 transition-all duration-300 overflow-hidden ${
        isDisabled
          ? "cursor-not-allowed"
          : "hover:shadow-[0_1px_3px_rgba(0,0,0,0.06),0_12px_28px_rgba(0,0,0,0.06)] hover:-translate-y-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#6366f1]/40"
      }`}
    >
      <div className={isDisabled ? "opacity-50" : ""}>
        {/* 顶部彩色装饰条 */}
        <div
          className={`h-1 w-full bg-gradient-to-r ${isDisabled ? "from-gray-300 to-gray-400" : accentGradient} opacity-80 ${isDisabled ? "" : "group-hover:opacity-100"} transition-opacity`}
        />
        {/* 已删除角标 — 右上角黄色警告 */}
        {isDeleted && (
          <div className="absolute top-3 right-3 z-10 inline-flex items-center gap-1 rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-bold text-amber-700 ring-1 ring-amber-300 shadow-sm">
            ⚠️ RAGFlow 端已删除
          </div>
        )}
        {/* Key 未配置角标 — 右上角红色警告 */}
        {isKeyMissing && !isDeleted && (
          <div className="absolute top-3 right-3 z-10 inline-flex items-center gap-1 rounded-full bg-red-50 px-2.5 py-0.5 text-[10px] font-bold text-red-700 ring-1 ring-red-300 shadow-sm">
            🔑 个人 Key 未配置
          </div>
        )}
        <div className="flex w-full items-center gap-4 p-5 pt-4">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl text-[20px] font-bold bg-gradient-to-br from-${baseColor}-100 to-${baseColor}-50 ${color.split(" ")[1]} shadow-sm ring-1 ring-black/5`}
          >
            {getInitial(kb.name)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3
                className={`truncate text-[15px] font-semibold text-[#0f172a] ${isDisabled ? "" : "group-hover:text-[#6366f1]"} transition-colors duration-200`}
              >
                {kb.name}
              </h3>
              <span
                className={`inline-block h-2 w-2 shrink-0 rounded-full ${getStatusDot(kb.status)} ring-2 ring-white`}
              />
            </div>
            {kb.description && (
              <p className="mt-1 line-clamp-1 text-[12px] leading-relaxed text-[#94a3b8]">{kb.description}</p>
            )}
            <div className="mt-3 flex items-center gap-3 text-[11px] text-[#94a3b8]">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#f1f5f9] px-2.5 py-1 text-[#64748b]">
                <File className="h-3 w-3" />
                {kb.resourcesCount}
              </span>
              <span>{formatTimestamp(kb.updatedAt)}</span>
            </div>
          </div>
        </div>
      </div>
      {/* 已删除的卡片：底部显示清除按钮 */}
      {isDeleted && onDelete && (
        <div className="flex justify-end border-t border-gray-100 px-5 py-2.5">
          <Button
            size="xs"
            variant="ghost"
            className="h-7 gap-1 text-[11px] text-red-500 hover:bg-red-50 rounded-md"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <Trash2 className="h-3 w-3" />
            清除记录
          </Button>
        </div>
      )}
    </button>
  );
}

export function AgentKnowledgeBasesPage() {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const { data: session } = useSession();
  const { role: orgRole } = useOrg();

  // 从 URL search param 读取 kbId（支持浏览器前进后退及直接访问带 kbId 的 URL）
  const [kbId, setKbId] = useState<string | null>(
    () => new URLSearchParams(window.location.search).get("kbId") ?? null,
  );

  // 监听浏览器前进后退，同步 kbId
  useEffect(() => {
    const onPopState = () => setKbId(new URLSearchParams(window.location.search).get("kbId") ?? null);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const pushKbId = (id: string | null) => {
    const url = new URL(window.location.href);
    if (id) {
      url.searchParams.set("kbId", id);
    } else {
      url.searchParams.delete("kbId");
    }
    window.history.pushState(null, "", url.toString());
    setKbId(id);
  };

  const fileInputRef = useRef<HTMLInputElement>(null);
  const isSystemAdmin = session?.user?.email === SYSTEM_ADMIN_EMAIL;
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
  const [detailTab, setDetailTab] = useState<"documents" | "retrieval">("documents");
  const [mainTab] = useState<"global" | "org" | "personal">("global");
  const [modelDialogOpen, setModelDialogOpen] = useState(false);
  const [_formKeySource, _setFormKeySource] = useState<string>("global");
  const [showGraphPanel, setShowGraphPanel] = useState(false);
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
  const [searchQuery, setSearchQuery] = useState("");
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
  // 切换 tab 时关闭导入对话框，避免数据错乱
  useEffect(() => {
    setImportDialogOpen(false);
  }, []);
  const items: KnowledgeBaseInfo[] = Array.isArray(listData) ? (listData as unknown as KnowledgeBaseInfo[]) : [];
  const tabItems: Record<string, KnowledgeBaseInfo[]> = {
    global: Array.isArray(listData) ? (listData as unknown as KnowledgeBaseInfo[]) : [],
    org: [],
    personal: [],
  };

  // 当前 tab 对应的 keySource
  const activeKeySource = "global";

  // 创建表单可选项（嵌入模型、分块方法、pipeline）；失败不阻断表单。按 activeKeySource 拉取对应租户的模型列表
  const { data: formOptions } = useRequest(() => unwrap(kbApi.getFormOptions(activeKeySource)), {
    refreshDeps: [activeKeySource],
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

  // kbId 变化时自动加载/清除详情（支持浏览器前进后退及直接访问带 kbId 的 URL）
  useEffect(() => {
    if (kbId) {
      setDetailTab("documents");
      runLoadDetail(kbId);
    } else {
      setSelectedDetail(null);
      setResources([]);
    }
  }, [kbId, runLoadDetail]); // eslint-disable-line react-hooks/exhaustive-deps

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
        const hasRunning = resList.some((r) => r.runStatus === "RUNNING" || r.runStatus === "UNSTART");
        if (target && (target.runStatus === "DONE" || target.runStatus === "FAIL")) {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
          setReparsingResourceId(null);
          runLoadDetail(kbId);
          return;
        }
        // 所有资源都已完成处理后停止轮询（兜底）
        if (!hasRunning || ticks > 150) {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
          setReparsingResourceId(null);
          runLoadDetail(kbId);
        }
      } catch {
        if (pollingRef.current) clearInterval(pollingRef.current);
        pollingRef.current = null;
        setReparsingResourceId(null);
      }
    }, 2000);
  };

  // 搜索过滤
  const _filteredItems = items.filter((kb) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return (
      kb.name.toLowerCase().includes(q) ||
      (kb.slug?.toLowerCase().includes(q) ?? false) ||
      (kb.description?.toLowerCase().includes(q) ?? false)
    );
  });

  // 返回网格视图
  const handleBackToGrid = () => {
    pushKbId(null);
    setSelectedDetail(null);
    setResources([]);
    setDetailTab("documents");
    refresh();
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
    const ks = mainTab !== "personal" ? mainTab : "user";

    // org / user 必须先配 key
    if (ks === "org" || ks === "user") {
      try {
        const status =
          ks === "org" ? await unwrap(orgApi.getRagflowKeyStatus()) : await unwrap(ragflowKeyApi.getUserStatus());
        if (!status.configured) {
          toast.error(
            ks === "org"
              ? "组织尚未配置 RAGFlow API Key，请先在组织设置中配置后再创建知识库"
              : "尚未配置个人 RAGFlow API Key，请先在个人设置中配置后再创建知识库",
            { duration: 5000 },
          );
          return;
        }
      } catch (err) {
        toast.error(`无法检查 RAGFlow Key 状态: ${(err as Error).message}`);
        return;
      }
    }

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
    const ks = mainTab === "personal" ? "user" : mainTab;

    // org / user 必须先配 key，global 走环境变量无需检查
    if (ks === "org" || ks === "user") {
      try {
        const status =
          ks === "org" ? await unwrap(orgApi.getRagflowKeyStatus()) : await unwrap(ragflowKeyApi.getUserStatus());
        if (!status.configured) {
          toast.error(
            ks === "org"
              ? "组织尚未配置 RAGFlow API Key，请先在组织设置中配置后再导入知识库"
              : "尚未配置个人 RAGFlow API Key，请先在个人设置中配置后再导入知识库",
            { duration: 5000 },
          );
          return;
        }
      } catch (err) {
        toast.error(`无法检查 RAGFlow Key 状态: ${(err as Error).message}`);
        return;
      }
    }

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
    const _ks = mainTab === "personal" ? "user" : mainTab;
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
      <div className="min-h-full overflow-auto bg-[#f7f8fa] px-6 py-6 text-[#0f172a]">
        <div className="mb-8 flex items-end justify-between">
          <div>
            <Skeleton className="h-7 w-28 rounded-lg" />
            <Skeleton className="mt-2 h-3.5 w-56 rounded-md" />
          </div>
          <Skeleton className="h-10 w-[260px] rounded-xl" />
        </div>
        <div className="mb-6 h-px bg-gradient-to-r from-transparent via-[#e2e8f0] to-transparent" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
              key={i}
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
      </div>
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

  // 当前 tab 是否有创建/导入权限
  const canManage = isSystemAdmin || isOrgOwner;

  // 当前选中的知识库是否可管理（编辑/删除/上传/重新解析/启用等操作）
  const canManageDetail = selectedDetail ? isOrgOwner || selectedDetail.userId === session?.user?.id : false;

  return (
    <div
      className={
        selectedDetail
          ? "h-full flex flex-col overflow-hidden bg-[#f7f8fa] px-6 py-6 text-[#0f172a]"
          : "min-h-full overflow-auto bg-[#f7f8fa] px-6 py-6 text-[#0f172a]"
      }
    >
      {/* ===== 网格视图 ===== */}
      {!selectedDetail && (
        <>
          {/* 顶部栏：标题 + 搜索 + 新建按钮 */}
          <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-[26px] font-bold tracking-tight text-[#0f172a]">{t("title")}</h1>
              <p className="mt-1.5 text-[13px] text-[#94a3b8]">{t("subtitle")}</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94a3b8]" />
                <input
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t("searchPlaceholder")}
                  className="h-10 w-[260px] rounded-xl border border-[#e2e8f0] bg-white pl-10 pr-4 text-[13px] text-[#0f172a] shadow-sm outline-none transition-all duration-300 placeholder:text-[#a0aec0] focus:w-[320px] focus:border-[#6366f1] focus:ring-4 focus:ring-[#6366f1]/8 focus:shadow-md"
                />
              </div>
              {canManage && (
                <>
                  <Button
                    onClick={openCreateDialog}
                    className="h-10 gap-2 text-[13px] rounded-xl shadow-md shadow-[#6366f1]/20 bg-[#6366f1] hover:bg-[#5558e6] transition-all duration-200"
                  >
                    <Plus className="h-4 w-4" />
                    {t("btn.create")}
                  </Button>
                  <Button
                    onClick={() => setModelDialogOpen(true)}
                    variant="outline"
                    className="h-10 gap-2 text-[13px] rounded-xl border-[#6366f1] text-[#6366f1] hover:bg-[#eef0ff] transition-all duration-200"
                  >
                    <Cpu className="h-4 w-4" />
                    向量模型
                  </Button>
                  <Button
                    onClick={openImportDialog}
                    variant="outline"
                    className="h-10 gap-2 text-[13px] rounded-xl border-[#6366f1] text-[#6366f1] hover:bg-[#eef0ff] transition-all duration-200"
                  >
                    <Download className="h-4 w-4" />从 RAGFlow 导入
                  </Button>
                </>
              )}
            </div>
          </div>

          <div className="mb-6 h-px bg-gradient-to-r from-transparent via-[#e2e8f0] to-transparent" />

          {/* 三级 Tab：个人 / 组织 / 公共 */}
          <Tabs value="global">
            <TabsList className="mb-6" style={{ display: "none" }}>
              <TabsTrigger value="personal">个人知识库</TabsTrigger>
              <TabsTrigger value="org">组织知识库</TabsTrigger>
              <TabsTrigger value="global">公共知识库</TabsTrigger>
            </TabsList>

            {(["personal", "org", "global"] as const).map((tab) => {
              const currentItems = tabItems[tab].filter((kb) => {
                if (!searchQuery.trim()) return true;
                const q = searchQuery.toLowerCase();
                return (
                  kb.name.toLowerCase().includes(q) ||
                  (kb.slug?.toLowerCase().includes(q) ?? false) ||
                  (kb.description?.toLowerCase().includes(q) ?? false)
                );
              });

              return (
                <TabsContent key={tab} value={tab} className="space-y-6">
                  {currentItems.length === 0 ? (
                    <div className="flex flex-col items-center justify-center py-32 gap-5">
                      {searchQuery.trim() ? (
                        <>
                          <div className="flex h-24 w-24 items-center justify-center rounded-3xl bg-gradient-to-br from-[#f1f5f9] to-[#e2e8f0] shadow-inner">
                            <Search className="h-10 w-10 text-[#94a3b8]" />
                          </div>
                          <p className="text-[15px] font-medium text-[#64748b]">
                            {t("emptySearchMessage", { query: searchQuery })}
                          </p>
                          <button
                            type="button"
                            onClick={() => setSearchQuery("")}
                            className="text-[13px] font-medium text-[#6366f1] hover:underline underline-offset-4"
                          >
                            {t("emptyClearSearch")}
                          </button>
                        </>
                      ) : (
                        <>
                          <div className="flex h-28 w-28 items-center justify-center rounded-3xl bg-gradient-to-br from-indigo-50 via-blue-50 to-violet-50 shadow-inner ring-1 ring-[#6366f1]/10">
                            <BookOpen className="h-12 w-12 text-[#6366f1]/50" />
                          </div>
                          <p className="text-[17px] font-semibold text-[#334155]">{t("emptyTitle")}</p>
                          <p className="text-[14px] text-[#94a3b8] max-w-[400px] text-center leading-relaxed">
                            {t("emptyDescription")}
                          </p>
                          {canManage && (
                            <Button
                              onClick={openCreateDialog}
                              className="mt-3 h-11 gap-2 text-[14px] rounded-xl shadow-md shadow-[#6366f1]/20 bg-[#6366f1] hover:bg-[#5558e6]"
                            >
                              <Plus className="h-4 w-4" />
                              {t("emptyCreateBtn")}
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
                      {currentItems.map((kb) => (
                        <KbCard
                          key={kb.id}
                          kb={kb}
                          onClick={() => handleSelect(kb)}
                          onDelete={() => {
                            setDeleteTarget(kb);
                            setConfirmOpen(true);
                          }}
                        />
                      ))}
                    </div>
                  )}
                </TabsContent>
              );
            })}
          </Tabs>
        </>
      )}

      {/* 向量模型管理弹窗 */}
      <Dialog open={modelDialogOpen} onOpenChange={setModelDialogOpen}>
        <DialogContent className="sm:max-w-[1100px] w-[92vw] h-[82vh] flex flex-col p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-6 pt-6 pb-4 border-b border-[#eef2f6] shrink-0">
            <DialogTitle className="flex items-center gap-2 text-[18px]">
              <Cpu className="h-5 w-5 text-[#6366f1]" />
              向量模型管理
            </DialogTitle>
            <DialogDescription className="text-[12px]">
              管理 "全局" RAGFlow 租户下的向量模型。当前作用域：
              <span className="font-medium text-[#6366f1]">"全局"</span>
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 py-4">
            <EmbeddingModelManager canManage={canManage} inDialog />
          </div>
        </DialogContent>
      </Dialog>

      {/* ===== 详情视图 ===== */}
      {selectedDetail && (
        <div className="flex flex-col flex-1 min-h-0">
          {/* 返回按钮 + 标题 */}
          <div className="mb-5 flex items-center justify-between">
            <button
              type="button"
              onClick={handleBackToGrid}
              className="inline-flex items-center gap-1.5 text-[13px] font-medium text-[#64748b] hover:text-[#0f172a] transition-all duration-150 rounded-lg px-2.5 py-1.5 -ml-2.5 hover:bg-[#f1f5f9]"
            >
              <ChevronLeft className="h-4 w-4" />
              <span>返回知识库列表</span>
            </button>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={!canManageDetail}
                onClick={openEditDialog}
                className="h-8 text-[12px] rounded-lg"
              >
                {t("btn.edit")}
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={!canManageDetail}
                onClick={() => {
                  const found = items.find((i) => i.id === kbId);
                  setDeleteTarget(found ?? null);
                  setConfirmOpen(true);
                }}
                className="h-8 text-[12px] rounded-lg"
              >
                {t("btn.delete")}
              </Button>
            </div>
          </div>

          <div className="h-px bg-gradient-to-r from-transparent via-[#e2e8f0] to-transparent mb-5" />

          {/* 加载中 */}
          {detailLoading && (
            <div className="flex items-center justify-center h-64">
              <div className="flex flex-col items-center gap-3">
                <div className="h-10 w-10 rounded-full border-[3px] border-[#e2e8f0] border-t-[#1677ff] animate-spin shadow-sm" />
                <p className="text-[13px] text-[#94a3b8]">Loading...</p>
              </div>
            </div>
          )}

          {!detailLoading && (
            <div className="max-w-[960px] mx-auto space-y-6 flex flex-col flex-1 min-h-0">
              {/* 详情头部卡片：头像 + 名称 + 元数据 + 配置 */}
              <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.04)] ring-1 ring-inset ring-[#e8edf4]/80 overflow-hidden">
                {/* 顶部渐变装饰条 */}
                <div className="h-1.5 w-full bg-gradient-to-r from-indigo-400 via-violet-400 to-purple-400" />
                <div className="p-7 relative">
                  {/* 右上角知识图谱魔法棒按钮 */}
                  <button
                    type="button"
                    className="absolute top-7 right-7 inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-[12px] font-semibold bg-[#f0f4ff] text-[#6366f1] hover:bg-[#e4eaff] border border-[#d4dafc] transition-all duration-150 shadow-sm hover:shadow-md"
                    onClick={() => setShowGraphPanel(!showGraphPanel)}
                    title={showGraphPanel ? "收起知识图谱" : t("retrieval.knowledgeGraphSection")}
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {showGraphPanel ? "收起知识图谱" : t("retrieval.knowledgeGraphSection")}
                  </button>
                  <div className="flex items-start gap-5">
                    {/* 头像 */}
                    <div
                      className={`flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl text-[22px] font-bold bg-gradient-to-br ${pickAvatarColor(
                        selectedDetail.name,
                      ).replace(
                        /bg-(\w+)-\d+ text-(\w+)-\d+/,
                        "from-$1-100 to-$1-200 text-$2-600",
                      )} shadow-sm ring-1 ring-black/5`}
                    >
                      {getInitial(selectedDetail.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2.5">
                        <h2 className="text-[22px] font-bold text-[#0f172a] truncate">{selectedDetail.name}</h2>
                        <span
                          className={`inline-block h-2.5 w-2.5 rounded-full ${getStatusDot(selectedDetail.status)} ring-2 ring-white`}
                        />
                      </div>
                      <p className="text-[12px] text-[#94a3b8] font-mono mt-0.5">{selectedDetail.slug}</p>
                      {selectedDetail.description && (
                        <p className="mt-3 text-[13px] text-[#475569] leading-relaxed max-w-[640px]">
                          {selectedDetail.description}
                        </p>
                      )}
                      <div className="flex items-center gap-4 mt-4">
                        <span
                          className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold tracking-wide uppercase shadow-sm ${getStatusBadge(
                            selectedDetail.status,
                          )}`}
                        >
                          {selectedDetail.status}
                        </span>
                        <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#64748b] rounded-full bg-[#f1f5f9] px-3 py-1">
                          <File className="h-3.5 w-3.5" />
                          {t("card.resourcesUnit", { count: selectedDetail.resourcesCount })}
                        </span>
                        {selectedDetail.bindingsCount > 0 && (
                          <span className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[#64748b] rounded-full bg-[#f1f5f9] px-3 py-1">
                            <Braces className="h-3.5 w-3.5" />
                            {selectedDetail.bindingsCount} agent{selectedDetail.bindingsCount > 1 ? "s" : ""}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 创建时选定的配置（只读展示） */}
                  <div className="mt-6 grid grid-cols-1 sm:grid-cols-3 gap-5 border-t border-[#f0f3f8] pt-5">
                    <ConfigItem
                      icon={<Cpu className="h-4 w-4 text-[#6366f1]" />}
                      label={t("detailConfig.embeddingModel")}
                    >
                      {selectedDetail.embeddingModel ?? t("detailConfig.notSet")}
                    </ConfigItem>
                    <ConfigItem
                      icon={<Layers className="h-4 w-4 text-violet-500" />}
                      label={t("detailConfig.parseMethod")}
                    >
                      {parseMethodLabel(selectedDetail.parseMethod)}
                    </ConfigItem>
                    <ConfigItem
                      icon={<Scissors className="h-4 w-4 text-emerald-500" />}
                      label={t("detailConfig.chunkMethod")}
                    >
                      {chunkMethodLabel(selectedDetail.chunkMethod)}
                    </ConfigItem>
                  </div>
                </div>
              </div>

              {/* 知识图谱面板（点击魔法棒展开） */}
              {showGraphPanel && selectedDetail && (
                <div className="rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] ring-1 ring-inset ring-[#e8edf4]/80 p-6">
                  <KnowledgeGraphPanel
                    knowledgeBaseId={selectedDetail.id}
                    onCollapse={() => setShowGraphPanel(false)}
                  />
                </div>
              )}

              {/* Tab 切换：文档 | 检索测试 */}
              <Tabs
                value={detailTab}
                onValueChange={(v) => setDetailTab(v as "documents" | "retrieval")}
                className="flex flex-col flex-1 min-h-0 space-y-4"
              >
                <TabsList>
                  <TabsTrigger value="documents">{t("tabs.documents")}</TabsTrigger>
                  <TabsTrigger value="retrieval">{t("tabs.retrievalTest")}</TabsTrigger>
                </TabsList>

                <TabsContent value="documents" className="flex flex-col flex-1 min-h-0 space-y-6">
                  {/* 外部链接 */}
                  {selectedDetail.remoteId && (
                    <div className="rounded-xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04)] ring-1 ring-inset ring-[#e8edf4]/80 p-4">
                      <div className="flex items-center gap-2 text-[12px] text-[#64748b]">
                        <Globe className="h-3.5 w-3.5 text-[#6366f1]" />
                        <span>Remote ID: {selectedDetail.remoteId}</span>
                      </div>
                    </div>
                  )}

                  {/* 资源列表 — 表格形式 */}
                  <div className="flex flex-col flex-1 min-h-0 rounded-2xl bg-white shadow-[0_1px_3px_rgba(0,0,0,0.04),0_4px_12px_rgba(0,0,0,0.03)] ring-1 ring-inset ring-[#e8edf4]/80 overflow-hidden">
                    {/* 表头工具栏 */}
                    <div className="flex items-center justify-between px-6 py-4 border-b border-[#eef2f6]">
                      <h3 className="text-[14px] font-semibold text-[#0f172a]">
                        {t("resources.title", { count: resources.length })}
                      </h3>
                      <div className="flex items-center gap-2">
                        <input
                          ref={fileInputRef}
                          type="file"
                          multiple
                          onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0 && kbId) {
                              const filesArr = Array.from(e.target.files);
                              const formData = new FormData();
                              for (const file of filesArr) {
                                formData.append("files", file);
                              }
                              // 检查与现有资源的同名冲突
                              const existingNames = new Set(resources.map((r) => r.sourceName));
                              const dupNames = filesArr.map((f) => f.name).filter((n) => existingNames.has(n));
                              if (dupNames.length > 0) {
                                // 先存起来，弹窗确认后再上传
                                pendingOverwriteRef.current = { kbId: kbId, formData, dupNames };
                                setOverwriteConfirmOpen(true);
                                // 重置 input 值，否则第二次选同名文件不会触发 onChange
                                if (fileInputRef.current) fileInputRef.current.value = "";
                                return;
                              }
                              runUpload(kbId, formData);
                            }
                          }}
                          className="hidden"
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={uploading || !canManageDetail}
                          onClick={() => fileInputRef.current?.click()}
                          className="h-8 gap-1.5 text-[12px] rounded-lg border-[#e2e8f0] hover:border-[#6366f1] hover:text-[#6366f1] hover:bg-[#f0f4ff] transition-all duration-150"
                        >
                          <Upload className="h-3.5 w-3.5" />
                          {uploading ? t("btn.uploading") : t("btn.upload")}
                        </Button>
                      </div>
                    </div>

                    {/* 表头 */}
                    <div className="flex items-center gap-3 border-b border-[#eef2f6] bg-[#f8fafc] px-6 py-2.5 text-[10px] font-bold uppercase tracking-[0.08em] text-[#94a3b8]">
                      <div className="flex-[2] min-w-0">{t("columns.name")}</div>
                      <div className="w-[60px] shrink-0 text-center">{t("resources.colChunks")}</div>
                      <div className="w-[100px] shrink-0">{t("resources.colStatus")}</div>
                      <div className="w-[80px] shrink-0 text-center">{t("resources.colEnabled")}</div>
                      <div className="w-[130px] shrink-0">{t("columns.updatedAt")}</div>
                      <div className="w-[200px] shrink-0 text-right">{t("resources.colActions")}</div>
                    </div>

                    {/* 表格行 — 自动填充剩余空间并滚动 */}
                    <div className="divide-y divide-[#f0f3f8] flex-1 overflow-y-auto">
                      {resources.map((r) => (
                        <div
                          key={r.id}
                          className="group flex items-center gap-3 px-6 py-3.5 hover:bg-[#fafbfd] transition-all duration-150 border-l-[3px] border-l-transparent hover:border-l-[#6366f1]"
                        >
                          {/* 文件名 + 方法标签 — 点击文件名进入切片详情 */}
                          <div className="flex-[2] min-w-0 flex items-center gap-2.5">
                            <span className="shrink-0 flex h-8 w-8 items-center justify-center rounded-lg bg-[#f1f5f9] group-hover:bg-[#eef0ff] transition-colors">
                              {getFileIcon(r.sourceName)}
                            </span>
                            {r.chunkCount != null && r.chunkCount > 0 ? (
                              <button
                                type="button"
                                className="text-[13px] font-semibold text-[#0f172a] hover:text-[#6366f1] truncate transition-colors text-left"
                                onClick={() => {
                                  setPreviewResource(null);
                                  setSelectedChunkResource(r);
                                }}
                              >
                                {r.sourceName}
                              </button>
                            ) : (
                              <span className="text-[13px] font-semibold text-[#0f172a] truncate">{r.sourceName}</span>
                            )}
                          </div>

                          {/* 分块数 */}
                          <div className="w-[60px] shrink-0 text-center text-[12px] text-[#94a3b8]">
                            {r.chunkCount != null ? r.chunkCount : "—"}
                          </div>

                          {/* 状态 */}
                          <div className="w-[100px] shrink-0">
                            {r.runStatus === "RUNNING" && r.parseProgress != null ? (
                              <div className="flex items-center gap-1.5">
                                <div className="flex-1 h-1.5 rounded-full bg-[#eef2f8] overflow-hidden">
                                  <div
                                    className="h-full rounded-full bg-gradient-to-r from-[#1677ff] to-[#6366f1] shadow-[0_0_6px_rgba(99,102,241,0.3)] transition-all duration-500"
                                    style={{ width: `${Math.round(r.parseProgress * 100)}%` }}
                                  />
                                </div>
                                <span className="text-[10px] font-medium text-[#6366f1] shrink-0">
                                  {Math.round(r.parseProgress * 100)}%
                                </span>
                              </div>
                            ) : (
                              <span
                                className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${getStatusBadge(r.status)}`}
                              >
                                <span className={`inline-block h-1.5 w-1.5 rounded-full ${getStatusDot(r.status)}`} />
                                {r.status}
                              </span>
                            )}
                          </div>

                          {/* 启用 */}
                          <div className="w-[80px] shrink-0 flex justify-center">
                            <Switch
                              checked={r.enabled ?? true}
                              disabled={!canManageDetail}
                              onCheckedChange={(checked) => {
                                kbApi
                                  .toggleResourceEnabled({ kbId: kbId!, resourceId: r.id }, { enabled: checked })
                                  .then(() => runLoadDetail(kbId!))
                                  .catch((err) => {
                                    toast.error(`操作失败: ${err instanceof Error ? err.message : "未知错误"}`);
                                    runLoadDetail(kbId!);
                                  });
                              }}
                            />
                          </div>

                          {/* 更新时间 */}
                          <div className="w-[130px] shrink-0 text-[12px] text-[#94a3b8]">
                            {formatTimestamp(r.createdAt)}
                          </div>

                          {/* 操作 */}
                          <div className="w-[200px] shrink-0 flex items-center justify-end gap-2">
                            <Button
                              size="xs"
                              variant="outline"
                              className="h-7 gap-1 rounded-md border-[#dbe1ea] px-2 text-[11px] text-[#1677ff] hover:border-[#1677ff] hover:bg-[#e8f4ff] shrink-0"
                              disabled={!canManageDetail || reparsingResourceId === r.id}
                              onClick={() => {
                                setReparseDeleteOld(false);
                                setReparseTarget(r);
                                setReparseConfirmOpen(true);
                              }}
                            >
                              <RefreshCw className={`h-3 w-3 ${reparsingResourceId === r.id ? "animate-spin" : ""}`} />
                              {t("reparse.btn")}
                            </Button>
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              {r.status === "ready" && (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  className="h-7 w-7 p-0 text-[#94a3b8] hover:text-[#1677ff]"
                                  title={t("preview.btn")}
                                  onClick={() => {
                                    setSelectedChunkResource(null);
                                    setPreviewResource(r);
                                  }}
                                >
                                  <ExternalLink className="h-3.5 w-3.5" />
                                </Button>
                              )}
                              <Button
                                size="xs"
                                variant="ghost"
                                className="h-7 w-7 p-0 text-[#94a3b8] hover:text-red-500"
                                title={t("actions.delete")}
                                disabled={!canManageDetail || deletingResourceId === r.id}
                                onClick={() => {
                                  setResourceDeleteTarget({ kbId: kbId!, resourceId: r.id, name: r.sourceName });
                                  setResourceDeleteConfirmOpen(true);
                                }}
                              >
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                        </div>
                      ))}

                      {resources.length === 0 && (
                        <div className="flex flex-col items-center justify-center py-24 text-[#94a3b8] gap-5">
                          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-[#f1f5f9] to-[#e2e8f0] shadow-inner">
                            <File className="h-8 w-8 opacity-25" />
                          </div>
                          <p className="text-[14px] font-medium">{t("resources.empty")}</p>
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>

                {/* 检索测试 Tab — 仅在切换到此 tab 时挂载 */}
                <TabsContent value="retrieval" forceMount className="data-[state=inactive]:hidden">
                  {detailTab === "retrieval" && selectedDetail && (
                    <RetrievalTestPanel knowledgeBaseId={selectedDetail.id} />
                  )}
                </TabsContent>
              </Tabs>
            </div>
          )}
        </div>
      )}

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
          // 前端校验：嵌入模型必须含 @（RagFlow v0.26 要求 model@provider 格式）
          if (embeddingModel && !embeddingModel.includes("@")) {
            toast.error(t("validation.embeddingModelFormat") || "向量模型格式不对，必须包含@");
            return;
          }
          const slug = name
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, "-")
            .replace(/^-|-$/g, "");
          // Key always configured (hierarchy removed)
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

              {/* 知识库类型：仅全局（分层已移除） */}
              <FieldGroup required label="知识库类型">
                <Select value="global" disabled>
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="global">公共知识库</SelectItem>
                  </SelectContent>
                </Select>
              </FieldGroup>

              {/* 嵌入模型 */}
              <FieldGroup label={t("form.embeddingModel")} hint={t("form.embeddingModelHint")}>
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
            <DialogDescription>选择下方未关联的知识库导入到当前知识库空间</DialogDescription>
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
    </div>
  );
}

/** 详情头部配置项：图标 + 标签 + 值 */
function ConfigItem({ icon, label, children }: { icon: ReactNode; label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <div className="mt-0.5 shrink-0 flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-[#f1f5f9] to-[#f8fafc] ring-1 ring-inset ring-[#e2e8f0]/60">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-[11px] font-semibold text-[#94a3b8] uppercase tracking-[0.06em]">{label}</p>
        <p className="mt-0.5 text-[13px] font-semibold text-[#0f172a] truncate">{children}</p>
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
