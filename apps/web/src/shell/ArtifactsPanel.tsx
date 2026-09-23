import { SiteFrame, SiteTabsBar } from "@fenix/agent-config/web";
import { type ProdViewModulesConfig, ProdViewsPanel } from "@fenix/resource-prod-view/web";
import { TasksPanel } from "@fenix/resource-task/web";
import type { ChangedFile } from "@fenix/ui-components/chat/lib/extract-changed-files";
import { Button } from "@fenix/ui-components/ui/button";
import { ErrorFallback } from "@fenix/ui-components/ui/error-fallback";
import { Globe, Plus, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ErrorBoundary } from "react-error-boundary";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";
import { ArtifactsDialogs } from "../components/agent-panel/artifacts-dialogs";
import { ArtifactsFilesWorkspace } from "../components/agent-panel/artifacts-files-workspace";
import { type TopMode, TopModeTabs } from "../components/agent-panel/TopModeTabs";
import { useArtifactsFiles } from "./use-artifacts-files";
import { useArtifactsSites } from "./use-artifacts-sites";

/** Sites 模式下的状态条刻度（「加载中」与「加载失败」两条同名同级，改刻度时两处一起动） */
const SITES_STATUS_STRIP_CLASS = "px-3 py-1 text-3xs text-text-dim border-b border-border/30";

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

/**
 * 输出展示面板（§7.1 放置矩阵第 4 行）：非关键面板，根组件裹一层错误边界——文件树 / 预览 / 站点 iframe
 * 任一崩溃时收缩成统一降级 UI（一次重试即可重新挂载整块面板），聊天区与侧栏不受影响。
 *
 * 边界裹在导出处而不是某个 `return` 上：本组件有多个输出出口，且取数发生在两个子 hook 体内，
 * 逐出口加边界既不完整也要写多遍。
 */
export function ArtifactsPanel(props: ArtifactsPanelProps) {
  return (
    <ErrorBoundary
      FallbackComponent={ErrorFallback}
      onError={(error, info) => console.error("[ArtifactsPanel] 渲染失败", error, info)}
    >
      <ArtifactsPanelView {...props} />
    </ErrorBoundary>
  );
}

/**
 * Chat 右侧真实工作区。本组件只剩两件事：**模式切换**（Files / Sites / Tasks / Views）与**渲染装配**；
 * Sites 的数据流在 `use-artifacts-sites`，Files 的 tab / 角标 / 拖拽上传在 `use-artifacts-files`。
 */
function ArtifactsPanelView({
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
  const isFilesMode = topMode === "files";

  const availableModes = useMemo<TopMode[]>(() => {
    if (!modulesConfig) return ["files", "sites", "tasks", "views"];
    const modes: TopMode[] = [];
    if (modulesConfig.filesPanel?.enabled !== false) modes.push("files");
    if (modulesConfig.sitesPanel?.enabled !== false) modes.push("sites");
    if (modulesConfig.tasksPanel?.enabled !== false) modes.push("tasks");
    if (modulesConfig.viewsPanel?.enabled !== false) modes.push("views");
    return modes;
  }, [modulesConfig]);

  const enterSitesMode = useCallback(() => setTopMode("sites"), []);
  const enterFilesMode = useCallback(() => setTopMode("files"), []);

  const {
    agentConfigId,
    sites,
    sitesLoading,
    sitesLoadError,
    unmounting,
    validActiveSiteId,
    activeSite,
    mountDialogOpen,
    setMountDialogOpen,
    unmountConfirm,
    setUnmountConfirm,
    setActiveSiteId,
    handleSiteChange,
    handleMount,
    handleMounted,
    handleUnmountClick,
    runUnmount,
  } = useArtifactsSites({ envId, agentConfigId: agentConfigIdProp, onEnterSitesMode: enterSitesMode });

  const {
    openFiles,
    activeFile,
    setActiveFile,
    openFile,
    pendingDiffCount,
    normalizedChangedFiles,
    handleCloseFile,
    handleReferenceFile,
    isDragging,
    handleDragEnter,
    handleDragOver,
    handleDragLeave,
    handleDrop,
    fileTreeRef,
  } = useArtifactsFiles({ envId, changedFiles, isFilesMode, onEnterFilesMode: enterFilesMode });

  // agent 切换：回到 Files 模式（站点列表、选中态与角标各由对应 hook 复位）
  useEffect(() => {
    setTopMode("files");
  }, [agentConfigId]);

  const handleTopChange = useCallback(
    (next: TopMode) => {
      setTopMode(next);
      if (next !== "files") {
        // 进入 Sites 时若没选过 site，自动选第一个；已选过则保留（agent 切换会被 effect 清空）
        setActiveSiteId((cur) => cur ?? sites[0]?.id ?? null);
      }
    },
    [sites, setActiveSiteId],
  );

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
        <div className={SITES_STATUS_STRIP_CLASS}>{t("siteFrame.loadingSites")}</div>
      )}
      {topMode === "sites" && sites.length > 0 && sitesLoadError && (
        // 文案不带原始 `sitesLoadError.message`：那是站点接口错误信封的原文（§9.3）。这条属于
        // 「列表已加载、重取失败」的降级提示，原始 error 仍在取数侧的 `onError` 里进了 `console.error`。
        <div className={SITES_STATUS_STRIP_CLASS}>{t("siteFrame.loadFailed")}</div>
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
