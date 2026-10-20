// web/__tests__/knowledge-graph-canvas-stub.ts
// 知识图谱面板用例共用的 `@antv/g6` 替身注册器（与同目录 `react-i18next-stub.ts` 同一模式）。
//
// 为什么必须替身：取数成功且节点数 > 0 时 `use-knowledge-graph-canvas` 会 `await import("@antv/g6")`
// 并 `new Graph(...)`；G6 经 `@antv/g-canvas` 立即向 `canvas.getContext("2d")` 取 2D 上下文，而
// happy-dom 没有画布实现、拿到 `null` 后在建图期抛 `TypeError: null is not an object`
// （CI Linux 上稳定命中；本机是否命中取决于惰性 import 与用例卸载的时序）。
// 面板用例断言的是「数据到手」这一层，不覆盖 G6 渲染，替身把画布层挡在测试之外。
//
// 为什么抽成共享模块：① CLAUDE.md「测试文件禁止直接调用 `mock.module()`」（宿主
// `setup-mocks.ts` 是正向收敛点，包内如 workflow 的 `src/server/testing.ts` 也以辅助模块封装）；
// ② bun 的模块替身是**进程级**注册、不可撤销，注册语义集中一处便于复用与核对。

import { mock } from "bun:test";

/**
 * 与 `use-knowledge-graph-canvas` 实际使用的 G6 API 对齐的空替身：构造、`setData` / `render` /
 * `once` / `fitView` / `destroy`。不触 DOM、不建画布——生产代码新增调用面时需同步补充，
 * 缺失会以 TypeError 在用例里直接暴露。
 */
class StubGraph {
  /** 构造参数即 `buildKnowledgeGraphSpec` 的返回值，替身不消费。 */
  constructor(_options: unknown) {}
  /** 换数据（真实实现会重排布局）。 */
  setData(_data: unknown): void {}
  /** 建图（真实实现会创建画布并渲染；替身不触 DOM）。 */
  render(): void {}
  /** 事件订阅（真实实现的 `afterlayout` 会触发 fitView；替身不回调，兜底定时器随用例卸载被清理）。 */
  once(_event: string, _handler: () => void): void {}
  /** 视口自适应（布局收敛后调用；替身忽略）。 */
  fitView(_options?: unknown, _animate?: boolean): void {}
  /** 销毁实例（真实实现会销毁画布；替身忽略）。 */
  destroy(): void {}
}

/** 注册 `@antv/g6` 替身；须在被测组件触发 `await import("@antv/g6")` 之前调用。 */
export function registerKnowledgeGraphCanvasStub(): void {
  mock.module("@antv/g6", () => ({ Graph: StubGraph }));
}
