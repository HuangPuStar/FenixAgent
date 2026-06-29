# 后端技术栈

> Bun + Elysia + PostgreSQL + Drizzle ORM + better-auth + WebSocket/ACP

---

## 1. [Bun](https://bun.sh) 运行时

Bun 是项目唯一运行时环境。生产部署、开发调试、脚本执行、测试运行——全部走 Bun，不引入 Node.js。

- **包管理**：`bun install` 替代 npm/pnpm/yarn，workspace 协议管理内部包
- **构建**：`bun build` 打包 TypeScript 为独立可执行文件（如 `migrate.js`），Docker 镜像无需 node_modules
- **测试**：`bun test` 运行全部测试，preload 机制注入全局 mock
- **热重载**：`bun run --watch` 开发模式自动重启

**关键约束**：`Bun.file()`、`Bun.write()` 等 Bun 原生 API 优先于 Node.js `fs` 模块。不引入 Node.js 专用库（如依赖 `worker_threads` 的包）。

---

## 2. [Elysia](https://elysiajs.com) 框架

Elysia 是后端 HTTP 框架，同时承载 REST API、WebSocket Upgrade、静态文件服务。

**插件系统**：Elysia 的插件模型是核心架构的组织方式。启动时按以下功能域顺序注册插件和中间件：

- **CORS 插件**：跨域配置
- **双 OpenAPI 实例**：对外 API（`/api/*`，OpenAPI 3.1）+ 内部控制台 API（`/web/*`），均通过 Scalar UI 提供交互式文档
- **结构化请求日志**：通过 `.onBeforeHandle()` / `.onAfterHandle()` 生命周期钩子挂载日志中间件
- **统一错误格式**：所有错误返回 `{ error: { code, message } }` 结构
- **限流插件**：API 访问速率限制
- **全局中间件**：大请求体限制、双斜杠路径归一化
- **健康检查**：`GET /health`、`GET /` → 302 到控制台首页
- **认证中间件**：better-auth 认证，注入认证实例到上下文
- **静态文件分发**：前端构建产物托管
- **控制面板 API**：`/web/*` 全部路由
- **Agent Sites 反向代理**：将请求转发至业务前端
- **外部 API 路由群**：`/api/*` 下所有 REST 模块
- **工作流代理**：工作流引擎静态资源与 API 反向代理
- **MCP 知识库端点**：Agent 运行时通过 Bearer token 查询知识库
- **ACP WebSocket 路由**：`/acp/ws`（acp-link 机器接入）、`/acp/file-ws`（远程文件操作）、`/acp/relay`（前端中继）
- **Webhook 端点**：外部系统通过 public hash 触发工作流（无认证）

**OpenAPI 集成**：双 `openapi` 实例——对外（`/api/*`）+ 内部控制台（`/web/*`），通过 Scalar UI 提供交互式文档。

**路由约定**：URL 小写 kebab-case，资源名复数；`GET` 查询、`POST` 创建/动作、`PUT` 更新、`DELETE` 删除。所有 route 的 `params`、`query`、`body`、`response` 绑定 Zod Schema，不内联声明。

---

## 3. 数据库：[PostgreSQL](https://www.postgresql.org) + [Drizzle ORM](https://orm.drizzle.team)

**为什么 PostgreSQL**：JSONB 支持（Agent 配置、Workflow 定义）、全文搜索（知识库）、事务隔离（并发 Instance 管理）、行级安全（多租户）。不选 SQLite——单文件不适合多实例并发场景。

**Drizzle ORM**：类型安全的 SQL 构建器，不引入 Query Builder 抽象层。

- **Schema 定义**：集中在一份 schema 文件中作为唯一真相来源，覆盖 better-auth 核心表 + 组织/API Key 插件表 + 自定义业务表
- **迁移**：通过 CLI 工具从 schema 生成 SQL 迁移文件，开发环境推送同步，生产环境通过独立打包的 migrate 脚本执行
- **关系**：ORM 的 `relations()` 定义表间关联，类型推断到查询层
- **索引命名**：`idx_<表名>_org_<字段>` 格式

**Repository 模式**：数据访问逻辑封装在数据访问层中，route 层不直接操作 ORM。同一类数据操作内聚到单一模块，不分散。

---

## 4. 认证：[better-auth](https://www.better-auth.com)

better-auth 是认证的唯一实现，提供用户登录/注册、组织多租户、API Key 管理。

**三路认证优先级**：

1. better-auth session cookie → 浏览器用户
2. Environment Secret → 自动化任务（检查早于 API Key）
3. API Key（特殊前缀）→ 外部系统

**多租户**：通过 `better-auth` organization 插件实现，每个组织独立成员、角色（owner/admin/member）、品牌。组织 ID 从 header > query param > cookie 提取，缓存 60s。

**API Key**：通过 better-auth 的 API Key 插件管理，SHA-256 哈希存储，创建时返回明文（仅一次）。Provider API Key 通过占位符引用环境变量密文，不存储明文。

---

## 5. 实时通信：WebSocket + ACP 协议

**传输层**：

- **ACP WS Handler**：acp-link 注册入口，NDJSON 协议
- **Relay**：Instance 模式优先（直连 acp-link），EventBus fallback（SSE 断线重连）
- **EventBus**：per-session 隔离，支持 SSE `last-event-id` 断点续传

**ACP 协议关键约定**：

- acp-link spawn 时自动生成认证 token，relay 从 acp-link 标准输出捕获
- relay 必须转发 agent `status` 消息（前端依赖 `capabilities` 判断 ACP 能力）
- relay 断连不杀子进程，keep_alive 不透传前端
- ACP session ID 与 RCS session ID 独立，文件 API 须用 RCS ID

**空闲回收**：通过空闲超时控制 relay 断开后的实例回收窗口，以及绝对硬超时防止资源泄漏。超时阈值和扫描周期可通过环境变量配置。

---

## 6. 文件系统存储

- **Skills**：元数据在数据库 skill 表，Markdown 内容在文件系统中。必须通过统一的创建流程（同时写 DB 和文件系统），禁止只写 DB（会导致 skill 内容不下发）
- **Workspaces**：路径按 `组织/用户/环境` 层级拼接，运行时实时计算，不依赖数据库中可能过期的路径字段
- **Agent 模板**：存放在预设目录下，使用 Markdown + YAML frontmatter 格式，通过标准 Markdown frontmatter 解析库读取，进程级内存缓存
