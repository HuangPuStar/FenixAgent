import { useCallback, useEffect, useRef } from "react";

/**
 * 取数用的取消信号（`useRequest` 的配套件）。
 *
 * `useRequest` 在 `refreshDeps` 变化时重跑，但**不会**中止上一次请求（并发语义随版本变化，规范要求调用方
 * 显式持有信号）。「后发请求覆盖先发结果」是典型场景：用户在列表里连点两条，慢的那次回来会覆盖快的，
 * 于是界面显示的是上一次选中的对象。因此每次发起前 abort 上一次，卸载时也 abort。
 *
 * 中止在调用方表现为 `AbortError`（见 {@link isAbortError}）：据此静默忽略，不当作失败态展示。
 * 用法：`const nextSignal = useRequestSignal()`，在 `useRequest` 的 service 里 `nextSignal()` 取本次信号。
 */
export function useRequestSignal(): () => AbortSignal {
  const current = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      current.current?.abort();
      current.current = null;
    },
    [],
  );

  return useCallback(() => {
    current.current?.abort();
    current.current = new AbortController();
    return current.current.signal;
  }, []);
}

/**
 * 判断一个错误是否为取消导致（用户换了选择 / 关闭面板），这类「失败」不该进错误态。
 *
 * 按 `name` 做结构判定而不是 `instanceof Error`：取消在各运行时抛出的对象不同——浏览器与 undici 抛
 * `DOMException`，它在部分环境里不是 `Error` 子类；也见过 polyfill 抛裸 `Error`。`name === "AbortError"`
 * 是 DOM 规范给定的稳定标记，跨来源（跨 realm / 跨实现）都成立。
 */
export function isAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  return (error as { name?: unknown }).name === "AbortError";
}
