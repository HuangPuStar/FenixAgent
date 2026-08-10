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

节点启动并确认健康后，再将节点的可访问地址注册到 Cluster。Cluster 只通过 HTTP 连接这些节点，不挂载节点的 Docker Socket。

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
    "workspace_root":"/workspace/sandboxes",
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
