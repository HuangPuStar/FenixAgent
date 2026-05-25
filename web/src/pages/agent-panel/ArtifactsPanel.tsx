import { FolderTree, PanelRightClose } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileTreeTab } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { NS } from "../../i18n";

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, envId }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-width");
    return saved ? Number(saved) : 480;
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
        const newWidth = Math.min(700, Math.max(360, startWidthRef.current + delta));
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

  if (collapsed) {
    return null;
  }

  return (
    <div className="relative flex shrink-0">
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
      <div className="agent-artifacts" style={{ width }}>
        {/* Tab bar — single "Files" tab */}
        <div className="agent-artifacts-tabs">
          <span className="agent-artifacts-tab active">
            <FolderTree className="inline h-3 w-3 mr-1" />
            {t("tabFiles")}
          </span>
        </div>

        {/* Split content: file tree (left) + preview (right) */}
        <div className="agent-artifacts-split">
          <div className="agent-artifacts-tree-pane">
            <FileTreeTab envId={envId} onPreviewFile={handlePreviewFile} onReferenceFile={handleReferenceFile} />
          </div>
          <div className="agent-artifacts-preview-pane">
            <PreviewTab envId={envId} filePath={previewFilePath} />
          </div>
        </div>
      </div>
    </div>
  );
}
