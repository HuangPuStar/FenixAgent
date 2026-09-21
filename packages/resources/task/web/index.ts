/**
 * Task 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/task-browser-surface.test.ts` 静态走值导入图守护（参照 sandbox 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面按**包外真实消费点**收敛（实测 `git grep -n "@fenix/resource-task" -- apps` 只命中宿主服务端、
 * 宿主 i18n 注册与生成的 registry）：i18n 由宿主 `apps/web/src/i18n/index.ts:23` 经 `./web/i18n` 子路径
 * 消费（2026-09-20 落地）；浏览器侧的 3 处宿主直连**已全部改为本入口**（§1.6 T11e 收口）——
 * `routes/agent/_panel/tasks.tsx:5` 的懒加载取 `AgentTasksPage`，`shell/ArtifactsPanel.tsx` 取 `TasksPanel`
 * （后者先是深层相对路径穿透包内，T11e-4b 一并改为 `@fenix/resource-task/web`）；两处 `@/src/…` alias
 * 条目已随同批的别名表删除消失。
 * 因此这里导出 `AgentTasksPage`、`TasksPanel`、`taskV2Api` 与 i18n 资源；其余页面级组件
 * （`AgentTasksRegistry` / `AgentTaskRuntimeBoard`）是 `AgentTasksPage` 的内部视图，由它自己组合——
 * 今天没有第二个消费者，提前导出只会让「内部视图的 props 形状」变成对外契约。
 */

export * from "./api/tasks-v2";
export { TASKS_V2_NS, type TasksV2Resources, tasksV2Resources } from "./i18n";
export { AgentTasksPage } from "./pages/agent-panel/pages/AgentTasksPage";
export { TasksPanel } from "./pages/agent-panel/TasksPanel";
