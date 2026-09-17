# 根目录源码最终归属清单

此文件由 `bun run scripts/check-root-source-owner-inventory.ts --markdown > docs/arch/root-source-owner-inventory.md` 生成。请修改规则后重新生成，不要手工编辑。

## 审计结果

- 文件总数：472
- 未归属：0
- 歧义：0
- 不安全删除：0

## 按任务和 owner 汇总

| 任务 | Owner | 文件数 |
| --- | --- | ---: |
| RMD-09 | delete | 472 |

RMD-01、RMD-02、RMD-03、RMD-04、RMD-05、RMD-06、RMD-07、RMD-08、RMD-09 按上表顺序执行。`delete` 仅允许 `src/.DS_Store` 与 `web/dist/` 下的构建产物。

## 完整规则

| Prefix | Target prefix | Owner | 任务 |
| --- | --- | --- | --- |
| `src/.DS_Store` | 删除 | delete | RMD-09 |
| `web/dist/` | 删除 | delete | RMD-09 |
| `src/routes/acp/` | packages/agent-runtime/src/routes/acp/ | agent-runtime | RMD-01 |
| `src/routes/api/openai-chat.ts` | packages/agent-runtime/src/routes/api/openai-chat.ts | agent-runtime | RMD-01 |
| `src/routes/api/instances.ts` | packages/agent-runtime/src/routes/api/instances.ts | agent-runtime | RMD-01 |
| `src/services/acp-` | packages/agent-runtime/src/services/acp- | agent-runtime | RMD-01 |
| `src/services/agent-chat-service.ts` | packages/agent-runtime/src/services/agent-chat-service.ts | agent-runtime | RMD-01 |
| `src/services/agent-concurrency.ts` | packages/agent-runtime/src/services/agent-concurrency.ts | agent-runtime | RMD-01 |
| `src/services/environment` | packages/agent-runtime/src/services/environment | agent-runtime | RMD-01 |
| `src/services/instance-` | packages/agent-runtime/src/services/instance- | agent-runtime | RMD-01 |
| `src/services/orchestration-` | packages/agent-runtime/src/services/orchestration- | agent-runtime | RMD-01 |
| `src/services/session.ts` | packages/agent-runtime/src/services/session.ts | agent-runtime | RMD-01 |
| `src/services/launch-spec-builder.ts` | packages/agent-runtime/src/services/launch-spec-builder.ts | agent-runtime | RMD-01 |
| `src/transport/agent-node-bridge.ts` | packages/agent-runtime/src/transport/agent-node-bridge.ts | agent-runtime | RMD-01 |
| `src/transport/event-bus.ts` | packages/agent-runtime/src/transport/event-bus.ts | agent-runtime | RMD-01 |
| `src/schemas/acp.schema.ts` | packages/agent-runtime/src/schemas/acp.schema.ts | agent-runtime | RMD-01 |
| `src/schemas/environment.schema.ts` | packages/agent-runtime/src/schemas/environment.schema.ts | agent-runtime | RMD-01 |
| `src/schemas/instance.schema.ts` | packages/agent-runtime/src/schemas/instance.schema.ts | agent-runtime | RMD-01 |
| `src/schemas/openai-chat.schema.ts` | packages/agent-runtime/src/schemas/openai-chat.schema.ts | agent-runtime | RMD-01 |
| `src/services/chat-channel-error-classify.ts` | packages/chat-channel/src/services/chat-channel-error-classify.ts | chat-channel | RMD-01 |
| `src/services/doc-manager-instance.ts` | packages/chat-channel/src/services/doc-manager-instance.ts | chat-channel | RMD-01 |
| `src/routes/api/workspaces.ts` | packages/resources/machine/src/routes/api/workspaces.ts | resource-machine | RMD-02 |
| `src/routes/web/fs.ts` | packages/resources/machine/src/routes/web/fs.ts | resource-machine | RMD-02 |
| `src/routes/web/registry.ts` | packages/resources/machine/src/routes/web/registry.ts | resource-machine | RMD-02 |
| `src/routes/web/file-events.ts` | packages/resources/machine/src/routes/web/file-events.ts | resource-machine | RMD-02 |
| `src/schemas/file` | packages/resources/machine/src/schemas/file | resource-machine | RMD-02 |
| `src/schemas/registry.schema.ts` | packages/resources/machine/src/schemas/registry.schema.ts | resource-machine | RMD-02 |
| `src/services/local-node-service.ts` | packages/resources/machine/src/services/local-node-service.ts | resource-machine | RMD-02 |
| `src/services/event-service.ts` | packages/resources/machine/src/services/event-service.ts | resource-machine | RMD-02 |
| `src/routes/api/sandbox` | packages/resources/sandbox/src/routes/api/sandbox | resource-sandbox | RMD-03 |
| `web/src/api/sandbox-pools.ts` | packages/resources/sandbox/web/src/api/sandbox-pools.ts | resource-sandbox | RMD-03 |
| `web/src/api/system-sandbox.ts` | packages/resources/sandbox/web/src/api/system-sandbox.ts | resource-sandbox | RMD-03 |
| `web/src/pages/admin/` | packages/resources/sandbox/web/src/pages/admin/ | resource-sandbox | RMD-03 |
| `src/routes/api/models.ts` | packages/resources/model-management/src/routes/api/models.ts | model-management | RMD-04 |
| `src/routes/web/config/models.ts` | packages/resources/model-management/src/routes/web/config/models.ts | model-management | RMD-04 |
| `src/services/peri-task-` | packages/resources/model-management/src/services/peri-task- | model-management | RMD-04 |
| `web/src/pages/agent-panel/pages/Algorithm` | packages/resources/model-management/web/src/pages/agent-panel/pages/Algorithm | model-management | RMD-04 |
| `web/src/pages/agent-panel/components/Embedding` | packages/resources/model-management/web/src/pages/agent-panel/components/Embedding | model-management | RMD-04 |
| `src/services/meta-agent.ts` | packages/resources/agent-config/src/services/meta-agent.ts | agent-config | RMD-04 |
| `src/schemas/meta-agent.schema.ts` | packages/resources/agent-config/src/schemas/meta-agent.schema.ts | agent-config | RMD-04 |
| `src/routes/web/sidebar-config.ts` | packages/resources/agent-config/src/routes/web/sidebar-config.ts | agent-config | RMD-04 |
| `src/services/sidebar-config.ts` | packages/resources/agent-config/src/services/sidebar-config.ts | agent-config | RMD-04 |
| `web/src/api/meta-agent.ts` | packages/resources/agent-config/web/src/api/meta-agent.ts | agent-config | RMD-04 |
| `web/src/api/sidebar-config.ts` | packages/resources/agent-config/web/src/api/sidebar-config.ts | agent-config | RMD-04 |
| `web/src/pages/agent-panel/components/Chunk` | packages/resources/knowledge/web/src/pages/agent-panel/components/Chunk | resource-knowledge | RMD-05 |
| `web/src/pages/agent-panel/components/Retrieval` | packages/resources/knowledge/web/src/pages/agent-panel/components/Retrieval | resource-knowledge | RMD-05 |
| `web/components/ChatInterface.tsx` | packages/chat-channel/web/components/ChatInterface.tsx | chat-channel | RMD-01 |
| `web/components/ACPMain.tsx` | packages/chat-channel/web/components/ACPMain.tsx | chat-channel | RMD-01 |
| `web/components/ContextPanel.tsx` | packages/chat-channel/web/components/ContextPanel.tsx | chat-channel | RMD-01 |
| `web/src/pages/agent-panel/ChatArea.tsx` | packages/chat-channel/web/src/pages/agent-panel/ChatArea.tsx | chat-channel | RMD-01 |
| `web/src/pages/agent-panel/chat-design-` | packages/chat-channel/web/src/pages/agent-panel/chat-design- | chat-channel | RMD-01 |
| `web/src/pages/agent-panel/chat-layout.css` | packages/chat-channel/web/src/pages/agent-panel/chat-layout.css | chat-channel | RMD-01 |
| `web/src/pages/agent-panel/chat-design.css` | packages/chat-channel/web/src/pages/agent-panel/chat-design.css | chat-channel | RMD-01 |
| `web/src/components/agent-panel/SiteFrame.tsx` | packages/resources/agent-config/web/components/agent-panel/SiteFrame.tsx | agent-config | RMD-05 |
| `web/src/components/agent-panel/SiteTabsBar.tsx` | packages/resources/agent-config/web/components/agent-panel/SiteTabsBar.tsx | agent-config | RMD-05 |
| `src/repositories/resource-permission.ts` | packages/platform/access-control/src/repositories/resource-permission.ts | platform-access-control | RMD-06 |
| `src/schemas/resource-access.schema.ts` | packages/platform/access-control/src/schemas/resource-access.schema.ts | platform-access-control | RMD-06 |
| `src/routes/web/control.ts` | packages/resources/identity-admin/src/routes/web/control.ts | identity-admin | RMD-06 |
| `src/repositories/share-link.ts` | packages/resources/identity-admin/src/repositories/share-link.ts | identity-admin | RMD-06 |
| `src/repositories/token.ts` | packages/resources/identity-admin/src/repositories/token.ts | identity-admin | RMD-06 |
| `src/repositories/user.ts` | packages/resources/identity-admin/src/repositories/user.ts | identity-admin | RMD-06 |
| `web/components/ChangePasswordDialog.tsx` | packages/resources/identity-admin/web/components/ChangePasswordDialog.tsx | identity-admin | RMD-06 |
| `src/__tests__/acp-` | packages/agent-runtime/src/__tests__/acp- | agent-runtime | RMD-01 |
| `src/__tests__/agent-chat-` | packages/agent-runtime/src/__tests__/agent-chat- | agent-runtime | RMD-01 |
| `src/__tests__/agent-concurrency` | packages/agent-runtime/src/__tests__/agent-concurrency | agent-runtime | RMD-01 |
| `src/__tests__/agent-node-` | packages/agent-runtime/src/__tests__/agent-node- | agent-runtime | RMD-01 |
| `src/__tests__/api-instance-` | packages/agent-runtime/src/__tests__/api-instance- | agent-runtime | RMD-01 |
| `src/__tests__/environment-` | packages/agent-runtime/src/__tests__/environment- | agent-runtime | RMD-01 |
| `src/__tests__/instance-` | packages/agent-runtime/src/__tests__/instance- | agent-runtime | RMD-01 |
| `src/__tests__/launch-spec-` | packages/agent-runtime/src/__tests__/launch-spec- | agent-runtime | RMD-01 |
| `src/__tests__/openai-chat` | packages/agent-runtime/src/__tests__/openai-chat | agent-runtime | RMD-01 |
| `src/__tests__/openai-response` | packages/agent-runtime/src/__tests__/openai-response | agent-runtime | RMD-01 |
| `src/__tests__/orchestration-` | packages/agent-runtime/src/__tests__/orchestration- | agent-runtime | RMD-01 |
| `src/__tests__/session-` | packages/agent-runtime/src/__tests__/session- | agent-runtime | RMD-01 |
| `src/__tests__/transport-` | packages/agent-runtime/src/__tests__/transport- | agent-runtime | RMD-01 |
| `src/__tests__/external-relay` | packages/agent-runtime/src/__tests__/external-relay | agent-runtime | RMD-01 |
| `src/__tests__/event-bus` | packages/agent-runtime/src/__tests__/event-bus | agent-runtime | RMD-01 |
| `src/__tests__/doc-manager` | packages/chat-channel/src/__tests__/doc-manager | chat-channel | RMD-01 |
| `src/__tests__/api-agent-schema` | packages/resources/agent-config/src/__tests__/api-agent-schema | agent-config | RMD-04 |
| `src/__tests__/sidebar-config-service` | packages/resources/agent-config/src/__tests__/sidebar-config-service | agent-config | RMD-04 |
| `src/__tests__/web-sidebar-config-routes` | packages/resources/agent-config/src/__tests__/web-sidebar-config-routes | agent-config | RMD-04 |
| `src/__tests__/api-sandbox-schema` | packages/resources/sandbox/src/__tests__/api-sandbox-schema | resource-sandbox | RMD-03 |
| `src/__tests__/api-sandbox-server` | packages/resources/sandbox/src/__tests__/api-sandbox-server | resource-sandbox | RMD-03 |
| `src/__tests__/fs-upload-escape` | packages/resources/machine/src/__tests__/fs-upload-escape | resource-machine | RMD-02 |
| `src/__tests__/registry-filews-cleanup` | packages/resources/machine/src/__tests__/registry-filews-cleanup | resource-machine | RMD-02 |
| `src/__tests__/registry-machine-stages` | packages/resources/machine/src/__tests__/registry-machine-stages | resource-machine | RMD-02 |
| `src/__tests__/registry-routes-isolation` | packages/resources/machine/src/__tests__/registry-routes-isolation | resource-machine | RMD-02 |
| `src/__tests__/registry-routes` | packages/resources/machine/src/__tests__/registry-routes | resource-machine | RMD-02 |
| `src/__tests__/registry-schema` | packages/resources/machine/src/__tests__/registry-schema | resource-machine | RMD-02 |
| `src/__tests__/round19-registry-service-boundaries` | packages/resources/machine/src/__tests__/round19-registry-service-boundaries | resource-machine | RMD-02 |
| `src/__tests__/round36-registry-service-coverage` | packages/resources/machine/src/__tests__/round36-registry-service-coverage | resource-machine | RMD-02 |
| `src/__tests__/round39-registry-service` | packages/resources/machine/src/__tests__/round39-registry-service | resource-machine | RMD-02 |
| `src/__tests__/round68-registry-heartbeat` | packages/resources/machine/src/__tests__/round68-registry-heartbeat | resource-machine | RMD-02 |
| `src/__tests__/instances-delete-idempotent` | packages/agent-runtime/src/__tests__/instances-delete-idempotent | agent-runtime | RMD-01 |
| `src/__tests__/local-instance-death-cleanup` | packages/agent-runtime/src/__tests__/local-instance-death-cleanup | agent-runtime | RMD-01 |
| `src/__tests__/registry-environment-isolation-coverage` | packages/agent-runtime/src/__tests__/registry-environment-isolation-coverage | agent-runtime | RMD-01 |
| `src/__tests__/yjs-frontend-snapshot-persist` | packages/agent-runtime/src/__tests__/yjs-frontend-snapshot-persist | agent-runtime | RMD-01 |
| `src/__tests__/chat-channel-` | packages/chat-channel/src/__tests__/chat-channel- | chat-channel | RMD-01 |
| `src/__tests__/extract-acp-event` | packages/agent-runtime/src/__tests__/extract-acp-event | agent-runtime | RMD-01 |
| `src/__tests__/round43-launch-spec-builder` | packages/agent-runtime/src/__tests__/round43-launch-spec-builder | agent-runtime | RMD-01 |
| `src/__tests__/round44-environments-routes` | packages/agent-runtime/src/__tests__/round44-environments-routes | agent-runtime | RMD-01 |
| `src/__tests__/round44-launch-spec-builder-config` | packages/agent-runtime/src/__tests__/round44-launch-spec-builder-config | agent-runtime | RMD-01 |
| `src/__tests__/round45-environment-acp` | packages/agent-runtime/src/__tests__/round45-environment-acp | agent-runtime | RMD-01 |
| `src/__tests__/machine-cleanup-node-dispatch` | packages/agent-runtime/src/__tests__/machine-cleanup-node-dispatch | agent-runtime | RMD-01 |
| `src/__tests__/fs-symlink-escape` | packages/resources/machine/src/__tests__/fs-symlink-escape | resource-machine | RMD-02 |
| `src/__tests__/local-node-service` | packages/resources/machine/src/__tests__/local-node-service | resource-machine | RMD-02 |
| `src/__tests__/registry-service` | packages/resources/machine/src/__tests__/registry-service | resource-machine | RMD-02 |
| `src/__tests__/machine-` | packages/resources/machine/src/__tests__/machine- | resource-machine | RMD-02 |
| `src/__tests__/sandbox-` | packages/resources/sandbox/src/__tests__/sandbox- | resource-sandbox | RMD-03 |
| `src/__tests__/model-gateway-` | packages/resources/model-management/src/__tests__/model-gateway- | model-management | RMD-04 |
| `src/__tests__/meta-agent` | packages/resources/agent-config/src/__tests__/meta-agent | agent-config | RMD-04 |
| `src/__tests__/resource-permission` | packages/platform/access-control/src/__tests__/resource-permission | platform-access-control | RMD-06 |
| `src/__tests__/round23-resource-permission-isolation` | packages/platform/access-control/src/__tests__/round23-resource-permission-isolation | platform-access-control | RMD-06 |
| `src/__tests__/round64-resource-permission-repository` | packages/platform/access-control/src/__tests__/round64-resource-permission-repository | platform-access-control | RMD-06 |
| `src/__tests__/` | apps/server/src/__tests__/ | apps-server | RMD-07 |
| `src/errors/` | apps/server/src/errors/ | apps-server | RMD-07 |
| `src/repositories/` | apps/server/src/repositories/ | apps-server | RMD-07 |
| `src/routes/api/` | apps/server/src/routes/api/ | apps-server | RMD-07 |
| `src/routes/web/` | apps/server/src/routes/web/ | apps-server | RMD-07 |
| `src/routes/hooks.ts` | apps/server/src/routes/hooks.ts | apps-server | RMD-07 |
| `src/schemas/` | apps/server/src/schemas/ | apps-server | RMD-07 |
| `src/services/` | apps/server/src/services/ | apps-server | RMD-07 |
| `src/transport/` | apps/server/src/transport/ | apps-server | RMD-07 |
| `src/types/` | apps/server/src/types/ | apps-server | RMD-07 |
| `src/utils/` | apps/server/src/utils/ | apps-server | RMD-07 |
| `src/main.ts` | apps/server/src/main.ts | apps-server | RMD-07 |
| `web/components/` | apps/web/components/ | apps-web | RMD-08 |
| `web/src/__tests__/chat-` | packages/chat-channel/web/src/__tests__/chat- | chat-channel | RMD-01 |
| `web/src/__tests__/acp-main-session-recovery` | packages/chat-channel/web/src/__tests__/acp-main-session-recovery | chat-channel | RMD-01 |
| `web/src/__tests__/message.ssr` | packages/agent-runtime/web/src/__tests__/message.ssr | agent-runtime | RMD-01 |
| `web/src/__tests__/tool-semantic` | packages/agent-runtime/web/src/__tests__/tool-semantic | agent-runtime | RMD-01 |
| `web/src/__tests__/structured-to-thread` | packages/chat-channel/web/src/__tests__/structured-to-thread | chat-channel | RMD-01 |
| `web/src/__tests__/file-` | packages/resources/machine/web/src/__tests__/file- | resource-machine | RMD-02 |
| `web/src/__tests__/agent-editor-model` | packages/resources/model-management/web/src/__tests__/agent-editor-model | model-management | RMD-04 |
| `web/src/__tests__/agent-sidebar-config` | packages/resources/agent-config/web/src/__tests__/agent-sidebar-config | agent-config | RMD-04 |
| `web/src/__tests__/context-panel` | packages/resources/knowledge/web/src/__tests__/context-panel | resource-knowledge | RMD-05 |
| `web/src/__tests__/token-` | packages/resources/identity-admin/web/src/__tests__/token- | identity-admin | RMD-06 |
| `web/src/__tests__/` | apps/web/src/__tests__/ | apps-web | RMD-08 |
| `web/src/api/` | apps/web/src/api/ | apps-web | RMD-08 |
| `web/src/components/` | apps/web/src/components/ | apps-web | RMD-08 |
| `web/src/hooks/` | apps/web/src/hooks/ | apps-web | RMD-08 |
| `web/src/i18n/` | apps/web/src/i18n/ | apps-web | RMD-08 |
| `web/src/lib/` | apps/web/src/lib/ | apps-web | RMD-08 |
| `web/src/pages/agent-panel/` | apps/web/src/pages/agent-panel/ | apps-web | RMD-08 |
| `web/src/pages/` | apps/web/src/pages/ | apps-web | RMD-08 |
| `web/src/types/` | apps/web/src/types/ | apps-web | RMD-08 |
| `web/src/App.tsx` | apps/web/src/App.tsx | apps-web | RMD-08 |
| `web/src/vite-env.d.ts` | apps/web/src/vite-env.d.ts | apps-web | RMD-08 |
| `web/tsconfig.json` | apps/web/tsconfig.json | apps-web | RMD-08 |

## 逐文件映射

| 原路径 | 明确目标路径 | Owner | 主要消费者 | 测试目标 | RMD 批次 |
| --- | --- | --- | --- | --- | --- |
| `src/.DS_Store` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/admin-key-BIu3CCSz.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/admin-key-BIu3CCSz.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminLogsPage-DrP3_wSe.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminLogsPage-DrP3_wSe.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminModelGatewayPage-CLayJSsd.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminModelGatewayPage-CLayJSsd.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminObserverPage-DBN_WQuM.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminObserverPage-DBN_WQuM.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminPeoplePage-CaG27BF2.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminPeoplePage-CaG27BF2.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminSandboxPage-Dlm0y-I5.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AdminSandboxPage-Dlm0y-I5.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/agent-panel-BfBVPaU_.css` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentApiKeysPage-DtNhScRy.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentApiKeysPage-DtNhScRy.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentBadge-GW5AWmlm.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentBadge-GW5AWmlm.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentCardList-BvK69yFj.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentCardList-BvK69yFj.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentChannelsPage-CkwtrYua.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentChannelsPage-CkwtrYua.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentDashboardPage-BK8YZAR0.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentDashboardPage-BK8YZAR0.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentFormDialog-mYXly8gW.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentFormDialog-mYXly8gW.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentHomePage-VXddeKXp.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentHomePage-VXddeKXp.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentKnowledgeBasesPage-CIvLS1Mm.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentKnowledgeBasesPage-CIvLS1Mm.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentManagementPage-CGsCJyJ3.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentManagementPage-CGsCJyJ3.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentMcpPage-ayljZgw5.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentMcpPage-ayljZgw5.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentModelsPage-DeDWmFsV.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentModelsPage-DeDWmFsV.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentOrganizationsPage-RmO9x6cB.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentOrganizationsPage-RmO9x6cB.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentPageHeader-B6kHax0f.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentPageHeader-B6kHax0f.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentPanelLayout-D8X0ik5f.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentPanelLayout-D8X0ik5f.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentProdViewsPage-7xzQNM-v.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentProdViewsPage-7xzQNM-v.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/agents-CLgxQ7ps.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/agents-CLgxQ7ps.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentSitesPage-DR2OWbCA.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentSitesPage-DR2OWbCA.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentSkillsPage-Ho8lcr_e.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentSkillsPage-Ho8lcr_e.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentTasksPage-CY6_27jy.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AgentTasksPage-CY6_27jy.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/aiden0z-pptx-renderer.es-DwfEfIVf.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/aiden0z-pptx-renderer.es-DwfEfIVf.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/alert-dialog-DtvbHuPJ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/alert-dialog-DtvbHuPJ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AlgorithmsPage-Ck8R1bQ-.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/AlgorithmsPage-Ck8R1bQ-.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/arrow-left-Bzipl3Jv.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/arrow-left-Bzipl3Jv.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/arrow-right-DS-4Wbz5.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/arrow-right-DS-4Wbz5.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ArtifactsPanel-CRxQOS7I.css` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ArtifactsPanel-DV-RIx9d.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ArtifactsPanel-DV-RIx9d.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/auth-client-Ya23AdRv.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/auth-client-Ya23AdRv.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/badge-Dti7B8uB.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/badge-Dti7B8uB.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/book-open-s-pX1wVC.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/book-open-s-pX1wVC.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/bot-StabeaLu.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/bot-StabeaLu.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/boxes-UiEWi0Re.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/boxes-UiEWi0Re.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/brain-B9zz3e5O.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/brain-B9zz3e5O.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/building-2-Fp8j01Ip.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/building-2-Fp8j01Ip.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/bundle-mjs-B_AA55HL.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/bundle-mjs-B_AA55HL.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/button-DncOrx_g.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/button-DncOrx_g.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/calendar-DrjFHsLn.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/calendar-DrjFHsLn.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/card-Cr_HNqd3.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/card-Cr_HNqd3.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/card-renderer-DCptazgb.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/card-renderer-DCptazgb.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ChatArea-Cg7mcNst.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ChatArea-DS5eVp9z.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ChatArea-DS5eVp9z.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ChatPanel-BYZTFntp.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ChatPanel-BYZTFntp.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ChatPanel-DdsaS6yU.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/check-Bxx-97Ql.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/check-Bxx-97Ql.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/checkbox-D6RKl0kc.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/checkbox-D6RKl0kc.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-down-CXgOl9uV.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-down-CXgOl9uV.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-left-CinhXnsh.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-left-CinhXnsh.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-right-BHlwiREx.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-right-BHlwiREx.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-up-BOwma3vO.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevron-up-BOwma3vO.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevrons-up-down-kmvwBYdT.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chevrons-up-down-kmvwBYdT.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chunk-BO2N2NFS-D3tCruOW.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/chunk-BO2N2NFS-D3tCruOW.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/circle-alert-Co2cspxY.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/circle-alert-Co2cspxY.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/circle-check-big-DikJiNIs.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/circle-check-big-DikJiNIs.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/circle-x-VAurJVDh.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/circle-x-VAurJVDh.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/clock-_lAO_eCt.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/clock-_lAO_eCt.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/collapsible-DNGzBYaS.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/collapsible-DNGzBYaS.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/command-eoo4_-LM.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/command-eoo4_-LM.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/config-events-78toy3_6.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/config-events-78toy3_6.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ConfirmDialog-hjXkRsSX.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ConfirmDialog-hjXkRsSX.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/context-queue-DG7NodPA.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/context-queue-kzxpM9Jg.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/context-queue-kzxpM9Jg.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/copy-D3d31QqH.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/copy-D3d31QqH.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/createLucideIcon-CM6Y4aVo.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/createLucideIcon-CM6Y4aVo.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/CronEditor-jPLVfx1w.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/CronEditor-jPLVfx1w.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dialog-BVkrlthT.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dialog-BVkrlthT.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dist-D-AmENxm.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dist-D-AmENxm.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dist-DiSvoLYw.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dist-u-2P-92t.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dist-u-2P-92t.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/docx-preview-CT5aNAuZ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/docx-preview-CT5aNAuZ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/download-SysCaNbu.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/download-SysCaNbu.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dropdown-menu-BZHXC9Tz.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/dropdown-menu-BZHXC9Tz.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/EmptyState-CM4BC7Ru.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/EmptyState-CM4BC7Ru.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/environments-Dpp_tRT5.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/environments-Dpp_tRT5.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/eventemitter3-BL0-Rvuz.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/eventemitter3-BL0-Rvuz.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/external-link-wBeD5wXe.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/external-link-wBeD5wXe.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/eye-BR0PjDLB.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/eye-BR0PjDLB.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/file-code-BGaMYd0F.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/file-code-BGaMYd0F.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/file-text-BS8Ptrzj.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/file-text-BS8Ptrzj.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/FormDialog-s7cD4N05.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/FormDialog-s7cD4N05.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/gauge-CCQY7-7N.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/gauge-CCQY7-7N.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/globe-BFrv4jLQ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/globe-BFrv4jLQ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/heic2any-DBUyPcaT.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/heic2any-DBUyPcaT.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/highlighted-body-OFNGDK62-CEqoMERk.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/highlighted-body-OFNGDK62-CEqoMERk.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/hookform-CDaomxVA.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/hookform-CDaomxVA.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/i18n-Ds8HVnFz.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/i18n-Ds8HVnFz.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/inbox-_jQP1HwY.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/inbox-_jQP1HwY.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/info-CbiwABHz.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/info-CbiwABHz.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/input-DGzmbkQq.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/input-DGzmbkQq.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/jszip.min-Uer3KtZc.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/jszip.min-Uer3KtZc.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/key-round-C3aqxZu_.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/key-round-C3aqxZu_.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/knowledge-bases-UTc-0iQT.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/knowledge-bases-UTc-0iQT.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/label-CcO7HaPb.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/label-CcO7HaPb.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/layers-DCfo9kUF.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/layers-DCfo9kUF.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/lib--AU_81Hr.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/lib--AU_81Hr.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/lib-Dm7WF17-.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/lib-Dm7WF17-.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/lib-Dmxda1-q.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/list-Cp-GTHyB.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/list-Cp-GTHyB.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/loader-circle-DheYvj0j.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/loader-circle-DheYvj0j.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/log-out-Cj8CheDu.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/log-out-Cj8CheDu.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/LoginPage-Bxmjja_w.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/LoginPage-Bxmjja_w.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/main-CGDp7JPA.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/main-CGDp7JPA.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/main-DbdTcngK.css` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/main-Dlkgu0vs.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/main-Dlkgu0vs.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/marked.esm-D0K5jX26.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/marked.esm-D0K5jX26.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/MasterKeyGate-D3on8m50.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/MasterKeyGate-D3on8m50.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/mcp-resource-access-BWZ_85Ln.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/mcp-resource-access-BWZ_85Ln.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/MemoriesPage-C6Xw7tH6.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/MemoriesPage-C6Xw7tH6.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/mermaid-GHXKKRXX-C_JprzpB.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/message-square-g9tigQBP.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/message-square-g9tigQBP.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/meta-agent-CesVu5JK.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/meta-agent-CesVu5JK.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/model-gateway-usage-iG34j9oC.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/model-gateway-usage-iG34j9oC.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ModelGatewayUsagePage-iHVRwHjZ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ModelGatewayUsagePage-iHVRwHjZ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/models--Cr2lPWc.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/models--Cr2lPWc.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/motion-CGcRKhLL.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/motion-CGcRKhLL.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/network-BinpcmjC.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/network-BinpcmjC.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/objectWithoutProperties-CKVKl2hH.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/objectWithoutProperties-CKVKl2hH.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/OrgContext-CzUogm6N.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/OrgContext-CzUogm6N.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/pagination-CWPDTJeR.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/pagination-CWPDTJeR.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/password-crypto-CSzGqZto.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/password-crypto-CSzGqZto.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/pdf-XvMRToeg.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/pdf-XvMRToeg.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/pencil-CKlaoVgc.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/pencil-CKlaoVgc.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/play-BhoHRoFL.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/play-BhoHRoFL.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/plus-DuCz_wRh.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/plus-DuCz_wRh.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/popover-CuaCDT9I.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/popover-CuaCDT9I.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/preload-helper-D1lGPcRK.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-bash-D6zCJ74D.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-bash-D6zCJ74D.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-batch-B9jqdHtA.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-batch-B9jqdHtA.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-c-04YixN25.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-c-04YixN25.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-CGKbDHo5.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-CGKbDHo5.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-clojure-_z-zoNcE.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-clojure-_z-zoNcE.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-cpp-C-lJbC-6.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-cpp-C-lJbC-6.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-csharp-XPn2bw0d.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-csharp-XPn2bw0d.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-dart-CDv16Fbu.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-dart-CDv16Fbu.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-docker-DpmEQIw1.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-docker-DpmEQIw1.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-dot-muz-bJnx.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-dot-muz-bJnx.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-editorconfig-D_2lxMb2.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-editorconfig-D_2lxMb2.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-elixir-DhHhV5Rj.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-elixir-DhHhV5Rj.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-elm-Cw9KzQcz.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-elm-Cw9KzQcz.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-erlang-Bh-2Lpd-.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-erlang-Bh-2Lpd-.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-fsharp-CEOgdqPe.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-fsharp-CEOgdqPe.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-go-C_8qAH5n.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-go-C_8qAH5n.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-graphql-XjvHrdQl.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-graphql-XjvHrdQl.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-groovy-ve2nSEyk.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-groovy-ve2nSEyk.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-haskell-5hq1Nh9c.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-haskell-5hq1Nh9c.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-hcl-B6Z0Ouoo.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-hcl-B6Z0Ouoo.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-http-P0tfj_R7.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-http-P0tfj_R7.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-ignore-DhqxNYSM.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-ignore-DhqxNYSM.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-ini-BESK3y0r.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-ini-BESK3y0r.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-java-6wtusvIl.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-java-6wtusvIl.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-json-Dp_-W-Hv.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-json-Dp_-W-Hv.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-json5-Fv36zNOw.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-json5-Fv36zNOw.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-kotlin-BUlJgC-o.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-kotlin-BUlJgC-o.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-latex-DNMbqcH_.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-latex-DNMbqcH_.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-lua-CpZpYpyh.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-lua-CpZpYpyh.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-makefile-CRKWLQ8l.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-makefile-CRKWLQ8l.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-markup-templating-KkSMBj6Y.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-markup-templating-KkSMBj6Y.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-nginx-B3l_WPu1.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-nginx-B3l_WPu1.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-php-Co4fM40K.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-php-Co4fM40K.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-powershell-Cvud8pPk.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-powershell-Cvud8pPk.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-properties-BEvvZlWN.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-properties-BEvvZlWN.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-protobuf-yzSHlhwy.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-protobuf-yzSHlhwy.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-python-CfiSVtM6.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-python-CfiSVtM6.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-r-QmNGR8LX.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-r-QmNGR8LX.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-ruby-DFCASkuD.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-ruby-DFCASkuD.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-rust-Bu9N8X3N.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-rust-Bu9N8X3N.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-scala-VkM3wCOL.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-scala-VkM3wCOL.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-sql-CYhVDMEE.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-sql-CYhVDMEE.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-swift-B0kWc-ne.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-swift-B0kWc-ne.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-toml-DP4acBVm.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-toml-DP4acBVm.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-typescript-BMqONzxf.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-typescript-BMqONzxf.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-yaml-C0JHu8gr.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prism-yaml-C0JHu8gr.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prod-view-modules-C7L2tnEO.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prod-view-modules-C7L2tnEO.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prod-views-D_xNUWcF.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/prod-views-D_xNUWcF.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ProdViewPage-CYO39wlJ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ProdViewPage-CYO39wlJ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/purify.es-CudRumAY.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/purify.es-DY32g7DN.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/purify.es-DY32g7DN.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/qr-OQ492SX-.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/qr-OQ492SX-.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/radix-ui-B6gdef0K.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/radix-ui-B6gdef0K.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/refresh-cw-CcFh5mNq.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/refresh-cw-CcFh5mNq.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/registry-jK7nduE3.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/registry-jK7nduE3.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/request-BgznYEIW.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/request-BgznYEIW.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/resizable-B9Jgm8iF.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/resizable-B9Jgm8iF.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ResourcePreviewContent-CazmXbru.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ResourcePreviewContent-CZt8eJ1O.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/ResourcePreviewContent-CZt8eJ1O.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/rolldown-runtime-CMxvf4Kt.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/rotate-cw-CZcbufwe.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/rotate-cw-CZcbufwe.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/scroll-area-sSHuWQ1J.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/scroll-area-sSHuWQ1J.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/search-M7STPAhr.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/search-M7STPAhr.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/select-kQ-JUgJ0.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/select-kQ-JUgJ0.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/server-DYXOg1NM.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/server-DYXOg1NM.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/settings-Br01ACr0.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/settings-Br01ACr0.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/sheet-0MimWHTF.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/sheet-0MimWHTF.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/shield-Byk3VcvD.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/shield-Byk3VcvD.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/shield-check-Gg3nkb6U.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/shield-check-Gg3nkb6U.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/sites-Ca_JgEGA.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/sites-Ca_JgEGA.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/skeleton-BoyErDmU.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/skeleton-BoyErDmU.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/skill-resource-access-Bjd2_Yve.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/skill-resource-access-Bjd2_Yve.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/sparkles-QFRdPDpI.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/sparkles-QFRdPDpI.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/square-KDHzIqUT.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/square-KDHzIqUT.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/star-01HVjcjp.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/star-01HVjcjp.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/switch-CkW130pQ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/switch-CkW130pQ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/system-people-tree-BFHVThnm.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/system-people-tree-BFHVThnm.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/table-Cxnxvwak.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/table-Cxnxvwak.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/tabs-BVrzpBvr.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/tabs-BVrzpBvr.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/tanstack-DNrwyqvV.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/tanstack-DNrwyqvV.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/tanstack-router-CrnzIVPe.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/tanstack-router-CrnzIVPe.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/textarea-D7q48qpI.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/textarea-D7q48qpI.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/trash-2-rOQQccxY.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/trash-2-rOQQccxY.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/triangle-alert-DCCpPXr_.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/triangle-alert-DCCpPXr_.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/upload-CGkhVmUI.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/upload-CGkhVmUI.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/useMetaAgent-DC7q4B7J.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/useMetaAgent-DC7q4B7J.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/usePageVisible-CgXnyqZr.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/usePageVisible-CgXnyqZr.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/user-8kSBuk4D.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/user-8kSBuk4D.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/user-plus-Cc3YOUMG.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/user-plus-Cc3YOUMG.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/user-round-CiefmftZ.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/user-round-CiefmftZ.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/useRequest-D1eKpF-w.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/useRequest-D1eKpF-w.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/users-ClGtuwJY.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/users-ClGtuwJY.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/UTIF-BTCkAS1V.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/UTIF-BTCkAS1V.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/utils-C-7UWu6Z.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/utils-C-7UWu6Z.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/value-8xOwwyZS.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/value-8xOwwyZS.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/vendor-DyK9JTuL.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/vendor-DyK9JTuL.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/VerticalModelsPage-Dh9zhlTE.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/VerticalModelsPage-Dh9zhlTE.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/workflow-Cz5wfZ9a.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/workflow-Cz5wfZ9a.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/workflow-defs-C7XRPa1w.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/workflow-defs-C7XRPa1w.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/workflow-engine-GyRPK9u4.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/workflow-engine-GyRPK9u4.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowEditor-3g67wxkx.css` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowEditor-DxBRABqx.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowEditor-DxBRABqx.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowList-DT36APWP.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowList-DT36APWP.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowRuns-CMvhJqiw.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/WorkflowRuns-CMvhJqiw.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/x-BOOWposN.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/x-BOOWposN.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/xlsx-B5IUcRbL.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/xlsx-BBdGTGDY.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/xlsx-BBdGTGDY.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/yaml-utils-D7MgLOCD.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/yaml-utils-D7MgLOCD.js.map` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/assets/yaml-utils-PlvOQ88D.js` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/brand/fenix-agent-logo-mark.png` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/brand/models/power-dispatch.png` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/brand/models/ppe-detection.jpeg` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/brand/models/wind-assembly.png` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/brand/models/wind-logistics.jpeg` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/images/memories-empty.webp` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |
| `web/dist/index.html` | 删除 | delete | 删除：非源码产物 | scripts/__tests__/root-source-owner-inventory.test.ts | RMD-09 |

## RMD-07 retained host test rationale

| 保留的 host 测试 | 依据 |
| --- | --- |
