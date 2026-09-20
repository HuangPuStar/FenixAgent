import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

/**
 * RMD-08 开始时从 root-source-owner audit 导出的精确迁移清单。
 *
 * 第二列是该文件**当前**唯一的 owner 落点。RMD-08 之后有四项改判：
 * 1. `password-crypto.ts` 属于身份密码职责，CE 阶段 2 任务 1.2 把它随 `auth-client.ts` 一并迁入
 *    `packages/platform/identity/web/lib/`，不再是 apps/web 的壳文件。
 * 2. `system-sandbox.test.ts` 验证的是沙盒资源自身的请求构造约定，CE 阶段 2 任务 1.3 把 owner 从应用壳
 *    交给 `packages/resources/sandbox`，宿主侧删除（见下方 relocated 断言）。
 * 3. `admin-key.ts` 是跨资源复用的浏览器端密钥投影，CE 阶段 2 任务 1.3 把它从应用壳上收到
 *    `packages/web-runtime/web/lib/admin-key.ts`，宿主侧删除（见下方 relocated 断言）。
 * 4. 任务 1.3 收口的 9 份「宿主副本」不再由 apps/web 持有：字典、共享类型、hook、面板与一份表单校验测试的
 *    owner 落在资源包 / web-runtime，宿主副本删除（见 `RMD_08_RELOCATED` 与下方 relocated 断言）。
 */
const RMD_08_MOVES = [
  ["web/components/ai-elements/chat-message-content.css", "apps/web/components/ai-elements/chat-message-content.css"],
  ["web/components/ai-elements/code-block.tsx", "apps/web/components/ai-elements/code-block.tsx"],
  ["web/components/ai-elements/conversation.tsx", "apps/web/components/ai-elements/conversation.tsx"],
  ["web/components/ai-elements/iframe-preview.tsx", "apps/web/components/ai-elements/iframe-preview.tsx"],
  ["web/components/ai-elements/index.ts", "apps/web/components/ai-elements/index.ts"],
  ["web/components/ai-elements/message-attachments.tsx", "apps/web/components/ai-elements/message-attachments.tsx"],
  ["web/components/ai-elements/message.tsx", "apps/web/components/ai-elements/message.tsx"],
  ["web/components/ai-elements/permission-request.tsx", "apps/web/components/ai-elements/permission-request.tsx"],
  ["web/components/ai-elements/prompt-input.tsx", "apps/web/components/ai-elements/prompt-input.tsx"],
  ["web/components/ai-elements/reasoning.tsx", "apps/web/components/ai-elements/reasoning.tsx"],
  ["web/components/ai-elements/shimmer.tsx", "apps/web/components/ai-elements/shimmer.tsx"],
  ["web/components/ai-elements/tool.tsx", "apps/web/components/ai-elements/tool.tsx"],
  ["web/components/config/BatchActionBar.tsx", "apps/web/components/config/BatchActionBar.tsx"],
  ["web/components/config/ConfirmDialog.tsx", "apps/web/components/config/ConfirmDialog.tsx"],
  ["web/components/config/DataTable.tsx", "apps/web/components/config/DataTable.tsx"],
  ["web/components/config/EmptyState.tsx", "apps/web/components/config/EmptyState.tsx"],
  ["web/components/config/FormDialog.tsx", "apps/web/components/config/FormDialog.tsx"],
  ["web/components/config/StatusBadge.tsx", "apps/web/components/config/StatusBadge.tsx"],
  ["web/components/config/index.ts", "apps/web/components/config/index.ts"],
  ["web/src/App.tsx", "apps/web/src/App.tsx"],
  ["web/src/__tests__/agent-create-enter-flow.test.ts", "apps/web/src/__tests__/agent-create-enter-flow.test.ts"],
  [
    "web/src/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-editor-guards.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-editor-guards.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-pure-logic.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-round54-pure.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-round54-pure.test.ts",
  ],
  ["web/src/__tests__/agent-form-dialog-ssr.test.tsx", "apps/web/src/__tests__/agent-form-dialog-ssr.test.tsx"],
  ["web/src/__tests__/agent-home-generation.test.tsx", "apps/web/src/__tests__/agent-home-generation.test.tsx"],
  ["web/src/__tests__/agent-node-selector.test.ts", "apps/web/src/__tests__/agent-node-selector.test.ts"],
  [
    "web/src/__tests__/agent-resource-picker-interaction.test.tsx",
    "apps/web/src/__tests__/agent-resource-picker-interaction.test.tsx",
  ],
  [
    "web/src/__tests__/agent-sidebar-instance-order.test.ts",
    "apps/web/src/__tests__/agent-sidebar-instance-order.test.ts",
  ],
  ["web/src/__tests__/agent-utils.test.ts", "apps/web/src/__tests__/agent-utils.test.ts"],
  ["web/src/__tests__/api-client.test.ts", "apps/web/src/__tests__/api-client.test.ts"],
  ["web/src/__tests__/api-result-utils.test.ts", "apps/web/src/__tests__/api-result-utils.test.ts"],
  ["web/src/__tests__/artifacts-preview-events.test.ts", "apps/web/src/__tests__/artifacts-preview-events.test.ts"],
  ["web/src/__tests__/auth-preference.test.ts", "apps/web/src/__tests__/auth-preference.test.ts"],
  ["web/src/__tests__/config-datatable.test.ts", "apps/web/src/__tests__/config-datatable.test.ts"],
  ["web/src/__tests__/config-helpers.test.ts", "apps/web/src/__tests__/config-helpers.test.ts"],
  ["web/src/__tests__/config-routing.test.ts", "apps/web/src/__tests__/config-routing.test.ts"],
  ["web/src/__tests__/config-types.test.ts", "apps/web/src/__tests__/config-types.test.ts"],
  ["web/src/__tests__/confirm-dialog.test.tsx", "apps/web/src/__tests__/confirm-dialog.test.tsx"],
  ["web/src/__tests__/context-queue.test.ts", "apps/web/src/__tests__/context-queue.test.ts"],
  ["web/src/__tests__/dark-mode-components.test.tsx", "apps/web/src/__tests__/dark-mode-components.test.tsx"],
  ["web/src/__tests__/data-table-round41-pure.test.tsx", "apps/web/src/__tests__/data-table-round41-pure.test.tsx"],
  ["web/src/__tests__/data-table-ssr.test.tsx", "apps/web/src/__tests__/data-table-ssr.test.tsx"],
  ["web/src/__tests__/date-picker.test.tsx", "apps/web/src/__tests__/date-picker.test.tsx"],
  [
    "web/src/__tests__/extract-changed-files-boundaries.test.ts",
    "apps/web/src/__tests__/extract-changed-files-boundaries.test.ts",
  ],
  ["web/src/__tests__/extract-changed-files.test.ts", "apps/web/src/__tests__/extract-changed-files.test.ts"],
  ["web/src/__tests__/folder-upload-batching.test.ts", "apps/web/src/__tests__/folder-upload-batching.test.ts"],
  ["web/src/__tests__/form-utils.test.ts", "apps/web/src/__tests__/form-utils.test.ts"],
  ["web/src/__tests__/fs-upload-url.test.ts", "apps/web/src/__tests__/fs-upload-url.test.ts"],
  ["web/src/__tests__/instances-api.test.ts", "apps/web/src/__tests__/instances-api.test.ts"],
  ["web/src/__tests__/message-additional-ssr.test.tsx", "apps/web/src/__tests__/message-additional-ssr.test.tsx"],
  ["web/src/__tests__/narrators-i18n.test.ts", "apps/web/src/__tests__/narrators-i18n.test.ts"],
  ["web/src/__tests__/new-session-dialog-form.test.ts", "apps/web/src/__tests__/new-session-dialog-form.test.ts"],
  ["web/src/__tests__/pagination.test.tsx", "apps/web/src/__tests__/pagination.test.tsx"],
  [
    "web/src/__tests__/params-editor-round42-pure.test.tsx",
    "apps/web/src/__tests__/params-editor-round42-pure.test.tsx",
  ],
  ["web/src/__tests__/peri-task-details-api.test.ts", "apps/web/src/__tests__/peri-task-details-api.test.ts"],
  ["web/src/__tests__/permission-options.test.ts", "apps/web/src/__tests__/permission-options.test.ts"],
  ["web/src/__tests__/preview-utils-normalize.test.ts", "apps/web/src/__tests__/preview-utils-normalize.test.ts"],
  [
    "web/src/__tests__/pure-logic-transform-boundaries.test.ts",
    "apps/web/src/__tests__/pure-logic-transform-boundaries.test.ts",
  ],
  ["web/src/__tests__/random-uuid-polyfill.test.ts", "apps/web/src/__tests__/random-uuid-polyfill.test.ts"],
  ["web/src/__tests__/retry.test.ts", "apps/web/src/__tests__/retry.test.ts"],
  ["web/src/__tests__/strip-html-tags.test.ts", "apps/web/src/__tests__/strip-html-tags.test.ts"],
  [
    "web/src/__tests__/structured-thread-additional.test.ts",
    "apps/web/src/__tests__/structured-thread-additional.test.ts",
  ],
  [
    "web/src/__tests__/structured-thread-boundaries.test.ts",
    "apps/web/src/__tests__/structured-thread-boundaries.test.ts",
  ],
  ["web/src/__tests__/todo.test.ts", "apps/web/src/__tests__/todo.test.ts"],
  ["web/src/__tests__/tree-component.test.tsx", "apps/web/src/__tests__/tree-component.test.tsx"],
  ["web/src/__tests__/use-task-views.test.tsx", "apps/web/src/__tests__/use-task-views.test.tsx"],
  ["web/src/__tests__/utils.test.ts", "apps/web/src/__tests__/utils.test.ts"],
  ["web/src/api/fs.ts", "apps/web/src/api/fs.ts"],
  ["web/src/api/instances.ts", "apps/web/src/api/instances.ts"],
  ["web/src/api/peri-task-details.ts", "apps/web/src/api/peri-task-details.ts"],
  ["web/src/api/registry.ts", "apps/web/src/api/registry.ts"],
  ["web/src/components/FilePickerDialog.tsx", "apps/web/src/components/FilePickerDialog.tsx"],
  ["web/src/components/OrgSwitcher.tsx", "apps/web/src/components/OrgSwitcher.tsx"],
  ["web/src/components/PermissionTab.tsx", "apps/web/src/components/PermissionTab.tsx"],
  [
    "web/src/components/agent-panel/ChangedFilesSection.tsx",
    "apps/web/src/components/agent-panel/ChangedFilesSection.tsx",
  ],
  ["web/src/components/agent-panel/FileTabsBar.tsx", "apps/web/src/components/agent-panel/FileTabsBar.tsx"],
  [
    "web/src/components/agent-panel/FileTreeContextMenu.tsx",
    "apps/web/src/components/agent-panel/FileTreeContextMenu.tsx",
  ],
  ["web/src/components/agent-panel/FileTreeTab.tsx", "apps/web/src/components/agent-panel/FileTreeTab.tsx"],
  ["web/src/components/agent-panel/PreviewTab.tsx", "apps/web/src/components/agent-panel/PreviewTab.tsx"],
  ["web/src/components/agent-panel/TopModeTabs.tsx", "apps/web/src/components/agent-panel/TopModeTabs.tsx"],
  ["web/src/components/agent-panel/WorkbenchPanel.tsx", "apps/web/src/components/agent-panel/WorkbenchPanel.tsx"],
  ["web/src/components/agent-panel/artifacts-dialogs.tsx", "apps/web/src/components/agent-panel/artifacts-dialogs.tsx"],
  [
    "web/src/components/agent-panel/artifacts-files-workspace.tsx",
    "apps/web/src/components/agent-panel/artifacts-files-workspace.tsx",
  ],
  [
    "web/src/components/agent-panel/file-tree-input-dialog.tsx",
    "apps/web/src/components/agent-panel/file-tree-input-dialog.tsx",
  ],
  ["web/src/components/agent-panel/file-tree-model.ts", "apps/web/src/components/agent-panel/file-tree-model.ts"],
  ["web/src/components/agent-panel/file-tree-view.tsx", "apps/web/src/components/agent-panel/file-tree-view.tsx"],
  [
    "web/src/components/agent-panel/preview/FileViewerPreview.tsx",
    "apps/web/src/components/agent-panel/preview/FileViewerPreview.tsx",
  ],
  [
    "web/src/components/agent-panel/preview/html-plugin.ts",
    "apps/web/src/components/agent-panel/preview/html-plugin.ts",
  ],
  [
    "web/src/components/agent-panel/preview/native-pdf-plugin.ts",
    "apps/web/src/components/agent-panel/preview/native-pdf-plugin.ts",
  ],
  ["web/src/components/agent-panel/preview/overrides.css", "apps/web/src/components/agent-panel/preview/overrides.css"],
  ["web/src/components/agent-panel/preview/utils.ts", "apps/web/src/components/agent-panel/preview/utils.ts"],
  [
    "web/src/components/agent-panel/use-file-tree-events.ts",
    "apps/web/src/components/agent-panel/use-file-tree-events.ts",
  ],
  ["web/src/components/agent-panel/use-file-uploads.ts", "apps/web/src/components/agent-panel/use-file-uploads.ts"],
  ["web/src/components/file-icon-helper.tsx", "apps/web/src/components/file-icon-helper.tsx"],
  ["web/src/components/layout/app-header.tsx", "apps/web/src/components/layout/app-header.tsx"],
  ["web/src/components/layout/app-page.tsx", "apps/web/src/components/layout/app-page.tsx"],
  ["web/src/hooks/use-changed-files-stats.ts", "apps/web/src/hooks/use-changed-files-stats.ts"],
  ["web/src/hooks/use-task-views.ts", "apps/web/src/hooks/use-task-views.ts"],
  ["web/src/hooks/usePageVisible.ts", "apps/web/src/hooks/usePageVisible.ts"],
  ["web/src/i18n/locales/en/agentHome.json", "apps/web/src/i18n/locales/en/agentHome.json"],
  ["web/src/i18n/locales/en/agentPanel.json", "apps/web/src/i18n/locales/en/agentPanel.json"],
  ["web/src/i18n/locales/en/common.json", "apps/web/src/i18n/locales/en/common.json"],
  ["web/src/i18n/locales/en/components.json", "apps/web/src/i18n/locales/en/components.json"],
  ["web/src/i18n/locales/en/dashboard.json", "apps/web/src/i18n/locales/en/dashboard.json"],
  ["web/src/i18n/locales/en/environments.json", "apps/web/src/i18n/locales/en/environments.json"],
  ["web/src/i18n/locales/en/login.json", "apps/web/src/i18n/locales/en/login.json"],
  ["web/src/i18n/locales/en/sessions.json", "apps/web/src/i18n/locales/en/sessions.json"],
  ["web/src/i18n/locales/en/settings.json", "apps/web/src/i18n/locales/en/settings.json"],
  ["web/src/i18n/locales/en/sidebar.json", "apps/web/src/i18n/locales/en/sidebar.json"],
  ["web/src/i18n/locales/en/tasks.json", "apps/web/src/i18n/locales/en/tasks.json"],
  ["web/src/i18n/locales/en/toolNarrator.json", "apps/web/src/i18n/locales/en/toolNarrator.json"],
  ["web/src/i18n/locales/zh/agentHome.json", "apps/web/src/i18n/locales/zh/agentHome.json"],
  ["web/src/i18n/locales/zh/agentPanel.json", "apps/web/src/i18n/locales/zh/agentPanel.json"],
  ["web/src/i18n/locales/zh/common.json", "apps/web/src/i18n/locales/zh/common.json"],
  ["web/src/i18n/locales/zh/components.json", "apps/web/src/i18n/locales/zh/components.json"],
  ["web/src/i18n/locales/zh/dashboard.json", "apps/web/src/i18n/locales/zh/dashboard.json"],
  ["web/src/i18n/locales/zh/environments.json", "apps/web/src/i18n/locales/zh/environments.json"],
  ["web/src/i18n/locales/zh/login.json", "apps/web/src/i18n/locales/zh/login.json"],
  ["web/src/i18n/locales/zh/sessions.json", "apps/web/src/i18n/locales/zh/sessions.json"],
  ["web/src/i18n/locales/zh/settings.json", "apps/web/src/i18n/locales/zh/settings.json"],
  ["web/src/i18n/locales/zh/sidebar.json", "apps/web/src/i18n/locales/zh/sidebar.json"],
  ["web/src/i18n/locales/zh/tasks.json", "apps/web/src/i18n/locales/zh/tasks.json"],
  ["web/src/i18n/locales/zh/toolNarrator.json", "apps/web/src/i18n/locales/zh/toolNarrator.json"],
  ["web/src/lib/agent-node.ts", "apps/web/src/lib/agent-node.ts"],
  ["web/src/lib/agent-resource-access.ts", "apps/web/src/lib/agent-resource-access.ts"],
  ["web/src/lib/agent-utils.ts", "apps/web/src/lib/agent-utils.ts"],
  ["web/src/lib/api-result.ts", "apps/web/src/lib/api-result.ts"],
  ["web/src/lib/artifacts-preview-events.ts", "apps/web/src/lib/artifacts-preview-events.ts"],
  ["web/src/lib/auth-preference.ts", "apps/web/src/lib/auth-preference.ts"],
  ["web/src/lib/chat-stats.ts", "apps/web/src/lib/chat-stats.ts"],
  ["web/src/lib/citation-preview-context.tsx", "apps/web/src/lib/citation-preview-context.tsx"],
  ["web/src/lib/config-events.ts", "apps/web/src/lib/config-events.ts"],
  ["web/src/lib/context-queue.ts", "apps/web/src/lib/context-queue.ts"],
  ["web/src/lib/extract-changed-files.ts", "apps/web/src/lib/extract-changed-files.ts"],
  ["web/src/lib/form-utils.ts", "apps/web/src/lib/form-utils.ts"],
  ["web/src/lib/password-crypto.ts", "packages/platform/identity/web/lib/password-crypto.ts"],
  ["web/src/lib/retry.ts", "apps/web/src/lib/retry.ts"],
  ["web/src/lib/strip-html-tags.ts", "apps/web/src/lib/strip-html-tags.ts"],
  ["web/src/lib/structured-to-thread.ts", "apps/web/src/lib/structured-to-thread.ts"],
  ["web/src/lib/todo.ts", "apps/web/src/lib/todo.ts"],
  ["web/src/lib/token-stats.ts", "apps/web/src/lib/token-stats.ts"],
  ["web/src/lib/tool-semantic.ts", "apps/web/src/lib/tool-semantic.ts"],
  ["web/src/lib/types.ts", "apps/web/src/lib/types.ts"],
  ["web/src/lib/use-context-queue.ts", "apps/web/src/lib/use-context-queue.ts"],
  ["web/src/pages/LoginPage.tsx", "apps/web/src/pages/LoginPage.tsx"],
  ["web/src/pages/agent-panel/AgentAppShell.tsx", "apps/web/src/pages/agent-panel/AgentAppShell.tsx"],
  ["web/src/pages/agent-panel/AgentPanelLayout.tsx", "apps/web/src/pages/agent-panel/AgentPanelLayout.tsx"],
  ["web/src/pages/agent-panel/AgentPanelPage.tsx", "apps/web/src/pages/agent-panel/AgentPanelPage.tsx"],
  ["web/src/pages/agent-panel/AgentSidebar.tsx", "apps/web/src/pages/agent-panel/AgentSidebar.tsx"],
  ["web/src/pages/agent-panel/AgentSidebarConfig.tsx", "apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx"],
  ["web/src/pages/agent-panel/AgentSidebarTree.tsx", "apps/web/src/pages/agent-panel/AgentSidebarTree.tsx"],
  ["web/src/pages/agent-panel/ArtifactsPanel.tsx", "apps/web/src/pages/agent-panel/ArtifactsPanel.tsx"],
  ["web/src/pages/agent-panel/agent-create-navigation.ts", "apps/web/src/pages/agent-panel/agent-create-navigation.ts"],
  ["web/src/pages/agent-panel/agent-panel.css", "apps/web/src/pages/agent-panel/agent-panel.css"],
  ["web/src/pages/agent-panel/artifacts-workspace.css", "apps/web/src/pages/agent-panel/artifacts-workspace.css"],
  [
    "web/src/pages/agent-panel/components/KnowledgeGraphPanel.tsx",
    "apps/web/src/pages/agent-panel/components/KnowledgeGraphPanel.tsx",
  ],
  [
    "web/src/pages/agent-panel/pages/AgentDashboardPage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentDashboardPage.tsx",
  ],
  ["web/src/pages/agent-panel/pages/AgentHomePage.tsx", "apps/web/src/pages/agent-panel/pages/AgentHomePage.tsx"],
  [
    "web/src/pages/agent-panel/pages/AgentManagementPage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentManagementPage.tsx",
  ],
  ["web/src/pages/agent-panel/shared/AgentCardList.tsx", "apps/web/src/pages/agent-panel/shared/AgentCardList.tsx"],
  [
    "web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx",
    "apps/web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx",
  ],
  ["web/src/types/cytoscape-fcose.d.ts", "apps/web/src/types/cytoscape-fcose.d.ts"],
  ["web/src/types/global.d.ts", "apps/web/src/types/global.d.ts"],
  ["web/src/types/index.ts", "apps/web/src/types/index.ts"],
  ["web/src/types/react-file-icon.d.ts", "apps/web/src/types/react-file-icon.d.ts"],
  ["web/src/vite-env.d.ts", "apps/web/src/vite-env.d.ts"],
  ["web/tsconfig.json", "apps/web/tsconfig.json"],
] as const;

/**
 * 任务 1.3 收口时删掉的宿主副本，三元组为 `[旧根路径, 应用壳路径, 包内 owner 落点]`。
 *
 * 这些文件在 RMD-08 时是「apps/web 的壳」，但键的 owner 与实现的 owner 都属于资源包 / web-runtime：
 * 宿主再留一份就是两份实现并存（i18n 字典尤其危险——命名空间同名时构建期不报错，运行期整片文案回退）。
 * `MetaAgentPanel.tsx` 的宿主副本在被删除前已经零引用（面板实现在 workflow 包内），仍按「宿主不得复活」
 * 断言，避免把一份 workflow 实现重新接回应用壳。
 */
const RMD_08_RELOCATED = [
  [
    "web/components/MetaAgentPanel.tsx",
    "apps/web/components/MetaAgentPanel.tsx",
    "packages/resources/workflow/web/pages/workflow/components/MetaAgentPanel.tsx",
  ],
  [
    "web/src/hooks/useMetaAgent.ts",
    "apps/web/src/hooks/useMetaAgent.ts",
    "packages/resources/agent-config/web/hooks/use-meta-agent.ts",
  ],
  [
    "web/src/lib/use-workflow-events.ts",
    "apps/web/src/lib/use-workflow-events.ts",
    "packages/resources/workflow/web/lib/use-workflow-events.ts",
  ],
  ["web/src/types/config.ts", "apps/web/src/types/config.ts", "packages/web-runtime/web/types/config.ts"],
  [
    "web/src/i18n/locales/en/agents.json",
    "apps/web/src/i18n/locales/en/agents.json",
    "packages/resources/agent-config/web/i18n/locales/en/agents.json",
  ],
  [
    "web/src/i18n/locales/zh/agents.json",
    "apps/web/src/i18n/locales/zh/agents.json",
    "packages/resources/agent-config/web/i18n/locales/zh/agents.json",
  ],
  [
    "web/src/i18n/locales/en/models.json",
    "apps/web/src/i18n/locales/en/models.json",
    "packages/resources/model-management/web/i18n/locales/en/models.json",
  ],
  [
    "web/src/i18n/locales/zh/models.json",
    "apps/web/src/i18n/locales/zh/models.json",
    "packages/resources/model-management/web/i18n/locales/zh/models.json",
  ],
  [
    "web/src/__tests__/task-form-schema.test.ts",
    "apps/web/src/__tests__/task-form-schema.test.ts",
    "packages/resources/task/web/__tests__/agent-tasks-utils.test.ts",
  ],
] as const;

describe("RMD-08 apps/web migration", () => {
  // 171 个保留的应用壳源文件都必须从旧根路径移除，并保留在唯一的 owner 目标。
  // 任务 1.3 收口移出的一项：`__tests__/task-form-schema.test.ts` 是内联的表单校验 schema 副本，宿主侧
  // 既无 TaskForm 组件也无导入方，且已与包内唯一 owner 漂移；owner 是 task 包，见下方 relocated 断言。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_08_MOVES).toHaveLength(171);
    for (const [source, target] of RMD_08_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `apps/web target is missing: ${target}`).toBe(true);
    }
  });

  // 已批准退役的污染测试在旧根路径和迁移目标中都不得复活。
  test("keeps the retired card renderer test deleted", () => {
    expect(existsSync("web/src/__tests__/card-renderer-pure-utils.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/card-renderer-pure-utils.test.ts")).toBe(false);
  });

  // 沙盒请求构造测试的 owner 已从应用壳交给资源包：旧根路径与旧 app 壳路径都不得复活，包内必须有唯一落点。
  test("relocates the sandbox request helper test to the resource package", () => {
    expect(existsSync("web/src/__tests__/system-sandbox.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/system-sandbox.test.ts")).toBe(false);
    expect(existsSync("packages/resources/sandbox/web/__tests__/system-sandbox.test.ts")).toBe(true);
  });

  // 跨资源复用的密钥投影已上收到 web-runtime：宿主两份旧路径都不得复活，且包内保留唯一实现。
  test("relocates the admin key projection to web runtime", () => {
    expect(existsSync("web/src/lib/admin-key.ts")).toBe(false);
    expect(existsSync("apps/web/src/lib/admin-key.ts")).toBe(false);
    expect(existsSync("packages/web-runtime/web/lib/admin-key.ts")).toBe(true);
  });

  // 任务 1.3 收口的 9 份宿主副本：旧根路径与应用壳路径都不得复活，且包侧 owner 落点必须存在。
  // 副本与 owner 并存是「两份实现各自能跑」的最坏形态，删除与断言必须成对出现。
  test("relocates the leftover host copies to their package owners", () => {
    expect(RMD_08_RELOCATED).toHaveLength(9);
    for (const [legacy, shell, owner] of RMD_08_RELOCATED) {
      expect(existsSync(legacy), `legacy source still exists: ${legacy}`).toBe(false);
      expect(existsSync(shell), `host copy still exists: ${shell}`).toBe(false);
      expect(existsSync(owner), `package owner is missing: ${owner}`).toBe(true);
    }
  });
});
