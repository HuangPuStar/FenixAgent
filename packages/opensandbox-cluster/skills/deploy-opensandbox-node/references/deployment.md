# 部署与注册

以下命令在目标机器的独立部署目录执行。将 `sandbox.toml.example` 中的占位值替换后再启动；模板目录来自本 Skill 的 `assets/`。

## direct

```sh
docker compose -f compose.yaml -f direct.yaml config --quiet
docker compose -f compose.yaml -f direct.yaml up -d
docker compose -f compose.yaml -f direct.yaml ps
curl --fail-with-body http://127.0.0.1:8090/health
```

发布节点管理端口 `8090` 与沙盒端口段 `10000–10100`。Cluster 的 `base_url` 填 `http://<节点可达地址>:8090`。沙盒请求可全部通过 Cluster 代理；不要把仅在自己机器可达的地址交给远端调用方。

## tunnel

先在 Cluster 注册节点，再下载配置：

```sh
curl --fail-with-body --silent --show-error \
  "$CLUSTER_URL/api/v1/servers/$SERVER_ID/tunnel/frpc.toml" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" -o frpc.toml
chmod 600 frpc.toml
docker compose -f compose.yaml -f tunnel.yaml config --quiet
docker compose -f compose.yaml -f tunnel.yaml up -d
docker compose -f compose.yaml -f tunnel.yaml ps
docker compose -f compose.yaml -f tunnel.yaml exec -T opensandbox-server \
  curl --fail-with-body http://127.0.0.1:8080/health
```

不发布入站端口。节点内 frpc 连接 Cluster 配置的 `FRP_PUBLIC_ADDRESS:FRP_BIND_PORT`（通常为 `7000`）；frps 在 Cluster 一侧。不要在目标节点额外启动 frps。

两种模式都用与启动相同的 `-f` 参数执行 `logs --tail=100 opensandbox-server` 或 `stop`。`down -v` 不作为普通停止命令，持久化数据目录需保留。

## 注册 JSON

请求：`POST {CLUSTER_URL}/api/v1/servers`，Bearer 认证及 `Content-Type: application/json`。

资源池的 direct 示例：

```json
{
  "id": "node-1",
  "pool_id": "resource-pool",
  "name": "Node 1",
  "transport_mode": "direct",
  "base_url": "http://node.example.com:8090",
  "workspace_root": "/workspace",
  "api_key": "<NODE_API_KEY>",
  "cpu_capacity": 8,
  "memory_capacity_mb": 16384,
  "disk_capacity_gb": 100,
  "gpu_capacity": 1
}
```

- 数量池：用 `max_sandboxes` 替换四个 `*_capacity*` 字段。
- tunnel：设置 `transport_mode` 为 `tunnel`，省略 `base_url`，其余按池模式填写。
- 示例容量不是推荐值，必须使用目标机器确认后的可分配预算。不要虚报 GPU 数量。
- 维护节点可 `PUT /api/v1/servers/{serverId}` 设置 `status=draining`，已有绑定仍可访问；`disabled` 会拒绝代理。

## 数据、镜像和 GPU

- 容器内 Docker 镜像和沙盒状态存放于 `data/docker`；Server 状态在 `data/opensandbox`；工作数据在 `workspace`。
- 镜像在 DinD 内拉取。离线包放进 `offline/` 后，使用相同 Compose 参数执行 `exec -T opensandbox-server docker load -i /offline/<镜像包>.tar`。宿主机 `docker load` 不会导入 DinD。
- Cluster 将申请的挂载相对路径拼接到 `/workspace`，不会自动添加业务 ID。需要隔离目录时，调用方显式提供 `用户或任务前缀/子目录`。
- GPU 节点需按目标机器配置宿主机驱动、容器设备映射及 DinD 内的 GPU runtime；本模板未配置 GPU 透传。登记 GPU 容量前，用 `nvidia-smi` 和一次获准的 GPU 沙盒验证可用性；Cluster 按 GPU 数量调度。

项目部署文档：

- direct：https://github.com/HuangPuStar/FenixAgent/tree/main/docker/opensandbox-server
- tunnel：https://github.com/HuangPuStar/FenixAgent/tree/main/docker/opensandbox-server-tunnel
