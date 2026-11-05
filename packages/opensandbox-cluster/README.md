# OpenSandbox Cluster

独立的 OpenSandbox Server 集群调度和 HTTP 代理服务，使用 SQLite 保存资源池、节点和沙盒绑定。

## 启动服务

### 本地启动

在 `packages/opensandbox-cluster` 目录执行：

```bash
cp .env.example .env
bun install
bun run src/db/migrate.ts
bun run dev
```

`CLUSTER_SERVICE_API_KEY` 用于调用方鉴权；`SERVER_API_KEY_ENCRYPTION_KEY` 必须是 32 字节密钥，用于加密 SQLite 中的 OpenSandbox Server API Key。

### Docker 部署

统一部署文件位于 [`docker/opensandbox-cluster`](../../docker/opensandbox-cluster/README.md)：

```bash
cd ../../docker/opensandbox-cluster
cp .env.example .env
docker compose up -d --build
```

默认 Compose 同时启动 Cluster 和单实例 `frps`：

- Cluster API：宿主机 `8080`；
- FRP 登录端口：宿主机 `7000`，供 Server 的 `frpc` 主动连接；
- FRP Plugin `8081` 和 vhost `7080`：仅 Docker 内部网络可见，不对宿主机发布。

`.env` 至少配置：

```dotenv
FRP_PUBLIC_ADDRESS=cluster.example.com
FRP_BIND_PORT=7000
FRP_TOKEN=replace-with-a-url-safe-random-token
```

`FRP_TOKEN` 同时用于 frpc/frps 登录认证和 frps 回调 Cluster Plugin；建议只使用字母、数字、`-`、`_`。`FRP_BIND_PORT` 修改后，必须重新下载对应 Server 的 `frpc.toml`。

## 配置节点

### 连接方式

节点支持两种连接方式：

- `direct`：Cluster 直接访问 Server 的 `base_url`，Server 需要提供可达端口；
- `tunnel`：Server 内的 `frpc` 主动连接 Cluster 的 `frps`，Cluster 通过 FRP vhost 访问 Server，Server 不需要发布宿主机端口。

tunnel 配置有两种入口，二选一：

- 新建 Server：在 `POST /api/v1/servers` 中设置 `transport_mode=tunnel`；
- 迁移已有 direct Server：先停机，再调用 `PUT /api/v1/servers/:serverId/tunnel`，由接口检查离线并切换模式。

完成任一入口后，再调用 `GET /api/v1/servers/:serverId/tunnel/frpc.toml` 下载配置。

然后将文件安全地挂载到 Server 的 `/etc/frp/frpc.toml`，参考 [tunnel 节点部署说明](../../docker/opensandbox-server-tunnel/README.md) 启动或重启 Server，等待 FRP 连接恢复。

### 工作目录

每个节点注册时须指定 `workspace_root`，例如 `/workspace`。节点 Compose 挂载路径、`sandbox.toml` 的 `storage.allowed_host_paths` 和 `workspace_root` 须保持一致。

创建沙盒时，调用方提供相对路径，Cluster 将其映射到节点工作目录：

```text
user-123/ws → {workspace_root}/user-123/ws
```

数量模式通过 `volumes[*].host.path` 传入路径，资源模式通过 `resources.volumes[*].source` 传入。用户目录前缀由调用方提供。

`ws`、`/ws` 和 `./ws` 统一为相对路径；拒绝越界、Windows 绝对路径和 NUL 字符。容器内挂载点和 PVC volume 保持原值。

## 管理沙盒

资源池通过 `scheduling_mode` 选择数量模式或资源模式，默认使用数量模式。

### 数量模式

数量模式（`count`）按节点的 `max_sandboxes` 分配沙盒。

```text
创建资源池/Server
  -> POST /api/v1/pools/:poolId/sandboxes/:sandboxId/allocate
  -> 通过 /api/v1/sandboxes/:sandboxId/proxy/... 调用 OpenSandbox
  -> 远程删除成功后 DELETE /api/v1/sandboxes/:sandboxId/allocation
```

`allocate` 对同一 `sandbox_id` 幂等，后续查询和代理不需要再次分配。

### 资源模式

资源模式（`resources`）按节点剩余资源分配沙盒，并在租期到期后自动销毁。

创建池时设置 `scheduling_mode: "resources"`，并指定默认租期 `default_lease_seconds` 和最大租期 `max_lease_seconds`，最短租期为 60 秒。注册节点时配置可分配容量：

| 字段 | 含义 | 单位 |
| --- | --- | --- |
| `cpu_capacity` | CPU 容量 | 核，支持小数 |
| `memory_capacity_mb` | 内存容量 | MB |
| `disk_capacity_gb` | 硬盘容量 | GB |
| `gpu_capacity` | GPU 容量 | 数量，可为 0 |

申请的四类资源须由同一节点同时满足，容量不足返回 `409`。

```http
POST /api/v2/pools/:poolId/sandboxes
GET /api/v2/sandboxes/:sandboxId
DELETE /api/v2/sandboxes/:sandboxId
GET /api/v1/servers/:serverId/resources
GET /api/v1/pools/:poolId/resources
```

创建示例：

```json
{
  "sandbox_id": "job-123",
  "lease_seconds": 3600,
  "resources": {
    "cpu": 0.5,
    "memoryMb": 512,
    "diskGb": 5,
    "gpuCount": 0,
    "environment": {},
    "volumes": []
  },
  "sandbox": {
    "image": { "uri": "your-worker:tag" },
    "entrypoint": ["sleep", "infinity"]
  }
}
```

创建成功返回 `201`；处理中返回 `202`，通过响应的 `Location` 查询进度。`lease_seconds` 省略时使用池的默认租期。

使用返回的 `proxy_url` 和 `provider_sandbox_id` 访问沙盒内的服务，例如 execd：

```http
GET {proxy_url}/v1/sandboxes/{provider_sandbox_id}/proxy/44772/ping
```

主动释放使用沙盒删除接口：销毁完成返回 `204`，回收中返回 `202`。资源在确认销毁后归还。查询及创建重试使用同一 `sandbox_id`，释放或到期后的新申请使用新 ID。

Cluster 负责容量预留与分配，实际资源限制由 OpenSandbox 节点执行。

## 升级

升级前停止 Cluster，备份 SQLite 数据库（含 WAL）及加密密钥。启动时自动执行迁移，也可在包目录运行 `bun run src/db/migrate.ts`。
