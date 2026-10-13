// ACPMain 会话切换失败路径测试（点击侧边栏历史项失败时必须「有提示 + 高亮回退」）。
//
// 覆盖的用户报告：引擎既无 loadSession 也无 resumeSession 时，点击历史会话项在
// `ACPMain.handleSelectSession` 里抛错并被 catch 只写 console.error——侧边栏高亮已在点击时
// 乐观置位、却没有任何东西把它拉回来，界面表现为「高亮变了、消息区空白、无任何提示」。
//
// 装配沿用 `acp-main-session-recovery.test.tsx`（真实组件 + happy-dom + 真实 i18n 实例 +
// 最小 fake 回调），只断言用户可见行为：提示出口收到的通知、`aria-current="page"` 高亮的落点、
// 以及点击不产生未捕获异常；不触碰组件内部实现细节。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ChatNotice } from "../chat/shell/chat-interface-types";
import type { ChatStateSnapshot, SessionStateSnapshot } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 会话切换走客户端 effect 与事件处理，安装同一 realm 的 DOM 全局对象（含 ResizeObserver：
// ScrollArea / Tooltip 依赖它）。
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

/** 会话列表与激活态（真实会话 + 待切换的历史会话） */
const REAL_SESSION_ID = "ses-real";
const TARGET_SESSION_ID = "ses-target";

function createChatState(overrides: Partial<ChatStateSnapshot> = {}): ChatStateSnapshot {
  return {
    sessions: [
      { sessionId: REAL_SESSION_ID, title: "真实会话", preview: "", status: "idle", lastMsgTs: Date.now() },
      { sessionId: TARGET_SESSION_ID, title: "目标历史会话", preview: "", status: "idle", lastMsgTs: Date.now() },
    ],
    activeSessionId: REAL_SESSION_ID,
    permissions: [],
    capabilities: {},
    modelState: null,
    modeState: null,
    availableCommands: [],
    sessionListLoaded: true,
    tokenUsage: null,
    ...overrides,
  };
}

function createSessionState(): SessionStateSnapshot {
  return {
    acpSessionId: REAL_SESSION_ID,
    sessionStatus: "ready",
    status: "idle",
    loading: null,
    canCancel: false,
    structuredMessages: [],
    pendingQuestions: new Map(),
    agentPublicError: null,
  };
}

interface Harness {
  container: HTMLElement;
  root: Root;
  notices: ChatNotice[];
  loaded: string[];
  resumed: string[];
  /** 侧边栏当前高亮的会话（无高亮时为 null），来源于会话标题按钮的 aria-current */
  activeHighlight(): string | null;
  /** 点击指定标题的会话项；返回点击过程中抛出的未捕获异常（无异常为 null） */
  clickSession(title: string): unknown;
  /** 以新的 chatState 重渲染（模拟服务端投影推进：session_updated / 会话列表变化） */
  rerender(chatState: ChatStateSnapshot): Promise<void>;
  unmount(): Promise<void>;
}

/** 渲染 ACPMain 并等待 bootstrap 防抖（300ms）走完，返回可交互的侧边栏查询入口 */
async function renderACPMain(props: {
  supportsLoadSession: boolean;
  supportsResumeSession?: boolean;
  chatState: ChatStateSnapshot;
  onLoadSession?: (sessionId: string) => void;
  onResumeSession?: (sessionId: string) => void;
}): Promise<Harness> {
  const { ACPMain } = await import("../chat/shell/ACPMain");
  const notices: ChatNotice[] = [];
  const loaded: string[] = [];
  const resumed: string[] = [];
  const container = win.document.createElement("div") as unknown as HTMLElement;
  const root: Root = createRoot(container);

  /** 每次渲染使用同一组宿主端口；chatState 可替换（模拟服务端投影推进） */
  const element = (chatState: ChatStateSnapshot) =>
    createElement(ACPMain, {
      chatState,
      sessionState: createSessionState(),
      connectionState: "connected",
      supportsLoadSession: props.supportsLoadSession,
      supportsResumeSession: props.supportsResumeSession,
      onSendPrompt: async () => {},
      onCancel: () => {},
      onCreateSession: async () => {},
      onLoadSession: (sessionId: string) => {
        loaded.push(sessionId);
        props.onLoadSession?.(sessionId);
      },
      onResumeSession: (sessionId: string) => {
        resumed.push(sessionId);
        props.onResumeSession?.(sessionId);
      },
      onRenameSession: () => {},
      onDeleteSession: () => {},
      onRespondPermission: () => {},
      onRespondQuestion: () => {},
      onNotice: (notice: ChatNotice) => notices.push(notice),
    });

  await act(async () => {
    root.render(element(props.chatState));
    // bootstrap 防抖 300ms：让首次自动恢复先跑完，后续断言只反映用户点击
    await new Promise((resolve) => setTimeout(resolve, 350));
  });

  const titleButton = (title: string): HTMLButtonElement | undefined =>
    Array.from(container.querySelectorAll("button")).find((button) => button.textContent?.trim() === title) as
      | HTMLButtonElement
      | undefined;

  return {
    container,
    root,
    notices,
    loaded,
    resumed,
    activeHighlight() {
      // 行高亮经 aria-current="page" 暴露（SessionTitleButton），按标题反查所属会话
      const activeButtons = Array.from(container.querySelectorAll('button[aria-current="page"]'));
      const texts = activeButtons.map((button) => button.textContent?.trim() ?? "");
      return texts[0] ?? null;
    },
    clickSession(title: string): unknown {
      const button = titleButton(title);
      if (!button) throw new Error(`侧边栏未渲染会话项：${title}`);
      let thrown: unknown = null;
      act(() => {
        try {
          button.click();
        } catch (error) {
          thrown = error;
        }
      });
      return thrown;
    },
    async rerender(chatState: ChatStateSnapshot) {
      await act(async () => {
        root.render(element(chatState));
      });
    },
    async unmount() {
      await act(async () => {
        root.unmount();
      });
    },
  };
}

describe("ACPMain 会话切换失败", () => {
  // 引擎既无 loadSession 也无 resumeSession：点击历史项必须给出明确的能力提示
  //（区别于并发保护 chatBusy 与普通失败），用户不能只看到高亮变化。
  test("不支持加载历史会话时点击历史项给出能力提示", async () => {
    const harness = await renderACPMain({ supportsLoadSession: false, chatState: createChatState() });
    expect(harness.notices).toEqual([]);

    harness.clickSession("目标历史会话");

    expect(harness.notices).toEqual([
      { level: "warning", message: en.chat.components.acpMain.sessionSwitchUnsupported },
    ]);
    // 不发起任何切换动作（引擎没有可用动作）
    expect(harness.loaded).toEqual([]);
    expect(harness.resumed).toEqual([]);
    await harness.unmount();
  });

  // 失败后高亮必须回到真实当前会话：点击时是乐观置位，若不回退界面会长期显示错误的高亮
  //（用户报告的「高亮变了、消息区空白」）。
  test("切换失败后侧边栏高亮回到真实会话", async () => {
    const harness = await renderACPMain({ supportsLoadSession: false, chatState: createChatState() });
    expect(harness.activeHighlight()).toBe("真实会话");

    harness.clickSession("目标历史会话");

    expect(harness.activeHighlight()).toBe("真实会话");
    await harness.unmount();
  });

  // 点击失败不得抛出未捕获异常：事件处理器内的异常会中断 React 事件系统并变成控制台未处理错误。
  test("切换失败不产生未捕获异常", async () => {
    const harness = await renderACPMain({ supportsLoadSession: false, chatState: createChatState() });

    const thrown = harness.clickSession("目标历史会话");

    expect(thrown).toBeNull();
    await harness.unmount();
  });

  // 引擎支持 load_session 但宿主回调抛错（意外失败）：提示区分于「不支持」，且同样回退高亮。
  test("宿主加载回调抛错时给出失败提示并回退高亮", async () => {
    const harness = await renderACPMain({
      supportsLoadSession: true,
      chatState: createChatState(),
      onLoadSession: () => {
        throw new Error("relay unavailable");
      },
    });

    const thrown = harness.clickSession("目标历史会话");

    expect(thrown).toBeNull();
    expect(harness.notices).toEqual([{ level: "error", message: en.chat.components.acpMain.sessionSwitchFailed }]);
    expect(harness.activeHighlight()).toBe("真实会话");
    await harness.unmount();
  });

  // 成功路径不得触发回退信号：点击调用宿主加载回调、无任何提示，且服务端确认（chatState
  // 推进到目标会话）后高亮落在目标会话——回退机制只在失败分支生效。
  test("成功切换不下发提示且确认后高亮落在目标会话", async () => {
    const harness = await renderACPMain({ supportsLoadSession: true, chatState: createChatState() });

    const thrown = harness.clickSession("目标历史会话");

    expect(thrown).toBeNull();
    // 首条是 bootstrap 的自动恢复（真实会话），其后才是点击触发切换的目标会话
    expect(harness.loaded).toEqual([REAL_SESSION_ID, TARGET_SESSION_ID]);
    expect(harness.notices).toEqual([]);

    await harness.rerender(createChatState({ activeSessionId: TARGET_SESSION_ID }));
    expect(harness.activeHighlight()).toBe("目标历史会话");
    await harness.unmount();
  });

  // 自动恢复（restore）失败只保留 console.error 诊断，不下发用户提示：页面打开瞬间弹提示属噪声。
  test("自动恢复失败不下发用户提示", async () => {
    const harness = await renderACPMain({ supportsLoadSession: false, chatState: createChatState() });

    // renderACPMain 已等待一轮防抖；此处再多等一轮，确认自动恢复重试路径同样不下发提示
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(harness.notices).toEqual([]);
    expect(harness.activeHighlight()).toBe("真实会话");
    await harness.unmount();
  });
});
