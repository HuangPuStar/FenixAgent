# OpenSandbox Server 节点

本目录只提供一种部署方式：单镜像、单容器 DinD。镜像内复用了官方 `docker:dind` 的 Docker daemon 初始化逻辑。

## 启动

```bash
cp .env.example .env
cp sandbox.toml.example sandbox.toml
# 手动编辑 sandbox.toml：
# 1. server.api_key：节点 API Key，注册到 Cluster 时使用相同值；
# 2. docker.host_ip：Cluster 和调用方可以访问的本机 IP。
mkdir -p data workspace/sandboxes offline

docker compose -f docker-compose.dind.yml up -d --build

# 等待服务进入 healthy；DinD 首次启动通常需要十几秒
docker compose -f docker-compose.dind.yml ps

# 查看是否启动成功
curl -fsS "http://127.0.0.1:${OPENSANDBOX_SERVER_PORT:-8090}/health"
```

DinD 使用 `privileged` 和 `cgroup: host`，并通过 `docker-data` 持久化内部 Docker 镜像、容器和 volume。不要挂载宿主机 `/var/run/docker.sock`；该部署使用容器内独立的 Docker daemon。沙盒端口范围必须与 `.env` 和 `sandbox.toml` 保持一致。

如服务器不支持 `privileged` 和 `cgroup: host`，请走物理机部署原生 OpenSandbox Server（参考官方文档）。

## Workspace 配置

Workspace 配置用于存放沙盒运行的 Workspace 数据，一般为 `/workspace/sandboxes`，如需要修改，调整下面几个地方：

1、`docker-compose.dind.yml` 中挂载的路径：

```yaml
- ./workspace/sandboxes:/workspace/sandboxes
```

2、`sandbox.toml`：

```toml
[storage]
allowed_host_paths = ["/workspace/sandboxes"]
```

3、Cluster 注册该节点时的参数：

```json
{
  "workspace_root": "/workspace/sandboxes"
}
```


之后调用方在创建沙盒的时候，如果需要配置 mount 只需要传相对路径即可：

```json
{
  "volumes": [
    {
      "name": "workspace",
      "host": { "path": "ws" },
      "mountPath": "/workspace"
    },
    {
      "name": "config",
      "host": { "path": "/config" },
      "mountPath": "/app/config"
    }
  ]
}
```

Cluster 根据业务 `sandbox_id` 改写为：

```text
/workspace/sandboxes/{sandbox_id}/ws
/workspace/sandboxes/{sandbox_id}/config
```

`../` 等路径穿越会被拒绝。

## 离线镜像导入

`opensandbox/execd` 已在构建镜像时通过 skopeo 预打包进 `/opt/opensandbox/seed-images/`，Server 启动时会自动 `docker load` 进容器内 DinD。剩余需要离线导入的是业务沙盒镜像。

DinD 使用的是 Server 容器内部的 Docker daemon。宿主机执行 `docker load` 不会把镜像导入 DinD，因此需要把镜像包挂载到 `/offline` 后，在容器内执行：

```bash
cp opensandbox-images.tar offline/
docker compose -f docker-compose.dind.yml up -d
docker compose -f docker-compose.dind.yml exec opensandbox-server \
  docker load -i /offline/opensandbox-images.tar
```

业务镜像包只需包含：

```text
业务沙盒镜像
```

镜像名称和 tag 必须与创建请求和 `sandbox.toml` 中的配置完全一致。

不要将宿主机 `/var/run/docker.sock` 挂载进该容器。若要使用宿主机 Docker，应使用单独的 host-socket 部署方案，不能与本 DinD 入口混用。

## 注册到 Cluster

确认健康后，由管理员调用：

```bash
# 创建节点所属资源池（如无）
curl -X POST "$CLUSTER_URL/api/v1/pools" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"id":"pool-default","name":"Default"}'

# 注册到指定资源池
curl -X POST "$CLUSTER_URL/api/v1/servers" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"id":"server-node-1","pool_id":"pool-default","name":"Node 1","base_url":"http://node-1:8090","workspace_root":"/workspace/sandboxes","api_key":"change-me","max_sandboxes":10}'

# 校验是否能通过 Cluster 访问
curl -X POST "$CLUSTER_URL/api/v1/servers/server-node-1/health-check" \
  -H "Authorization: Bearer $CLUSTER_SERVICE_API_KEY"
```
