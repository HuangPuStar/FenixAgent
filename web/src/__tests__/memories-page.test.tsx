import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = new Window();
win.SyntaxError = SyntaxError;
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;

const originalFetch = globalThis.fetch;
let statusEnabled = true;
let statusFailuresRemaining = 0;
let graphRequests: Array<{ type: string; query: string }> = [];

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeAll(() => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(typeof input === "string" ? input : input.toString(), "http://localhost");
    if (url.pathname.endsWith("/status")) {
      if (statusFailuresRemaining > 0) {
        statusFailuresRemaining--;
        return new Response(JSON.stringify({ success: false, error: "Service unavailable" }), { status: 503 });
      }
      return jsonResponse({ enabled: statusEnabled });
    }
    if (url.pathname.endsWith("/graph")) {
      graphRequests.push({ type: url.searchParams.get("type") ?? "", query: url.searchParams.get("q") ?? "" });
      return jsonResponse({ table_rows: [], nodes: [], edges: [], total_units: 0 });
    }
    if (url.pathname.endsWith("/bank-stats")) {
      return jsonResponse({ pending_consolidation: 0, last_consolidated_at: null });
    }
    if (url.pathname.endsWith("/mental-models")) return jsonResponse({ items: [], total: 0 });
    if (url.pathname.endsWith("/entities/graph")) return jsonResponse({ nodes: [], edges: [] });
    if (url.pathname.endsWith("/entities")) return jsonResponse({ items: [], total: 0 });
    throw new Error(`Unexpected test request: ${url.pathname}`);
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  statusEnabled = true;
  statusFailuresRemaining = 0;
  graphRequests = [];
  win.document.body.innerHTML = "";
});

async function renderPage() {
  const { MemoriesPage } = await import("../pages/hindsight/MemoriesPage");
  const domContainer = win.document.createElement("div");
  win.document.body.appendChild(domContainer);
  const container = domContainer as unknown as HTMLElement;
  const root: Root = createRoot(container);
  await act(async () => {
    root.render(createElement(MemoriesPage));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return { container, root };
}

describe("MemoriesPage", () => {
  // Hindsight 未启用时不得渲染记忆工作台。
  test("显示未配置状态", async () => {
    statusEnabled = false;
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("status.notConfigured");
    expect(container.querySelector("nav")).toBeNull();
    act(() => root.unmount());
  });

  // 状态请求失败必须显示独立错误态，并允许用户重试恢复。
  test("状态加载失败后可重试", async () => {
    statusFailuresRemaining = 1;
    const { container, root } = await renderPage();

    expect(container.textContent).toContain("status.loadFailed");
    expect(container.textContent).not.toContain("status.notConfigured");
    const retryButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("status.retry"),
    );

    await act(async () => {
      retryButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(container.textContent).not.toContain("status.loadFailed");
    expect(container.querySelector("nav")).not.toBeNull();
    act(() => root.unmount());
  });

  // 默认视角必须使用真实世界事实查询，并提供可访问的选中语义。
  test("默认加载世界事实并标记左侧视角", async () => {
    const { container, root } = await renderPage();

    expect(graphRequests).toEqual([{ type: "world", query: "" }]);
    const worldButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("tabs.worldFacts"),
    );
    expect(worldButton?.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });

  // 切换经验视角时必须复用 DataView，并按 experience 类型重新请求。
  test("切换经验视角", async () => {
    const { container, root } = await renderPage();
    const experienceButton = Array.from(container.querySelectorAll("button")).find((button) =>
      button.textContent?.includes("tabs.experience"),
    );

    await act(async () => {
      experienceButton?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(graphRequests.map(({ type }) => type)).toEqual(["world", "experience"]);
    expect(experienceButton?.getAttribute("aria-pressed")).toBe("true");
    act(() => root.unmount());
  });

  // 左栏搜索提交后必须把查询参数传给当前真实 Graph API。
  test("从左栏搜索当前记忆视角", async () => {
    const { container, root } = await renderPage();
    const input = container.querySelector("input") as HTMLInputElement;
    const form = input.closest("form") as HTMLFormElement;

    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      valueSetter?.call(input, "部署");
      input.dispatchEvent(
        new win.InputEvent("input", { bubbles: true, data: "部署", inputType: "insertText" }) as unknown as Event,
      );
    });
    await act(async () => {
      form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(graphRequests.at(-1)).toEqual({ type: "world", query: "部署" });
    act(() => root.unmount());
  });
});
