// setup-globals.ts — 在 preload 链最前端运行，确保 CI CJS 环境下的模块加载兼容性
// 不 import 任何模块，避免 react-dom 在 window 准备好之前被间接加载

// CI 环境 react-dom 的 CJS 构建在模块加载时直接访问 window；
// 后端测试不应加载 React，但某些间接依赖链可能触发加载
if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}

/**
 * 无 DOM 进程里的 `matchMedia` 桩。
 *
 * 上面那行 window 垫片会让第三方库的 `typeof window !== "undefined"` 守卫成立，于是它们接着访问
 * `matchMedia`（例如 `@lobehub/icons` → `antd-style` 在模块加载期就裸调它做暗色偏好判定），在
 * 无 DOM 的 `bun test` 进程里抛 `ReferenceError` 并导致整文件 0 断言执行——受影响的是那些只跑纯逻辑、
 * 却因导入组件模块而连带加载 `antd-style` 的用例（`agent-form-dialog-*`、`agent-resource-picker-*`
 * 等）。这是**最小垫片，不是 DOM**：只补齐「有 window 就必须有 matchMedia」这一条隐含契约，让加载期
 * 守卫与断点判定退回默认分支；需要真实 DOM 的用例仍各自显式建立 happy-dom Window
 *（`@fenix/ui-components/testing` 的 `initializeHappyDomWindow`，全仓唯一实现）。
 *
 * 与包侧记录的阻断项一致（`packages/resources/model-management/web/__tests__/provider-model-resource-access-flow.test.ts`
 * 与 `packages/resources/agent-config/web/__tests__/agent-config-browser-surface.test.ts` 均以「补齐
 * matchMedia 桩」为可接受的解除条件）。移除条件：web 用例改为在真实 happy-dom 环境里运行，
 * 不再需要这层 window/matchMedia 垫片。
 */
if (typeof (globalThis as Record<string, unknown>).matchMedia !== "function") {
  // 结构对齐 `MediaQueryList`，但不引用该 DOM 类型：server 侧 tsconfig 未加载 DOM lib，
  // 写出类型名会直接编译失败（`error TS2304`）。
  const createMediaQueryList = (query: string) => ({
    // 无 DOM 一律按「不匹配」处理：暗色跟随与响应式断点都走默认分支，结论稳定可预期。
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
  (globalThis as Record<string, unknown>).matchMedia = createMediaQueryList;
}
