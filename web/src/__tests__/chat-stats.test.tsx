// web/src/__tests__/chat-stats.test.tsx
// SP-B7 chat:stats 摘要协议的行为测试，覆盖三条关键链路：
// 1) ChatStatsDispatcher（派发方）：摘要 payload 只含轻量字段（不含 entries）、
//    相同签名幂等跳过、1s trailing 窗口合并多次变化、依赖变化/卸载时 flush 保证最终态；
// 2) useChangedFilesFromStats（消费方）：正确消费 detail.changedFiles、
//    按 agentName 过滤跨 agent 事件、agent 切换与 agent:reconnect 时重置；
// 3) 派发器默认走 window.dispatchEvent 派发 chat:stats，与消费方构成闭环。

import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useChangedFilesFromStats } from "../hooks/use-changed-files-stats";
import { ChatStatsDispatcher, type ChatStatsSummary } from "../lib/chat-stats";
import type { ChangedFile } from "../lib/extract-changed-files";
import { initializeHappyDomWindow } from "./happy-dom-window";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// ── DOM 环境（react-dom/client 加载需要 document）──
// window 使用原生 EventTarget：hook 生产代码监听 window 的 chat:stats/agent:reconnect，
// 测试用原生 CustomEvent 派发，原生 EventTarget 的 addEventListener/dispatchEvent 语义与之匹配
const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = new EventTarget();
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;

const f = (path: string, type: ChangedFile["type"] = "edit"): ChangedFile => ({ path, type });

function summary(partial: Partial<ChatStatsSummary>): ChatStatsSummary {
  return { agentName: "agent-a", modelName: "model-x", entryCount: 1, changedFiles: [], ...partial };
}

// 记录派发的摘要，供断言使用；每个用例独立实例
function recordedDispatcher(windowMs?: number) {
  const events: ChatStatsSummary[] = [];
  const dispatcher = new ChatStatsDispatcher({ windowMs, emit: (s) => events.push(s) });
  return { dispatcher, events };
}

/** 用真实 timer 等待 ms 毫秒（windowMs 在测试中收窄，避免秒级等待） */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("ChatStatsDispatcher", () => {
  // 摘要 payload 只含 agentName/modelName/entryCount/changedFiles，不含 entries
  test("dispatches only lightweight summary fields", async () => {
    const { dispatcher, events } = recordedDispatcher(10);
    dispatcher.update(summary({ entryCount: 3, changedFiles: [f("a.ts")] }));
    await wait(30);
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]).sort()).toEqual(["agentName", "changedFiles", "entryCount", "modelName"]);
    expect(events[0].changedFiles).toEqual([{ path: "a.ts", type: "edit" }]);
  });

  // 相同签名的重复 update 在窗口内与跨窗口均不重复派发（幂等）
  test("skips dispatch when signature unchanged", async () => {
    const { dispatcher, events } = recordedDispatcher(10);
    const s = summary({ changedFiles: [f("a.ts")] });
    dispatcher.update(s);
    dispatcher.update({ ...s, changedFiles: [{ ...f("a.ts") }] }); // 内容等价，签名相同
    await wait(30);
    dispatcher.update({ ...s }); // 窗口结束后再次相同签名
    await wait(30);
    expect(events).toHaveLength(1);
  });

  // 节流窗口内多次变化只派发最终态，且窗口到期才派发
  test("coalesces rapid changes into one trailing dispatch", async () => {
    const { dispatcher, events } = recordedDispatcher(20);
    dispatcher.update(summary({ entryCount: 1, changedFiles: [f("a.ts")] }));
    await wait(5);
    dispatcher.update(summary({ entryCount: 2, changedFiles: [f("a.ts"), f("b.ts")] }));
    await wait(5);
    dispatcher.update(summary({ entryCount: 3, changedFiles: [f("c.ts")] }));
    expect(events).toHaveLength(0); // trailing-only：窗口内不派发
    await wait(40);
    expect(events).toHaveLength(1);
    expect(events[0].entryCount).toBe(3);
    expect(events[0].changedFiles).toEqual([f("c.ts")]);
  });

  // 窗口内签名再次变化只替换待发摘要，不提前派发（间隔恒 ≥ windowMs）
  test("does not dispatch early when signature changes in-window", () => {
    const { dispatcher, events } = recordedDispatcher(1000);
    dispatcher.update(summary({ entryCount: 1 }));
    dispatcher.update(summary({ entryCount: 2 }));
    expect(events).toHaveLength(0);
    dispatcher.flush(); // 卸载补发：拿到的是最新摘要
    expect(events).toHaveLength(1);
    expect(events[0].entryCount).toBe(2);
  });

  // 卸载/依赖切换时 flush 保证最终态到达消费方（含 entryCount 与 changedFiles 均未变但内容已变的防御）
  test("flush on cleanup delivers final state without waiting for window", () => {
    const { dispatcher, events } = recordedDispatcher(1000);
    dispatcher.update(summary({ entryCount: 5, changedFiles: [f("final.ts", "write")] }));
    expect(events).toHaveLength(0);
    dispatcher.flush();
    expect(events).toHaveLength(1);
    expect(events[0].changedFiles).toEqual([{ path: "final.ts", type: "write" }]);
  });

  // 无待发摘要时 flush 为空操作，不产生重复事件
  test("flush is a no-op when nothing pending", () => {
    const { dispatcher, events } = recordedDispatcher(10);
    dispatcher.flush();
    expect(events).toHaveLength(0);
  });

  // 默认构造走 window.dispatchEvent 派发 chat:stats，与消费方事件名闭环
  test("default emit dispatches chat:stats on window", async () => {
    const received: unknown[] = [];
    const handler = (e: Event) => received.push((e as CustomEvent).detail);
    window.addEventListener("chat:stats", handler as EventListener);
    const dispatcher = new ChatStatsDispatcher({ windowMs: 5 });
    dispatcher.update(summary({ entryCount: 2 }));
    await wait(20);
    window.removeEventListener("chat:stats", handler as EventListener);
    expect(received).toHaveLength(1);
    expect((received[0] as ChatStatsSummary).agentName).toBe("agent-a");
  });
});

// ── 消费方 hook：ChatArea 对 chat:stats 摘要协议的消费行为 ──
describe("useChangedFilesFromStats", () => {
  let root: Root | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
  });

  function renderHook() {
    const latest = { value: null as ChangedFile[] | null };
    function Probe({ id }: { id: string | null }) {
      latest.value = useChangedFilesFromStats(id);
      return null;
    }
    const container = win.document.createElement("div");
    root = createRoot(container as unknown as HTMLElement);
    return {
      latest,
      rerender: (id: string | null) =>
        act(() => {
          root?.render(createElement(Probe, { id }));
        }),
    };
  }

  const dispatch = (detail: unknown) => window.dispatchEvent(new CustomEvent("chat:stats", { detail }));

  // 摘要事件中的 changedFiles 正确进入消费方状态（新协议，非 entries）
  test("consumes changedFiles from summary event", async () => {
    const h = renderHook();
    h.rerender("agent-a");
    await act(async () => {
      dispatch(summary({ changedFiles: [f("a.ts", "write")] }));
    });
    expect(h.latest.value).toEqual([{ path: "a.ts", type: "write" }]);
  });

  // 其他 agent（keep-alive 隐藏槽位）派发的事件被过滤，不污染当前 agent
  test("ignores events from other agents", async () => {
    const h = renderHook();
    h.rerender("agent-a");
    await act(async () => {
      dispatch(summary({ agentName: "agent-b", changedFiles: [f("other.ts")] }));
    });
    expect(h.latest.value).toEqual([]);
  });

  // 切换 agent 时重置，避免残留上一个 agent 的摘要
  test("resets changedFiles when agent changes", async () => {
    const h = renderHook();
    h.rerender("agent-a");
    await act(async () => {
      dispatch(summary({ changedFiles: [f("a.ts")] }));
    });
    expect(h.latest.value).toHaveLength(1);
    h.rerender("agent-b"); // agent 切换
    expect(h.latest.value).toEqual([]);
  });

  // 实例重启（agent:reconnect）时清空同 agent 的 changedFiles
  test("clears changedFiles on agent:reconnect for same agent", async () => {
    const h = renderHook();
    h.rerender("agent-a");
    await act(async () => {
      dispatch(summary({ changedFiles: [f("a.ts")] }));
    });
    expect(h.latest.value).toHaveLength(1);
    await act(async () => {
      window.dispatchEvent(new CustomEvent("agent:reconnect", { detail: { envId: "agent-a" } }));
    });
    expect(h.latest.value).toEqual([]);
  });

  // 旧协议（仅 entries 字段）事件不会造成错误回填：changedFiles 回退为空数组
  test("falls back to empty array for legacy entries-only payload", async () => {
    const h = renderHook();
    h.rerender("agent-a");
    await act(async () => {
      dispatch({ agentName: "agent-a", entries: [{ type: "message" }] });
    });
    expect(h.latest.value).toEqual([]);
  });
});
