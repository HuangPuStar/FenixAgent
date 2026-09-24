// ACPMain 会话列表滚动容器的高度约束守卫。
//
// 覆盖的用户报告：「Chat 页面通过左侧边栏的会话切换，从无滚动条切到有滚动条时无法滚动」。
// 根因：会话列表的 ScrollArea 根是列向 flex 子项（`flex-1`），此前缺 `min-h-0`，
// CSS 的自动最小尺寸（`min-height: auto`）会把这个根撑到**整个列表的内容高度**，
// 视口于是与内容等高、永远没有可滚动溢出 —— 会话数少时看不出差别，一旦多到需要滚动就滚不动。
//
// 为什么在这里只断言类约定：happy-dom 没有排版引擎，无法断言「视口 clientHeight < scrollHeight」。
// 真实滚动行为（滚轮 / scrollTop 赋值是否生效）由仓库外的 headless Chrome 工装量测（见交付报告）；
// 本文件守住的是让它成立的唯一前置条件 —— 该 flex 子项不得依赖 `min-height: auto`。
//
// 装配沿用 `acp-main-session-switch-failure.test.tsx`（真实组件 + happy-dom + 真实 i18n 实例 +
// 最小 fake 回调），不触碰组件内部实现。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ChatStateSnapshot, SessionStateSnapshot, SessionSummary } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 与既有 ACPMain 测试同款装置：同一 realm 的 DOM 全局对象（含 ResizeObserver，ScrollArea 依赖它）。
const win = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = win;
globalRecord.document = win.document;
globalRecord.navigator = win.navigator;
globalRecord.ResizeObserver = win.ResizeObserver;
globalRecord.getComputedStyle = win.getComputedStyle.bind(win);

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

/** 造出「会话数多于侧栏可用高度」的列表：数量本身不影响本文件的类约定断言，只用于贴近真实场景。 */
function createSessions(count: number): SessionSummary[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    sessionId: `ses-${index}`,
    title: `会话 ${index}`,
    preview: "",
    status: "idle" as const,
    lastMsgTs: now - index * 1000,
  }));
}

function createChatState(sessions: SessionSummary[]): ChatStateSnapshot {
  return {
    sessions,
    activeSessionId: sessions[0]?.sessionId ?? null,
    permissions: [],
    capabilities: {},
    modelState: null,
    modeState: null,
    availableCommands: [],
    sessionListLoaded: true,
    tokenUsage: null,
  };
}

function createSessionState(): SessionStateSnapshot {
  return {
    acpSessionId: "ses-0",
    sessionStatus: "ready",
    status: "idle",
    loading: null,
    canCancel: false,
    structuredMessages: [],
    pendingQuestions: new Map(),
    agentPublicError: null,
  };
}

/** 渲染 ACPMain，返回容器与卸载入口。 */
async function renderACPMain(chatState: ChatStateSnapshot): Promise<{ container: HTMLElement; root: Root }> {
  const { ACPMain } = await import("../chat/shell/ACPMain");
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const root: Root = createRoot(container);

  await act(async () => {
    root.render(
      createElement(ACPMain, {
        chatState,
        sessionState: createSessionState(),
        connectionState: "connected",
        supportsLoadSession: true,
        onSendPrompt: async () => {},
        onCancel: () => {},
        onCreateSession: async () => {},
        onLoadSession: () => {},
        onResumeSession: () => {},
        onRenameSession: () => {},
        onDeleteSession: () => {},
        onRespondPermission: () => {},
        onRespondQuestion: () => {},
        onNotice: () => {},
      }),
    );
    // bootstrap 防抖 300ms：等首次自动恢复会话的选择逻辑跑完，避免 act 外的状态更新。
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

  return { container, root };
}

/** 取会话列表所在的滚动容器（`nav` = 会话列表根，其最近的 ScrollArea 根即被守卫的元素）。 */
function findSessionListScrollArea(container: HTMLElement): HTMLElement | null {
  const list = container.querySelector("nav");
  return list?.closest('[data-slot="scroll-area"]') as HTMLElement | null;
}

describe("ACPMain 会话列表滚动容器", () => {
  // 会话数远超侧栏高度时，会话列表的滚动容器必须带 min-h-0，否则会被内容撑高、丧失滚动能力
  test("会话列表的 ScrollArea 根带 min-h-0（不依赖 min-height: auto）", async () => {
    const { container, root } = await renderACPMain(createChatState(createSessions(40)));
    const scrollArea = findSessionListScrollArea(container);
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.classList.contains("min-h-0")).toBe(true);
    // 顺带确认它确实还是那个「撑满剩余高度」的 flex 子项，避免断言落在一个换了语义的元素上。
    expect(scrollArea?.classList.contains("flex-1")).toBe(true);
    await act(async () => root.unmount());
  });

  // 会话数少（不需要滚动）时同样成立：约束与列表长度无关，避免只做得住「无滚动条」那半段
  test("会话数少时同一条约束仍在（与列表长度无关）", async () => {
    const { container, root } = await renderACPMain(createChatState(createSessions(2)));
    const scrollArea = findSessionListScrollArea(container);
    expect(scrollArea?.classList.contains("min-h-0")).toBe(true);
    await act(async () => root.unmount());
  });
});
