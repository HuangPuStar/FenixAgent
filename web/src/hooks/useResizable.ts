import { useCallback, useEffect, useRef, useState } from "react";

interface Size {
  width: number;
  height: number;
}

interface UseResizableOptions {
  initialWidth: number;
  initialHeight: number;
  minWidth?: number;
  minHeight?: number;
}

/**
 * 拖拽边缘调整元素尺寸的 hook。
 *
 * 通过 ref 保持拖拽开始时的快照，避免 state 依赖导致
 * 事件监听器频繁重新注册。
 */
export function useResizable({ initialWidth, initialHeight, minWidth = 400, minHeight = 300 }: UseResizableOptions) {
  const [size, setSize] = useState<Size>({ width: initialWidth, height: initialHeight });
  const sizeRef = useRef(size);
  sizeRef.current = size;

  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; edge: string } | null>(null);

  const handleMouseDown = useCallback((e: React.MouseEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: sizeRef.current.width,
      startH: sizeRef.current.height,
      edge,
    };
  }, []);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      const current = sizeRef.current;

      let newW = drag.startW;
      let newH = drag.startH;
      if (drag.edge.includes("e")) newW = Math.max(minWidth, drag.startW + dx);
      if (drag.edge.includes("s")) newH = Math.max(minHeight, drag.startH + dy);
      if (drag.edge.includes("w")) newW = Math.max(minWidth, drag.startW - dx);
      if (drag.edge.includes("n")) newH = Math.max(minHeight, drag.startH - dy);

      if (newW !== current.width || newH !== current.height) {
        setSize({ width: newW, height: newH });
      }
    };

    const handleMouseUp = () => {
      dragRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [minWidth, minHeight]);

  const resizeHandle = useCallback(
    (edge: string) => ({
      onMouseDown: (e: React.MouseEvent) => handleMouseDown(e, edge),
      className: edgeToClass(edge),
    }),
    [handleMouseDown],
  );

  return { size, resizeHandle };
}

function edgeToClass(edge: string): string {
  const map: Record<string, string> = {
    se: "absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10",
    sw: "absolute bottom-0 left-0 w-5 h-5 cursor-nesw-resize z-10",
    ne: "absolute top-0 right-0 w-5 h-5 cursor-nesw-resize z-10",
    nw: "absolute top-0 left-0 w-5 h-5 cursor-nwse-resize z-10",
    e: "absolute top-0 bottom-0 right-0 w-1.5 cursor-e-resize z-10",
    w: "absolute top-0 bottom-0 left-0 w-1.5 cursor-w-resize z-10",
    s: "absolute bottom-0 left-0 right-0 h-1.5 cursor-s-resize z-10",
    n: "absolute top-0 left-0 right-0 h-1.5 cursor-n-resize z-10",
  };
  return map[edge] || "absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize z-10";
}
