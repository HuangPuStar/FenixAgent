# RCS (Remote Control Server)

AI Agent 控制面板后端，管理 Agent 环境注册、会话通信、配置持久化和定时任务调度。

## Language

**Repository**:
数据访问层，封装单一领域的持久化操作（内存 Map 或 PostgreSQL），对外暴露异步接口。一个 Repository 对应一个数据库表或一组相关内存 Map。
_Avoid_: DAO, store, data access object

**Service**:
业务逻辑层，编排 Repository 调用和跨领域协作。路由和 Transport 层通过 Service 访问数据，不直接操作 Repository。
_Avoid_: handler, manager, controller

**EventBus**:
会话级事件总线，提供有序发布/订阅和断线重连事件回放。通过 EventService 薄封装访问，不直接导入。
_Avoid_: message broker, pub/sub

**Environment**:
已注册的 Agent 运行环境（对应 `environment` 表），包含工作目录、Agent 配置和认证 secret。一个 Environment 可以有多个 Instance。
_Avoid_: agent registration, node, worker

**Session**:
Agent 与用户之间的对话上下文（对应 `agent_session` 表），属于一个 Environment。Session 通过 EventBus 推送事件给前端。
_Avoid_: conversation, chat, thread

**ACP (Agent Control Protocol)**:
RCS 与 acp-link 之间的 WebSocket 通信协议，用于 Agent 注册、会话管理和消息中继。
_Avoid_: agent protocol, control channel

**Relay**:
前端与 acp-link 之间的 WebSocket 中继连接，服务器双向转发消息，拦截 keep_alive 和 list_sessions。
_Avoid_: proxy, tunnel, bridge

**Config Module**:
配置管理的子域，包括 Providers、Models、Agents、Skills、MCP、UserConfig 六个模块。每个模块有自己的 CRUD 逻辑，共享公共工具函数。
_Avoid_: settings, preferences, configuration resource

**ConfigUtils**:
配置模块的公共工具函数（JSONB 序列化、错误包装、字段过滤），位于 `src/services/config-utils.ts`。
_Avoid_: config helpers, shared config

## Relationships

- 一个 **Environment** 拥有零或多个 **Session**
- 删除 **Environment** 时，Service 层编排级联删除关联 **Session**（不依赖数据库 CASCADE）
- 一个 **Session** 对应一个 **EventBus**
- **Transport** 层通过 **Service** 访问 **Repository**，不直接导入 store 函数
- **Relay** 按 instanceId 路由消息，不是 agentId
- **Config Module** 的 body schema 在各自路由文件中定义，不在统一的 ConfigBodySchema 中

## Example dialogue

> **Dev:** "创建 **Environment** 时需要同时创建默认 **Session**，这个逻辑放在哪里？"
> **Domain expert:** "在 Service 层编排 — 先调 `environmentRepo.create()`，再调 `sessionRepo.create()`。Transport 层只调 `environmentService.register()`，不直接操作 Repository。"

> **Dev:** "为什么 **Relay** 要按 instanceId 而不是 agentId 路由？"
> **Domain expert:** "因为一个 Environment 可以有多个 Instance（多实例模式）。如果按 agentId 路由，所有实例的消息会混入同一信道。"

## Flagged ambiguities

- "store" 曾同时指代数据存储和 `store.ts` 文件 — 已解决：数据访问层统一为 **Repository**，`store.ts` 将被拆分删除。
- "config" 曾同时指代 `config.ts`（已废弃）和 `config-pg.ts`（活跃） — 已解决：`config.ts` 是空壳，所有配置操作通过 **Config Module** 访问 `config-pg.ts`。
- "session" 在 ACP 协议中返回 `ses_xxx` 格式 ID，RCS 内部用 `session_xxx`/`cse_xxx` — 已解决：前端通过 `resolveExistingSessionId` 转换，不做 fallback。
