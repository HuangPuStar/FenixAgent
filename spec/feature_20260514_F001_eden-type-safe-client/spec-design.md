# Feature: 20260514_F001 - eden-type-safe-client

## 需求背景

当前前后端通信使用手动 `fetch` + `as T` 类型断言模式（`web/src/api/client.ts`），存在以下问题：

1. **无类型安全**：前端 API 调用的参数和返回值类型全部手动定义在 `web/src/types/` 中，与后端实际返回结构无编译时关联。后端改一个字段，前端不会报错。
2. **类型重复维护**：`web/src/types/index.ts`、`config.ts`、`knowledge.ts` 中的 interface 与后端 `src/store.ts`、各路由文件中的内联类型一一对应但独立维护，容易漂移。
3. **无运行时校验**：前端不做 response 校验，后端不做 body 校验（路由中大量 `(body as any)`），异常数据静默通过。
4. **API client 代码冗余**：`client.ts` 有 573 行，大量 `apiXxx()` 函数只是对 `fetch` 的简单包装，手动拼 URL 和 method。

Elysia 官方提供 `@elysiajs/eden` (Eden Treaty)，可以从后端 Elysia app 实例自动推导出完整的类型安全 API 客户端，同时配合后端 Zod schema 提供运行时校验。

## 目标

- 引入 `@elysiajs/eden`，实现前后端端到端类型安全通信
- 为所有 `/web/*` 后端路由补全 Elysia schema（body + response），使用 Zod 定义
- 一次性迁移所有前端 API 调用到 Eden Treaty 客户端
- 删除 `web/src/types/` 中与后端重复的类型定义
- 同步更新所有受影响的测试用例
- REST + WebSocket 统一由 Eden 管理，SSE 保留 EventSource

## 方案设计

### 架构概览

```
后端 (src/)                              前端 (web/src/)
┌───────────────────────────┐            ┌─────────────────────────┐
│ src/schemas/              │            │ api/client.ts           │
│   session.schema.ts       │            │   treaty<App>(baseURL)  │
│   environment.schema.ts   │            │        ↓                │
│   config.schema.ts        │  类型推导   │ 自动推导所有路由的       │
│   task.schema.ts          │ ────────→  │ 参数和返回值类型         │
│   ...                     │            │                         │
│                           │            │ 页面组件直接调用         │
│ src/routes/web/           │            │ client.web.sessions.get │
│   sessions.ts             │            │ client.web.config...    │
│   environments.ts         │            │                         │
│   config.ts               │            │ 删除 web/src/types/     │
│   ...9个模块               │            │ 的重复 interface        │
│                           │            │                         │
│ src/index.ts              │            │ web/tsconfig.json       │
│   export type App         │            │   @server → ../../src   │
│   = typeof app            │            │                         │
└───────────────────────────┘            └─────────────────────────┘
```

### 类型导出机制

1. **后端导出**：在 `src/index.ts` 底部添加 `export type App = typeof app`，将编译后的 Elysia 实例类型导出
2. **前端导入**：在 `web/tsconfig.json` 的 `paths` 中添加 `"@server/*": ["../../src/*"]`，让前端能直接 `import type { App } from "@server/index"`
3. **Treaty 实例化**：`web/src/api/client.ts` 中 `const client = treaty<App>('', { fetch: { credentials: 'include' } })`

### 后端 Schema 补全

#### Schema 定义规范

每个路由模块遵循以下模式：

```typescript
import { z } from "zod";

// 1. 在 src/schemas/xxx.schema.ts 中定义 Zod schema
export const SessionResponseSchema = z.object({
  id: z.string(),
  status: z.enum(["active", "idle", "requires_action", "archived", "error"]),
  // ...
});
export type SessionResponse = z.infer<typeof SessionResponseSchema>;

// 2. 在路由模块中用 .model() 注册
new Elysia({ name: "web-sessions", prefix: "/web" })
  .use(authGuardPlugin)
  .model({ "session.response": SessionResponseSchema })
  .get("/sessions/:id", handler, {
    response: "session.response",
    sessionAuth: true,
  })
```

#### 共享 Schema 目录结构

```
src/schemas/
├── session.schema.ts        # Session, SessionEvent, SessionSummary
├── environment.schema.ts    # Environment, EnvironmentDetail, CreateEnvironmentRequest
├── instance.schema.ts       # InstanceInfo, CreateInstanceResponse
├── config.schema.ts         # ProviderInfo, ModelConfig, AgentInfo, SkillInfo, McpServerInfo
├── task.schema.ts           # TaskInfo, ExecutionLogInfo, PaginatedLogs
├── channel.schema.ts        # ChannelInfo, ChannelBinding, HermesStatus
├── api-key.schema.ts        # ApiKeyInfo, CreateApiKeyResponse
├── file.schema.ts           # FileListResponse, FileContent, FileUploadResult
├── knowledge.schema.ts      # KnowledgeBaseInfo, KnowledgeResourceInfo
├── common.schema.ts         # ApiResponse<T>, PaginationParams, 等通用 schema
└── index.ts                 # 统一导出
```

#### 路由模块 Schema 补全清单

| 路由文件 | 路由数 | 需要的 Schema |
|----------|--------|--------------|
| `api-keys.ts` | 4 | ApiKeyInfo, CreateApiKeyRequest, CreateApiKeyResponse |
| `channels.ts` | 7 | ChannelProviderInfo, ChannelInfo, ChannelBinding, CreateChannelBindingRequest, HermesStatus |
| `instances.ts` | 5 | InstanceInfo, CreateInstanceResponse, SpawnInstanceRequest |
| `files.ts` | 5 | FileListResponse, FileContent, FileUploadResult, FileWriteResult |
| `knowledge-bases.ts` | 8 | KnowledgeBaseInfo, KnowledgeBaseDetail, KnowledgeResourceInfo, KnowledgeUploadResponse |
| `sessions.ts` | 5 | Session, SessionEvent, SessionHistory |
| `environments.ts` | 7 | Environment, EnvironmentDetail, CreateEnvironmentRequest, UpdateEnvironmentRequest, EnterEnvironmentResponse |
| `tasks.ts` | 9 | TaskInfo, ExecutionLogInfo, PaginatedLogs, CreateTaskRequest, UpdateTaskRequest |
| `config.ts` | 25+ | ConfigRequest (action + data), 各模块的 ProviderInfo/ModelConfig/AgentInfo 等 |

#### Config 模块特殊处理

Config 模块使用统一的 `POST /web/config/:module` + action 分发模式。为保持向后兼容，Schema 按如下方式定义：

```typescript
// config body 的通用结构
const ConfigActionSchema = z.object({
  action: z.enum(["list", "get", "set", "create", "delete", "enable", "disable"]),
});

// 各模块的特化 body
const ProviderSetBody = ConfigActionSchema.extend({
  action: z.literal("set"),
  name: z.string(),
  data: z.record(z.unknown()),
});
```

Config 路由的每个 action 可以通过 Elysia 的 `.body()` 声明对应的 schema。

### 前端 Eden Treaty 集成

#### 客户端初始化

```typescript
// web/src/api/client.ts
import { treaty } from "@elysiajs/eden";
import type { App } from "@server/index";

export const client = treaty<App>("", {
  fetch: { credentials: "include" },
});

// 使用示例
export async function fetchSessions() {
  const { data, error } = await client.web.sessions.get();
  if (error) throw new Error(error.message);
  return data;
}
```

#### 前端类型清理

| 文件 | 处理方式 |
|------|---------|
| `web/src/types/index.ts` | 删除所有后端响应类型（Session、Environment、ChannelInfo 等），仅保留纯前端 UI 状态类型（如有） |
| `web/src/types/config.ts` | 删除所有 API 响应类型（ProviderInfo、AgentDetail 等），Permission 相关前端表单类型视情况保留或迁入 schema |
| `web/src/types/knowledge.ts` | 完全删除，类型从 Eden 推导 |
| `web/src/api/client.ts` | 完全重写，删除所有 `apiXxx()` 函数和内联 interface（如 `InstanceInfo`、`TaskInfo` 等） |

#### 页面迁移

所有页面组件中的 `import { apiXxx }` 改为 `import { client }`，调用方式从：

```typescript
const sessions = await apiFetchSessions();
```

改为：

```typescript
const { data: sessions, error } = await client.web.sessions.get();
if (error) { toast.error(error.message); return; }
```

#### WebSocket 集成

Eden Treaty 支持 WebSocket。当前 `/acp/relay/:agentId` 的 WebSocket 连接可以改为：

```typescript
const ws = await client.acp.relay({ agentId }).subscribe();
ws.send?.(message);
ws.subscribe?.(handler);
```

前端 `web/src/acp/client.ts` 中的 WebSocket 连接逻辑相应迁移。

#### SSE 处理

Eden Treaty 目前不原生支持 SSE（Server-Sent Events）。`/web/sessions/:id/events` 的 SSE 连接保留 `EventSource` 方式，在 `client.ts` 中导出辅助函数：

```typescript
export function createSessionEventSource(sessionId: string): EventSource {
  return new EventSource(`/web/sessions/${sessionId}/events`, { withCredentials: true });
}
```

#### FormData 上传

Eden Treaty 支持 FormData 作为 body 直接传递。`apiUploadFile`、`apiUploadSkills`、`apiUploadKnowledgeResources` 等函数迁移为：

```typescript
const { data, error } = await client.web.sessions({ id: sessionId }).user({ dirPath }).post(formData);
```

对于不兼容的场景，保留 `fetch` 辅助函数作为 fallback。

### 迁移顺序

按依赖关系从底层到上层，分 4 个阶段：

**Phase 1 - 基础设施搭建**
1. 安装 `@elysiajs/eden`
2. 创建 `src/schemas/` 目录和 `common.schema.ts`
3. `src/index.ts` 导出 `type App = typeof app`
4. `web/tsconfig.json` 添加路径别名 `@server/*`

**Phase 2 - 后端 Schema 补全（按复杂度从低到高）**
1. `api-keys.ts`（4 个路由，最简单）
2. `channels.ts`（7 个路由）
3. `instances.ts`（5 个路由）
4. `files.ts`（5 个路由）
5. `knowledge-bases.ts`（8 个路由）
6. `sessions.ts`（5 个路由）
7. `environments.ts`（7 个路由）
8. `tasks.ts`（9 个路由）
9. `config.ts`（25+ 个路由，最复杂）

**Phase 3 - 前端迁移**
1. 重写 `web/src/api/client.ts` 为 Eden Treaty 客户端
2. 逐页更新 API 调用方式
3. 迁移 `web/src/acp/client.ts` 的 WebSocket
4. 删除 `web/src/types/` 重复类型定义
5. 处理 SSE 辅助函数

**Phase 4 - 测试同步**
1. 更新后端测试（mock 值适配新 schema）
2. 更新前端测试（导入路径和调用方式）
3. 全量运行测试确认通过

## 实现要点

### 关键技术决策

1. **Zod 版本**：项目已有 `zod@^4.3.6`（Zod 4），使用 Zod 4 的 schema 语法
2. **路径别名方案**：使用 `web/tsconfig.json` 的 `paths` 配置 `"@server/*": ["../../src/*"]`，Vite 需要同步配置 `resolve.alias`
3. **Schema 复用**：跨模块复用的类型（如 `ApiResponse<T>`、分页参数）放在 `src/schemas/common.schema.ts`
4. **Permission 类型**：`PermissionConfig` 等前端表单使用的复杂类型，从 `web/src/types/config.ts` 迁入 `src/schemas/config.schema.ts`，前端通过 Eden 推导使用

### 难点

1. **Config 模块的 action 分发模式**：当前用单一 POST + action 字段分发，需要为每种 action 定义不同的 body schema。可能需要拆分为多个路由或使用 Elysia 的 discriminated union 支持
2. **内联类型提取**：`client.ts` 中的 `InstanceInfo`、`TaskInfo` 等内联 interface 需要迁移到后端 schema，同时确保所有字段精确匹配
3. **FormData 上传路由**：Eden Treaty 对 FormData 的支持需要验证，特别是 `files`、`skills/upload`、`knowledge-bases/:id/resources/upload` 三个上传端点

### 依赖

- `@elysiajs/eden`：需要安装（前端 devDependency）
- `zod`：已安装（v4.3.6），无需额外安装

## 验收标准

- [ ] 所有 9 个后端路由模块补全了 Zod schema（body + response）
- [ ] `src/schemas/` 目录结构完整，类型从 schema 自动推导
- [ ] `src/index.ts` 导出 `type App`
- [ ] `web/tsconfig.json` 配置了 `@server/*` 路径别名
- [ ] `web/src/api/client.ts` 重写为 Eden Treaty 客户端
- [ ] 所有前端页面使用 `client.xxx.method()` 替代 `apiXxx()` 调用
- [ ] `web/src/types/` 中与后端重复的类型定义已删除
- [ ] WebSocket 连接迁移到 Eden Treaty `.subscribe()`
- [ ] SSE 连接保留 EventSource + 辅助函数
- [ ] 所有后端测试通过（`bun test src/__tests__/`）
- [ ] 所有前端测试通过（`bun test web/src/__tests__/`）
- [ ] `bun run typecheck` 无错误
- [ ] 前端构建成功（`bun run build:web`）
