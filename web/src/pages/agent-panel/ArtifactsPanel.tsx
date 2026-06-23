import { FilesIcon, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import { agentSitesApi } from "@/src/api/sdk";
import { FileTabsBar } from "../../components/agent-panel/FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { type PanelMode, PanelModeTabs } from "../../components/agent-panel/PanelModeTabs";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { normalizeToUserPath } from "../../components/agent-panel/preview/utils";
import { SiteFrame } from "../../components/agent-panel/SiteFrame";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";
import { cn } from "../../lib/utils";

/** 打开文件 tab 的 LRU 上限：超出时丢弃最旧（数组末尾）的，与 FileTabsBar 的 MAX_VISIBLE_TABS 解耦 */
const MAX_OPEN_FILES = 8;

interface SiteEntry {
  id: string;
  name: string;
  remoteAppId: string;
}

interface ArtifactsPanelProps {
  envId: string | null;
  /** Agent 配置 ID，用于加载绑定的 sites；为 null 时不加载。 */
  agentConfigId?: string | null;
  /** 本次会话中被 Agent 修改的文件列表，已去重排序，含操作类型 */
  changedFiles?: ChangedFile[];
}

/**
 * ArtifactsPanel —— chat 右侧区域，顶部一级 tab 切换 Files / Sites，Files 内部保持
 * 原三段式（FileTabsBar + PreviewTab + 文件树 popover），Sites 用 SiteFrame 嵌入。
 *
 * 一级 tab 切换规则：Files 模式只显示文件区；Site 模式只显示对应 site iframe。
 * 互斥渲染避免 iframe 与文件预览抢占地盘，也避免后台 iframe 持续消耗资源。
 */
export function ArtifactsPanel({ envId, agentConfigId, changedFiles = [] }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  // ── 一级 tab 状态 ─────────────────────────────────────
  // 默认 Files 模式；当 agentConfigId 变化（切换 agent）时重置回 Files
  const [mode, setMode] = useState<PanelMode>({ kind: "files" });
  const [sites, setSites] = useState<SiteEntry[]>([]);
  const [sitesLoading, setSitesLoading] = useState(false);
  const [sitesError, setSitesError] = useState<string | null>(null);
  // 用户主动选择 Site 模式的标记：一旦主动选了 Site，后续 agent 产生 diff
  // 时不再粗暴切回 Files（避免长任务运行中持续打断浏览 site 的用户）。
  // 切回 Files 由用户主动操作（点 Files tab 或拖拽上传）触发清零。
  const userPickedSiteRef = useRef(false);
  // 待展示的 diff 文件数：用户在 Site 模式时累计，切回 Files 时清零
  const [pendingDiffCount, setPendingDiffCount] = useState(0);

  const handleChangeMode = useCallback((next: PanelMode) => {
    setMode(next);
    if (next.kind === "files") {
      userPickedSiteRef.current = false;
      setPendingDiffCount(0);
    } else {
      userPickedSiteRef.current = true;
    }
  }, []);

  // 切换 agent / agentConfigId 时：重置 mode + 重新加载绑定的 sites
  useEffect(() => {
    setMode({ kind: "files" });
    setSitesError(null);
    userPickedSiteRef.current = false;
    setPendingDiffCount(0);

    if (!agentConfigId) {
      setSites([]);
      return;
    }
    let cancelled = false;
    setSitesLoading(true);
    agentSitesApi
      .listByAgentConfig(agentConfigId)
      .then((res: { success?: boolean; data?: unknown[] }) => {
        if (cancelled) return;
        const raw = res.data;
        const list: SiteEntry[] = (Array.isArray(raw) ? raw : [])
          .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
          .map((item) => ({
            id: String(item.id ?? ""),
            name: String(item.name ?? ""),
            remoteAppId: String(item.remoteAppId ?? ""),
          }))
          .filter((item) => item.id && item.remoteAppId);
        setSites(list);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error("[ArtifactsPanel] 加载 agent 绑定 sites 失败", err);
        setSitesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setSitesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [agentConfigId]);

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

  const normalizedChangedFiles = useMemo<ChangedFile[]>(
    () => changedFiles.map((f) => ({ ...f, path: normalizeToUserPath(f.path) })),
    [changedFiles],
  );

  // changedFiles 变化时：
  // - 用户在 Files 模式：直接把新 diff 加入 openFiles
  // - 用户已主动切到 Site 模式：不强制切回，仅累计 pendingDiffCount 在 Files tab 上做角标提示，
  //   由用户主动点击切回 Files 时清零（避免长任务运行中持续打断浏览 site 的用户）
  useEffect(() => {
    const paths = normalizedChangedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    setOpenFiles((prev) => {
      const newPaths = paths.filter((p) => !prev.includes(p));
      if (newPaths.length === 0) return prev;
      return [...newPaths, ...prev].slice(0, MAX_OPEN_FILES);
    });
    setActiveFile((cur) => cur ?? paths[0]);
    if (userPickedSiteRef.current) {
      setPendingDiffCount((n) => n + paths.length);
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

      // 无论当前在 Files 还是 Site 模式，拖入文件都先切回 Files：
      // 否则文件树 popover 还未挂载，fileTreeRef.current 为 null 导致上传静默失败
      userPickedSiteRef.current = false;
      setPendingDiffCount(0);
      setMode({ kind: "files" });
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

  const isFilesMode = mode.kind === "files";

  return (
    <div
      className="relative flex h-full min-w-0 flex-col bg-surface-1 rounded-xl border border-border/75"
      style={{ boxShadow: "var(--shadow-card)" }}
      // 拖拽 handler 始终绑定：Site 模式下用户拖入文件也能自动切回 Files 并上传，
      // 否则浏览器会把文件交给 iframe 触发其内部导航（drop handler 内部会 setMode）
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 一级 tab：Files / Sites；只在加载到 sites 后展示，避免无 site 时浪费垂直空间 */}
      {(sites.length > 0 || sitesLoading || sitesError) && (
        <PanelModeTabs mode={mode} sites={sites} onChange={handleChangeMode} pendingDiffCount={pendingDiffCount} />
      )}

      {/* 加载中提示（紧凑模式，避免阻塞 Files 默认体验） */}
      {sitesLoading && sites.length === 0 && (
        <div className="px-3 py-1 text-[11px] text-text-dim border-b border-border/30">
          {t("siteFrame.loadingSites")}
        </div>
      )}
      {sitesError && (
        <div className="px-3 py-1 text-[11px] text-text-dim border-b border-border/30">
          {t("siteFrame.loadFailed", { message: sitesError })}
        </div>
      )}

      {/* Files 模式：完整文件区；Site 模式：仅渲染对应 iframe，文件区卸载 */}
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
      ) : (
        <div className="flex-1 min-h-0 min-w-0">
          <SiteFrame key={mode.remoteAppId} remoteAppId={mode.remoteAppId} name={mode.name} />
        </div>
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
    </div>
  );
}
