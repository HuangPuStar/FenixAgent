// apps/web/src/__tests__/use-chat-hydration.test.tsx
// 展示层门控 hook 的时序回归：切换会话后先收起旧消息，确定性完成信号后一次提交；
// 新协议基线在途时同步投影冻结，基线齐备后一次合并。使用真实 hook + happy-dom，不 mock 模块。

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

describe("useChatHydration", () => {
  // 切换会话后回放未结束不渲染；回放结束后一次提交，实时增量随后可达。
  test("回放结束前门控，结束后一次提交", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "a",
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
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toEqual([]);
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["a1"]);

    const large = Array.from({ length: 100 }, (_, index) => assistant(`b${index}`, `answer ${index}`));
    options = { ...options, scope: "b", legacy: large, liveActive: false, replayActive: true };
    act(() => root.render(createElement(Probe)));
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    await act(async () => {
      await wait(400);
    });
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toEqual([]);

    options = { ...options, replayActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages).toHaveLength(100);

    options = { ...options, legacy: [...large, assistant("b100", "live")] };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(40);
    });
    expect(latest.current?.messages).toHaveLength(101);
    act(() => root.unmount());
  }, 30_000);

  // 旧路径已有内容时，新协议基线在途期间冻结同步投影；基线齐备后一次合并，不逐条追加。
  test("旧内容先显示，后到基线只合并一次", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    const partial = [assistant("turn_1:assistant", "partial")];
    const baseline = Array.from({ length: 100 }, (_, index) => assistant(`base_${index}`, `baseline ${index}`));
    let options: UseChatHydrationOptions = {
      scope: "c",
      legacy: partial,
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
    expect(latest.current?.messages).toHaveLength(1);

    // 基线在途：同步投影即使已经变大也不得进入合并器。
    options = { ...options, blocked: true, sync: baseline };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(400);
    });
    expect(latest.current?.messages).toHaveLength(1);
    expect(latest.current?.hydrating).toBe(false);

    // 基线齐备：一次合并全部 100 条（旧条目保留）。
    options = { ...options, blocked: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(40);
    });
    expect(latest.current?.messages).toHaveLength(101);
    act(() => root.unmount());
  }, 30_000);

  // 新协议进入终态错误时，门控必须结束骨架并提交旧通道内容；不能错误卡与骨架长期并存。
  test("同步终态错误结束骨架并提交旧内容", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    const options: UseChatHydrationOptions = {
      scope: "sync-terminal-error",
      legacy: [assistant("old", "旧通道内容")],
      sync: [],
      sourceReady: false,
      replayActive: true,
      blocked: true,
      syncTerminalError: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(400);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["old"]);
    act(() => root.unmount());
  });

  // 同步终态错误必须清掉旧路径遗留的 loading，否则错误卡消失后输入区仍被禁用。
  test("同步终态错误清除 loading 并保留旧消息", () => {
    const legacy = {
      acpSessionId: "ses-1",
      sessionStatus: "ready" as const,
      status: "idle" as const,
      loading: { kind: "session/bootstrap" as const, since: 0 },
      canCancel: false,
      replayState: null,
      timelineEmpty: false,
      structuredMessages: [assistant("old", "旧通道内容")],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const state = applyChatHydration(
      legacy,
      { messages: [assistant("old", "旧通道内容")], hydrating: false },
      { syncEnabled: true, legacyFallback: false, syncTerminalError: true },
    );
    expect(state.loading).toBeNull();
    expect(state.structuredMessages.map((message) => message.id)).toEqual(["old"]);
  });
});
