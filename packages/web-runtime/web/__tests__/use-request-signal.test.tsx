// web/__tests__/use-request-signal.test.tsx
// `useRequestSignal` / `isAbortError` 的行为契约（2026-10-10 从 trace 面板下沉进本包）。
//
// 为什么必须钉住：这套件的全部价值在「后发请求作废先发」这一条时序语义——信号没被续接、卸载没被中止，
// 界面不会报错，只会偶尔显示上一次选中的内容（trace 面板的 run 列表是最早的现场）。
// `isAbortError` 则决定取消该不该进错误态：判据过窄会把用户主动切换显示成加载失败。
//
// 引导方式与 `use-admin-key-gate.test.tsx` 一致：happy-dom + createRoot，用完卸载。

import { afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { isAbortError, useRequestSignal } from "../hooks/use-request-signal";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const globalScope = globalThis as Record<string, unknown>;
globalScope.window = win;
globalScope.document = win.document;
globalScope.navigator = win.navigator;

describe("useRequestSignal", () => {
  let host: HTMLElement;
  let root: Root;
  let nextSignal: (() => AbortSignal) | null;

  /** 探针组件：把 hook 返回的取信号函数暴露给用例（hook 只能在组件里调用）。 */
  function Probe() {
    nextSignal = useRequestSignal();
    return null;
  }

  afterEach(() => {
    act(() => root.unmount());
    nextSignal = null;
  });

  function mountProbe(): void {
    host = win.document.createElement("div") as unknown as HTMLElement;
    win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
    root = createRoot(host);
    act(() => root.render(createElement(Probe)));
  }

  // 续接语义：取新信号必须作废上一个，否则慢的旧请求会覆盖新请求的结果。
  test("取新信号会中止上一个，返回的信号未中止", () => {
    mountProbe();
    const first = nextSignal?.();
    const second = nextSignal?.();
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first?.aborted).toBe(true);
    expect(second?.aborted).toBe(false);
    expect(first).not.toBe(second);
  });

  // 卸载语义：组件没了还挂着的请求必须中止，否则回调会往已卸载的组件里写状态。
  test("卸载时中止最后一个信号", () => {
    mountProbe();
    const signal = nextSignal?.();
    expect(signal?.aborted).toBe(false);
    act(() => root.unmount());
    expect(signal?.aborted).toBe(true);
  });
});

describe("isAbortError", () => {
  // 取消由 fetch 抛出的 DOMException 表示；这是最常见的一支。
  test("DOMException 形式的取消", () => {
    expect(isAbortError(new DOMException("The operation was aborted.", "AbortError"))).toBe(true);
  });

  // 部分运行时 / polyfill 抛的是普通 Error，只有 name 标记相同。
  test("Error 形式的取消", () => {
    const error = new Error("aborted");
    error.name = "AbortError";
    expect(isAbortError(error)).toBe(true);
  });

  // 其它失败一律不算取消：调用方据此把真实故障展示出来。
  test("非取消错误与非法输入都不算取消", () => {
    expect(isAbortError(new Error("boom"))).toBe(false);
    expect(isAbortError(new DOMException("expired", "TimeoutError"))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
  });
});
