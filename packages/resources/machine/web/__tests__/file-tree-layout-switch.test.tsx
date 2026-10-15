// web/__tests__/file-tree-layout-switch.test.tsx
// 文件树「浮动 / 固定」的接线行为：默认值来自屏宽还是已存偏好、切换控件写不写 localStorage、
// 浮动浮层的开合与重开入口。
//
// 为什么必须渲染而不是扫源码：默认判定是**两步**（未手动选择 → 屏宽；已手动选择 → 用户意志），
// 每一步都跨 hook / 控件 / 容器三层接线；浮层开合是本地状态。两者都只有真跑一遍才看得到。
//
// 环境：happy-dom + react-dom/client（与同批包的组件用例同款）。被测组件以 `envId=null` 挂载——
// 该环境下不拉文件树、不开 `/web/file-events`，布局行为与远端状态无关，用例因此不碰网络。
// 断点用 `matchMedia` 替身驱动：happy-dom 会按窗口宽度求值，但不派发 `change`，跨断点跟随测不到。
//
// 全局卫生（与 tickets / channel 的写动作用例同款）：`bun test` 在同一进程里依次求值全部测试文件，
// 三条都按「会泄漏给后续文件」处理——DOM 全局每例重放、`afterAll` 还原快照；i18n 只经
// `I18nextProvider` 注入而**不**注册全局默认实例（`initReactI18next` 会把进程级默认换成中文，
// 让后续文件里「`t()` 回显 key」的 SSR 断言整体失败）；`HTMLElement` 与 `customElements` 成对注入
// （见 `@fenix/ui-components/web/testing.ts` 的记录：只注入前者会让后续加载 streamdown 的文件崩掉）。

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance, type i18n as I18nInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";

import { ArtifactsFilesWorkspace } from "../components/artifacts-files-workspace";
import { MACHINE_NS, machineResources } from "../i18n/index";
import { FILE_TREE_DOCKED_MEDIA_QUERY, FILE_TREE_LAYOUT_STORAGE_KEY } from "../lib/file-tree-layout";

const win = initializeHappyDomWindow(new Window({ url: "https://localhost:3000" }));
const globals = globalThis as Record<string, unknown>;

/** DOM 全局构造器：同进程的其它文件会读写它们，故每例重放。 */
const DOM_GLOBALS = [
  "CustomEvent",
  "DOMRect",
  "Element",
  "Event",
  "HTMLElement",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "ResizeObserver",
  "customElements",
] as const;

const TRACKED_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "IS_REACT_ACT_ENVIRONMENT",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  ...DOM_GLOBALS,
] as const;

const originalGlobals = new Map<string, unknown>(TRACKED_GLOBALS.map((key) => [key, globals[key]] as const));

function applyDomGlobals(): void {
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.localStorage = win.localStorage;
  globals.IS_REACT_ACT_ENVIRONMENT = true;
  for (const key of DOM_GLOBALS) {
    globals[key] = (win as unknown as Record<string, unknown>)[key];
  }
  globals.getComputedStyle = win.getComputedStyle.bind(win);
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
}

applyDomGlobals();

/** 用例断言到的文案取自真实字典（zh）：控件能否被无障碍读到由 `aria-label` 承担，回显 key 即为漏配。 */
const i18n: I18nInstance = createInstance();
await i18n.init({
  lng: "zh",
  fallbackLng: "zh",
  defaultNS: MACHINE_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: {
    zh: { [MACHINE_NS]: machineResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
  },
});

/** 断点替身：记录被问到的是哪个查询，并允许用例手动翻转匹配结果以模拟缩放。 */
function installDockedQuery(initialMatches: boolean) {
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const questions: string[] = [];
  const list = {
    matches: initialMatches,
    media: FILE_TREE_DOCKED_MEDIA_QUERY,
    addEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: MediaQueryListEvent) => void) => listeners.delete(listener),
    dispatchEvent: () => true,
    onchange: null,
  };
  (win as unknown as Record<string, unknown>).matchMedia = (query: string) => {
    questions.push(query);
    return list;
  };

  return {
    questions,
    /** 模拟视口跨过断点：媒体查询对象按新值通知订阅者（真实浏览器由 `change` 事件承担）。 */
    emit(matches: boolean) {
      list.matches = matches;
      act(() => {
        for (const listener of listeners) listener({ matches } as MediaQueryListEvent);
      });
    },
  };
}

function renderWorkspace(): { container: HTMLElement; root: Root } {
  const container = win.document.createElement("div");
  win.document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ArtifactsFilesWorkspace
          envId={null}
          fileTreeRef={{ current: null }}
          openFiles={[]}
          activeFile={null}
          changedFiles={[]}
          onSelectFile={() => {}}
          onCloseFile={() => {}}
          onOpenFile={() => {}}
          onReferenceFile={() => {}}
        />
      </I18nextProvider>,
    );
  });
  return { container, root };
}

/** 布局模式以工作台根节点的 `data-tree-layout` 为准（两种模式各一份几何，不靠类名猜）。 */
function layoutOf(container: HTMLElement): string | null {
  return container.querySelector("[data-tree-layout]")?.getAttribute("data-tree-layout") ?? null;
}

function buttonByLabel(container: HTMLElement, label: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

let mounted: Root | null = null;
let dockedQuery = installDockedQuery(true);

beforeEach(() => {
  applyDomGlobals();
  win.localStorage.clear();
  dockedQuery = installDockedQuery(true);
});

afterEach(() => {
  act(() => mounted?.unmount());
  mounted = null;
  win.document.body.innerHTML = "";
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

describe("文件树浮动 / 固定接线", () => {
  // 业务意图：未手动选择 + 大屏 → 固定（保持现有占位行为），且不因渲染就写偏好（「没选过」必须可辨）。
  test("未手动选择：大屏默认固定，且不写偏好", () => {
    const { container, root } = renderWorkspace();
    mounted = root;

    expect(layoutOf(container)).toBe("docked");
    expect(container.querySelector('[data-slot="file-tree-overlay"]')).toBeNull();
    // 大屏默认固定 → 控件给出的动作是「浮动文件树」（当前状态与动作互斥，与面板的 `panelMode.*` 同款口径）。
    expect(buttonByLabel(container, "浮动文件树")).not.toBeNull();
    expect(dockedQuery.questions).toContain(FILE_TREE_DOCKED_MEDIA_QUERY);
    expect(win.localStorage.getItem(FILE_TREE_LAYOUT_STORAGE_KEY)).toBeNull();
  });

  // 业务意图：未手动选择 + 小屏 → 浮动浮层呈现，主内容宽度不再被切走，且浮层可关闭。
  test("未手动选择：小屏默认浮动，浮层与关闭入口都在", () => {
    dockedQuery = installDockedQuery(false);
    const { container, root } = renderWorkspace();
    mounted = root;

    expect(layoutOf(container)).toBe("floating");
    expect(container.querySelector('[data-slot="file-tree-overlay"]')).not.toBeNull();
    expect(buttonByLabel(container, "固定文件树")).not.toBeNull();
    expect(buttonByLabel(container, "关闭文件树")).not.toBeNull();
    expect(win.localStorage.getItem(FILE_TREE_LAYOUT_STORAGE_KEY)).toBeNull();
  });

  // 业务意图：没选过的用户缩放窗口时布局要跟着断点走（否则「按屏宽默认」只在刷新那一刻成立）。
  test("未手动选择：跨断点缩放跟随屏宽", () => {
    const { container, root } = renderWorkspace();
    mounted = root;
    expect(layoutOf(container)).toBe("docked");

    act(() => dockedQuery.emit(false));
    expect(layoutOf(container)).toBe("floating");

    act(() => dockedQuery.emit(true));
    expect(layoutOf(container)).toBe("docked");
  });

  // 业务意图：点切换控件 → 立刻换版式并记为显式选择（持久化）；此后缩放不再覆盖用户意志。
  test("切换控件：写入 localStorage 后屏宽不再覆盖", () => {
    const { container, root } = renderWorkspace();
    mounted = root;

    const toggle = buttonByLabel(container, "浮动文件树");
    expect(toggle).not.toBeNull();
    act(() => toggle?.click());

    expect(layoutOf(container)).toBe("floating");
    expect(win.localStorage.getItem(FILE_TREE_LAYOUT_STORAGE_KEY)).toBe("floating");

    // 切到浮动后再落到小屏、再回大屏，模式都不变——显式选择优先于屏宽。
    act(() => dockedQuery.emit(false));
    expect(layoutOf(container)).toBe("floating");
    act(() => dockedQuery.emit(true));
    expect(layoutOf(container)).toBe("floating");
  });

  // 业务意图：浮动模式下关掉浮层后主内容完全露出，且必须有重开入口（否则用户无法再找回文件树）。
  test("浮动模式下关闭浮层后可重开", () => {
    dockedQuery = installDockedQuery(false);
    const { container, root } = renderWorkspace();
    mounted = root;

    const close = buttonByLabel(container, "关闭文件树");
    act(() => close?.click());
    expect(container.querySelector('[data-slot="file-tree-overlay"]')).toBeNull();

    const reopen = buttonByLabel(container, "显示文件树");
    expect(reopen).not.toBeNull();
    act(() => reopen?.click());
    expect(container.querySelector('[data-slot="file-tree-overlay"]')).not.toBeNull();
  });

  // 业务意图：用户已明确要求记住选择——已存的「固定」在小屏下也必须生效（默认值不得盖掉偏好）。
  test("已存偏好优先于屏宽默认", () => {
    win.localStorage.setItem(FILE_TREE_LAYOUT_STORAGE_KEY, "docked");
    dockedQuery = installDockedQuery(false);
    const { container, root } = renderWorkspace();
    mounted = root;

    expect(layoutOf(container)).toBe("docked");
    expect(container.querySelector('[data-slot="file-tree-overlay"]')).toBeNull();
  });
});
