// 消息通道页在运行时的状态接线（loading / empty / error + 重试 / unauthorized / ready）。
//
// 这些状态由 `request()` 的返回形状与 `useRequest` 的时序共同决定，读源码断言不到：
// 错误被 `unwrap` 抛出后是否落到整块 `role="alert"`、重试按钮是否真的重新发起请求、403 是否
// 换成无权限态而不是可重试的错误态。页面组件经包的浏览器入口加载，与宿主装配的是同一份实现。
//
// 环境：happy-dom + react-dom/client；`fetch` 用模块级替身（不 mock 请求基建本身，避免把
// `unwrap` / `ApiError` 的行为也替换掉）。

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

/** 构造一个 `/web/*` 信封响应。 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes(label));
}

/** 每个用例只关心自己那条请求；默认三个端点都返回空列表。 */
function defaultHandler(url: string): Response {
  if (url.includes("/web/config/agents")) return jsonResponse({ success: true, data: { agents: [] } });
  return jsonResponse({ success: true, data: [] });
}

describe("消息通道页状态接线", () => {
  let host: HTMLDivElement;
  let root: Root;
  let fetchCalls = 0;
  let handler: (url: string) => Response | Promise<Response>;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    fetchCalls = 0;
    handler = defaultHandler;
    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls += 1;
      return handler(String(input));
    }) as unknown as typeof fetch;
    // 失败路径会把后端错误原文打到 console.error；用例只关心界面，静音以免刷屏。
    originalConsoleError = console.error;
    console.error = () => {};
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
  });

  /** 渲染页面并等待首轮请求落地；`useRequest` 的状态更新发生在 promise 之后的微任务里。 */
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

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  // 业务意图：首屏请求未落地时必须显示骨架（`aria-busy`），不能先渲染「还没有通道」让用户误以为数据被清空。
  test("首屏请求进行中：渲染加载骨架", async () => {
    let resolveBots: ((response: Response) => void) | null = null;
    const pendingBots = new Promise<Response>((resolve) => {
      resolveBots = resolve;
    });
    // 只挂起通道列表：Response 的 body 只能读一次，三路请求共用同一个实例会互相消费掉。
    handler = (url) => (url.includes("/channels/langbot/bots") ? pendingBots : defaultHandler(url));

    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AgentChannelsPage />
        </I18nextProvider>,
      );
    });

    expect(host.querySelector("[aria-busy='true']")).not.toBeNull();

    await act(async () => {
      resolveBots?.(jsonResponse({ success: true, data: [] }));
      await pendingBots;
    });
    await flush();
    expect(host.textContent).toContain(TEXT.bots.emptyTitle);
  });

  // 业务意图：通道为空时给出创建引导，而不是一个空表格加一个「重试」——重试解决不了「确实没有通道」。
  test("请求成功但没有通道：渲染空态与创建入口", async () => {
    await renderPage();

    expect(host.textContent).toContain(TEXT.bots.emptyTitle);
    expect(host.textContent).toContain(TEXT.bots.emptyDescription);
    expect(findButton(host, TEXT.bots.create)).toBeDefined();
    expect(host.querySelector("[aria-busy='true']")).toBeNull();
  });

  // 业务意图：控制面不可用时错误块必须带 `role="alert"` 与可用的重试出口，且重试真的重新发请求。
  test("加载失败：渲染 role=alert 错误态，重试重新请求", async () => {
    handler = () =>
      jsonResponse({ success: false, error: { code: "LANGBOT_UNREACHABLE", message: "LangBot 不可达" } }, 500);

    await renderPage();

    const alert = host.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain(TEXT.common.loadFailed);
    expect(alert?.textContent).toContain("LangBot 不可达");

    const retry = findButton(host, TEXT.common.retry);
    expect(retry).toBeDefined();
    const callsBeforeRetry = fetchCalls;

    await act(async () => {
      retry?.click();
    });
    await flush();

    // 合并视图一次刷新会并发取通道与路由，重试必须把两条列表请求都重新发出。
    expect(fetchCalls).toBe(callsBeforeRetry + 2);
  });

  // 业务意图：403 是持久状态，显示无权限说明且不给重试（重试只会再失败一次）。
  test("无权限：渲染无权限态且不提供重试", async () => {
    handler = () => jsonResponse({ success: false, error: { code: "FORBIDDEN", message: "forbidden" } }, 403);

    await renderPage();

    const alert = host.querySelector("[role='alert']");
    expect(alert?.textContent).toContain(TEXT.common.unauthorizedTitle);
    expect(findButton(host, TEXT.common.retry)).toBeUndefined();
  });

  // 业务意图：拿到数据后渲染通道树；父行必须能一眼核对通道是否接对，子行要能看到路由归属。
  test("有通道：渲染通道树与路由子行", async () => {
    handler = (url) => {
      if (url.includes("/web/config/agents")) {
        return jsonResponse({ success: true, data: { agents: [{ id: "agent-1", name: "客服 Agent" }] } });
      }
      if (url.includes("/channels/langbot/routes")) {
        return jsonResponse({
          success: true,
          data: [
            {
              id: "route-1",
              channelId: "channel-1",
              chatType: "group",
              chatId: "chat-1",
              agentConfigId: "agent-1",
              enabled: true,
              instances: [],
              createdAt: "2026-10-01T00:00:00.000Z",
              updatedAt: "2026-10-01T00:00:00.000Z",
            },
          ],
        });
      }
      return jsonResponse({
        success: true,
        data: [
          {
            botUuid: "bot-1",
            name: "客服机器人",
            adapter: "feishu",
            channelId: "channel-1",
            channelName: "客服通道",
            status: "connected",
            boundRouteCount: 2,
            missingInLangbot: false,
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        ],
      });
    };

    await renderPage();

    expect(host.querySelector("button[aria-expanded='true']")).not.toBeNull();
    expect(host.textContent).toContain("客服机器人");
    expect(host.textContent).toContain(TEXT.bots.status.connected);
    expect(host.textContent).toContain("chat-1");
    expect(host.textContent).toContain("客服 Agent");
  });
});
