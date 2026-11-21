/// <reference types="vite/client" />
import type { PreviewPlugin } from "@open-file-viewer/core";
import type { TFunction } from "i18next";
import { AnnotationMode, GlobalWorkerOptions, getDocument, type PDFDocumentLoadingTask, version } from "pdfjs-dist";
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from "pdfjs-dist/web/pdf_viewer.mjs";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import "pdfjs-dist/web/pdf_viewer.css";
import { PdfToolbar } from "./pdf-toolbar";

/** Bind the official viewer to the existing file preview lifecycle and local resource bundle. */
export function createPdfPlugin(t: TFunction, onInteraction: () => void): PreviewPlugin {
  const assets = `${import.meta.env.BASE_URL}pdfjs/${version}/`;
  GlobalWorkerOptions.workerSrc = `${assets}pdf.worker.min.mjs`;
  return {
    name: "pdfjs",
    match: (file) => file.extension === "pdf" || file.mimeType === "application/pdf",
    render(ctx) {
      const root = document.createElement("div");
      root.dataset.pdfPreview = "true";
      root.className = "absolute inset-0 flex min-h-0 flex-col";
      const toolbar = document.createElement("div");
      const body = document.createElement("div");
      body.className = "relative min-h-0 flex-1";
      const container = document.createElement("div");
      container.className = "absolute inset-0 overflow-auto bg-surface-2";
      const pages = document.createElement("div");
      pages.className = "pdfViewer";
      container.append(pages);
      body.append(container);
      root.append(toolbar, body);
      ctx.viewport.append(root);
      const eventBus = new EventBus();
      const links = new PDFLinkService({
        eventBus,
        externalLinkTarget: LinkTarget.BLANK,
        externalLinkRel: "noopener noreferrer",
      });
      const viewer = new PDFViewer({
        container,
        viewer: pages,
        eventBus,
        linkService: links,
        annotationMode: AnnotationMode.ENABLE,
        imageResourcesPath: `${assets}images/`,
      });
      links.setViewer(viewer);
      let disposed = false;
      let task: PDFDocumentLoadingTask | undefined;
      const toolbarRoot = createRoot(toolbar);
      toolbarRoot.render(createElement(PdfToolbar, { viewer, eventBus, t, onInteraction }));
      eventBus.on("pagesinit", () => {
        viewer.currentScaleValue = "page-width";
        ctx.setLoading(false);
      });
      const fail = (error: unknown) => {
        if (disposed) return;
        console.error("[pdf-preview] Document loading failed", error);
        ctx.setLoading(false);
        ctx.setError(
          t(
            (error as { name?: string })?.name === "PasswordException"
              ? "fileTree.preview.pdf.encrypted"
              : "fileTree.preview.pdf.invalid",
          ),
        );
      };
      void (async () => {
        const blob = ctx.file.blob ?? (ctx.file.source instanceof Blob ? ctx.file.source : null);
        if (!blob) throw new Error("PDF preview requires host-provided file bytes");
        const data = new Uint8Array(await blob.arrayBuffer());
        if (disposed) return;
        task = getDocument({
          data,
          cMapUrl: `${assets}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${assets}standard_fonts/`,
          wasmUrl: `${assets}wasm/`,
          iccUrl: `${assets}iccs/`,
          enableXfa: false,
        });
        const document = await task.promise;
        if (disposed) return;
        links.setDocument(document);
        viewer.setDocument(document);
      })().catch(fail);
      return {
        resize() {
          if (!disposed && viewer.pagesCount) {
            if (viewer.currentScaleValue === "page-width") viewer.currentScaleValue = "page-width";
            else viewer.update();
          }
        },
        destroy() {
          disposed = true;
          queueMicrotask(() => toolbarRoot.unmount());
          viewer.setDocument(null);
          links.setDocument(null);
          if (task) void task.destroy().catch((error) => console.error("[pdf-preview] Cleanup failed", error));
          root.remove();
        },
      };
    },
  };
}
