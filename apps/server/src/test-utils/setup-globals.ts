// setup-globals.ts — 在 preload 链最前端运行，确保 CI CJS 环境下的模块加载兼容性
// 不 import 任何模块，避免 react-dom 在 window 准备好之前被间接加载

// CI 环境 react-dom 的 CJS 构建在模块加载时直接访问 window；
// 后端测试不应加载 React，但某些间接依赖链可能触发加载
if (typeof (globalThis as Record<string, unknown>).window === "undefined") {
  (globalThis as Record<string, unknown>).window = globalThis;
}
