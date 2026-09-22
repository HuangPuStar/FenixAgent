// web/__tests__/use-admin-key-gate.test.tsx
// useAdminKeyGate 的行为契约。
//
// 为什么必须钉住：这道门的状态机此前在 5 个管理页各抄一遍（sandbox 1 / observer 3 /
// model-management 1），收敛后 5 处共用同一份实现——一旦 `unlock` 忘记写 key、`fail` 忘记清 key，
// 表现是「解锁后请求全部 401」或「退出后 key 仍在 sessionStorage」，五个页面同时中招且都只在运行时暴露。
//
// 覆盖：初始解锁态的取值来源、unlock 的写入与 trim、空值不放行、fail 的清 key + 提示回门、
// 提示取最新文案（语言切换后 fail 仍是新文案）、两个回调的引用稳定性（会被挂到 useRequest 的 onError 上）。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { type AdminKeyGateController, useAdminKeyGate } from "../hooks/use-admin-key-gate";
import { getAdminKey, setAdminKey } from "../lib/admin-key";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const globalScope = globalThis as Record<string, unknown>;
globalScope.window = win;
globalScope.document = win.document;
globalScope.navigator = win.navigator;

const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

/** 最小 sessionStorage 替身：测试进程没有浏览器全局，用完在 afterEach 还原，避免跨文件泄漏。 */
function stubSessionStorage(): Map<string, string> {
  const store = new Map<string, string>();
  globalScope.sessionStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
  };
  return store;
}

afterEach(() => {
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

/** 挂一个探针组件把 controller 取出来；`rerender` 用于模拟语言切换（提示文案变化）。 */
function renderGate(authErrorMessage = "master key 无效或已失效") {
  const latest: { controller: AdminKeyGateController | null } = { controller: null };
  function Probe({ message }: { message: string }) {
    latest.controller = useAdminKeyGate(message);
    return null;
  }
  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);
  const render = (message: string) =>
    act(() => {
      root.render(createElement(Probe, { message }));
    });
  render(authErrorMessage);
  return {
    latest,
    render,
    unmount: () => act(() => root.unmount()),
  };
}

describe("useAdminKeyGate", () => {
  test("初始解锁态取自 sessionStorage：无 key 停在门、有 key 直接进面板", () => {
    stubSessionStorage();
    const locked = renderGate();
    expect(locked.latest.controller?.unlocked).toBe(false);
    expect(locked.latest.controller?.error).toBeNull();
    locked.unmount();

    stubSessionStorage();
    setAdminKey("existing-key");
    const unlocked = renderGate();
    expect(unlocked.latest.controller?.unlocked).toBe(true);
    unlocked.unmount();
  });

  test("unlock 写入 key（trim 后）并解锁，同时清掉上一次的错误提示", () => {
    stubSessionStorage();
    const { latest, unmount } = renderGate();
    expect(latest.controller?.unlocked).toBe(false);
    act(() => latest.controller?.unlock("  raw-key  "));
    expect(getAdminKey()).toBe("raw-key");
    expect(latest.controller?.unlocked).toBe(true);
    expect(latest.controller?.error).toBeNull();

    act(() => latest.controller?.fail());
    expect(latest.controller?.error).toBe("master key 无效或已失效");
    act(() => latest.controller?.unlock("second-key"));
    expect(latest.controller?.error).toBeNull();
    unmount();
  });

  test("空白 key 不解锁也不写入（门组件之外的第二道闸）", () => {
    stubSessionStorage();
    const { latest, unmount } = renderGate();
    act(() => latest.controller?.unlock("   "));
    expect(getAdminKey()).toBeNull();
    expect(latest.controller?.unlocked).toBe(false);
    unmount();
  });

  test("fail 清 key、带提示回门（401 与退出的唯一路径）", () => {
    const store = stubSessionStorage();
    setAdminKey("existing-key");
    const { latest, unmount } = renderGate();
    expect(latest.controller?.unlocked).toBe(true);
    act(() => latest.controller?.fail());
    expect(store.size).toBe(0);
    expect(getAdminKey()).toBeNull();
    expect(latest.controller?.unlocked).toBe(false);
    expect(latest.controller?.error).toBe("master key 无效或已失效");
    unmount();
  });

  test("提示文案取最新参数：语言切换后 fail 用新文案", () => {
    stubSessionStorage();
    setAdminKey("existing-key");
    const { latest, render, unmount } = renderGate("旧文案");
    render("Invalid or expired master key");
    act(() => latest.controller?.fail());
    expect(latest.controller?.error).toBe("Invalid or expired master key");
    unmount();
  });

  test("unlock / fail 引用稳定：重渲染不重建，可直接挂到请求回调上", () => {
    stubSessionStorage();
    setAdminKey("existing-key");
    const { latest, render, unmount } = renderGate("旧文案");
    const first = latest.controller;
    render("新文案");
    expect(latest.controller?.unlock).toBe(first?.unlock);
    expect(latest.controller?.fail).toBe(first?.fail);
    unmount();
  });
});
