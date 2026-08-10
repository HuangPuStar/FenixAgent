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
      | 宿主机地址：http://<宿主机局域网 IP>:8090
      v
OpenSandbox Server 容器 :8080
      |
      | 宿主机映射 :8090
      v
    DinD Docker + 沙盒容器
```

Cluster 负责资源池、Server 注册、容量分配和请求代理；Server 负责实际创建和运行沙盒容器。

## 2. 部署前准备

准备一台 Linux 服务器，并确认具备以下条件：

- 已安装 Docker Engine 和 Docker Compose v2；
- 支持特权容器和 host cgroup；
- 为 DinD 数据卷和 `/workspace` 预留足够磁盘空间；
- 放通 `3000`、`8080`、`8090` 以及 `sandbox.toml` 中配置的沙盒端口范围；
- 准备一个 Fenix、Cluster、Server 和沙盒容器都能访问的主机或局域网地址。

跨容器通信不要使用 `localhost` 或 `127.0.0.1`，应使用宿主机局域网 IP 或可解析的服务地址。

## 3. 准备离线镜像包

下载并打包离线镜像包：

```bash
CLUSTER_IMAGE=ghcr.io/huangpustar/fenixagent-opensandbox-cluster:v0.1.0
SERVER_IMAGE=ghcr.io/huangpustar/fenixagent-opensandbox-server:v0.1.0
BUSINESS_IMAGE=ghcr.io/huangpustar/fenixagent-sandbox-peri:v0.4.0-beta.1-peri
# 如果用 OpenCode 的业务沙盒镜像使用下面这个
# BUSINESS_IMAGE=ghcr.io/huangpustar/fenixagent-sandbox-opencode:v0.4.0-beta.1-opencode

docker pull "${CLUSTER_IMAGE}"
docker pull "${SERVER_IMAGE}"
docker pull "${BUSINESS_IMAGE}"

mkdir -p offline

docker save \
  "${CLUSTER_IMAGE}" \
  "${SERVER_IMAGE}" \
  -o offline/opensandbox-images.tar

docker save \
  "${BUSINESS_IMAGE}" \
  -o offline/business-sandbox-images.tar
```

这里会生成两个离线镜像包：

- `offline/opensandbox-images.tar`：包含 OpenSandbox Cluster 和 OpenSandbox Server 镜像，导入离线服务器宿主机 Docker；
- `offline/business-sandbox-images.tar`：只包含业务沙盒镜像，导入 OpenSandbox Server 内部的 DinD Docker。

把离线镜像包上传到离线服务器，部署根目录样例：

```text
/fenix/
├── opensandbox-images.tar
├── .env
├── docker-compose.yml
├── sandbox.toml
└── offline/
    └── business-sandbox-images.tar
```

在离线服务器宿主机导入基础设施镜像：

```bash
docker load -i /opt/fenix-deploy/opensandbox-images.tar
```

## 4. 部署 OpenSandbox Cluster 和 Server

docker-compose.yml 使用目录中的即可。

生成`.env`，样例：

```dotenv
########## cluster

# 对外端口
OPENSANDBOX_CLUSTER_PORT=8080

# Cluster 管理接口和代理接口使用的 Bearer Token。
CLUSTER_SERVICE_API_KEY="替换为随机 Cluster API Key"

# 必须为正好 32 个 UTF-8 字节，用于加密 Server API Key。
SERVER_API_KEY_ENCRYPTION_KEY="替换为随机加密 Server API Key"

# Cluster 访问 OpenSandbox Server 的 HTTP 超时。
PROXY_CONNECT_TIMEOUT_MS=3000
PROXY_RESPONSE_TIMEOUT_MS=120000

########### server

# 对外端口
OPENSANDBOX_SERVER_PORT=8090

# 必须与 sandbox.toml 中的端口范围一致。
SANDBOX_PORT_MIN=10000
SANDBOX_PORT_MAX=10100
```

这里的端口必须保持一致：`SANDBOX_PORT_MIN/MAX` 要与 `sandbox.toml` 中的 `docker.port_range_min/max` 一致。

编辑 `sandbox.toml`：

```toml
[server]
host = "0.0.0.0"
port = 8080
api_key = "替换为随机 Server API Key"

[runtime]
type = "docker"
execd_image = "opensandbox/execd:v1.0.18"

[docker]
network_mode = "bridge"
host_ip = "替换为宿主机局域网 IP"
port_range_min = 10000
port_range_max = 10100

[storage]
allowed_host_paths = ["/workspace"]
```

关键配置说明：

- `server.api_key`：Cluster 代理请求 Server 时使用的密钥；
- `docker.host_ip`：沙盒端口暴露和回连地址使用的宿主机局域网 IP，不能填写 `127.0.0.1`；

启动 Cluster 和 Server：

```bash
docker compose up -d
docker compose ps
curl -fsS http://127.0.0.1:8080/health
curl -fsS http://127.0.0.1:8090/health \
  -H 'OPEN-SANDBOX-API-KEY: 替换为 Server API Key'
docker compose exec opensandbox-server docker info
```

将业务沙盒镜像导入 Server 内部的 DinD Docker：

```bash
docker compose exec opensandbox-server \
  docker load -i /offline/business-sandbox-images.tar

# 查看业务沙盒镜像是否导入成功
docker compose exec opensandbox-server \
  docker images
```

使用运维脚本创建默认资源池并注册 Server 进去 Cluster。

如果在 Fenix 镜像容器内运行 `/app/fenix-sandbox-ops.sh`，脚本会直接读取容器已有的 `RCS_SANDBOX_CLUSTER_URL` 和 `RCS_SANDBOX_CLUSTER_API_KEY`，无需再次设置。以下环境变量仅适用于在宿主机或其他独立环境中运行脚本的场景：

```bash
# 独立环境中没有这2个环境变量，需要手动设置
# export RCS_SANDBOX_CLUSTER_URL=http://127.0.0.1:8080
# export RCS_SANDBOX_CLUSTER_API_KEY='替换为 Cluster API Key'

export SERVER_UEL="http://<宿主机局域网 IP>:8090"
export SERVER_API_KEY='替换为 Server API Key'

./fenix-sandbox-ops.sh cluster pool create \
  '{"id":"default","name":"default"}'

./fenix-sandbox-ops.sh cluster server create \
  "{\"id\":\"server-1\",\"pool_id\":\"default\",\"name\":\"server-1\",\"base_url\":\"$SERVER_UEL\",\"workspace_root\":\"/workspace\",\"api_key\":\"$SERVER_API_KEY\",\"max_sandboxes\":200}"
```

注册 Server 时使用宿主机局域网 IP 和映射端口 `http://<宿主机局域网 IP>:8090`。

## 5. 配置并启动 FenixAgent

在 Fenix 的 `.env` 中配置 Cluster 和默认沙盒策略。以下默认使用 Peri；如果使用 OpenCode，请使用后面的 OpenCode 配置。两套配置不能混用。

注意：其中的cpu、memoryMb、diskGb为单个沙盒（一个用户）的使用上限，请按需配置。

### 5.1 Peri（默认）

```dotenv
RCS_SYSTEM_API_KEYS=Fenix 系统 API Key
REGISTRY_SECRET=沙盒注册使用的的key

RCS_SANDBOX_ENABLED=true
RCS_SANDBOX_CLUSTER_URL=http://<宿主机局域网 IP>:8080
RCS_SANDBOX_CLUSTER_API_KEY=替换为 Cluster API Key
RCS_DEFAULT_SANDBOX_POOL_ID=default
RCS_DEFAULT_SANDBOX_IMAGE=ghcr.io/huangpustar/fenixagent-sandbox-peri:v0.4.0-beta.1-peri
RCS_DEFAULT_SANDBOX_AGENT_TYPE=ccb
RCS_DEFAULT_SANDBOX_RESOURCES_JSON='{
  "cpu": 2,
  "memoryMb": 512,
  "diskGb": 5,
  "gpuCount": 0,
  "environment": {
    "TZ": "Asia/Shanghai",
    "RCS_URL": "ws://替换为AOS地址",
    "RCS_SECRET": "替换为 REGISTRY_SECRET",
    "IS_PERI": "1",
    "RCS_CCB_COMMAND": "peri",
    "RCS_CCB_ARGS": "acp"
  },
  "volumes": [
    {
      "name": "workspace",
      "source": "workspace",
      "target": "/app/workspaces"
    },
    {
      "name": "peri-global",
      "source": "peri-global",
      "target": "/root/.peri"
    }
  ]
}'
RCS_DEFAULT_SANDBOX_EXTRA_JSON='{
  "opensandbox-cluster": {
    "entrypoint": [
      "bun",
      "/usr/local/bin/acp-runtime.js",
      "peri",
      "acp"
    ]
  }
}'
```

Peri 配置需要将 `RCS_CCB_COMMAND` 设置为 `peri`、`RCS_CCB_ARGS` 设置为 `acp`，并通过 `IS_PERI=1` 启用 Peri 配置生成。这里的 `entrypoint` 使用镜像中的 Bun 直接启动 `/usr/local/bin/acp-runtime.js peri acp`；`workspace` 保存工作区，`peri-global` 保存 Peri 的全局目录。

### 5.2 OpenCode

如果业务沙盒选择 OpenCode，改用下面四项配置：

```dotenv
RCS_DEFAULT_SANDBOX_IMAGE=ghcr.io/huangpustar/fenixagent-sandbox-opencode:v0.4.0-beta.1-opencode
RCS_DEFAULT_SANDBOX_AGENT_TYPE=opencode
RCS_DEFAULT_SANDBOX_RESOURCES_JSON='{
  "cpu": 2,
  "memoryMb": 512,
  "diskGb": 5,
  "gpuCount": 0,
  "environment": {
    "TZ": "Asia/Shanghai",
    "RCS_URL": "ws://替换为AOS地址",
    "RCS_SECRET": "替换为 REGISTRY_SECRET"
  },
  "volumes": [
    {
      "name": "workspace",
      "source": "workspace",
      "target": "/app/workspaces"
    },
    {
      "name": "rcs-opencode-config",
      "source": "rcs-opencode-config",
      "target": "/root/.config/opencode"
    },
    {
      "name": "rcs-opencode-data",
      "source": "rcs-opencode-data",
      "target": "/root/.local/share/opencode"
    }
  ]
}'
RCS_DEFAULT_SANDBOX_EXTRA_JSON='{
  "opensandbox-cluster": {
    "entrypoint": [
      "docker-entrypoint.sh",
      "acp-runtime",
      "opencode",
      "acp"
    ]
  }
}'
```

这四个参数共同定义新建沙盒的默认配置：

- `RCS_DEFAULT_SANDBOX_IMAGE`：指定实际运行 Agent 的业务沙盒镜像。镜像必须已经导入 OpenSandbox Server 所在 Docker，名称必须与导入时完全一致；它不是 OpenSandbox Server 镜像，也不是 `opensandbox/execd` 镜像。
- `RCS_DEFAULT_SANDBOX_RESOURCES_JSON`：指定该镜像运行时的 CPU、内存、磁盘、GPU、环境变量和挂载。`environment.RCS_URL` 填写沙盒能够访问到的 Fenix 地址，不能填写沙盒容器内的 `localhost`；`environment.RCS_SECRET` 必须与 Fenix 的 `REGISTRY_SECRET` 一致。Peri 和 OpenCode 的挂载目录不同，必须使用对应示例。
- `RCS_DEFAULT_SANDBOX_EXTRA_JSON`：指定 OpenSandbox Cluster 的 Provider 专属参数。`entrypoint` 必须与所选业务镜像内实际存在的启动命令匹配：Peri 使用 `peri`，OpenCode 使用 `opencode`。

这四个参数会共同影响新建 Sandbox：`IMAGE` 决定运行哪个镜像，`AGENT_TYPE` 写入 Sandbox Pool 的 `extra.agent_type` 并用于生成 Machine 记录，`RESOURCES_JSON` 决定运行资源及挂载，`EXTRA_JSON` 决定 Provider 如何启动该镜像。通常更换业务镜像时，需要同步检查这四个参数。

本文默认使用 Peri 镜像。使用 OpenCode 时，必须将 `RCS_DEFAULT_SANDBOX_AGENT_TYPE` 改为 `opencode`，并同步替换 `RCS_DEFAULT_SANDBOX_IMAGE`、`RCS_DEFAULT_SANDBOX_RESOURCES_JSON` 和 `RCS_DEFAULT_SANDBOX_EXTRA_JSON`；不能只替换镜像名称。

其中 `volumes.source` 使用逻辑路径名，不要改成宿主机绝对路径；Cluster 会根据 Server 注册的 `workspace_root` 映射实际目录。

修改默认值只影响之后新建的 `sandbox_instance`，已有实例仍使用自己的配置快照。

`RCS_DEFAULT_SANDBOX_POOL_ID=default` 是 Fenix 使用的默认资源池 ID。Fenix 启动时会创建或更新本地 `sandbox_pool` 配置；已有 `sandbox_instance` 的配置快照不会因默认值变化而被覆盖。

如果 Fenix 运行在 Docker 中，`RCS_SANDBOX_CLUSTER_URL` 必须填写 Fenix 容器可以访问的地址。不要在 Fenix 容器中使用 `http://127.0.0.1:8080`。

启动并检查 Fenix：

```bash
docker compose up -d
curl -fsS http://127.0.0.1:3000/health
```

## 6. 日常运维操作

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

### 6.1 健康检查

```bash
# 检查 Cluster 服务是否健康
./fenix-sandbox-ops.sh health cluster
# 检查 Fenix 服务是否健康
./fenix-sandbox-ops.sh health fenix
# 主动检查指定 OpenSandbox Server，并同步其健康状态
./fenix-sandbox-ops.sh cluster server health-check "${SERVER_ID}"
```

### 6.2 Cluster 资源池

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

### 6.3 Cluster Server

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
  "base_url": "http://<宿主机局域网 IP>:8090",
  "workspace_root": "/workspace",
  "max_sandboxes": 10
}
```

删除 Server 前应先停止新的沙盒分配，并确认没有活跃沙盒依赖该 Server。脚本对删除操作默认要求二次确认。

### 6.4 Fenix 沙盒实例

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

## 7. 部署后人工检查

部署完成后，至少检查以下内容：

1. Cluster 和 Fenix 的健康检查接口正常；
2. `cluster server health-check "${SERVER_ID}"` 返回健康；
3. `cluster server list "${POOL_ID}"` 能看到注册的 Server；
4. Fenix 的 `sandbox list` 能看到默认资源池配置，没有异常的历史实例；
5. 进入 Agent 后能为用户和资源池创建一个沙盒实例；
6. 沙盒容器能够回连 Fenix，Agent 可以执行 ACP 请求；

## 8. 常见问题

### Cluster 无法访问 Server

检查已注册的 `base_url`，并从 Cluster 容器内访问 Server：

```bash
docker compose exec opensandbox-cluster wget -qO- 'http://<宿主机局域网 IP>:8090/health'
```

如果接口需要认证，同时携带 Server API Key。Cluster 和 Server 不共享网络命名空间时，不要注册 `127.0.0.1`。

### Server 无法创建沙盒镜像

通常是镜像只导入了宿主机 Docker，没有导入 Server 的 DinD Docker。通过 `docker compose exec opensandbox-server` 执行 `docker load`，再在同一个容器内执行 `docker image inspect`。

### 沙盒无法回连 Fenix

检查 `RCS_URL` 是否使用沙盒容器可以访问的宿主机或局域网地址，并确认 `RCS_SECRET` 与 Fenix 的注册密钥一致。沙盒内的 `ws://127.0.0.1:3000` 指向的是沙盒自身。

### 宿主机看不到工作空间目录

确认生产 `docker-compose.yml` 暴露了 `/workspace`，并确认请求中的 volume source 已被改写到配置的工作空间根目录。DinD 模式下还要检查 Server 内部的 Docker 数据卷，不能只检查宿主机 Docker。
