// web/src/__tests__/use-chat-state-hook.test.tsx
// SP-B1 验收项「切换会话、StrictMode 双挂载行为不回归」的 hook 级测试：
// useChatState / useSessionState 的 store 绑定语义已从「自建 doc」改为
// 「DocHub 引用计数共享 doc」，此处渲染真实 hook 验证生命周期配对：
// - 切换会话（A→B）：旧 entry 引用释放（部分释放不销毁共享 doc）、
//   新旧会话数据互不串扰、状态快照正确跟随新会话；
// - StrictMode 双挂载：dev 构建下 effects 双调用（mount → cleanup destroy →
//   effect 重跑），重挂载后经 switchDoc 重建 hub 绑定，后续 update 仍可见；
// - 卸载后引用计数归零：共享 doc 销毁、hub entry 移除（无泄漏）。

import { describe, expect, test } from "bun:test";
import type { ChatStateSnapshot, SessionStateSnapshot } from "@fenix/chat-channel";
import { createSessionDoc, setSessionInfo } from "@fenix/chat-channel";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { useChatState } from "../hooks/use-chat-state";
import { useSessionState } from "../hooks/use-session-state";
import { createSessionDocBinding } from "../yjs/doc-hub";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 设置最小 DOM 环境（react-dom/client 模块加载时需要 window；与
// chat-composer.test.tsx 同款处理，仅在本文件作用域内生效）
const win = new Window();
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = win;
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;

/** 渲染包裹 StrictMode 的探针组件，返回最新 hook 快照与重渲染/卸载控制 */
function createHarness<T>(useHook: (rcsSessionId: string) => { state: T }) {
  const latest = { value: null as T | null };
  function Probe({ rcsSessionId }: { rcsSessionId: string }) {
    const { state } = useHook(rcsSessionId);
    latest.value = state;
    return null;
  }
  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  return {
    latest,
    render: (rcsSessionId: string) =>
      act(() => {
        root.render(createElement(StrictMode, null, createElement(Probe, { rcsSessionId })));
      }),
    unmount: () =>
      act(() => {
        root.unmount();
      }),
  };
}

/** 等待派生重算调度落地（Yjs observe → store 通知 → useSyncExternalStore） */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** hub 共享 doc 为裸 Y.Doc：注入 Session Doc 骨架（root.session/agent 等）后才能用包内 writer 写入 */
function seedSessionSkeleton(doc: Y.Doc): void {
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(createSessionDoc("skeleton", null).ydoc));
}

describe("useChatState hook 生命周期", () => {
  // 切换会话 A→B：旧 entry 的 hook 引用释放（旁观绑定仍持有时不销毁），
  // 新会话数据可见且不串扰旧会话，快照正确跟随新 sessionId
  test("切换会话时旧引用释放、新会话数据隔离、快照跟随", async () => {
    // 旁观绑定：持有 A 的 session doc 引用，用于断言「部分释放不销毁」
    const spectatorA = createSessionDocBinding("rcs-hook-a");
    const docA = spectatorA.ydoc;
    act(() => {
      seedSessionSkeleton(docA);
      setSessionInfo(docA, { sessionId: "ses-a", title: "会话A", status: "ready" });
    });

    const harness = createHarness<ChatStateSnapshot>(useChatState);
    harness.render("rcs-hook-a");
    await flush();
    expect(harness.latest.value?.activeSessionId).toBe("ses-a");

    // 切到 B：A 的两个 hook store 各 release 一次，但旁观绑定仍持有 → doc 存活
    harness.render("rcs-hook-b");
    await flush();
    expect(docA.isDestroyed).toBe(false);

    // B 会话 session doc 经旁观绑定写入数据：快照跟随 B、不串扰 A 的 ses-a
    const spectatorB = createSessionDocBinding("rcs-hook-b");
    act(() => {
      seedSessionSkeleton(spectatorB.ydoc);
      setSessionInfo(spectatorB.ydoc, { sessionId: "ses-b", title: "会话B", status: "ready" });
    });
    await flush();
    expect(harness.latest.value?.activeSessionId).toBe("ses-b");

    // 卸载后旁观仍持引用：doc 存活（单连接故障隔离的对称保证）；
    // 旁观释放后 entry 引用计数归零，共享 doc 销毁（无泄漏）
    harness.unmount();
    expect(spectatorB.ydoc.isDestroyed).toBe(false);
    spectatorB.cleanup();
    expect(spectatorB.ydoc.isDestroyed).toBe(true);
    spectatorA.cleanup();
    expect(docA.isDestroyed).toBe(true);
  });

  // StrictMode 双挂载：首挂 cleanup destroy 后 effect 重跑（activeKey 已重置），
  // 重挂载后仍能收到后续 session doc 更新
  test("StrictMode 双挂载 destroy 后重绑并接收后续更新", async () => {
    const spectator = createSessionDocBinding("rcs-hook-sm");
    seedSessionSkeleton(spectator.ydoc);
    const harness = createHarness<ChatStateSnapshot>(useChatState);
    harness.render("rcs-hook-sm");
    await flush();

    // 双挂载完成后写入：若 destroy 后未重新绑定 hub doc，此更新不可见
    act(() => {
      setSessionInfo(spectator.ydoc, { sessionId: "ses-sm", title: "双挂载", status: "ready" });
    });
    await flush();
    expect(harness.latest.value?.activeSessionId).toBe("ses-sm");

    harness.unmount();
    spectator.cleanup();
    expect(spectator.ydoc.isDestroyed).toBe(true);
  });
});

describe("useSessionState hook 生命周期", () => {
  // 切换会话 A→B：meta 快照跟随新会话的 session 投影字段（acpSessionId 回退
  // 读 session.sessionId），旧会话 entry 在 hook 侧释放（旁观持有期间不销毁）
  test("切换会话时快照跟随新会话且旧 doc 未被提前销毁", async () => {
    const spectatorA = createSessionDocBinding("rcs-sess-a");
    const docA = spectatorA.ydoc;
    act(() => {
      seedSessionSkeleton(docA);
      setSessionInfo(docA, { sessionId: "ses-sa", title: "A", status: "ready" });
    });

    const harness = createHarness<SessionStateSnapshot>(useSessionState);
    harness.render("rcs-sess-a");
    await flush();
    expect(harness.latest.value?.acpSessionId).toBe("ses-sa");

    harness.render("rcs-sess-b");
    await flush();
    expect(docA.isDestroyed).toBe(false);

    const spectatorB = createSessionDocBinding("rcs-sess-b");
    act(() => {
      seedSessionSkeleton(spectatorB.ydoc);
      setSessionInfo(spectatorB.ydoc, { sessionId: "ses-sb", title: "B", status: "ready" });
    });
    await flush();
    expect(harness.latest.value?.acpSessionId).toBe("ses-sb");

    harness.unmount();
    spectatorB.cleanup();
    expect(spectatorB.ydoc.isDestroyed).toBe(true);
    spectatorA.cleanup();
  });

  // StrictMode 双挂载：重挂载后 session 投影字段更新仍可见（canCancel 透传）
  test("StrictMode 双挂载重绑后接收 canCancel 更新", async () => {
    const spectator = createSessionDocBinding("rcs-sess-sm");
    seedSessionSkeleton(spectator.ydoc);
    const harness = createHarness<SessionStateSnapshot>(useSessionState);
    harness.render("rcs-sess-sm");
    await flush();
    expect(harness.latest.value?.canCancel).toBe(false);

    act(() => {
      setSessionInfo(spectator.ydoc, { sessionId: "ses-sm2", status: "ready", canCancel: true });
    });
    await flush();
    expect(harness.latest.value?.canCancel).toBe(true);

    harness.unmount();
    spectator.cleanup();
  });

  // 会话数据隔离兜底：A 的时间线数据在切到 B 后不再出现（chat doc 副本独立）
  test("切换后旧会话时间线数据不串扰", async () => {
    const chatBindingA = createSessionDocBinding("rcs-tl-a");
    // 借 session entry 持有 A 存活到断言结束；chat doc 属同一 entry
    const harness = createHarness<SessionStateSnapshot>(useSessionState);
    harness.render("rcs-tl-a");
    await flush();
    expect(harness.latest.value?.structuredMessages).toEqual([]);

    // 切到无数据的 B：时间线保持空（A 侧后续写入不得泄漏进 B 的快照）
    harness.render("rcs-tl-b");
    const rootA = chatBindingA.ydoc.getMap("root");
    act(() =>
      chatBindingA.ydoc.transact(() => {
        const order = new Y.Array<string>();
        const entries = new Y.Map<Y.Map<unknown>>();
        const entry = new Y.Map<unknown>();
        entry.set("kind", "message");
        entry.set("role", "user");
        entries.set("e1", entry);
        order.push(["e1"]);
        rootA.set("entryOrder", order);
        rootA.set("entries", entries);
      }),
    );
    await flush();
    expect(harness.latest.value?.structuredMessages).toEqual([]);

    harness.unmount();
    chatBindingA.cleanup();
  });
});
