// apps/web/src/__tests__/use-chat-hydration-scope-switch.test.tsx
// 投影换代/历史切换的展示门控回归：首帧中性 loading、旧 scope 信号隔离、多标签 create/load 归属。
// 基础时序与纯投影测试留在 use-chat-hydration.test.tsx，避免单文件超出维护上限。

import { describe, expect, test } from "bun:test";
import type { StructuredMessage } from "@fenix/chat-channel";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  applyChatHydration,
  type ChatHydrationState,
  type UseChatHydrationOptions,
  useChatHydration,
} from "../../../../packages/agent-runtime/web/hooks/use-chat-hydration";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const runtimeGlobal = globalThis as Record<string, unknown>;
runtimeGlobal.window = win;
runtimeGlobal.document = win.document;
runtimeGlobal.navigator = win.navigator;

function assistant(id: string, text: string): StructuredMessage {
  return { type: "assistant_message", id, chunks: [{ type: "message", text }], seq: 0, ts: 0 };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("聊天历史切换展示门控", () => {
  // 完成初次 hydrate 后切历史投影：首帧即 loading（不等 500ms），回放期间不露旧会话，完成后提交新会话。
  test("历史投影换代首帧即 loading 且不残留旧消息", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "history:0",
      legacy: [assistant("a1", "旧会话")],
      sync: [],
      sourceReady: true,
      liveActive: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["a1"]);

    // 换代首帧仍可能带着旧 scope 的消息快照；展示必须立即切到中性 loading。
    options = { ...options, scope: "history:1", liveActive: false, replayActive: true };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    // 新会话回放内容已到达：门控提交前不得展示，loading 持续到回放结束。
    options = { ...options, legacy: [assistant("b1", "新会话")] };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(400);
    });
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    options = { ...options, replayActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.loadingVisible).toBe(false);
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["b1"]);
    act(() => root.unmount());
  }, 30_000);

  // 真实换代顺序：旧投影残留 → rebind idle → 延迟 replay → complete；
  // 旧 scope 的 replayActive 不得让新 gate 把 idle 误判为回放结束而提前空提交。
  test("scope 快速连续切换不沿用旧回放状态或旧定时器", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "rapid:0",
      legacy: [assistant("a1", "旧会话")],
      sync: [],
      sourceReady: true,
      liveActive: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);

    options = {
      ...options,
      scope: "rapid:1",
      legacy: [assistant("b1", "中间会话")],
      liveActive: false,
      replayActive: true,
    };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(100);
    });
    expect(latest.current?.messages).toEqual([]);

    // 换代首帧：旧投影仍残留且 replayActive 仍是上一代的值，展示立即切到 loading。
    options = { ...options, scope: "rapid:2", legacy: [assistant("b1", "中间会话")] };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    // 新 Doc rebind 后先 idle：旧 replayActive 的离开不是回放完成，不得提前提交。
    options = { ...options, legacy: [], replayActive: false, liveActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    // 延迟 300ms 后才开始真正的回放：此前与回放期间都不得露出逐条内容。
    options = { ...options, legacy: [assistant("c1", "最终会话")], replayActive: true };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(100);
    });
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    options = { ...options, replayActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["c1"]);
    act(() => root.unmount());
  }, 30_000);

  // 多标签远端 load：本标签 create 标记只属于上一次换代，远端 load 不得复用；慢回放前不得空提交。
  test("远端 load 换代不沿用本地 create 标记", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "multi:0",
      legacy: [assistant("a1", "旧会话")],
      sync: [],
      sourceReady: true,
      liveActive: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);

    // 本标签 create：首帧空态直出，250ms 后提交空列表。
    options = {
      ...options,
      scope: "multi:1",
      liveActive: false,
      replayActive: false,
      localCreate: true,
      noReplaySession: true,
    };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.loadingVisible).toBe(false);
    expect(latest.current?.messages).toEqual([]);
    options = { ...options, legacy: [] };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages).toEqual([]);

    // 另一标签触发 load：localCreate 已失效，noReplaySession 也必须等本次 scope rebind。
    options = {
      ...options,
      scope: "multi:2",
      localCreate: false,
      noReplaySession: false,
      replayActive: false,
      liveActive: false,
    };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    const hydration = latest.current;
    expect(hydration).not.toBeNull();
    if (hydration === null) return;
    const legacy = {
      acpSessionId: "ses-remote",
      sessionStatus: "ready" as const,
      status: "idle" as const,
      loading: null,
      canCancel: false,
      replayState: null,
      timelineEmpty: false,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const projected = applyChatHydration(legacy, hydration, {
      syncEnabled: true,
      legacyFallback: false,
      noReplaySession: false,
    });
    expect(projected.loading).toEqual({ kind: "session/bootstrap", since: 0 });

    // 慢 load 300ms 内不得提交空态；延迟回放开始后继续门控，完成后一次提交。
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    options = { ...options, legacy: [assistant("d1", "远端历史")], replayActive: true };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(100);
    });
    expect(latest.current?.messages).toEqual([]);

    options = { ...options, replayActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["d1"]);
    act(() => root.unmount());
  }, 30_000);

  // 从零历史 complete 会话切走：旧 noReplaySession 在首帧必须失效，不能用空态抑制 loading。
  test("切离空 complete 会话首帧仍挂 loading", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "empty:0",
      legacy: [],
      sync: [],
      sourceReady: true,
      liveActive: true,
      noReplaySession: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages).toEqual([]);

    options = { ...options, scope: "empty:1", noReplaySession: false, liveActive: false };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.loadingVisible).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    const hydration = latest.current;
    expect(hydration).not.toBeNull();
    if (hydration === null) return;
    const projected = applyChatHydration(
      {
        acpSessionId: "ses-empty",
        sessionStatus: "ready" as const,
        status: "idle" as const,
        loading: null,
        canCancel: false,
        replayState: "complete" as const,
        timelineEmpty: true,
        structuredMessages: [],
        pendingQuestions: new Map(),
        agentPublicError: null,
      },
      hydration,
      { syncEnabled: true, legacyFallback: false, noReplaySession: false },
    );
    expect(projected.loading).toEqual({ kind: "session/bootstrap", since: 0 });
    act(() => root.unmount());
  }, 30_000);

  // 本地新建空会话：换代首帧保持空状态直出，不用骨架替换；旧快照清空后快速提交空列表。
  test("本地新建会话换代不挂骨架", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "create:0",
      legacy: [assistant("a1", "旧会话")],
      sync: [],
      sourceReady: true,
      liveActive: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);

    // 换代首帧旧快照尚未清空，但本地 create 没有回放：直接保持空态，不挂骨架。
    options = {
      ...options,
      scope: "create:1",
      liveActive: false,
      replayActive: false,
      noReplaySession: true,
      localCreate: true,
    };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(false);
    expect(latest.current?.messages).toEqual([]);

    // switchDoc 后旧快照清空：250ms settle 后提交空列表。
    options = { ...options, legacy: [] };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.loadingVisible).toBe(false);
    expect(latest.current?.messages).toEqual([]);
    act(() => root.unmount());
  }, 30_000);

  // noReplaySession 的空会话即使 loading 已可见，也不得用骨架替换空状态。
  test("noReplaySession 空会话不挂骨架", () => {
    const legacy = {
      acpSessionId: "ses-empty",
      sessionStatus: "ready" as const,
      status: "idle" as const,
      loading: null,
      canCancel: false,
      replayState: null,
      timelineEmpty: false,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const state = applyChatHydration(
      legacy,
      { messages: [], hydrating: true, loadingVisible: true },
      { syncEnabled: true, legacyFallback: false, noReplaySession: true },
    );
    expect(state.loading).toBeNull();
    expect(state.structuredMessages).toEqual([]);
  });
});
