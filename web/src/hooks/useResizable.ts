import { useCallback, useEffect, useRef, useState } from "react";

interface Size {
  width: number;
  height: number;
  offsetX: number;
  offsetY: number;
}

interface UseResizableOptions {
  initialWidth: number;
  initialHeight: number;
  minWidth?: number;
  minHeight?: number;
  externalOffsetX?: number;
  externalOffsetY?: number;
}

/**
 * Resize an element from its edges.
 *
 * During drag, dimensions are applied directly to the target DOM node so heavy
 * preview content does not re-render on every pointer event. React state is
 * synchronized when the drag ends.
 */
export function useResizable({
  initialWidth,
  initialHeight,
  minWidth = 400,
  minHeight = 300,
  externalOffsetX = 0,
  externalOffsetY = 0,
}: UseResizableOptions) {
  const [size, setSize] = useState<Size>({ width: initialWidth, height: initialHeight, offsetX: 0, offsetY: 0 });
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const externalOffsetRef = useRef({ x: externalOffsetX, y: externalOffsetY });
  externalOffsetRef.current = { x: externalOffsetX, y: externalOffsetY };

  const targetRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingRef = useRef<Size | null>(null);
  const dragRef = useRef<{
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    startOffsetX: number;
    startOffsetY: number;
    edge: string;
  } | null>(null);

  const applySize = useCallback((next: Size) => {
    sizeRef.current = next;
    const target = targetRef.current;
    if (!target) return;
    target.style.width = `${next.width}px`;
    target.style.height = `${next.height}px`;
    const externalOffset = externalOffsetRef.current;
    target.style.transform = `translate(calc(-50% + ${next.offsetX + externalOffset.x}px), calc(-50% + ${
      next.offsetY + externalOffset.y
    }px))`;
  }, []);

  const scheduleApplySize = useCallback(
    (next: Size) => {
      pendingRef.current = next;
      if (frameRef.current !== null) return;
      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null;
        const pending = pendingRef.current;
        if (!pending) return;
        pendingRef.current = null;
        applySize(pending);
      });
    },
    [applySize],
  );

  const handlePointerDown = useCallback((e: React.PointerEvent, edge: string) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      startW: sizeRef.current.width,
      startH: sizeRef.current.height,
      startOffsetX: sizeRef.current.offsetX,
      startOffsetY: sizeRef.current.offsetY,
      edge,
    };
    document.body.style.cursor = edgeToCursor(edge);
    document.body.style.userSelect = "none";
  }, []);

  useEffect(() => {
    const handlePointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;

      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let newW = drag.startW;
      let newH = drag.startH;
      let newOffsetX = drag.startOffsetX;
      let newOffsetY = drag.startOffsetY;

      if (drag.edge.includes("e")) newW = Math.max(minWidth, drag.startW + dx);
      if (drag.edge.includes("s")) newH = Math.max(minHeight, drag.startH + dy);
      if (drag.edge.includes("w")) newW = Math.max(minWidth, drag.startW - dx);
      if (drag.edge.includes("n")) newH = Math.max(minHeight, drag.startH - dy);
      if (drag.edge.includes("w")) newOffsetX = drag.startOffsetX + (drag.startW - newW) / 2;
      if (drag.edge.includes("n")) newOffsetY = drag.startOffsetY + (drag.startH - newH) / 2;

      scheduleApplySize({ width: newW, height: newH, offsetX: newOffsetX, offsetY: newOffsetY });
    };

    const finishResize = () => {
      if (!dragRef.current) return;
      dragRef.current = null;
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
      if (pendingRef.current) {
        applySize(pendingRef.current);
        pendingRef.current = null;
      }
      setSize(sizeRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", finishResize);
    document.addEventListener("pointercancel", finishResize);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", finishResize);
      document.removeEventListener("pointercancel", finishResize);
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
  }, [applySize, minWidth, minHeight, scheduleApplySize]);

  const resizeHandle = useCallback(
    (edge: string) => ({
      onPointerDown: (e: React.PointerEvent) => handlePointerDown(e, edge),
      className: edgeToClass(edge),
    }),
    [handlePointerDown],
  );

  return { size, resizeHandle, targetRef };
}

function edgeToClass(edge: string): string {
  const map: Record<string, string> = {
    se: "absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize touch-none z-10",
    sw: "absolute bottom-0 left-0 w-5 h-5 cursor-nesw-resize touch-none z-10",
    ne: "absolute top-0 right-0 w-5 h-5 cursor-nesw-resize touch-none z-10",
    nw: "absolute top-0 left-0 w-5 h-5 cursor-nwse-resize touch-none z-10",
    e: "absolute top-0 bottom-0 right-0 w-1.5 cursor-e-resize touch-none z-10",
    w: "absolute top-0 bottom-0 left-0 w-1.5 cursor-w-resize touch-none z-10",
    s: "absolute bottom-0 left-0 right-0 h-1.5 cursor-s-resize touch-none z-10",
    n: "absolute top-0 left-0 right-0 h-1.5 cursor-n-resize touch-none z-10",
  };
  return map[edge] || "absolute bottom-0 right-0 w-5 h-5 cursor-nwse-resize touch-none z-10";
}

function edgeToCursor(edge: string): string {
  const map: Record<string, string> = {
    se: "nwse-resize",
    sw: "nesw-resize",
    ne: "nesw-resize",
    nw: "nwse-resize",
    e: "e-resize",
    w: "w-resize",
    s: "s-resize",
    n: "n-resize",
  };
  return map[edge] || "nwse-resize";
}
