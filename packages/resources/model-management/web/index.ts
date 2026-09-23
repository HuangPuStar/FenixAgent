/**
 * Model-management 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名 `@/...`；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/model-management-browser-surface.test.ts` 静态走值导入图守护
 * （参照 sandbox 与 chat-channel 的同名守卫；事故背景见 CLAUDE.md YJS 不变量 11）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面 = 跨包实测需求 + 本包控制台页面/客户端。实测需求（2026-09-20，`grep -rn "@fenix/model-management"`）：
 * `@fenix/agent-config/web` 取 `getModelProviderKey` / `isExternalModelProvider` / `modelApi` 并懒加载
 * `ModelIcon`；宿主路由懒加载 `AlgorithmsPage`。其余导出（页面、api client、纯逻辑助手）供宿主路由从
 * `@/...` 别名切换为包根入口，使消费方不再按深路径引用包内文件（§2.3：不得穿透到另一个包的 `src/**`）。
 *
 * `EmbeddingModelManager` 已移入 `@fenix/resource-knowledge/web`：它管的是 RAGFlow 的 embedding 模型
 * （数据面是 knowledge 的路由 `POST /web/knowledgeBases/models`），唯一消费方是 knowledge 的
 * `AgentKnowledgeBasesPage`，留在本包会让两包互引、barrel 在值导入图上成环。因此本包**不再依赖**
 * `@fenix/resource-knowledge`。
 *
 * `src/index.ts` 保持空入口：根入口若转出浏览器代码，服务端侧任何一次 `import "@fenix/model-management"`
 * 都会把 React 页面图拖进服务端图（计划 §2.3 的 exports 注记）。
 */

// `simplifyModelDisplayName` 的唯一实现在 `@fenix/ui-components`（Chat 输入岛的模型标签与
// 本包的下拉标签都要用同一份化简规则）。此处保留同名转发，本包对外出口不变。
export { simplifyModelDisplayName } from "@fenix/ui-components/chat/lib/simplify-model-display-name";
// API 客户端：`/web/config/models`、`/web/config/providers`、`/web/model-gateway` 与 `/api` 用量查询
export * from "./api/model-gateway";
export * from "./api/models";
export * from "./api/providers";
// 组件：模型配置对话框与模型品牌图标。`@lobehub/icons` 只在 ModelIcon 内出现，纯逻辑模块不加载它
// （CLAUDE.md 前端边界：不得让纯逻辑测试间接加载图标包）。
export {
  ModelConfigDialog,
  type ModelConfigUpdate,
  mergeModelConfigUpdate,
} from "./components/config/ModelConfigDialog";
export { ModelIcon, type ModelIconProps } from "./components/model-icon/ModelIcon";
export { findModelIconEntry, modelIconMap } from "./components/model-icon/model-icon-map";
// i18n：命名空间常量与字典（宿主经 `./web/i18n` 子路径登记，理由见 web/i18n/index.ts）
export { MODELS_NS, type ModelManagementResources, modelManagementResources } from "./i18n";
// 纯逻辑助手：Provider 归属判定、模型选项与用量日期区间（无 React 依赖，可被后端/测试直接调用）
export { buildModelOptions } from "./lib/model-config-utils";
export { buildRecentUsageDateRange, type ModelGatewayUsageDateRange, toUsageDate } from "./lib/model-gateway-usage";
export * from "./lib/provider-resource-access";

// 控制台页面：宿主路由懒加载这些组件（`/agent/_panel/models`、`/admin/model-gateway` 等）
export { AdminModelGatewayPage } from "./pages/admin/AdminModelGatewayPage";
export { AgentModelsPage } from "./pages/agent-panel/pages/AgentModelsPage";
export { ModelGatewayUsagePage } from "./pages/agent-panel/pages/ModelGatewayUsagePage";
export { type VerticalModel, VerticalModelsPage } from "./pages/agent-panel/pages/VerticalModelsPage";
export { AlgorithmDetailDialog } from "./src/pages/agent-panel/pages/AlgorithmDetailDialog";
export { type Algorithm, AlgorithmsPage } from "./src/pages/agent-panel/pages/AlgorithmsPage";
