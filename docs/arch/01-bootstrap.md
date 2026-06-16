# 入口与启动

> 对应文件：`src/index.ts`、`src/config.ts`

## 这个模块干什么

`index.ts` 是整个后端的入口。它负责三件事：

1. **启动前的初始化**——连接数据库、恢复会话、启动调度器、连接 Hermes
2. **组装路由**——把所有路由模块挂到 Elysia 上
3. **优雅关闭**——收到 SIGINT/SIGTERM 时，按顺序清理所有资源

## 启动顺序

服务器启动时，按以下顺序执行初始化，每一步依赖前一步完成：

```text
① initDb()               连接 PostgreSQL，初始化 better-auth
② migrateSkillsDir()      把旧目录的 skill 文件迁移到新路径
③ sessionRepo.loadFromDB() 从数据库恢复上次的会话记录到内存
④ startScheduler()        读取所有 enabled 的定时任务，注册 cron job
⑤ initHermesClient()      如果配了 HERMES_URL，连接 IM 网关
⑥ pkill stale processes   杀掉上次运行残留的 acp-link 子进程
⑦ autoStart instances     遍历标记了 autoStart 的环境，自动 spawn 实例
⑧ Elysia listen           开始监听 HTTP 端口
```

## 关闭顺序

收到关闭信号时，反方向清理：

```text
① hermesClient.stop()     断开 IM 网关连接
② closeAllAcpConnections() 关闭所有 acp-link 的 WebSocket，持久环境→idle，临时环境→删除
③ closeAllRelayConnections() 关闭所有前端 relay WebSocket
④ stopAllInstances()       SIGTERM 所有子进程
⑤ stopScheduler()          取消所有 cron job
⑥ pgClient.end()           关闭数据库连接
```

## 全局配置

`config.ts` 是一个纯对象，从环境变量读取所有配置项。没有运行时动态更新，改配置需要重启。

关键配置项：

| 环境变量 | 默认值 | 说明 |
|---------|--------|------|
| `RCS_PORT` | 3000 | HTTP 端口 |
| `RCS_CORS_ORIGIN` | `*` | CORS 允许来源，支持逗号分隔多个 origin |
| `RCS_TRUSTED_ORIGINS` | 空 | better-auth 可信前端来源，支持逗号分隔；默认包含 localhost dev 和公开 base URL |
| `RCS_BASE_URL` | 空 | 外部访问 URL，acp-link 回连时用 |
| `RCS_API_KEYS` | 空 | 全局 API Key（逗号分隔），遗留用途 |
| `RCS_WS_IDLE_TIMEOUT` | 255 | Bun WebSocket 空闲超时（秒） |
| `RCS_WS_KEEPALIVE_INTERVAL` | 20 | 服务端→客户端心跳间隔（秒） |
| `RCS_DISCONNECT_TIMEOUT` | 120 | 无活动判定断连的超时（秒） |
| `HERMES_URL` | 空 | Hermes IM 网关地址，不配则不启动 |

## 和其他模块的关系

- 调用 `transport/` 关闭 WebSocket 连接
- 调用 `services/instance` spawn 和 stop 子进程
- 调用 `services/scheduler` 启停定时任务
- 调用 `services/hermes-client` 启停 IM 网关连接
- 调用 `repositories/session` 从 DB 恢复会话
- 挂载 `routes/` 下所有路由模块
- 挂载 `plugins/` 下所有插件
