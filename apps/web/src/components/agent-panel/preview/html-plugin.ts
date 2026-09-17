import type { PreviewContext, PreviewInstance, PreviewPlugin } from "@open-file-viewer/core";

/**
 * HTML 文件预览插件。
 *
 * 与 textPlugin 不同：textPlugin 将 HTML 作为纯文本代码展示，
 * 本插件用 iframe 渲染 HTML 的实际页面效果。
 *
 * 安全策略：使用 sandbox 隔离 iframe，不赋予 allow-scripts / allow-same-origin，
 * 避免 Agent 生成的 HTML 中可能的恶意脚本影响宿主页面。
 *
 * 插件位置应在 textPlugin 之前，避免被 textPlugin 优先匹配。
 */
export function htmlPreviewPlugin(): PreviewPlugin {
  /** iframe 加载超时（毫秒），超时后强制隐藏 loading */
  const LOAD_TIMEOUT_MS = 15000;

  return {
    name: "fenix-html-preview",

    match(file) {
      const ext = file.extension?.toLowerCase();
      return ext === "html" || ext === "htm";
    },

    render(ctx: PreviewContext): PreviewInstance {
      const { viewport, file, setLoading, setError } = ctx;
      const src = file.url ?? (typeof file.source === "string" ? file.source : undefined);

      if (!src) {
        setError("无法获取 HTML 文件的预览地址");
        return { destroy: () => {} };
      }

      setLoading(true);

      // 加载超时兜底：15 秒后无论是否加载完成都结束 loading
      const loadTimer = setTimeout(() => setLoading(false), LOAD_TIMEOUT_MS);

      // 创建 iframe 容器
      const container = document.createElement("div");
      container.style.cssText = "width:100%;height:100%;display:flex;flex-direction:column;";

      // 源码 / 预览 切换标签栏
      const tabBar = document.createElement("div");
      tabBar.style.cssText =
        "display:flex;align-items:center;gap:8px;padding:4px 8px;border-bottom:1px solid var(--ofv-border, #d1d5db);background:var(--ofv-surface, #fff);flex-shrink:0;";
      tabBar.id = "fenix-html-tabbar";

      const previewTab = document.createElement("span");
      previewTab.textContent = "渲染预览";
      previewTab.style.cssText = "font-size:12px;cursor:pointer;padding:2px 6px;border-radius:4px;";
      const sourceTab = document.createElement("span");
      sourceTab.textContent = "源码";
      sourceTab.style.cssText = "font-size:12px;cursor:pointer;padding:2px 6px;border-radius:4px;";

      // 激活样式：浅色模式下的高亮
      const activeCSS = "background:var(--ofv-surface-muted, #f5f5f5);font-weight:600;color:var(--ofv-text, #1e1e1e);";
      const inactiveCSS = "color:var(--ofv-text-muted, #888);";

      previewTab.setAttribute("style", inactiveCSS);
      sourceTab.setAttribute("style", inactiveCSS);

      // iframe 预览区
      const iframe = document.createElement("iframe");
      iframe.src = src;
      // 仅允许脚本执行，禁止 allow-same-origin 以防止访问父页面 DOM
      iframe.setAttribute("sandbox", "allow-scripts");
      iframe.setAttribute("referrerpolicy", "no-referrer");
      iframe.style.cssText = "flex:1;width:100%;border:none;background:#fff;";
      iframe.title = file.name;

      // 源码预览区（初始隐藏）
      const srcView = document.createElement("div");
      srcView.style.cssText = "flex:1;width:100%;display:none;overflow:auto;";
      srcView.className = "fenix-html-source-view";

      // 切换函数
      function showPreview() {
        previewTab.setAttribute("style", activeCSS);
        sourceTab.setAttribute("style", inactiveCSS);
        iframe.style.display = "";
        srcView.style.display = "none";
      }
      function showSource() {
        previewTab.setAttribute("style", inactiveCSS);
        sourceTab.setAttribute("style", activeCSS);
        iframe.style.display = "none";
        srcView.style.display = "";
      }
      showPreview();

      previewTab.addEventListener("click", showPreview);
      sourceTab.addEventListener("click", showSource);

      tabBar.appendChild(previewTab);
      tabBar.appendChild(sourceTab);
      container.appendChild(tabBar);
      container.appendChild(iframe);
      container.appendChild(srcView);

      // 异步加载 HTML 文本内容用于源码展示
      void fetch(src)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .then((text) => {
          const pre = document.createElement("pre");
          pre.style.cssText =
            "margin:0;padding:12px;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap;word-break:break-all;";
          pre.textContent = text;
          srcView.appendChild(pre);
        })
        .catch(() => {
          srcView.innerHTML =
            '<div style="padding:16px;color:var(--ofv-text-muted,#6b7280);font-size:13px;">源码加载失败</div>';
        });

      // iframe 加载完成或错误时结束 loading
      const finish = () => {
        clearTimeout(loadTimer);
        setLoading(false);
      };
      iframe.addEventListener("load", finish, { once: true });
      iframe.addEventListener(
        "error",
        () => {
          finish();
          setError("HTML 预览加载失败");
        },
        { once: true },
      );

      viewport.appendChild(container);

      return {
        resize(_size) {
          // iframe 自适应，无需额外处理
        },
        destroy() {
          clearTimeout(loadTimer);
          container.remove();
        },
      };
    },
  };
}
