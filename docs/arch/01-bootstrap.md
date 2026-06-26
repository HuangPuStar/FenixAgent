# 入口与启动

> 对应文件：`src/index.ts`、`src/env.ts`、`src/config.ts`

## 这个模块干什么

`index.ts` 是整个后端的入口。它负责三件事：

1. **启动前的初始化**——校验环境变量、连接数据库、运行数据迁移、同步内置资源、启动调度器、启动各类后台任务
2. **组装路由**——把所有路由模块挂到 Elysia 上
3. **优雅关闭**——收到 SIGINT/SIGTERM 时，按顺序清理所有资源

## 启动顺序

服务器启动时，按以下顺序执行初始化，每一步依赖前一步完成：

```text
① interceptConsole()        劫持全局 console 输出到统一日志系统 @fenix/logger
② initDb()                 连接 PostgreSQL，初始化 better-auth
③ validateEnv() + applyEnv()  校验 process.env 并应用到 config 对象
④ ensureSystemAdmin()      确保系统管理员用户存在（读密码文件、创建用户）
⑤ runDataMigrations()      运行数据库数据迁移（如 Skill 存储重组）
⑥ reset agent_session      将所有 agent_session 状态重置为 idle（重启后 WS/EventBus 已断开）
⑦ getCoreRuntime()         初始化 Core Runtime（引擎插件注册中心等）
⑧ startScheduler()         读取所有 enabled 的定时任务，注册 cron job
⑨ syncBuiltin()            同步内置资源配置（Agent/Skill/Model 等）到系统管理员组织
⑩ initCustomToolsRegistry() 扫描 WORKFLOW_TOOLS_DIR，注册自定义工作流节点工具
⑪ initHermesClient()       如果配了 HERMES_URL，连接 IM 网关
⑫ checkRagFlowHealth()     验证 RagFlow 知识库引擎连通性（失败不阻塞启动）
⑬ pkill stale acp-link     杀掉上次运行残留的 acp-link 子进程
⑭ startMachineSweep()      启动机器注册表心跳巡检（60s 周期）
⑮ startAcpIdleMonitor()    启动 ACP 空闲实例回收监控
⑯ Elysia route assembly    组装所有路由、插件、openapi 文档
⑰ app.listen()             开始监听 HTTP 端口
```

## 关闭顺序

收到关闭信号时，按以下顺序清理资源：

```text
① hermesClient.stop()      断开 IM 网关连接
② stopAcpIdleMonitor()     停止 ACP 空闲监控定时器
③ closeAllRelayConnections()  关闭所有前端 relay WebSocket
④ closeAllAcpConnections()   关闭所有 acp-link WebSocket 连接，持久环境→idle，临时环境→删除
⑤ closeAllFileWsConnections() 关闭所有文件操作 WebSocket 连接
⑥ stopAllInstances()       SIGTERM 所有子进程
⑦ stopScheduler()          取消所有 cron job
⑧ closeCache()             关闭 Redis 缓存连接（如已配置）
⑨ pgClient.end()           关闭数据库连接
```

## 环境变量

环境变量是系统的运行时配置。`env.ts` 是唯一真相来源，使用 Zod v4 `envSchema` 校验所有变量，校验失败时测试环境抛异常、生产环境退出进程。`config.ts` 通过 `applyEnv()` 从校验结果构建 `AppConfig` 对象。

### 必填

| 环境变量 | 说明 |
|---------|------|
| `DATABASE_URL` | PostgreSQL 连接串 |
| `RCS_API_KEYS` | acp-link / worker JWT 签名密钥（逗号分隔的多 key） |

### 可选：服务器

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `NODE_ENV` | `development` | 运行环境（`development` / `production` / `test`） |
| `RCS_HOST` | `0.0.0.0` | HTTP 监听地址 |
| `RCS_PORT` | `3000` | HTTP 端口 |
| `RCS_CORS_ORIGIN` | `*` | CORS 允许来源，支持逗号分隔多个 origin |
| `RCS_TRUSTED_ORIGINS` | 空 | better-auth 可信前端来源，支持逗号分隔；默认包含 localhost dev 和公开 base URL |
| `RCS_BASE_URL` | 空 | 外部访问 URL，acp-link 回连时用 |
| `RCS_VERSION` | `0.1.0` | 版本号 |
| `SKILL_DIR` | `./data/skills` | Skill 文件系统存储目录 |
| `RCS_SYSTEM_ADMIN_PASSWORD_FILE` | `./data/password.txt` | 首次启动管理员密码存放路径 |
| `APP_BRAND_NAME` | `Fenix` | 品牌名称 |
| `APP_LOGO_PATH` | 空 | 品牌 Logo 路径 |
| `WORKSPACE_ROOT` | 空 | 覆盖 workspace 根目录（默认 cwd/workspaces） |

### 可选：HTTP / WebSocket

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RCS_POLL_TIMEOUT` | `8` | 机器长轮询超时（秒） |
| `RCS_HEARTBEAT_INTERVAL` | `20` | 心跳间隔（秒） |
| `RCS_WS_IDLE_TIMEOUT` | `255` | Bun WebSocket 协议级空闲超时（秒），应大于 wsKeepaliveInterval * 3 |
| `RCS_WS_KEEPALIVE_INTERVAL` | `20` | 服务端→客户端心跳间隔（秒） |
| `RCS_DISCONNECT_TIMEOUT` | `120` | 无活动判定断连的超时（秒） |
| `RCS_JWT_EXPIRES_IN` | `3600` | Worker JWT 过期时间（秒） |
| `RCS_ACP_IDLE_TIMEOUT_SECONDS` | `1200` | ACP 实例在前端 relay 全部断开后允许继续空闲的秒数 |
| `RCS_ACP_IDLE_SWEEP_INTERVAL_SECONDS` | `300` | ACP 空闲实例扫描周期（秒） |
| `RCS_ACP_ACTIVITY_TIMEOUT_SECONDS` | `7200` | 无 ACP 业务活动的硬超时秒数，命中后即使 relay 仍存在也会回收实例 |

### 可选：知识库（RagFlow）

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RAGFLOW_API_URL` | `http://localhost:9380` | RagFlow API 地址 |
| `RAGFLOW_API_KEY` | 空 | RagFlow API 密钥 |
| `RAGFLOW_REQUEST_TIMEOUT_MS` | `30000` | RagFlow 请求超时（毫秒） |

### 可选：认证

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RCS_DISABLE_SIGNUP` | `false` | 禁用注册 |
| `RCS_SYSTEM_API_KEYS` | 空 | 系统级 API Key（用于 `/api/system/*` 路由） |

### 可选：Hermes

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `HERMES_URL` | 空 | Hermes IM 网关地址，不配则不启动 |
| `HERMES_PLATFORMS` | 空 | Hermes 支持的平台列表 |

### 可选：Hindsight 记忆 MCP

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `HINDSIGHT_MCP_URL` | 空 | Hindsight 记忆服务 MCP 地址 |

### 可选：Agent Sites 代理

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `AGENT_SITES_BASE_URL` | 空 | Agent Sites 业务前端地址 |
| `AGENT_SITES_MASTER_KEY` | 空 | Agent Sites 主密钥 |

### 可选：Agent 智能生成

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `OPENAI_MODEL` | 空 | Meta Agent 智能生成使用的模型名（OPENAI_API_KEY / OPENAI_BASE_URL 由 OpenAI SDK 自动读取） |

### 可选：Workflow

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `WORKFLOW_TOOLS_DIR` | `./tools` | 自定义节点工具目录，启动时扫描 .ts 文件并注册 |
| `ACPX_G_URL` | `http://localhost:8848` | acpx-g 工作流引擎反向代理地址 |

### 可选：注册中心

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `REGISTRY_SECRET` | `rcs-registry-secret` | 机器注册中心密钥 |

### 可选：引擎

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RCS_ENGINE_TYPE` | `opencode` | Agent 引擎类型（`opencode` / `ccb`） |
| `RCS_CCB_COMMAND` | `ccb` | CCB 引擎启动命令 |
| `RCS_CCB_ARGS` | `--acp` | CCB 引擎启动参数 |

### 可选：Redis 缓存

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RCS_REDIS_URL` | 空 | Redis 连接 URL |
| `RCS_REDIS_PASSWORD` | 空 | Redis 密码 |
| `RCS_REDIS_CLUSTER` | 空 | Redis 集群节点（逗号分隔） |

## 和其他模块的关系

- 调用 `services/env.ts` 校验环境变量
- 调用 `services/config.ts` 应用配置
- 调用 `services/system-admin.ts` 确保系统管理员存在
- 调用 `services/data-migrate.ts` 运行数据迁移
- 调用 `services/core-bootstrap.ts` 初始化核心运行时
- 调用 `services/sync-builtin.ts` 同步内置资源
- 调用 `services/workflow/custom-tools.ts` 注册自定义节点工具
- 调用 `services/scheduler.ts` 启停定时任务
- 调用 `services/hermes-client.ts` 启停 IM 网关连接
- 调用 `services/knowledge-provider/ragflow.ts` 检查知识库引擎健康
- 调用 `services/registry-heartbeat.ts` 启停机器心跳巡检
- 调用 `services/acp-idle-monitor.ts` 启停 ACP 空闲实例监控
- 调用 `services/instance.ts` stop 子进程
- 调用 `services/cache.ts` 关闭缓存连接
- 调用 `transport/` 关闭各类型 WebSocket 连接
- 挂载 `routes/` 下所有路由模块
- 挂载 `plugins/` 下所有插件
