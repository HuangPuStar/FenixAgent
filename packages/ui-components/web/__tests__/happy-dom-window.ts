import type { Window } from "happy-dom";

/**
 * 本包测试专用的 happy-dom Window 初始化。
 *
 * happy-dom 把 `Error` / `SyntaxError` 等 JS 全局定义成 Window 实例上**值为 `undefined` 的可写属性**
 * （`BrowserWindow` 的类字段），由使用方自行填充。而它内部的 `query-selector/SelectorParser`
 * 会通过 `new this.window.SyntaxError(...)` 构造错误对象，因此任何 `querySelectorAll` 都会抛
 * `TypeError: undefined is not a constructor`，测试在渲染期集体失败（2026-09-19 实测 24 例）。
 * 这里把宿主侧的标准错误构造器补到测试自建的 Window 上；`location.origin === "null"` 的修正
 * 供断言 URL 的用例使用。
 *
 * **为什么在本包内复制一份，而不是复用 `apps/web/src/__tests__/happy-dom-window.ts`**：
 * 包内测试以相对路径读取 `apps/web/src/**` 会被 `.dependency-cruiser.cjs` 判为越界
 * （`web/__tests__/` 命中 `web-package-not-to-app`，`demo/` 命中 `apps-boundary`），
 * 必须逐条登记进 `scripts/architecture/exceptions.json`；而本包的设计前提正是**不依赖宿主**
 * —— README「为什么必须是顶层包」一节记明 `@fenix/*` 与 `@/` 的类型全部在包内自带。
 * 台账中既有 10 处同类条目的 `removeWhen` 也写明去向是「改经 WebShell 公开面**或包内自持**」，
 * 故此处选包内自持，不新增同向债务。
 *
 * **后续收敛**：该 workaround 在本仓库已有 15 个真实用例（本包 5 个测试文件 + 既有 10 个），
 * 按「第二个真实用例出现即抽象」的约定，应收敛为一个跨包可用的测试工具入口 —— 仓库已有
 * `@fenix/resource-machine/server/testing` 这样的 `/testing` 子路径先例 —— 并让既有调用方一并迁走。
 * 该收敛应与 §1.6 的 `web-package-not-to-app` 台账削减同批进行；**在那之前本文件与
 * `apps/web/src/__tests__/happy-dom-window.ts` 两份实现必须同步修改**。
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
