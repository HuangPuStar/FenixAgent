/**
 * streamdown table patch — 修复表格最大化后下载/复制按钮无响应的问题。
 *
 * 根因：streamdown 的表格最大化组件（Co）通过 createPortal 将表格渲染到 document.body，
 * 但渲染的 DOM 结构中缺少 data-streamdown="table-wrapper" 属性。
 * streamdown 的复制/下载按钮（Te/Pe）依赖 closest('[data-streamdown="table-wrapper"]')
 * 来定位表格元素，因此在全屏视图下无法找到表格，点击无任何响应。
 *
 * 本模块通过 MutationObserver 检测全屏对话框的插入，
 * 并动态补全缺失的 data 属性，使按钮功能恢复。
 */

/** 为全屏表格对话框注入缺失的 data-streamdown 属性 */
function patchTableFullscreen(dialog: Element): void {
  // 全屏对话框内有一个 role="presentation" 的子 div，是按钮容器和表格的最近公共祖先
  // 为它加上 data-streamdown="table-wrapper"，使 Te/Pe 内的 closest() 查询能匹配到
  const wrapper = dialog.querySelector<HTMLElement>('[role="presentation"]');
  if (wrapper && !wrapper.hasAttribute("data-streamdown")) {
    wrapper.setAttribute("data-streamdown", "table-wrapper");
  }
}

/** 安装 MutationObserver，检测 DOM 中新增的 streamdown 表格全屏对话框 */
export function installStreamdownTablePatch(): void {
  if (typeof window === "undefined" || typeof MutationObserver === "undefined") return;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof Element)) continue;

        // 直接检测全屏对话框节点
        if (node.getAttribute("data-streamdown") === "table-fullscreen") {
          // React createPortal 可能尚未完成子节点渲染，用 rAF 延迟到下一帧
          requestAnimationFrame(() => patchTableFullscreen(node));
          return;
        }

        // 批量插入场景：新节点可能包含全屏对话框作为后代
        if (node.querySelector?.('[data-streamdown="table-fullscreen"]')) {
          const dialog = node.querySelector('[data-streamdown="table-fullscreen"]')!;
          requestAnimationFrame(() => patchTableFullscreen(dialog));
          return;
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}
