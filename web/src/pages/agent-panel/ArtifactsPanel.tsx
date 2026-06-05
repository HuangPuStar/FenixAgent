import { FolderTree, Maximize2, Minimize2, PanelRightClose, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { useResizable } from "../../hooks/useResizable";
import { NS } from "../../i18n";

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, envId }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const { t: tPanel } = useTranslation(NS.AGENT_PANEL);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const { size: dialogSize, resizeHandle } = useResizable({
    initialWidth: Math.round(window.innerWidth * 0.66),
    initialHeight: Math.round(window.innerHeight * 0.75),
  });
  const [isMaximized, setIsMaximized] = useState(false);
  const prevSizeRef = useRef({ width: 0, height: 0 });

  const effectiveStyle: React.CSSProperties = isMaximized
    ? { width: "calc(100vw - 16px)", height: "calc(100vh - 16px)" }
    : { width: dialogSize.width, height: dialogSize.height };

  const toggleMaximize = useCallback(() => {
    setIsMaximized((prev) => {
      if (!prev) {
        // 进入最大化前记住当前尺寸
        prevSizeRef.current = { width: dialogSize.width, height: dialogSize.height };
      }
      return !prev;
    });
  }, [dialogSize]);

  const [isDragging, setIsDragging] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{
    active: boolean;
    percent: number;
    fileName: string;
  }>({ active: false, percent: 0, fileName: "" });
  const dragCounterRef = useRef(0);
  const fileTreeRef = useRef<FileTreeTabHandle>(null);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-width");
    return saved ? Number(saved) : 260;
  });

  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-width", String(width));
  }, [width]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = startXRef.current - ev.clientX;
        const newWidth = Math.min(500, Math.max(200, startWidthRef.current + delta));
        setWidth(newWidth);
      };

      const handleMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [width],
  );

  const handlePreviewFile = useCallback((path: string) => {
    setPreviewFilePath(path);
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

  if (collapsed) {
    return null;
  }

  return (
    <>
      <div
        className="relative flex shrink-0 border-l border-border bg-surface-1"
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {/* Toggle button — pinned to the left edge */}
        <button
          className="absolute left-0 -translate-x-full top-1/2 -translate-y-1/2 z-10 w-6 h-12 flex items-center justify-center rounded-l-lg border border-border border-r-0 bg-surface-1 text-text-muted cursor-pointer transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
          onClick={onToggleCollapse}
          title={t("closePanel")}
          aria-label={t("closePanel")}
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>

        {/* Resize handle */}
        <div className="agent-artifacts-resize-handle" style={{ left: 0 }} onMouseDown={handleMouseDown} />

        {/* Panel body */}
        <div className="flex flex-col overflow-hidden" style={{ width }}>
          {/* Tab bar */}
          <div className="flex items-center px-2 py-1.5 border-b border-border shrink-0">
            <span className="text-xs text-text-primary flex items-center gap-1">
              <FolderTree className="h-3 w-3" />
              {tPanel("tabFiles")}
            </span>
          </div>

          {/* File tree */}
          <div className="flex-1 min-h-0">
            <FileTreeTab
              ref={fileTreeRef}
              envId={envId}
              onPreviewFile={handlePreviewFile}
              onReferenceFile={handleReferenceFile}
            />
          </div>
        </div>

        {/* 拖拽覆盖层 */}
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

      {/* 文件预览弹窗 — 位于视口中央，宽 2/3、高 3/4 */}
      <Dialog
        open={!!previewFilePath}
        onOpenChange={(open) => {
          if (!open) setPreviewFilePath(null);
        }}
      >
        <DialogContent
          className={`flex flex-col p-0 gap-0 overflow-hidden sm:max-w-none ${isMaximized ? "!top-2 !left-2 !translate-x-0 !translate-y-0 !rounded-none" : ""}`}
          style={effectiveStyle}
          disableOverlayClose
          disableEscapeClose
          showCloseButton={false}
        >
          <DialogHeader className="flex-row items-center justify-between px-4 py-3 border-b shrink-0 gap-2">
            <DialogTitle className="text-sm font-medium truncate max-w-[70%]">
              {previewFilePath?.split("/").pop() ?? t("fileTree.preview.title")}
            </DialogTitle>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={toggleMaximize}
                className="h-6 w-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
                title={isMaximized ? "恢复" : "最大化"}
              >
                {isMaximized ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              </button>
              <button
                type="button"
                onClick={() => setPreviewFilePath(null)}
                className="h-6 w-6 flex items-center justify-center rounded-md text-text-muted hover:text-text-primary hover:bg-surface-2 transition-colors"
                title="关闭"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-auto">
            {previewFilePath && <PreviewTab envId={envId} filePath={previewFilePath} />}
          </div>
          {/* 拖拽调整尺寸的把手 — 四角 + 四边（最大化时隐藏） */}
          {!isMaximized && (
            <>
              <div {...resizeHandle("n")} />
              <div {...resizeHandle("s")} />
              <div {...resizeHandle("e")} />
              <div {...resizeHandle("w")} />
              <div {...resizeHandle("ne")} />
              <div {...resizeHandle("nw")} />
              <div {...resizeHandle("se")} />
              <div {...resizeHandle("sw")} />
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
