import { afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import translations from "../i18n/locales/en/agentConcurrency.json";

const window = initializeHappyDomWindow(new Window());
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  sessionStorage: window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
for (const key of [
  "Element",
  "Node",
  "MutationObserver",
  "CustomEvent",
  "Event",
  "DocumentFragment",
  "NodeFilter",
  "HTMLInputElement",
  "HTMLButtonElement",
  "ResizeObserver",
]) {
  (globalThis as Record<string, unknown>)[key] = (window as unknown as Record<string, unknown>)[key];
}
globalThis.getComputedStyle = window.getComputedStyle.bind(window) as typeof getComputedStyle;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
globalThis.cancelAnimationFrame = window.cancelAnimationFrame.bind(window);
const { AgentConcurrencyPage } = await import("../pages/admin/AgentConcurrencyPage");
const originalFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let globalOverride: number | null;
let userOverride: number | null;
let failLoad: boolean;
let unauthorized: boolean;
let failWrite: boolean;
let lastPatch: unknown;
let failRefreshAfterPatch: boolean;
const i18n = createInstance();
await i18n.init({
  lng: "en",
  initAsync: false,
  resources: { en: { agentConcurrency: translations } },
});
function policy(override: number | null = globalOverride) {
  return {
    agentMaxConcurrency: { override: null, value: 20, defaultValue: 20, source: "environment" },
    userAgentMaxConcurrency: {
      override,
      value: override ?? 10,
      defaultValue: 10,
      source: override === null ? "environment" : "global",
    },
    scheduledAgentMaxConcurrency: { override: null, value: null, defaultValue: null, source: "environment" },
  };
}
function response(data: unknown) {
  return Response.json({ success: true, data });
}
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}
async function click(text: string) {
  const button = Array.from(document.body.querySelectorAll("button")).find(
    (element) => element.textContent === text || element.getAttribute("aria-label") === text,
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  await settle();
}

/** happy-dom 的 React input polyfill 需聚焦后用原生 setter 和键盘事件提交输入。 */
function typeInput(id: string, value: string) {
  const input = document.body.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`Missing input: ${id}`);
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, "value")?.set;
  if (!setter) throw new Error("Missing input value setter");
  act(() => {
    input.focus();
    setter.call(input, value);
    input.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: value.slice(-1), bubbles: true }) as unknown as Event,
    );
  });
}
beforeEach(async () => {
  globalOverride = 4;
  userOverride = 2;
  failLoad = false;
  unauthorized = false;
  failWrite = false;
  lastPatch = undefined;
  failRefreshAfterPatch = false;
  window.sessionStorage.setItem("rcs_admin_master_key", "test-admin");
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (unauthorized)
        return Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid system API key" } }, { status: 401 });
      if (failWrite && (init?.method === "PATCH" || init?.method === "PUT"))
        return Response.json({ error: { code: "FAILED", message: "Save failed" } }, { status: 500 });
      if (failLoad) return Response.json({ error: { code: "FAILED", message: "Load failed" } }, { status: 500 });
      if (path.includes("/user-candidates"))
        return response([{ id: "u1", name: "User One", email: "user@example.com" }]);
      if (path.endsWith("/users/u1")) {
        if (init?.method === "PUT") userOverride = JSON.parse(String(init.body)).userAgentMaxConcurrency;
        if (init?.method === "DELETE") userOverride = null;
        return response({
          userId: "u1",
          name: "User One",
          policy: {
            ...policy(),
            userAgentMaxConcurrency: {
              override: userOverride,
              value: userOverride ?? globalOverride ?? 10,
              source: userOverride === null ? "global" : "user",
            },
          },
        });
      }
      if (path.endsWith("/users"))
        return response(
          userOverride === null
            ? []
            : [
                {
                  userId: "u1",
                  name: "User One",
                  policy: {
                    ...policy(),
                    userAgentMaxConcurrency: {
                      override: userOverride,
                      value: 2,
                      defaultValue: globalOverride ?? 10,
                      source: "user",
                    },
                  },
                },
              ],
        );
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { userAgentMaxConcurrency?: number | null };
        lastPatch = body;
        globalOverride = body.userAgentMaxConcurrency ?? null;
        if (failRefreshAfterPatch) failLoad = true;
      }
      return response(policy());
    },
    { preconnect: originalFetch.preconnect },
  ) as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <AgentConcurrencyPage />
      </I18nextProvider>,
    );
  });
  await settle();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
});

// 恢复默认必须确认，并展示清除覆盖后的生效值。
test("restores defaults after confirmation", async () => {
  await click("Restore default");
  expect(globalOverride).toBe(4);
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("10");
  await click("Confirm restore");
  expect(globalOverride).toBeNull();
  expect(container.textContent).toContain("Saved");
});
// 移除用户配置后该用户重新跟随平台默认，列表展示空状态。
test("restores the user to the platform default", async () => {
  await click("Restore platform default for User One");
  await click("Confirm restore");
  expect(userOverride).toBeNull();
  expect(container.textContent).toContain(translations.empty);
});
// 刷新失败保留原数据，错误区域的重试可以恢复。
test("recovers from a refresh error", async () => {
  failLoad = true;
  await click("Refresh");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Load failed");
  failLoad = false;
  await click("Retry");
  expect(container.textContent).toContain("User One");
});
// 只编辑选中的限制，避免其他默认设置被意外提交。
test("edits only the selected limit", async () => {
  expect(container.querySelector('input[type="number"]') === null).toBe(true);
  await click("Edit Default concurrency per user");
  typeInput("concurrency-limit", "7");
  await click("Save");
  expect(globalOverride).toBe(7);
  expect(lastPatch).toEqual({ userAgentMaxConcurrency: 7 });
  expect(container.textContent).toContain("Saved");
});
// 保存失败时保留草稿并允许重试。
test("preserves the draft after a failed save", async () => {
  await click("Edit Default concurrency per user");
  typeInput("concurrency-limit", "9");
  failWrite = true;
  await click("Save");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
  expect(container.querySelector<HTMLInputElement>("#concurrency-limit")?.value).toBe("9");
  failWrite = false;
  await click("Save");
  expect(globalOverride).toBe(9);
});
// 凭据过期后清除系统密钥并返回解锁界面。
test("returns to the gate after unauthorized response", async () => {
  unauthorized = true;
  await click("Refresh");
  expect(window.sessionStorage.getItem("rcs_admin_master_key")).toBeNull();
  expect(container.querySelector('input[type="password"]') !== null).toBe(true);
});
// 写入已提交后刷新失败不能复活旧覆盖。
test("keeps committed defaults when refresh fails", async () => {
  failRefreshAfterPatch = true;
  await click("Restore default");
  await click("Confirm restore");
  expect(globalOverride).toBeNull();
  expect(container.querySelector("#effective-userAgentMaxConcurrency")?.textContent).toContain("10");
  expect(container.textContent).toContain("Saved");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Load failed");
});
// 用户弹窗通过候选选择稳定 ID，再提交指定用户额度。
test("searches and selects a user before saving", async () => {
  await click("Add user");
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 350));
  });
  const option = document.body.querySelector<HTMLElement>("[cmdk-item]");
  expect(option !== null).toBe(true);
  await act(async () => {
    option?.click();
  });
  typeInput("concurrency-user-limit", "6");
  await click("Save configuration");
  expect(userOverride).toBe(6);
  expect(document.body.querySelector('[role="dialog"]') === null).toBe(true);
});

// 用户保存失败必须在弹窗内显示错误并保留选择和额度。
test("keeps user configuration open on save failure", async () => {
  await click("Edit concurrency for User One");
  typeInput("concurrency-user-limit", "6");
  failWrite = true;
  await click("Save configuration");
  expect(document.body.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain("Save failed");
  expect(document.body.querySelector<HTMLInputElement>("#concurrency-user-limit")?.value).toBe("6");
  failWrite = false;
  await click("Save configuration");
  expect(userOverride).toBe(6);
});

// 平台默认已提交而刷新失败时，用户恢复预览必须使用新默认。
test("previews the committed platform default after refresh failure", async () => {
  await click("Edit Default concurrency per user");
  typeInput("concurrency-limit", "8");
  failRefreshAfterPatch = true;
  await click("Save");
  await click("Restore platform default for User One");
  expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain("8");
  expect(document.body.querySelector('[role="dialog"]')?.textContent).not.toContain("4");
});
