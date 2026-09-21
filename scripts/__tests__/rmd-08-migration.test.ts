import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

/**
 * RMD-08 开始时从 root-source-owner audit 导出的精确迁移清单。
 *
 * 第二列是该文件**当前**唯一的 owner 落点。RMD-08 之后有五项改判：
 * 1. `password-crypto.ts` 属于身份密码职责，CE 阶段 2 任务 1.2 把它随 `auth-client.ts` 一并迁入
 *    `packages/platform/identity/web/lib/`，不再是 apps/web 的壳文件。
 * 2. `system-sandbox.test.ts` 验证的是沙盒资源自身的请求构造约定，CE 阶段 2 任务 1.3 把 owner 从应用壳
 *    交给 `packages/resources/sandbox`，宿主侧删除（见下方 relocated 断言）。
 * 3. `admin-key.ts` 是跨资源复用的浏览器端密钥投影，CE 阶段 2 任务 1.3 把它从应用壳上收到
 *    `packages/web-runtime/web/lib/admin-key.ts`，宿主侧删除（见下方 relocated 断言）。
 * 4. 任务 1.3 收口的 9 份「宿主副本」不再由 apps/web 持有：字典、共享类型、hook、面板与一份表单校验测试的
 *    owner 落在资源包 / web-runtime，宿主副本删除（见 `RMD_08_RELOCATED` 与下方 relocated 断言）。
 * 5. 任务 1.6 T2 删掉 18 个零消费宿主文件（171 → 153）：它们的 owner 落点**从未**被任何代码引用，
 *    是 RMD-08 的搬运残留再加之后续拆分留下的孤儿。删除依据见任务 1.6 T2 的 review 文档：
 *    逐标识符全仓 grep + 传递可达性（测试算根与不算根两轮）+ 现有 dist sourcemap 实证三者一致。
 * 6. 任务 1.6 T4 再移出一项：`web/src/api/registry.ts` 的壳副本在 T4 之前一直由 identity 的组织机器页
 *    经 `@/src/api/registry` 别名消费，T4 把该页的机器注册表能力改成宿主注入的 `MachineRegistryPort`
 *    后，壳副本零消费，且与 `packages/resources/machine/web/api/registry.ts` 除 import 说明符外逐字相同，
 *    于是删除、owner 归 machine 包（见下方 relocated 断言）。
 * 7. 任务 1.6 T9c 直删 9 项（109 → 100）：`TASKS` / `SESSIONS` / `ENVIRONMENTS` / `TOOL_NARRATOR` 四个
 *    宿主命名空间的 8 份字典在全仓没有任何 `useTranslation` 绑定（历史迁出后留下的空壳，真实消费方各在
 *    资源包内），连同守护 `toolNarrator` 字典的**自指测试** `narrators-i18n.test.ts`（它只读该字典并断言
 *    同一文件里的键）一并删除。删除口径与逐条证据见 `review/task-1.6-web-shell.md` §7.17。
 * 8. 任务 1.6 T10b1 把 12 个 ui-components 归属的宿主测试移入包内（100 → 88）：这些用例的被测实现
 *    在 T8b/T8c 已整体退场到 `@fenix/ui-components`，导入图里除标准库外只指向该包出口，留在宿主等于让
 *    「包内实现」被「应用壳测试」守护；搬运后宿主不再是它们的 owner（见下方 relocated 断言）。
 * 9. 任务 1.6 T10b2 把 7 个 web-runtime 归属的宿主测试移入包内（88 → 82）：判定口径同第 8 条，只是 owner
 *    换成 `@fenix/web-runtime`；其中 `request.test.ts` 不在 RMD-08 快照内（它守护的是 T8d 才上收到包里的
 *    `api/request`），一并归位并补进 relocated 断言，避免宿主侧复活。
 * 10. 任务 1.6 T10b3 收尾 ui-components 归属（82 → 80）：同上口径，另含两处变形——`tree-component.test.tsx`
 *     去掉宿主副本时代遗留的 `@/src/i18n` 替身（`ui/tree` 只依赖包内 `i18n/namespace`）；
 *     `context-queue.test.ts` 按 owner 拆开，队列一半随宿主副本删除（与包内用例逐字重复）。
 * 11. 任务 1.6 T10b4 把 8 个 agent-config 归属的宿主测试移入包内（80 → 72）：这 8 份此前以
 *     `../../../../packages/resources/agent-config/web/...` 反向读取包内实现，既是跨边界依赖也说明 owner
 *     已明确；`agent-form-dialog-pure-logic.test.ts` 因同时导入宿主 `../api/fs`、`../lib/{api-result,form-utils}`
 *     而不在本片（等 T11 把宿主 `src/{api,lib}` 的剩余模块定归属后再归位）。
 */
const RMD_08_MOVES = [
  ["web/src/App.tsx", "apps/web/src/App.tsx"],
  ["web/src/__tests__/agent-create-enter-flow.test.ts", "apps/web/src/__tests__/agent-create-enter-flow.test.ts"],
  [
    "web/src/__tests__/agent-form-dialog-pure-logic.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts",
  ],
  ["web/src/__tests__/agent-form-dialog-ssr.test.tsx", "apps/web/src/__tests__/agent-form-dialog-ssr.test.tsx"],
  ["web/src/__tests__/agent-home-generation.test.tsx", "apps/web/src/__tests__/agent-home-generation.test.tsx"],
  [
    "web/src/__tests__/agent-sidebar-instance-order.test.ts",
    "apps/web/src/__tests__/agent-sidebar-instance-order.test.ts",
  ],
  ["web/src/__tests__/api-client.test.ts", "apps/web/src/__tests__/api-client.test.ts"],
  ["web/src/__tests__/api-result-utils.test.ts", "apps/web/src/__tests__/api-result-utils.test.ts"],
  ["web/src/__tests__/auth-preference.test.ts", "apps/web/src/__tests__/auth-preference.test.ts"],
  ["web/src/__tests__/config-routing.test.ts", "apps/web/src/__tests__/config-routing.test.ts"],
  ["web/src/__tests__/dark-mode-components.test.tsx", "apps/web/src/__tests__/dark-mode-components.test.tsx"],
  ["web/src/__tests__/folder-upload-batching.test.ts", "apps/web/src/__tests__/folder-upload-batching.test.ts"],
  ["web/src/__tests__/form-utils.test.ts", "apps/web/src/__tests__/form-utils.test.ts"],
  ["web/src/__tests__/fs-upload-url.test.ts", "apps/web/src/__tests__/fs-upload-url.test.ts"],
  ["web/src/__tests__/instances-api.test.ts", "apps/web/src/__tests__/instances-api.test.ts"],
  ["web/src/__tests__/new-session-dialog-form.test.ts", "apps/web/src/__tests__/new-session-dialog-form.test.ts"],
  ["web/src/__tests__/peri-task-details-api.test.ts", "apps/web/src/__tests__/peri-task-details-api.test.ts"],
  ["web/src/__tests__/preview-utils-normalize.test.ts", "apps/web/src/__tests__/preview-utils-normalize.test.ts"],
  [
    "web/src/__tests__/pure-logic-transform-boundaries.test.ts",
    "apps/web/src/__tests__/pure-logic-transform-boundaries.test.ts",
  ],
  ["web/src/__tests__/random-uuid-polyfill.test.ts", "apps/web/src/__tests__/random-uuid-polyfill.test.ts"],
  ["web/src/__tests__/retry.test.ts", "apps/web/src/__tests__/retry.test.ts"],
  ["web/src/__tests__/use-task-views.test.tsx", "apps/web/src/__tests__/use-task-views.test.tsx"],
  ["web/src/__tests__/utils.test.ts", "apps/web/src/__tests__/utils.test.ts"],
  ["web/src/api/fs.ts", "apps/web/src/api/fs.ts"],
  ["web/src/api/instances.ts", "apps/web/src/api/instances.ts"],
  ["web/src/api/peri-task-details.ts", "apps/web/src/api/peri-task-details.ts"],
  ["web/src/components/FilePickerDialog.tsx", "apps/web/src/components/FilePickerDialog.tsx"],
  ["web/src/components/agent-panel/FileTabsBar.tsx", "apps/web/src/components/agent-panel/FileTabsBar.tsx"],
  ["web/src/components/agent-panel/FileTreeTab.tsx", "apps/web/src/components/agent-panel/FileTreeTab.tsx"],
  ["web/src/components/agent-panel/TopModeTabs.tsx", "apps/web/src/components/agent-panel/TopModeTabs.tsx"],
  ["web/src/components/agent-panel/artifacts-dialogs.tsx", "apps/web/src/components/agent-panel/artifacts-dialogs.tsx"],
  [
    "web/src/components/agent-panel/artifacts-files-workspace.tsx",
    "apps/web/src/components/agent-panel/artifacts-files-workspace.tsx",
  ],
  ["web/src/components/agent-panel/preview/utils.ts", "apps/web/src/components/agent-panel/preview/utils.ts"],
  [
    "web/src/components/agent-panel/use-file-tree-events.ts",
    "apps/web/src/components/agent-panel/use-file-tree-events.ts",
  ],
  ["web/src/components/agent-panel/use-file-uploads.ts", "apps/web/src/components/agent-panel/use-file-uploads.ts"],
  ["web/src/hooks/use-task-views.ts", "apps/web/src/hooks/use-task-views.ts"],
  ["web/src/i18n/locales/en/agentHome.json", "apps/web/src/i18n/locales/en/agentHome.json"],
  ["web/src/i18n/locales/en/agentPanel.json", "apps/web/src/i18n/locales/en/agentPanel.json"],
  ["web/src/i18n/locales/en/common.json", "apps/web/src/i18n/locales/en/common.json"],
  ["web/src/i18n/locales/en/components.json", "apps/web/src/i18n/locales/en/components.json"],
  ["web/src/i18n/locales/en/dashboard.json", "apps/web/src/i18n/locales/en/dashboard.json"],
  ["web/src/i18n/locales/en/login.json", "apps/web/src/i18n/locales/en/login.json"],
  ["web/src/i18n/locales/en/sidebar.json", "apps/web/src/i18n/locales/en/sidebar.json"],
  ["web/src/i18n/locales/zh/agentHome.json", "apps/web/src/i18n/locales/zh/agentHome.json"],
  ["web/src/i18n/locales/zh/agentPanel.json", "apps/web/src/i18n/locales/zh/agentPanel.json"],
  ["web/src/i18n/locales/zh/common.json", "apps/web/src/i18n/locales/zh/common.json"],
  ["web/src/i18n/locales/zh/components.json", "apps/web/src/i18n/locales/zh/components.json"],
  ["web/src/i18n/locales/zh/dashboard.json", "apps/web/src/i18n/locales/zh/dashboard.json"],
  ["web/src/i18n/locales/zh/login.json", "apps/web/src/i18n/locales/zh/login.json"],
  ["web/src/i18n/locales/zh/sidebar.json", "apps/web/src/i18n/locales/zh/sidebar.json"],
  ["web/src/lib/api-result.ts", "apps/web/src/lib/api-result.ts"],
  ["web/src/lib/auth-preference.ts", "apps/web/src/lib/auth-preference.ts"],
  ["web/src/lib/form-utils.ts", "apps/web/src/lib/form-utils.ts"],
  ["web/src/lib/password-crypto.ts", "packages/platform/identity/web/lib/password-crypto.ts"],
  ["web/src/lib/retry.ts", "apps/web/src/lib/retry.ts"],
  ["web/src/pages/LoginPage.tsx", "apps/web/src/pages/LoginPage.tsx"],
  ["web/src/pages/agent-panel/AgentPanelLayout.tsx", "apps/web/src/pages/agent-panel/AgentPanelLayout.tsx"],
  ["web/src/pages/agent-panel/AgentSidebar.tsx", "apps/web/src/pages/agent-panel/AgentSidebar.tsx"],
  ["web/src/pages/agent-panel/AgentSidebarConfig.tsx", "apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx"],
  ["web/src/pages/agent-panel/AgentSidebarTree.tsx", "apps/web/src/pages/agent-panel/AgentSidebarTree.tsx"],
  ["web/src/pages/agent-panel/ArtifactsPanel.tsx", "apps/web/src/pages/agent-panel/ArtifactsPanel.tsx"],
  ["web/src/pages/agent-panel/agent-create-navigation.ts", "apps/web/src/pages/agent-panel/agent-create-navigation.ts"],
  ["web/src/pages/agent-panel/agent-panel.css", "apps/web/src/pages/agent-panel/agent-panel.css"],
  ["web/src/pages/agent-panel/artifacts-workspace.css", "apps/web/src/pages/agent-panel/artifacts-workspace.css"],
  [
    "web/src/pages/agent-panel/pages/AgentDashboardPage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentDashboardPage.tsx",
  ],
  ["web/src/pages/agent-panel/pages/AgentHomePage.tsx", "apps/web/src/pages/agent-panel/pages/AgentHomePage.tsx"],
  [
    "web/src/pages/agent-panel/pages/AgentManagementPage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentManagementPage.tsx",
  ],
  [
    "web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx",
    "apps/web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx",
  ],
  ["web/src/types/global.d.ts", "apps/web/src/types/global.d.ts"],
  ["web/src/types/index.ts", "apps/web/src/types/index.ts"],
  ["web/src/vite-env.d.ts", "apps/web/src/vite-env.d.ts"],
  ["web/tsconfig.json", "apps/web/tsconfig.json"],
] as const;

/**
 * 1.3 与 1.6 T4/T8 收口时删掉的宿主副本，三元组为 `[旧根路径, 应用壳路径, 包内 owner 落点]`。
 *
 * 这些文件在 RMD-08 时是「apps/web 的壳」，但键的 owner 与实现的 owner 都属于资源包 / web-runtime：
 * 宿主再留一份就是两份实现并存（i18n 字典尤其危险——命名空间同名时构建期不报错，运行期整片文案回退）。
 * `MetaAgentPanel.tsx` 的宿主副本在被删除前已经零引用（面板实现在 workflow 包内），仍按「宿主不得复活」
 * 断言，避免把一份 workflow 实现重新接回应用壳；`api/registry.ts` 同理由 T4 移出（见文件头第 6 条）。
 * 任务 1.6 T8b 再移出 11 项：`components/ai-elements/**`（7，owner 为 `chat/primitives/**`）与
 * `components/config/**`（4）——这 11 个宿主副本的消费方已全部改指 `@fenix/ui-components` 的对应出口，
 * 副本本身零引用。
 * 任务 1.6 T8c 再移出 11 项：`src/components/**` 的 `PreviewTab`、`file-tree-*`、`file-icon-helper`、
 * `layout/**` 与 `preview/**`——消费方已改指 `@fenix/ui-components` 的 `components/**` 与 `layout/**` 出口。
 * 任务 1.6 T8d 再移出 15 项：`src/{api,hooks,lib}` 的 `request`、两个 hooks 与 12 个 `lib` 模块——
 * owner 分属 `@fenix/web-runtime`（api/hooks/lib/chat）、`@fenix/agent-config`（web/lib）与
 * `@fenix/ui-components`（chat/lib、chat/types）。
 * 任务 1.6 T10b1 再移出 12 项：`src/__tests__/**` 的表格、分页、日期选择器、确认弹窗与 config 纯逻辑
 * 用例——被测实现的 owner 已在 T8b/T8c 归 `@fenix/ui-components`，这些用例的导入图里除标准库外只指向
 * 该包出口，于是用例随实现移入包内，宿主侧不再保留第二份。
 * 任务 1.6 T10b2 再移出 7 项：`request` 与两个 `structured-thread-*`、`todo`、`permission-options`、
 * `artifacts-preview-events`、`config-types` 的宿主用例——全部只引用 `@fenix/web-runtime` 出口（其中
 * `request.test.ts` 未被 RMD-08 快照收录，本片一并归位），owner 是该包的 `web/{api,lib,chat,types}`。
 * 任务 1.6 T10b3 再移出 1 项并拆 1 项：`tree-component.test.tsx` 随 `ui/tree` 的实现迁入 ui-components；
 * `context-queue.test.ts` 同时守护队列（web-runtime）与纯函数（ui-components）两个 owner，按 owner 拆开
 * （队列一半与 web-runtime 包内用例逐字重复，随宿主副本一并删除），拆分归属另立专项断言。
 * 任务 1.6 T10b4 再移出 8 项：`agent-form-dialog-*`（5）与 `agent-resource-picker-interaction`、
 * `agent-node-selector`、`agent-utils` 的宿主用例——被测实现是 agent-config 包的
 * `web/pages/agent-panel/agent-editor/**`，此前只能从宿主以四级相对路径反向读取包内实现，迁入后改为一跳。
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
  ["web/src/api/registry.ts", "apps/web/src/api/registry.ts", "packages/resources/machine/web/api/registry.ts"],
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
  [
    "web/components/ai-elements/chat-message-content.css",
    "apps/web/components/ai-elements/chat-message-content.css",
    "packages/ui-components/web/chat/primitives/chat-message-content.css",
  ],
  [
    "web/components/ai-elements/conversation.tsx",
    "apps/web/components/ai-elements/conversation.tsx",
    "packages/ui-components/web/chat/primitives/conversation.tsx",
  ],
  [
    "web/components/ai-elements/iframe-preview.tsx",
    "apps/web/components/ai-elements/iframe-preview.tsx",
    "packages/ui-components/web/chat/primitives/iframe-preview.tsx",
  ],
  [
    "web/components/ai-elements/message-attachments.tsx",
    "apps/web/components/ai-elements/message-attachments.tsx",
    "packages/ui-components/web/chat/primitives/message-attachments.tsx",
  ],
  [
    "web/components/ai-elements/message.tsx",
    "apps/web/components/ai-elements/message.tsx",
    "packages/ui-components/web/chat/primitives/message.tsx",
  ],
  [
    "web/components/ai-elements/reasoning.tsx",
    "apps/web/components/ai-elements/reasoning.tsx",
    "packages/ui-components/web/chat/primitives/reasoning.tsx",
  ],
  [
    "web/components/ai-elements/shimmer.tsx",
    "apps/web/components/ai-elements/shimmer.tsx",
    "packages/ui-components/web/chat/primitives/shimmer.tsx",
  ],
  [
    "web/components/config/ConfirmDialog.tsx",
    "apps/web/components/config/ConfirmDialog.tsx",
    "packages/ui-components/web/config/ConfirmDialog.tsx",
  ],
  [
    "web/components/config/DataTable.tsx",
    "apps/web/components/config/DataTable.tsx",
    "packages/ui-components/web/config/DataTable.tsx",
  ],
  [
    "web/components/config/FormDialog.tsx",
    "apps/web/components/config/FormDialog.tsx",
    "packages/ui-components/web/config/FormDialog.tsx",
  ],
  [
    "web/components/config/StatusBadge.tsx",
    "apps/web/components/config/StatusBadge.tsx",
    "packages/ui-components/web/config/StatusBadge.tsx",
  ],
  [
    "web/src/components/agent-panel/PreviewTab.tsx",
    "apps/web/src/components/agent-panel/PreviewTab.tsx",
    "packages/ui-components/web/components/PreviewTab.tsx",
  ],
  [
    "web/src/components/agent-panel/file-tree-input-dialog.tsx",
    "apps/web/src/components/agent-panel/file-tree-input-dialog.tsx",
    "packages/ui-components/web/components/file-tree-input-dialog.tsx",
  ],
  [
    "web/src/components/agent-panel/file-tree-model.ts",
    "apps/web/src/components/agent-panel/file-tree-model.ts",
    "packages/ui-components/web/components/file-tree-model.ts",
  ],
  [
    "web/src/components/agent-panel/file-tree-view.tsx",
    "apps/web/src/components/agent-panel/file-tree-view.tsx",
    "packages/ui-components/web/components/file-tree-view.tsx",
  ],
  [
    "web/src/components/file-icon-helper.tsx",
    "apps/web/src/components/file-icon-helper.tsx",
    "packages/ui-components/web/components/file-icon-helper.tsx",
  ],
  [
    "web/src/components/layout/app-header.tsx",
    "apps/web/src/components/layout/app-header.tsx",
    "packages/ui-components/web/layout/app-header.tsx",
  ],
  [
    "web/src/components/layout/app-page.tsx",
    "apps/web/src/components/layout/app-page.tsx",
    "packages/ui-components/web/layout/app-page.tsx",
  ],
  [
    "web/src/components/agent-panel/preview/FileViewerPreview.tsx",
    "apps/web/src/components/agent-panel/preview/FileViewerPreview.tsx",
    "packages/ui-components/web/components/preview/FileViewerPreview.tsx",
  ],
  [
    "web/src/components/agent-panel/preview/html-plugin.ts",
    "apps/web/src/components/agent-panel/preview/html-plugin.ts",
    "packages/ui-components/web/components/preview/html-plugin.ts",
  ],
  [
    "web/src/components/agent-panel/preview/native-pdf-plugin.ts",
    "apps/web/src/components/agent-panel/preview/native-pdf-plugin.ts",
    "packages/ui-components/web/components/preview/native-pdf-plugin.ts",
  ],
  [
    "web/src/components/agent-panel/preview/overrides.css",
    "apps/web/src/components/agent-panel/preview/overrides.css",
    "packages/ui-components/web/components/preview/overrides.css",
  ],
  ["web/src/api/request.ts", "apps/web/src/api/request.ts", "packages/web-runtime/web/api/request.ts"],
  [
    "web/src/hooks/use-changed-files-stats.ts",
    "apps/web/src/hooks/use-changed-files-stats.ts",
    "packages/web-runtime/web/hooks/use-changed-files-stats.ts",
  ],
  [
    "web/src/hooks/usePageVisible.ts",
    "apps/web/src/hooks/usePageVisible.ts",
    "packages/web-runtime/web/hooks/use-page-visible.ts",
  ],
  [
    "web/src/lib/agent-node.ts",
    "apps/web/src/lib/agent-node.ts",
    "packages/resources/agent-config/web/lib/agent-node.ts",
  ],
  [
    "web/src/lib/agent-resource-access.ts",
    "apps/web/src/lib/agent-resource-access.ts",
    "packages/resources/agent-config/web/lib/agent-resource-access.ts",
  ],
  [
    "web/src/lib/agent-utils.ts",
    "apps/web/src/lib/agent-utils.ts",
    "packages/resources/agent-config/web/lib/agent-utils.ts",
  ],
  [
    "web/src/lib/artifacts-preview-events.ts",
    "apps/web/src/lib/artifacts-preview-events.ts",
    "packages/web-runtime/web/lib/artifacts-preview-events.ts",
  ],
  ["web/src/lib/chat-stats.ts", "apps/web/src/lib/chat-stats.ts", "packages/web-runtime/web/lib/chat-stats.ts"],
  [
    "web/src/lib/config-events.ts",
    "apps/web/src/lib/config-events.ts",
    "packages/web-runtime/web/lib/config-events.ts",
  ],
  [
    "web/src/lib/extract-changed-files.ts",
    "apps/web/src/lib/extract-changed-files.ts",
    "packages/ui-components/web/chat/lib/extract-changed-files.ts",
  ],
  [
    "web/src/lib/strip-html-tags.ts",
    "apps/web/src/lib/strip-html-tags.ts",
    "packages/ui-components/web/chat/lib/strip-html-tags.ts",
  ],
  [
    "web/src/lib/structured-to-thread.ts",
    "apps/web/src/lib/structured-to-thread.ts",
    "packages/web-runtime/web/chat/structured-to-thread.ts",
  ],
  ["web/src/lib/todo.ts", "apps/web/src/lib/todo.ts", "packages/web-runtime/web/chat/todo.ts"],
  [
    "web/src/lib/tool-semantic.ts",
    "apps/web/src/lib/tool-semantic.ts",
    "packages/ui-components/web/chat/lib/tool-semantic.ts",
  ],
  ["web/src/lib/types.ts", "apps/web/src/lib/types.ts", "packages/ui-components/web/chat/types.ts"],
  [
    "web/src/i18n/locales/en/settings.json",
    "apps/web/src/i18n/locales/en/settings.json",
    "packages/platform/identity/web/i18n/locales/en/settings.json",
  ],
  [
    "web/src/i18n/locales/zh/settings.json",
    "apps/web/src/i18n/locales/zh/settings.json",
    "packages/platform/identity/web/i18n/locales/zh/settings.json",
  ],
  [
    "web/src/__tests__/config-datatable.test.ts",
    "apps/web/src/__tests__/config-datatable.test.ts",
    "packages/ui-components/web/__tests__/config-datatable.test.ts",
  ],
  [
    "web/src/__tests__/config-helpers.test.ts",
    "apps/web/src/__tests__/config-helpers.test.ts",
    "packages/ui-components/web/__tests__/config-helpers.test.ts",
  ],
  [
    "web/src/__tests__/confirm-dialog.test.tsx",
    "apps/web/src/__tests__/confirm-dialog.test.tsx",
    "packages/ui-components/web/__tests__/confirm-dialog.test.tsx",
  ],
  [
    "web/src/__tests__/data-table-round41-pure.test.tsx",
    "apps/web/src/__tests__/data-table-round41-pure.test.tsx",
    "packages/ui-components/web/__tests__/data-table-round41-pure.test.tsx",
  ],
  [
    "web/src/__tests__/data-table-ssr.test.tsx",
    "apps/web/src/__tests__/data-table-ssr.test.tsx",
    "packages/ui-components/web/__tests__/data-table-ssr.test.tsx",
  ],
  [
    "web/src/__tests__/date-picker.test.tsx",
    "apps/web/src/__tests__/date-picker.test.tsx",
    "packages/ui-components/web/__tests__/date-picker.test.tsx",
  ],
  [
    "web/src/__tests__/extract-changed-files-boundaries.test.ts",
    "apps/web/src/__tests__/extract-changed-files-boundaries.test.ts",
    "packages/ui-components/web/__tests__/extract-changed-files-boundaries.test.ts",
  ],
  [
    "web/src/__tests__/extract-changed-files.test.ts",
    "apps/web/src/__tests__/extract-changed-files.test.ts",
    "packages/ui-components/web/__tests__/extract-changed-files.test.ts",
  ],
  [
    "web/src/__tests__/message-additional-ssr.test.tsx",
    "apps/web/src/__tests__/message-additional-ssr.test.tsx",
    "packages/ui-components/web/__tests__/message-additional-ssr.test.tsx",
  ],
  [
    "web/src/__tests__/pagination.test.tsx",
    "apps/web/src/__tests__/pagination.test.tsx",
    "packages/ui-components/web/__tests__/pagination.test.tsx",
  ],
  [
    "web/src/__tests__/params-editor-round42-pure.test.tsx",
    "apps/web/src/__tests__/params-editor-round42-pure.test.tsx",
    "packages/ui-components/web/__tests__/params-editor-round42-pure.test.tsx",
  ],
  [
    "web/src/__tests__/strip-html-tags.test.ts",
    "apps/web/src/__tests__/strip-html-tags.test.ts",
    "packages/ui-components/web/__tests__/strip-html-tags.test.ts",
  ],
  [
    "web/src/__tests__/artifacts-preview-events.test.ts",
    "apps/web/src/__tests__/artifacts-preview-events.test.ts",
    "packages/web-runtime/web/__tests__/artifacts-preview-events.test.ts",
  ],
  [
    "web/src/__tests__/config-types.test.ts",
    "apps/web/src/__tests__/config-types.test.ts",
    "packages/web-runtime/web/__tests__/config-types.test.ts",
  ],
  [
    "web/src/__tests__/permission-options.test.ts",
    "apps/web/src/__tests__/permission-options.test.ts",
    "packages/web-runtime/web/__tests__/permission-options.test.ts",
  ],
  [
    "web/src/__tests__/request.test.ts",
    "apps/web/src/__tests__/request.test.ts",
    "packages/web-runtime/web/__tests__/request.test.ts",
  ],
  [
    "web/src/__tests__/structured-thread-additional.test.ts",
    "apps/web/src/__tests__/structured-thread-additional.test.ts",
    "packages/web-runtime/web/__tests__/structured-thread-additional.test.ts",
  ],
  [
    "web/src/__tests__/structured-thread-boundaries.test.ts",
    "apps/web/src/__tests__/structured-thread-boundaries.test.ts",
    "packages/web-runtime/web/__tests__/structured-thread-boundaries.test.ts",
  ],
  [
    "web/src/__tests__/todo.test.ts",
    "apps/web/src/__tests__/todo.test.ts",
    "packages/web-runtime/web/__tests__/todo.test.ts",
  ],
  [
    "web/src/__tests__/tree-component.test.tsx",
    "apps/web/src/__tests__/tree-component.test.tsx",
    "packages/ui-components/web/__tests__/tree-component.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-editor-guards.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-editor-guards.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-editor-guards.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-options-boundaries.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-round54-pure.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-round54-pure.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-round54-pure.test.ts",
  ],
  [
    "web/src/__tests__/agent-node-selector.test.ts",
    "apps/web/src/__tests__/agent-node-selector.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-node-selector.test.ts",
  ],
  [
    "web/src/__tests__/agent-resource-picker-interaction.test.tsx",
    "apps/web/src/__tests__/agent-resource-picker-interaction.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-resource-picker-interaction.test.tsx",
  ],
  [
    "web/src/__tests__/agent-utils.test.ts",
    "apps/web/src/__tests__/agent-utils.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-utils.test.ts",
  ],
] as const;

describe("RMD-08 apps/web migration", () => {
  // 100 个保留的应用壳源文件都必须从旧根路径移除，并保留在唯一的 owner 目标。
  // 任务 1.3 收口移出的一项：`__tests__/task-form-schema.test.ts` 是内联的表单校验 schema 副本，宿主侧
  // 既无 TaskForm 组件也无导入方，且已与包内唯一 owner 漂移；owner 是 task 包，见下方 relocated 断言。
  // 任务 1.6 T2 再移出 18 项零消费文件，见文件头第 5 条；T4 又移出 1 项（`api/registry.ts`，
  // 见文件头第 6 条），153 → 152；T8b 再移出 11 项，152 → 141；T8c 再移出 11 项，141 → 130；
  // T8d 再移出 15 项（改指包出口）并直删 5 项零消费文件（`context-queue` 宿主副本、`token-stats`、
  // `citation-preview-context`、两份第三方类型垫片——垫片归各包自持，见 §1.6 T8z），130 → 111；
  // T9a 把宿主 `settings.json` 两份交给 identity 包（唯一消费方是包内的 `ChangePasswordDialog`），
  // 111 → 109——i18n 归属重划：键的物理落点必须等于 owner；T9c 直删 8 份零绑定字典与 1 项自指测试
  // （见文件头第 7 条），109 → 100；T10b1 把 12 个 ui-components 归属的宿主测试移入包内（见文件头第 8 条），
  // 100 → 88；T10b2 把 7 个 web-runtime 归属的宿主测试移入包内（见文件头第 9 条），88 → 82；
  // T10b3 又移出 2 项（见文件头第 10 条），82 → 80；T10b4 把 8 个 agent-config 归属的宿主测试移入包内
  // （见文件头第 11 条），80 → 72。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_08_MOVES).toHaveLength(72);
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

  // 自指 i18n 测试随其守护的字典一同退役：`toolNarrator` 字典在 T9c 整份删除（无任何命名空间绑定），
  // 旧根路径与应用壳路径都不得复活，否则等于凭空恢复一份死字典的守护测试。
  test("keeps the self-referential narrator i18n test deleted", () => {
    expect(existsSync("web/src/__tests__/narrators-i18n.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/narrators-i18n.test.ts")).toBe(false);
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

  // 任务 1.3 收口的 9 份 + 任务 1.6 T4 的 1 份 + T8b 的 11 份 + T8c 的 11 份 + T8d 的 15 份 + T9a 的 2 份
  // + T10b1 的 12 份 + T10b2 的 7 份 + T10b3 的 1 份 + T10b4 的 8 份宿主副本：
  // 旧根路径与应用壳路径都不得复活，
  // 且包侧 owner 落点必须存在。副本与 owner 并存是「两份实现各自能跑」的最坏形态，
  // 删除与断言必须成对出现。
  test("relocates the leftover host copies to their package owners", () => {
    expect(RMD_08_RELOCATED).toHaveLength(77);
    for (const [legacy, shell, owner] of RMD_08_RELOCATED) {
      expect(existsSync(legacy), `legacy source still exists: ${legacy}`).toBe(false);
      expect(existsSync(shell), `host copy still exists: ${shell}`).toBe(false);
      expect(existsSync(owner), `package owner is missing: ${owner}`).toBe(true);
    }
  });
  // 拆分归属的用例无法用 relocated 三元组表达：`context-queue` 的宿主副本连同「队列状态」一半一并删除
  // （那一半与该包 `web/__tests__/context-queue.test.ts` 逐字重复），纯函数一半移入 ui-components。断言
  // 覆盖三件事：旧的根路径与宿主副本都不得复活，两个 owner 侧的用例都必须存在。
  test("splits the host context queue test between its two package owners", () => {
    expect(existsSync("web/src/__tests__/context-queue.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/context-queue.test.ts")).toBe(false);
    expect(existsSync("packages/web-runtime/web/__tests__/context-queue.test.ts")).toBe(true);
    expect(existsSync("packages/ui-components/web/__tests__/context-queue.test.ts")).toBe(true);
  });
});
