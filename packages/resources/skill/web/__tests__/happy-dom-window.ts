import type { Window } from "happy-dom";

/**
 * 本包组件用例专用的 happy-dom Window 初始化。
 *
 * happy-dom 把 `Error` / `SyntaxError` 等 JS 全局定义成 Window 实例上**值为 `undefined` 的可写属性**，
 * 而它内部的 `query-selector/SelectorParser` 会通过 `new this.window.SyntaxError(...)` 构造错误对象，
 * 因此任何 `querySelectorAll` 都会抛 `TypeError: undefined is not a constructor`，用例在渲染期集体失败。
 * 这里把宿主侧的标准错误构造器补到测试自建的 Window 上；`location.origin === "null"` 的修正供
 * React `act` 环境下的 URL 解析使用。
 *
 * **为什么在本包内复制一份，而不是复用 `apps/web/src/__tests__/happy-dom-window.ts`**：
 * 包内测试以相对路径读取 `apps/web/src/**` 会让本包离开宿主后无法独立测试（计划 §1 静态条件 3
 * 明确禁止 `packages/**` 出现指向 `apps/web` 的三级相对路径），且 `.dependency-cruiser.cjs` 判为越界。
 * 先例是 `packages/ui-components/web/__tests__/happy-dom-window.ts` 与
 * `packages/resources/memory/web/__tests__/happy-dom-window.ts`（同因复制）。
 *
 * **后续收敛（已登记，非本包范围）**：该 workaround 在本仓库已有 15 个以上真实用例，按「第二个真实
 * 用例出现即抽象」的约定应收敛为跨包测试工具入口（如 `@fenix/web-runtime` 的 `/testing` 子路径）。
 * 收敛属任务 1.3 W4 跨包收敛范围：在那之前本文件与其它三份副本必须同步修改。
 */
const ERROR_CONSTRUCTORS = [
  "Error",
  "EvalError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
] as const;

/** 补齐 happy-dom Window 缺失的标准错误构造器，并修正空 origin 的 location。 */
export function initializeHappyDomWindow<T extends Window>(window: T): T {
  if (window.location.origin === "null") {
    window.location.href = "http://localhost/";
  }

  const record = window as unknown as Record<string, unknown>;
  for (const key of ERROR_CONSTRUCTORS) {
    record[key] = globalThis[key];
  }
  return window;
}
