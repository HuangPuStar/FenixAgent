# @fenix/resource-channel

IM 通道能力的唯一 owner：通道平台描述、Hermes 网关连接与消息匹配、通道绑定的领域规则。

## 职责

- **通道平台清单**：`src/server/services/channel-provider.ts` 维护静态平台表（微信 / 飞书），`status` 由 Hermes 连接状态与已连平台列表推导；测试经 `setHermesClientGetter()` 替换客户端。
- **Hermes 网关客户端**：`src/server/services/hermes-client.ts` 的 `HermesClient` 持有 WebSocket 连接（30s ping / 60s pong 超时、指数退避重连封顶 60s、按 `HERMES_PLATFORMS` 或内置清单订阅、`platform_status` 到达时增量订阅），单例由 `initHermesClient()` / `getHermesClient()` / `resetHermesClient()` 管理。
- **入站路由**：网关消息由 `findBindingForMessage()` 匹配绑定（精确 `chatId` 优先，其次 `chatId === null` 的通配绑定），再 `routeToAgent()` 投递——先按 environment 找运行实例走 relay，失败退回 `sendToAgentWs()`；两条路径都失败只记日志，不重试、不排队。
- **出站回投**：`ensureOutboundRouting()` 按 `platform:chatId:agentId` 订阅 ACP 事件总线，累积 `session_update` 中 `update.sessionUpdate === "agent_message_chunk"` 的文本，`prompt_complete` 时一次性 `send()` 回网关。
- **绑定领域与持久化**：`src/server/services/channel-binding.ts` 提供 CRUD 与匹配规则；`src/server/repositories/channel-binding.ts` 是唯一数据访问点。
- **HTTP 交付物**：`src/server/routes/web/channels.ts`（默认导出）提供 `/web/channels/providers`、`/web/channels/hermes/status` 与 `/web/channels/bindings` 的 GET/POST/PATCH/DELETE；请求响应 schema 在 `src/server/schemas/channel.schema.ts`，用 `@fenix/platform-sdk` 的 `WebOkSchema` / `WebErrSchema` 包装。
- **浏览器侧**：`web/pages/agent-panel/pages/AgentChannelsPage.tsx`（并行拉取绑定与环境、表单 / 确认对话框）、`web/api/channels.ts`（经 `@/src/api/request`）、`web/i18n/{zh,en}/channels.json`；`web/__tests__/channel-i18n-contract.test.ts` 用 AST 校验 `t()` 键可静态解析且双语键集合一致。
- **测试覆盖**：`src/__tests__/round54-channels-routes.test.ts` 断言未认证 401、跨组织拒绝、环境 `secret` 不外泄与参数校验；`round28-hermes-client-isolation.test.ts` 覆盖文本累积与回复缓存隔离、订阅去重与停止释放、心跳 / pong 超时与损坏帧容错。

## 依赖边界

本包属 `resources` 类别，类别禁则只有一条（`scripts/lib/architecture-boundary-rules.ts`）：`resource → platform-impl`。

- **不导入** `@fenix/identity/*` 与 `@fenix/access-control/*`。当前组织归属校验是拿 `environmentRepo.getById()` 返回的 `organizationId` 与 `store.authContext.organizationId` 比对（`routes/web/channels.ts`），不是授权实现。
- **跨包值导入**只有 `@fenix/agent-runtime/server`（运行实例查询、relay/WS 投递、`environmentRepo`）与 `@fenix/logger`；没有对其它资源包的值导入，故 `dependsOn` 为空——本包是叶子模块，装配上不要求其它资源模块同批启用。
- **`@server/**` 是待消除的宿主内引用**：`@server/plugins/auth`（2 处）、`@server/db`、`@server/db/schema`；已由台账登记为 `apps-boundary`（owner 1.5，实测 6 处导入 / 4 文件）。

## 守卫由宿主注入

本包的目标形态是「路由工厂 + 宿主注入守卫」，当前**尚未迁移**：`src/server/routes/web/channels.ts` 是默认导出的已构造 Elysia 实例，内部 `import { authGuardPlugin } from "@server/plugins/auth"` 并在构造时 `.use(authGuardPlugin)`，各路由用 `sessionAuth: true` 声明鉴权；宿主 `apps/server/src/routes/web/index.ts` 直接 `.use(webChannelsRoutes)` 把它挂进 `/web` 前缀。因此这一节记录的是待办：转成 `createWebChannelsRoutes({ authGuardPlugin })` 工厂（对齐 `@fenix/resource-sandbox/server`），与 `src/module.ts` 组合根同批，属 W2 切片；`@server/**` 引用的彻底消失归台账 owner 1.5。包内用例目前依赖 `@server/plugins/auth` 的 `setTestAuth()` 与 `@server/test-utils/stubs/module-stubs` 注入替身（见 `src/__tests__/round54-channels-routes.test.ts`）。

## 配置与 DB

- **直读 `process.env` 的只有一处**：`HermesClient` 构造器读 `HERMES_PLATFORMS`（逗号分隔，缺省用内置平台清单）。网关地址由宿主传入（`apps/server/src/main.ts` 读 `HERMES_URL`），本包不读；`envDefinitions` 与 preflight 收敛在任务 1.7。
- **DB 经宿主句柄**：`repositories/channel-binding.ts` 直接 `import { db } from "@server/db"` 并使用 `@server/db/schema` 的 `channelBinding` 表对象——`uuid` 主键、`platform` / `chatId` / `agentId` / `enabled` 与时间戳，带 platform、agent_id 两个索引；表定义迁出归 §1.7。
- **表定位是遗留**：`channel_binding` 在宿主 schema 里标注为「Hermes 通道绑定表（遗留，保留兼容）」，升级目标 `im_channel` / `im_channel_route` 已建表但尚无任何代码引用（只被 schema 内部引用）。

## 边界外的已知项

- **无包级浏览器出口**：`package.json` 的 `exports` 只有 `"."`（`src/index.ts` 是空导出）与 `"./server"`；`web/` 下的页面、API client 与语言资源还没有 `web/index.ts`。宿主当前经 `apps/web/vite.config.ts` 的文件级 alias 与懒加载路由 `apps/web/src/routes/agent/_panel/channels.tsx` 消费页面，这层 alias 的收敛归 §1.6 WebShell 装配。
- **无 `src/module.ts` 单例**：Hermes 客户端是 `services/hermes-client.ts` 的模块级变量，宿主 `main.ts` 直接 `initHermesClient()`；组合根与 manifest `create` 归 W2 切片。
- **路由仍是默认导出**：见「守卫由宿主注入」一节，工厂化归 W2 切片。
- **`services/channel-provider.ts` 不在公开入口**：`src/server.ts` 只导出路由、绑定服务、事件总线端口与 Hermes 单例；平台清单与 `setHermesClientGetter()` 目前只能从路由或 `src/**` 路径触达，未定型为稳定契约。
- **`im_channel` / `im_channel_route` 无实现**：一等资源模型只有表，没有服务端规则与路由；补实现或删表都不在 1.3 范围，需先确认归属。
- **语言资源由宿主索引**：`apps/web/src/i18n/index.ts` 以相对路径 `../../../../packages/resources/channel/web/i18n/...` 引入两份 JSON，命名空间常量也定义在宿主；随 `web/index.ts` 出口一并收归 §1.6。
- **前后端 DTO 各写一份**：`web/api/channels.ts` 手写响应类型，`src/server/schemas/channel.schema.ts` 用 zod 描述同一形状，靠人工同步；契约测试目前只断言后端一侧。
- **两个注入点没有装配期校验**：`bindAcpEventBusPort()`（宿主 `main.ts`）与 `setHermesClientGetter()`（测试）都是可被覆盖的模块级状态，绑定缺失或时机错误只会在首次使用时以 fail-fast 或静默 no-op 暴露。
- **台账入口**：`apps-boundary`（owner 1.5）与 `web-package-not-to-app`（owner 1.6，实测 15 处 / 2 文件，集中在 `@/components/ui` 与 `@/src/api`）。
