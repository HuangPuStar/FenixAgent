// web/testing.ts
// 跨包测试工具入口（exports 键 `./testing`）。**不得从包根入口导出**：happy-dom 是 devDependency，
// 经 barrel 可达会让生产 bundle 的依赖图出现仅在开发期存在的模块。
//
// 本文件是「happy-dom Window 初始化」这一 workaround 的**唯一实现**（CE 阶段 2 §1.6 T3 收敛）。
// 收敛前全仓有 5 份逐字相同的副本（apps/web、本包、resources/{memory,skill,workflow} 各一份），
// 函数体一致、差异只在注释，因此合并是行为等价的改动。
//
// happy-dom 把 `Error` / `SyntaxError` 等 JS 全局定义成 Window 实例上**值为 `undefined` 的可写属性**
// （`BrowserWindow` 的类字段），由使用方自行填充。而它内部的 `query-selector/SelectorParser`
// 会通过 `new this.window.SyntaxError(...)` 构造错误对象，因此任何 `querySelectorAll` 都会抛
// `TypeError: undefined is not a constructor`，测试在渲染期集体失败（2026-09-19 实测 24 例）。
// 这里把宿主侧的标准错误构造器补到测试自建的 Window 上；`location.origin === "null"` 的修正
// 供断言 URL 的用例使用。
//
// **DOM 全局注入必须成对：`HTMLElement` 与 `customElements`**（本函数不注入全局，此条约束落在各
// 调用点）。`bun test` 在同一进程内依次求值全部测试文件，直接写 `globalThis.HTMLElement = win.HTMLElement`
// 的用例（本包 web/__tests__ 与 demo 各 3 处）会把该全局泄漏给后续文件；而 streamdown 的 diff 组件
// （`@pierre/diffs/dist/components/web-components.js`）在模块求值期判定
// `typeof HTMLElement !== "undefined" && customElements.get(TAG) == null` —— 只注入 `HTMLElement`
// 会让「有 DOM」这个前提成立而 `customElements` 仍是 `undefined`，于是此后任何导入该链路的文件
// （如 resources/{task,prod-view,model-management} 经桶入口间接触达 streamdown）以
// `ReferenceError: customElements is not defined` 崩在测试之间的空档里（2026-09-21 实测 4 例）。
// 成对注入后，`customElements.define` 与 `instanceof HTMLElement` 落在同一个 happy-dom 注册表里。
//
// **为什么落点是 @fenix/ui-components 而不是 @fenix/web-runtime 或宿主**：本包是类别 `standalone`
// 的纯前端包，依赖矩阵允许全部类别依赖它（`scripts/lib/architecture-boundary-rules.ts` 的
// `FORBIDDEN_CROSS_CATEGORY.standalone = []`），而调用方横跨 apps/web、resources/*、chat-channel、
// agent-runtime 四类；resources/{memory,skill,workflow} 已声明对本包的依赖，收敛不新增任何依赖边。
// 放在 `apps/web/src/__tests__/` 则会被 `.dependency-cruiser.cjs` 判为 `web-package-not-to-app` 越界
// （包内测试以相对路径读 `apps/web/src/**`），正是本次要削减的台账方向。
//
// 同款先例：`@fenix/resource-machine/server/testing`、`@fenix/platform-sdk/testing`。
//
// 消费方须自行声明 `happy-dom` 为 devDependency（本包已在 devDependencies 声明）；调用点迁移进度
// 见 §1.6 T10（宿主 apps/web 与 resources/{memory,skill,workflow} 的副本一并删除）。

import type { Window } from "happy-dom";

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
