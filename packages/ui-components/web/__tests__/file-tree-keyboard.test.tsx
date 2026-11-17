// 与门禁口径一致使用 --isolate，Radix Portal 在模块求值时缓存 DOM 能力。
import { afterAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { I18nextProvider } from "react-i18next";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { initializeHappyDomWindow } from "../testing";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost/" }));
const globals = globalThis as Record<string, unknown>;
const constructors = [
  "Element",
  "HTMLElement",
  "SVGElement",
  "Node",
  "Image",
  "Event",
  "KeyboardEvent",
  "CustomEvent",
  "MutationObserver",
  "ResizeObserver",
  "customElements",
] as const;
const injected = {
  window: win,
  document: win.document,
  navigator: win.navigator,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
  IS_REACT_ACT_ENVIRONMENT: true,
  ...Object.fromEntries(constructors.map((key) => [key, win[key]])),
};
const originals = new Map(Object.keys(injected).map((key) => [key, globals[key]]));
Object.assign(globals, injected);
const heightDescriptor = Object.getOwnPropertyDescriptor(win.HTMLElement.prototype, "clientHeight");
Object.defineProperty(win.HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 240 });

// Portal 与拖拽库在求值时读取 DOM，必须在隔离的浏览器环境建立后加载真实组件。
const { createRoot } = await import("react-dom/client");
const { FileTreeArborist } = await import("../components/file-tree-arborist");
const i18n = createInstance();
await i18n.init({ lng: "zh", initAsync: false, resources: { zh: { [UI_COMPONENTS_NS]: zh } } });

afterAll(async () => {
  if (heightDescriptor) Object.defineProperty(win.HTMLElement.prototype, "clientHeight", heightDescriptor);
  else Reflect.deleteProperty(win.HTMLElement.prototype, "clientHeight");
  await win.happyDOM.abort();
  for (const [key, value] of originals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 等待 Portal 完成挂载，不依赖文件行内部按钮的程序化 focus。 */
async function tooltipText(): Promise<string> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const tooltip = document.querySelector('[role="tooltip"]');
    if (tooltip) return tooltip.textContent ?? "";
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  }
  return "";
}

/** 把按键发给用户当前焦点，保留 Arborist 原生树导航。 */
async function press(key: string): Promise<void> {
  await act(async () => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

// 标准树导航聚焦外层 treeitem，完整信息必须随焦点移动且允许 Escape 关闭、Tab 离开。
test("树的键盘导航可查看并关闭完整文件元数据", async () => {
  const host = document.createElement("div");
  const after = document.createElement("button");
  after.textContent = "after";
  document.body.append(host, after);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <FileTreeArborist
            data={[
              { name: "empty.txt", path: "empty.txt", isDir: false, children: [], size: 0, modifiedAt: 1794912000000 },
              { name: "data.txt", path: "data.txt", isDir: false, children: [], size: 1024, modifiedAt: 1794912000000 },
            ]}
            expandedIds={[]}
            selectedPaths={[]}
            onSelect={() => {}}
            onSelectionChange={() => {}}
            onDragStart={() => {}}
            onDragEnd={() => {}}
            onToggle={() => {}}
            onRefresh={() => {}}
            onNewFile={() => {}}
          />
        </I18nextProvider>,
      );
    });
    await act(async () => host.querySelector<HTMLElement>('[role="tree"]')?.focus());
    expect(document.activeElement?.getAttribute("role")).toBe("treeitem");
    expect(await tooltipText()).toContain("0 字节");
    expect(document.activeElement?.getAttribute("aria-label")).toContain("修改时间");

    await press("ArrowDown");
    expect(await tooltipText()).toContain("1,024 字节");
    expect(document.activeElement?.getAttribute("aria-label")).toContain("data.txt");
    await press("Escape");
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
    await press("Tab");
    expect(document.activeElement).toBe(after);
  } finally {
    await act(async () => root.unmount());
    host.remove();
    after.remove();
  }
});
