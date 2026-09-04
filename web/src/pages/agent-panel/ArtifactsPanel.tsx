import { useRequest } from "ahooks";
import { Globe, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { envApi } from "@/src/api/environments";
import type { ProdViewModulesConfig } from "@/src/api/prod-views";
import { unwrap } from "@/src/api/request";
import { agentSitesApi, type SiteApp } from "@/src/api/sites";
import { ARTIFACTS_PREVIEW_FILE_EVENT, getArtifactsPreviewFileDetail } from "@/src/lib/artifacts-preview-events";
import { ArtifactsDialogs } from "../../components/agent-panel/artifacts-dialogs";
import { ArtifactsFilesWorkspace } from "../../components/agent-panel/artifacts-files-workspace";
import type { FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { normalizeToUserPath } from "../../components/agent-panel/preview/utils";
import { SiteFrame } from "../../components/agent-panel/SiteFrame";
import { SiteTabsBar } from "../../components/agent-panel/SiteTabsBar";
import { type TopMode, TopModeTabs } from "../../components/agent-panel/TopModeTabs";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";
import { ProdViewsPanel } from "./ProdViewsPanel";
import { TasksPanel } from "./TasksPanel";

/** 打开文件 tab 的 LRU 上限：超出时丢弃最旧（数组末尾）的，与 FileTabsBar 的 MAX_VISIBLE_TABS 解耦 */
const MAX_OPEN_FILES = 8;

interface ArtifactsPanelProps {
  envId: string | null;
  agentConfigId?: string | null;
  changedFiles?: ChangedFile[];
  /** ProdView 模块配置，控制面板 tab 的显示/隐藏 */
  modulesConfig?: ProdViewModulesConfig;
  /** 面板相对 Chat 的布局方式。窄屏由父级强制传入 floating。 */
  layoutMode?: "floating" | "docked";
  /** 窄屏不展示布局切换，避免提供不可执行的操作。 */
  canDock?: boolean;
  onLayoutModeChange?: (mode: "floating" | "docked") => void;
  onClose?: () => void;
}

/** Chat 右侧真实工作区；环境、Site 和文件状态均保持原有 API 数据流。 */
export function ArtifactsPanel({
  envId,
  agentConfigId: agentConfigIdProp,
  changedFiles = [],
  modulesConfig,
  layoutMode = "floating",
  canDock = true,
  onLayoutModeChange,
  onClose,
}: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  const [topMode, setTopMode] = useState<TopMode>("files");

  const availableModes = useMemo<TopMode[]>(() => {
    if (!modulesConfig) return ["files", "sites", "tasks", "views"];
    const modes: TopMode[] = [];
    if (modulesConfig.filesPanel?.enabled !== false) modes.push("files");
    if (modulesConfig.sitesPanel?.enabled !== false) modes.push("sites");
    if (modulesConfig.tasksPanel?.enabled !== false) modes.push("tasks");
    if (modulesConfig.viewsPanel?.enabled !== false) modes.push("views");
    return modes;
  }, [modulesConfig]);

  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  // 用户主动离开 Files 后不因后续 diff 打断当前浏览；切回 Files 时清零。
  const userPickedSiteRef = useRef(false);
  // 待展示的 diff 文件数：用户在 Sites 模式时累计，切回 Files 时清零
  const [pendingDiffCount, setPendingDiffCount] = useState(0);
  const configIdRef = useRef(agentConfigIdProp);
  configIdRef.current = agentConfigIdProp;

  const [mountDialogOpen, setMountDialogOpen] = useState(false);
  const [unmountConfirm, setUnmountConfirm] = useState<{ id: string; name: string } | null>(null);

  const { data: envData } = useRequest(() => unwrap(envApi.get({ id: envId! })), {
    ready: agentConfigIdProp == null && !!envId,
    onError: (err: unknown) => {
      console.warn("[ArtifactsPanel] 加载 environment 详情失败，Sites tab 不可用", err);
    },
  });
  const resolvedAgentConfigId = envData?.agentConfigId ?? null;
  const agentConfigId = agentConfigIdProp != null ? agentConfigIdProp : resolvedAgentConfigId;
  configIdRef.current = agentConfigId ?? undefined;

  const {
    run: loadSites,
    loading: sitesLoading,
    data: sites = [],
    error: sitesLoadError,
    mutate: setSites,
  } = useRequest(
    async (cfgId: string) => {
      const list = (await unwrap(agentSitesApi.listByAgentConfig(cfgId))) as SiteApp[];
      return (Array.isArray(list) ? list : [])
        .filter((item): item is SiteApp => !!item)
        .map((item) => ({
          id: item.id,
          name: item.name,
          remoteAppId: item.remoteAppId,
          createdByAgentConfigId: item.createdByAgentConfigId ?? null,
          createdByAgentConfigName: item.createdByAgentConfigName ?? null,
        }))
        .filter((item) => item.id && item.remoteAppId);
    },
    {
      manual: true,
      onError: (err: unknown) => {
        console.error("[ArtifactsPanel] 加载 agent 绑定 sites 失败", err);
      },
    },
  );

  const sitesRef = useRef(sites);
  sitesRef.current = sites;

  // ── useRequest：卸载 site mutation（manual） ──────────
  const { run: runUnmount, loading: unmounting } = useRequest(
    async (cfgId: string, siteId: string) => {
      await unwrap(agentSitesApi.unbindSite(cfgId, siteId));
    },
    {
      manual: true,
      onSuccess: (_data, params) => {
        const [, siteId] = params as [string, string];
        setUnmountConfirm(null);
        // 乐观更新：立即剔除已解绑 site，避免 loadSites 异步延迟期间
        // 旧 tab 残留（responsiveSiteId 派生自动回退到剩余 site 或 null）
        setSites((prev) => (prev ?? []).filter((s) => s.id !== siteId));
        // 后台确认：从 DB 拉最新列表，确保最终一致性
        if (agentConfigId) loadSites(agentConfigId);
      },
      onError: () => {
        toast.error(t("panelMode.unmountFailed"));
      },
    },
  );

  // ── useRequest：自动绑定的 mutation（manual） ─────────
  const { run: runBind, loading: binding } = useRequest(
    async (cfgId: string, siteId: string) => {
      await unwrap(agentSitesApi.bindSite(cfgId, siteId));
    },
    {
      manual: true,
      onSuccess: (_data, params) => {
        const [bindCfgId, bindSiteId] = params as [string, string];
        loadSites(bindCfgId);
        setTimeout(() => {
          const fresh = sitesRef.current.find((s) => s.remoteAppId === bindSiteId);
          setActiveSiteId(fresh?.id ?? null);
        }, 100);
      },
      onError: (err: unknown) => {
        console.error("[ArtifactsPanel] 自动挂载站点失败", err);
      },
    },
  );
  const bindingRef = useRef(binding);
  bindingRef.current = binding;

  // 监听 <agent-sites> 卡片点击事件：切到 Sites 模式并选中对应 site
  // 卡片组件触发 artifacts:select-site 时：
  // 1. 切到 Sites 模式
  // 2. 在已绑定的 sites 中按 remoteAppId 查找并选中
  // 3. 若未绑定：自动调用 bindSite 挂载（通过 runBind mutation hook），刷新列表后选中
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler 不重新注册，靠 ref 获取最新值
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { siteId: string };
      if (!detail?.siteId) return;

      const siteId = detail.siteId; // remoteAppId（如 "app-91a0621c"）
      const currentSites = sitesRef.current;
      const cfgId = configIdRef.current;

      setTopMode("sites");
      userPickedSiteRef.current = true;

      // 在已绑定的 sites 中按 remoteAppId 查找
      const matched = currentSites.find((s) => s.remoteAppId === siteId);
      if (matched) {
        setActiveSiteId(matched.id);
        return;
      }

      // 未绑定 → 自动挂载（并发锁由 useRequest loading 状态提供）
      if (!cfgId || bindingRef.current) return;
      runBind(cfgId, siteId);
    };
    window.addEventListener("artifacts:select-site", handler);
    return () => window.removeEventListener("artifacts:select-site", handler);
  }, []);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = getArtifactsPreviewFileDetail(event, envId);
      if (!detail) return;
      userPickedSiteRef.current = false;
      setPendingDiffCount(0);
      setTopMode("files");
      openFileRef.current?.(normalizeToUserPath(detail.path));
    };
    window.addEventListener(ARTIFACTS_PREVIEW_FILE_EVENT, handler);
    return () => window.removeEventListener(ARTIFACTS_PREVIEW_FILE_EVENT, handler);
  }, [envId]);

  const handleTopChange = useCallback(
    (next: TopMode) => {
      setTopMode(next);
      if (next === "files") {
        userPickedSiteRef.current = false;
        setPendingDiffCount(0);
      } else {
        userPickedSiteRef.current = true;
        // 进入 Sites 时若没选过 site，自动选第一个；已选过则保留（agent 切换会被 effect 清空）
        setActiveSiteId((cur) => cur ?? sites[0]?.id ?? null);
      }
    },
    [sites],
  );

  const handleSiteChange = useCallback((siteId: string) => {
    setActiveSiteId(siteId);
  }, []);

  const handleMount = useCallback(() => {
    if (!agentConfigId) return;
    setMountDialogOpen(true);
  }, [agentConfigId]);
  const handleMounted = useCallback(() => {
    setMountDialogOpen(false);
    if (agentConfigId) void loadSites(agentConfigId);
  }, [agentConfigId, loadSites]);
  const handleUnmountClick = useCallback(
    (siteId: string) => {
      const site = sites.find((s) => s.id === siteId);
      if (site) setUnmountConfirm({ id: site.id, name: site.name });
    },
    [sites],
  );

  useEffect(() => {
    setTopMode("files");
    setActiveSiteId(null);
    userPickedSiteRef.current = false;
    setPendingDiffCount(0);

    if (!agentConfigId) {
      setSites([]);
      return;
    }
    void loadSites(agentConfigId);
  }, [agentConfigId, loadSites, setSites]);

  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const fileTreeRef = useRef<FileTreeTabHandle>(null);
  const pendingUploadRef = useRef<File[]>([]);

  const openFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter((p) => p !== path);
      return [path, ...filtered].slice(0, MAX_OPEN_FILES);
    });
    setActiveFile(path);
  }, []);

  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;

  const normalizedChangedFiles = useMemo<ChangedFile[]>(
    () => changedFiles.map((f) => ({ ...f, path: normalizeToUserPath(f.path) })),
    [changedFiles],
  );

  // changedFiles 变化时：仅统计增量并更新 pendingDiffCount 角标，
  // 不再自动打开文件 tab（文件预览改为用户手动点击工具卡片的预览按钮触发）
  const prevChangedPathsRef = useRef<string[]>([]);
  useEffect(() => {
    const paths = normalizedChangedFiles.map((f) => f.path);
    if (paths.length === 0) return;

    // 计算增量：只统计本次新增的文件，避免总数被累加放大
    const prevPaths = prevChangedPathsRef.current;
    const newPaths = paths.filter((p) => !prevPaths.includes(p));
    prevChangedPathsRef.current = paths;

    if (userPickedSiteRef.current && newPaths.length > 0) {
      setPendingDiffCount((n) => n + newPaths.length);
    }
  }, [normalizedChangedFiles]);

  const handleCloseFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const next = prev.filter((p) => p !== path);
      setActiveFile((cur) => {
        if (cur !== path) return cur;
        const closedIdx = prev.indexOf(path);
        const fallback = next[closedIdx] ?? next[closedIdx - 1] ?? null;
        return fallback ?? null;
      });
      return next;
    });
  }, []);

  const handleReferenceFile = useCallback(
    (path: string, name: string) => {
      window.dispatchEvent(
        new CustomEvent("file-tree:reference", {
          detail: { path, name, envId },
        }),
      );
    },
    [envId],
  );

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current--;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length === 0) return;

      userPickedSiteRef.current = false;
      setPendingDiffCount(0);

      if (topMode === "files") {
        // 已在 Files 模式：FileTreeTab 已挂载，直接上传
        fileTreeRef.current?.uploadFiles(files);
      } else {
        // 非 Files 模式：暂存文件，切到 Files 后由 useEffect 触发上传
        pendingUploadRef.current = files;
        setTopMode("files");
      }
    },
    [topMode],
  );

  useEffect(() => {
    if (topMode === "files" && pendingUploadRef.current.length > 0) {
      const files = pendingUploadRef.current;
      pendingUploadRef.current = [];
      fileTreeRef.current?.uploadFiles(files);
    }
  }, [topMode]);

  const isFilesMode = topMode === "files";

  // 渲染前派生：activeSiteId 可能因 agent 切换后 sites 重新加载而指向不存在的 id，
  // 此时回退到 sites[0]。不在 effect 里 setActiveSiteId 修正，避免多一次渲染。
  const validActiveSiteId =
    activeSiteId && sites.some((s) => s.id === activeSiteId) ? activeSiteId : (sites[0]?.id ?? null);
  const activeSite = sites.find((s) => s.id === validActiveSiteId) ?? null;

  return (
    <div
      className="artifacts-workspace relative flex h-full min-w-0 flex-col bg-surface-1"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 一级 tab：Files / Sites 永远显示且永远可点；
          未绑定 site 时点 Sites 会进入空状态，提示用户去 Agent 配置里绑定 */}
      <TopModeTabs
        topMode={topMode}
        pendingDiffCount={pendingDiffCount}
        onChange={handleTopChange}
        availableModes={availableModes}
        layoutMode={layoutMode}
        canDock={canDock}
        onLayoutModeChange={onLayoutModeChange}
        onClose={onClose}
      />

      {/* 加载中/错误提示仅在 Sites 模式下展示，避免在 Files/Tasks/Views 模式下干扰 */}
      {topMode === "sites" && sitesLoading && sites.length === 0 && (
        <div className="px-3 py-1 text-[11px] text-text-dim border-b border-border/30">
          {t("siteFrame.loadingSites")}
        </div>
      )}
      {topMode === "sites" && sites.length > 0 && sitesLoadError && (
        <div className="px-3 py-1 text-[11px] text-text-dim border-b border-border/30">
          {t("siteFrame.loadFailed", { message: sitesLoadError.message || String(sitesLoadError) })}
        </div>
      )}

      {/* Files 模式：完整文件区；Tasks 模式：定时任务列表；Views 模式：发布视图列表；Sites 模式：二级 site tab + iframe */}
      {isFilesMode ? (
        <ArtifactsFilesWorkspace
          envId={envId}
          fileTreeRef={fileTreeRef}
          openFiles={openFiles}
          activeFile={activeFile}
          changedFiles={normalizedChangedFiles}
          onSelectFile={setActiveFile}
          onCloseFile={handleCloseFile}
          onOpenFile={openFile}
          onReferenceFile={handleReferenceFile}
        />
      ) : topMode === "tasks" ? (
        <TasksPanel agentId={agentConfigId} />
      ) : topMode === "views" ? (
        <ProdViewsPanel agentId={agentConfigId} />
      ) : sites.length === 0 ? (
        // Sites 模式 + 未绑定任何 site：空状态提示 + 直接挂载入口（agentConfigId 就绪时显示）
        <div className="flex-1 min-h-0 min-w-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <Globe className="h-10 w-10 text-text-dim" />
          <div>
            <p className="text-sm font-medium text-text-primary">{t("panelMode.sitesEmptyTitle")}</p>
            <p className="mt-1 text-xs text-text-muted">{t("panelMode.sitesEmptyHint")}</p>
          </div>
          {agentConfigId && (
            <Button variant="outline" size="sm" onClick={handleMount} className="mt-1">
              <Plus className="h-3.5 w-3.5" />
              {t("panelMode.mountSite")}
            </Button>
          )}
        </div>
      ) : (
        <>
          {/* 二级 site tab：仅在 Sites 模式且有有效 activeSiteId 时挂载 */}
          {validActiveSiteId && (
            <SiteTabsBar
              activeSiteId={validActiveSiteId}
              sites={sites}
              currentAgentConfigId={agentConfigId}
              onChange={handleSiteChange}
              onMountClick={handleMount}
              onUnmountClick={handleUnmountClick}
            />
          )}
          {/* SiteFrame：占满剩余空间，切 site 时 key 变化触发重挂载 */}
          {activeSite && (
            <div className="flex-1 min-h-0 min-w-0">
              <SiteFrame
                key={activeSite.remoteAppId}
                remoteAppId={activeSite.remoteAppId}
                name={activeSite.name}
                createdByAgentConfigId={activeSite.createdByAgentConfigId}
                createdByAgentConfigName={activeSite.createdByAgentConfigName}
              />
            </div>
          )}
        </>
      )}

      {/* 拖拽上传遮罩：拖入文件时覆盖整个面板 */}
      {isDragging && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center rounded-lg bg-background/80 backdrop-blur-sm">
          <Upload className="h-10 w-10 mb-3 text-brand" />
          <p className="text-sm font-medium text-text-primary mb-1">{t("fileTree.dropToUpload")}</p>
          <p className="text-xs text-text-muted">{t("fileTree.uploadTo", { path: "user/" })}</p>
        </div>
      )}

      <ArtifactsDialogs
        agentConfigId={agentConfigId}
        siteIds={sites.map((site) => site.id)}
        mountOpen={mountDialogOpen}
        onMountOpenChange={setMountDialogOpen}
        onMounted={handleMounted}
        unmountTarget={unmountConfirm}
        unmounting={unmounting}
        onUnmountOpenChange={(open) => !open && setUnmountConfirm(null)}
        onConfirmUnmount={(siteId) => agentConfigId && runUnmount(agentConfigId, siteId)}
      />
    </div>
  );
}
