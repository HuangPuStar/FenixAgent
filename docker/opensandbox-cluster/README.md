# OpenSandbox Cluster 部署

本目录提供 OpenSandbox Cluster 的 Docker Compose 部署。Cluster 使用 SQLite 保存资源池、OpenSandbox Server 和 sandbox binding，不挂载 Docker Socket。

单机离线部署和日常运维请参考：

- [`deploy/fenix-integration.md`](deploy/fenix-integration.md)
- [`fenix-sandbox-ops.sh`](../../fenix-sandbox-ops.sh)

契约与边界见 [`docs/operations/docker-topology.md`](../../docs/operations/docker-topology.md)（§3 网络分层、§6 依赖目录契约）。

## 前置条件

- Docker Engine + Compose v2（≥ 2.20）。
- 主服务项目已启动（`./docker/deploy.sh up`，或在仓库根 `docker compose up -d`）：`fenix-server` 网络由主服务项目创建（dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`），本目录以 `external` 方式接入。
- 一个供 OpenSandbox Server 节点访问的地址（`FRP_PUBLIC_ADDRESS`）。

## 启动

```bash
cd docker/opensandbox-cluster
cp .env.example .env
# 填写 .env 的必需项：FRP_PUBLIC_ADDRESS / FRP_TOKEN / CLUSTER_SERVICE_API_KEY / SERVER_API_KEY_ENCRYPTION_KEY
docker compose up -d
curl -fsS "http://127.0.0.1:${OPENSANDBOX_CLUSTER_PORT:-8080}/health"
```

也可由一键入口启动：在 `docker/deploy.env` 里打开 `FENIX_FEATURE_OPENSANDBOX_CLUSTER=true`，再执行 `./docker/deploy.sh up`。

Cluster 启动时会自动执行 SQLite 迁移，数据保存在本目录同级的 `./data/opensandbox-cluster.db`（bind 挂载，随交付面搬迁）。

## 配置

| 参数 | 说明 |
| --- | --- |
| `FRP_PUBLIC_ADDRESS` | **必需**。Server 访问 frps 的地址（域名或 IP） |
| `FRP_TOKEN` | **必需**。frpc/frps 登录认证与 Plugin 路径令牌 |
| `CLUSTER_SERVICE_API_KEY` | **必需**。调用方访问 Cluster 的鉴权 Token；主服务的 `RCS_SANDBOX_CLUSTER_API_KEY` 填同值 |
| `SERVER_API_KEY_ENCRYPTION_KEY` | **必需**。32 字节密钥，用于加密 Server API Key |
| `FRP_BIND_PORT` | frps 对外登录端口，默认 `7000` |
| `OPENSANDBOX_CLUSTER_PORT` | 管理 API 的宿主端口（只绑回环），默认 `8080` |
| `PROXY_CONNECT_TIMEOUT_MS` | 连接 OpenSandbox Server 的超时 |
| `PROXY_RESPONSE_TIMEOUT_MS` | 代理请求响应超时 |

镜像 tag 写死在本目录 `docker-compose.yml` 的 `image:` 行；升级 = 改该行 + `docker compose up -d`。
本目录不声明 `build:`：需要从本仓源码自建时，在仓库根执行
`docker build -f docker/opensandbox-cluster/Dockerfile -t ghcr.io/huangpustar/fenixagent-opensandbox-cluster:<tag> .`，
再 `docker compose up -d`；本地镜像占用同一个 tag，要回到发布版本时用 `docker compose pull` 覆盖。

## 网络接入清单

| 服务 | 网络 | 理由 |
| --- | --- | --- |
| `opensandbox-cluster` | 项目默认网络 + `fenix-server` | 主服务经 `fenix-server` 以 `http://opensandbox-cluster:8080` 调用管理 API；默认网络用于 frps 回调 Plugin（`opensandbox-cluster:8081`） |
| `frps` | 项目默认网络 | 只服务远程节点的隧道接入，主服务不直连 |

宿主端口：`OPENSANDBOX_CLUSTER_PORT` 只绑 `127.0.0.1`；`FRP_BIND_PORT` 是远程节点主动连入的入口，绑 `0.0.0.0`。

主服务侧的对应配置（主服务 env：生产 `docker/main/.env`、dev 仓库根 `.env`）：`RCS_SANDBOX_CLUSTER_URL=http://opensandbox-cluster:8080`（同机部署）或 `http://<宿主机地址>:<OPENSANDBOX_CLUSTER_PORT>`（跨机部署）。

## 部署 OpenSandbox Server 节点

OpenSandbox Server 不与 Cluster 部署在同一个 Compose 中。请在每台沙盒机器上参考
[`docker/opensandbox-server/README.md`](../opensandbox-server/README.md) 独立部署 DinD 版 OpenSandbox Server。

节点启动并确认健康后，再将节点注册到 Cluster。direct 节点需要提供可访问的 `base_url`；tunnel 节点通过 FRP 主动连接，不挂载节点的 Docker Socket。

## 注册 OpenSandbox Server

```bash
CLUSTER_URL=http://127.0.0.1:8080
CLUSTER_SERVICE_API_KEY=change-me

curl -X POST "$CLUSTER_URL/api/v1/pools" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"id":"pool-default","name":"Default"}'

curl -X POST "$CLUSTER_URL/api/v1/servers" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{
    "id":"server-node-1",
    "pool_id":"pool-default",
    "name":"Node 1",
    "base_url":"http://node-1:8090",
    "workspace_root":"/workspace",
    "api_key":"replace-with-server-api-key",
    "max_sandboxes":10
  }'
```

`base_url` 必须是 Cluster 容器可以访问的 OpenSandbox Server 地址。
`workspace_root` 必须与 Server 节点 Compose 挂载路径和 `sandbox.toml` 的
`storage.allowed_host_paths` 保持一致。

## 停止和备份

```bash
docker compose stop
cp data/opensandbox-cluster.db /backup/opensandbox-cluster.db
docker compose start
```

不要在 Cluster 运行时直接复制正在写入的 SQLite 文件。

## FRP tunnel 配置

默认 Compose 同时启动 Cluster 和单实例 `frps`。宿主机只发布：

- Cluster 管理 API：`OPENSANDBOX_CLUSTER_PORT`（默认 `8080`，只绑回环）；
- FRP 登录端口：`FRP_BIND_PORT`（默认 `7000`，对沙盒机器开放）。

Cluster 的 Plugin `8081` 和 frps vhost `7080` 仅在 Docker 内部网络可见。

`.env` 至少配置：

```env
FRP_PUBLIC_ADDRESS=cluster.example.com
FRP_BIND_PORT=7000
FRP_TOKEN=replace-with-a-url-safe-random-token
```

`FRP_TOKEN` 同时用于 frpc/frps 登录认证和 frps 回调 Cluster Plugin，建议只使用字母、数字、`-`、`_`。

tunnel 配置有两种入口，二选一：

- 新建 Server：在 `POST /api/v1/servers` 中设置 `transport_mode=tunnel`；
- 迁移已有 direct Server：先停机，再调用 `PUT /api/v1/servers/:serverId/tunnel`，由接口检查离线并切换模式。

完成任一入口后，再调用 `GET /api/v1/servers/:serverId/tunnel/frpc.toml` 下载配置。

然后将配置挂载到 Server 的 `/etc/frp/frpc.toml`，参考 [`../opensandbox-server-tunnel/README.md`](../opensandbox-server-tunnel/README.md) 启动或重启 Server，等待 FRP 连接恢复。

Cluster 管理 API 支持 HTTP 或 HTTPS，FRP 数据链路固定启用 TLS。
