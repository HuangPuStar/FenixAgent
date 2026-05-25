# Architecture Refactor Plan

基于架构分析识别的 6 个深度化机会，通过 grilling 确认的设计决策汇总。

## 执行顺序

候选 1（Repository）是其他候选的基础依赖，必须最先执行。候选 5（Auth）和候选 6（EventBus）相互独立，可并行。候选 2、3、4 可在候选 1 完成后并行推进。

```
候选 1: Store → Repository
  ├── 候选 5: Auth Consolidation
  ├── 候选 6: EventBus Service Wrapper
  ├── 候选 2: Config Module 抽象
  ├── 候选 4: 路由业务逻辑提取（依赖候选 2）
  └── 候选 3: 前端 Eden 统一
```

## 候选 1: Store 拆分为领域仓储 (ADR-0001)

### 仓储清单

| 仓储 | 文件 | 底层存储 | 现有函数 |
|------|------|---------|---------|
| EnvironmentRepo | `repositories/environment.ts` | PostgreSQL | storeCreate/Get/Update/Delete/List Environment, GetBySecret |
| SessionRepo | `repositories/session.ts` | 内存 Map | storeCreate/Get/List/Delete Session, ListByEnvironment, ListForAgentByCwd, ListByUserId |
| SessionWorkerRepo | `repositories/session-worker.ts` | 内存 Map | storeGetSessionWorker, storeUpsertSessionWorker |
| ShareLinkRepo | `repositories/share-link.ts` | PostgreSQL | storeCreate/Get/List/Delete ShareLink, CreateEventSnapshot |
| TokenRepo | `repositories/token.ts` | 内存 Map | storeCreateToken, storeGetUserByToken |
| WorkItemRepo | `repositories/work-item.ts` | 内存 Map | storeSet/Get/DeleteWorkItem |

### 关键步骤

1. 创建 `src/repositories/` 目录
2. 每个仓储定义 interface（如 `IEnvironmentRepo`）和实现（如 `PgEnvironmentRepo`）
3. 内存 Map 仓储也包装为 async 接口
4. 创建 `src/plugins/repositories.ts`，用 `.decorate()` 注入全局单例
5. 在 `src/index.ts` 挂载 repoPlugin
6. 所有调用者从 `import { storeGetEnvironment } from "../store"` 改为 `({ environmentRepo }) => environmentRepo.getEnvironment()`
7. 级联删除逻辑移入 service 层（如 `environment.ts` service）
8. Transport 层通过 service 层访问仓储，不直接导入
9. 删除 `src/store.ts`

### DI 示例

```typescript
// src/plugins/repositories.ts
import { Elysia } from "elysia";
import { db } from "../db";

const repoPlugin = new Elysia({ name: "repositories" })
  .decorate({
    environmentRepo: new PgEnvironmentRepo(db),
    sessionRepo: new SessionRepo(),       // 内存 Map
    sessionWorkerRepo: new SessionWorkerRepo(),
    shareLinkRepo: new PgShareLinkRepo(db),
    tokenRepo: new TokenRepo(),
    workItemRepo: new WorkItemRepo(),
  });

// 路由中使用
app.get("/environments", async ({ environmentRepo, store }) => {
  const user = store.user!;
  return environmentRepo.listByUser(user.id);
}, { sessionAuth: true });
```

## 候选 2: Config-pg 统一抽象 (ADR-0002)

### 关键步骤

1. 创建 `src/services/config-utils.ts`，抽取公共工具函数：
   - `jsonbParse<T>(value: unknown): T | null` — JSONB 反序列化
   - `jsonbStringify(value: unknown): string | null` — JSONB 序列化
   - `wrapConfigSuccess<T>(data: T)` — 统一成功响应
   - `wrapConfigError(code: string, message: string)` — 统一错误响应
2. 每个配置路由文件注册自己的 body schema（Zod），替代 `ConfigBodySchema`
3. `AGENT_SETTABLE_FIELDS` 改为从 schema key 推断：`Object.keys(AgentCreateBodySchema.shape)`
4. 其他模块同理

## 候选 3: 前端 Eden 统一 (ADR-0003)

### 关键步骤

1. 删除 `apiFetch` 函数和所有包装函数（`apiCreateSession`、`apiFetchSession` 等）
2. 将 `NewSessionDialog` 改为 `client.web.sessions.post({ ... })`
3. 将 `rcs-chat-adapter` 改为 `client.web.sessions({ id })["history"].get()`
4. 前端为尚未注册 body schema 的 POST 路由手动定义请求类型
5. `fetchUpload` 暂时保留，等上传方案确定后替换
6. 消除所有 `as unknown as` 双重断言

## 候选 4: 路由业务逻辑提取 (ADR-0004)

### 关键步骤

1. 创建 `src/errors/` 目录，定义自定义错误类：
   - `ValidationError(message: string)`
   - `NotFoundError(resource: string, id: string)`
   - `ConflictError(message: string)`
   - `ForbiddenError(message: string)`
2. 在 Elysia 全局 `onError` 中匹配错误类，转换为 HTTP 状态码和响应格式
3. `environments.ts` 的 88 行创建逻辑 → `environmentService.register()`
4. `knowledge-bases.ts` 的上传重试逻辑 → `knowledgeService.uploadResources()`
5. 路由处理器只保留：参数解析 → 调用 service → 返回响应

### 错误处理示例

```typescript
// Service 层
async function registerEnvironment(userId: string, params: CreateEnvParams) {
  if (!isValidName(params.name)) throw new ValidationError("name 格式无效");
  const existing = await environmentRepo.getByName(params.name, userId);
  if (existing) throw new ConflictError(`环境 '${params.name}' 已存在`);
  return environmentRepo.create({ ...params, userId });
}

// Elysia onError
app.onError(({ code, error, set }) => {
  if (error instanceof ValidationError) {
    set.status = 400;
    return { error: { type: "VALIDATION_ERROR", message: error.message } };
  }
  if (error instanceof NotFoundError) {
    set.status = 404;
    return { error: { type: "NOT_FOUND", message: error.message } };
  }
  // ... 其他错误类
});

// 路由处理器（只有 happy path）
app.post("/environments", async ({ store, body, environmentRepo }) => {
  const user = store.user!;
  return environmentService.register(user.id, body);
}, { sessionAuth: true });
```

## 候选 5: 认证碎片化清理 (ADR-0005)

### 关键步骤

1. 将 `auth/api-key.ts` 的 `validateApiKey()` 合并到 `auth/api-key-service.ts` 作为 fallback
2. 删除 `auth/middleware.ts`，将 `routes/acp/index.ts` 的引用改为 `authGuardPlugin`
3. 统一 `ensureSystemUser()` — 删除 `routes/acp/index.ts` 中的重复实现，改为导入 `plugins/auth.ts`
4. `v1/session-ingress.ts` 改用 `authGuardPlugin` 的 `apiKeyAuth` macro

## 候选 6: EventBus 薄封装 (ADR-0006)

### 关键步骤

1. 创建 `src/services/event-service.ts`，薄封装 EventBus：
   - `publishEvent(sessionId: string, event: Omit<SessionEvent, "seqNum" | "createdAt">): SessionEvent`
   - `subscribe(sessionId: string, callback: Subscriber): () => void`
   - `getEventsSince(sessionId: string, seqNum: number): SessionEvent[]`
   - `getAcpEvent(sessionId: string): EventBus`
2. 通过 `.decorate()` 注入全局单例
3. 11 个文件从 `import { getEventBus } from "..."` 改为 `({ eventService }) => eventService.publishEvent(...)`
4. `event-bus.ts` 保持不变，只是不再被直接导入

## 影响范围

| 文件 | 涉及候选 |
|------|---------|
| `src/store.ts` | 1 (删除) |
| `src/index.ts` | 1, 6 (挂载 plugin) |
| `src/plugins/auth.ts` | 5 (合并 api-key, 统一 ensureSystemUser) |
| `src/auth/api-key.ts` | 5 (删除) |
| `src/auth/middleware.ts` | 5 (删除) |
| `src/transport/acp-ws-handler.ts` | 1, 6 (改 import) |
| `src/transport/acp-relay-handler.ts` | 1, 6 (改 import) |
| `src/transport/event-bus.ts` | 6 (不再被直接导入) |
| `src/routes/web/environments.ts` | 1, 4 (拆分业务逻辑) |
| `src/routes/web/config/*.ts` | 2 (注册 body schema) |
| `src/services/config-pg.ts` | 2 (抽取 utils) |
| `src/routes/v1/session-ingress.ts` | 5 (改用 macro) |
| `src/routes/acp/index.ts` | 5 (删除重复 ensureSystemUser) |
| `web/src/api/client.ts` | 3 (删除 apiFetch) |
| `web/src/components/NewSessionDialog.tsx` | 3 (改用 Eden) |
| `web/src/lib/rcs-chat-adapter.ts` | 3 (改用 Eden) |
| `web/src/components/FilePickerDialog.tsx` | 3 (改用 Eden) |
