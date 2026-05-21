import { useCallback, useEffect, useRef, useState } from "react";
import { X, FileText, FolderTree, BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import { FileTreeTab } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";

type ArtifactsTab = "files" | "preview" | "context";

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, envId }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [activeTab, setActiveTab] = useState<ArtifactsTab>(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-tab");
    return saved === "preview" || saved === "context" || saved === "files" ? saved : "files";
  });
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-width");
    return saved ? Number(saved) : 400;
  });

  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-tab", activeTab);
  }, [activeTab]);

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
        const newWidth = Math.min(600, Math.max(300, startWidthRef.current + delta));
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
    setActiveTab("preview");
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
    <>
      {/* 拖拽分隔线 */}
      <div className="agent-artifacts-resize-handle" style={{ left: 0 }} onMouseDown={handleMouseDown} />

      {/* 面板主体 */}
      <div className="agent-artifacts" style={{ width }}>
        {/* Tab 栏 */}
        <div className="agent-artifacts-tabs">
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "files" ? "active" : ""}`}
            onClick={() => setActiveTab("files")}
          >
            <FolderTree className="inline h-3 w-3 mr-1" />
            {t("tabFiles")}
          </button>
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "preview" ? "active" : ""}`}
            onClick={() => setActiveTab("preview")}
          >
            <FileText className="inline h-3 w-3 mr-1" />
            {t("tabPreview")}
          </button>
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "context" ? "active" : ""}`}
            onClick={() => setActiveTab("context")}
          >
            <BarChart3 className="inline h-3 w-3 mr-1" />
            {t("tabContext")}
          </button>
          <button
            type="button"
            className="agent-artifacts-close-btn"
            onClick={onToggleCollapse}
            title={t("closePanel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="flex-1 overflow-hidden">
          {activeTab === "files" && (
            <FileTreeTab
              envId={envId}
              onPreviewFile={handlePreviewFile}
              onReferenceFile={handleReferenceFile}
            />
          )}
          {activeTab === "preview" && <PreviewTab envId={envId} filePath={previewFilePath} />}
          {activeTab === "context" && (
            <div className="flex-1 overflow-y-auto p-4">
              <p className="text-sm text-text-muted">Context (placeholder)</p>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
