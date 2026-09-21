/**
 * Machine 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/machine-browser-surface.test.ts` 静态走值导入图守护（参照
 * `@fenix/chat-channel` 的同名守卫与沙盒样本）。因此这里只导出可在浏览器中执行的模块；
 * 服务端能力走 `./server`，不得从这里转出。
 *
 * 当前导出面只有机器注册表 API（`registryApi` 与它的记录/查询类型）：本包的服务端能力全部
 * 经 `/web/registry/machines*` 协议暴露，web 侧没有 UI 组件——文件域页面拆两处收敛：可复用的
 * 展示组件（文件树视图、文件选择面板、文件图标辅助）已上收 `@fenix/ui-components`（本包 web 用例按
 * 对方公开入口做消费方断言），宿主专用容器与文件 API 客户端随 §1.6 的 WebShell 装配迁入，届时再从本入口转出。
 * 跨包消费方取用的也是这一份 `registryApi`，因此它们必须走包根 `@fenix/resource-machine/web`，
 * 不得深入 `web/api/registry` 这类实现路径。当前消费方有两处：agent-config 的 Agent 编辑器直连本入口；
 * identity 的组织机器页不直连（§2.3 禁止 platform-impl → resources），改由宿主 route adapter
 * `apps/web/src/routes/agent/_panel/organizations.tsx` 把本入口的 `registryApi` 注入为它的
 * `machineRegistry` prop，端口形状见 identity 的 `agent-organizations-types.ts`。
 */

export * from "./api/registry";
