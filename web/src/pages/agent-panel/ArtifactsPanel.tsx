import { useRequest } from "ahooks";
import { FilesIcon, Globe, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { envApi } from "@/src/api/environments";
import { unwrap } from "@/src/api/request";
import { agentSitesApi, type SiteApp } from "@/src/api/sites";
import { FileTabsBar } from "../../components/agent-panel/FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { MountSiteDialog } from "../../components/agent-panel/MountSiteDialog";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { normalizeToUserPath } from "../../components/agent-panel/preview/utils";
import { SiteFrame } from "../../components/agent-panel/SiteFrame";
import { type SiteEntry, SiteTabsBar } from "../../components/agent-panel/SiteTabsBar";
import { type TopMode, TopModeTabs } from "../../components/agent-panel/TopModeTabs";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";
import { cn } from "../../lib/utils";

/** 打开文件 tab 的 LRU 上限：超出时丢弃最旧（数组末尾）的，与 FileTabsBar 的 MAX_VISIBLE_TABS 解耦 */
const MAX_OPEN_FILES = 8;

interface ArtifactsPanelProps {
  envId: string | null;
  /**
   * Agent 配置 ID，用于加载绑定的 sites。
   * 外部已加载时可显式传入，避免重复请求；不传则 ArtifactsPanel 自己用 envId 拉
   * environment 详情取 `agent_config_id`（chat 路由文件不再各自重复实现这段逻辑）。
   */
  agentConfigId?: string | null;
  /** 本次会话中被 Agent 修改的文件列表，已去重排序，含操作类型 */
  changedFiles?: ChangedFile[];
}

/**
 * ArtifactsPanel —— chat 右侧区域，两级 tab 结构：
 *
 * - 一级 tab（TopModeTabs）：Files / Sites 二选一
 * - Files 模式：完整三段式（FileTabsBar + PreviewTab + 文件树 popover）
 * - Sites 模式：下方出现二级 SiteTabsBar 切换具体 site，再渲染对应 SiteFrame iframe
 *
 * Files / Sites 互斥渲染避免 iframe 与文件预览抢占地盘，也避免后台 iframe 持续消耗资源。
 * 二级 site 切换不动 pendingDiffCount：用户仍在 Sites 区浏览，没回 Files，角标继续累计。
 *
 * agentConfigId 解析优先级：外部 prop > envId 内部加载。
 * 把加载逻辑放这里是为了让 chat.$agentId.tsx / chat.$agentId_.$sessionId.tsx
 * 两个路由文件都不用重复实现 environment 拉取——历史上 chat.$agentId_.$sessionId.tsx
 * 漏传 agentConfigId prop 导致 sites 永远显示"未绑定"就是这种重复埋的坑。
 */
export function ArtifactsPanel({ envId, agentConfigId: agentConfigIdProp, changedFiles = [] }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  // ── 一级 + 二级 tab 状态 ─────────────────────────────
  // 一级 topMode：Files 显示文件区，Sites 显示二级 site tab + iframe
  // 二级 activeSiteId：在 sites 列表里选哪个 site（仅 Sites 模式下使用）
  // 拆成两个独立 state 而非 discriminated union：onChange 信号天然分离，
  // render 派生 validActiveSiteId 比 effect 里 setActiveSiteId 更直接。
  // agentConfigId 变化（切换 agent）时重置 topMode 回 files + activeSiteId 清空
  const [topMode, setTopMode] = useState<TopMode>("files");
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  // 用户主动切到 Sites 模式的标记：一旦主动离开 Files，后续 agent 产生 diff
  // 时不再粗暴切回 Files（避免长任务运行中持续打断浏览 site 的用户）。
  // 切回 Files 由用户主动操作（点 Files tab 或拖拽上传）触发清零。
  // 二级 site 切换不触发此 ref：用户仍在 Sites 区浏览，pendingDiffCount 应继续累计。
  const userPickedSiteRef = useRef(false);
  // 待展示的 diff 文件数：用户在 Sites 模式时累计，切回 Files 时清零
  const [pendingDiffCount, setPendingDiffCount] = useState(0);
  const configIdRef = useRef(agentConfigIdProp);
  configIdRef.current = agentConfigIdProp;

  // ── 挂载/卸载 state ───────────────────────────────────
  // mountDialogOpen：挂载弹层（多选 + 确认）
  // unmountConfirm：卸载确认弹层（{id, name} 单槽位，null=关闭）
  const [mountDialogOpen, setMountDialogOpen] = useState(false);
  const [unmountConfirm, setUnmountConfirm] = useState<{ id: string; name: string } | null>(null);

  // ── useRequest：环境详情加载 ──────────────────────────
  // 外部 prop 优先；未传时根据 envId 拉 environment 详情获取 agent_config_id。
  // ready 条件控制是否发起请求：仅当外部未传 prop 且 envId 存在时才拉取。
  const { data: envData } = useRequest(() => unwrap(envApi.get({ id: envId! })), {
    ready: agentConfigIdProp === undefined && !!envId,
    onError: (err: unknown) => {
      console.warn("[ArtifactsPanel] 加载 environment 详情失败，Sites tab 不可用", err);
    },
  });
  const resolvedAgentConfigId = envData?.agentConfigId ?? null;
  const agentConfigId = agentConfigIdProp !== undefined ? agentConfigIdProp : resolvedAgentConfigId;
  configIdRef.current = agentConfigId ?? undefined;

  // ── useRequest：Sites 列表加载（manual） ──────────────
  // 挂载/卸载成功后复用 loadSites 刷新列表。
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

  // sites / agentConfigId 的 ref 镜像：事件处理器（useEffect []）内需要访问最近值。
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
        setSites((prev: SiteEntry[] | undefined) => (prev ?? []).filter((s) => s.id !== siteId));
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

  // 工具卡片点击预览按钮（artifacts:preview-file）→ 切到 Files 模式并打开文件预览
  // biome-ignore lint/correctness/useExhaustiveDependencies: 仅 mount 时注册，通过 ref 读取最新 openFile
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { path: string } | undefined;
      if (!detail?.path) return;
      userPickedSiteRef.current = false;
      setPendingDiffCount(0);
      setTopMode("files");
      openFileRef.current?.(normalizeToUserPath(detail.path));
    };
    window.addEventListener("artifacts:preview-file", handler);
    return () => window.removeEventListener("artifacts:preview-file", handler);
  }, []);

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

  // ── 挂载/卸载 handlers ───────────────────────────────
  // 挂载流程：点 + → 打开 MountSiteDialog → 多选 + 确认 → 内部串行 bindSite →
  //   成功后 onMounted 关闭弹层 + 调 loadSites 刷新。
  // 卸载流程：点 × → setUnmountConfirm 弹 AlertDialog → 确认 → unbindSite →
  //   loadSites 刷新。activeSiteId 不显式重置：validActiveSiteId 派生会回退到 sites[0]，
  //   若卸载完 sites 为空，render 时 validActiveSiteId=null 走空状态分支。
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

  // agentConfigId 变化（切换 agent）时：重置 UI state + 重新加载绑定的 sites。
  // 挂载/卸载不走这里——直接调 loadSites（不重置 topMode/activeSiteId/pendingDiff，
  // 用户挂载完希望留在 Sites 模式看到新 tab，卸载完希望保留剩余 site 的浏览状态）。
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

  // ── Files 模式内部状态 ─────────────────────────────────
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [fileTreeOpen, setFileTreeOpen] = useState(false);

  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    active: boolean;
    percent: number;
    fileName: string;
  }>({ active: false, percent: 0, fileName: "" });
  const dragCounterRef = useRef(0);
  const fileTreeRef = useRef<FileTreeTabHandle>(null);

  const openFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter((p) => p !== path);
      return [path, ...filtered].slice(0, MAX_OPEN_FILES);
    });
    setActiveFile(path);
  }, []);

  // 事件监听器中需要访问最新的 openFile，用 ref 保持引用同步
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

  const handleReferenceFile = useCallback((path: string, name: string) => {
    window.dispatchEvent(
      new CustomEvent("file-tree:reference", {
        detail: { path, name },
      }),
    );
  }, []);

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    dragCounterRef.current++;
    setIsDragging(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
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
    async (e: React.DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setIsDragging(false);

      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;

      // 无论当前在 Files 还是 Sites 模式，拖入文件都先切回 Files：
      // 否则文件树 popover 还未挂载，fileTreeRef.current 为 null 导致上传静默失败
      userPickedSiteRef.current = false;
      setPendingDiffCount(0);
      setTopMode("files");
      setUploadProgress({ active: true, percent: 0, fileName: files[0].name });

      try {
        await fileTreeRef.current?.uploadFiles(files, (percent) => {
          setUploadProgress((prev) => ({ ...prev, percent }));
        });
        toast.success(t("fileTree.uploadSuccess", { count: files.length }));
      } catch {
        toast.error(t("fileTree.uploadFailed"));
      } finally {
        setUploadProgress({ active: false, percent: 0, fileName: "" });
      }
    },
    [t],
  );

  const isFilesMode = topMode === "files";

  // 渲染前派生：activeSiteId 可能因 agent 切换后 sites 重新加载而指向不存在的 id，
  // 此时回退到 sites[0]。不在 effect 里 setActiveSiteId 修正，避免多一次渲染。
  const validActiveSiteId =
    activeSiteId && sites.some((s) => s.id === activeSiteId) ? activeSiteId : (sites[0]?.id ?? null);
  const activeSite = sites.find((s) => s.id === validActiveSiteId) ?? null;

  return (
    <div
      className="relative flex h-full min-w-0 flex-col bg-surface-1 rounded-xl border border-border/75"
      style={{ boxShadow: "var(--shadow-card)" }}
      // 拖拽 handler 始终绑定：Sites 模式下用户拖入文件也能自动切回 Files 并上传，
      // 否则浏览器会把文件交给 iframe 触发其内部导航（drop handler 内部会 setTopMode）
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 一级 tab：Files / Sites 永远显示且永远可点；
          未绑定 site 时点 Sites 会进入空状态，提示用户去 Agent 配置里绑定 */}
      <TopModeTabs topMode={topMode} pendingDiffCount={pendingDiffCount} onChange={handleTopChange} />

      {/* 加载中提示（紧凑模式，避免阻塞 Files 默认体验） */}
      {sitesLoading && sites.length === 0 && (
        <div className="px-3 py-1 text-[11px] text-text-dim border-b border-border/30">
          {t("siteFrame.loadingSites")}
        </div>
      )}
      {sitesLoadError && (
        <div className="px-3 py-1 text-[11px] text-text-dim border-b border-border/30">
          {t("siteFrame.loadFailed", { message: sitesLoadError.message || String(sitesLoadError) })}
        </div>
      )}

      {/* Files 模式：完整文件区；Sites 模式：二级 site tab + iframe，文件区卸载 */}
      {isFilesMode ? (
        <>
          <FileTabsBar
            openFiles={openFiles}
            activeFile={activeFile}
            changedFiles={normalizedChangedFiles}
            onSelectFile={setActiveFile}
            onCloseFile={handleCloseFile}
            onPreviewChangedFile={openFile}
          />
          <div className="flex-1 min-h-0 min-w-0 flex">
            <div className="flex-1 min-h-0 min-w-0 flex flex-col border-r border-solid border-border/75">
              <PreviewTab envId={envId} filePath={activeFile} />
            </div>
            <div className="relative flex-shrink-0">
              <button
                type="button"
                onClick={() => setFileTreeOpen((v) => !v)}
                className={cn(
                  "absolute -left-12 z-20 h-10 w-10 flex items-center justify-center rounded-lg shadow-sm transition-colors",
                  fileTreeOpen
                    ? "bg-surface-1 border border-border/30 text-text-primary"
                    : "bg-surface-1 border border-border/20 text-text-muted hover:text-text-primary hover:bg-surface-2/60",
                )}
                title={fileTreeOpen ? t("fileTree.hideTree") : t("fileTree.showTree")}
                aria-label={fileTreeOpen ? t("fileTree.hideTree") : t("fileTree.showTree")}
              >
                <FilesIcon className="h-4 w-4" />
              </button>
              {fileTreeOpen && (
                <div className="w-60 flex flex-col overflow-hidden">
                  <FileTreeTab
                    ref={fileTreeRef}
                    envId={envId}
                    onPreviewFile={openFile}
                    onReferenceFile={handleReferenceFile}
                  />
                </div>
              )}
            </div>
          </div>
        </>
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
              onChange={handleSiteChange}
              onMountClick={handleMount}
              onUnmountClick={handleUnmountClick}
            />
          )}
          {/* SiteFrame：占满剩余空间，切 site 时 key 变化触发重挂载 */}
          {activeSite && (
            <div className="flex-1 min-h-0 min-w-0">
              <SiteFrame key={activeSite.remoteAppId} remoteAppId={activeSite.remoteAppId} name={activeSite.name} />
            </div>
          )}
        </>
      )}

      {(isDragging || uploadProgress.active) && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center rounded-lg bg-background/80 backdrop-blur-sm">
          {uploadProgress.active ? (
            <>
              <Upload className="h-8 w-8 mb-3 text-brand animate-pulse" />
              <p className="text-sm text-text-primary mb-2">
                {t("fileTree.uploadingFile", { name: uploadProgress.fileName })}
              </p>
              <div className="w-48">
                <Progress value={uploadProgress.percent} className="h-1.5" />
              </div>
              <p className="text-xs text-text-muted mt-1">
                {t("fileTree.uploadingProgress", { percent: uploadProgress.percent })}
              </p>
            </>
          ) : (
            <>
              <Upload className="h-10 w-10 mb-3 text-brand" />
              <p className="text-sm font-medium text-text-primary mb-1">{t("fileTree.dropToUpload")}</p>
              <p className="text-xs text-text-muted">{t("fileTree.uploadTo", { path: "user/" })}</p>
            </>
          )}
        </div>
      )}

      {/* 挂载弹层：仅在 agentConfigId 就绪时启用，避免环境未绑定 agentConfig 时无效调用 */}
      {agentConfigId && (
        <MountSiteDialog
          open={mountDialogOpen}
          onOpenChange={setMountDialogOpen}
          agentConfigId={agentConfigId}
          boundSiteAppIds={sites.map((s) => s.id)}
          onMounted={handleMounted}
        />
      )}

      {/* 卸载确认：单槽位 state，null=关闭。不预先 close，让用户必须做选择 */}
      <AlertDialog open={unmountConfirm !== null} onOpenChange={(o) => !o && setUnmountConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("panelMode.unmountConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {unmountConfirm ? t("panelMode.unmountConfirm", { name: unmountConfirm.name }) : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unmounting}>{t("confirmDialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (unmountConfirm && agentConfigId) runUnmount(agentConfigId, unmountConfirm.id);
              }}
              disabled={unmounting}
            >
              {unmounting ? t("confirmDialog.processing") : t("panelMode.unmountSite")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
