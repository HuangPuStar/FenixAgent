# 根目录源码最终归属清单

此文件由 `bun run scripts/check-root-source-owner-inventory.ts --markdown > docs/arch/root-source-owner-inventory.md` 生成。请修改规则后重新生成，不要手工编辑。

## 审计结果

- 文件总数：0
- 未归属：0
- 歧义：0
- 不安全删除：0

## 按任务和 owner 汇总

| 任务 | Owner | 文件数 |
| --- | --- | ---: |


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
| `src/routes/web/control.ts` | packages/agent-runtime/src/routes/web/control.ts | agent-runtime | RMD-06 |
| `src/repositories/share-link.ts` | packages/platform/identity/src/repositories/share-link.ts | platform-identity | RMD-06 |
| `src/repositories/token.ts` | packages/platform/identity/src/repositories/token.ts | platform-identity | RMD-06 |
| `src/repositories/user.ts` | packages/platform/identity/src/repositories/user.ts | platform-identity | RMD-06 |
| `web/components/ChangePasswordDialog.tsx` | packages/platform/identity/web/components/ChangePasswordDialog.tsx | platform-identity | RMD-06 |
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
| `web/src/__tests__/token-` | packages/platform/identity/web/src/__tests__/token- | platform-identity | RMD-06 |
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


## RMD-07 retained host test rationale

| 保留的 host 测试 | 依据 |
| --- | --- |
