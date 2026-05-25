# 架构深度化候选（第二轮）

> 基于第一轮重构（ADR-0001~0006）后的代码库现状分析。
> 日期：2026-05-15

---

## 候选 1：完成 ADR-0004 — 路由层采纳自定义错误类

**Files**: `src/errors/index.ts`, `src/plugins/error-handler.ts`, `src/routes/web/*.ts`, `src/routes/v1/*.ts`, `src/routes/v2/*.ts`

**Problem**: ADR-0004 定义了 `ValidationError`/`NotFoundError`/`ConflictError`/`ForbiddenError`，`error-handler.ts` 配置了全局 `onError`。但几乎所有路由仍在手动构造 `{ error: { type, message } }` 响应，没有 throw 自定义错误类。这是一次半途而废的重构。

**Solution**: 逐个路由文件将手动错误响应替换为 `throw new NotFoundError(...)` 等抛出，让 Elysia 全局 `onError` 统一捕获转换。路由处理器只写 happy path。config 路由中的 `configError()`/`configNotFound()` 等手动构造函数也替换为 throw + 全局捕获。

**Benefits**:
- **Locality**: 错误格式化逻辑集中在 `errors/index.ts` 一处，不在 20+ 个路由处理器中重复
- **Leverage**: 路由处理器变薄，每个路由减少 5-15 行错误处理代码
- **Test surface**: 可以通过测试 Service 层抛出的错误类型来验证业务逻辑，不需要构造 HTTP 响应

---

## 候选 2：完成 ADR-0006 — Transport 层迁移到 eventService

**Files**: `src/transport/ws-handler.ts`, `src/transport/acp-ws-handler.ts`, `src/transport/acp-relay-handler.ts`, `src/transport/sse-writer.ts`, `src/transport/acp-sse-writer.ts`, `src/services/event-service.ts`

**Problem**: ADR-0006 创建了 `eventService` 薄封装，但 Transport 层全部 5 个文件仍然直接 `import { getEventBus } from "./event-bus"`。只有 Service 层和 Route 层在正确使用 `eventService`。这制造了两种访问 EventBus 的路径，违反了"单一访问点"约束。

**Solution**: 将 Transport 层的 `getEventBus`/`getAcpEventBus` 直接导入替换为 `eventService.getBus()`/`eventService.getAcpBus()`。不改业务逻辑，只改 import 路径。

**Benefits**:
- **Locality**: EventBus 访问路径统一，未来修改 EventBus 实现只需改 eventService 一处
- **Seam**: eventService 成为真正的 seam——可以在此插入日志、指标、或替换实现
- **Consistency**: 消除"Transport 层是特例"的认知负担

---

## 候选 3：前端提取 useQuery / useMutation 数据获取 Hook

**Files**: `web/src/pages/Dashboard.tsx`, `web/src/pages/AgentsPage.tsx`, `web/src/pages/ModelsPage.tsx`, `web/src/pages/SkillsPage.tsx`, `web/src/pages/TasksPage.tsx`, `web/src/pages/ChannelsPage.tsx`, `web/src/pages/McpPage.tsx`, `web/src/pages/ApiKeyManager.tsx`

**Problem**: 8+ 个页面组件重复同一套数据获取模式——`useState(loading)` + `useState(error)` + `useState(data)` + `useEffect` + `try/catch` + `finally`。每个页面约 15-20 行完全相同的样板代码。这是典型的浅模块反模式：样板代码的接口和"实现"几乎一样复杂，没有 leverage。

**Solution**: 提取 `useQuery<T>(queryFn, deps)` 和 `useMutation<T>(mutateFn)` 自定义 Hook，封装 loading/error/data 状态管理和错误 toast。页面组件只需传入查询函数和依赖项。

**Benefits**:
- **Leverage**: 小接口（`useQuery(queryFn, deps) => { data, loading, error, refetch }`）背后封装了全部生命周期管理
- **Locality**: 加载/错误/刷新逻辑集中在一处，bug 修复只需改 Hook
- **Test surface**: 可以单独测试 Hook 的缓存、去重、竞态处理，不需要挂载整个页面
- **Seam**: 未来可以无缝替换为 SWR/React Query，页面代码不变

---

## 候选 4：后端 Environment/File 路由业务逻辑提取到 Service

**Files**: `src/routes/web/environments.ts` (369 行), `src/services/environment.ts`, `src/routes/web/files.ts` (281 行)

**Problem**: `environments.ts` 路由处理器直接包含文件系统操作（目录创建、工作空间验证）、实例 spawn 编排、端口分配等业务逻辑。`files.ts` 路由直接做路径安全检查、文件 I/O。这些逻辑无法脱离 HTTP 层测试，也无法被其他调用者（如 WebSocket handler、定时任务）复用。

**Solution**: 将 `environments.ts` 中的业务逻辑下沉到 `environment.ts` service（已有，但偏薄），新增 `file-service.ts` 封装文件 I/O 和路径安全。路由只做参数提取 + 调用 service + 返回结果。

**Benefits**:
- **Locality**: 环境注册、实例管理、文件操作的规则集中在 Service 层
- **Test surface**: 可以在没有 HTTP 请求的情况下测试环境创建、路径验证、文件操作
- **Leverage**: WebSocket handler（`acp-ws-handler.ts`）和 REST 路由共享同一套环境管理逻辑

---

## 候选 5：前端 ACPClient 拆分

**Files**: `web/src/acp/client.ts` (812 行)

**Problem**: `ACPClient` 是一个 god class，混合了 WebSocket 传输管理、连接状态机、Session 管理、心跳保活、浏览器工具调用。812 行代码中至少有 4 个不同关注点。修改心跳逻辑需要理解整个文件，修改 Session 管理也要理解整个文件——没有 locality。

**Solution**: 拆分为：
- `ACPTransport` — WebSocket 连接、重连、消息收发（~200 行）
- `ACPSessionManager` — Session 列表、创建、恢复、状态同步（~250 行）
- `ACPClient` — 编排层，组合 Transport + SessionManager（~150 行）

**Benefits**:
- **Locality**: 心跳逻辑、Session 管理、传输层各自独立，修改不影响其他部分
- **Seam**: Transport 可以有 mock adapter 用于测试，不需要真实 WebSocket
- **Test surface**: 可以单独测试 Session 管理的状态转换，不需要建立 WebSocket 连接

---

## 候选 6：config-pg.ts 按模块拆分为独立 Service

**Files**: `src/services/config-pg.ts` (425 行), `src/routes/web/config/*.ts`

**Problem**: `config-pg.ts` 是一个 425 行的 god service，同时处理 Provider/Model/Agent/Skill/MCP/UserConfig 六个完全独立的领域。每个领域的 CRUD 模式几乎相同（get/list/create/update/delete），但字段映射、验证规则、关联操作各不相同。ADR-0002 说"每个模块保留独立的 CRUD 逻辑"，但实际上所有 CRUD 都挤在一个文件里。

**Solution**: 将 config-pg.ts 拆分为 6 个独立 service 文件（`provider-service.ts`, `model-service.ts` 等），每个 ~70 行，只包含自己领域的 CRUD 和验证。原 config-pg.ts 保留为薄的重导出层以兼容现有 import。

**Benefits**:
- **Locality**: 修改 Provider 逻辑不需要阅读 Model/Skill/Agent/MCP 的代码
- **Test surface**: 每个 service 可以独立测试，测试文件从 1 个变为 6 个，每个更小更聚焦
- **Seam**: 未来某个模块切换存储后端（如 MCP 配置走远程 API），只改对应 service
