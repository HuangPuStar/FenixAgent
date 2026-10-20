// 组内新建会话的归属绑定（创建回执）测试。
//
// 验收契约：归属只由「本页本次 create_session 的创建回执（sessionId）」决定，不得把共享投影里
// `chatState.activeSessionId` 的任何变化当作消费依据——那正是别的标签页创建/切换会话时会误归属的入口。
// 本文件覆盖：正常回执落归属、忙碌被拒、回执为空、迟到回执、其它标签页并发创建/切换、默认分组不写归属。
//
// 搭法沿用 `acp-main-session-recovery.test.tsx`（真实 `ACPMain` + happy-dom + 真实 i18n 实例）。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { toSpaceDropId } from "../chat/lib/space-drop-target";
import type { ChatNotice, ChatSpaceItem, SessionCreateReceipt } from "../chat/shell/chat-interface-types";
import type { ChatStateSnapshot, SessionStateSnapshot } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 与其它 shell 测试同一套 DOM 引导（Radix / 事件构造器依赖同一 realm 的全局对象）。
const win = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = win;
globalRecord.document = win.document;
globalRecord.navigator = win.navigator;
globalRecord.ResizeObserver = win.ResizeObserver;
globalRecord.getComputedStyle = win.getComputedStyle.bind(win);
globalRecord.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globalRecord.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globalRecord.Event = win.Event;
globalRecord.CustomEvent = win.CustomEvent;
globalRecord.MouseEvent = win.MouseEvent;
globalRecord.Element = win.Element;
globalRecord.HTMLElement = win.HTMLElement;
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

const SPACES: ChatSpaceItem[] = [{ id: "space-1", name: "空间一", sessionIds: [] }];

/** 默认创建回执：本页本次创建出的会话 id。 */
const DEFAULT_RECEIPT = "ses-created";

/** 侧栏分组树要求至少有一条会话才渲染（空列表走空态分支），故样本始终带会话。 */
function chatState(sessionIds: readonly string[], activeSessionId: string | null): ChatStateSnapshot {
  return {
    sessions: sessionIds.map((sessionId) => ({
      sessionId,
      title: sessionId,
      preview: "",
      status: "idle",
      lastMsgTs: Date.now(),
    })),
    activeSessionId,
    permissions: [],
    capabilities: { loadSession: true },
    modelState: null,
    modeState: null,
    availableCommands: [],
    sessionListLoaded: true,
    tokenUsage: null,
  };
}

/** `loading` 非空即 `ChatInterface` 认定的「忙碌」，也是它拒绝新建的唯一判据。 */
function sessionStateSnapshot(loading: boolean): SessionStateSnapshot {
  return {
    acpSessionId: "ses-a",
    sessionStatus: "ready",
    status: loading ? "loading" : "idle",
    loading: loading ? { kind: "session/respond", since: Date.now() } : null,
    canCancel: loading,
    structuredMessages: [],
    pendingQuestions: new Map(),
    agentPublicError: null,
  };
}

interface MainHarness {
  container: HTMLElement;
  /** `onCreateSession` 的调用次数（新建是否真的走到宿主） */
  createCalls: number;
  /** 归属写入（spaceId + sessionId） */
  assigned: Array<[string, string]>;
  notices: ChatNotice[];
  /** 以新 props 重渲染（chatState 变化是「新会话到达」的模拟方式） */
  update(props: Record<string, unknown>): Promise<void>;
  /** 替换创建实现（回执悬挂 / 抛错）；调用计数仍由 harness 统一记录 */
  setCreateReceipt(impl: () => SessionCreateReceipt | Promise<SessionCreateReceipt>): void;
  clickNewSessionInSpace(spaceId: string | null): Promise<void>;
  clickSessionRow(sessionId: string): Promise<void>;
  unmount(): Promise<void>;
}

/** 渲染真实 `ACPMain`；未显式覆盖的 props 使用本文件的样本（一个分组、一条活动会话）。 */
async function renderMain(overrides: Record<string, unknown> = {}): Promise<MainHarness> {
  const { ACPMain } = await import("../chat/shell/ACPMain");
  const created: number[] = [];
  const assigned: Array<[string, string]> = [];
  const notices: ChatNotice[] = [];
  // 创建实现的替换点：调用计数留在 harness 里，覆盖实现的用例仍能断言「创建是否被调用」。
  let createImpl: () => SessionCreateReceipt | Promise<SessionCreateReceipt> = () => DEFAULT_RECEIPT;
  const container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  const root: Root = createRoot(container);

  const element = (props: Record<string, unknown>) =>
    createElement(ACPMain, {
      connectionState: "connected",
      onSendPrompt: async () => {},
      onCancel: () => {},
      // 默认回执：本次点击创建出的会话 id（用例可用 setCreateReceipt 换成悬挂 Promise / 抛错）
      onCreateSession: () => {
        created.push(1);
        return createImpl();
      },
      onLoadSession: () => {},
      onResumeSession: () => {},
      onRenameSession: () => {},
      onDeleteSession: () => {},
      onRespondPermission: () => {},
      onRespondQuestion: () => {},
      onNotice: (notice: ChatNotice) => notices.push(notice),
      onAssignSession: (spaceId: string, sessionId: string) => assigned.push([spaceId, sessionId]),
      spaces: SPACES,
      chatState: chatState(["ses-a"], "ses-a"),
      sessionState: sessionStateSnapshot(false),
      supportsLoadSession: true,
      ...props,
    });

  const update = async (props: Record<string, unknown>) => {
    await act(async () => {
      root.render(element(props));
    });
  };

  await act(async () => {
    root.render(element(overrides));
    // 跨过 bootstrap 的 300ms 防抖：否则自动进入会话的副作用会在断言之后再落一次
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

  return {
    container,
    get createCalls() {
      return created.length;
    },
    assigned,
    notices,
    update,
    setCreateReceipt(impl) {
      createImpl = impl;
    },
    async clickNewSessionInSpace(spaceId: string | null) {
      const button = container.querySelector(
        `[data-space-drop-id="${toSpaceDropId(spaceId)}"] button[aria-label="New session in this space"]`,
      ) as HTMLButtonElement | null;
      if (!button) throw new Error(`未找到组内新建入口：${String(spaceId)}`);
      await act(async () => {
        button.click();
        // 让「点击 → newSession → 创建回执」的 async 链在本帧内跑完：
        // act 只保证刷新 React 工作，微任务链需要显式让出若干次。
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
      });
    },
    async clickSessionRow(sessionId: string) {
      const button = container.querySelector(`[data-session-id="${sessionId}"] button`) as HTMLButtonElement | null;
      if (!button) throw new Error(`未找到会话行：${sessionId}`);
      await act(async () => {
        button.click();
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe("ACPMain 组内新建的归属意图", () => {
  // 正常路径：点击组内新建 → 回执带上本次创建出的 session id → 该会话进入这个分组。
  // 归属不依赖 chatState 变化（旧实现要等 activeSessionId 变，等于把别页会话也算进来）。
  test("回执到达即写入分组，无需等待共享投影变化", async () => {
    const harness = await renderMain();

    await harness.clickNewSessionInSpace("space-1");

    expect(harness.createCalls).toBe(1);
    expect(harness.assigned).toEqual([["space-1", DEFAULT_RECEIPT]]);

    await harness.unmount();
  });

  // 多标签页并发：本页创建在途时别页创建/切换会话（共享投影变化）不得消费本页归属意图。
  test("回执在途时其它标签页的会话变化不产生归属", async () => {
    let resolveReceipt: (sessionId: string | null) => void = () => {};
    const harness = await renderMain();
    harness.setCreateReceipt(
      () =>
        new Promise<string | null>((resolve) => {
          resolveReceipt = resolve;
        }),
    );

    await harness.clickNewSessionInSpace("space-1");
    expect(harness.createCalls).toBe(1);

    // 另一标签页创建并切到 ses-other-tab：旧实现会在这里把 ses-other-tab 写进空间一。
    await harness.update({ chatState: chatState(["ses-a", "ses-other-tab"], "ses-other-tab") });
    expect(harness.assigned).toEqual([]);

    // 本页回执到达：只写回执里的会话，别页会话仍不在分组里。
    await act(async () => resolveReceipt("ses-mine"));
    expect(harness.assigned).toEqual([["space-1", "ses-mine"]]);

    await harness.unmount();
  });

  // 两个标签页同时创建：本页只认自己的回执，不把同时到达的别页会话写进分组。
  test("两页同时创建时只归属本页回执的会话", async () => {
    let resolveReceipt: (sessionId: string | null) => void = () => {};
    const harness = await renderMain();
    harness.setCreateReceipt(
      () =>
        new Promise<string | null>((resolve) => {
          resolveReceipt = resolve;
        }),
    );

    await harness.clickNewSessionInSpace("space-1");
    // 别页的创建先落到共享投影。
    await harness.update({ chatState: chatState(["ses-a", "ses-other-tab"], "ses-other-tab") });
    await act(async () => resolveReceipt("ses-mine"));

    expect(harness.assigned).toEqual([["space-1", "ses-mine"]]);
    await harness.unmount();
  });

  // 迟到回执：用户在等待期间切走会话，回执仍属于本次点击的创建结果，照常写入该分组。
  test("用户切走后到达的回执仍写入点击时的分组", async () => {
    let resolveReceipt: (sessionId: string | null) => void = () => {};
    const harness = await renderMain({ chatState: chatState(["ses-a", "ses-a2"], "ses-a") });
    harness.setCreateReceipt(
      () =>
        new Promise<string | null>((resolve) => {
          resolveReceipt = resolve;
        }),
    );

    await harness.clickNewSessionInSpace("space-1");
    await harness.clickSessionRow("ses-a2");
    await harness.update({ chatState: chatState(["ses-a", "ses-a2", "ses-late"], "ses-late") });
    expect(harness.assigned).toEqual([]);

    await act(async () => resolveReceipt("ses-late"));
    expect(harness.assigned).toEqual([["space-1", "ses-late"]]);

    await harness.unmount();
  });

  // 忙碌被拒：`ChatInterface` 只提示、不建会话，回执为 null，随后任何会话变化都不得写出归属。
  test("忙碌时组内新建被拒且不产生归属", async () => {
    const harness = await renderMain({ sessionState: sessionStateSnapshot(true) });

    await harness.clickNewSessionInSpace("space-1");
    expect(harness.createCalls).toBe(0);
    expect(harness.notices.map((notice) => notice.message)).toContain(
      "Please wait for the current conversation to finish before switching",
    );

    // 随后到来的会话切换（如另一标签页新建会话）不得写出归属
    await harness.update({ chatState: chatState(["ses-a", "ses-b"], "ses-b") });
    expect(harness.assigned).toEqual([]);

    await harness.unmount();
  });

  // 创建被拒（宿主抛错 / 回执为空）：提示可见，且之后别的会话变化不得补写归属。
  test("回执为空时不写归属并提示创建失败", async () => {
    const harness = await renderMain();
    harness.setCreateReceipt(async () => {
      throw new Error("create rejected");
    });

    await harness.clickNewSessionInSpace("space-1");
    expect(harness.notices.some((notice) => notice.level === "error")).toBe(true);
    expect(harness.assigned).toEqual([]);

    await harness.update({ chatState: chatState(["ses-a", "ses-other"], "ses-other") });
    expect(harness.assigned).toEqual([]);
    await harness.unmount();
  });

  // 默认分组（null）只创建会话、不写归属：新会话本来就落在默认分组。
  test("默认分组内新建不产生归属写", async () => {
    const harness = await renderMain();

    await harness.clickNewSessionInSpace(null);
    expect(harness.createCalls).toBe(1);
    expect(harness.assigned).toEqual([]);

    await harness.unmount();
  });
});
