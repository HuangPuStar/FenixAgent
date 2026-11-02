// 管理台「消息通道」页（`/admin/channels`）的运行时接线。
//
// 这页的凭据是系统 master key（sessionStorage），数据只有一条 `/api/system/channels`。用例覆盖四件事：
// 拓扑四层的层级与实例名真的渲染出来、没有通道时是空态而不是空表、失败态可重试且重试真的重新请求、
// 401 会清 key 回门；另加一条客户端分页（每页 10 条）的行为断言。
//
// 环境：happy-dom + react-dom/client；`fetch` 用模块级替身（不 mock 请求基建本身，`unwrap` / `ApiError`
// 的语义因此与生产一致）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AdminChannelsPage, CHANNELS_NS, channelsResources } from "@fenix/resource-channel/web";
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
// `useAdminKeyGate` 读写的是全局 sessionStorage；happy-dom 的实现挂在 window 上。
globalRecord.sessionStorage = window.sessionStorage;
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
const ADMIN_KEY_STORAGE_KEY = "rcs_admin_master_key";
const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function snapshot(organizations: unknown[]): Response {
  return jsonResponse({
    success: true,
    data: {
      status: { reachable: true, version: "v4.11.2", edition: "ce", wizardStatus: "done" },
      organizations,
    },
  });
}

/** 一条通道 + 指定数量的会话实例；实例字段与后端 schema 逐字段对应。 */
function organizationWithInstances(instanceCount: number): unknown[] {
  return [
    {
      id: "org-1",
      name: "研发部",
      users: [
        {
          id: "user-1",
          name: "张三",
          email: "zs@example.com",
          channels: [
            {
              id: "channel-1",
              name: "飞书机器人",
              adapter: "lark",
              status: "connected",
              botUuid: "bot-1",
              createdAt: "2026-01-01T00:00:00.000Z",
              instances: Array.from({ length: instanceCount }, (_unused, index) => ({
                conversationId: `conversation-${index + 1}`,
                instanceName: `im-conversation-${index + 1}`,
                chatType: index % 2 === 0 ? "person" : "group",
                chatId: `chat-${index + 1}`,
                agentConfigId: "agent-1",
                sessionId: "rcs_…abcd",
                lastEventAt: "2026-02-01T00:00:00.000Z",
                lastReplyAt: null,
              })),
            },
          ],
        },
      ],
    },
  ];
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
  return Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.includes(label));
}

describe("管理台消息通道页", () => {
  let host: HTMLDivElement;
  let root: Root;
  let handler: (url: string) => Response | Promise<Response>;
  let requestedPaths: string[];
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    requestedPaths = [];
    handler = () => snapshot(organizationWithInstances(1));
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      requestedPaths.push(url);
      return handler(url);
    }) as unknown as typeof fetch;
    originalConsoleError = console.error;
    console.error = () => {};
    window.sessionStorage.setItem(ADMIN_KEY_STORAGE_KEY, "test-system-key");
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    window.document.body.replaceChildren();
    window.sessionStorage.clear();
    console.error = originalConsoleError;
    globalThis.fetch = originalFetch;
  });

  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  async function renderPage(): Promise<void> {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <AdminChannelsPage />
        </I18nextProvider>,
      );
    });
    await flush();
  }

  // 业务意图：master key 已在 sessionStorage 时直接进面板——拓扑四层（组织/用户/通道/实例）都要真的
  // 渲染成嵌套层级，实例名与 chatId 必须可见，否则排障者无法把会话映射回具体的 IM 聊天。
  test("带 key 时渲染拓扑层级与实例名", async () => {
    await renderPage();

    expect(requestedPaths.every((url) => url.includes("/api/system/channels"))).toBe(true);
    expect(host.textContent).toContain("研发部");
    expect(host.textContent).toContain("张三");
    expect(host.textContent).toContain("飞书机器人");
    expect(host.textContent).toContain("v4.11.2");

    const tree = host.querySelector("[data-testid='channel-topology-tree']");
    expect(tree).not.toBeNull();
    // 组织 → 用户 → 通道 三层 <details>，实例行挂在最内层。
    expect(tree?.querySelectorAll("details").length).toBe(3);
    const instanceRow = tree?.querySelector("[data-testid='channel-instance-row']");
    expect(instanceRow?.textContent).toContain("im-conversation-1");
    expect(instanceRow?.textContent).toContain("chat-1");

    const table = host.querySelector("[data-testid='channel-instance-table']");
    expect(table?.textContent).toContain("im-conversation-1");

    // 业务意图：脱敏会话列排在 Agent 与实例名之间，值直接取后端已脱敏的 sessionId（前端不重新拼装）。
    const headers = Array.from(table?.querySelectorAll("thead th") ?? []).map((cell) => cell.textContent ?? "");
    expect(headers).toContain(TEXT.admin.table.session);
    const sessionColumn = headers.indexOf(TEXT.admin.table.session);
    expect(sessionColumn).toBe(headers.indexOf(TEXT.admin.table.agent) + 1);
    expect(sessionColumn).toBe(headers.indexOf(TEXT.admin.table.instance) - 1);
    const firstRowCells = Array.from(table?.querySelectorAll("tbody tr")[0]?.querySelectorAll("td") ?? []);
    expect(firstRowCells[sessionColumn]?.textContent).toBe("rcs_…abcd");
  });

  // 业务意图：没有任何组织的通道时给空态，而不是一张空表——空表看起来像加载失败。
  test("没有通道时渲染空态", async () => {
    handler = () => snapshot([]);

    await renderPage();

    expect(host.textContent).toContain(TEXT.admin.emptyTitle);
    expect(host.querySelector("[data-testid='channel-topology-tree']")).toBeNull();
  });

  // 业务意图：失败态必须可重试，且重试真的重新发请求；重试成功后错误块消失。
  test("加载失败渲染错误态，重试后展示拓扑", async () => {
    let calls = 0;
    handler = () => {
      calls += 1;
      return calls === 1
        ? jsonResponse({ error: { code: "INTERNAL_ERROR", message: "通道快照读取失败" } }, 500)
        : snapshot(organizationWithInstances(1));
    };

    await renderPage();

    const alert = host.querySelector("[role='alert']");
    expect(alert).not.toBeNull();
    expect(alert?.textContent).toContain(TEXT.common.retry);
    const before = requestedPaths.length;

    const retry = findButton(host, TEXT.common.retry);
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.click();
    });
    await flush();

    expect(requestedPaths.length).toBeGreaterThan(before);
    expect(host.querySelector("[role='alert']")).toBeNull();
    expect(host.textContent).toContain("飞书机器人");
  });

  // 业务意图：master key 失效（401）时必须清掉 sessionStorage 并回到密钥门，而不是停在错误态反复重试。
  test("401 清 key 回门", async () => {
    handler = () => jsonResponse({ error: { code: "UNAUTHORIZED", message: "系统 API key 无效" } }, 401);

    await renderPage();

    expect(host.textContent).toContain(TEXT.admin.loginTitle);
    expect(window.sessionStorage.getItem(ADMIN_KEY_STORAGE_KEY)).toBeNull();
  });

  // 业务意图：会话表按每页 10 条分页，且翻页不再发请求（数据来自同一次快照）。
  test("会话表每页 10 条，翻页不重新请求", async () => {
    handler = () => snapshot(organizationWithInstances(12));

    await renderPage();

    const table = host.querySelector("[data-testid='channel-instance-table']");
    expect(table?.querySelectorAll("tbody tr").length).toBe(10);
    expect(table?.textContent).toContain(TEXT.admin.page.replace("{{page}}", "1").replace("{{total}}", "2"));

    const callsBefore = requestedPaths.length;
    await act(async () => {
      // 翻页按钮只有图标，按 aria-label 定位。
      const next = host.querySelector(`[aria-label='${TEXT.admin.next}']`) as HTMLButtonElement | null;
      next?.click();
    });
    await flush();

    expect(requestedPaths.length).toBe(callsBefore);
    expect(table?.querySelectorAll("tbody tr").length).toBe(2);
    expect(table?.textContent).toContain("im-conversation-12");
  });
});
