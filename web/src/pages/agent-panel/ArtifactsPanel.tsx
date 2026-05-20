import { useCallback, useEffect, useRef, useState } from "react";
import { X, FileText, BarChart3 } from "lucide-react";
import { ArtifactPreview } from "../../components/agent-panel/ArtifactPreview";
import { ArtifactContext } from "../../components/agent-panel/ArtifactContext";

type ArtifactsTab = "preview" | "context";

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  entries: unknown[];
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, entries }: ArtifactsPanelProps) {
  const [activeTab, setActiveTab] = useState<ArtifactsTab>(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-tab");
    return saved === "preview" || saved === "context" ? saved : "preview";
  });

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
            className={`agent-artifacts-tab ${activeTab === "preview" ? "active" : ""}`}
            onClick={() => setActiveTab("preview")}
          >
            <FileText className="inline h-3 w-3 mr-1" />
            预览
          </button>
          <button
            type="button"
            className={`agent-artifacts-tab ${activeTab === "context" ? "active" : ""}`}
            onClick={() => setActiveTab("context")}
          >
            <BarChart3 className="inline h-3 w-3 mr-1" />
            上下文
          </button>
          <button type="button" className="agent-artifacts-close-btn" onClick={onToggleCollapse} title="关闭面板">
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tab 内容 */}
        <div className="flex-1 overflow-hidden">
          {activeTab === "preview" ? <ArtifactPreview entries={entries} /> : <ArtifactContext entries={entries} />}
        </div>
      </div>
    </>
  );
}
