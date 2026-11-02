import { expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { useAcpSessionBootstrap } from "../chat/shell/internal/use-acp-session-bootstrap";
import type { ChatStateSnapshot } from "../chat/types";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const win = initializeHappyDomWindow(new Window());
const i18n = createInstance();
void i18n.use(initReactI18next).init({ lng: "zh", initAsync: false, ns: [UI_COMPONENTS_NS], resources: {} });

/** 最小权威投影：已有会话走恢复，确认空列表走创建。 */
function chatState(existing: boolean): ChatStateSnapshot {
  return {
    sessions: existing
      ? [{ sessionId: "ses-existing", title: "历史会话", preview: "", status: "idle", lastMsgTs: 0 }]
      : [],
    activeSessionId: existing ? "ses-existing" : "",
    permissions: [],
    capabilities: {},
    modelState: null,
    modeState: null,
    availableCommands: [],
    sessionListLoaded: true,
    tokenUsage: null,
  };
}

/** 通过真实 hook 观察恢复状态，并模拟下一次权威投影到达。 */
function renderBootstrap(existing: boolean, load: boolean) {
  const globals = globalThis as Record<string, unknown>;
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  let sent = false;
  let attempts = 0;
  let creating: Promise<string | null> | null = null;
  const latest: { current: ReturnType<typeof useAcpSessionBootstrap> | null } = { current: null };
  const chatRef = { current: null };
  const select = () => {
    attempts += 1;
    return sent;
  };
  const create = () => {
    attempts += 1;
    return creating ?? Promise.resolve(sent ? "ses-created" : null);
  };
  function Probe({ state }: { state: ChatStateSnapshot }) {
    latest.current = useAcpSessionBootstrap({
      connectionState: "connected",
      chatState: state,
      chatRef,
      supportsLoadSession: load,
      supportsResumeSession: !load,
      onLoadSession: select,
      onResumeSession: select,
      handleCreateSession: create,
    });
    return null;
  }
  const root = createRoot(win.document.createElement("div") as unknown as HTMLElement);
  const rerender = (hasSession = existing) =>
    act(() => root.render(createElement(Probe, { state: chatState(hasSession) })));
  rerender();
  return {
    latest,
    rerender,
    attempts: () => attempts,
    allowSend() {
      sent = true;
    },
    pendingCreate(promise: Promise<string | null>) {
      creating = promise;
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

// load/resume 发送被拒时不能把恢复标记为成功，下一次投影到达仍可恢复。
test.each([true, false])("会话恢复发送失败后可再次进入（load=%s）", async (load) => {
  const harness = renderBootstrap(true, load);
  try {
    expect(harness.latest.current?.initialActiveSessionId).toBeNull();
    const before = harness.attempts();
    harness.allowSend();
    harness.rerender();
    expect(harness.attempts()).toBeGreaterThan(before);
    expect(harness.latest.current?.initialActiveSessionId).toBe("ses-existing");
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.attempts()).toBe(before + 1);
  } finally {
    harness.unmount();
  }
});

// 创建未拿到回执不能永久压住自动引导，后续权威空列表仍能重新发起创建。
test("自动创建失败后不标记已进入", async () => {
  const harness = renderBootstrap(false, true);
  try {
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.attempts()).toBe(1);
    harness.allowSend();
    harness.rerender();
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.attempts()).toBe(2);
  } finally {
    harness.unmount();
  }
});

// 创建期间共享投影可能先于定向回执到达；不能因此重复创建或发送 load_session。
test("自动创建等待回执期间不重复创建或恢复投影中的新会话", async () => {
  const harness = renderBootstrap(false, true);
  let finish: ((sessionId: string) => void) | undefined;
  harness.pendingCreate(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  try {
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.attempts()).toBe(1);
    harness.rerender();
    await act(async () => {
      await Bun.sleep(350);
    });
    harness.rerender(true);
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.attempts()).toBe(1);
    await act(async () => {
      finish?.("ses-created");
    });
    harness.rerender(true);
    await act(async () => {
      await Bun.sleep(350);
    });
    expect(harness.attempts()).toBe(1);
  } finally {
    harness.unmount();
  }
});
