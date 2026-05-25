# 实施计划：eden-type-safe-client

> 设计文档：`spec/feature_20260514_F001_eden-type-safe-client/spec-design.md`

## 迁移规模

- 后端：60 个路由处理器、16 个路由文件，均未使用 schema 装饰器
- 前端：31 个文件 import `api/client`、39 个文件 import `types`，约 52 个唯一文件需修改
- 测试：12 个前端测试文件 + 后端测试文件

---

## Phase 1：基础设施搭建

### Task 1.1：安装依赖

- 安装 `@elysiajs/eden`（生产依赖，Eden Treaty 同时用于前后端类型推导）
- 验证 Eden 版本与 Elysia `^1.4.28` 兼容

```bash
bun add @elysiajs/eden
```

**验证**：`bun run typecheck` 通过

### Task 1.2：创建 `src/schemas/` 目录结构

创建共享 schema 目录和通用类型：

```
src/schemas/
├── common.schema.ts         # ApiResponse<T>、分页参数、通用错误响应
├── session.schema.ts
├── environment.schema.ts
├── instance.schema.ts
├── config.schema.ts
├── task.schema.ts
├── channel.schema.ts
├── api-key.schema.ts
├── file.schema.ts
├── knowledge.schema.ts
└── index.ts                 # 统一 re-export
```

先只创建 `common.schema.ts`（ApiResponse 包装、通用错误结构），其余文件在 Phase 2 各 Task 中按需创建。

**关键**：项目使用 Zod 4（`zod@^4.3.6`），schema 语法使用 Zod 4 API。

### Task 1.3：后端导出 App 类型

在 `src/index.ts` 底部添加：

```typescript
export type App = typeof app;
```

**验证**：`bun run typecheck` 通过

### Task 1.4：前端 tsconfig 路径别名

**`web/tsconfig.json`** 添加：

```json
"paths": {
  "@/*": ["./*"],
  "@server/*": ["../../src/*"]
}
```

**`web/vite.config.ts`** 同步添加 resolve alias：

```typescript
resolve: {
  alias: {
    "@server": path.resolve(__dirname, "../src"),
    // ... 现有 alias
  },
}
```

**验证**：
- `bun run typecheck` 通过
- 前端能 `import type { App } from "@server/index"` 无报错

---

## Phase 2：后端 Schema 补全

按复杂度从低到高，每个 Task 包含：创建/更新 schema 文件 → 更新路由文件注册 model → 运行 typecheck。

### Task 2.1：api-keys（4 路由）

**Schema 文件**：`src/schemas/api-key.schema.ts`

定义：
- `ApiKeyInfoSchema`：id, label, keyPrefix, createdAt, lastUsedAt
- `CreateApiKeyRequestSchema`：label
- `CreateApiKeyResponseSchema`：extends ApiKeyInfo + full_key

**路由更新**：`src/routes/web/api-keys.ts`
- 4 个路由添加 `.model()` 注册 + `.body()` / `.response()`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.2：channels（7 路由）

**Schema 文件**：`src/schemas/channel.schema.ts`

定义：
- `ChannelProviderInfoSchema`：type, label, description, icon
- `ChannelInfoSchema`：id, type, name, config, status, createdAt
- `ChannelBindingSchema`：id, channelId, channelName, environmentId, environmentName, ...
- `CreateChannelBindingRequestSchema`：channelId, environmentId, ...
- `HermesStatusSchema`：connected, url, ...

**路由更新**：`src/routes/web/channels.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.3：instances（4 路由）

**Schema 文件**：`src/schemas/instance.schema.ts`

定义：
- `InstanceInfoSchema`：id, port, status, error, groupId, environmentId, sessionId, instanceNumber, createdAt
- `CreateInstanceResponseSchema`：id, port, status, instanceNumber, sessionId, createdAt
- `SpawnInstanceRequestSchema`：environmentId

**路由更新**：`src/routes/web/instances.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.4：files（5 路由）

**Schema 文件**：`src/schemas/file.schema.ts`

定义：
- `FileInfoSchema`：name, path, size, isDirectory, modifiedAt
- `FileListResponseSchema`：path, files: FileInfo[]
- `FileContentSchema`：path, content, encoding
- `FileUploadResultSchema`：uploaded: string[]
- `FileWriteResultSchema`：path, size

**路由更新**：`src/routes/web/files.ts`

**注意**：文件上传路由（POST）接受 FormData，body schema 需要特殊处理。

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.5：knowledge-bases（9 路由）

**Schema 文件**：`src/schemas/knowledge.schema.ts`

定义：
- `KnowledgeBaseInfoSchema`：id, name, slug, description, resourceCount, createdAt
- `KnowledgeBaseDetailSchema`：extends KnowledgeBaseInfo + resources
- `KnowledgeResourceInfoSchema`：id, name, type, sourceName, size, createdAt
- `KnowledgeUploadResponseSchema`：uploaded, skipped, conflicts
- 创建/更新请求 schema

**路由更新**：`src/routes/web/knowledge-bases.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.6：sessions（4 路由）

**Schema 文件**：`src/schemas/session.schema.ts`

定义：
- `SessionSchema`：id, environmentId, status, title, cwd, agentName, createdAt, updatedAt
- `SessionEventSchema`：id, sessionId, type, timestamp, payload
- `SessionHistorySchema`：events: SessionEvent[]

**路由更新**：`src/routes/web/sessions.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.7：control（3 路由）

**Schema 文件**：`src/schemas/session.schema.ts`（追加）

定义：
- `SessionEventPayloadSchema`：type, content, ...
- `ControlResponseSchema`：action, ...

**路由更新**：`src/routes/web/control.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.8：environments（7 路由）

**Schema 文件**：`src/schemas/environment.schema.ts`

定义：
- `EnvironmentSchema`：id, name, status, workspacePath, agentName, sessionCount, autoStart, ...
- `EnvironmentDetailSchema`：extends Environment + sessions, instances
- `CreateEnvironmentRequestSchema`：name, workspacePath, agentName, ...
- `UpdateEnvironmentRequestSchema`：部分字段可选
- `EnterEnvironmentResponseSchema`：session_id, instance_id, instance_number, instance_status, environment_id
- `ListInstancesResponseSchema`：environment_id, instances

**路由更新**：`src/routes/web/environments.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.9：tasks（9 路由）

**Schema 文件**：`src/schemas/task.schema.ts`

定义：
- `TaskInfoSchema`：id, name, description, cron, timezone, enabled, environmentId, ...
- `ExecutionLogInfoSchema`：id, taskId, status, error, duration, triggeredBy, ...
- `PaginatedLogsSchema`：total, items
- `CreateTaskRequestSchema` / `UpdateTaskRequestSchema`：部分字段

**路由更新**：`src/routes/web/tasks.ts`

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.10：config（约 30 路由，最复杂）

Config 模块已拆分为子文件，需要逐个处理：

- `src/routes/web/config/index.ts`：组合入口
- `src/routes/web/config/providers.ts`：1 路由（POST /config/providers）
- `src/routes/web/config/models.ts`：1 路由（POST /config/models）
- `src/routes/web/config/agents.ts`：1 路由（POST /config/agents）
- `src/routes/web/config/skills.ts`：2 路由（POST /config/skills + POST /config/skills/upload）
- `src/routes/web/config/mcp.ts`：1 路由（POST /config/mcp）

**Schema 文件**：`src/schemas/config.schema.ts`

定义（所有 config 相关类型）：
- `ConfigActionSchema`：action 枚举
- `ConfigResponseSchema<T>`：success, data?, error?
- `ProviderInfoSchema`、`ProviderDetailSchema`、`ProviderModelSchema`
- `ModelConfigSchema`
- `AgentInfoSchema`、`AgentDetailSchema`
- `SkillInfoSchema`、`SkillDetailSchema`、`SkillSourceInfoSchema`
- `McpServerInfoSchema`、`McpServerDetailSchema`、`McpServerConfigSchema`、`McpToolInfoSchema`、`McpInspectResultSchema`
- `SkillUploadResponseSchema`、`SkillUploadConflictResponseSchema`
- Permission 相关：`PermissionActionSchema`、`PermissionConfigSchema`、`PermissionObjectConfigSchema`

**难点处理**：
- Config 路由用 `action` 字段分发，Elysia 不直接支持 discriminated union body。方案：在 handler 内部用 Zod `discriminatedUnion()` 做运行时校验，路由级别用宽松的 `z.record(z.unknown())` 作为 body schema（保留 action 字段约束）
- Skills upload 接受 FormData，body schema 特殊处理

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.11：auth（1 路由）

**路由更新**：`src/routes/web/auth.ts`
- POST `/bind`：添加 body schema（sessionId: string）

**验证**：`bun run typecheck` + `bun test src/__tests__/`

### Task 2.12：更新 `src/schemas/index.ts` 统一导出

所有 schema 文件创建完成后，更新 `index.ts` 统一 re-export 所有 schema 和推导类型。

**验证**：`bun run typecheck` 通过

---

## Phase 3：前端迁移

### Task 3.1：重写 `web/src/api/client.ts` 为 Eden Treaty

**核心变更**：
```typescript
import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

export const client = treaty<App>("", {
  fetch: { credentials: "include" },
});
```

**保留的辅助函数**（Eden 不直接支持的）：
- `createSessionEventSource(sessionId)` — SSE 连接
- FormData 上传的 fallback `fetchUpload()` — 验证 Eden FormData 兼容性前的保险方案

**删除**：
- 所有 `apiXxx()` 函数（573 行缩减为 ~30 行）
- 所有内联 interface（`InstanceInfo`、`TaskInfo`、`EnterEnvironmentResponse`、`ListEnvironmentInstancesResponse`、`ApiKeyInfo`、`CreateApiKeyResponse`）

**验证**：`bun run typecheck` 通过（此时页面组件会报错，预期行为）

### Task 3.2：迁移页面组件 API 调用（11 个文件）

按模块分批迁移，每个文件将 `apiXxx()` 调用替换为 `client.xxx.method()`：

| 文件 | 迁移内容 |
|------|---------|
| `ApiKeyManager.tsx` | apiFetchApiKeys, apiCreateApiKey, apiDeleteApiKey, apiUpdateApiKeyLabel |
| `ChannelsPage.tsx` | apiGetHermesStatus, apiListChannelBindings, apiCreateChannelBinding, apiDeleteChannelBinding, apiUpdateChannelBinding, apiFetchEnvironments |
| `TasksPage.tsx` | apiClearTaskLogs, apiCreateTask, apiDeleteTask, apiListTaskLogs, apiListTasks, apiToggleTask, apiTriggerTask, apiUpdateTask, apiListFiles |
| `EnvironmentsPage.tsx` | apiFetchEnvironments, apiGetEnvironment, apiCreateEnvironment, apiUpdateEnvironment, apiDeleteEnvironment, apiListAgents, apiEnterEnvironment, apiDeleteInstance, apiListEnvironmentInstances, apiSpawnInstanceFromEnvironment |
| `SkillsPage.tsx` | apiListSkillSources, apiGetSkill, apiSetSkill, apiDeleteSkill, apiEnableSkill, apiDisableSkill, apiUploadSkills |
| `ModelsPage.tsx` | apiListProviders, apiSetProvider, apiTestProvider, apiDeleteProvider, apiGetProvider, apiAddProviderModel, apiUpdateProviderModel, apiRemoveProviderModel, apiGetModels |
| `McpPage.tsx` | apiListMcpServers, apiGetMcpServer, apiCreateMcpServer, apiUpdateMcpServer, apiDeleteMcpServer, apiEnableMcpServer, apiDisableMcpServer, apiTestMcpUrl, apiInspectMcpServer, apiListMcpTools |
| `AgentsPage.tsx` | apiListAgents, apiGetAgent, apiCreateAgent, apiSetAgent, apiDeleteAgent, apiSetDefaultAgent, apiGetModels, apiListKnowledgeBases |
| `Dashboard.tsx` | apiFetchEnvironments, apiFetchAllSessions, apiListAgents, apiGetModels, apiListSkills, apiListMcpServers, apiListTasks |
| `SessionDetail.tsx` | apiFetchSession, apiSendControl |
| `KnowledgeBasesPage.tsx` | apiCreateKnowledgeBase, apiDeleteKnowledgeResource, apiDeleteKnowledgeBase, apiGetKnowledgeBase, apiImportKnowledgeResourceUrl, apiListKnowledgeBases, apiListKnowledgeResources, apiUpdateKnowledgeBase, apiUploadKnowledgeResources |

**调用模式统一**：
```typescript
// 旧
const sessions = await apiFetchSessions();
// 新
const { data: sessions, error } = await client.web.sessions.get();
if (error) { toast.error(error.message); return; }
```

**验证**：每迁移一个文件后 `bun run typecheck` 通过

### Task 3.3：迁移组件 API 调用（6 个文件）

| 文件 | 迁移内容 |
|------|---------|
| `FilePickerDialog.tsx` | apiListFiles, apiUploadFile |
| `PermissionTab.tsx` | apiListSkills |
| `NewSessionDialog.tsx` | apiCreateSession |
| `IdentityPanel.tsx` | getUuid, setUuid（deprecated，评估是否删除） |
| `EnvironmentList.tsx` | type InstanceInfo 改为从 Eden 推导 |

**验证**：`bun run typecheck` 通过

### Task 3.4：迁移 hooks 和 libraries（7 个文件）

| 文件 | 迁移内容 |
|------|---------|
| `hooks/useAuth.ts` | getUuid, setUuid |
| `hooks/useModels.ts` | apiGetModels |
| `lib/rcs-transport.ts` | getUuid |
| `lib/rcs-chat-adapter.ts` | apiFetchSession, apiFetchSessionHistory, apiSendEvent, apiSendControl, apiInterrupt |
| `api/sse.ts` | getUuid |

**验证**：`bun run typecheck` 通过

### Task 3.5：迁移 WebSocket（ACP 客户端）

**文件**：`web/src/acp/client.ts`、`web/src/acp/relay-client.ts`

评估 Eden Treaty 的 `.subscribe()` 是否适用于当前的 WebSocket 连接模式：
- `/acp/relay/:agentId` — 前端与 Agent 的中继 WebSocket
- 如果 Eden 不适合（如自定义消息协议），保留现有 WebSocket 实现，仅确保类型引用正确

**验证**：`bun run typecheck` 通过

### Task 3.6：清理前端类型文件

| 文件 | 操作 |
|------|------|
| `web/src/types/index.ts` | 删除 Session、Environment、EnvironmentDetail、EnvironmentInstance、CreateEnvironmentRequest、UpdateEnvironmentRequest、SessionEvent、EventPayload、ContentBlock、PermissionRequest、ControlResponse、ChannelProviderInfo、ChannelInfo、HermesStatus、ChannelBinding、CreateChannelBindingRequest、FileInfo、FileListResponse、FileContent、FileUploadResult、FileWriteResult。保留纯前端 UI 类型（如有） |
| `web/src/types/config.ts` | 删除 ProviderInfo、ProviderDetail、ModelConfig、AgentInfo、AgentDetail、SkillInfo、SkillDetail、McpServerInfo、McpServerDetail、McpServerConfig、McpToolInfo、McpInspectResult、ApiResponse、SkillUploadResponse、SkillUploadConflictResponse、OpenCodeModel、OpenCodeProvider、OpenCodeAgent、OpenCodeConfig。Permission 相关类型（PermissionAction、PermissionConfig、PermissionObjectConfig）评估是否保留（前端表单可能直接使用）或迁入 schema |
| `web/src/types/knowledge.ts` | 完全删除 |

**注意**：`web/src/types/config.ts` 中的 `SkillSourceInfo`、`SkillSourceStatus`、`SkillUploadConflictStrategy`、`UploadSkillSummary`、`UploadManifestEntry`、`UploadSkillFileItem` 等纯前端上传流程类型可能需要保留在 types 中（非 API 响应类型）。

**验证**：`bun run typecheck` 通过 + `bun run build:web` 成功

---

## Phase 4：测试同步

### Task 4.1：更新前端测试（12 个文件）

| 文件 | 更新内容 |
|------|---------|
| `api-client.test.ts` | 完全重写，测试 Eden Treaty 客户端而非 api 函数 |
| `config-api-client.test.ts` | 迁移为 Eden Treaty 调用 |
| `config-mcp-api-client.test.ts` | 迁移为 Eden Treaty 调用 |
| `file-api.test.ts` | 迁移为 Eden Treaty 调用 |
| `dashboard-env.test.tsx` | 更新 import（types + api） |
| `file-picker-dialog.test.tsx` | 更新 import |
| `tasks-page.test.ts` | 更新 import |
| `config-agents-page.test.ts` | 更新 import（types） |
| `config-model-config-dialog.test.ts` | 更新 import（types） |
| `config-types.test.ts` | 更新 import（types）→ 可能需要重写或删除（类型从 schema 推导） |
| `config-mcp-types.test.ts` | 更新 import（types）→ 可能需要重写或删除 |
| `rcs-chat-adapter.test.ts` | 更新 import（types + api） |

**验证**：`bun test web/src/__tests__/` 全部通过

### Task 4.2：更新后端测试

检查所有 `src/__tests__/` 下的测试文件，更新：
- Mock 返回值需匹配新的 schema 结构
- 如果测试直接 import 路由文件，确保 schema 变更不破坏 mock

**验证**：`bun test src/__tests__/` 全部通过

### Task 4.3：全量验证

```bash
bun run typecheck        # 无错误
bun test src/__tests__/  # 全部通过
bun test web/src/__tests__/  # 全部通过
bun run build:web        # 构建成功
```

---

## 风险与应对

| 风险 | 影响 | 应对 |
|------|------|------|
| Eden Treaty 对 FormData 上传支持不完善 | 3 个上传端点无法用 Eden | 保留 `fetchUpload()` 辅助函数作为 fallback |
| Config 模块 action 分发模式与 Elysia schema 不兼容 | 类型推导不精确 | 路由级别用宽松 schema，handler 内部用 Zod discriminatedUnion 校验 |
| tsconfig 路径别名在 Vite 构建时不生效 | 前端构建失败 | 同步配置 `vite.config.ts` 的 `resolve.alias` |
| Zod 4 与 Elysia 的 schema 集成有兼容问题 | body 校验失败 | 验证 Elysia 对 Zod 4 的支持，必要时使用 `z.object()` 而非 Zod 4 特有 API |
| 迁移过程中前后端类型不匹配 | typecheck 报错 | Phase 2 完成后再开始 Phase 3，确保后端 schema 稳定后再迁移前端 |
