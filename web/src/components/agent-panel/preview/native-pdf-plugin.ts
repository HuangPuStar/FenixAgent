import type { PreviewContext, PreviewInstance, PreviewPlugin } from "@open-file-viewer/core";

/**
 * 使用浏览器原生 PDF 查看器的预览插件。
 *
 * 直接用 iframe 加载 PDF，利用 Chrome/Edge/Firefox 等浏览器内置渲染引擎，
 * 无需额外 worker。加载失败时通过 setError 让 @open-file-viewer 统一展示兜底。
 */
export function nativePdfPlugin(): PreviewPlugin {
  return {
    name: "fenix-native-pdf",

    match(file) {
      return file.extension?.toLowerCase() === "pdf";
    },

    render(ctx: PreviewContext): PreviewInstance {
      const { viewport, file, setLoading, setError } = ctx;
      const src = file.url ?? (typeof file.source === "string" ? file.source : undefined);

      if (!src) {
        setError("无法获取 PDF 文件的预览地址");
        return { destroy: () => {} };
      }

      const container = document.createElement("div");
      container.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;";

      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.style.cssText = "flex:1;width:100%;border:none;background:#fff;";
      iframe.title = file.name;
      iframe.addEventListener("load", () => setLoading(false));
      iframe.addEventListener("error", () => {
        setLoading(false);
        setError("PDF 预览加载失败");
      });

      container.appendChild(iframe);
      viewport.appendChild(container);
      setLoading(true);

      return {
        resize(_size) {
          // iframe 自适应
        },
        destroy() {
          container.remove();
        },
      };
    },
  };
}
