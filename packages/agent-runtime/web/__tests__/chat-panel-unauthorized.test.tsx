import { afterEach, expect, spyOn, test } from "bun:test";
import { UI_COMPONENTS_NS, uiComponentsResources } from "@fenix/ui-components/i18n";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { ChatPanel } from "../agent-panel/ChatPanel";
import { AGENT_CHAT_NS, agentChatResources } from "../i18n";
import {
  FakeWebSocket,
  installFakeWebSocket,
  isSyncSocket,
  restoreFakeWebSocket,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

// 服务端只发 4003 而无 error 帧时，中英文面板都必须显示权限错误并结束重连提示。
test.each(
  (
    [
      ["zh", "无法访问此智能体", "请检查登录状态和当前组织权限，再重新进入智能体。"],
      [
        "en",
        "Cannot access this agent",
        "Check your sign-in status and current organization permissions, then reopen the agent.",
      ],
    ] as const
  ).flatMap(([language, title, description]) =>
    (["legacy", "sync"] as const).map((channel) => [language, channel, title, description] as const),
  ),
)("4003 在 %s 界面的 %s 通道显示明确权限错误", async (language, channel, title, description) => {
  installFakeWebSocket();
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = new Map([["active_org_id", "org-unauthorized"]]);
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    initAsync: false,
    resources: {
      zh: { [AGENT_CHAT_NS]: agentChatResources.zh, [UI_COMPONENTS_NS]: uiComponentsResources.zh },
      en: { [AGENT_CHAT_NS]: agentChatResources.en, [UI_COMPONENTS_NS]: uiComponentsResources.en },
    },
  });
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true, data: { spaces: [] } }));
  const container = win.document.createElement("div");
  const root = createRoot(container as unknown as HTMLElement);
  try {
    await act(async () => {
      root.render(
        createElement(
          I18nextProvider,
          { i18n },
          createElement(ChatPanel, {
            agentId: "env-unauthorized",
            sessionId: "inst-unauthorized",
            hostPorts: {
              authState: "ready",
              userId: "user-unauthorized",
              usePeriTaskViews: () => ({ state: { tasks: [], loaded: true } }),
            },
          }),
        ),
      );
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    const socket = FakeWebSocket.instances.find((candidate) => isSyncSocket(candidate) === (channel === "sync"));
    expect(socket).toBeDefined();
    act(() => {
      socket?.closeFromServer(4003, "unauthorized");
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain(title);
    expect(alert?.textContent).toContain(description);
    expect(container.textContent).not.toContain(agentChatResources[language].reconnecting);
  } finally {
    act(() => root.unmount());
    fetch.mockRestore();
    if (previousStorage) Object.defineProperty(globalThis, "localStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
});
