/**
 * 原生 PDF 预览插件（从 apps/web 的 `agent-panel/preview/native-pdf-plugin.ts` 逐字复制）。
 *
 * 纯化取舍：
 * 1. 无任何宿主 import —— 只依赖 `@open-file-viewer/core` 类型与浏览器原生 iframe，
 *    因此本模块零改动即可入包。
 * 2. 错误串「无法获取 PDF 文件的预览地址」「PDF 预览加载失败」为**硬编码中文**（与源实现一致）：
 *    插件在非 React 上下文里通过 `setError` 上报，接入宿主 i18n 需要在插件工厂上新增 t 参数，
 *    属契约扩张；需要多语言的宿主应自行派生插件（见 README 已知限制）。
 * 3. 插件名 `fenix-native-pdf` 与源实现保持一致，避免宿主按插件名做排序/去重时行为分叉。
 */

import type { PreviewContext, PreviewInstance, PreviewPlugin } from "@open-file-viewer/core";
import { PREVIEW_FRAME_CONTAINER_STYLE, PREVIEW_FRAME_IFRAME_STYLE } from "./internal/frame-styles";

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
      container.style.cssText = PREVIEW_FRAME_CONTAINER_STYLE;

      const iframe = document.createElement("iframe");
      iframe.src = src;
      iframe.style.cssText = PREVIEW_FRAME_IFRAME_STYLE;
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
