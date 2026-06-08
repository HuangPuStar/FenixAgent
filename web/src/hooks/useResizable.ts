import { useCallback, useRef, useState } from "react";

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
 * 拖拽期间直接操作 DOM 保证严格跟手，松手后同步到 React state。
 * 返回 ref 用于绑定到目标 DOM 元素。
 */
export function useResizable({ initialWidth, initialHeight, minWidth = 400, minHeight = 300 }: UseResizableOptions) {
  const [size, setSize] = useState<Size>({ width: initialWidth, height: initialHeight });

  const elRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; startW: number; startH: number; edge: string } | null>(null);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, edge: string) => {
      e.preventDefault();
      e.stopPropagation();

      const el = elRef.current;
      if (!el) return;

      const startW = el.offsetWidth;
      const startH = el.offsetHeight;

      dragRef.current = { startX: e.clientX, startY: e.clientY, startW, startH, edge };

      const onMove = (ev: MouseEvent) => {
        const drag = dragRef.current;
        if (!drag) return;
        const dx = ev.clientX - drag.startX;
        const dy = ev.clientY - drag.startY;

        let newW = drag.startW;
        let newH = drag.startH;
        if (drag.edge.includes("e")) newW = Math.max(minWidth, drag.startW + dx);
        if (drag.edge.includes("s")) newH = Math.max(minHeight, drag.startH + dy);
        if (drag.edge.includes("w")) newW = Math.max(minWidth, drag.startW - dx);
        if (drag.edge.includes("n")) newH = Math.max(minHeight, drag.startH - dy);

        // 直接操作 DOM，保证跟手
        el.style.width = `${newW}px`;
        el.style.height = `${newH}px`;
      };

      const onUp = () => {
        dragRef.current = null;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);

        // 拖拽结束后同步到 React state
        if (elRef.current) {
          const finalW = elRef.current.offsetWidth;
          const finalH = elRef.current.offsetHeight;
          setSize({ width: finalW, height: finalH });
        }
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [minWidth, minHeight],
  );

  const resizeHandle = useCallback(
    (edge: string) => ({
      onMouseDown: (e: React.MouseEvent) => handleMouseDown(e, edge),
      className: edgeToClass(edge),
    }),
    [handleMouseDown],
  );

  return { size, resizeHandle, ref: elRef };
}

function edgeToClass(edge: string): string {
  const map: Record<string, string> = {
    se: "absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-10",
    sw: "absolute bottom-0 left-0 w-6 h-6 cursor-nesw-resize z-10",
    ne: "absolute top-0 right-0 w-6 h-6 cursor-nesw-resize z-10",
    nw: "absolute top-0 left-0 w-6 h-6 cursor-nwse-resize z-10",
    e: "absolute top-0 bottom-0 right-0 w-2 cursor-e-resize z-10",
    w: "absolute top-0 bottom-0 left-0 w-2 cursor-w-resize z-10",
    s: "absolute bottom-0 left-0 right-0 h-2 cursor-s-resize z-10",
    n: "absolute top-0 left-0 right-0 h-2 cursor-n-resize z-10",
  };
  return map[edge] || "absolute bottom-0 right-0 w-6 h-6 cursor-nwse-resize z-10";
}
