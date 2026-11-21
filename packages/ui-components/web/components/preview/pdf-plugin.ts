import type { PreviewInstance, PreviewPlugin, PreviewSize } from "@open-file-viewer/core";

/** Load PDF.js only for PDF files and fence asynchronous mounting after disposal. */
export function pdfPreviewPlugin(load: () => Promise<PreviewPlugin>): PreviewPlugin {
  return {
    name: "fenix-pdf",
    match: (file) => file.extension?.toLowerCase() === "pdf" || file.mimeType === "application/pdf",
    render(ctx) {
      let disposed = false;
      let instance: PreviewInstance | undefined;
      let size: PreviewSize = ctx.size;
      ctx.setLoading(true);
      void load()
        .then(async (plugin) => {
          if (disposed) return;
          const loaded = await plugin.render({ ...ctx, size });
          if (disposed) loaded.destroy();
          else {
            instance = loaded;
            instance.resize?.(size);
            ctx.toolbar?.refreshCommandSupport();
          }
        })
        .catch((error: unknown) => {
          if (disposed) return;
          console.error("[pdf-preview] Failed to load PDF", error);
          ctx.setLoading(false);
          ctx.setError(error instanceof Error ? error : new Error("PDF preview failed"));
        });
      return {
        command: (command) => instance?.command?.(command),
        canCommand: (command) => instance?.canCommand?.(command) ?? false,
        resize(next) {
          size = next;
          instance?.resize?.(next);
        },
        destroy() {
          disposed = true;
          instance?.destroy();
        },
      };
    },
  };
}
