// apps/web/src/__tests__/use-chat-hydration.test.tsx
// 展示层门控 hook 的时序回归：切换会话后先收起旧消息，确定性完成信号后一次提交；
// 新协议基线在途时同步投影冻结，基线齐备后一次合并。使用真实 hook + happy-dom，不 mock 模块。

import { describe, expect, test } from "bun:test";
import { createYjsStore, type NormalizedEvent, type StructuredMessage } from "@fenix/chat-channel";
import { applyNormalizedEvent, createChatDoc, createSessionDoc } from "@fenix/chat-channel/server";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { chatDocEntriesToStructuredMessages } from "@fenix/web-runtime/chat/structured-to-thread";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import * as Y from "yjs";
import {
  applyChatHydration,
  type ChatHydrationState,
  type UseChatHydrationOptions,
  useChatHydration,
} from "../../../../packages/agent-runtime/web/hooks/use-chat-hydration";
import { createSyncContentProjectionHub } from "../../../../packages/agent-runtime/web/yjs/sync-doc-hub";

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
  // 回复中刷新不能等流式输出暂停；初始快照和同步基线齐备后应在持续输出期间显示。
  test.each(["ready", "source", "baseline"])("实时回复持续输出时结束加载：%s", async (pending) => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "refresh-live",
      legacy: [assistant("reply", "已收到的回复")],
      sync: [],
      sourceReady: pending !== "source",
      blocked: pending === "baseline",
      liveActive: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    try {
      act(() => root.render(createElement(Probe)));
      if (pending !== "ready") {
        await act(async () => {
          await wait(300);
        });
        expect(latest.current?.hydrating).toBe(true);
        expect(latest.current?.messages).toEqual([]);
        options = { ...options, sourceReady: true, blocked: false };
        act(() => root.render(createElement(Probe)));
      }
      for (let index = 1; index <= 4; index += 1) {
        options = { ...options, legacy: [assistant("reply", `持续输出-${index}`)] };
        act(() => root.render(createElement(Probe)));
        await act(async () => {
          await wait(40);
        });
      }
      expect(latest.current?.hydrating).toBe(false);
      expect(latest.current?.loadingVisible).toBe(false);
      expect(latest.current?.messages).toEqual([...options.legacy]);
    } finally {
      act(() => root.unmount());
    }
  });

  // 切换会话后回放期间不展示任何半成品；回放结束后一次收口，实时增量随后可达。
  test("回放期间不展示，结束后收口", async () => {
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
    // 回放仍在进行：消息保持清空，不逐批填充。
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.messages).toHaveLength(0);

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

  // 骨架 loading 延迟 500ms：窗口内不出现，窗口结束后仍处于 hydrate 才出现。
  test("骨架 loading 延迟出现", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    let options: UseChatHydrationOptions = {
      scope: "delay",
      legacy: [assistant("a1", "旧会话")],
      sync: [],
      sourceReady: true,
      replayActive: true,
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
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(false);

    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(true);
    expect(latest.current?.loadingVisible).toBe(true);

    options = { ...options, replayActive: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(300);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(latest.current?.loadingVisible).toBe(false);
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

    // 基线齐备：100 条一次并入，不逐条追加；未被基线正文覆盖的旧助手文本按退役规则保留。
    options = { ...options, blocked: false };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(40);
    });
    expect(latest.current?.messages).toHaveLength(101);
    expect(latest.current?.messages.map((message) => message.id)).toEqual([
      "turn_1:assistant",
      ...baseline.map((message) => message.id),
    ]);
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

  // 明确回退或关闭开关时，旧全量仍是唯一视图；新投影文本不得替换旧历史。
  test("回退与关闭开关时保留旧全量文本", () => {
    const legacy = {
      acpSessionId: "ses-1",
      sessionStatus: "ready" as const,
      status: "idle" as const,
      loading: null,
      canCancel: false,
      replayState: null,
      timelineEmpty: false,
      structuredMessages: [assistant("old", "旧历史")],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const hydration = { messages: [assistant("new", "新投影")], hydrating: false };
    for (const options of [
      { syncEnabled: false, legacyFallback: false },
      { syncEnabled: true, legacyFallback: true },
    ]) {
      const state = applyChatHydration(legacy, hydration, options);
      expect(state.structuredMessages.map((message) => message.id)).toEqual(["old"]);
    }
  });

  // 即使 hydrate 标志尚未解除，已有可见消息时也不能再挂伪 loading（避免时间线与转圈并存）。
  test("已有可见消息时不再挂 hydration loading", () => {
    const legacy = {
      acpSessionId: "ses-1",
      sessionStatus: "ready" as const,
      status: "idle" as const,
      loading: null,
      canCancel: false,
      replayState: "active" as const,
      timelineEmpty: false,
      structuredMessages: [assistant("a1", "第一段")],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const state = applyChatHydration(
      legacy,
      { messages: [...legacy.structuredMessages, assistant("a2", "第二段")], hydrating: true },
      { syncEnabled: true, legacyFallback: false },
    );
    expect(state.loading).toBeNull();
    expect(state.structuredMessages.map((message) => message.id)).toEqual(["a1", "a2"]);
  });

  // 延迟窗口结束后仍无内容才挂伪 loading，调用方据此显示加载态而不是空状态。
  test("延迟窗口结束后保留 hydration loading", () => {
    const legacy = {
      acpSessionId: "ses-1",
      sessionStatus: "ready" as const,
      status: "idle" as const,
      loading: null,
      canCancel: false,
      replayState: "active" as const,
      timelineEmpty: false,
      structuredMessages: [],
      pendingQuestions: new Map(),
      agentPublicError: null,
    };
    const state = applyChatHydration(
      legacy,
      { messages: [], hydrating: true, loadingVisible: true },
      { syncEnabled: true, legacyFallback: false },
    );
    expect(state.loading).toEqual({ kind: "session/bootstrap", since: 0 });
    expect(state.structuredMessages).toEqual([]);
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

  // 对抗验证 H01/H02：终态旧快照缺尾段时，合并结果必须保留新投影尾文；scope 重建不能让它消失。
  test("终态旧快照缺尾段时保留新投影尾文并跨 scope 重建可见", async () => {
    const latest: { current: ChatHydrationState | null } = { current: null };
    const tool: StructuredMessage = { type: "tool_call", id: "t", title: "Read", status: "complete", content: [] };
    let options: UseChatHydrationOptions = {
      scope: "terminal-stale",
      legacy: [assistant("e", "A"), tool, assistant("e#1", "B")],
      sync: [assistant("e", "ABC")],
      sourceReady: true,
      liveActive: false,
      noReplaySession: true,
    };
    function Probe() {
      latest.current = useChatHydration(options);
      return null;
    }
    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);
    const visibleText = () =>
      (latest.current?.messages ?? [])
        .filter((message): message is Extract<StructuredMessage, { type: "assistant_message" }> => {
          return message.type === "assistant_message";
        })
        .flatMap((message) => message.chunks)
        .map((chunk) => chunk.text)
        .join("");

    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(350);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(visibleText()).toBe("ABC");

    // 重连/换代 scope：同一份旧快照与新投影必须仍然完整可见。
    options = { ...options, scope: "reconnected-stale" };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(350);
    });
    expect(latest.current?.hydrating).toBe(false);
    expect(visibleText()).toBe("ABC");

    // 旧侧追平后回到权威分段，且不重复。
    options = { ...options, legacy: [assistant("e", "A"), tool, assistant("e#1", "BC")] };
    act(() => root.render(createElement(Probe)));
    await act(async () => {
      await wait(50);
    });
    expect(latest.current?.messages.map((message) => message.id)).toEqual(["e", "t", "e#1"]);
    expect(visibleText()).toBe("ABC");

    act(() => root.unmount());
  });
});

// 真实链路：YjsStore 派生旧投影 + SyncContentProjectionHub 从有序工具标记切段 + useChatHydration 合并。
// 标记存在时缺失段必须精确落在工具之后，而不是走字符串启发式。
test("真实 YjsStore + 投影 hub + hook：标记存在时精确落位", async () => {
  const chat = createChatDoc("rcs-hook-marker", null).ydoc;
  const session = createSessionDoc("rcs-hook-marker", null).ydoc;
  const pair = { chat, session };
  const event = (
    type: NormalizedEvent["type"],
    update: Record<string, unknown> = {},
    turnId = "turn-hook",
  ): NormalizedEvent =>
    ({ type, update, content: (update.content as Record<string, unknown>) ?? null, turnId }) as NormalizedEvent;

  applyNormalizedEvent(pair, event("user_message", { content: { type: "text", text: "问" } }));
  applyNormalizedEvent(pair, event("message_delta", { content: { type: "text", text: "A" } }));
  applyNormalizedEvent(pair, event("tool_call_started", { toolCallId: "tool-h", title: "Read" }));

  const store = createYjsStore(chatDocEntriesToStructuredMessages, []);
  store.switchDoc("hook-scope", () => ({ ydoc: new Y.Doc() }));
  store.applyUpdate(Y.encodeStateAsUpdate(chat));
  await wait(60);
  const legacy = store.getSnapshot();

  const content = new Y.Doc();
  const records = new Y.Array<Record<string, unknown>>();
  content.getMap("root").set("records", records);
  const encoder = new TextEncoder();
  records.push([
    {
      recordId: "r0",
      entryId: "turn-hook:assistant",
      entryOrder: 1,
      contentSlot: "text",
      partIndex: 0,
      kind: "text",
      payload: encoder.encode("A"),
    },
    {
      recordId: "r1",
      entryId: "turn-hook:assistant",
      entryOrder: 1,
      contentSlot: "boundary",
      partIndex: 1,
      kind: "tool_boundary",
      payload: encoder.encode(JSON.stringify("tool-h")),
    },
    {
      recordId: "r2",
      entryId: "turn-hook:assistant",
      entryOrder: 1,
      contentSlot: "text",
      partIndex: 2,
      kind: "text",
      payload: encoder.encode("B"),
    },
  ]);
  const hub = createSyncContentProjectionHub({ onProjection: () => {} });
  hub.applyUpdate({ docId: "sync/content/gen/0/nonce", generation: "gen", payload: Y.encodeStateAsUpdate(content) });
  const sync = hub.snapshot().messages;

  const latest: { current: ChatHydrationState | null } = { current: null };
  const options: UseChatHydrationOptions = {
    scope: "hook-marker",
    legacy,
    sync,
    sourceReady: true,
    liveActive: false,
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
    await wait(350);
  });
  expect(latest.current?.hydrating).toBe(false);
  expect(latest.current?.messages.map((message) => message.id)).toEqual([
    "turn-hook:user",
    "turn-hook:assistant",
    "tool-h",
    "turn-hook:assistant#1",
  ]);
  expect(
    latest.current?.messages
      .map((message) =>
        message.type === "assistant_message"
          ? message.chunks.map((chunk) => (chunk.type === "message" ? chunk.text : "")).join("")
          : "",
      )
      .join(""),
  ).toBe("AB");

  act(() => root.unmount());
  hub.dispose();
  content.destroy();
  store.destroy();
  chat.destroy();
  session.destroy();
});
