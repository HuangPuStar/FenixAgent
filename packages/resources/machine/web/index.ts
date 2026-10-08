/**
 * Machine 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/machine-browser-surface.test.ts` 静态走值导入图守护（参照
 * `@fenix/chat-channel` 的同名守卫与沙盒样本）。因此这里只导出可在浏览器中执行的模块；
 * 服务端能力走 `./server`，不得从这里转出。文案资源也不经本入口转出（宿主在启动期求值，
 * 会把字典拉进首屏 bundle）：走 `exports["./web/i18n"]` 子路径，见 `web/i18n/index.ts`。
 *
 * 当前导出面：
 * - 机器注册表 API（`web/api/registry.ts`）：跨包消费方（agent-config 的 Agent 编辑器直连本入口；
 *   identity 的组织机器页不直连，§2.3 禁止 platform-impl → resources，改由宿主 route adapter
 *   `apps/web/src/routes/agent/_panel/organizations.tsx` 把 `registryApi` 注入为它的 `machineRegistry`
 *   prop，端口形状见 identity 的 `agent-organizations-types.ts`）。它们必须走包根
 *   `@fenix/resource-machine/web`——`web/api/registry` 这类实现路径不在 `exports` 里。
 * - 文件域客户端（`web/api/fs.ts`：文件树 / 目录 / 读写 / 上传 / 下载 / 预览源）、文件变更事件通道
 *   （`web/api/file-events.ts`：`/web/file-events` 的 WS 入口与帧归一）与文件上传 hook
 *   （`web/hooks/use-file-uploads.ts`）：2026-09-24 随台账 `ce-standards-todo.md` D2 由宿主
 *   `apps/web/src/api/{fs,file-events}.ts` 与 `apps/web/src/shell/artifacts/use-file-uploads.ts` 迁入
 *   （该簇 2026-09-28 归位到 `apps/web/src/pages/agent-panel/artifacts/`，上述文件都不在其中）。
 * - 文件域容器与状态编排（2026-09-24，D2 同批）：`web/components/FileTreeTab.tsx`（文件树：下载、
 *   重试、失效事件、上传落点）、`web/components/FileTabsBar.tsx` + `web/components/artifacts-files-workspace.tsx`
 *   （tab 栏与文件工作区）、`web/hooks/{use-artifacts-files,use-file-tree-events}.ts`、
 *   `web/lib/normalize-to-user-path.ts`；`web/hooks/use-drag-counter.ts` 是这一簇的内部实现
 *   （两个调用点都在包内），不转出。宿主 `apps/web/src/pages/agent-panel/artifacts/` 只剩跨包装配
 *   （`ArtifactsPanel` 的模式切换把 machine / agent-config / task / prod-view 四家的 UI 装在一起、
 *   `TopModeTabs`、站点绑定对话框与其 hook）——`machine` 属 §2.3 矩阵的固定基础资源，不得导入
 *   `@fenix/agent-config`（包内 `src/__tests__/machine-package-contract.test.ts` 守卫），那部分因此
 *   留在宿主壳层，不随文件域迁入。
 */

export * from "./api/file-events";
export * from "./api/fs";
export * from "./api/registry";
export * from "./components/artifacts-files-workspace";
export * from "./components/FileTabsBar";
export * from "./components/FileTreeTab";
export * from "./hooks/use-artifacts-files";
export * from "./hooks/use-file-tree-events";
export * from "./hooks/use-file-uploads";
export * from "./lib/normalize-to-user-path";
