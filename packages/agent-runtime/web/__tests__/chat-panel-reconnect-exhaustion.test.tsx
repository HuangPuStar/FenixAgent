import { afterEach, expect, spyOn, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ChatPanel } from "../agent-panel/ChatPanel";
import { AGENT_CHAT_NS, agentChatResources } from "../i18n";
import {
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

type Timer = { callback: () => void; delay: number; cancelled: boolean; fired: boolean };

/** 真实 hook 的重连退避依赖定时器；用可控时钟把 31 秒的重试窗口压缩到同步调用。 */
function installClock() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const originalNow = Date.now;
  const timers: Timer[] = [];
  let now = 0;
  Date.now = () => now;
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    const timer = { callback, delay, cancelled: false, fired: false };
    timers.push(timer);
    return timer;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((timer: Timer | number) => {
    if (timer && typeof timer === "object" && "cancelled" in timer) timer.cancelled = true;
    else originalClearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
  }) as unknown as typeof globalThis.clearTimeout;
  return {
    fireLast(delay: number) {
      const timer = [...timers]
        .reverse()
        .find((candidate) => !candidate.cancelled && !candidate.fired && candidate.delay === delay);
      if (!timer) throw new Error(`timer ${delay} not scheduled`);
      now += delay;
      timer.fired = true;
      act(() => timer.callback());
    },
    pending() {
      return timers.filter((candidate) => !candidate.cancelled && !candidate.fired);
    },
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
      Date.now = originalNow;
    },
  };
}

/** 依次制造 6 次不足 30 秒的 1006 断连，走完 1/2/4/8/16 秒退避。 */
function exhaustReconnects(clock: ReturnType<typeof installClock>, options: { openBeforeClose?: boolean } = {}) {
  const delays = [1000, 2000, 4000, 8000, 16000];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const socket = legacySockets()[attempt];
    if (!socket) throw new Error(`missing socket ${attempt}`);
    if (options.openBeforeClose !== false) act(() => socket.open());
    act(() => socket.closeFromServer(1006, "temporary_network_outage"));
    if (attempt < 5) clock.fireLast(delays[attempt]!);
  }
}

function setDocumentVisibility(state: "visible" | "hidden") {
  Object.defineProperty(win.document, "visibilityState", { configurable: true, get: () => state });
}

// 有界重试耗尽后必须结束自动重连提示，并给渲染层一个明确、可点击的恢复入口。
test("六次 1006 后进入耗尽态：autoReconnecting=false、connectionState=error", () => {
  installFakeWebSocket();
  const clock = installClock();
  const harness = renderRuntime();
  try {
    exhaustReconnects(clock);

    expect(legacySockets()).toHaveLength(6);
    expect(harness.latest.current?.connectionState).toBe("error");
    expect(harness.latest.current?.autoReconnecting).toBe(false);
    expect(harness.latest.current?.reconnectExhausted).toBe(true);
    expect(harness.latest.current?.terminalUiCode).toBeNull();
    // 只关心传输层重连定时器；React 调度器可能留下自己的零延迟任务。
    expect(clock.pending().filter((timer) => timer.delay === 30000)).toHaveLength(0);
  } finally {
    harness.unmount();
    clock.restore();
  }
});

// 浏览器恢复在线时应自动开始新一轮有界重试，保留同一 hook 状态（面板/草稿/会话身份）。
test("online 事件在耗尽后重建连接", () => {
  installFakeWebSocket();
  const clock = installClock();
  const harness = renderRuntime();
  try {
    exhaustReconnects(clock);
    act(() => {
      win.dispatchEvent(new win.Event("online"));
    });

    expect(legacySockets()).toHaveLength(7);
    expect(harness.latest.current?.connectionState).toBe("connecting");
    expect(harness.latest.current?.autoReconnecting).toBe(false);
    expect(harness.latest.current?.reconnectExhausted).toBe(false);

    act(() => legacySockets()[6]?.open());
    expect(harness.latest.current?.connectionState).toBe("connected");
  } finally {
    harness.unmount();
    clock.restore();
  }
});

// 页面从后台回到前台（hidden -> visible）同样应触发新一轮有界重试。
test("visibilitychange 回到前台在耗尽后重建连接", () => {
  installFakeWebSocket();
  const clock = installClock();
  const harness = renderRuntime();
  try {
    exhaustReconnects(clock);
    setDocumentVisibility("hidden");
    act(() => win.document.dispatchEvent(new win.Event("visibilitychange")));
    expect(legacySockets()).toHaveLength(6);

    setDocumentVisibility("visible");
    act(() => win.document.dispatchEvent(new win.Event("visibilitychange")));
    expect(legacySockets()).toHaveLength(7);
    expect(harness.latest.current?.connectionState).toBe("connecting");
  } finally {
    harness.unmount();
    setDocumentVisibility("visible");
    clock.restore();
  }
});

// 显式停止（4002）与权限拒绝（4003）是终态：网络恢复/页面可见都不得自动重启。
test.each([
  [4002, "instance_stopped"],
  [4003, "unauthorized"],
] as const)("%i 终态不被 online/可见性恢复重启", (code, uiCode) => {
  installFakeWebSocket();
  const harness = renderRuntime();
  try {
    act(() => legacySockets()[0]?.open());
    act(() => legacySockets()[0]?.closeFromServer(code, uiCode));
    expect(harness.latest.current?.terminalUiCode).toBe(uiCode);
    expect(harness.latest.current?.autoReconnecting).toBe(false);

    act(() => win.dispatchEvent(new win.Event("online")));
    setDocumentVisibility("hidden");
    act(() => win.document.dispatchEvent(new win.Event("visibilitychange")));
    setDocumentVisibility("visible");
    act(() => win.document.dispatchEvent(new win.Event("visibilitychange")));

    expect(legacySockets()).toHaveLength(1);
    expect(harness.latest.current?.reconnectExhausted).toBe(false);
  } finally {
    harness.unmount();
    setDocumentVisibility("visible");
  }
});

// 耗尽后的面板不得再显示“重连中”，重连按钮必须可点击并立即建立新连接。
test("ChatPanel 耗尽后显示停止说明与可用的重连按钮", async () => {
  installFakeWebSocket();
  const clock = installClock();
  const i18n = createInstance();
  await i18n.init({
    lng: "zh",
    initAsync: false,
    resources: {
      zh: { [AGENT_CHAT_NS]: agentChatResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
    },
  });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, data: { spaces: [] } }));
  const container = win.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  try {
    act(() => {
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ChatPanel, {
            agentId: "env-1",
            sessionId: "inst-1",
            hostPorts: {
              authState: "ready",
              userId: "user-1",
              usePeriTaskViews: () => ({ state: { tasks: [], loaded: true } }),
            },
          }),
        ),
      );
    });
    exhaustReconnects(clock, { openBeforeClose: false });

    expect(container.textContent).toContain(agentChatResources.zh.reconnectExhausted);
    expect(container.textContent).not.toContain(agentChatResources.zh.reconnecting);
    const button = [...container.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === agentChatResources.zh.reconnectNow,
    );
    expect(button).toBeDefined();

    act(() => button?.click());
    expect(legacySockets()).toHaveLength(7);
  } finally {
    act(() => root.unmount());
    fetch.mockRestore();
    clock.restore();
  }
});
