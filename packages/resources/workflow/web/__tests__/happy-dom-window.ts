import type { Window } from "happy-dom";

/**
 * 本包测试专用的 happy-dom Window 初始化。
 *
 * happy-dom 把 `Error` / `SyntaxError` 等 JS 全局定义成 Window 实例上**值为 `undefined` 的可写属性**
 * （`BrowserWindow` 的类字段），由使用方自行填充；而它内部的 `query-selector/SelectorParser` 会通过
 * `new this.window.SyntaxError(...)` 构造错误对象，于是任何 `querySelectorAll` 都抛
 * `TypeError: undefined is not a constructor`。这里把宿主侧的标准错误构造器补到测试自建的 Window 上；
 * `location.origin === "null"` 的修正供断言 URL 的用例使用。
 *
 * **为什么在本包内复制一份，而不是复用 `apps/web/src/__tests__/happy-dom-window.ts`**：
 * 包内测试用相对路径读 `apps/web/src/**` 会让本包离开宿主后无法独立测试——静态条件 3 明确禁止
 * `packages/**` 出现 `../../../apps/web`，`.dependency-cruiser.cjs` 也判为越界。先例是
 * `packages/ui-components/web/__tests__/happy-dom-window.ts` 与 `packages/resources/memory/web/__tests__/happy-dom-window.ts`（同因复制）。
 *
 * **后续收敛（已登记，非本包范围）**：该 workaround 在本仓库已有十余处真实用例，按「第二个真实用例出现
 * 即抽象」的约定应收敛为一个跨包测试工具入口（如 `@fenix/web-runtime` 的 `/testing` 子路径）。收敛属
 * 任务 1.3 W4 跨包收敛范围；在那之前本文件与宿主 `apps/web/src/__tests__/happy-dom-window.ts`
 * 及 ui-components / memory 的副本必须同步修改（改动条件：happy-dom 升级补齐这些构造器后，本文件整体删除）。
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

/**
 * 补齐 happy-dom Window 缺失的标准错误构造器，并修正空 origin 的 location。
 *
 * 返回同一个 `window` 实例，便于调用方写成 `const win = initializeHappyDomWindow(new Window())`。
 */
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
