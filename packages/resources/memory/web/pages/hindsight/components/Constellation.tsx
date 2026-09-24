/**
 * `Constellation` —— 记忆星座图（自绘 canvas）的渲染壳（§4.8 中两套刻意分叉的图谱之一）。
 *
 * 本文件只留下「挂载 canvas → 驱动动画帧 → 装配鼠标 / 滚轮事件 → 渲染外壳」这条编排：
 * 场景准备在 `constellation-scene.ts`、交互状态在 `constellation-state.ts`、逐帧绘制在
 * `constellation-paint.ts`（图例在 `constellation-legend.ts`、标签在 `constellation-labels.ts`）、
 * tooltip 在 `constellation-tooltip.ts`。图形逻辑不与 `Graph2d`（Cytoscape.js）归一——
 * 两者的渲染模型不同，抽公共层只会得到一层薄转发（已裁定，见前端规范 §4.8）。
 */

import { useTheme } from "@fenix/ui-components/lib/theme";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Maximize2, Minimize2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { paintConstellationFrame } from "./constellation-paint";
import { prepareConstellationScene } from "./constellation-scene";
import { createConstellationViewState } from "./constellation-state";
import { updateConstellationTooltip } from "./constellation-tooltip";
import type { GraphData, GraphLink, GraphNode } from "./graph-model";

export interface ConstellationProps {
  data: GraphData;
  height?: number;
  onNodeClick?: (node: GraphNode) => void;
  nodeColorFn?: (node: GraphNode) => string;
  linkColorFn?: (link: GraphLink) => string;
  /**
   * Optional override for the on-screen dot radius (in CSS pixels, pre-zoom).
   * When omitted, radius is derived from link count (default star-field behavior).
   * Used by the entities view to scale dots by total co-occurrence weight.
   */
  nodeSizeFn?: (node: GraphNode) => number;
  /**
   * When true, pack labels densely: small deconfliction footprint and no zoom
   * threshold. Appropriate for graphs with short labels (e.g. entity names)
   * where the memory-page truncated-text defaults would hide most of them.
   */
  compactLabels?: boolean;
  /**
   * Optional override for the node heat gradient (0..1 where 1 = hottest).
   * Default is a normalized link-count. Use this to map color to a different
   * dimension — e.g. recency — while keeping size mapped to something else.
   */
  nodeHeatFn?: (node: GraphNode) => number;
  /**
   * Caption for the heat-gradient legend (default: "LINKS"). Use when nodeHeatFn
   * represents something other than connectivity — e.g. "RECENCY".
   */
  heatLegendLabel?: string;
  /**
   * Captions for the heat-gradient endpoints (default: "few" → "many").
   */
  heatLegendEndpoints?: [string, string];
  /**
   * When set, draws a "small dot → big dot" legend entry with this caption.
   * Use this when nodeSizeFn encodes a meaningful dimension (e.g. "source facts",
   * "co-occurrences") so the reader knows what the node size represents.
   */
  sizeLegendLabel?: string;
}

export function Constellation({
  data,
  height = 700,
  onNodeClick,
  nodeColorFn,
  linkColorFn,
  nodeSizeFn,
  nodeHeatFn,
  heatLegendLabel,
  heatLegendEndpoints,
  compactLabels,
  sizeLegendLabel,
}: ConstellationProps) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  // 暗色判定改读主题上下文（原为本地 MutationObserver 副本，与 Graph2d.tsx 里的那份逐字相同）。
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const animRef = useRef<number>(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Interaction state stored in ref for perf (avoid re-renders on every frame)
  const stateRef = useRef(createConstellationViewState());

  // ----- Prepare data with Pretext -----
  const scene = useMemo(
    () => prepareConstellationScene(data, { nodeColorFn, linkColorFn, nodeHeatFn }),
    [data, nodeColorFn, linkColorFn, nodeHeatFn],
  );
  const { preparedNodes } = scene;

  // ----- Animation loop -----
  // 只负责取 canvas / 取上下文 / 画一帧 / 排下一帧；绘制过程本身在 constellation-paint.ts。
  // 取不到上下文时直接返回、不排帧（迁移前同形）。
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    paintConstellationFrame(ctx, canvas, {
      state: stateRef.current,
      scene,
      isDark,
      compactLabels: !!compactLabels,
      nodeSizeFn,
      t,
      heatLegendLabel,
      heatLegendEndpoints,
      sizeLegendLabel,
    });

    animRef.current = requestAnimationFrame(animate);
  }, [scene, isDark, compactLabels, nodeSizeFn, t, heatLegendLabel, heatLegendEndpoints, sizeLegendLabel]);

  // ----- Setup & resize -----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      const rect = canvas.getBoundingClientRect();
      const W = rect.width;
      const H = rect.height;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      stateRef.current.dpr = dpr;
      stateRef.current.W = W;
      stateRef.current.H = H;
    };

    resize();

    // Auto-fit zoom based on node spread
    if (preparedNodes.length > 0) {
      let maxR = 0;
      for (const n of preparedNodes) {
        const d = Math.sqrt(n.wx * n.wx + n.wy * n.wy);
        if (d > maxR) maxR = d;
      }
      const fitZoom = maxR > 0 ? Math.min(stateRef.current.W, stateRef.current.H) / (maxR * 2.5) : 0.5;
      stateRef.current.zoom = fitZoom;
      stateRef.current.targetZoom = fitZoom;
    }

    animRef.current = requestAnimationFrame(animate);

    // 父容器与 fullscreen 变化都需要同步 canvas backing store。
    const resizeObserver = new ResizeObserver(resize);
    if (wrapperRef.current) resizeObserver.observe(wrapperRef.current);

    // Events
    const handleResize = () => resize();

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 0.9 : 1.1;
      stateRef.current.targetZoom = Math.max(0.03, Math.min(8, stateRef.current.targetZoom * factor));
    };

    const updateTooltip = (mx: number, my: number) => {
      updateConstellationTooltip({
        tip: tooltipRef.current,
        scene,
        state: stateRef.current,
        isDark,
        t,
        mouse: { x: mx, y: my },
      });
    };

    const handleMouseMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      stateRef.current.mouseX = mx;
      stateRef.current.mouseY = my;

      if (stateRef.current.isDragging) {
        stateRef.current.targetPanX = stateRef.current.panStartX + (e.clientX - stateRef.current.dragStartX);
        stateRef.current.targetPanY = stateRef.current.panStartY + (e.clientY - stateRef.current.dragStartY);
        canvas.style.cursor = "grabbing";
        if (tooltipRef.current) tooltipRef.current.style.display = "none";
      } else {
        canvas.style.cursor = stateRef.current.hoverIndex >= 0 ? "pointer" : "default";
        updateTooltip(mx, my);
      }
    };

    const handleMouseDown = (e: MouseEvent) => {
      stateRef.current.isDragging = true;
      stateRef.current.dragStartX = e.clientX;
      stateRef.current.dragStartY = e.clientY;
      stateRef.current.panStartX = stateRef.current.panX;
      stateRef.current.panStartY = stateRef.current.panY;
    };

    const handleMouseUp = () => {
      // If we didn't drag far, treat as click
      if (stateRef.current.isDragging) {
        const dx = Math.abs(stateRef.current.panX - stateRef.current.panStartX);
        const dy = Math.abs(stateRef.current.panY - stateRef.current.panStartY);
        if (dx < 3 && dy < 3 && stateRef.current.hoverIndex >= 0) {
          const node = preparedNodes[stateRef.current.hoverIndex]?.node;
          if (node && onNodeClick) onNodeClick(node);
        }
      }
      stateRef.current.isDragging = false;
      canvas.style.cursor = stateRef.current.hoverIndex >= 0 ? "pointer" : "default";
    };

    const handleMouseLeave = () => {
      stateRef.current.mouseX = -1;
      stateRef.current.mouseY = -1;
      stateRef.current.isDragging = false;
      stateRef.current.hoverIndex = -1;
      if (tooltipRef.current) tooltipRef.current.style.display = "none";
    };

    window.addEventListener("resize", handleResize);
    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("mousemove", handleMouseMove);
    canvas.addEventListener("mousedown", handleMouseDown);
    canvas.addEventListener("mouseup", handleMouseUp);
    canvas.addEventListener("mouseleave", handleMouseLeave);

    return () => {
      cancelAnimationFrame(animRef.current);
      window.removeEventListener("resize", handleResize);
      resizeObserver.disconnect();
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("mousemove", handleMouseMove);
      canvas.removeEventListener("mousedown", handleMouseDown);
      canvas.removeEventListener("mouseup", handleMouseUp);
      canvas.removeEventListener("mouseleave", handleMouseLeave);
    };
  }, [animate, scene, preparedNodes, onNodeClick, isDark, t]);

  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((prev) => !prev);
  }, []);

  // Esc to exit fullscreen
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [isFullscreen]);

  return (
    <div
      ref={wrapperRef}
      style={
        isFullscreen
          ? {
              position: "fixed",
              inset: 0,
              zIndex: 50,
              background: isDark ? "#09090b" : "#ffffff",
            }
          : { position: "relative", width: "100%", height: `${height}px` }
      }
    >
      <canvas ref={canvasRef} style={{ width: "100%", height: "100%", display: "block" }} />

      {/* Fullscreen toggle — 图标改用 lucide 的 `Maximize2` / `Minimize2`（原为两份逐字相同的内联
          SVG 属性块，只差 polyline/line 子元素；路径与 14px 尺寸逐点对应，见 commit 正文）。 */}
      <button
        onClick={toggleFullscreen}
        style={{
          position: "absolute",
          top: 8,
          right: 8,
          zIndex: 21,
          padding: "6px 10px",
          borderRadius: 6,
          border: `1px solid ${isDark ? "#27272a" : "#e4e4e7"}`,
          background: isDark ? "#18181b" : "#ffffff",
          color: isDark ? "#a1a1aa" : "#71717a",
          fontSize: 12,
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: 4,
          opacity: 0.7,
          transition: "opacity 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "1";
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLButtonElement).style.opacity = "0.7";
        }}
        title={isFullscreen ? t("constellation.exitFullscreenTitle") : t("constellation.enterFullscreenTitle")}
      >
        {isFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
        {isFullscreen ? t("constellation.exitFullscreenLabel") : t("constellation.enterFullscreenLabel")}
      </button>

      {/* Tooltip */}
      <div
        ref={tooltipRef}
        style={{
          display: "none",
          position: "absolute",
          pointerEvents: "none",
          zIndex: 22,
          maxWidth: 360,
          padding: "10px 14px",
          borderRadius: 8,
          fontSize: 12,
          lineHeight: 1.5,
          boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
          border: `1px solid ${isDark ? "#27272a" : "#e4e4e7"}`,
          background: isDark ? "#18181b" : "#ffffff",
          color: isDark ? "#e4e4e7" : "#18181b",
        }}
      />
    </div>
  );
}
