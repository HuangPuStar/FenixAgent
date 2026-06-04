import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// 设置最小 DOM 环境（React 19 需要 window + document）
const win = new Window();
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = win;
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;

// 简易 renderHook（项目无 @testing-library/react，用 react-dom/client 手写）
function renderHook<T>(hookFn: () => T): {
  result: { current: T };
  rerender: () => void;
  unmount: () => void;
} {
  const result: { current: T } = {} as never;
  let root: Root | null = null;
  const container = win.document.createElement("div");

  function Comp() {
    result.current = hookFn();
    return null as unknown as ReactNode;
  }

  root = createRoot(container as unknown as HTMLElement);
  act(() => {
    root!.render(createElement(Comp));
  });

  return {
    result,
    rerender: () =>
      act(() => {
        root!.render(createElement(Comp));
      }),
    unmount: () =>
      act(() => {
        root!.unmount();
        root = null;
      }),
  };
}

const { useBackoffRetry } = await import("../hooks/useBackoffRetry");

// hook 返回 retry, cancel, attempt 三个属性
test("hook returns retry, cancel, attempt", () => {
  const { result, unmount } = renderHook(() => useBackoffRetry());
  expect(typeof result.current.retry).toBe("function");
  expect(typeof result.current.cancel).toBe("function");
  expect(result.current.attempt).toBe(0);
  unmount();
});

// retry 成功后不重试，直接返回结果
test("retry succeeds without retrying", async () => {
  const { result, unmount } = renderHook(() => useBackoffRetry());

  const value = await act(() =>
    result.current.retry(() => Promise.resolve("ok"), {
      maxAttempts: 3,
      baseDelayMs: 1,
      maxDelayMs: 10,
    }),
  );
  expect(value).toBe("ok");
  unmount();
});

// cancel 后 retry 抛出 AbortError
test("cancel causes retry to throw AbortError", async () => {
  const { result, unmount } = renderHook(() => useBackoffRetry({ baseDelayMs: 1, maxDelayMs: 10 }));

  let rejected = false;
  const promise = act(() =>
    result.current
      .retry(
        async () => {
          // 给 cancel 一点时间生效
          await new Promise((r) => setTimeout(r, 5));
          throw new Error("fail");
        },
        { maxAttempts: 5 },
      )
      .catch((e: unknown) => {
        expect((e as DOMException).name).toBe("AbortError");
        rejected = true;
      }),
  );

  // 在 fn 还在执行时 cancel
  result.current.cancel();

  await promise;
  expect(rejected).toBe(true);
  unmount();
});
