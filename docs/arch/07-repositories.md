# 仓储层

> 对应文件：`src/repositories/`、`src/plugins/repositories.ts`

## 这个模块干什么

仓储层是数据访问的统一封装。Service 层需要读写数据时，不直接写 SQL，而是调用仓储层的函数。每个仓储负责一个领域对象（Environment、Session、Token 等）的 CRUD 操作。

这样设计的好处：Service 层不需要知道数据存在内存还是数据库，只需要调用仓储接口。如果以后要换存储方式，只改仓储层就行。

## 六个仓储

| 仓储 | 文件 | 存储方式 | 说明 |
|------|------|----------|------|
| EnvironmentRepo | `environment.ts` | 纯 PostgreSQL | 环境记录，直接操作 `environment` 表 |
| SessionRepo | `session.ts` | 内存 Map + PostgreSQL 双写 | 会话记录，读走内存，写双写到 DB |
| SessionWorkerRepo | `session-worker.ts` | 纯内存 | Worker 状态追踪 |
| TokenRepo | `token.ts` | 纯内存 | 遗留 token 存储 |
| WorkItemRepo | `work-item.ts` | 纯内存 | CLI bridge 的 work 队列 |
| ShareLinkRepo | `share-link.ts` | 纯内存 | 分享链接 |

## 存储策略的选择

### 为什么 Environment 用纯 PG？

环境记录是持久化的核心数据——用户创建了一个环境（指定了 workspace 路径、Agent 名称等），希望重启后还在。所有操作（查询、更新、列表）都直接走数据库查询。

### 为什么 Session 用内存 + PG 双写？

Session 是高频读写的对象——每条消息都会触发 session 的更新。如果每次读都查数据库，性能会很差。所以：

- **读**：直接从内存 Map 取，O(1)
- **写**：先更新内存，再异步写入 PostgreSQL（确保持久性）
- **启动时**：`loadFromDB()` 从数据库恢复所有 session 到内存

### 为什么 Token、WorkItem、ShareLink 用纯内存？

这些是短生命周期的临时数据：
- Token：遗留代码，未来会清理
- WorkItem：CLI bridge 的短生命周期工作队列，重启后重新分发即可
- ShareLink：功能开发中，暂未持久化

## 接口设计

每个仓储都定义了接口（`IEnvironmentRepo`、`ISessionRepo` 等），导出的是接口类型和单例实例：

```text
IEnvironmentRepo（接口）
    └── PgEnvironmentRepo（实现）── environmentRepo（单例）

ISessionRepo（接口）
    └── SessionRepo（实现）── sessionRepo（单例）
```

`src/repositories/index.ts` 统一导出所有单例，方便其他模块 import。

## DI 注入

通过 `plugins/repositories.ts` 把仓储实例注入到 Elysia 的 context 里，路由 handler 可以直接从 `store` 中获取。但实际上很多 Service 层代码直接 import `repositories/index.ts` 的单例，两种方式并存。

## 和其他模块的关系

- → `db/index.ts`（PostgreSQL 连接）
- → `db/schema.ts`（Drizzle ORM 的表定义）
- ← `services/*`（Service 层调用仓储的 CRUD 函数）
- ← `transport/acp-ws-handler.ts`（直接引用 environmentRepo 更新状态）
- ← `plugins/repositories.ts`（注入到 Elysia context）
