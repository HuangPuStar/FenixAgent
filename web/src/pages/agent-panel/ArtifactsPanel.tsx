import { FilesIcon, Upload } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Progress } from "@/components/ui/progress";
import { FileTabsBar } from "../../components/agent-panel/FileTabsBar";
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { normalizeToUserPath } from "../../components/agent-panel/preview/utils";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";
import { cn } from "../../lib/utils";

/** 打开文件 tab 的 LRU 上限：超出时丢弃最旧（数组末尾）的，与 FileTabsBar 的 MAX_VISIBLE_TABS 解耦 */
const MAX_OPEN_FILES = 8;

interface ArtifactsPanelProps {
  envId: string | null;
  /** 本次会话中被 Agent 修改的文件列表，已去重排序，含操作类型 */
  changedFiles?: ChangedFile[];
}

/**
 * ArtifactsPanel —— 文件区域，VSCode 风格三段式布局（Popover 变体）。
 *
 * 顶部 FileTabsBar 承担：文件树 popover（点击 PanelLeft 展开，与历史会话 popover 一致）
 * / 变更文件 badge / 文件 tab 列表；主体全部留给 PreviewTab 预览区，文件树不再占用主区域。
 *
 * 预览改造：原先点击文件弹出可拖拽 Dialog，现已废弃；点击文件等于在 PreviewTab
 * 中打开，并加入顶部 tab 列表（最近 8 个，tab 栏仅展示最近 5 个，超出折叠）。
 *
 * 文件树改造：从原"主体左侧常驻"改为"popover 浮层"，与 ChatHeader 的历史会话交互一致；
 * ArtifactsPanel 把 `<FileTreeTab ref={fileTreeRef}>` 作为 ReactNode 交给 FileTabsBar
 * 渲染到 PopoverContent 内，ref 仍由 ArtifactsPanel 持有以便上传等命令式调用。
 */
export function ArtifactsPanel({ envId, changedFiles = [] }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  // 打开的文件列表（LRU 顺序：最前为最新打开），上限 MAX_OPEN_FILES
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  // 当前激活文件，控制 PreviewTab 展示内容
  const [activeFile, setActiveFile] = useState<string | null>(null);
  // 文件树是否展开（默认 false，由顶部 FilesIcon 按钮切换）
  // 改进：不再因为 openFiles 为空就自动展开，避免初始抢占主区域；用户需要时手动点开
  const [fileTreeOpen, setFileTreeOpen] = useState(false);

  // 拖拽上传遮罩状态
  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    active: boolean;
    percent: number;
    fileName: string;
  }>({ active: false, percent: 0, fileName: "" });
  const dragCounterRef = useRef(0);
  const fileTreeRef = useRef<FileTreeTabHandle>(null);

  // 打开文件预览：把 path 提到 openFiles 最前（去重），超过上限丢弃末尾，并设为 active
  const openFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const filtered = prev.filter((p) => p !== path);
      return [path, ...filtered].slice(0, MAX_OPEN_FILES);
    });
    setActiveFile(path);
  }, []);

  // 把 Agent 上报的任意格式 path（相对路径 / workspace 绝对路径）统一规范化为
  // 「相对 user/ 的路径」，与文件树 tree API 返回的格式一致（user/foo/bar.html）。
  // 集中规范化一次：useEffect 自动展开 + FileTabsBar badge 点击都消费同一份数据，
  // 避免 badge 回调把原始绝对路径直接喂给 openFile 导致 buildPreviewUrl 拼出双 user/。
  const normalizedChangedFiles = useMemo<ChangedFile[]>(
    () => changedFiles.map((f) => ({ ...f, path: normalizeToUserPath(f.path) })),
    [changedFiles],
  );

  // changedFiles 变化时自动将 diff 文件加入 openFiles（新文件前置），并激活第一个 diff 文件
  // path 已在 normalizedChangedFiles 中规范化为带 user/ 前缀，无需再次处理
  useEffect(() => {
    const paths = normalizedChangedFiles.map((f) => f.path);
    if (paths.length === 0) return;
    setOpenFiles((prev) => {
      const newPaths = paths.filter((p) => !prev.includes(p));
      if (newPaths.length === 0) return prev;
      return [...newPaths, ...prev].slice(0, MAX_OPEN_FILES);
    });
    setActiveFile((cur) => cur ?? paths[0]);
  }, [normalizedChangedFiles]);

  // 关闭 tab：从 openFiles 移除；若关闭的是当前激活文件，激活相邻 tab（优先右侧，再左侧）
  const handleCloseFile = useCallback((path: string) => {
    setOpenFiles((prev) => {
      const next = prev.filter((p) => p !== path);
      setActiveFile((cur) => {
        if (cur !== path) return cur;
        const closedIdx = prev.indexOf(path);
        // 优先选右侧第一个；越界则回退左侧最后一个；都没有则置空
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

  return (
    // h-full + min-w-0：填满外层 ResizablePanel 的宽高，避免内容溢出导致拖动布局错位。
    // 由外层 chat 路由的 ResizablePanel collapsible 控制可见性，这里不再处理折叠态。
    <div
      className="relative flex h-full min-w-0 flex-col bg-surface-1 rounded-xl border border-border/75"
      style={{ boxShadow: "var(--shadow-card)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* 顶部 tab 栏：文件树 toggle / 变更文件 badge / 文件 tabs */}
      <FileTabsBar
        openFiles={openFiles}
        activeFile={activeFile}
        changedFiles={normalizedChangedFiles}
        // 点击已有 tab / +N popover 中的项：仅切换 active，不重排顺序
        // （用户偏好：tab 位置稳定，不希望每次点击都把文件提到最前）
        // 真正"打开新文件"（双击文件树 / 变更 badge）才走 openFile 触发 LRU 入列
        onSelectFile={setActiveFile}
        onCloseFile={handleCloseFile}
        onPreviewChangedFile={openFile}
      />

      {/* 主体：文件树固定右侧 + 预览区自适应剩余空间 */}
      <div className="flex-1 min-h-0 min-w-0 flex">
        <div className="flex-1 min-h-0 min-w-0 flex flex-col border-r border-solid border-border/75">
          <PreviewTab envId={envId} filePath={activeFile} />
        </div>
        {/* 浮动 toggle 按钮：absolute 定位在文件树面板左边缘 */}
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

      {/* 拖拽上传遮罩（覆盖整个 panel） */}
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
