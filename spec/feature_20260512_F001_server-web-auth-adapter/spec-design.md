# Feature: 20260512_F001 - server-web-auth-adapter

## 需求背景

当前仓库已经有一套可工作的旧控制面前端 `web/`，其登录态与受保护接口访问方式都建立在旧后端的认证基座之上，包括：

- `better-auth` 提供的 `/api/auth/*` 协议
- 基于 cookie 的 session
- `better-auth/react` 的 `useSession` / `signIn` / `signUp`
- `/web/*` 路由统一依赖 `sessionAuth` 从 Hono context 中读取当前用户

而新的 `src-new/apps/server` 目前仍处于最小骨架阶段，只具备：

- Hono 进程入口与基础中间件
- Core runtime 装配
- SQLite 仓储与配置仓储
- 健康检查接口

它还没有任何用户、认证、会话 cookie、登录接口或 `/web/*` 用户态宿主能力，因此无法直接承接现有 `web/` 前端。

本 feature 的目标不是重新设计一套新认证体系，也不是先抽象通用身份域，而是把旧后端已经验证可用的认证基座整体平移到新后端，让新的 `apps/server` 可以直接对接当前 `web/` 前端，并为后续新 `/web/*` 路由提供统一认证宿主层。

## 目标

- 将旧后端认证基座整体平移到 `src-new/apps/server`
- 让现有 `web/` 前端无需改登录协议即可连接新后端
- 在新后端保留与旧后端一致的 `sessionAuth` 上下文约定，作为后续 `/web/*` 的统一入口
- 为后续补齐用户态 `/web/*` API 提供稳定宿主能力，而不是临时模拟登录态

## 方案设计

### 一、总体方案

本 feature 采用“旧认证整套平移，新后端原生承接”的方案。

核心原则如下：

- 对外协议保持兼容：继续提供 `/api/auth/*`、cookie session、`better-auth/react` 可直接消费的响应行为
- 对内归属明确：认证能力属于 `apps/server` 的 Web 宿主层，不进入 `packages/core`
- 实现优先复用旧方案：尽量沿用旧后端已经验证过的认证表结构、中间件语义和上下文注入格式
- 演进边界清晰：本 feature 先落认证基座，不强行在同一轮完成全部 `/web/*` 用户态接口

这意味着新的 `apps/server` 会先获得一层完整的“Web 宿主认证能力”，再由后续 feature 逐步把 `/web/environments`、`/web/sessions`、`/web/api-keys` 等接口接回新 runtime 和新仓储。

### 二、认证能力的归属边界

认证相关能力放在 `apps/server`，不下沉到 `packages/core`。

原因：

- `better-auth`、cookie、HTTP headers、session persistence 都是典型 Web 宿主能力
- `packages/core` 负责环境、实例、会话、配置等业务抽象，不应该依赖某个具体 Web 鉴权框架
- 当前 `web/` 前端的直接依赖是 HTTP 协议与 cookie 行为，而不是 Core 接口

因此新架构中的依赖关系应为：

`web/` → `apps/server(auth + web routes)` → `packages/core`

而不是：

`web/` → `packages/core(auth domain)` → `apps/server`

### 三、平移范围

本次需要平移的不是单个 `sessionAuth` 文件，而是一整套可独立工作的认证基座。

建议平移范围包括：

1. `better-auth` 实例配置
- 新建 `apps/server` 下的 auth 模块
- 继续使用 email/password 登录
- 保持与旧前端兼容的 session 生命周期与 cookie 行为

2. 认证相关数据表
- 在新 server SQLite 中补齐 `user`、`session`、`account`、`verification`
- 需要时一并补齐与用户登录后常用能力直接关联的 `apiKey` 表

3. `/api/auth/*` 路由入口
- 在 `createApp()` 中注册 `auth.handler`
- 保持旧前端当前调用路径不变

4. `sessionAuth` 中间件
- 在 Hono context 中注入与旧后端兼容的 `user` 和 `session`
- 后续所有新的 `/web/*` 路由继续复用这套约定

5. 与认证强相关的辅助能力
- 例如 system user 初始化逻辑
- 与 API key 校验直接耦合的用户查找逻辑
- 为后续 ACP / worker / environment 鉴权保留可扩展入口

不在本 feature 内一次性完成的内容：

- 全量 `/web/*` 用户态接口迁移
- 旧 `src/store.ts` 的完整平移
- 所有 worker / ACP / relay 鉴权链路的最终重构

### 四、数据层设计

#### 4.1 新 server 数据库增加认证表

`src-new/apps/server/src/db/schema.ts` 当前只有环境、实例、会话和配置类表。为了直接承接旧前端认证协议，需要在同一 SQLite 中补充用户与认证表。

建议在新 schema 中新增：

- `user`
- `session`
- `account`
- `verification`
- `apiKey`

设计原则：

- 表语义优先兼容旧后端，降低平移成本
- 表创建仍沿用当前 `CREATE TABLE IF NOT EXISTS` 自举方式
- 暂不引入额外 migration 系统，保持与当前 `apps/server` 初始化方式一致

#### 4.2 与现有业务表共库

认证表与 `environments`、`instances`、`sessions`、`models` 等表共用同一个 SQLite 文件。

这样做的理由：

- 新 server 已经把 SQLite 作为默认基础设施
- 登录用户、环境记录、配置记录天然需要在同一进程中协同使用
- 可以直接通过 `user_id` 将环境等业务资源与登录用户关联

### 五、运行时与路由装配

#### 5.1 createApp 补齐认证宿主能力

`src-new/apps/server/src/app.ts` 当前只有：

- 全局 CORS
- `/health`
- `/version`

本 feature 完成后，需要补齐：

- `better-auth` 所需的 CORS/credentials 配置
- `/api/auth/*` handler
- 认证失败时的统一 JSON 响应
- 供 `/web/*` 使用的 `sessionAuth`

#### 5.2 与 bootstrap/runtime 的关系

`createServerRuntime()` 继续负责 Core、插件、仓储装配；认证基座不进入 runtime facade。

即：

- `bootstrap.ts` 负责 Core runtime
- `auth/*` 负责用户认证
- `app.ts` 负责把两者装配到同一个 Hono 应用

这样可以保持职责清晰：

- “谁是当前登录用户”属于宿主层
- “该用户可访问哪些 environment / session / config”由路由层结合 runtime 与 repository 决定

### 六、sessionAuth 约定

为了兼容旧前端和后续新 `/web/*` 路由，`sessionAuth` 继续保留旧后端的上下文约定。

中间件职责：

- 从 cookie/headers 中读取 `better-auth` session
- 验证 session 是否存在
- 在 context 中写入统一格式的 `user`
- 在 context 中写入统一格式的 `session`
- 未登录时返回 401 JSON

建议保留的上下文字段语义：

- `c.get("user")`：当前登录用户最小信息，如 `id`、`email`、`name`
- `c.get("session")`：当前登录 session 最小信息，如 `id`、`userId`、`token`

该约定既服务于当前旧前端所需接口，也服务于后续新 `/web/*` 的统一编写方式，因此应视为 `apps/server` 的正式宿主契约，而不是临时兼容层。

### 七、与当前 web 前端的兼容策略

现有 `web/` 前端当前使用：

- `createAuthClient({ baseURL: "" })`
- 同源 `/api/auth/*`
- `credentials: "include"`
- `useSession()` 作为页面是否进入登录态的前置判断

因此新后端的兼容要求非常明确：

- 保留同源 `/api/auth/*`
- 允许 cookie session 正常回传
- 返回结果满足 `better-auth/react` 预期
- 登录后可以通过 `useSession()` 读取到有效 session

只要这层打通，前端就可以先完成登录态闭环；后续再逐步接入真正的 `/web/*` 数据接口。

### 八、与后续 `/web/*` 迁移的关系

本 feature 的定位是“先把门装上”，不是“整栋楼一次装修完”。

认证平移后，后续 `/web/*` 迁移建议按以下顺序推进：

1. 先补最小登录后首页必需接口
- 如当前会话判断、基础资源列表、用户 API key 管理等

2. 再补强依赖 Core runtime 的接口
- 如 environment、instance、session 相关接口

3. 最后处理历史兼容链路
- 如 ACP 相关 agent 注册、legacy token、worker ingress 等

这样可以让现有 `web/` 尽早切到新后端，同时避免把认证 feature 做成“大而全的旧后端重建”。

## 实现要点

- 新增 `apps/server/src/auth/` 模块，承接 `better-auth` 实例与中间件
- 扩展 `apps/server/src/db/schema.ts`，补齐认证与 API key 相关表
- 调整 `apps/server/src/app.ts`，注册 `/api/auth/*` 与认证相关 CORS/credentials 配置
- 保留与旧后端兼容的 `sessionAuth` context 注入格式
- 后续 `/web/*` 路由开发统一依赖 `sessionAuth`，避免各自重复处理登录态
- 若旧认证实现中有直接耦合 legacy store 的逻辑，只平移“认证必需部分”，不整体引入旧 store
- 对 API key / environment secret / worker JWT 等扩展鉴权能力，优先保留接口边界和兼容语义，不要求本轮全部接通

## 验收标准

- [ ] `src-new/apps/server` 中存在可独立工作的 `better-auth` 实例与 `/api/auth/*` 路由
- [ ] 新 server SQLite 中补齐认证所需表结构，并可正常完成注册、登录、会话读取
- [ ] 现有 `web/` 前端无需修改登录协议，即可通过新后端完成 `signUp`、`signIn`、`useSession`
- [ ] 新后端提供与旧后端兼容的 `sessionAuth` 中间件，并向 Hono context 注入统一 `user`/`session`
- [ ] 认证能力明确留在 `apps/server`，不向 `packages/core` 引入 `better-auth` 或 Web session 依赖
- [ ] 文档中明确本 feature 只完成认证基座平移，不承诺一次性完成全部 `/web/*` 用户态接口
