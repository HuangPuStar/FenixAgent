// ACPMain 的刷新恢复测试（CE 阶段 2 §1.6 T5c5 从 `packages/chat-channel/web/src/__tests__/` 迁入）。
// 断言的行为属包内 shell：`ACPMain` 在 loading 中恢复当前会话时仍要发 `load_session`。
// 迁移改动：`ACPMain` 改从包内 `../chat/shell/ACPMain` 导入、happy-dom 初始化改用包内 `testing` 入口、
// 补 i18next 实例初始化（否则包内 shell 的文案走 react-i18next 的无实例告警路径）。

import { describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ChatStateSnapshot, SessionStateSnapshot } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ACPMain 的刷新恢复依赖客户端 effect，安装同一 realm 的 DOM 全局对象。
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

describe("ACPMain 会话恢复", () => {
  // 刷新时当前对话仍在进行，应恢复同一会话而非被用户切换保护拦截。
  test("loading 中恢复当前会话时仍发送 load_session", async () => {
    const { ACPMain } = await import("../chat/shell/ACPMain");
    const loadedSessionIds: string[] = [];
    const chatState: ChatStateSnapshot = {
      sessions: [
        {
          sessionId: "ses-loading",
          title: "进行中的会话",
          preview: "",
          status: "active",
          lastMsgTs: Date.now(),
        },
      ],
      activeSessionId: "ses-loading",
      permissions: [],
      capabilities: { loadSession: true },
      modelState: null,
      modeState: null,
      availableCommands: [],
      sessionListLoaded: true,
      tokenUsage: null,
    };
    const sessionState: SessionStateSnapshot = {
      acpSessionId: "ses-loading",
      sessionStatus: "ready",
      status: "loading",
      loading: { kind: "session/respond", since: Date.now() },
      canCancel: true,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const container = win.document.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);

    await act(async () => {
      root.render(
        createElement(ACPMain, {
          chatState,
          sessionState,
          connectionState: "connected",
          onSendPrompt: async () => {},
          onCancel: () => {},
          onCreateSession: async () => {},
          onLoadSession: (sessionId: string) => loadedSessionIds.push(sessionId),
          onResumeSession: () => {},
          onRenameSession: () => {},
          onDeleteSession: () => {},
          onRespondPermission: () => {},
          onRespondQuestion: () => {},
          supportsLoadSession: true,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 350));
    });

    expect(loadedSessionIds).toEqual(["ses-loading"]);

    await act(async () => {
      root.unmount();
    });
  });
});
