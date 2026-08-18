# OpenSandbox Cluster 部署

本目录提供 OpenSandbox Cluster 的 Docker Compose 部署。Cluster 使用 SQLite 保存资源池、OpenSandbox Server 和 sandbox binding，不挂载 Docker Socket。

单机离线部署和日常运维请参考：

- [`deploy/fenix-integration.md`](deploy/fenix-integration.md)
- [`fenix-sandbox-ops.sh`](../../fenix-sandbox-ops.sh)

## 启动

```bash
cd docker/opensandbox-cluster
cp .env.example .env
# 手动修改 .env 中的鉴权密钥
docker compose up -d --build
curl -fsS http://127.0.0.1:${PORT:-8080}/health
```

Cluster 启动时会自动执行 SQLite 迁移，数据保存在 Compose volume `opensandbox-cluster-data` 中。

## 配置

| 参数 | 说明 |
| --- | --- |
| `PORT` | 宿主机对外端口，默认 `8080` |
| `CLUSTER_SERVICE_API_KEY` | 调用方访问 Cluster 的鉴权 Token |
| `SERVER_API_KEY_ENCRYPTION_KEY` | 32 字节密钥，用于加密 Server API Key |
| `PROXY_CONNECT_TIMEOUT_MS` | 连接 OpenSandbox Server 的超时 |
| `PROXY_RESPONSE_TIMEOUT_MS` | 代理请求响应超时 |

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
docker run --rm \
  -v opensandbox-cluster_opensandbox-cluster-data:/data \
  -v "$PWD:/backup" \
  alpine cp /data/opensandbox-cluster.db /backup/opensandbox-cluster.db
docker compose start
```

不要在 Cluster 运行时直接复制正在写入的 SQLite 文件。

## FRP tunnel 配置

默认 Compose 同时启动 Cluster 和单实例 `frps`。宿主机只发布：

- Cluster 管理 API：`8080`；
- FRP 登录端口：`7000`，可通过 `FRP_BIND_PORT` 修改。

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

然后将配置挂载到 Server 的 `/etc/frp/frpc.toml`，使用 `docker-compose.tunnel.yml` 重启或启动 Server，等待 FRP 连接恢复。

Cluster 管理 API 支持 HTTP 或 HTTPS，FRP 数据链路固定启用 TLS。
