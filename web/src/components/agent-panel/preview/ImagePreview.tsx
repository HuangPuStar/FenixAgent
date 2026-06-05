import { Loader2, Minus, Plus, RotateCw } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { encodePathSegment } from "./utils";

interface ImagePreviewProps {
  envId: string;
  filePath: string;
}

export function ImagePreview({ envId, filePath }: ImagePreviewProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  const src = `/web/environments/${envId}/user/${filePath.split("/").map(encodePathSegment).join("/")}?preview=true`;

  const handleLoad = useCallback(() => setLoading(false), []);
  const handleError = useCallback(() => {
    setLoading(false);
    setError(true);
  }, []);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(z + 0.125, 5)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(z - 0.125, 0.125)), []);
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const handleWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.min(5, Math.max(0.125, z + (e.deltaY > 0 ? -0.125 : 0.125))));
    setPan({ x: 0, y: 0 });
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (zoom <= 1) return;
      isPanning.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
    },
    [zoom],
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastPos.current.x;
    const dy = e.clientY - lastPos.current.y;
    lastPos.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* 缩放控制栏 */}
      <div className="flex items-center justify-center gap-1 px-3 py-1.5 shrink-0 border-b bg-surface-2/50">
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom <= 0.125}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-surface-2 disabled:opacity-30"
          title="缩小"
        >
          <Minus className="h-4 w-4" />
        </button>
        <span className="text-xs tabular-nums w-12 text-center text-text-muted">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom >= 5}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-surface-2 disabled:opacity-30"
          title="放大"
        >
          <Plus className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={resetZoom}
          className="h-7 w-7 flex items-center justify-center rounded hover:bg-surface-2"
          title="还原"
        >
          <RotateCw className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* 图片区域 */}
      <div
        className="flex-1 flex items-center justify-center overflow-hidden cursor-grab active:cursor-grabbing"
        onWheel={handleWheel}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
      >
        {loading && <Loader2 className="h-6 w-6 animate-spin text-text-muted" />}
        {error && <p className="text-sm text-status-error">{t("fileTree.preview.fetchFailed")}</p>}
        <img
          src={src}
          alt={filePath.split("/").pop() ?? ""}
          onLoad={handleLoad}
          onError={handleError}
          draggable={false}
          className="select-none"
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: "center center",
            maxWidth: "none",
            display: loading || error ? "none" : "block",
          }}
        />
      </div>
    </div>
  );
}
