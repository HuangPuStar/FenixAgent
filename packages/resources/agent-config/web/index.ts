/**
 * Agent 配置控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名 `@/...`；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/agent-config-browser-surface.test.ts` 静态走值导入图守护（参照沙盒样本）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面覆盖当前跨包消费方（2026-09-20 实测）：
 *   - `task` / `prod-view` 取 `agentApi`；
 *   - `model-management` 的编辑器纯逻辑用例取 `agent-editor-model` 的转换函数与校验 schema；
 *   - `workflow` 仍待取 `useMetaAgent`（发布方在本包；宿主的 `hooks/useMetaAgent.ts` 已于 W3 删除，
 *     该包 `useWorkflowMetaAgent` 目前自持环境就绪逻辑）；
 *   - 宿主 WebShell 的 `shell/use-shell-navigation.ts` 取 `sidebarConfigApi`（导航裁剪的隐藏列表），
 *     宿主 `shell/AgentSidebarTree.tsx` 取 `ensureMetaAgent`；
 *   - 宿主聊天容器（`apps/web` 的 ChatArea）取 `loadBoundMcps`，把「Agent 已绑定的 MCP 选项」注入
 *     `@fenix/ui-components` 聊天面板的 `boundMcps` 端口（查询为何落在这里见 `./lib/bound-mcps.ts`）。
 *   - `AgentManagementPage` 原寄居宿主 `apps/web/src/pages/agent-panel/pages/`，§1.6 T11e 随「宿主剩余
 *     页面归位」迁入本包，route adapter 改直连本入口（原先经 vite / tsconfig 的 `@/src/pages/...` 桥接别名）。
 * 这些符号都在本文件的导出面内，消费方一律走包根，不得深入 `web/pages/**` 这类实现路径。
 *
 * 宿主注册 i18n 走子路径 `@fenix/agent-config/web/i18n`（见 `./i18n/index.ts` 的说明）：
 * 从根入口取会把整棵编辑器页面图拉进首屏 bundle。
 */

export * from "./api/agents";
export * from "./api/sites";
export { AgentSitesCard } from "./components/agent-panel/AgentSitesCard";
export { MountSiteDialog } from "./components/agent-panel/MountSiteDialog";
export { SiteFrame } from "./components/agent-panel/SiteFrame";
export { type SiteEntry, SiteTabsBar } from "./components/agent-panel/SiteTabsBar";
export { useMetaAgent } from "./hooks/use-meta-agent";
export { AGENTS_NS, type AgentResources, agentResources } from "./i18n";
export { loadBoundMcps } from "./lib/bound-mcps";
export { AgentFormDialog, type AgentFormDialogProps } from "./pages/agent-panel/agent-editor/AgentFormDialog";
export * from "./pages/agent-panel/agent-editor/agent-editor-model";
export {
  AgentGenerationForm,
  type GenerationFormData,
  type SkillItem,
} from "./pages/agent-panel/components/AgentGenerationForm";
export { AgentManagementPage } from "./pages/agent-panel/pages/AgentManagementPage";
export { AgentSitesPage } from "./pages/agent-panel/pages/AgentSitesPage";
export { AgentSitesCatalog, type SiteVisibilityFilter } from "./pages/agent-panel/pages/agent-sites-catalog";
export * from "./src/api/meta-agent";
export * from "./src/api/sidebar-config";
