# 仓储层

> 对应文件：`src/repositories/`

## 这个模块干什么

仓储层是数据访问的统一封装。Service 层需要读写数据时，不直接写 SQL，而是调用仓储层的函数。每个仓储负责一个领域对象的 CRUD 操作。

这样设计的好处：Service 层不需要知道数据存在内存还是数据库，只需要调用仓储接口。如果以后要换存储方式，只改仓储层就行。

## 仓储总览

`src/repositories/` 目录下共 15 个文件，按领域分组如下：

### 认证与会话

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| SessionRepo | `session.ts` | 纯 PostgreSQL | 会话记录，所有读/写直接操作 `agent_session` 表 |
| SessionWorkerRepo | `session-worker.ts` | 纯内存 | Worker 状态追踪（心跳、权限请求详情） |
| TokenRepo | `token.ts` | 纯内存 | 遗留 token 认证存储 |

### 运行环境

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| EnvironmentRepo | `environment.ts` | 纯 PostgreSQL | 环境记录，直接操作 `environment` 表 |

### 任务调度

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| WorkItemRepo | `work-item.ts` | 纯内存 | CLI bridge 的短生命周期工作队列 |
| ScheduledTaskRepo | `task.ts` | 纯 PostgreSQL | 定时任务 CRUD（cron 表达式、HTTP 目标） |
| TaskExecutionLogRepo | `task.ts` | 纯 PostgreSQL | 任务执行日志（状态、耗时、错误信息） |

### 知识库

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| KnowledgeBaseRepo | `knowledge-base.ts` | 纯 PostgreSQL | 知识库元数据 CRUD |
| KnowledgeResourceRepo | `knowledge-base.ts` | 纯 PostgreSQL | 知识资源（文件）管理 |
| AgentKnowledgeBindingRepo | `knowledge-base.ts` | 纯 PostgreSQL | Agent↔知识库多对多绑定 |

### 工作流

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| WorkflowDef | `workflow-def.ts` | PostgreSQL + 文件系统 | 工作流定义与版本管理，YAML 存文件系统，元数据存 PG。无单例接口，导出独立函数 |
| WorkflowTriggerRepo | `workflow-trigger.ts` | 纯 PostgreSQL | Webhook 触发器管理 |

### 组织与权限

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| OrganizationRepo | `organization.ts` | 纯 PostgreSQL | 按 ID 列表查询组织名称 |
| ResourcePermissionRepo | `resource-permission.ts` | 纯 PostgreSQL | 跨组织资源权限（provider/skill/mcp_server/agent_config 的读取授权） |

### 集成

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| ChannelBindingRepo | `channel-binding.ts` | 纯 PostgreSQL | Hermes 通道绑定（遗留，platform→Agent 映射） |
| ShareLinkRepo | `share-link.ts` | 纯 PostgreSQL | 会话分享链接（token 生成、访问计数） |
| AgentSiteAppRepo | `agent-site-app.ts` | 纯 PostgreSQL | Agent Sites 应用映射与凭证管理 |

## 存储策略的选择

### 为什么大部分仓储用纯 PostgreSQL？

环境记录、会话、知识库、工作流等是持久化的核心数据——用户创建后希望重启后还在。所有操作直接走数据库查询，不引入内存缓存层，保证数据一致性。

### 为什么 SessionRepo 是纯 PG 而不是内存+PG 双写？

SessionRepo (`session.ts`) 的 `getById()` 直接查询 `agent_session` 表，没有内存 Map 缓存层，也没有 `loadFromDB()` 方法。Session 的读写频率在 RCS 中并不高（消息事件通过 EventBus/WebSocket 实时推送，不依赖 session 表轮询），直接用 PG 查询即可满足性能需求。

### 为什么 Token、WorkItem、SessionWorker 用纯内存？

这些是短生命周期的临时数据：
- **TokenRepo**：遗留 token 认证，仅在进程生命周期内有效，重启后重新生成
- **WorkItemRepo**：CLI bridge 的工作分发队列，重启后重新分发即可
- **SessionWorkerRepo**：Worker 心跳状态，依赖 WebSocket 实时更新，重启后状态自然重置

## 接口设计

大部分仓储定义接口 + 实现类的模式，导出单例实例：

```text
ISessionRepo（接口）
    └── PgSessionRepo（实现）── sessionRepo（单例）

IEnvironmentRepo（接口）
    └── PgEnvironmentRepo（实现）── environmentRepo（单例）

IShareLinkRepo（接口）
    └── PgShareLinkRepo（实现）── shareLinkRepo（单例）
```

例外：`workflow-def.ts` 不使用接口-实现类模式，直接导出具名函数（`createWorkflowDef`、`saveDraft`、`publishVersion` 等），调用方通过参数传入 `AuthCtx`（含 `organizationId`、`userId`）。

`src/repositories/index.ts` 统一 re-export 所有单例和类型，方便其他模块 import。

## 测试支持

`src/repositories/index.ts` 导出 `resetAllRepos()` 函数，调用所有内存仓储（`sessionRepo`、`tokenRepo`、`workItemRepo`、`sessionWorkerRepo`）的 `reset()` 方法。测试在每个用例前调用此函数清理内存状态。PostgreSQL 仓储通过 `resetAllStubs()`（`src/test-utils/`）配置 mock 行为。

## 和其他模块的关系

- → `db/index.ts`（PostgreSQL 连接）
- → `db/schema.ts`（Drizzle ORM 的表定义）
- → `services/workflow/workflow-fs.ts`（工作流 YAML 文件系统读写）
- ← `services/*`（Service 层调用仓储的 CRUD 函数）
- ← `transport/acp-ws-handler.ts`（直接引用 environmentRepo 更新状态）
- ← `routes/*`（路由 handler 直接 import 仓储单例使用）
