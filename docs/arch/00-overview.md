# 总览：RCS 后端模块地图

本文档是后端各模块文档的导航入口，帮助快速定位每个模块的详细设计文档。

## 模块清单

| 模块 | 文档 | 一句话说明 |
|------|------|-----------|
| 入口与启动 | [01-bootstrap.md](./01-bootstrap.md) | 服务器启动、关闭，以及全局初始化流程 |
| 路由层 | [02-routes.md](./02-routes.md) | HTTP 请求入口，每个 URL 前缀对应什么功能 |
| 认证系统 | [03-auth.md](./03-auth.md) | 用户登录、API Key、权限校验的完整链路 |
| ACP 传输层 | [04-acp-transport.md](./04-acp-transport.md) | WebSocket 双向通信：acp-link 注册、前端 Relay、EventBus |
| 实例管理 | [05-instance.md](./05-instance.md) | acp-link 子进程的 spawn、端口分配、生命周期（由 Environment 资源管理层调度） |
| 配置系统 | [06-config.md](./06-config.md) | Provider/Model/Agent/MCP/Skill 的 CRUD 存储 |
| 仓储层 | [07-repositories.md](./07-repositories.md) | 数据访问的统一封装，哪些走内存、哪些走数据库 |
| 数据库 | [08-database.md](./08-database.md) | PostgreSQL 表结构、Drizzle ORM、表间关系 |
| 定时任务 | [09-scheduler.md](./09-scheduler.md) | Cron 调度、任务执行、日志记录 |
| Channel 与 Hermes | [10-hermes.md](./10-hermes.md) | 多平台 IM 消息网关，聊天平台到 Agent 的桥接 |
| 知识库 | [11-knowledge.md](./11-knowledge.md) | 知识库 CRUD、文件上传索引、Agent 绑定 |
| 文件 | [12-files.md](./12-files.md) | 会话文件系统 |
| 插件层 | [13-plugins.md](./13-plugins.md) | Elysia 插件：CORS、日志、错误处理、静态文件 |
| 用户与权限 | [14-auth-and-permissions.md](./14-auth-and-permissions.md) | 认证链路、资源隔离方式、当前缺失的权限能力 |
| 团队权限方案 | [15-team-permissions-design.md](./15-team-permissions-design.md) | 从用户隔离→团队共享+管理员全局可见的设计（未实施） |
| 领域模型关联图 | [16-domain-model.md](./16-domain-model.md) | Agent/Environment/Session/Channel/Knowledge 等概念的关联关系 |

## 分层全景

```
外部系统（前端 / acp-link / Hermes / CLI）
        │
        ▼
┌─ Routes ──────── HTTP 请求分发，参数校验
│       │
│  ┌─ Plugins ──── 认证、CORS、日志等横切逻辑
│  │
│  ▼
├─ Services ────── 业务逻辑（配置、实例、调度、知识库……）
│       │
│  ┌───┴──────┐
│  ▼          ▼
├─ Repos      Transport
│  (数据访问)  (WebSocket/EventBus)
│  │          │
│  ▼          ▼
└─ DB         EventBus
   (PostgreSQL) (进程内 pub/sub)
```

**依赖方向**：上面的层可以调用下面的层，下面的层不知道上面的层存在。
