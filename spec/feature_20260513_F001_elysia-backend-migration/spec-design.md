# Feature: 20260513_F001 - elysia-backend-migration

## 需求背景

当前 RCS 后端基于 Hono 框架构建，使用 Hono 的路由、中间件、WebSocket（`upgradeWebSocket`）、静态文件服务等能力。随着项目演进，存在以下动机：

1. **性能**：Elysia 基于 Bun 原生 HTTP（uWebsocket）实现，在 Bun 环境下有显著的请求吞吐优势
2. **类型安全**：Elysia 提供端到端类型推导，路由参数、请求体、响应体均可获得静态类型检查
3. **开发体验**：Elysia 的生命周期（`beforeHandle`/`afterHandle`）、`derive`/`resolve`、macro 等模式比 Hono 中间件链更直观
4. **生态统一**：前端和后端可以共享 Elysia 的类型定义（通过 `@elysia/eden`），实现端到端类型安全的 API 调用

用户选择全量重写策略，采用插件化重写方式（方案 B），将每个功能域封装为 Elysia 插件，充分利用 Elysia 的插件系统和类型推导能力。

## 目标

- 将后端框架从 Hono 完全替换为 Elysia，删除所有 `hono` 依赖
- 以 Elysia 插件模式重新组织所有路由模块，获得端到端类型安全
- 使用 Elysia 原生 better-auth 集成替代当前 Hono 中间件方案
- WebSocket 从 `upgradeWebSocket` 迁移到 Elysia `.ws()` 方法
- SSE 实现脱离 Hono Context 依赖，改用 Web 标准 API
- 前端 API client 改用 `@elysia/eden` 实现类型安全通信
- 保持所有现有功能和 API 接口的兼容性

## 方案设计

### 一、架构总览

迁移后的架构采用 Elysia 插件化分层结构：

```
┌─────────────────────────────────────────────────────┐
│                    Entry Point                       │
│                   src/index.ts                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │              Elysia App (root)                   │ │
│  │  .use(corsPlugin)                               │ │
│  │  .use(loggerPlugin)                             │ │
│  │  .use(authPlugin)     ← better-auth 集成        │ │
│  │  .use(staticPlugin)   ← /ctrl/ 静态文件         │ │
│  │  .use(acpPlugin)      ← ACP WebSocket 路由      │ │
│  │  .use(v1Plugin)       ← /v1 兼容路由            │ │
│  │  .use(webPlugin)      ← /web 控制面板路由        │ │
│  │  .use(mcpPlugin)      ← MCP 知识库路由          │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

每个功能域（domain）封装为独立 Elysia 插件，通过 `.use()` 组合到根应用。插件之间通过 `derive`/`resolve` 共享上下文（如当前用户、认证信息），通过 `guard` 统一保护路由。

### 二、插件结构设计

#### 2.1 公共插件（`src/plugins/`）

公共插件提供横切关注点，被所有路由插件复用。

**`src/plugins/cors.ts`** — CORS 配置

```typescript
import Elysia from 'elysia'
import cors from '@elysiajs/cors'

export const corsPlugin = new Elysia({ name: 'cors' })
  .use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
  }))
```

**`src/plugins/logger.ts`** — 请求日志

```typescript
import Elysia from 'elysia'

export const loggerPlugin = new Elysia({ name: 'logger' })
  .onBeforeHandle(({ request }) => {
    console.log(`[${request.method}] ${new URL(request.url).pathname}`)
  })
```

**`src/plugins/error-handler.ts`** — 全局错误处理

```typescript
import Elysia from 'elysia'

export const errorPlugin = new Elysia({ name: 'error-handler' })
  .onError(({ code, error, request }) => {
    const path = new URL(request.url).pathname
    console.error(`[Error] ${code} ${path}: ${error.message}`)
    return Response.json(
      { error: { type: code, message: error.message } },
      { status: code === 'NOT_FOUND' ? 404 : code === 'VALIDATION' ? 400 : 500 }
    )
  })
```

#### 2.2 认证插件（`src/plugins/auth.ts`）

使用 Elysia 原生 better-auth 集成模式。这是本次迁移最关键的插件。

```typescript
import Elysia from 'elysia'
import { auth } from '../auth/better-auth'

export const authPlugin = new Elysia({ name: 'auth' })
  // 挂载 better-auth handler 到 /api/auth/*
  .mount(auth.handler)
  // 通过 derive 注入认证上下文
  .derive(async ({ request }) => {
    const session = await auth.api.getSession({ headers: request.headers })
    return {
      user: session?.user ? { id: session.user.id, email: session.user.email, name: session.user.name } : null,
      session: session?.session ?? null,
    }
  })
  // 通过 macro 提供 `auth: true` 守卫语法糖
  .macro(({ onBeforeHandle }) => ({
    sessionAuth(enabled: boolean) {
      if (!enabled) return
      onBeforeHandle(({ user }) => {
        if (!user) return Response.json(
          { error: { type: 'unauthorized', message: 'Not authenticated' } },
          { status: 401 }
        )
      })
    },
    apiKeyAuth(enabled: boolean) {
      if (!enabled) return
      onBeforeHandle(async ({ request, store }) => {
        // 三级认证：environment secret → per-user API key → legacy global key
        const token = extractToken(request)
        if (!token) return Response.json(
          { error: { type: 'unauthorized', message: 'Missing API key' } },
          { status: 401 }
        )
        // ... 认证逻辑
      })
    },
  }))
```

路由文件中的使用方式：

```typescript
// 需要 session 认证
app.get('/sessions', ({ user }) => { ... }, { sessionAuth: true })

// 需要 API key 认证
app.post('/bridge', ({ user }) => { ... }, { apiKeyAuth: true })
```

#### 2.3 静态文件插件（`src/plugins/static.ts`）

使用 `@elysiajs/static` 替代 Hono 的 `serveStatic`。

```typescript
import Elysia from 'elysia'
import staticPlugin from '@elysiajs/static'

export const ctrlStaticPlugin = new Elysia({ name: 'static' })
  .use(staticPlugin({
    assets: resolve(__dirname, '../../web/dist'),
    prefix: '/ctrl',
    indexHTML: true, // SPA fallback
  }))
```

`indexHTML: true` 自动处理 SPA 的 client-side routing，不再需要手动为 `/ctrl/:sessionId` 等路径写 fallback。

### 三、路由插件设计

每个路由目录变为一个 Elysia 插件，通过 `prefix` 声明路径前缀。

#### 3.1 `/web/sessions` 插件示例

```typescript
// src/routes/web/sessions.ts
import Elysia from 'elysia'
import { authPlugin } from '../../plugins/auth'
import { storeGetSession, storeListSessionsByUserId } from '../../store'
import { getEventBus } from '../../transport/event-bus'

export const webSessionsPlugin = new Elysia({ prefix: '/web' })
  .use(authPlugin)
  .get('/sessions', ({ user }) => {
    const sessions = storeListSessionsByUserId(user!.id)
    return sessions.map(toSessionResponse)
  }, { sessionAuth: true })
  .get('/sessions/:id', ({ user, params: { id } }) => {
    const session = storeGetSession(id)
    if (!session) return Response.json(
      { error: { type: 'not_found', message: 'Session not found' } },
      { status: 404 }
    )
    if (session.userId && session.userId !== user!.id) return Response.json(
      { error: { type: 'forbidden', message: 'Not your session' } },
      { status: 403 }
    )
    return toSessionResponse(session)
  }, { sessionAuth: true })
  .get('/sessions/:id/history', async ({ params: { id }, request }) => {
    // SSE stream — 使用 Web 标准 API
    return createSSEStream(request, id)
  }, { sessionAuth: true })
```

关键变化：
- `c.get("user")` → 解构 `{ user }`（来自 `derive`）
- `c.req.param("id")` → 解构 `{ params: { id } }`
- `c.json(data)` → 直接返回对象（Elysia 自动 JSON 序列化）
- `c.json({ error }, 404)` → `Response.json({ error }, { status: 404 })`

#### 3.2 `/web/environments` 插件

```typescript
// src/routes/web/environments.ts
import Elysia from 'elysia'
import { authPlugin } from '../../plugins/auth'
import { bodySchema } from './schemas'

export const webEnvironmentsPlugin = new Elysia({ prefix: '/web' })
  .use(authPlugin)
  .get('/environments', ({ user }) => { ... }, { sessionAuth: true })
  .post('/environments', ({ user, body }) => { ... }, {
    sessionAuth: true,
    body: bodySchema,  // Elysia 原生 schema 验证
  })
  .get('/environments/:id', ({ user, params: { id } }) => { ... }, { sessionAuth: true })
  .put('/environments/:id', ({ user, params: { id }, body }) => { ... }, { sessionAuth: true })
  .delete('/environments/:id', ({ user, params: { id } }) => { ... }, { sessionAuth: true })
  .post('/environments/:id/enter', ({ user, params: { id }, body }) => { ... }, { sessionAuth: true })
```

#### 3.3 所有路由插件映射

| 旧文件 | 新插件名 | 路径前缀 |
|--------|---------|---------|
| `routes/web/sessions.ts` | `webSessionsPlugin` | `/web` |
| `routes/web/environments.ts` | `webEnvironmentsPlugin` | `/web` |
| `routes/web/api-keys.ts` | `webApiKeysPlugin` | `/web` |
| `routes/web/config/index.ts` | `webConfigPlugin` | `/web` |
| `routes/web/instances.ts` | `webInstancesPlugin` | `/web` |
| `routes/web/tasks.ts` | `webTasksPlugin` | `/web` |
| `routes/web/channels.ts` | `webChannelsPlugin` | `/web` |
| `routes/web/knowledge-bases.ts` | `webKnowledgeBasesPlugin` | `/web` |
| `routes/web/files.ts` | `webFilesPlugin` | `/web` |
| `routes/web/control.ts` | `webControlPlugin` | `/web` |
| `routes/web/auth.ts` | `webAuthPlugin` | `/web` |
| `routes/web/workflow-proxy.ts` | `workflowProxyPlugin` | `/workflow-ui` |
| `routes/acp/index.ts` | `acpPlugin` | `/acp` |
| `routes/v1/environments.ts` | `v1EnvironmentsPlugin` | `/v1/environments` |
| `routes/mcp/knowledge.ts` | `mcpKnowledgePlugin` | `/` |

### 四、WebSocket 迁移设计

这是迁移中复杂度最高的部分。当前使用 Hono 的 `upgradeWebSocket`，需要迁移到 Elysia 的 `.ws()` 方法。

#### 4.1 Elysia WebSocket 模式

```typescript
// src/routes/acp/index.ts (迁移后)
export const acpPlugin = new Elysia({ prefix: '/acp' })
  .ws('/ws', {
    // 可选：query schema 验证
    query: t.Object({ token: t.Optional(t.String()) }),
    open(ws) {
      // ws.data 包含 validated query params
      const { token } = ws.data.query
      // 认证 + 初始化
      handleAcpWsOpen(ws, ws.data.query.token)
    },
    message(ws, message) {
      // message 已自动解析（支持 string / ArrayBuffer）
      handleAcpWsMessage(ws, typeof message === 'string' ? message : new TextDecoder().decode(message))
    },
    close(ws, code, reason) {
      handleAcpWsClose(ws, code, reason)
    },
    error(ws, error) {
      logError(`[ACP-WS] Error:`, error)
      handleAcpWsClose(ws, 1006, 'websocket error')
    },
  })
  .ws('/relay/:agentId', {
    params: t.Object({ agentId: t.String() }),
    query: t.Object({ sessionId: t.Optional(t.String()) }),
    open(ws) {
      // 从 headers 获取 better-auth session
      // ws.data.params 包含 agentId
      handleRelayOpen(ws, ws.data.params.agentId, ws.data.query.sessionId)
    },
    message(ws, message) {
      handleRelayMessage(ws, typeof message === 'string' ? message : new TextDecoder().decode(message))
    },
    close(ws, code, reason) {
      handleRelayClose(ws, code, reason)
    },
  })
```

#### 4.2 WebSocket handler 接口变更

当前 `acp-ws-handler.ts` 和 `acp-relay-handler.ts` 使用 Hono 的 `WSContext` 类型。迁移后需要改用 Elysia 的 `WS` 类型（基于 uWebsocket 的 `us_socket_context_t`）。

核心差异：

| Hono `WSContext` | Elysia `WS` | 说明 |
|-----------------|-------------|------|
| `ws.send(data)` | `ws.send(data)` | 相同 |
| `ws.close(code, reason)` | `ws.close(code, reason)` | 相同 |
| `ws.readyState` | `ws.readyState` | 相同 |
| `c.req.header()` | `ws.data.headers` | 获取 headers 的方式不同 |
| `c.req.query()` | `ws.data.query` | query 已通过 schema 验证 |

由于 Elysia 的 `WS` 和 Hono 的 `WSContext` 接口非常接近（都是 `send`/`close`/`readyState`），可以定义一个最小化的接口类型来解耦：

```typescript
// src/transport/ws-types.ts
export interface WsConnection {
  send(data: string): void
  close(code?: number, reason?: string): void
  readonly readyState: number
}
```

所有 handler 函数改为依赖 `WsConnection` 接口，而非具体的 Hono/Elysia 类型。

### 五、SSE 迁移设计

当前 SSE 实现依赖 Hono `Context` 的 `c.req.raw.signal`（用于 abort 检测）。迁移后改用 Web 标准 `Request` 对象。

```typescript
// src/transport/sse-writer.ts (迁移后)
export function createSSEStream(request: Request, sessionId: string, fromSeqNum = 0): Response {
  const bus = getEventBus(sessionId)
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      // ... 历史事件重发、订阅、keepalive 逻辑完全不变

      // abort 检测：直接使用 request.signal
      request.signal.addEventListener('abort', () => {
        unsub()
        clearInterval(keepalive)
        try { controller.close() } catch {}
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}
```

核心变化：函数签名从 `createSSEStream(c: Context, ...)` 改为 `createSSEStream(request: Request, ...)`，内部 `c.req.raw.signal` 改为 `request.signal`。业务逻辑完全不变。

同样的模式适用于 `createWorkerEventStream` 和 `createAcpSSEStream`。

### 六、入口文件设计

```typescript
// src/index.ts (迁移后)
import Elysia from 'elysia'
import { corsPlugin } from './plugins/cors'
import { loggerPlugin } from './plugins/logger'
import { errorPlugin } from './plugins/error-handler'
import { authPlugin } from './plugins/auth'
import { ctrlStaticPlugin } from './plugins/static'
import { acpPlugin } from './routes/acp'
import { v1EnvironmentsPlugin } from './routes/v1/environments'
import { webSessionsPlugin } from './routes/web/sessions'
import { webEnvironmentsPlugin } from './routes/web/environments'
// ... 其他插件

const app = new Elysia()
  .use(corsPlugin)
  .use(loggerPlugin)
  .use(errorPlugin)
  .use(authPlugin)
  .use(ctrlStaticPlugin)
  .use(acpPlugin)
  .use(v1EnvironmentsPlugin)
  .use(webSessionsPlugin)
  .use(webEnvironmentsPlugin)
  // ... 其他路由插件
  .get('/health', () => ({ status: 'ok', version: config.version }))
  .get('/', ({ redirect }) => redirect('/ctrl/'))

// 启动逻辑（与当前相同）
await migrateSkillsDir()
await startScheduler()
storeLoadSessionsFromDB()
// ... auto-start instances, Hermes client 等

const port = config.port
const host = config.host

console.log(`[RCS] Remote Control Server starting on ${host}:${port}`)

export default { port, hostname: host, fetch: app.fetch }
```

Elysia 的 Bun 导出格式与 Hono 兼容，都是 `{ port, hostname, fetch }`，但不再需要 `websocket` 字段（Elysia 的 `.ws()` 自动注册到 Bun 的 WebSocket 处理器）。

### 七、前端 API Client 迁移

#### 7.1 使用 `@elysia/eden` 实现端到端类型安全

```typescript
// web/src/api/client.ts (迁移后)
import { edenTreaty } from '@elysia/eden'
import type { App } from '../../../src/index' // 共享服务端类型

const api = edenTreaty<App>('', {
  fetch: { credentials: 'include' } // 保持 cookie 携带
})

// 使用时有完整类型推导
const sessions = await api.web.sessions.get() // 类型自动推导
```

#### 7.2 兼容方案

如果 `@elysia/eden` 与当前前端构建工具链（Vite + React）存在兼容问题，可以保留当前 fetch-based API client 模式，仅更新路由路径和响应处理。前端代码不需要在本次迁移中全部改完。

### 八、依赖变更

#### 删除的依赖

```jsonc
{
  "hono": "^4.7.0"  // 删除
}
```

#### 新增的依赖

```jsonc
{
  "elysia": "^1.3.0",
  "@elysiajs/cors": "^1.3.0",
  "@elysiajs/static": "^1.2.0",
  "@elysia/eden": "^1.2.0"  // 前端类型安全 client（可选）
}
```

#### 不受影响的依赖

- `drizzle-orm`、`better-auth`、`uuid`、`zod` 等业务依赖完全不变
- `@ai-sdk/react`、`react`、`react-dom` 等前端依赖不变
- `vite`、`@vitejs/plugin-react`、`tailwindcss` 等构建工具不变

### 九、文件变更清单

#### 新增文件

| 文件路径 | 说明 |
|---------|------|
| `src/plugins/cors.ts` | CORS 插件 |
| `src/plugins/logger.ts` | 请求日志插件 |
| `src/plugins/error-handler.ts` | 全局错误处理插件 |
| `src/plugins/auth.ts` | 认证插件（better-auth 集成 + macro） |
| `src/plugins/static.ts` | 静态文件服务插件 |
| `src/transport/ws-types.ts` | WebSocket 抽象接口 |

#### 修改文件（约 30 个）

| 类别 | 文件 | 变更说明 |
|------|------|---------|
| 入口 | `src/index.ts` | Hono → Elysia，插件组装 |
| 认证 | `src/auth/middleware.ts` | 重写为 Elysia 插件 + macro |
| 路由 | `src/routes/web/sessions.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/environments.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/api-keys.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/config/index.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/config/*.ts` | 子模块配置路由 |
| 路由 | `src/routes/web/instances.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/tasks.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/channels.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/knowledge-bases.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/files.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/control.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/auth.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/web/workflow-proxy.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/acp/index.ts` | WebSocket 迁移 |
| 路由 | `src/routes/v1/environments.ts` | Hono → Elysia 插件 |
| 路由 | `src/routes/v1/*.ts` | V1 兼容路由 |
| 路由 | `src/routes/mcp/knowledge.ts` | Hono → Elysia 插件 |
| 传输 | `src/transport/sse-writer.ts` | Context → Request |
| 传输 | `src/transport/acp-sse-writer.ts` | Context → Request |
| 传输 | `src/transport/acp-ws-handler.ts` | WSContext → WsConnection |
| 传输 | `src/transport/acp-relay-handler.ts` | WSContext → WsConnection |
| 传输 | `src/transport/ws-shared.ts` | 删除（不再需要） |
| 传输 | `src/transport/ws-handler.ts` | WSContext → WsConnection |
| 前端 | `web/src/api/client.ts` | 迁移到 eden 或更新 fetch |

#### 不变文件

- `src/store.ts` — 纯内存 Map + SQLite，无框架依赖
- `src/config.ts` — 纯配置常量
- `src/db/**` — Drizzle ORM schema 和连接
- `src/auth/better-auth.ts` — better-auth 实例配置
- `src/auth/api-key-service.ts` — 纯业务逻辑
- `src/services/**` — 业务服务层（config, skill, instance, task, scheduler, session 等）
- `src/transport/event-bus.ts` — 纯事件总线，无框架依赖
- `src/transport/client-payload.ts` — 纯数据转换
- `web/src/components/**` — 前端组件不变
- `web/src/pages/**` — 前端页面不变（API client 层屏蔽了框架变化）

### 十、实现顺序

推荐按依赖关系从底层到上层实现：

**Phase 1：基础设施层（无路由变化）**

1. 安装 Elysia 依赖，删除 Hono 依赖
2. 创建 `src/plugins/` 目录和公共插件（cors, logger, error-handler）
3. 创建 `src/transport/ws-types.ts` 抽象接口
4. 重写 SSE writer 函数签名（Context → Request）

**Phase 2：认证插件**

5. 实现 `src/plugins/auth.ts`（better-auth mount + derive + macro）
6. 验证 `/api/auth/*` 路由和 `sessionAuth` 宏是否工作

**Phase 3：WebSocket 迁移**

7. 迁移 `acp-ws-handler.ts`（WSContext → WsConnection）
8. 迁移 `acp-relay-handler.ts`（WSContext → WsConnection）
9. 重写 `src/routes/acp/index.ts`（upgradeWebSocket → .ws()）

**Phase 4：路由插件迁移**

10. 逐个迁移 `/v1/environments` 和 `/web/*` 路由文件
11. 实现 `src/plugins/static.ts` 和 `workflow-proxy.ts`
12. 重写 `src/index.ts` 入口组装

**Phase 5：前端集成**

13. 更新 `web/src/api/client.ts`（eden 或保留 fetch）
14. 端到端测试所有 API 接口

### 十一、测试策略

- 每个 Phase 完成后运行 `bun test src/__tests__/` 确保后端测试通过
- Phase 3 完成后手动验证 WebSocket 连接（acp-link 注册 + relay 通信）
- Phase 4 完成后运行 `bun run build:web` 构建前端，验证静态文件服务
- Phase 5 完成后进行完整端到端验收
- 需要更新的测试文件：所有 `src/__tests__/` 中 mock 了 Hono 的测试

## 实现要点

1. **WebSocket handler 解耦**：定义 `WsConnection` 接口，让 `acp-ws-handler.ts` 和 `acp-relay-handler.ts` 不依赖任何框架的 WebSocket 类型，降低迁移风险
2. **Elysia macro 模式**：`sessionAuth` 和 `apiKeyAuth` 作为 macro 提供，路由声明时可写 `{ sessionAuth: true }`，比 Hono 的中间件链更简洁且类型安全
3. **SSE 函数签名变更**：从 `Hono Context` 改为 `Request`，这是最小改动路径——内部逻辑完全不变，只是入参类型变了
4. **静态文件 SPA**：`@elysiajs/static` 的 `indexHTML: true` 自动处理 SPA fallback，消除了当前入口文件中为 `/ctrl/:sessionId` 等路径手动写 fallback 的样板代码
5. **路径规范化中间件**：当前入口中手动处理 `//` 的中间件，在 Elysia 中可以通过 `onBeforeHandle` 全局处理
6. **better-auth 挂载**：使用 Elysia 的 `.mount(auth.handler)` 方式，将 better-auth 的请求处理直接挂载到 `/api/auth/*`，无需手动 `app.on(["POST", "GET"], "/api/auth/*", handler)`
7. **Bun 导出格式兼容**：Elysia 和 Hono 都使用 `{ port, hostname, fetch }` 导出格式，但 Elysia 的 WebSocket 自动集成到 Bun 的 uWebsocket 层，不需要手动导出 `websocket` 配置
8. **前端兼容**：`@elysia/eden` 提供的 treaty client 与当前 fetch-based client 的行为差异需要验证，特别是 `credentials: 'include'` 和错误处理。如果 eden 不兼容，可以保留当前 fetch 模式

## 验收标准

- [ ] 所有 `hono` 相关依赖从 `package.json` 中移除，`elysia` 及相关插件正确安装
- [ ] 后端启动正常，`bun run dev` 无报错
- [ ] `/api/auth/*` 路由正常工作（better-auth 注册、登录、会话读取）
- [ ] `/web/*` 所有 API 接口行为与迁移前一致
- [ ] `/acp/ws` WebSocket 连接正常（acp-link 注册、消息收发、保活）
- [ ] `/acp/relay/:agentId` WebSocket relay 正常（前端↔Agent 双向通信）
- [ ] `/ctrl/*` 静态文件服务正常（SPA 路由、index.html fallback）
- [ ] SSE 事件流正常推送（会话历史、keepalive）
- [ ] 前端 `bun run dev:web` 开发模式正常
- [ ] 前端 `bun run build:web` 构建成功
- [ ] 所有后端测试 `bun test src/__tests__/` 通过
- [ ] 代码中无任何 `from "hono"` 或 `from "hono/bun"` 或 `from "hono/ws"` 的导入
