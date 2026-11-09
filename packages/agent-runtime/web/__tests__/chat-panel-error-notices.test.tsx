import { afterEach, expect, spyOn, test } from "bun:test";
import {
  appendEntryText,
  createDeterministicRcsSessionId,
  createPublicError,
  encodeYjsUpdateFrame,
  ensureEntry,
  getAgentStatus,
  initChatDocStructure,
  initSessionDocStructure,
  setSessionInfo,
} from "@fenix/chat-channel";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import * as Y from "yjs";
import { ChatPanel } from "../agent-panel/ChatPanel";
import { AGENT_CHAT_NS, agentChatResources } from "../i18n";
import {
  type FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  restoreFakeWebSocket,
  syncSockets,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

/** 使用真实面板和真实帧，覆盖卡片选择、历史消息与发送入口。 */
async function renderPanel() {
  installFakeWebSocket();
  const globals = globalThis as Record<string, unknown>;
  globals.getComputedStyle = win.getComputedStyle.bind(win);
  globals.ResizeObserver = win.ResizeObserver;
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: win.localStorage });
  win.localStorage.setItem("active_org_id", "org-notices");
  const i18n = createInstance();
  await i18n.init({
    lng: "en",
    initAsync: false,
    resources: { en: { [AGENT_CHAT_NS]: agentChatResources.en, [UI_COMPONENTS_NS]: uiComponentsResources.en } },
  });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, data: { spaces: [] } }));
  const container = win.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  await act(async () =>
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(ChatPanel, {
          agentId: "env-notices",
          sessionId: "inst-notices",
          hideSidebar: true,
          hostPorts: {
            authState: "ready",
            userId: "user-notices",
            usePeriTaskViews: () => ({ state: { tasks: [], loaded: true } }),
          },
        }),
      ),
    ),
  );
  const socket = legacySockets()[0]!;
  const key = createDeterministicRcsSessionId("env-notices", "user-notices", "inst-notices");
  act(() => socket.open());
  const receive = (frame: Record<string, unknown>) =>
    act(() => socket.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent));
  return {
    container,
    socket,
    key,
    receive,
    cleanup: () => {
      act(() => root.unmount());
      fetch.mockRestore();
      win.localStorage.clear();
      if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
      else Reflect.deleteProperty(globalThis, "localStorage");
    },
  };
}

/** 将内存文档投递到旧通道，不绕过 runtime 的快照读取路径。 */
function update(socket: FakeWebSocket, name: string, doc: Y.Doc) {
  act(() =>
    socket.onmessage?.({ data: encodeYjsUpdateFrame(name, "notices-g1", Y.encodeStateAsUpdate(doc)) } as MessageEvent),
  );
}

// 1011 降级后不伪造 Error ID；接管完成无卡片，历史不完整只保留一条恢复反馈。
test("健康接管静默，缺失历史展示唯一恢复提示", async () => {
  const h = await renderPanel();
  const chat = new Y.Doc();
  const session = new Y.Doc();
  try {
    act(() => syncSockets()[0]!.closeFromServer(1011, "private reason"));
    expect(h.container.textContent).not.toContain("ID: WS_1011");
    initChatDocStructure(chat);
    initSessionDocStructure(session);
    setSessionInfo(session, { sessionId: "ses-notices", status: "ready", replayState: "complete" });
    update(h.socket, `chat:${h.key}`, chat);
    update(h.socket, `session:${h.key}`, session);
    h.receive({ type: "error", payload: createPublicError("SYNC_RELAY.SYNC_FAILED") });
    h.receive({ type: "yjs:sync-complete", docs: [`chat:${h.key}`, `session:${h.key}`], generation: "notices-g1" });
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(h.container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    h.receive({
      type: "yjs:history-incomplete",
      docs: [`chat:${h.key}`],
      generation: "notices-g1",
      reason: "too_large",
      bytes: 100,
      limitBytes: 10,
    });
    expect(h.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(h.container.textContent).toContain("History sync incomplete");
    expect(h.container.textContent).not.toContain("SYNC_RELAY.SYNC_FAILED");
  } finally {
    h.cleanup();
    chat.destroy();
    session.destroy();
  }
});

// 本轮失败归属于消息，重复 WS/Agent 投影不应再堆顶部卡片；独立操作失败仍可见。
test("消息与顶部同 ID 只出现一次，独立操作错误保留", async () => {
  const h = await renderPanel();
  const chat = new Y.Doc();
  const session = new Y.Doc();
  const error = createPublicError("AGENT_RUNTIME.REQUEST_FAILED");
  const operation = createPublicError("ACTION.OUTCOME_UNKNOWN");
  try {
    act(() => syncSockets()[0]!.closeFromServer(1011, "closed"));
    initChatDocStructure(chat);
    initSessionDocStructure(session);
    const entry = ensureEntry(chat, {
      entryId: "assistant-notices",
      role: "assistant",
      kind: "message",
      turnId: "turn-notices",
    });
    appendEntryText(chat, "assistant-notices", "block-notices", "text", "Answer failed");
    entry.set("error", error);
    entry.set("status", "error");
    setSessionInfo(session, { sessionId: "ses-notices", status: "ready", replayState: "complete" });
    getAgentStatus(session).set("publicError", error);
    update(h.socket, `chat:${h.key}`, chat);
    update(h.socket, `session:${h.key}`, session);
    h.receive({ type: "error", payload: error });
    await act(async () => {
      await Bun.sleep(10);
    });
    h.receive({ type: "action_error", commandId: "command-notices", error: operation });
    await act(async () => {
      await Bun.sleep(300);
    });
    expect(h.container.textContent?.split(error.id)).toHaveLength(2);
    expect(h.container.textContent).toContain(operation.id);
  } finally {
    h.cleanup();
    chat.destroy();
    session.destroy();
  }
});

// 自动重连期间先反馈正在恢复，真实终态结束后仍保留故障反馈。
test.each([1006, 4500])("关闭码 %s 保持自动重连与终态故障的反馈区别", async (code) => {
  const h = await renderPanel();
  const error = createPublicError("SYNC_RELAY.CONNECTION_LOST");
  try {
    h.receive({ type: "error", payload: error });
    act(() => h.socket.closeFromServer(code, "lost"));
    if (code === 1006) {
      expect(h.container.textContent).toContain("Reconnecting");
      expect(h.container.querySelector('[role="alert"]')).toBeNull();
    } else {
      expect(h.container.querySelector('[role="alert"]')?.textContent).toContain(error.id);
      expect(h.container.textContent).not.toContain("Reconnecting");
    }
  } finally {
    h.cleanup();
  }
});

// 队列与回答等操作没有草稿恢复横幅，独立失败必须各自可见，成功回执只结算自己的命令。
test("独立操作失败不覆盖未知结果，回执只清理对应项", async () => {
  const h = await renderPanel();
  const unknown = createPublicError("ACTION.OUTCOME_UNKNOWN");
  const failed = createPublicError("ACTION.FAILED");
  try {
    h.receive({ type: "action_error", commandId: "queue-operation", error: unknown });
    h.receive({ type: "action_error", commandId: "answer-operation", error: failed });
    expect(h.container.textContent).toContain(unknown.id);
    expect(h.container.textContent).toContain(failed.id);
    h.receive({ type: "action_ack", commandId: "answer-operation", status: "committed" });
    expect(h.container.textContent).toContain(unknown.id);
    expect(h.container.textContent).not.toContain(failed.id);
    const close = h.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss error"]');
    act(() => close?.click());
    expect(h.container.textContent).not.toContain(unknown.id);
  } finally {
    h.cleanup();
  }
});
