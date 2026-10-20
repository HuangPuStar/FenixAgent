import { expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { DEFAULT_SPACE_DROP_ID } from "../chat/lib/space-drop-target";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { dragSessionTo, installSpaceDragHarness } from "./space-drag-harness";

const win = initializeHappyDomWindow(new Window());
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  window: win,
  document: win.document,
  navigator: win.navigator,
  HTMLElement: win.HTMLElement,
  Element: win.Element,
  Node: win.Node,
  Event: win.Event,
  CustomEvent: win.CustomEvent,
  MouseEvent: win.MouseEvent,
  KeyboardEvent: win.KeyboardEvent,
  MutationObserver: win.MutationObserver,
  ResizeObserver: win.ResizeObserver,
  customElements: win.customElements,
  getComputedStyle: win.getComputedStyle.bind(win),
  requestAnimationFrame: win.requestAnimationFrame.bind(win),
  cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
});
const i18n = createInstance();
await i18n.use(initReactI18next).init({
  lng: "en",
  initAsync: false,
  defaultNS: UI_COMPONENTS_NS,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});
const { SidebarSessionList } = await import("../chat/shell/sidebar-session-list");

/** 拖拽夹具：本文件的分组顺序固定为「两个真实分组 + 默认垫底」（与 `render` 的 spaces 一致）。 */
const dragHarness = installSpaceDragHarness(win);

/**
 * 把会话 `s` 拖到指定分组：**归属写入的唯一路径**是指针拖拽（行内菜单已于 2026-10-16 删除），
 * 因此这里的竞争条件用例必须真的拖一次；假布局与两次 pointermove 的必要性见 `space-drag-harness.ts`。
 */
async function dragSessionToSpace(container: HTMLElement, dropId: string): Promise<void> {
  dragHarness.setDropOrder(["space:a", "space:b", DEFAULT_SPACE_DROP_ID]);
  await dragSessionTo(win, container, "s", act, dragHarness.centerOf(dropId));
}

/** 用真实事件覆盖焦点与连续写入，避免直接调用 handler 绕过浏览器事件顺序。 */
async function render(overrides: Record<string, unknown> = {}) {
  const container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  const root = createRoot(container);
  const writes: string[] = [];
  await act(async () =>
    root.render(
      createElement(SidebarSessionList, {
        initialActiveSessionId: null,
        onSelectSession: () => {},
        onRenameSession: () => {},
        onDeleteSession: () => {},
        spaces: [
          { id: "a", name: "Alpha", sessionIds: [] },
          { id: "b", name: "Beta", sessionIds: [] },
        ],
        spacesLoaded: true,
        sessions: [{ sessionId: "s", title: "Session", status: "idle", preview: "", lastMsgTs: 1 }],
        onCreateSpace: (name: string) => {
          writes.push(name);
        },
        onRenameSpace: (_id: string, name: string) => {
          writes.push(name);
        },
        onAssignSession: () => {},
        onUnassignSession: () => {},
        ...overrides,
      }),
    ),
  );
  const button = (name: string) => {
    const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.getAttribute("aria-label") === name || node.textContent === name,
    );
    if (!found) throw new Error(`未找到按钮 ${name}`);
    return found;
  };
  return {
    container,
    writes,
    button,
    async update(props: Record<string, unknown>) {
      await act(async () =>
        root.render(
          createElement(SidebarSessionList, {
            initialActiveSessionId: null,
            onSelectSession: () => {},
            onRenameSession: () => {},
            onDeleteSession: () => {},
            spaces: [
              { id: "a", name: "Alpha", sessionIds: [] },
              { id: "b", name: "Beta", sessionIds: [] },
            ],
            sessions: [{ sessionId: "s", title: "Session", status: "idle", preview: "", lastMsgTs: 1 }],
            spacesLoaded: true,
            onAssignSession: () => {},
            onUnassignSession: () => {},
            ...overrides,
            ...props,
          }),
        ),
      );
    },
    async dispose() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

// 空会话池仍需保留分组与组内新建，否则无法先建分组再开始第一条会话。
test("空会话列表保留分组与创建入口", async () => {
  const calls: Array<string | null> = [];
  const h = await render({ sessions: [], onCreateSessionInSpace: (id: string | null) => calls.push(id) });
  expect(h.container.textContent).toContain("Alpha");
  expect(h.button("New space")).toBeDefined();
  // 默认分组渲染在列表最底，组内新建入口因此按分组定位点击：回传 null（默认分组只创建、不写归属）。
  const defaultNewSession = h.container.querySelector<HTMLButtonElement>(
    `[data-space-drop-id="${DEFAULT_SPACE_DROP_ID}"] button[aria-label="New session in this space"]`,
  );
  if (!defaultNewSession) throw new Error("默认分组未渲染组内新建入口");
  act(() => defaultNewSession.click());
  expect(calls).toEqual([null]);
  await h.dispose();
});

// 取消按钮先得到焦点再 click，失焦不得偷偷创建/重命名；关闭后焦点回到列表。
test("新建与重命名的取消不提交，编辑自动聚焦并恢复焦点", async () => {
  for (const label of ["New space", "Rename space"]) {
    const h = await render();
    act(() => h.button(label).click());
    const input = h.container.querySelector("input");
    if (!input) throw new Error("编辑输入未出现");
    expect(win.document.activeElement).toBe(input);
    input.value = "Changed";
    act(() => h.button("Cancel").focus());
    expect(h.writes).toEqual([]);
    act(() => h.button("Cancel").click());
    expect(h.writes).toEqual([]);
    expect(h.container.querySelector("input")).toBeNull();
    expect(h.container.contains(win.document.activeElement as unknown as Node)).toBe(true);
    await h.dispose();
  }
});

// 确认输入法候选不等于提交表单，避免中文名称只写入未完成的前半段。
test("输入法组合期间 Enter 不提交，普通 Enter 只提交一次", async () => {
  const h = await render();
  act(() => h.button("New space").click());
  const input = h.container.querySelector("input");
  if (!input) throw new Error("编辑输入未出现");
  input.value = "研发";
  act(() => input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true })));
  expect(h.writes).toEqual([]);
  act(() => input.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(h.writes).toEqual(["研发"]);
  await h.dispose();
});

// 连续移动的旧请求失败，不得撤销后一次成功移动的乐观归属。
test("迟到失败不撤销较新的移动", async () => {
  let rejectFirst: (error: Error) => void = () => {};
  const h = await render({
    onAssignSession: (id: string) =>
      id === "a"
        ? new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          })
        : Promise.resolve(),
  });
  await dragSessionToSpace(h.container, "space:a");
  await dragSessionToSpace(h.container, "space:b");
  await act(async () => rejectFirst(new Error("first write failed")));
  expect(h.container.querySelector('[data-space-drop-id="space:b"] [data-session-id="s"]')).not.toBeNull();
  await h.dispose();
});

// 首次移动的中间快照可能等于第二次的最终目标，但第二次写仍在途，不能提前清掉覆盖。
test("连续移入再移出不被中间空归属快照提前撤回", async () => {
  let finishAssign: () => void = () => {};
  let finishRemove: () => void = () => {};
  const h = await render({
    onAssignSession: () =>
      new Promise<void>((resolve) => {
        finishAssign = resolve;
      }),
    onUnassignSession: () =>
      new Promise<void>((resolve) => {
        finishRemove = resolve;
      }),
  });
  await dragSessionToSpace(h.container, "space:a");
  await dragSessionToSpace(h.container, DEFAULT_SPACE_DROP_ID);
  await h.update({});
  await act(async () => finishAssign());
  await h.update({
    spaces: [
      { id: "a", name: "Alpha", sessionIds: ["s"] },
      { id: "b", name: "Beta", sessionIds: [] },
    ],
  });
  expect(h.container.querySelector('[data-space-drop-id="space:__default__"] [data-session-id="s"]')).not.toBeNull();
  await act(async () => finishRemove());
  await h.update({});
  expect(h.container.querySelector('[data-space-drop-id="space:__default__"] [data-session-id="s"]')).not.toBeNull();
  await h.dispose();
});

/** 分组渲染顺序（放置目标 id 列表，含默认分组的哨兵）。 */
function renderedDropIds(container: HTMLElement): Array<string | null> {
  return [...container.querySelectorAll("[data-space-drop-id]")].map((element) =>
    element.getAttribute("data-space-drop-id"),
  );
}

// 列表顺序契约：space 按宿主数组顺序（后端按创建时间倒序下发，最新的在最上）渲染，默认分组固定在列表最底，
// 且不因换了位置而丢掉未归属会话。
test("space 在前，默认分组固定在列表最底", async () => {
  const h = await render({
    spaces: [
      { id: "space-new", name: "Newest", sessionIds: [] },
      { id: "a", name: "Alpha", sessionIds: ["s"] },
    ],
  });
  expect(renderedDropIds(h.container)).toEqual(["space:space-new", "space:a", DEFAULT_SPACE_DROP_ID]);
  expect(h.container.textContent).toContain("Newest");
  await h.dispose();
});

// 「新建空间」入口仍在分组列表上方（DOM 顺序）：整行宽度与字号属视觉细节，不进断言。
test("新建空间入口位于分组列表上方", async () => {
  const h = await render();
  const ordered = [...h.container.querySelectorAll("button, [data-space-drop-id]")];
  const entryIndex = ordered.findIndex((element) => element.textContent?.trim() === "New space");
  expect(entryIndex).toBeGreaterThanOrEqual(0);
  expect(entryIndex).toBeLessThan(ordered.findIndex((element) => element.hasAttribute("data-space-drop-id")));
  await h.dispose();
});
