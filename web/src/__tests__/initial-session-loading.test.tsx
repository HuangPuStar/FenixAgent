import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useInitialSessionLoading } from "../hooks/use-initial-session-loading";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = new Window();
const globals = globalThis as Record<string, unknown>;
if (!globals.window) globals.window = win;
if (!globals.document) globals.document = win.document;
if (!globals.navigator) globals.navigator = win.navigator;

function createLoadingHarness() {
  const latest = { value: false };

  function Probe({ isPending }: { isPending: boolean }) {
    latest.value = useInitialSessionLoading(isPending);
    return null;
  }

  const container = win.document.createElement("div");
  const root: Root = createRoot(container as unknown as HTMLElement);

  return {
    latest,
    render(isPending: boolean) {
      act(() => root.render(createElement(Probe, { isPending })));
    },
    unmount() {
      act(() => root.unmount());
    },
  };
}

describe("useInitialSessionLoading", () => {
  // 首次 session 请求应阻塞页面，完成后任何后台刷新都不能重新进入全屏 loading
  test("仅首次 pending 返回 loading", () => {
    const harness = createLoadingHarness();

    harness.render(true);
    expect(harness.latest.value).toBe(true);

    harness.render(false);
    expect(harness.latest.value).toBe(false);

    harness.render(true);
    expect(harness.latest.value).toBe(false);

    harness.render(false);
    expect(harness.latest.value).toBe(false);
    harness.unmount();
  });

  // 初始已有 session 结果时不应闪现全屏 loading
  test("初始非 pending 时直接保持页面可见", () => {
    const harness = createLoadingHarness();

    harness.render(false);
    expect(harness.latest.value).toBe(false);

    harness.render(true);
    expect(harness.latest.value).toBe(false);
    harness.unmount();
  });

  // 登录页完成首次加载后，聚焦刷新不得卸载子树或清空未提交表单草稿
  test("后台 pending 周期保留子组件和本地草稿", () => {
    const latest = {
      draft: "",
      setDraft: null as ((value: string) => void) | null,
      mountCount: 0,
    };

    function DraftProbe() {
      const [draft, setDraft] = useState("");
      latest.draft = draft;
      latest.setDraft = setDraft;

      useEffect(() => {
        latest.mountCount += 1;
      }, []);

      return null;
    }

    function Boundary({ isPending }: { isPending: boolean }) {
      const showLoading = useInitialSessionLoading(isPending);
      return showLoading ? null : createElement(DraftProbe);
    }

    const container = win.document.createElement("div");
    const root = createRoot(container as unknown as HTMLElement);

    act(() => root.render(createElement(Boundary, { isPending: true })));
    expect(latest.mountCount).toBe(0);

    act(() => root.render(createElement(Boundary, { isPending: false })));
    expect(latest.mountCount).toBe(1);

    act(() => latest.setDraft?.("admin@fenix.com"));
    expect(latest.draft).toBe("admin@fenix.com");

    act(() => root.render(createElement(Boundary, { isPending: true })));
    expect(latest.mountCount).toBe(1);
    expect(latest.draft).toBe("admin@fenix.com");

    act(() => root.render(createElement(Boundary, { isPending: false })));
    expect(latest.mountCount).toBe(1);
    expect(latest.draft).toBe("admin@fenix.com");

    act(() => root.unmount());
  });
});
