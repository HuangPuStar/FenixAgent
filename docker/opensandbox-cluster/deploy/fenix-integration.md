# FenixAgent 离线部署与运维手册

本文供运维人员在一台 Linux 服务器上离线部署一套完整环境：FenixAgent、OpenSandbox Cluster 和 OpenSandbox Server。

## 1. 部署拓扑

```text
用户 / 浏览器
      |
      v
FenixAgent :3000
      |
      | RCS_SANDBOX_CLUSTER_URL
      v
OpenSandbox Cluster :8080
      |
      | Server API Key
      v
OpenSandbox Server :8090
      |
      v
DinD Docker + 沙盒容器
```

Cluster 负责资源池、Server 注册、容量分配和请求代理；Server 负责实际创建和运行沙盒容器。

## 2. 部署前准备

准备一台 Linux 服务器，并确认具备以下条件：

- 已安装 Docker Engine 和 Docker Compose v2；
- 支持特权容器和 host cgroup；
- 为 DinD 数据卷和 `/workspace/sandboxes` 预留足够磁盘空间；
- 放通 `3000`、`8080`、`8090` 以及 `sandbox.toml` 中配置的沙盒端口范围；
- 准备一个 Fenix、Cluster、Server 和沙盒容器都能访问的主机或局域网地址。

跨容器通信不要使用 `localhost` 或 `127.0.0.1`，应使用宿主机局域网 IP 或可解析的服务地址。

## 3. 准备离线镜像包

在有网络的构建机上构建或准备以下镜像：

```bash
docker build -t aos/fenixagent:offline .
docker build -f docker/opensandbox-cluster/Dockerfile \
  -t aos/opensandbox-cluster:offline .
docker build -f docker/opensandbox-server/Dockerfile \
  -t aos/opensandbox-server:offline docker/opensandbox-server
```

业务沙盒镜像必须包含 ACP Runtime CLI 和正确的业务入口。例如：

```text
aos/fenixagent-sandbox-opencode:local-acp-sandbox
```

将基础设施镜像和业务沙盒镜像分别保存，避免把基础设施镜像导入 Server 内部的 DinD Docker：

```bash
mkdir -p offline
docker save \
  aos/fenixagent:offline \
  aos/opensandbox-cluster:offline \
  aos/opensandbox-server:offline \
  -o offline/fenix-opensandbox-images.tar

docker save \
  aos/fenixagent-sandbox-opencode:local-acp-sandbox \
  -o offline/business-sandbox-images.tar
```

这里会生成两个离线镜像包：

- `offline/fenix-opensandbox-images.tar`：只包含 Fenix、Cluster、OpenSandbox Server 等基础设施镜像，导入离线服务器宿主机 Docker；
- `offline/business-sandbox-images.tar`：只包含业务沙盒镜像，导入 OpenSandbox Server 内部的 DinD Docker。

请将整个 `offline/` 目录复制到离线服务器的部署根目录，例如：

```text
/opt/fenix-deploy/
├── offline/
│   ├── fenix-opensandbox-images.tar
│   └── business-sandbox-images.tar
├── docker/
│   ├── opensandbox-cluster/
│   └── opensandbox-server/
└── docker-compose.yml
```

如果离线服务器上还没有这个目录，先创建并复制文件：

```bash
mkdir -p offline
# 将联网构建机生成的两个 tar 包复制到当前目录的 offline/ 下
```

将以下内容复制到离线服务器：

- FenixAgent 部署文件和 Fenix 镜像；
- `docker/opensandbox-cluster/`；
- `docker/opensandbox-server/`；
- `fenix-sandbox-ops.sh`（或直接使用 Fenix 镜像中的 `/app/fenix-sandbox-ops.sh`）；
- `offline/fenix-opensandbox-images.tar`。
- `offline/business-sandbox-images.tar`。

在离线服务器宿主机导入基础设施镜像：

```bash
docker load -i offline/fenix-opensandbox-images.tar
docker image ls | grep -E 'fenixagent|opensandbox'
```

OpenSandbox Server 镜像内置独立 DinD Docker daemon。业务沙盒镜像不需要和基础设施镜像一起导入宿主机，也不能把宿主机 `/var/run/docker.sock` 挂载给 Server。Server 启动后，将 `business-sandbox-images.tar` 挂载到 `/offline`，再导入 Server 容器内的 DinD Docker。

## 4. 部署 OpenSandbox Server

```bash
cd docker/opensandbox-server
cp .env.example .env
cp sandbox.toml.example sandbox.toml
mkdir -p workspace/sandboxes offline
```

编辑 `.env`：

```dotenv
OPENSANDBOX_SERVER_IMAGE=aos/opensandbox-server:offline
OPENSANDBOX_SERVER_PORT=8090
SANDBOX_PORT_MIN=10000
SANDBOX_PORT_MAX=10100
```

编辑 `sandbox.toml`，替换下面的示例值：

```toml
[server]
host = "0.0.0.0"
port = 8080
api_key = "替换为随机生成的 Server API Key"

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.18"

[docker]
network_mode = "bridge"
host_ip = "192.168.1.20"
port_range_min = 10000
port_range_max = 10100

[storage]
allowed_host_paths = ["/workspace/sandboxes"]
```

关键配置说明：

- `server.api_key`：Cluster 代理请求 Server 时使用的密钥；
- `docker.host_ip`：沙盒端口暴露和回连地址使用的宿主机 IP；
- `runtime.execd_image`：OpenSandbox 注入沙盒的执行代理镜像，不是业务沙盒镜像；
- `storage.allowed_host_paths`：必须与 `docker-compose.dind.yml` 暴露的工作空间路径一致。

启动并检查 Server：

```bash
docker compose -f docker-compose.dind.yml up -d
curl -fsS http://127.0.0.1:8090/health \
  -H 'OPEN-SANDBOX-API-KEY: 替换为 Server API Key'
docker compose -f docker-compose.dind.yml exec opensandbox-server docker info
```

将业务沙盒镜像导入 Server 内部的 DinD Docker：

```bash
cp ../../offline/business-sandbox-images.tar offline/
docker compose -f docker-compose.dind.yml exec opensandbox-server \
  docker load -i /offline/business-sandbox-images.tar
docker compose -f docker-compose.dind.yml exec opensandbox-server \
  docker image inspect aos/fenixagent-sandbox-opencode:local-acp-sandbox
```

## 5. 部署 OpenSandbox Cluster

```bash
cd ../opensandbox-cluster
cp .env.example .env
```

编辑 `.env`，至少设置以下参数：

```dotenv
PORT=8080
DATABASE_PATH=/data/opensandbox-cluster.db
CLUSTER_SERVICE_API_KEY=替换为随机生成的 Cluster API Key
SERVER_API_KEY_ENCRYPTION_KEY=01234567890123456789012345678901
PROXY_CONNECT_TIMEOUT_MS=3000
PROXY_RESPONSE_TIMEOUT_MS=120000
```

离线镜像部署时，将 `OPENSANDBOX_CLUSTER_IMAGE` 设置为已导入的镜像：

```dotenv
OPENSANDBOX_CLUSTER_IMAGE=aos/opensandbox-cluster:offline
```

启动并检查 Cluster：

```bash
docker compose up -d
curl -fsS http://127.0.0.1:8080/health
```

使用运维脚本创建默认资源池并注册 Server。脚本会在注册 Server 后自动执行健康检查。

如果在 Fenix 镜像容器内运行 `/app/fenix-sandbox-ops.sh`，脚本会直接读取容器已有的 `RCS_SANDBOX_CLUSTER_URL` 和 `RCS_SANDBOX_CLUSTER_API_KEY`，无需再次设置。以下环境变量仅适用于在宿主机或其他独立环境中运行脚本的场景：

```bash
# 独立环境中没有这2个环境变量，需要手动设置
# export RCS_SANDBOX_CLUSTER_URL=http://127.0.0.1:8080
# export RCS_SANDBOX_CLUSTER_API_KEY='替换为 Cluster API Key'

export SERVER_API_KEY='替换为 Server API Key'

./fenix-sandbox-ops.sh cluster pool create \
  '{"id":"default","name":"default"}'

./fenix-sandbox-ops.sh cluster server create \
  "{\"id\":\"server-1\",\"pool_id\":\"default\",\"name\":\"server-1\",\"base_url\":\"http://192.168.1.20:8090\",\"workspace_root\":\"/workspace/sandboxes\",\"api_key\":\"$SERVER_API_KEY\",\"max_sandboxes\":10}"
```

Cluster 和 Server 使用独立的 Compose 项目时，`base_url` 必须填写宿主机局域网 IP 或其他可达地址，不能填写 `127.0.0.1`。

## 6. 配置并启动 FenixAgent

在 Fenix 的 `.env` 中配置 Cluster 和默认沙盒策略：

```dotenv
RCS_SYSTEM_API_KEYS=Fenix 系统 API Key
REGISTRY_SECRET=沙盒注册使用的的key

RCS_SANDBOX_ENABLED=true
RCS_SANDBOX_CLUSTER_URL=http://192.168.1.20:8080
RCS_SANDBOX_CLUSTER_API_KEY=替换为 Cluster API Key
RCS_DEFAULT_SANDBOX_POOL_ID=default
RCS_DEFAULT_SANDBOX_IMAGE=替换为业务沙盒镜像
RCS_DEFAULT_SANDBOX_RESOURCES_JSON={"cpu":2,"memoryMb":512,"diskGb":5,"gpuCount":0,"environment":{"RCS_URL":"ws://替换为AOS地址","RCS_SECRET":"替换为 REGISTRY_SECRET"},"volumes":[{"name":"workspace","source":"workspace","target":"/app/workspaces"},{"name":"rcs-opencode-config","source":"rcs-opencode-config","target":"/root/.config/opencode"},{"name":"rcs-opencode-data","source":"rcs-opencode-data","target":"/root/.local/share/opencode"}]}
RCS_DEFAULT_SANDBOX_EXTRA_JSON={"opensandbox-cluster":{"entrypoint":["docker-entrypoint.sh","acp-runtime","opencode","acp"]}}
RCS_SANDBOX_RUNTIME_CONNECT_TIMEOUT_MS=10000
```

上面三个参数共同定义新建沙盒的默认配置：

- `RCS_DEFAULT_SANDBOX_IMAGE`：指定实际运行 Agent 的业务沙盒镜像。镜像必须已经导入 OpenSandbox Server 所在 Docker，名称必须与导入时完全一致；它不是 OpenSandbox Server 镜像，也不是 `opensandbox/execd` 镜像。
- `RCS_DEFAULT_SANDBOX_RESOURCES_JSON`：指定该镜像运行时的 CPU、内存、磁盘、GPU、环境变量和挂载。`environment.RCS_URL` 填写沙盒能够访问到的 Fenix 地址，不能填写沙盒容器内的 `localhost`；`environment.RCS_SECRET` 必须与 Fenix 的 `REGISTRY_SECRET` 一致。`volumes` 中的 `workspace` 保存用户工作区，另外两个 volume 保存 OpenCode 配置和会话数据。
- `RCS_DEFAULT_SANDBOX_EXTRA_JSON`：指定 OpenSandbox Cluster 的 Provider 专属参数。当前示例通过 `entrypoint` 启动 ACP Runtime 和 OpenCode；它必须与 `RCS_DEFAULT_SANDBOX_IMAGE` 内实际存在的启动命令匹配。

这三个参数会一起保存到新建 `sandbox_instance` 的配置快照中：`IMAGE` 决定运行哪个镜像，`RESOURCES_JSON` 决定运行资源及挂载，`EXTRA_JSON` 决定 Provider 如何启动该镜像。通常更换业务镜像时，至少需要同步检查这三个参数。

以上示例针对 `aos/fenixagent-sandbox-opencode` 类型的 OpenCode 镜像。使用其他 Agent 镜像时，需要根据镜像的启动方式调整 `RCS_DEFAULT_SANDBOX_IMAGE`、资源中的环境变量和挂载，以及 `RCS_DEFAULT_SANDBOX_EXTRA_JSON` 中的 `entrypoint`；不能直接照搬 OpenCode 示例。

其中 `volumes.source` 使用逻辑路径名，不要改成宿主机绝对路径；Cluster 会根据 Server 注册的 `workspace_root` 映射实际目录。

修改默认值只影响之后新建的 `sandbox_instance`，已有实例仍使用自己的配置快照。

`RCS_DEFAULT_SANDBOX_POOL_ID=default` 是 Fenix 使用的默认资源池 ID。Fenix 启动时会创建或更新本地 `sandbox_pool` 配置；已有 `sandbox_instance` 的配置快照不会因默认值变化而被覆盖。

如果 Fenix 运行在 Docker 中，`RCS_SANDBOX_CLUSTER_URL` 必须填写 Fenix 容器可以访问的地址。不要在 Fenix 容器中使用 `http://127.0.0.1:8080`。

启动并检查 Fenix：

```bash
docker compose up -d
curl -fsS http://127.0.0.1:3000/health
```

## 7. 日常运维操作

在 Fenix 镜像容器中运行 `/app/fenix-sandbox-ops.sh` 时，Cluster 和 Fenix 相关配置会直接复用容器已有的环境变量，无需额外设置。只有在宿主机或其他独立环境运行脚本时，才需要通过项目根目录 `.env` 或 shell 环境变量提供这些配置；shell 环境变量优先于 `.env`：

```bash
# 独立环境中没有以下4个环境变量时，需要手动设置；Fenix 镜像容器内无需重复设置
# export RCS_SANDBOX_CLUSTER_URL=http://127.0.0.1:8080
# export RCS_SANDBOX_CLUSTER_API_KEY='Cluster API Key'
# export RCS_BASE_URL=http://127.0.0.1:3000
# export RCS_SYSTEM_API_KEYS='Fenix 系统 API Key'

export POOL_ID='资源池 ID'
export SERVER_ID='Server ID'
export SERVER_UPDATE_FILE='./server-update.json'
export SANDBOX_INSTANCE_ID='sandbox_instance ID'
export USER_ID='用户 ID'
```

### 7.1 健康检查

```bash
# 检查 Cluster 服务是否健康
./fenix-sandbox-ops.sh health cluster
# 检查 Fenix 服务是否健康
./fenix-sandbox-ops.sh health fenix
# 主动检查指定 OpenSandbox Server，并同步其健康状态
./fenix-sandbox-ops.sh cluster server health-check "${SERVER_ID}"
```

### 7.2 Cluster 资源池

```bash
# 查询全部资源池
./fenix-sandbox-ops.sh cluster pool list
# 查询指定资源池详情
./fenix-sandbox-ops.sh cluster pool get "${POOL_ID}"
# 修改指定资源池的名称或状态
./fenix-sandbox-ops.sh cluster pool update "${POOL_ID}" "{\"name\":\"${POOL_ID}\",\"status\":\"active\"}"
# 删除指定资源池；--yes 表示跳过交互确认
./fenix-sandbox-ops.sh cluster pool delete "${POOL_ID}" --yes
```

资源池存在 Fenix 沙盒实例记录时，Cluster 会拒绝删除资源池。

### 7.3 Cluster Server

```bash
# 查询全部 OpenSandbox Server
./fenix-sandbox-ops.sh cluster server list
# 查询指定资源池下的 Server
./fenix-sandbox-ops.sh cluster server list "${POOL_ID}"
# 查询指定 Server 详情
./fenix-sandbox-ops.sh cluster server get "${SERVER_ID}"
# 使用 JSON 文件更新 Server 配置
./fenix-sandbox-ops.sh cluster server update "${SERVER_ID}" @"${SERVER_UPDATE_FILE}"
# 检查 Server 的 OpenSandbox Server 接口是否可访问，并同步健康状态
./fenix-sandbox-ops.sh cluster server health-check "${SERVER_ID}"
# 删除指定 Server；--yes 表示跳过交互确认
./fenix-sandbox-ops.sh cluster server delete "${SERVER_ID}" --yes
```

`server-update.json` 示例：

```json
{
  "name": "${SERVER_ID}",
  "base_url": "http://192.168.1.20:8090",
  "workspace_root": "/workspace/sandboxes",
  "max_sandboxes": 10
}
```

删除 Server 前应先停止新的沙盒分配，并确认没有活跃沙盒依赖该 Server。脚本对删除操作默认要求二次确认。

### 7.4 Fenix 沙盒实例

```bash
# 查询全部 Sandbox Instance
./fenix-sandbox-ops.sh fenix sandbox list
# 按资源池和状态筛选 Sandbox Instance
./fenix-sandbox-ops.sh fenix sandbox list "sandbox_pool_id=${POOL_ID}&status=ready"
# 查询指定 Sandbox Instance 详情
./fenix-sandbox-ops.sh fenix sandbox get "${SANDBOX_INSTANCE_ID}"
# 预览指定资源池中需要重建的 Instance，不执行删除和重建
./fenix-sandbox-ops.sh fenix sandbox rebuild-all "${POOL_ID}" --dry-run
# 重建指定资源池中配置已变化的全部 Instance
./fenix-sandbox-ops.sh fenix sandbox rebuild-all "${POOL_ID}" --yes
# 重建指定 Sandbox Instance
./fenix-sandbox-ops.sh fenix sandbox rebuild-instance "${POOL_ID}" "${SANDBOX_INSTANCE_ID}" --yes
# 重建指定用户在资源池中的 Sandbox Instance
./fenix-sandbox-ops.sh fenix sandbox rebuild-user "${POOL_ID}" "${USER_ID}" --yes
# 删除指定 Sandbox Instance 及其关联的 Provider 沙盒
./fenix-sandbox-ops.sh fenix sandbox delete "${SANDBOX_INSTANCE_ID}" --yes
```

修改资源池或单个 Instance 的沙盒配置时，变更只会写入数据库配置，不会直接修改正在运行的 Provider 沙盒，也不会自动重启它。要让配置对已有实例生效，需要执行 `rebuild`。在用户下次进入 Agent 时，按新配置创建或启动沙盒。

`rebuild` 用于让已有 Instance 按新配置重建沙盒，适用于资源池默认配置或 Instance 配置发生变化的情况。`--dry-run` 只查询配置发生变化的 Instance，不执行重建。

`delete` 用于删除目标沙盒配置，下次用户进入 Agent 时按默认配置重建沙盒，日常较少使用。`rebuild` 和 `delete` 都不会清理工作空间、OpenCode 配置或会话数据。

脚本会输出接口响应体和 HTTP 状态码；接口返回非 2xx 时脚本以失败状态退出，可用于部署检查或自动化运维。

## 8. 部署后人工检查

部署完成后，至少检查以下内容：

1. Cluster 和 Fenix 的健康检查接口正常；
2. `cluster server health-check "${SERVER_ID}"` 返回健康；
3. `cluster server list "${POOL_ID}"` 能看到注册的 Server；
4. Fenix 的 `sandbox list` 能看到默认资源池配置，没有异常的历史实例；
5. 进入 Agent 后能为用户和资源池创建一个沙盒实例；
6. 沙盒容器能够回连 Fenix，Agent 可以执行 ACP 请求；

## 9. 常见问题

### Cluster 无法访问 Server

检查已注册的 `base_url`，并从 Cluster 容器内访问 Server：

```bash
docker compose exec opensandbox-cluster wget -qO- http://192.168.1.20:8090/
```

如果接口需要认证，同时携带 Server API Key。Cluster 和 Server 不共享网络命名空间时，不要注册 `127.0.0.1`。

### Server 无法创建沙盒镜像

通常是镜像只导入了宿主机 Docker，没有导入 Server 的 DinD Docker。通过 `docker compose exec opensandbox-server` 执行 `docker load`，再在同一个容器内执行 `docker image inspect`。

### 沙盒无法回连 Fenix

检查 `RCS_URL` 是否使用沙盒容器可以访问的宿主机或局域网地址，并确认 `RCS_SECRET` 与 Fenix 的注册密钥一致。沙盒内的 `ws://127.0.0.1:3000` 指向的是沙盒自身。

### 宿主机看不到工作空间目录

确认 `docker-compose.dind.yml` 暴露了 `/workspace/sandboxes`，并确认请求中的 volume source 已被改写到配置的工作空间根目录。DinD 模式下还要检查 Server 内部的 Docker 数据卷，不能只检查宿主机 Docker。
