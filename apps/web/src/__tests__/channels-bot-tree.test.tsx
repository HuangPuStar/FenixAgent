// 通道树的两层结构与展开行为：父行是通道，子行是该通道的路由。
//
// 合并后首屏同时请求 bots、routes 与 agents，父行与子行必须来自同一次取数；
// 这里只断言用户可见的结果——默认展开、收起后子行消失、无路由时的引导入口。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AgentChannelsPage, CHANNELS_NS, channelsResources } from "@fenix/resource-channel/web";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";

const window = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = window;
globalRecord.document = window.document;
globalRecord.navigator = window.navigator;
globalRecord.HTMLElement = window.HTMLElement;
globalRecord.customElements = window.customElements;
// Radix Tabs 在挂载动画里调用 requestAnimationFrame；缺它时 useEffect 直接抛错，页面状态会停在半渲染。
globalRecord.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalRecord.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
// Radix 的 presence / roving-focus 依赖同 realm 的样式与 DOM 原子类型；只注入 document 不够。
globalRecord.getComputedStyle = window.getComputedStyle.bind(window);
globalRecord.MutationObserver = window.MutationObserver;
globalRecord.ResizeObserver = window.ResizeObserver;
globalRecord.Node = window.Node;
globalRecord.Element = window.Element;
globalRecord.Event = window.Event;
globalRecord.KeyboardEvent = window.KeyboardEvent;
globalRecord.MouseEvent = window.MouseEvent;
globalRecord.IS_REACT_ACT_ENVIRONMENT = true;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [CHANNELS_NS, UI_COMPONENTS_NS],
  defaultNS: CHANNELS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: {
    en: {
      [CHANNELS_NS]: channelsResources.en,
      [UI_COMPONENTS_NS]: uiComponentsResources.en,
    },
  },
});

const TEXT = channelsResources.en.langbot;
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const BOT = {
  botUuid: "bot-1",
  name: "客服机器人",
  adapter: "telegram-omni",
  channelId: "channel-1",
  channelName: "客服通道",
  status: "connected",
  boundRouteCount: 1,
  missingInLangbot: false,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const ROUTE = {
  id: "route-1",
  channelId: "channel-1",
  chatType: "group",
  chatId: "chat-1",
  agentConfigId: "agent-1",
  enabled: true,
  instances: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("消息通道树", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handler: (url: string) => Response;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
    handler = (url) =>
      url.includes("/web/config/agents")
        ? jsonResponse({ success: true, data: { agents: [] } })
        : jsonResponse({ success: true, data: [] });
    globalThis.fetch = (async (input: string | URL | Request) => handler(String(input))) as unknown as typeof fetch;
    originalConsoleError = console.error;
    console.error = () => {};
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
  });

  /** 按端点返回合并视图需要的三份数据。 */
  function serve(input: { bots: unknown[]; routes: unknown[]; agents?: unknown[] }): void {
    handler = (url) => {
      if (url.includes("/web/config/agents")) {
        return jsonResponse({ success: true, data: { agents: input.agents ?? [] } });
      }
      if (url.includes("/channels/langbot/routes")) {
        return jsonResponse({ success: true, data: input.routes });
      }
      return jsonResponse({ success: true, data: input.bots });
    };
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function renderPage(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AgentChannelsPage />
        </I18nextProvider>,
      );
    });
    await flush();
  }

  // 业务意图：路由挂在通道下，默认就要看得见；否则用户仍要逐个点开才知道聊天交给了谁。
  test("默认展开：子行展示聊天类型、chatId 与 Agent 名", async () => {
    serve({ bots: [BOT], routes: [ROUTE], agents: [{ id: "agent-1", name: "客服 Agent" }] });

    await renderPage();

    const toggle = host.querySelector("button[aria-expanded='true']");
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-controls")).not.toBeNull();
    expect(toggle?.getAttribute("aria-label")).toBe(TEXT.bots.tree.collapse.replace("{{name}}", BOT.name));
    expect(host.textContent).toContain(BOT.name);
    expect(host.textContent).toContain(TEXT.routes.chatTypeGroup);
    expect(host.textContent).toContain("chat-1");
    expect(host.textContent).toContain("客服 Agent");

    // 删除是破坏性动作，图标态也必须保持红色，避免与普通操作混淆。
    const deleteButton = host.querySelector(`button[aria-label="${TEXT.bots.delete}"]`);
    expect(deleteButton?.className).toContain("text-destructive");
  });

  // 业务意图：收起是纯前端视图状态，收起后子行必须整块消失，读屏也不应再遍历到隐藏内容。
  test("点收起后子行消失且 aria-expanded 变为 false", async () => {
    serve({ bots: [BOT], routes: [ROUTE], agents: [{ id: "agent-1", name: "客服 Agent" }] });

    await renderPage();
    expect(host.textContent).toContain("chat-1");

    const toggle = host.querySelector("button[aria-expanded='true']");
    await act(async () => {
      (toggle as HTMLButtonElement | null)?.click();
    });
    await flush();

    expect(host.textContent).not.toContain("chat-1");
    const collapsed = host.querySelector("button[aria-expanded='false']");
    expect(collapsed).not.toBeNull();
    expect(collapsed?.getAttribute("aria-controls")).toBeNull();
  });

  // 业务意图：通道可能还没有路由；空提示要就地给出创建入口，而不是让用户去别的页签找。
  test("通道没有路由时：不算整页空态，子层给出空提示与对接入口", async () => {
    serve({ bots: [BOT], routes: [] });

    await renderPage();

    expect(host.textContent).not.toContain(TEXT.bots.emptyTitle);
    expect(host.textContent).toContain(TEXT.bots.tree.routesEmpty);
    // 父行是图标按钮，空提示保留文字入口，两处都能发起对接。
    const iconEntry = host.querySelector(`button[aria-label="${TEXT.bots.tree.addRoute}"]`);
    const textEntry = Array.from(host.querySelectorAll("button")).find((button) =>
      button.textContent?.includes(TEXT.bots.tree.addRoute),
    );
    expect(iconEntry).not.toBeNull();
    expect(textEntry).toBeDefined();
  });

  // 业务意图：实例名由后端派生，子行要直出这个名称，前端不得自己拼 `im-<会话id>`。
  test("路由带实例时：子行展示实例名", async () => {
    serve({
      bots: [BOT],
      routes: [{ ...ROUTE, instances: [{ conversationId: "conv-1", instanceName: "im-conv-1" }] }],
    });

    await renderPage();

    expect(host.textContent).toContain("im-conv-1");
  });

  // 业务意图：启用中但还没有会话时，要明确说出实例尚未创建，而不是留空让人以为界面漏渲染。
  test("启用路由没有实例时：子行提示尚未创建", async () => {
    serve({ bots: [BOT], routes: [ROUTE] });

    await renderPage();

    expect(host.textContent).toContain(TEXT.bots.tree.instancesEmpty);
  });
});
