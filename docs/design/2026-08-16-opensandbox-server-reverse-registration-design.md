# OpenSandbox Server 反向连接与 FRP 隧道设计

> 本文记录 tunnel 能力的设计决策和实现边界。系统当前架构以
> [`docs/arch/opensandbox-cluster.md`](../arch/opensandbox-cluster.md) 为准，部署步骤以各目录 README 为准。

## 1. 背景与目标

当前 direct 模式由 Cluster 主动访问 Server 的 `base_url`。当 Server 位于内网、无公网入站端口或防火墙禁止入站连接时，该模式无法使用。

本设计增加 tunnel 模式：Server 内的 `frpc` 主动连接 Cluster 的 `frps`，Cluster 通过 FRP vhost 反向访问 Server。Server 不需要向 Cluster 提供入站端口。

目标：

- direct 与 tunnel 可在同一 Cluster 中共存；
- 新建 Server 或已有 direct Server 均可使用 tunnel；
- 每个 Server 使用一份由 Cluster 生成的静态 `frpc.toml`；
- 断线后 frpc 自动重连，Cluster 自动恢复连接和健康状态；
- 保留 `base_url`，支持后续切回 direct；
- 不改变现有 sandbox binding 和上游 Provider 的 sandbox ID 管理方式。

非目标：

- 本期不实现 Cluster 多节点、多 frps 编排；
- 不实现 WebSocket/TTY 专用通道；未来需要时沿用同一 FRP 连接扩展代理类型；
- 不实现远程 Server 自动迁移或跨节点故障转移；
- 不在 Cluster 保存 Provider sandbox ID。

## 2. 架构设计

### 2.1 连接模式

```text
direct:
调用方 -> Cluster -> Server:base_url

tunnel:
Server:frpc --主动出站--> Cluster:frps
调用方 -> Cluster -> frps vhost -> frpc -> Server:8080
```

Cluster 根据 `transport_mode` 选择唯一请求路径：

- `direct` 使用 Server 的 `base_url`；
- `tunnel` 使用内部 frps vhost 地址，并通过 `Host: route_host` 路由到对应 frpc。

Server 容器不发布管理端口或沙盒端口；只需允许访问 `${FRP_PUBLIC_ADDRESS}:${FRP_BIND_PORT}`。direct 部署继续使用现有 dind Compose 和端口映射。

### 2.2 组件职责

| 组件 | 职责 |
| --- | --- |
| Cluster API | 创建/更新 Server、切换 transport、下载 frpc 配置 |
| Cluster proxy | 根据 transport 解析目标并转发 HTTP 请求 |
| Cluster monitor | 探测 tunnel 健康度，恢复连接状态 |
| frps | 接受 frpc 出站连接，按 vhost 转发请求 |
| frpc | 在 Server 内主动连接 frps，暴露 Server 本地 HTTP |
| OpenSandbox Server | 提供本地 OpenSandbox HTTP API 和 Docker runtime |

### 2.3 单实例边界

当前部署按单 Cluster、单 frps 设计。`opensandbox_tunnel_connection` 每个 Server 只有一条当前连接记录；frpc 重连更新同一记录，不保存连接历史。未来若引入多个 Cluster 或 frps，需要增加 gateway/实例归属字段和调度策略，本期不预留这些字段。

## 3. 数据模型

### 3.1 `opensandbox_server` 扩展

保留原有字段，并增加：

| 字段 | 说明 |
| --- | --- |
| `transport_mode` | `direct` 或 `tunnel`，默认 `direct` |
| `route_host` | tunnel vhost 的唯一 Host，切换后保留 |
| `last_health_at` / `health_status` / `last_error` | 当前请求路径的健康状态 |

`base_url` 始终保留：新建 tunnel Server 可以为空，已有 direct Server 切换后仍保留原值，便于切回 direct。`transport_mode` 是请求路径的唯一选择依据。

### 3.2 `opensandbox_server_credential`

保存 Server tunnel 注册凭证：

- `server_id` 唯一关联 Server；
- 数据库存储 token hash，不存明文 token；
- 完整 token 只在生成配置时返回给管理员，之后不能从 Cluster 恢复；
- token 通过 HTTPS 或受控 HTTP 管理接口传输，日志和普通 Server 查询不得返回。

### 3.3 `opensandbox_tunnel_connection`

保存当前连接 lease：

- `server_id` 唯一；
- `frp_run_id` 用于旧连接 fencing；
- `status`：`connected` / `disconnected`；
- `health_status`：`unknown` / `healthy` / `unhealthy`；
- `last_seen_at`、`disconnected_at`、`last_error` 保存诊断信息。

FRP Login、NewProxy、Ping、CloseProxy 回调必须校验 server、node token 和当前 run ID，旧连接不能覆盖新连接状态。

### 3.4 `sandbox_binding`

保持现有结构和语义，不因 tunnel 重建或迁移。binding 仍然只记录业务 `sandbox_id` 到 `server_id` 的落点和容量占用，不记录 Provider sandbox ID，也不随 transport 切换改变。

## 4. 业务逻辑设计

### 4.1 Server 创建

`POST /api/v1/servers` 是统一创建接口：

- 不传 `transport_mode`：按原 direct 语义创建，需要 `base_url`；
- `transport_mode=tunnel`：创建 tunnel Server，可不提供 `base_url`，同时创建 credential 和 route host。

创建 tunnel Server 后，管理员下载 `frpc.toml` 并启动独立 tunnel Compose。Server 成功 Login 和健康检查后才参与分配。

### 4.2 direct 切换 tunnel

```http
PUT /api/v1/servers/:serverId/tunnel
GET /api/v1/servers/:serverId/tunnel/frpc.toml
```

切换要求：

1. direct Server 必须先停止，Cluster 通过健康检查确认其离线；
2. 第一次调用生成并持久化 route host 和 credential；
3. `transport_mode` 一次性切换为 `tunnel`，原 `base_url` 保留；
4. 重复调用幂等复用已有配置，不轮换 token；
5. 下载接口返回可直接使用的完整 TOML，不要求调用方手工拼装。

Server 仍在线时返回冲突，避免请求路径在运行中突然切换。

### 4.3 frpc 配置

每台 Server 一份静态配置，关键内容由 Cluster 生成：

- `serverAddr`、`serverPort`；
- `loginFailExit=false`，允许网络恢复后自动 Login；
- token auth 和 Server 专属 node token；
- `heartbeatInterval=10`、`heartbeatTimeout=30`、`dialServerKeepalive=30`；
- Server 本地 `127.0.0.1:8080` 的 HTTP proxy 和唯一 route host。

配置文件应设置 `0600` 或更严格权限，不提交到 Git。frps 0.69 不接受客户端心跳字段，因此心跳参数只写入 frpc 配置，frps 保持兼容配置。

### 4.4 连接、健康与恢复

```text
frpc Login
  -> Cluster 创建/更新 connected lease
  -> Cluster 调用 tunnel /health
  -> 成功：connected + healthy
  -> 失败：connected + unhealthy

连接超时或 CloseProxy
  -> disconnected
  -> monitor 继续对 disconnected 节点做受控探测
  -> 探测成功：恢复 connected，清理 disconnected_at 和 last_error
```

frpc 负责网络层自动重连；Cluster 负责状态恢复。代理请求遇到 `SERVER_DISCONNECTED` 时最多主动触发一次恢复探测，再重新解析目标；恢复失败返回 503，不做无界重试。

### 4.5 分配与代理

- tunnel Server 只有在连接有效且健康时才参与新分配；
- 已有 binding 不会因为 tunnel 断线被自动迁移；
- direct/tunnel 使用相同的 sandbox proxy API、API Key 注入和 host volume 路径改写；
- frps 只承载 HTTP vhost。未来 TTY 或 WebSocket 需求可增加对应 FRP proxy 类型，但不改变 Server 注册模型。

## 5. 安全与兼容

- Cluster API 继续使用 Cluster service API Key；
- OpenSandbox Server API Key 由 Server 提供并加密存储，不由 Cluster 生成；
- FRP token 和 Server node token 分离职责，数据库只保存 hash；
- token、API Key、frp run ID 和 Plugin 原始请求不得出现在普通响应或日志；
- FRP 登录端口只需要对 Server 出站可达，Plugin 和 vhost 不发布公网；
- direct Server 不创建 tunnel credential/connection，frps 故障不影响 direct 请求；
- `base_url`、route host、binding 和 Server API Key 在 direct/tunnel 切换中保留，支持回滚。

## 6. 部署与验证

### 6.1 部署入口

| 模式 | Compose | 网络要求 |
| --- | --- | --- |
| direct | `docker/opensandbox-server/docker-compose.dind.yml` | Cluster 必须能访问 Server 入站端口 |
| tunnel | `docker/opensandbox-server-tunnel/docker-compose.yml` | Server 只需访问 frps 登录端口 |

tunnel 配置下载后放在独立目录，执行：

```bash
cd docker/opensandbox-server-tunnel
docker compose up -d --build
```

独立 Compose 使用独立 project 和 Docker volume，不会覆盖 direct/dind 部署。

### 6.2 验证重点

- direct Server 注册、健康检查、分配和代理保持原行为；
- tunnel Server 创建、配置下载、Login 和健康检查成功；
- 已有 direct Server 停机后可幂等切换 tunnel；
- 同一 Server 重复下载配置不会轮换 token；
- frps 停止后 frpc 自动重试，frps 恢复后无需重启 Server 即可恢复 `connected/healthy`；
- tunnel 断开期间 direct Server 仍可正常使用；
- 同一 `server_id` 只有一条 tunnel connection，旧 run ID 回调被拒绝；
- Fenix 通过 Cluster 创建、进入和销毁 sandbox 的人工 E2E 通过。

详细测试步骤见部署目录下的 tunnel 手工 E2E 文档，迁移文件和实现细节以代码与 Drizzle migration 为准。
