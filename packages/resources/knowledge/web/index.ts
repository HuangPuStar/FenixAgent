/**
 * Knowledge 控制台浏览器安全入口（`package.json` 的 `exports["./web"]` 必须指向本文件）。
 *
 * 浏览器安全 = 本文件的整条值导入图里不出现 `node:` 内建、`@server/*` 或宿主别名；
 * 跨包引用会经对方 `exports` 递归进入后一并检查（`@fenix/x/server` 这类子路径同样会现形），
 * 由 `web/__tests__/knowledge-browser-surface.test.ts` 静态走值导入图守护（参照 chat-channel 的同名守卫）。
 * 因此这里只导出可在浏览器中执行的模块；服务端能力走 `./server`，不得从这里转出。
 *
 * 导出面覆盖当前跨包消费方（实测 2026-09-20）：`agent-config` 取 `kbApi` 与 `KnowledgeBaseInfo`，
 * 宿主控制台取页面与面板组件。`EmbeddingModelManager` 已由本包自 `@fenix/model-management/web` 收归，
 * 只服务本包页面，因此不经本 barrel 转出（本包页面直接相对导入它）。
 *
 * 命名空间与字典从子路径 `./i18n` 转出而不是各自路径：宿主注册 i18n 时用 `./web/i18n`，
 * 页面消费方只需常量，见 `./i18n/namespace` 的说明。
 */

export { kbApi } from "./api/knowledge-bases";
// embedding 模型管理面（`EmbeddingModelManager` 消费其 `embeddingModelApi`）随组件自
// `@fenix/model-management/web` 收归本包，跨包转出的理由已消失。
export { embeddingModelApi } from "./api/knowledge-models";
export { ResourcePreviewContent } from "./components/knowledge/ResourcePreviewContent";
export { ResourcePreviewDialog } from "./components/knowledge/ResourcePreviewDialog";
// §4.8 拆分：类别判据随 `resource-preview-model.ts` 落位，出口与形状不变（仍是 `getFileCategory`）。
export { getFileCategory } from "./components/knowledge/resource-preview-model";
export { KNOWLEDGE_NS, type KnowledgeResources, knowledgeResources } from "./i18n";
export { KnowledgeGraphPanel } from "./pages/agent-panel/KnowledgeGraphPanel";
export { isKnowledgeGraphNotFound } from "./pages/agent-panel/knowledge-graph-state";
export { AgentKnowledgeBasesPage } from "./pages/agent-panel/pages/AgentKnowledgeBasesPage";
export { AgentKnowledgeDirectory } from "./pages/agent-panel/pages/agent-knowledge-directory";
export { AgentKnowledgeResources } from "./pages/agent-panel/pages/agent-knowledge-resources";
export { ChunkDetailSheet } from "./src/pages/agent-panel/components/ChunkDetailSheet";
export { RetrievalTestPanel } from "./src/pages/agent-panel/components/RetrievalTestPanel";
export type * from "./types/knowledge";
