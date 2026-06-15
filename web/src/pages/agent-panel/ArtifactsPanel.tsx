import { FolderTree, PanelRightClose, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { ChangedFilesSection } from "../../components/agent-panel/ChangedFilesSection";
import { FileTreeTab, type FileTreeTabHandle } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { useResizable } from "../../hooks/useResizable";
import { NS } from "../../i18n";
import type { ChangedFile } from "../../lib/extract-changed-files";

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
  /** 本次会话中被 Agent 修改的文件列表，已去重排序，含操作类型 */
  changedFiles?: ChangedFile[];
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, envId, changedFiles = [] }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const { t: tPanel } = useTranslation(NS.AGENT_PANEL);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);
  const [dialogOffset, setDialogOffset] = useState({ x: 0, y: 0 });
  const initialDialogSize = useMemo(
    () => ({
      width: Math.round(window.innerWidth * 0.66),
      height: Math.round(window.innerHeight * 0.75),
    }),
    [],
  );
  const {
    size: dialogSize,
    resizeHandle,
    targetRef: dialogResizeRef,
  } = useResizable({
    initialWidth: initialDialogSize.width,
    initialHeight: initialDialogSize.height,
    externalOffsetX: dialogOffset.x,
    externalOffsetY: dialogOffset.y,
  });
  const dragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });

  const effectiveStyle: React.CSSProperties = {
    width: dialogSize.width,
    height: dialogSize.height,
    transform: `translate(calc(-50% + ${dialogSize.offsetX + dialogOffset.x}px), calc(-50% + ${
      dialogSize.offsetY + dialogOffset.y
    }px))`,
  };

  const handleHeaderDragStart = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest("button")) return;
      e.preventDefault();
      dragStartRef.current = { x: e.clientX, y: e.clientY, ox: dialogOffset.x, oy: dialogOffset.y };

      const onMove = (ev: MouseEvent) => {
        const ds = dragStartRef.current;
        setDialogOffset({ x: ds.ox + ev.clientX - ds.x, y: ds.oy + ev.clientY - ds.y });
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [dialogOffset],
  );

  const closePreview = useCallback(() => {
    setPreviewFilePath(null);
    setDialogOffset({ x: 0, y: 0 });
  }, []);

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
        <button
          className="absolute left-0 -translate-x-full top-1/2 -translate-y-1/2 z-10 w-6 h-12 flex items-center justify-center rounded-l-lg border border-border border-r-0 bg-surface-1 text-text-muted cursor-pointer transition-colors duration-150 hover:bg-surface-2 hover:text-text-primary"
          onClick={onToggleCollapse}
          title={t("closePanel")}
          aria-label={t("closePanel")}
        >
          <PanelRightClose className="h-3.5 w-3.5" />
        </button>

        <div className="agent-artifacts-resize-handle" style={{ left: 0 }} onMouseDown={handleMouseDown} />

        <div className="flex flex-col overflow-hidden" style={{ width }}>
          <div className="flex items-center px-2 py-1.5 border-b border-border shrink-0">
            <span className="text-xs text-text-primary flex items-center gap-1">
              <FolderTree className="h-3 w-3" />
              {tPanel("tabFiles")}
            </span>
          </div>

          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <div className="flex-1 min-h-0">
              <FileTreeTab
                ref={fileTreeRef}
                envId={envId}
                onPreviewFile={handlePreviewFile}
                onReferenceFile={handleReferenceFile}
              />
            </div>
            <ChangedFilesSection files={changedFiles} />
          </div>
        </div>

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

      <Dialog
        open={!!previewFilePath}
        onOpenChange={(open) => {
          if (!open) closePreview();
        }}
      >
        <DialogContent
          ref={dialogResizeRef}
          className="flex flex-col p-0 gap-0 overflow-hidden sm:max-w-none !translate-x-0 !translate-y-0 shadow-[0_0_40px_rgba(0,0,0,0.4)] !transition-none"
          style={effectiveStyle}
          showOverlay
          disableOverlayClose
          showCloseButton={false}
        >
          <DialogHeader
            className="flex-row items-center justify-between px-4 py-3 border-b shrink-0 gap-2 cursor-grab active:cursor-grabbing select-none"
            onMouseDown={handleHeaderDragStart}
          >
            <DialogTitle className="text-sm font-medium truncate max-w-[70%]">
              {previewFilePath?.split("/").pop() ?? t("fileTree.preview.title")}
            </DialogTitle>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={closePreview}
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
          <div {...resizeHandle("n")} />
          <div {...resizeHandle("s")} />
          <div {...resizeHandle("e")} />
          <div {...resizeHandle("w")} />
          <div {...resizeHandle("ne")} />
          <div {...resizeHandle("nw")} />
          <div {...resizeHandle("se")} />
          <div {...resizeHandle("sw")} />
        </DialogContent>
      </Dialog>
    </>
  );
}
