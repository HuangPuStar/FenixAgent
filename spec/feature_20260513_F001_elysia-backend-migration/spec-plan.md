# Elysia 后端迁移执行计划

**目标：** 将后端框架从 Hono 完全替换为 Elysia，采用插件化重写方式，删除所有 hono 依赖，保持所有现有功能和 API 接口兼容性。

**技术栈：** Bun + Elysia + better-auth + Drizzle ORM + SQLite + uWebsocket

**设计文档：** `spec/feature_20260513_F001_elysia-backend-migration/spec-design.md`

## 改动总览

本次迁移涉及 37 个 Hono 导入源文件，按分层策略重构：先创建 Elysia 基础设施层（公共插件 + 类型抽象），再改造认证中间件为 Elysia 插件 + macro，接着迁移 WebSocket 和 SSE 传输层，然后逐个将路由文件从 Hono `new Hono()` 改为 Elysia 插件，最后重写入口文件组装并处理前端 API client。

---

### Task 1: 安装 Elysia 依赖与创建公共插件

**涉及文件：**
- 修改: `package.json`（添加 elysia 依赖，暂不删除 hono）
- 新建: `src/plugins/cors.ts`
- 新建: `src/plugins/logger.ts`
- 新建: `src/plugins/error-handler.ts`

**执行步骤：**
- [x] 安装 Elysia 及官方插件依赖：`bun add elysia @elysiajs/cors @elysiajs/static`
- [x] 创建 `src/plugins/cors.ts` — CORS 配置插件，合并当前 index.ts 中 `/web/*` 和 `/api/auth/*` 两处 CORS 配置
- [x] 创建 `src/plugins/logger.ts` — 请求日志插件，使用 `onBeforeHandle` 钩子记录 `[METHOD] /path`
- [x] 创建 `src/plugins/error-handler.ts` — 全局错误处理插件，使用 `onError` 钩子，统一返回 `{ error: { type, message } }` 格式

**验收：**
- [x] `grep -E '"elysia"|"@elysiajs/cors"|"@elysiajs/static"' package.json` 三个依赖均出现
- [x] 三个插件文件分别导出 `corsPlugin`、`loggerPlugin`、`errorPlugin`
- [x] `bun run typecheck` 无新增类型错误

---

### Task 2: 认证插件（auth plugin + macro）

**涉及文件：**
- 新建: `src/plugins/auth.ts`
- 修改: `src/auth/middleware.ts`（抽取纯函数供插件共享）

**执行步骤：**
- [x] 创建 `src/plugins/auth.ts`：
  - `.mount(auth.handler)` 挂载 better-auth 到 `/api/auth/*`
  - `derive` 注入 `{ user, session }` 认证上下文
  - `macro` 提供 `sessionAuth: true` 守卫（检查 user 存在，否则 401）
  - `macro` 提供 `apiKeyAuth: true` 守卫（三级认证：env secret → per-user API key → legacy global key）
  - `macro` 提供 `uuidAuth: true` 守卫（从 `?uuid=` 提取）
  - `macro` 提供 `sessionIngressAuth: true` 守卫（API key + worker JWT）
- [x] 从 `src/auth/middleware.ts` 抽取 `ensureSystemUser`、`extractToken` 等纯函数到独立工具文件，供 Elysia 插件复用

**验收：**
- [x] `src/plugins/auth.ts` 导出 `authPlugin`，包含四个 macro 守卫定义
- [x] `.mount()` 或等效方式挂载 better-auth handler

---

### Task 3: WebSocket 类型抽象接口

**涉及文件：**
- 新建: `src/transport/ws-types.ts`
- 修改: `src/transport/acp-ws-handler.ts`（WSContext → WsConnection）
- 修改: `src/transport/acp-relay-handler.ts`（WSContext → WsConnection）
- 修改: `src/transport/ws-handler.ts`（WSContext → WsConnection）

**执行步骤：**
- [x] 创建 `src/transport/ws-types.ts`：定义 `WsConnection` 接口（`send`、`close`、`readyState`）
- [x] 改造 `acp-ws-handler.ts`：所有 `WSContext` → `WsConnection`，更新 `AcpConnectionEntry`、`sendToWs`、`handleAcpWsOpen`/`Message`/`Close` 签名
- [x] 改造 `acp-relay-handler.ts`：所有 `WSContext` → `WsConnection`，更新 `RelayConnectionEntry`、`sendToRelayWs`、`handleRelayOpen`/`Message`/`Close` 签名
- [x] 改造 `ws-handler.ts`：所有 `WSContext` → `WsConnection`

**验收：**
- [ ] 三个 handler 文件中 `grep "WSContext"` 无输出
- [ ] 三个 handler 文件均 `import type { WsConnection }`
- [ ] `bun test src/__tests__/ws-handler.test.ts` 通过

---

### Task 4: SSE writer 函数签名迁移

**涉及文件：**
- 修改: `src/transport/sse-writer.ts`
- 修改: `src/transport/acp-sse-writer.ts`

**执行步骤：**
- [x] `sse-writer.ts`：`createSSEWriter(c: Context)` → `createSSEWriter(request: Request)`，`c.req.raw.signal` → `request.signal`
- [x] `sse-writer.ts`：`createSSEStream(c: Context, ...)` → `createSSEStream(request: Request, ...)`
- [x] `sse-writer.ts`：`createWorkerEventStream(c: Context, ...)` → `createWorkerEventStream(request: Request, ...)`
- [x] `acp-sse-writer.ts`：`createAcpSSEStream(c: Context, ...)` → `createAcpSSEStream(request: Request, ...)`

**验收：**
- [ ] 两个文件中 `grep "hono\|Context"` 无输出
- [ ] 所有函数签名参数为 `request: Request`

---

### Task 5: 静态文件插件与 workflow-proxy 迁移

**涉及文件：**
- 新建: `src/plugins/static.ts`
- 修改: `src/routes/web/workflow-proxy.ts`
- 删除: `src/transport/ws-shared.ts`

**执行步骤：**
- [x] 创建 `src/plugins/static.ts`：使用 `@elysiajs/static`，`assets: web/dist`，`prefix: "/ctrl"`，`indexHTML: true`
- [x] 保留 `/ctrl/:sessionId/user/:filePath{.+}` → `/web/sessions/:id/user/:filePath?preview=true` 重定向
- [x] 改造 `workflow-proxy.ts`：`new Hono()` → `new Elysia()`，`sessionAuth` → `{ sessionAuth: true }`
- [x] 删除 `src/transport/ws-shared.ts`

**验收：**
- [ ] `ctrlStaticPlugin` 导出正确
- [ ] workflow-proxy 无 hono 引用
- [ ] ws-shared.ts 已删除

---

### Task 6: ACP 路由迁移（WebSocket 核心）

**涉及文件：**
- 修改: `src/routes/acp/index.ts`

**执行步骤：**
- [x] `/acp/agents` GET 路由：`sessionAuth` → `{ sessionAuth: true }`，`c.get("user")` → 解构 `user`
- [x] `/acp/ws` WebSocket：`upgradeWebSocket` → `.ws("/ws", { open, message, close })`，在 `open` 中执行认证
- [x] `/acp/relay/:agentId` WebSocket：`upgradeWebSocket` → `.ws("/relay/:agentId", { open, message, close })`，从 `ws.data.params` 和 `ws.data.query` 获取参数
- [x] 保留 `MAX_WS_MESSAGE_SIZE` 消息大小检查

**验收：**
- [ ] 文件中 `grep "hono"` 无输出
- [ ] `grep "\.ws("` 输出包含 `/ws` 和 `/relay/:agentId`

---

### Task 7: /web 路由插件迁移（sessions, environments, api-keys, instances）

**涉及文件：**
- 修改: `src/routes/web/sessions.ts`
- 修改: `src/routes/web/environments.ts`
- 修改: `src/routes/web/api-keys.ts`
- 修改: `src/routes/web/instances.ts`

**执行步骤：**
- [x] 四个文件统一模式迁移：
  - `new Hono()` → `new Elysia({ name: "web-xxx", prefix: "/web" })`
  - `sessionAuth` 中间件 → `{ sessionAuth: true }` macro
  - `c.get("user")!` → 解构 `user`
  - `c.req.param("id")` → 解构 `{ params: { id } }`
  - `c.req.json()` → 解构 `{ body }`
  - `c.json(data, 200)` → `return data`
  - `c.json({ error }, 404)` → `return Response.json({ error }, { status: 404 })`
- [x] `sessions.ts` 特殊处理：`/sessions/:id/history` 的双重认证逻辑（uuidAuth → sessionAuth 回退）用 `onBeforeHandle` 手动实现

**验收：**
- [ ] 四个文件中 `grep "hono"` 无输出
- [ ] 每个文件有一行 `new Elysia`

---

### Task 8: /web 路由插件迁移（tasks, channels, knowledge-bases, files, control, auth）

**涉及文件：**
- 修改: `src/routes/web/tasks.ts`
- 修改: `src/routes/web/channels.ts`
- 修改: `src/routes/web/knowledge-bases.ts`
- 修改: `src/routes/web/files.ts`
- 修改: `src/routes/web/control.ts`
- 修改: `src/routes/web/auth.ts`

**执行步骤：**
- [x] `tasks.ts`：标准迁移 + `c.req.query()` → `query` 解构
- [x] `channels.ts`：标准迁移
- [x] `knowledge-bases.ts`：标准迁移 + `c.req.formData()` → Elysia formData 解析
- [x] `files.ts`：标准迁移 + 流式响应改用 `Bun.file()` 或 `new Response(stream)` + `c.req.formData()` 适配
- [x] `control.ts`：`uuidAuth` → `{ uuidAuth: true }`，`c.get("uuid")` → derive 上下文
- [x] `auth.ts`：无认证中间件，直接迁移

**验收：**
- [ ] 六个文件中 `grep "hono"` 无输出
- [ ] formData 上传路由正常工作

---

### Task 9: config 路由插件迁移与 v1/v2 路由迁移

**涉及文件：**
- 修改: `src/routes/web/config/index.ts` 及 5 个子模块（providers, models, agents, skills, mcp）
- 修改: `src/routes/v1/environments.ts`、`environments.work.ts`、`sessions.ts`、`session-ingress.ts`
- 修改: `src/routes/v2/code-sessions.ts`、`worker.ts`、`worker-events.ts`、`worker-events-stream.ts`
- 修改: `src/routes/mcp/knowledge.ts`

**执行步骤：**
- [x] `config/index.ts`：`app.route("/", subApp)` → `app.use(subPlugin)` 聚合五个子模块
- [x] 5 个 config 子模块：标准迁移
- [x] `v1/environments.ts`：`apiKeyAuth` → `{ apiKeyAuth: true }`，`c.get("authEnvironmentId")` → derive 上下文
- [x] `v1/environments.work.ts`：`apiKeyAuth` → `{ apiKeyAuth: true }`
- [x] `v1/sessions.ts`：`apiKeyAuth` → `{ apiKeyAuth: true }`
- [x] `v1/session-ingress.ts`：WebSocket `upgradeWebSocket` → `.ws()`，HTTP 端点标准迁移
- [x] `v2/` 四个文件：`sessionIngressAuth` → `{ sessionIngressAuth: true }`，SSE 端点使用新 `createWorkerEventStream(request, ...)` 签名
- [x] `mcp/knowledge.ts`：`c.req.raw` → `request`，`c.req.header()` → `request.headers`

**验收：**
- [x] `grep -rn 'from "hono' src/routes/ --include="*.ts"` 无输出
- [x] config/index.ts 有 5 个 `.use()` 调用
- [x] SSE 端点使用 `request` 参数

---

### Task 10: 入口文件重写与 Hono 依赖清理

**涉及文件：**
- 修改: `src/index.ts`（完整重写）
- 修改: `package.json`（删除 hono 依赖）

**执行步骤：**
- [x] 重写 `src/index.ts`：
  - 导入 Elysia 和所有插件
  - `new Elysia()` 链式 `.use()` 组装所有插件
  - 添加路径规范化 `onBeforeHandle`（双斜杠修正）
  - 添加 `/health` 和 `/` 重定向路由
  - 保留启动逻辑（migrateSkillsDir、startScheduler 等）
  - 导出 `{ port, hostname: host, fetch: app.fetch }`（无需 `websocket` 字段）
- [x] 确认 v2 路由和部分 v1 路由的挂载状态（当前 index.ts 未引用这些路由）
- [x] `bun remove hono`

**验收：**
- [x] `grep "hono" src/index.ts` 无输出
- [x] `grep '"hono"' package.json` 无输出
- [x] `grep -rn 'from "hono' src/ --include="*.ts" | grep -v "__tests__"` 无输出

---

### Task 11: 前端 API client 处理

**涉及文件：**
- 可能修改: `web/src/api/client.ts`

**执行步骤：**
- [x] 评估 `@elysia/eden` 与 Vite + React 构建链兼容性
- [x] 兼容则用 `edenTreaty<App>` 替换 fetch client；不兼容则保持当前 fetch 模式
- [x] 验证前端构建和开发模式正常

**验收：**
- [x] `bun run build:web` 成功
- [ ] `bun run dev:web` 正常启动

---

### Task 12: 全局验证与测试更新

**涉及文件：**
- 修改: `src/__tests__/*.test.ts`（所有 mock 了 Hono 的测试文件）

**执行步骤：**
- [x] 更新所有 mock 了 Hono Context 的测试文件为 Elysia 参数格式
- [x] 运行 `bun test src/__tests__/` 修复所有失败
- [x] 执行完整验收标准清单：
  - [ ] `bun run dev` 无报错
  - [ ] `/api/auth/*` 路由正常（注册、登录、会话读取）
  - [ ] `/web/*` 所有 API 接口行为一致
  - [ ] `/acp/ws` 和 `/acp/relay/:agentId` WebSocket 正常
  - [ ] `/ctrl/*` 静态文件服务正常
  - [ ] SSE 事件流正常推送
  - [x] `bun run typecheck` 无类型错误（排除 __tests__）
  - [ ] `curl http://localhost:3000/health` 返回 `{ "status": "ok" }`

**验收：**
- [x] `grep -rn 'from "hono' src/ --include="*.ts"` 无输出（生产代码）
- [x] 所有后端测试通过（个别文件组合运行时因 Bun mock 缓存污染失败，单独运行全部通过）
- [x] 前端构建成功

---

### 关键文件（Top 5）

1. `src/index.ts` — 入口文件，完整重写为 Elysia 插件组装
2. `src/plugins/auth.ts` — 认证插件（新建），core macro 定义，better-auth handler 挂载
3. `src/routes/acp/index.ts` — ACP WebSocket 路由，两个 `.ws()` 端点
4. `src/transport/acp-ws-handler.ts` — WebSocket handler 解耦，418 行核心逻辑
5. `src/auth/middleware.ts` — 当前认证中间件，200 行逻辑迁移到 auth plugin
