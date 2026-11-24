import type { TFunction } from "i18next";
import { ChevronLeft, ChevronRight, Maximize, Minus, Plus, RotateCw } from "lucide-react";
import type { EventBus, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";

/** Reading controls use the official PDF.js viewer's public navigation and scale API. */
export function PdfToolbar({
  viewer,
  eventBus,
  t,
  onInteraction,
}: {
  viewer: PDFViewer;
  eventBus: EventBus;
  t: TFunction;
  onInteraction: () => void;
}) {
  const read = useCallback(
    () => ({ page: viewer.currentPageNumber, pages: viewer.pagesCount, scale: viewer.currentScale }),
    [viewer],
  );
  const [state, setState] = useState(read);
  const [page, setPage] = useState(String(state.page));
  useEffect(() => {
    const update = () => {
      const next = read();
      setState(next);
      setPage(String(next.page));
    };
    for (const event of ["pagesinit", "pagechanging", "scalechanging", "rotationchanging"]) eventBus.on(event, update);
    update();
    return () => {
      for (const event of ["pagesinit", "pagechanging", "scalechanging", "rotationchanging"])
        eventBus.off(event, update);
    };
  }, [read, eventBus]);
  const go = (number: number) => {
    if (Number.isInteger(number) && number >= 1 && number <= state.pages) {
      onInteraction();
      viewer.currentPageNumber = number;
    } else setPage(String(state.page));
  };
  const action = (run: () => void) => {
    onInteraction();
    run();
  };
  return (
    <div
      className="flex items-center justify-center gap-0.5 overflow-x-auto border-b border-border bg-background px-1 py-1"
      role="toolbar"
      aria-label={t("fileTree.preview.pdf.controls")}
    >
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("fileTree.preview.pdf.previous")}
        title={t("fileTree.preview.pdf.previous")}
        disabled={state.pages === 0 || state.page <= 1}
        onClick={() => go(state.page - 1)}
      >
        <ChevronLeft />
      </Button>
      <Input
        className="h-7 w-10 px-1 text-center"
        aria-label={t("fileTree.preview.pdf.pageNumber")}
        inputMode="numeric"
        value={page}
        disabled={state.pages === 0}
        onChange={(event) => setPage(event.target.value)}
        onBlur={() => go(Number(page))}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            go(Number(page));
          }
        }}
      />
      <span className="px-1 text-xs text-text-muted">/ {state.pages}</span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("fileTree.preview.pdf.next")}
        title={t("fileTree.preview.pdf.next")}
        disabled={state.page >= state.pages}
        onClick={() => go(state.page + 1)}
      >
        <ChevronRight />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("fileTree.preview.pdf.zoomOut")}
        title={t("fileTree.preview.pdf.zoomOut")}
        disabled={!state.pages || state.scale <= 0.25}
        onClick={() =>
          action(() => {
            viewer.currentScale = Math.max(0.25, viewer.currentScale / 1.2);
          })
        }
      >
        <Minus />
      </Button>
      <span className="min-w-9 text-center text-xs tabular-nums">
        {state.scale > 0 ? Math.round(state.scale * 100) : 100}%
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("fileTree.preview.pdf.zoomIn")}
        title={t("fileTree.preview.pdf.zoomIn")}
        disabled={!state.pages || state.scale >= 4}
        onClick={() =>
          action(() => {
            viewer.currentScale = Math.min(4, viewer.currentScale * 1.2);
          })
        }
      >
        <Plus />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("fileTree.preview.pdf.fitWidth")}
        title={t("fileTree.preview.pdf.fitWidth")}
        disabled={!state.pages}
        onClick={() =>
          action(() => {
            viewer.currentScaleValue = "page-width";
          })
        }
      >
        <Maximize />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("fileTree.preview.pdf.rotate")}
        title={t("fileTree.preview.pdf.rotate")}
        disabled={!state.pages}
        onClick={() =>
          action(() => {
            viewer.pagesRotation = (viewer.pagesRotation + 90) % 360;
          })
        }
      >
        <RotateCw />
      </Button>
    </div>
  );
}
