import { expect, test } from "bun:test";
import { act } from "react";
import { button, host, render, settle, setWorkspaceWidth } from "./workspace-editing-fixture";

/** happy-dom 不发送 ResizeObserver 回调，这里只补发真实面板完成布局后的尺寸通知。 */
function renderWithSizeNotifications() {
  const ResizeObserverImplementation = window.ResizeObserver;
  const report = new Map<Element, () => void>();
  window.ResizeObserver = class extends ResizeObserverImplementation {
    private readonly callback: ResizeObserverCallback;

    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.callback = callback;
    }

    override observe(target: Element) {
      if (!(target instanceof HTMLElement)) return;
      report.set(target, () => {
        const size = { inlineSize: target.offsetWidth, blockSize: target.offsetHeight };
        this.callback(
          [
            {
              target,
              contentRect: target.getBoundingClientRect(),
              borderBoxSize: [size],
              contentBoxSize: [size],
              devicePixelContentBoxSize: [size],
            },
          ],
          this,
        );
      });
    }
  };
  try {
    render([], null);
  } finally {
    window.ResizeObserver = ResizeObserverImplementation;
  }
  return (target: Element) => {
    const callback = report.get(target);
    if (!callback) throw new Error("Missing size observer");
    act(callback);
  };
}

// 收起固定列会把整列宽度还给预览，展开后恢复用户保存的宽度。
test("the file tree collapses to zero and restores the preferred width", async () => {
  localStorage.setItem("fenix:file-tree-width", "240");
  const notifySize = renderWithSizeNotifications();
  await settle();
  const [tree, preview] = host.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');

  const collapse = button("Collapse file tree");
  expect(tree.style.flexGrow).toBe("30");
  expect(preview.style.flexGrow).toBe("70");

  const separator = host.querySelector('[role="separator"]');
  if (!separator) throw new Error("File tree resize handle missing");
  const event = new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
  act(() => separator.dispatchEvent(event));
  notifySize(tree);
  expect(localStorage.getItem("fenix:file-tree-width")).toBe("280");

  collapse.focus();
  act(() => collapse.click());
  const expand = button("Expand file tree");
  expect(document.activeElement).toBe(expand);
  expect(tree.inert).toBe(true);
  expect(tree.style.flexGrow).toBe("0");
  expect(preview.style.flexGrow).toBe("100");
  notifySize(tree);
  expect(localStorage.getItem("fenix:file-tree-width")).toBe("280");

  act(() => expand.click());
  expect(document.activeElement).toBe(button("Collapse file tree"));
  expect(tree.inert).toBe(false);
  expect(tree.style.flexGrow).toBe("35");
  expect(preview.style.flexGrow).toBe("65");
});

// 拖窄外层工作区时树最多占一半，已收起的树继续让预览占满宽度。
test("narrower workspaces clamp an expanded tree and keep a collapsed tree at zero", async () => {
  localStorage.setItem("fenix:file-tree-width", "240");
  const notifySize = renderWithSizeNotifications();
  await settle();
  const [tree, preview] = host.querySelectorAll<HTMLElement>('[data-slot="resizable-panel"]');
  if (!tree.parentElement) throw new Error("File tree panel group missing");
  const group = tree.parentElement;
  expect(tree.offsetWidth).toBe(240);
  notifySize(tree);

  setWorkspaceWidth(356);
  notifySize(group);
  notifySize(tree);
  expect(tree.offsetWidth).toBe(178);
  expect(preview.offsetWidth).toBe(178);
  expect(localStorage.getItem("fenix:file-tree-width")).toBe("240");

  act(() => button("Collapse file tree").click());
  setWorkspaceWidth(800);
  notifySize(group);
  notifySize(tree);
  expect(tree.offsetWidth).toBe(0);
  expect(preview.offsetWidth).toBe(800);
  expect(localStorage.getItem("fenix:file-tree-width")).toBe("240");

  act(() => button("Expand file tree").click());
  notifySize(tree);
  expect(tree.offsetWidth).toBe(240);
});

// 开合列时复用当前文件预览和树节点，避免 iframe 重载以及搜索框状态丢失。
test("toggling the file tree keeps the mounted tree and preview", async () => {
  render(["page.html"], "page.html");
  for (let index = 0; index < 10 && !host.querySelector('iframe[title="page.html"]'); index++) await settle();
  const frame = host.querySelector('iframe[title="page.html"]');
  const search = host.querySelector("input[placeholder]");
  expect(frame).not.toBeNull();
  expect(search).not.toBeNull();

  act(() => button("Collapse file tree").click());
  expect(host.querySelector('iframe[title="page.html"]')).toBe(frame);
  expect(host.querySelector("input[placeholder]")).toBe(search);
  act(() => button("Expand file tree").click());
  expect(host.querySelector('iframe[title="page.html"]')).toBe(frame);
  expect(host.querySelector("input[placeholder]")).toBe(search);
});
