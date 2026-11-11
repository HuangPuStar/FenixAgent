import { afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { AgentConcurrencyPage } from "../pages/admin/AgentConcurrencyPage";

const window = initializeHappyDomWindow(new Window());
Object.assign(globalThis, {
  window,
  document: window.document,
  navigator: window.navigator,
  HTMLElement: window.HTMLElement,
  sessionStorage: window.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const originalFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let globalOverride: number | null;
let userOverride: number | null;
let failLoad: boolean;
let unauthorized: boolean;
let failWrite: boolean;
let failRefreshAfterPatch: boolean;
const i18n = createInstance();
await i18n.init({
  lng: "en",
  initAsync: false,
  resources: {
    en: {
      agentConcurrency: {
        title: "Concurrency",
        save: "Save",
        reset: "Restore inheritance",
        retry: "Retry",
        empty: "No overrides",
        userId: "User ID",
        userLimit: "User limit",
        saveUser: "Save user",
        delete: "Delete",
        loadUser: "Load user",
        saved: "Saved",
        refreshFailed: "Refresh failed: {{message}}",
      },
    },
  },
});
function policy(override: number | null = globalOverride) {
  return {
    agentMaxConcurrency: { override: null, value: 20, source: "environment" },
    userAgentMaxConcurrency: { override, value: override ?? 10, source: override === null ? "environment" : "global" },
    scheduledAgentMaxConcurrency: { override: null, value: null, source: "environment" },
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
  const button = Array.from(container.querySelectorAll("button")).find((element) => element.textContent === text);
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
  });
  await settle();
}

/** happy-dom 的 React input polyfill 需聚焦后用原生 setter 和键盘事件提交输入。 */
function typeInput(id: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`#${id}`);
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
  failRefreshAfterPatch = false;
  window.sessionStorage.setItem("rcs_admin_master_key", "test-admin");
  globalThis.fetch = Object.assign(
    async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (unauthorized)
        return Response.json({ error: { code: "UNAUTHORIZED", message: "Invalid system API key" } }, { status: 401 });
      if (failWrite && init?.method === "PATCH")
        return Response.json({ error: { code: "FAILED", message: "Save failed" } }, { status: 500 });
      if (failLoad) return Response.json({ error: { code: "FAILED", message: "Load failed" } }, { status: 500 });
      if (path.endsWith("/users/u1")) {
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
                  policy: { ...policy(), userAgentMaxConcurrency: { override: 2, value: 2, source: "user" } },
                },
              ],
        );
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as { userAgentMaxConcurrency?: number | null };
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

// 清除平台覆盖后应展示继承值和来源，不能只清空输入框。
test("restores inheritance and displays effective policy", async () => {
  expect(container.textContent).toContain("User One");
  await click("Restore inheritance");
  expect(globalOverride).toBeNull();
  expect(container.textContent).toContain("10");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
});

// 删除指定用户覆盖后重新加载列表，空态应可见。
test("deletes user override and shows empty state", async () => {
  await click("Delete");
  expect(userOverride).toBeNull();
  expect(container.textContent).toContain("No overrides");
});

// 请求失败展示错误及重试入口，重试必须恢复数据。
test("recovers from a load error", async () => {
  failLoad = true;
  await click("Retry");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Load failed");
  failLoad = false;
  await click("Retry");
  expect(container.textContent).toContain("User One");
});

// 保存必须通过真实 request/unwrap 提交表单覆盖，并给出提交成功反馈。
test("saves the visible global overrides", async () => {
  await click("Save");
  expect(globalOverride).toBe(4);
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
});

// 写失败不能显示成功反馈，已加载数据和可重试的保存入口仍保留。
test("preserves the form after a failed save", async () => {
  failWrite = true;
  await click("Save");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Save failed");
  expect(container.textContent).not.toContain("Saved");
  expect(globalOverride).toBe(4);
  failWrite = false;
  await click("Save");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
});

// 系统密钥失效后必须清除凭据并返回解锁表单。
test("returns to the key gate after unauthorized response", async () => {
  unauthorized = true;
  await click("Retry");
  expect(window.sessionStorage.getItem("rcs_admin_master_key")).toBeNull();
  expect(container.querySelector('input[type="password"]')).not.toBeNull();
  expect(container.textContent).not.toContain("User One");
});

// 恢复继承已提交后，即使刷新失败也必须保留提交结果，后续保存不得复活旧覆盖。
test("keeps committed inheritance when the following refresh fails", async () => {
  typeInput("concurrency-user-id", "draft-user");
  typeInput("concurrency-user-limit", "7");
  failRefreshAfterPatch = true;
  await click("Restore inheritance");
  expect(globalOverride).toBeNull();
  const limitInput = container.querySelector<HTMLInputElement>("#concurrency-userAgentMaxConcurrency");
  expect(limitInput?.value).toBe("");
  expect(container.querySelector("#effective-userAgentMaxConcurrency")?.textContent).toContain("10");
  expect(container.querySelector("#effective-userAgentMaxConcurrency")?.textContent).toContain("environment");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("Saved");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Load failed");
  expect(container.querySelector<HTMLInputElement>("#concurrency-user-id")?.value).toBe("draft-user");
  expect(container.querySelector<HTMLInputElement>("#concurrency-user-limit")?.value).toBe("7");
  failRefreshAfterPatch = false;
  failLoad = false;
  await click("Save");
  expect(globalOverride).toBeNull();
});
