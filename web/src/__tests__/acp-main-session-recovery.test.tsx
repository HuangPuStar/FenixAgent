import { describe, expect, test } from "bun:test";
import type { ChatStateSnapshot, SessionStateSnapshot } from "@fenix/chat-channel";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initializeHappyDomWindow } from "./happy-dom-window";

// 告知 React 当前为测试环境，消除 act() 警告。
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ACPMain 的刷新恢复依赖客户端 effect，提供最小 DOM 环境以验证实际交互路径。
const win = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
if (!globalRecord.window) globalRecord.window = win;
if (!globalRecord.document) globalRecord.document = win.document;
if (!globalRecord.navigator) globalRecord.navigator = win.navigator;
if (!globalRecord.ResizeObserver) globalRecord.ResizeObserver = win.ResizeObserver;
if (!globalRecord.getComputedStyle) globalRecord.getComputedStyle = win.getComputedStyle.bind(win);

describe("ACPMain 会话恢复", () => {
  // 刷新时当前对话仍在进行，应恢复同一会话而非被用户切换保护拦截。
  test("loading 中恢复当前会话时仍发送 load_session", async () => {
    const { ACPMain } = await import("../../components/ACPMain");
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
