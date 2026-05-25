# server-web-auth-adapter 执行计划

**目标:** 将旧后端已验证的 `better-auth` 认证基座平移到 `src-new/apps/server`，让现有 `web/` 前端在不改登录协议的前提下接入新后端，并为后续 `/web/*` 路由提供统一 `sessionAuth` 宿主能力。

**技术栈:** Bun、Hono、better-auth、drizzle-orm、SQLite、Bun Test

**设计文档:** `spec/feature_20260512_F001_server-web-auth-adapter/spec-design.md`

## 改动总览

本次改动集中在 `src-new/apps/server` 的数据库、认证模块、应用装配和测试入口，避免把 `better-auth`、cookie session 或用户态概念下沉到 `src-new/packages/core`。
Task 1 先补齐 SQLite 认证表和 Drizzle schema 元数据，为 Task 2 的 `better-auth` adapter 与 API key 服务提供同库基础。
Task 2 在 `apps/server` 新增 `auth/` 宿主模块，复用旧后端的 `sessionAuth` 上下文语义和 API key 数据模型，但不引入旧 `src/store.ts` 的历史耦合。
Task 3 仅修改 `createApp()` 的 CORS、`/api/auth/*` 和认证失败响应装配，不触碰 `createServerRuntime()`，保持“Web 宿主认证”和 Core runtime 的职责边界清晰。
Task 4 用真实 SQLite 临时库补齐认证回归测试，并把 `src-new/apps/server/package.json` 的测试入口从单个健康检查扩展到整个 `src/__tests__` 目录，保证后续 `/web/*` 迁移可持续复用。

---

### Task 0: 环境准备

**背景:**
当前 `src-new/apps/server` 仅有健康检查与 SQLite 仓储测试，认证改造会同时引入 `better-auth`、Drizzle 和新的 Bun Test 用例。
先确认构建、类型检查和现有测试命令在当前仓库可用，避免后续 Task 被工具链问题阻塞。

**执行步骤:**
- [x] 验证 `apps/server` 本地构建命令可用
  - 位置: `src-new/apps/server/package.json:scripts.build`
  - 运行 `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run build`，确认 Bun 能从当前包入口 `src/index.ts` 正常构建产物
  - 原因: Task 3 会修改 `createApp()` 和认证模块导入链，先确认现有打包链路正常
- [x] 验证 `apps/server` 类型检查命令可用
  - 位置: `src-new/apps/server/package.json:scripts.typecheck`
  - 运行 `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run typecheck`，确认 `tsconfig.json`、workspace 依赖和现有源码能通过检查
  - 原因: 认证模块会新增多文件导入和类型注入，类型检查是最直接的结构回归防线
- [x] 验证 `apps/server` 现有测试命令可用
  - 位置: `src-new/apps/server/package.json:scripts.test`
  - 运行 `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/health.test.ts`
  - 原因: Task 4 会扩展测试入口，先确认 Bun Test 在当前包目录下工作正常

**检查步骤:**
- [x] 检查构建命令执行成功
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run build`
  - 预期: 生成 `dist/` 输出且无 build error
- [x] 检查类型检查命令执行成功
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run typecheck`
  - 预期: 命令退出码为 0，无 TypeScript 报错
- [x] 检查测试命令可运行
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/health.test.ts`
  - 预期: `GET /health` 与 `GET /version` 两个测试通过

---

### Task 1: 扩展认证数据库基础设施

**背景:**
现有 `src-new/apps/server/src/db/schema.ts` 只有环境、实例、会话和配置类表，无法承接 `better-auth` 的 `user/session/account/verification` 表，也没有 `api_key` 表支撑后续用户态鉴权扩展。
旧后端的认证实现依赖 Drizzle table 元数据，而新后端当前只有原始 SQL 建表语句；本 Task 需要把“SQLite 自举”与“Drizzle schema 描述”同时补齐。
Task 2 的 `better-auth` 实例和 API key 服务直接依赖本 Task 产出的表结构与共享 DB 访问层。

**涉及文件:**
- 新建: `src-new/apps/server/src/db/auth-schema.ts`
- 新建: `src-new/apps/server/src/db/auth-db.ts`
- 新建: `src-new/apps/server/src/__tests__/sqlite-auth-schema.test.ts`
- 修改: `src-new/apps/server/src/db/schema.ts`

**执行步骤:**
- [x] 在 SQLite 自举 schema 中追加认证表与 `api_key` 表
  - 位置: `src-new/apps/server/src/db/schema.ts:SCHEMA_STATEMENTS` 数组，在现有 `mcp_servers` 建表语句之后追加认证相关表
  - 追加 `CREATE TABLE IF NOT EXISTS user`、`session`、`account`、`verification`、`api_key` 五条语句，字段名与旧后端 `src/db/schema.ts` 保持一致：`email_verified`、`expires_at`、`user_id`、`last_used_at` 等 snake_case 列名全部对齐
  - `session.user_id`、`account.user_id`、`api_key.user_id` 统一声明外键指向 `user.id`，删除策略使用 `ON DELETE CASCADE`
  - 原因: 只有底层列名和外键语义与旧前端、旧认证实现保持兼容，后续平移 `better-auth` 才不需要额外适配层
- [x] 新建 Drizzle 认证 schema 元数据文件供 `better-auth` adapter 使用
  - 位置: `src-new/apps/server/src/db/auth-schema.ts`
  - 参照旧后端 `src/db/schema.ts`，用 `drizzle-orm/sqlite-core` 定义并导出 `user`、`session`、`account`、`verification`、`apiKey` 五个 table；时间字段继续使用 `integer(..., { mode: "timestamp" })`
  - 保持 `apiKey` 的命名和列映射与旧服务一致，导出命名采用 `apiKey`，表名保持 `api_key`
  - 原因: `better-auth` 的 `drizzleAdapter()` 需要 table object，不能直接消费原始 SQL 语句数组
- [x] 新建认证专用的 SQLite + Drizzle 共享访问层
  - 位置: `src-new/apps/server/src/db/auth-db.ts`
  - 复用 `resolveRuntimePaths().dbPath` 和 `createDatabase()` 打开与 Core 仓储同一个 SQLite 文件，再用 `drizzle-orm/bun-sqlite` 包装为 `authDb`
  - 导出模块级单例 `authSqlite` 与 `authDb`，并把 `* as authSchema` 一并导出，供 Task 2 的 `better-auth.ts` 和 `api-key-service.ts` 共用
  - 原因: 避免认证模块分别重复打开数据库连接，同时确保认证表与业务表共库
- [x] 为认证 schema 自举编写回归测试
  - 测试文件: `src-new/apps/server/src/__tests__/sqlite-auth-schema.test.ts`
  - 测试场景:
    - 认证建表: 用临时 SQLite 文件调用 `createDatabase()` 后，查询 `sqlite_master` → 预期存在 `user`、`session`、`account`、`verification`、`api_key`
    - 关键列校验: 用 `PRAGMA table_info('session')` 和 `PRAGMA table_info('api_key')` → 预期包含 `token`、`user_id`、`last_used_at`
    - 外键关系: 用 `PRAGMA foreign_key_list('api_key')` → 预期目标表为 `user`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/sqlite-auth-schema.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查认证表建表语句已加入 schema 自举
  - `rg -n "CREATE TABLE IF NOT EXISTS (user|session|account|verification|api_key)" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/db/schema.ts`
  - 预期: 输出 5 条认证相关建表语句
- [x] 检查 Drizzle 认证 schema 已导出
  - `rg -n "export const (user|session|account|verification|apiKey)" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/db/auth-schema.ts`
  - 预期: 输出 5 个 table 导出定义
- [x] 检查认证 schema 回归测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/sqlite-auth-schema.test.ts`
  - 预期: 认证表存在性、列结构和外键关系断言全部通过

---

### Task 2: 平移 better-auth 与 API key 服务

**背景:**
旧后端已经通过 `better-auth` + Drizzle adapter 实现 email/password 登录和 7 天 session 生命周期，新后端当前完全缺少用户认证宿主模块。
本 Task 需要在 `apps/server` 内部复制旧后端认证能力，但只平移认证必需部分，不把 legacy store、ACP 专用鉴权链路和旧路由历史包袱一起带入新架构。
Task 3 的 `sessionAuth` 装配和 `/api/auth/*` handler 直接依赖这里导出的 `auth` 实例与 API key 读写函数。

**涉及文件:**
- 新建: `src-new/apps/server/src/auth/better-auth.ts`
- 新建: `src-new/apps/server/src/auth/api-key-service.ts`
- 新建: `src-new/apps/server/src/__tests__/api-key-service.test.ts`

**执行步骤:**
- [x] 在 `apps/server` 新建 `better-auth` 实例模块
  - 位置: `src-new/apps/server/src/auth/better-auth.ts`
  - 复用旧后端 `src/auth/better-auth.ts` 的核心配置：`drizzleAdapter(authDb, { provider: "sqlite", schema: authSchema })`、`emailAndPassword.enabled = true`、`session.expiresIn = 60 * 60 * 24 * 7`、`session.updateAge = 60 * 60 * 24`
  - `trustedOrigins` 明确包含 `http://localhost:5173`，同时追加通过 `env.PORT` 推导出的 server 自身 origin，例如 `http://localhost:4001`
  - 为导出的 `auth` 补充模块级文档注释，说明其职责仅限 `apps/server` 的 Web 宿主认证
  - 原因: 保持旧前端 `better-auth/react` 的消费行为不变，同时把认证边界固定在 server 宿主层
- [x] 新建 `api-key-service`，沿用旧后端的 per-user API key 语义
  - 位置: `src-new/apps/server/src/auth/api-key-service.ts`
  - 平移 `createApiKey()`、`validateApiKeyAndGetUser()`、`listApiKeysByUser()`、`deleteApiKey()`、`updateApiKeyLabel()` 五个导出函数，底层查询改为使用 `authDb` + `authSchema.apiKey`
  - 保留 `rcs_` 前缀、`key_` 形式的 ID、`lastUsedAt` 后台更新以及脱敏 `keyPrefix` 返回格式
  - 删除旧实现中未使用的 `createHash` 导入，避免把无关 legacy 代码一并带入
  - 原因: 该服务与登录后用户能力直接相关，也是后续 `/web/api-keys`、ACP 用户解析的复用基础
- [x] 用真实临时库为 API key 服务补齐单元测试
  - 测试文件: `src-new/apps/server/src/__tests__/api-key-service.test.ts`
  - 测试场景:
    - 创建并脱敏: 预置测试用户后调用 `createApiKey()` → 预期返回完整 key 与 `record.keyPrefix`
    - 校验并更新使用时间: 调用 `validateApiKeyAndGetUser()` → 预期返回 `userId/keyId`，再次读取时 `lastUsedAt` 已更新
    - 所有权约束: 其他用户调用 `deleteApiKey()` 或 `updateApiKeyLabel()` → 预期返回 `false`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/api-key-service.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 `better-auth` 模块已启用 email/password 和 7 天 session
  - `rg -n "emailAndPassword|expiresIn|updateAge|trustedOrigins" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/better-auth.ts`
  - 预期: 输出包含 email/password、7 天 session 和 trustedOrigins 配置
- [x] 检查 API key 服务导出齐全
  - `rg -n "export async function (createApiKey|validateApiKeyAndGetUser|listApiKeysByUser|deleteApiKey|updateApiKeyLabel)" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/api-key-service.ts`
  - 预期: 输出 5 个导出函数定义
- [x] 检查 API key 服务测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/api-key-service.test.ts`
  - 预期: 创建、校验、更新和所有权约束场景全部通过

---

### Task 3: 实现 sessionAuth 并装配认证路由

**背景:**
新 `createApp()` 当前只有全局 `cors({ origin: "*" })`、`/health` 和 `/version`，完全无法承接旧前端的 `/api/auth/*` 登录协议，也没有可复用的 `sessionAuth` 宿主约定。
旧前端和旧 `/web/*` 路由大量依赖 `c.get("user")`、`c.get("session")` 的上下文形态，因此这里必须优先保证协议和上下文兼容，而不是重做一套新认证接口。
Task 4 的集成测试会直接验证本 Task 挂载的 `auth.handler`、cookie 回传和 `sessionAuth` 注入行为。

**涉及文件:**
- 新建: `src-new/apps/server/src/auth/middleware.ts`
- 修改: `src-new/apps/server/src/app.ts`

**执行步骤:**
- [x] 在 `apps/server` 新增兼容旧后端语义的 `sessionAuth` 中间件
  - 位置: `src-new/apps/server/src/auth/middleware.ts`
  - 复用旧后端 `src/auth/middleware.ts` 的核心逻辑：调用 `auth.api.getSession({ headers: c.req.raw.headers })` 读取当前会话；未登录时返回 `401` 和 `{ error: { type: "unauthorized", message: "Not authenticated" } }`
  - 登录成功后向 Hono context 写入 `user: { id, email, name }` 与 `session: { id, userId, token }`，键名保持与旧后端完全一致
  - 不在该文件中引入 ACP、UUID 或 worker JWT 分支，仅保留 Web UI 所需的 `sessionAuth`
  - 原因: 本 feature 的范围是“认证基座平移”，不是一次性平移旧后端全部鉴权分支
- [x] 在 `createApp()` 中注册 `/api/auth/*` 和认证专用 CORS
  - 位置: `src-new/apps/server/src/app.ts:createApp()`
  - 在创建 `app` 后、`onError()` 之前增加 `app.use("/api/auth/*", cors({ origin: ..., allowMethods: [...], allowHeaders: [...], credentials: true }))`
  - `origin` 使用函数形式：对空 `Origin` 头返回当前请求 origin，对 `http://localhost:5173` 返回该值，对其他 origin 返回空字符串；保留现有全局 `cors()` 供健康检查等匿名接口使用
  - 在健康检查路由之前挂载 `app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))`
  - 原因: `better-auth/react` 依赖 cookie 凭证和标准 `/api/auth/*` 路径，认证路由需要独立的 credentials CORS 配置
- [x] 保持 `apps/server` 与 Core runtime 的边界不变
  - 位置: `src-new/apps/server/src/app.ts` 与 `src-new/apps/server/src/bootstrap.ts`
  - 仅在 `app.ts` 引入 `auth` 与 `sessionAuth`，不要把认证对象注入 `createServerRuntime()`、`CoreFacade` 或 `src-new/packages/core`
  - 原因: 设计文档明确认证属于 Web 宿主层，Core 继续只负责环境、实例、会话等业务抽象
- [x] 为 `sessionAuth` 和 `/api/auth/*` 编写集成测试
  - 测试文件: `src-new/apps/server/src/__tests__/app-auth-routes.test.ts`
  - 测试场景:
    - 注册登录链路: `POST /api/auth/sign-up/email` 后再请求 `GET /api/auth/get-session` → 预期返回用户和 session
    - 上下文注入: 在测试中对 `createApp()` 返回的 Hono 实例追加 `/web/test-session` 路由并挂 `sessionAuth` → 携带登录 cookie 请求时返回 `user.id/email` 与 `session.userId`
    - 未登录拒绝: 不带 cookie 请求 `/web/test-session` → 预期返回 401 和 `Not authenticated`
    - CORS 凭证: 对 `/api/auth/get-session` 发送带 `Origin: http://localhost:5173` 的请求 → 预期响应包含 `Access-Control-Allow-Credentials: true`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/app-auth-routes.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 `sessionAuth` 已导出兼容上下文字段
  - `rg -n "c\\.set\\(\"user\"|c\\.set\\(\"session\"|Not authenticated" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/middleware.ts`
  - 预期: 输出 `user`、`session` 注入和 401 错误消息定义
- [x] 检查 `createApp()` 已挂载 `auth.handler`
  - `rg -n "auth\\.handler|/api/auth/\\*" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/app.ts`
  - 预期: 输出 `/api/auth/*` 的 CORS 中间件和 GET/POST handler 挂载语句
- [x] 检查认证路由集成测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/app-auth-routes.test.ts`
  - 预期: 注册、会话读取、上下文注入和未登录拒绝场景全部通过

---

### Task 4: 补齐认证回归测试与测试入口

**背景:**
`src-new/apps/server/package.json` 当前的 `test` 脚本只执行 `health.test.ts`，即使前面三个 Task 完成，也无法通过包级命令覆盖认证回归。
认证基座是后续 `/web/*` 迁移的正式宿主层，需要把数据库结构、API key 服务和 app 认证路由纳入统一测试入口，保证后续迭代不会破坏登录闭环。
本 Task 依赖 Task 1~3 的文件已落地，负责把零散测试收敛成稳定的包级回归命令。

**涉及文件:**
- 修改: `src-new/apps/server/package.json`
- 修改: `src-new/apps/server/src/__tests__/health.test.ts`

**执行步骤:**
- [x] 扩展 `apps/server` 的测试脚本覆盖整个测试目录
  - 位置: `src-new/apps/server/package.json:scripts.test`
  - 将现有 `bun test src/__tests__/health.test.ts` 修改为 `bun test src/__tests__`
  - 保留 `build` 和 `typecheck` 脚本不变，不新增与认证无关的 workspace 级脚本
  - 原因: 后续开发者需要通过一个包级命令运行完整 server 回归，而不是手动拼接单文件测试列表
- [x] 调整基础健康检查测试文件注释与 suite 说明，使其与新增认证测试并存
  - 位置: `src-new/apps/server/src/__tests__/health.test.ts`
  - 保留现有 `/health` 与 `/version` 断言，补一段文件级注释说明该文件只负责匿名基础路由，不承担认证覆盖
  - 不把认证断言塞入 `health.test.ts`，继续保持“健康检查”和“认证集成”按职责拆分
  - 原因: 避免单文件膨胀，保持测试命名与职责一致，便于后续新增 `/web/*` 路由测试
- [x] 为完整测试入口编写最终回归验证步骤
  - 测试文件: `src-new/apps/server/src/__tests__/app-auth-routes.test.ts`
  - 测试场景:
    - 完整目录执行: 运行 `bun test src/__tests__` → 预期同时覆盖 health、sqlite auth schema、api key service、app auth routes
    - 类型回归: 运行 `bun run typecheck` → 预期新增 auth/db 文件的导入链全部通过
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 `package.json` 测试脚本已切到全目录
  - `rg -n "\"test\": \"bun test src/__tests__\"" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/package.json`
  - 预期: 输出唯一一条 `test` 脚本定义
- [x] 检查完整测试目录执行成功
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__`
  - 预期: health、认证 schema、API key、认证路由相关测试全部通过
- [x] 检查新增认证文件通过类型检查
  - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run typecheck`
  - 预期: 命令退出码为 0，无新增类型错误

---

### Task 5: 认证基座平移验收

**前置条件:**
- 启动命令: `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun run dev`
- 测试数据准备: 使用测试专用临时 SQLite 文件，避免污染真实 `data/db.sqlite`
- 其他环境准备: 本机安装 Bun；端口 `4001` 可用；`http://localhost:5173` 可作为本地前端调试来源

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__`
   - 预期: `health.test.ts`、`sqlite-auth-schema.test.ts`、`api-key-service.test.ts`、`app-auth-routes.test.ts` 全部通过
   - 失败排查: 依次检查 Task 1 认证表结构、Task 2 API key 服务、Task 3 认证路由装配、Task 4 测试脚本入口

2. 验证 `/api/auth/*` 已由新 server 提供
   - `cd /Users/liyuan/Work/mothership-beta_new/src-new/apps/server && bun test src/__tests__/app-auth-routes.test.ts`
   - 预期: `POST /api/auth/sign-up/email`、`POST /api/auth/sign-in/email`、`GET /api/auth/get-session` 相关断言全部通过，不再只有 `/health` 和 `/version`
   - 失败排查: 检查 Task 2 `auth/better-auth.ts` 与 Task 3 `app.ts` 的 `auth.handler` 挂载

3. 验证 `sessionAuth` 注入与旧后端上下文兼容
   - `rg -n "c\\.set\\(\"user\"|c\\.set\\(\"session\"" /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/auth/middleware.ts`
   - 预期: `sessionAuth` 明确向 Hono context 注入 `user` 与 `session`，字段名与旧后端一致
   - 失败排查: 检查 Task 3 `auth/middleware.ts` 的 `auth.api.getSession()` 结果映射

4. 验证认证能力仍然留在 `apps/server` 而未侵入 Core
   - `rg -n "better-auth|sessionAuth|authDb|apiKey" /Users/liyuan/Work/mothership-beta_new/src-new/packages/core /Users/liyuan/Work/mothership-beta_new/src-new/apps/server/src/bootstrap.ts`
   - 预期: `src-new/packages/core` 无 `better-auth` 或 `sessionAuth` 相关引用；`bootstrap.ts` 不导入认证模块
   - 失败排查: 检查 Task 3 是否把宿主层依赖错误注入到 runtime 装配链

5. 验证本 feature 范围仍停留在认证基座而非全量 `/web/*` 迁移
   - `rg -n "/web/|sessionAuth|apiKey" /Users/liyuan/Work/mothership-beta_new/spec/feature_20260512_F001_server-web-auth-adapter/spec-plan.md`
   - 预期: 计划内容只要求提供 `sessionAuth` 宿主契约和认证配套，不包含 `environments/sessions/api-keys` 全量业务路由平移
   - 失败排查: 回看 Task 3 与改动总览，删除超出设计文档范围的业务路由改造步骤
