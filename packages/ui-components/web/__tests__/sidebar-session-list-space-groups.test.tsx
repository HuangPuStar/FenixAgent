// 侧栏 space 分组树的渲染与交互测试。
//
// 覆盖的用户可见行为：分组归属（含未归属会话落「默认」）、折叠后组内会话消失、组名重命名回调、
// 删除确认后清理 space 归属，未注入 spaces 时退化为时间分组，以及**拖拽写入归属**（乐观重排、
// 移出归属、松手在分组外不写、写失败回退、宿主未接回调时的静默）。分组与入口的展示顺序见
// `chat-space-review-regressions.test.tsx`（本文件已接近 500 行红线，顺序契约放在那里）。
// 断言按文本与回调写，不做纯样式断言；装配沿用 `acp-main-sidebar-scroll-area.test.tsx`
// （真实组件 + happy-dom + 真实 i18n 实例 + 最小 fake 回调），拖拽用 `space-drag-harness.ts` 的
// 假布局 + 真实指针事件驱动，因此落库断言真的经过 dnd-kit 的整条链路。
//
// **必须与 `--isolate` 同跑**（`precheck` 的三批全量与 `fastcheck` 的影响批次都带该开关）。同进程连续求值
// 多个测试文件时，本文件会假失败：`@radix-ui/react-use-layout-effect` 在**模块求值期**按
// `globalThis?.document` 是否存在决定导出 `React.useLayoutEffect` 还是空函数 `() => {}`
// （`dist/index.mjs`），而 demo 冒烟测试在 `import` 阶段就静态拉起了 Radix，此时全局 document 尚未注入 ——
// 该模块此后对全进程退化为空函数，折叠的内容隐藏与 AlertDialog 的 Portal 挂载都不会发生。
// 同一批次的 KaTeX 用例（`markdown-math-plugin.test.ts`）失败同理。实测：不带 `--isolate` 整目录运行，
// 原生 Radix 折叠/弹窗（不含本包任何代码）同样失效，可据此确认与本文件无关。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { DEFAULT_SPACE_DROP_ID } from "../chat/lib/space-drop-target";
import type { ChatNotice, ChatSpaceItem } from "../chat/shell/chat-interface-types";
import type { SessionSummary } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { dragSessionTo, installSpaceDragHarness } from "./space-drag-harness";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 同一 realm 的 DOM 全局对象。除 Tooltip / Collapsible 依赖的 ResizeObserver、requestAnimationFrame 外，
// 还需注入事件构造器与 Node 系：Radix 的 dismissable-layer / focus-scope 用全局构造器造事件，
// 缺失时 `event instanceof Event` 判定失败，删除确认流程整体抛
// `Failed to execute 'dispatchEvent' … parameter 1 is not of type 'Event'`。
const win = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = win;
globalRecord.document = win.document;
globalRecord.navigator = win.navigator;
globalRecord.ResizeObserver = win.ResizeObserver;
globalRecord.getComputedStyle = win.getComputedStyle.bind(win);
globalRecord.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globalRecord.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globalRecord.MutationObserver = win.MutationObserver;
globalRecord.Event = win.Event;
globalRecord.CustomEvent = win.CustomEvent;
globalRecord.MouseEvent = win.MouseEvent;
globalRecord.KeyboardEvent = win.KeyboardEvent;
globalRecord.Element = win.Element;
globalRecord.HTMLElement = win.HTMLElement;
// `HTMLElement` 与 `customElements` 成对注入：只注入前者会让后续文件里 streamdown 的
// web-components 判定崩在测试之间的空档里（约定见 `web/testing.ts` 头部说明）。
globalRecord.customElements = win.customElements;
globalRecord.Node = win.Node;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

const ACTIVE_SESSION_ID = "ses-active";

const dragHarness = installSpaceDragHarness(win);
// 分组渲染顺序即落点横条顺序：space 在前、默认垫底。
dragHarness.setDropOrder(["space:space-1", DEFAULT_SPACE_DROP_ID]);

/** 三个会话覆盖三种归属：活动会话、未归属会话、space 内会话；时间戳同时覆盖时间分组的回归场景。 */
const SESSIONS: SessionSummary[] = [
  {
    sessionId: ACTIVE_SESSION_ID,
    title: "活动会话",
    preview: "",
    status: "active",
    lastMsgTs: 3,
    updatedAt: new Date().toISOString(),
  },
  {
    sessionId: "ses-default",
    title: "未归属会话",
    preview: "",
    status: "idle",
    lastMsgTs: 2,
    updatedAt: new Date(Date.now() - 60_000).toISOString(),
  },
  {
    sessionId: "ses-space",
    title: "空间内会话",
    preview: "",
    status: "idle",
    lastMsgTs: 1,
    updatedAt: new Date(Date.now() - 120_000).toISOString(),
  },
];

const SPACES: ChatSpaceItem[] = [{ id: "space-1", name: "空间一", sessionIds: ["ses-space"] }];

interface Harness {
  container: HTMLElement;
  root: Root;
  renamedSpaces: Array<[string, string]>;
  createdSpaces: string[];
  deletedSessions: string[];
  unassignedSessions: string[];
  /** 归属写入（spaceId + sessionId）：拖拽落点经它落库 */
  assignedSessions: Array<[string, string]>;
  notices: ChatNotice[];
  /** 点击指定 aria-label 的第一个按钮 */
  clickButton(label: string, scope?: ParentNode): void;
  /** 按可见文本点击按钮（无 aria-label 的文字按钮，如「新建空间」） */
  clickButtonByText(text: string): void;
  /** 写入输入框值（绕过 React 的 value tracker）后返回元素 */
  typeInto(element: HTMLInputElement, value: string): void;
  /** 聚焦再失焦以触发提交（happy-dom 下键盘事件不派发给 React，提交路径用 blur 覆盖） */
  blur(element: HTMLInputElement): void;
  update(props: Record<string, unknown>): Promise<void>;
  unmount(): Promise<void>;
}

/** 渲染 `SidebarSessionList`；未显式覆盖的 props 使用本文件的 space 样本。 */
async function renderList(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const { SidebarSessionList } = await import("../chat/shell/sidebar-session-list");
  const renamedSpaces: Array<[string, string]> = [];
  const createdSpaces: string[] = [];
  const deletedSessions: string[] = [];
  const unassignedSessions: string[] = [];
  const assignedSessions: Array<[string, string]> = [];
  const notices: ChatNotice[] = [];
  const container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  const root = createRoot(container);

  const element = (props: Record<string, unknown>) =>
    createElement(SidebarSessionList, {
      initialActiveSessionId: ACTIVE_SESSION_ID,
      sessions: SESSIONS,
      spaces: SPACES,
      spacesLoaded: true,
      onRenameSession: () => {},
      onDeleteSession: (sessionId: string) => deletedSessions.push(sessionId),
      onRenameSpace: (spaceId: string, name: string) => renamedSpaces.push([spaceId, name]),
      onCreateSpace: (name: string) => createdSpaces.push(name),
      onAssignSession: (spaceId: string, sessionId: string) => assignedSessions.push([spaceId, sessionId]),
      onUnassignSession: (sessionId: string) => unassignedSessions.push(sessionId),
      onNotice: (notice: ChatNotice) => notices.push(notice),
      ...props,
    });

  await act(async () => {
    root.render(element(overrides));
  });

  return {
    container,
    root,
    renamedSpaces,
    createdSpaces,
    deletedSessions,
    unassignedSessions,
    assignedSessions,
    notices,
    clickButton(label: string, scope?: ParentNode) {
      const button = (scope ?? container).querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
      if (!button) throw new Error(`未找到按钮：${label}`);
      act(() => {
        button.click();
      });
    },
    clickButtonByText(text: string) {
      const button = Array.from(container.querySelectorAll("button")).find(
        (candidate) => candidate.textContent?.trim() === text,
      );
      if (!button) throw new Error(`未找到按钮：${text}`);
      act(() => {
        button.click();
      });
    },
    typeInto(element: HTMLInputElement, value: string) {
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      act(() => {
        setter?.call(element, value);
        element.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      });
    },
    blur(element: HTMLInputElement) {
      act(() => {
        element.focus();
        element.blur();
      });
    },
    async update(props) {
      await act(async () => root.render(element({ ...overrides, ...props })));
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** 组内新建/重命名相关的悬浮按钮（`hidden group-hover:flex` 只影响视觉，程序化点击仍可达）。 */
function rowButton(container: HTMLElement, sessionId: string, label: string): HTMLButtonElement {
  const button = container.querySelector(
    `[data-session-id="${sessionId}"] button[aria-label="${label}"]`,
  ) as HTMLButtonElement | null;
  if (!button) throw new Error(`会话 ${sessionId} 未渲染按钮：${label}`);
  return button;
}

/**
 * 把某条会话拖到指定分组（`null` = 松手在分组之外）。
 *
 * 拖拽是会话归属的唯一写入路径（2026-10-16 起行内菜单已删除），因此落库断言必须真的走一遍
 * 指针链路；假布局与两次 `pointermove` 的必要性见 `space-drag-harness.ts` 头部说明。
 */
async function dragTo(harness: Harness, sessionId: string, dropId: string | null): Promise<void> {
  const point = dropId === null ? dragHarness.outsidePoint() : dragHarness.centerOf(dropId);
  await dragSessionTo(win, harness.container, sessionId, act, point);
}

/** 会话是否落在指定放置目标的分组里（组归属的唯一可观察判据是 DOM 从属关系）。 */
function isSessionInGroup(container: HTMLElement, dropId: string, sessionId: string): boolean {
  const group = container.querySelector(`[data-space-drop-id="${dropId}"]`);
  return group?.querySelector(`[data-session-id="${sessionId}"]`) !== null;
}

describe("SidebarSessionList space 分组", () => {
  // space 名与「默认」分组名同时出现，未归属会话落默认分组、space 内会话落对应分组。
  test("渲染分组名并按归属分配会话", async () => {
    const harness = await renderList();
    const text = harness.container.textContent ?? "";
    expect(text).toContain("空间一");
    expect(text).toContain("Default");
    expect(text).toContain("未归属会话");
    expect(text).toContain("空间内会话");
    await harness.unmount();
  });

  // 折叠默认分组只隐藏它自己的会话行，其它分组的内容不受影响。
  test("折叠分组后组内会话消失，展开后恢复", async () => {
    const harness = await renderList();
    harness.clickButton("Collapse space: Default");
    expect(harness.container.textContent ?? "").not.toContain("未归属会话");
    expect(harness.container.textContent ?? "").toContain("空间内会话");
    harness.clickButton("Expand space: Default");
    expect(harness.container.textContent ?? "").toContain("未归属会话");
    await harness.unmount();
  });

  // 组头重命名提交后回调带上 spaceId 与新名称（默认分组不提供重命名入口）。
  test("重命名 space 回调携带 spaceId 与新名称", async () => {
    const harness = await renderList();
    expect(harness.container.querySelectorAll('button[aria-label="Rename space"]')).toHaveLength(1);
    harness.clickButton("Rename space");
    const input = harness.container.querySelector('input[aria-label="Rename space"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (input) {
      harness.typeInto(input, "空间二");
      harness.blur(input);
    }
    expect(harness.renamedSpaces).toEqual([["space-1", "空间二"]]);
    await harness.unmount();
  });

  // 未改名的失焦不产生写入：宿主数据仍是权威，本地不制造等价写。
  test("未改名时失焦不触发回调", async () => {
    const harness = await renderList();
    harness.clickButton("Rename space");
    const input = harness.container.querySelector('input[aria-label="Rename space"]') as HTMLInputElement | null;
    if (input) harness.blur(input);
    expect(harness.renamedSpaces).toEqual([]);
    await harness.unmount();
  });

  // 新建空间入口提交名称后回调一次，且输入框收起。
  test("新建空间提交名称给上层", async () => {
    const harness = await renderList();
    harness.clickButtonByText("New space");
    const input = harness.container.querySelector('input[aria-label="New space"]') as HTMLInputElement | null;
    expect(input).not.toBeNull();
    if (input) {
      harness.typeInto(input, "空间三");
      harness.blur(input);
    }
    expect(harness.createdSpaces).toEqual(["空间三"]);
    expect(harness.container.querySelector('input[aria-label="New space"]')).toBeNull();
    await harness.unmount();
  });

  // 删除确认通过后：宿主删除会话，同时清理它在 space 里的归属。
  test("删除会话后调用 onUnassignSession", async () => {
    const harness = await renderList();
    const deleteButton = rowButton(harness.container, "ses-space", "Delete");
    act(() => {
      deleteButton.click();
    });
    const confirm = Array.from(win.document.querySelectorAll('[role="alertdialog"] button')).find(
      (button) => button.textContent?.trim() === "Delete",
    ) as HTMLButtonElement | undefined;
    expect(confirm).toBeDefined();
    act(() => {
      confirm?.click();
    });
    expect(harness.deletedSessions).toEqual(["ses-space"]);
    expect(harness.unassignedSessions).toEqual([]);
    await harness.update({ sessions: [...SESSIONS] });
    expect(harness.unassignedSessions).toEqual([]);
    await harness.update({ sessions: SESSIONS.filter((session) => session.sessionId !== "ses-space") });
    expect(harness.unassignedSessions).toEqual(["ses-space"]);
    await harness.unmount();
  });

  // 未注入 spaces 时退化为时间分组：不出现 space 分组名与新建空间入口。
  test("未注入 spaces 时保持时间分组", async () => {
    const harness = await renderList({ spaces: undefined, spacesLoaded: undefined });
    const text = harness.container.textContent ?? "";
    expect(text).toContain("Today");
    expect(text).not.toContain("Default");
    expect(harness.container.querySelector('button[aria-label="New space"]')).toBeNull();
    await harness.unmount();
  });

  // spacesLoaded 为 false 且尚无会话时保持 loading：不能把「未加载」显示成「暂无会话」。
  test("spacesLoaded 为 false 且无会话时保持 loading", async () => {
    const harness = await renderList({ sessions: [], loading: false, spacesLoaded: false });
    expect(harness.container.textContent ?? "").not.toContain("No sessions");
    await harness.unmount();
  });
});

/**
 * 分组列表加载失败的用户可见出口。
 *
 * 判据与 knowledge / prod-view 的失败态一致：没有别的内容可显示（无会话）时错误块整区接管；
 * 仍有会话时只提示、不接管——会话列表是另一路数据且仍然可用，为分组失败阻断会话切换代价更大。
 * 两种形态都必须带重试入口：失败不得映射成 empty / 永久 loading，也不得只写 `console.error`
 * （前端规范 §3.4 / §5.8）。
 */
describe("SidebarSessionList space 加载失败", () => {
  // 无会话时错误块整区接管：既不是永久 loading（Spinner），也不是「暂无会话」空态。
  test("无会话且加载失败时渲染可重试错误态", async () => {
    let refreshes = 0;
    const harness = await renderList({
      sessions: [],
      spaces: undefined,
      spacesLoaded: false,
      spacesError: true,
      onRefreshSpaces: () => {
        refreshes += 1;
      },
    });

    const text = harness.container.textContent ?? "";
    expect(text).toContain("Failed to load spaces");
    expect(text).not.toContain("No sessions");
    expect(harness.container.querySelector('[role="alert"]')).not.toBeNull();

    harness.clickButtonByText("Retry");
    expect(refreshes).toBe(1);
    await harness.unmount();
  });

  // 有会话时错误提示与列表并存：会话仍可切换（接管列表会让用户在后端故障期间无法切换会话）。
  test("有会话时提示失败但保留会话列表", async () => {
    const harness = await renderList({
      spaces: undefined,
      spacesLoaded: false,
      spacesError: true,
      onRefreshSpaces: () => {},
    });

    const text = harness.container.textContent ?? "";
    expect(text).toContain("Failed to load spaces");
    expect(text).toContain("Today");
    expect(text).toContain("活动会话");
    await harness.unmount();
  });

  // 未失败时不得出现错误态：「尚未加载」与「加载失败」是两回事，错误出口不能被前者误触发。
  test("加载中不出现错误态", async () => {
    const harness = await renderList({ spaces: undefined, spacesLoaded: false, spacesError: false });
    expect(harness.container.textContent ?? "").not.toContain("Failed to load spaces");
    await harness.unmount();
  });
});

/**
 * 拖拽装配与归属写入的测试。
 *
 * 拖拽是会话归属的**唯一**写入路径（2026-10-16 按用户要求删除行内「移动到…」菜单后，触屏与键盘
 * 暂时没有等效入口），所以这里既断言装配信号（`data-draggable-session` / `data-space-drop-id`
 * 是 dnd-kit 不写自己的 DOM 属性时唯一可断言的装配信号），也**真的拖一次**：
 * `space-drag-harness.ts` 用假布局补齐 happy-dom 缺失的矩形，再用指针事件驱动完整链路。
 * 落点语义（拖到自身分组不写、拖到列表外不写等）由 `space-drop-target-pure.test.ts` 逐分支覆盖。
 */
describe("SidebarSessionList space 拖拽装配与归属写入", () => {
  // 每组会话行都是拖拽源，每个分组（含默认）都是放置目标，且放置 id 与分组一一对应；
  // 渲染顺序即「space 在前、默认在最底」。
  test("会话行装配拖拽源，分组装配放置目标", async () => {
    const harness = await renderList();
    expect(harness.container.querySelectorAll("[data-draggable-session]")).toHaveLength(SESSIONS.length);
    const dropIds = Array.from(harness.container.querySelectorAll("[data-space-drop-id]")).map((element) =>
      element.getAttribute("data-space-drop-id"),
    );
    expect(dropIds).toEqual(["space:space-1", DEFAULT_SPACE_DROP_ID]);
    await harness.unmount();
  });

  // 拖到某个分组：立刻按新归属重排（乐观展示），并调用 onAssignSession 落库。
  test("拖到分组后立刻重排并写入归属", async () => {
    const harness = await renderList();
    await dragTo(harness, "ses-default", "space:space-1");
    expect(harness.assignedSessions).toEqual([["space-1", "ses-default"]]);
    expect(isSessionInGroup(harness.container, "space:space-1", "ses-default")).toBe(true);
    await harness.unmount();
  });

  // 拖到「默认」分组等于移出归属：调用 onUnassignSession，会话立刻回到默认分组。
  test("拖到默认分组等于移出归属", async () => {
    const harness = await renderList();
    await dragTo(harness, "ses-space", DEFAULT_SPACE_DROP_ID);
    expect(harness.unassignedSessions).toEqual(["ses-space"]);
    expect(isSessionInGroup(harness.container, DEFAULT_SPACE_DROP_ID, "ses-space")).toBe(true);
    await harness.unmount();
  });

  // 松手在分组之外（列表空白）不改归属：没有落点就没有写入，界面也不该乐观重排。
  test("松手在分组之外不改归属", async () => {
    const harness = await renderList();
    await dragTo(harness, "ses-default", null);
    expect(harness.assignedSessions).toEqual([]);
    expect(harness.unassignedSessions).toEqual([]);
    expect(isSessionInGroup(harness.container, DEFAULT_SPACE_DROP_ID, "ses-default")).toBe(true);
    await harness.unmount();
  });

  // 写入失败必须撤销乐观重排并提示：界面不能停在一次没有落库的移动上。
  // 失败用「手动 reject」而不是立即 rejected 的 promise：后者会在拖拽手势的 act 里就结算，
  // 乐观态来不及被观察到，用例也就退回成只验证最终结果。
  test("归属写入失败时回退并提示", async () => {
    let failWrite: (error: Error) => void = () => {};
    const harness = await renderList({
      onAssignSession: () =>
        new Promise<void>((_resolve, reject) => {
          failWrite = reject;
        }),
    });
    await dragTo(harness, "ses-default", "space:space-1");
    expect(isSessionInGroup(harness.container, "space:space-1", "ses-default")).toBe(true);
    await act(async () => failWrite(new Error("boom")));
    expect(isSessionInGroup(harness.container, DEFAULT_SPACE_DROP_ID, "ses-default")).toBe(true);
    expect(harness.notices.map((notice) => notice.level)).toEqual(["error"]);
    await harness.unmount();
  });

  // 宿主没接写入回调时拖动不产生任何写入、也不乐观重排：画出一个永远不会落库的归属比不动更糟。
  test("未接入归属写入时拖动不产生写入", async () => {
    const harness = await renderList({ onAssignSession: undefined, onUnassignSession: undefined });
    await dragTo(harness, "ses-default", "space:space-1");
    expect(harness.assignedSessions).toEqual([]);
    expect(isSessionInGroup(harness.container, DEFAULT_SPACE_DROP_ID, "ses-default")).toBe(true);
    await harness.unmount();
  });

  // 时间分组路径没有分组可归，也就没有拖拽层：既不注册拖拽源，也不注册放置目标。
  test("未注入 spaces 时不装配拖拽", async () => {
    const harness = await renderList({ spaces: undefined, spacesLoaded: undefined });
    expect(harness.container.querySelector("[data-draggable-session]")).toBeNull();
    expect(harness.container.querySelector("[data-space-drop-id]")).toBeNull();
    await harness.unmount();
  });
});
