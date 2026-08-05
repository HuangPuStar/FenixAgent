# OpenSandbox Cluster 当前架构

## 1. 定位和边界

OpenSandbox Cluster 是一个独立部署的 Bun 服务，负责：

- 管理资源池和 OpenSandbox Server 节点；
- 在资源池内为 `sandbox_id` 选择一个 Server；
- 保存 `sandbox_id -> server_id` 的绑定关系；
- 代理调用方对 OpenSandbox Server 的 HTTP 请求；
- 自动注入目标 Server 的 `OPEN-SANDBOX-API-KEY`；
- 在创建沙盒时改写 host volume 路径，限制宿主机挂载范围；
- 使用 SQLite 保存自身数据。

Cluster 不负责：

- 运行 Docker daemon 或 OpenSandbox Server；
- 创建、恢复、暂停或删除远程沙盒；
- 解析或保存 OpenSandbox 返回的 Provider sandbox ID；
- 维护远程沙盒状态机；
- 自动迁移沙盒或自动故障转移；
- 管理 FenixAgent 的组织、用户和环境数据；
- 提供 Web 管理界面。

服务代码位于 `packages/opensandbox-cluster`，Docker 部署文件位于 `docker/opensandbox-cluster`。

## 2. 总体架构

```text
FenixAgent / 其他调用方
          |
          | Authorization: Bearer <cluster-service-api-key>
          v
OpenSandbox Cluster
  |-- SQLite
  |     |-- sandbox_pool
  |     |-- opensandbox_server
  |     `-- sandbox_binding
  |
  |-- HTTP + OPEN-SANDBOX-API-KEY
  v
OpenSandbox Server 节点
  `-- 节点自己的 Docker daemon（当前节点部署使用 DinD）
          |
          v
      Sandbox 容器 + execd
```

Cluster 只通过 HTTP 访问 OpenSandbox Server，不访问 Docker Socket。节点内部的 Docker daemon、沙盒容器和镜像由 OpenSandbox Server 管理。

### 2.1 实际目录

```text
packages/opensandbox-cluster/
├── src/
├── drizzle/
├── package.json
├── drizzle.config.ts
└── .env.example              # 本地 Bun 启动配置

docker/opensandbox-cluster/
├── Dockerfile
├── docker-compose.yml
├── .env.example              # Docker 部署配置
└── README.md
```

## 3. 数据模型

当前 Cluster 使用 SQLite，迁移文件为：

```text
packages/opensandbox-cluster/drizzle/0000_initial.sql
```

### 3.1 模型关系

```text
sandbox_pool 1 ---- N opensandbox_server
sandbox_pool 1 ---- N sandbox_binding
opensandbox_server 1 ---- N sandbox_binding

sandbox_binding.sandbox_id 是全局主键
sandbox_binding.server_id 指向实际承载沙盒的 Server
```

### 3.2 sandbox_pool

| 字段 | SQLite 类型 | 说明 |
| --- | --- | --- |
| `id` | `text` | 调用方控制的资源池 ID，主键 |
| `name` | `text` | 资源池名称 |
| `status` | `text` | 默认 `active`，当前仅持久化，不参与 allocate 过滤 |
| `created_at` | `integer` | 创建时间，epoch milliseconds |
| `updated_at` | `integer` | 更新时间，epoch milliseconds |

资源池没有 `max_sandboxes` 字段。查询资源池时，服务实时计算：

- `currentSandboxes`：该资源池下 binding 数量；
- `capacitySandboxes`：所有 Server 的 `maxSandboxes` 之和；
- `availableSandboxes`：状态为 `active` 且健康状态为 `healthy` 的 Server 剩余容量之和。

当前实现虽然允许保存资源池 `status`，但 `allocate` 尚未根据资源池状态过滤。实际是否允许分配由候选 Server 是否为 `active` 且 `healthy` 决定。

### 3.3 opensandbox_server

| 字段 | SQLite 类型 | 说明 |
| --- | --- | --- |
| `id` | `text` | 调用方控制的 Server ID，主键 |
| `pool_id` | `text` | 所属资源池 ID，外键 |
| `name` | `text` | Server 名称 |
| `base_url` | `text` | OpenSandbox Server 基础 URL，按原值保存 |
| `workspace_root` | `text` | Cluster 改写 host volume 时使用的绝对路径 |
| `api_key_ciphertext` | `text` | 使用 `SERVER_API_KEY_ENCRYPTION_KEY` 加密保存 |
| `max_sandboxes` | `integer` | 该 Server 的容量上限 |
| `status` | `text` | 默认 `active`，常用值为 `active`、`draining`、`disabled` |
| `health_status` | `text` | 默认 `unknown`，健康检查后为 `healthy` 或 `unhealthy` |
| `last_health_at` | `integer` | 最近一次手动健康检查时间 |
| `last_error` | `text` | 最近一次健康检查失败信息 |
| `created_at` | `integer` | 创建时间 |
| `updated_at` | `integer` | 更新时间 |

约束和实际行为：

- `pool_id` 必须指向已存在的资源池；
- `workspace_root` 必须是绝对路径，不能是 `/`，不能包含 NUL 或路径穿越；
- 查询 Server 时不会返回明文 API Key；
- `active + healthy` 的 Server 才会被 `allocate` 选中；
- `disabled` 或 `unhealthy` 的 Server 不允许代理请求；
- `draining` 不会被新分配选中，但当前代理实现不会因为 `draining` 阻止已有绑定请求；
- 删除存在 binding 的 Server 会返回冲突；
- 修改容量上限时，不能小于当前 binding 数量；
- 修改有 binding 的 Server 的 `pool_id` 会返回冲突。

### 3.4 sandbox_binding

| 字段 | SQLite 类型 | 说明 |
| --- | --- | --- |
| `sandbox_id` | `text` | 调用方控制的沙盒 ID，全局主键 |
| `pool_id` | `text` | 分配时使用的资源池 ID，外键 |
| `server_id` | `text` | 实际承载 Server ID，外键 |
| `created_at` | `integer` | 绑定创建时间 |

该表只保存落点和容量占用，不保存：

- OpenSandbox 返回的 Provider sandbox ID；
- 远程沙盒状态；
- allocation status；
- released_at；
- last_error。

binding 写入即计入容量。远程沙盒删除成功后，调用方还需要调用 release 接口删除 binding。

同一个 `sandbox_id` 在 Cluster 内全局唯一。如果它已经绑定到其他资源池，重复 allocate 会返回冲突。

## 4. 核心流程

### 4.1 Server 注册

```text
调用方 POST /api/v1/servers
        |
        | 校验 pool_id、workspace_root、API Key 和容量
        v
写入 SQLite
        |
        v
health_status = unknown
        |
        | 注册流程立即调用目标 Server 的 GET /health
        v
返回 healthy / unhealthy 的 Server 记录
```

注册流程会在写入后立即执行一次健康检查，因此正常情况下注册接口返回的
`healthStatus` 已经是 `healthy` 或 `unhealthy`，不会长期停留在 `unknown`。注册和修改只保存连接信息，不会创建或删除远程 OpenSandbox Server。

### 4.2 allocate 选择 Server

```text
POST /api/v1/pools/:poolId/sandboxes/:sandboxId/allocate
        |
        v
SQLite BEGIN IMMEDIATE
        |
        | 已有 sandbox_id 绑定？
        |-- 是：同 pool 返回原绑定；不同 pool 返回 409
        |
        | 查询 pool 下 Server
        |-- 过滤 status=active
        |-- 过滤 health_status=healthy
        |-- 过滤 current < max_sandboxes
        |
        | 按 current / max_sandboxes 升序选择
        v
写入 sandbox_binding
        |
        v
COMMIT，返回 server_id 和 proxy_url
```

调度锁只覆盖 SQLite 中的容量判断、Server 选择和 binding 写入，不覆盖后续远程 HTTP 请求。

当前算法只按负载比例升序排序，没有额外的稳定 tie-breaker。

### 4.3 通过 sandbox_id 代理

```text
调用方请求 /api/v1/sandboxes/:sandboxId/proxy/*path
        |
        v
查询 sandbox_binding
        |
        v
找到 server_id，读取 Server 配置和解密 API Key
        |
        v
拼接 base_url + 原始 path
        |
        v
覆盖 OPEN-SANDBOX-API-KEY，转发请求
```

Cluster 不会根据当前健康状态重新选择 Server，也不会迁移已有 binding。

### 4.4 创建沙盒时的 volume 改写

只有满足以下条件时才改写请求体：

- HTTP 方法为 `POST`；
- 目标 path 正好是 `v1/sandboxes`；
- `Content-Type` 包含 `application/json`；
- 请求通过 `sandbox_id` 代理，因此能取得 `workspace_root`。

调用方传入：

```json
{
  "volumes": [
    {
      "name": "workspace",
      "host": { "path": "ws" },
      "mountPath": "/workspace"
    }
  ]
}
```

Cluster 转发为：

```text
{workspace_root}/{sandbox_id}/ws
```

规则：

- `ws`、`/ws`、`./ws` 会归一化到同一个相对路径；
- host volume 的 `path` 必须是相对 workspace 的路径；
- Windows drive path、NUL 字节和 `..` 路径穿越会被拒绝；
- `sandbox_id` 只能包含字母、数字、`.`、`_`、`-`，且不能以特殊字符开头；
- 只改写 `volume.host.path`，不改写容器内的 `mountPath`；
- PVC 或其他没有 `host` 对象的 volume 保持原样；
- 非 JSON 创建请求不会执行 volume 改写。

不同业务镜像的默认容器内 workspace `mountPath` 不由 Cluster 决定，应该由上游调用方根据镜像配置生成；Cluster 只负责宿主机 host path 隔离。

### 4.5 删除流程

Cluster 不自动删除远程沙盒，也不根据远程删除响应自动释放 binding。调用方负责按顺序执行：

```text
DELETE /api/v1/sandboxes/:sandboxId/proxy/...
        |
        | 远程 OpenSandbox 删除成功
        v
DELETE /api/v1/sandboxes/:sandboxId/allocation
```

如果只删除远程沙盒而不释放 binding，容量会继续被占用。

## 5. 接口

### 5.1 通用约定

- 管理、分配和代理接口前缀均为 `/api/v1`；
- 除 `GET /health` 外，管理、分配和代理接口都使用 `Authorization: Bearer <cluster-service-api-key>`；
- Cluster 不接受调用方自带的 `OPEN-SANDBOX-API-KEY` 作为目标认证；
- 代理时由 Cluster 自动设置目标 Server 的 `OPEN-SANDBOX-API-KEY`；
- 代理会保留 query string；
- 代理会移除 hop-by-hop headers；
- 代理响应状态码和响应体直接返回；
- GET、HEAD 不发送请求体，其他方法支持流式请求体；
- 代理响应超时由 `PROXY_RESPONSE_TIMEOUT_MS` 控制，默认 120000ms；
- 当前 `PROXY_CONNECT_TIMEOUT_MS` 已作为配置项存在，但 HTTP 客户端实际只使用响应超时信号。

### 5.2 健康检查

```text
GET /health
```

响应：

```json
{"status":"healthy"}
```

### 5.3 资源池管理

```text
POST   /api/v1/pools
GET    /api/v1/pools
GET    /api/v1/pools/:poolId
PUT    /api/v1/pools/:poolId
DELETE /api/v1/pools/:poolId
```

创建请求：

```json
{
  "id": "pool-default",
  "name": "Default"
}
```

修改请求只支持 `name` 和 `status`：

```json
{
  "name": "Updated Pool",
  "status": "active"
}
```

查询资源池响应字段为 camelCase，例如：

```json
{
  "id": "pool-default",
  "name": "Default",
  "status": "active",
  "createdAt": 1785838035130,
  "updatedAt": 1785838035130,
  "currentSandboxes": 1,
  "capacitySandboxes": 4,
  "availableSandboxes": 3
}
```

删除存在 Server 或 binding 的资源池会返回冲突。

### 5.4 OpenSandbox Server 管理

```text
POST   /api/v1/servers
GET    /api/v1/servers
GET    /api/v1/servers/:serverId
PUT    /api/v1/servers/:serverId
DELETE /api/v1/servers/:serverId
POST   /api/v1/servers/:serverId/health-check
```

创建请求：

```json
{
  "id": "server-node-1",
  "pool_id": "pool-default",
  "name": "Node 1",
  "base_url": "http://node-1:8090",
  "workspace_root": "/workspace/sandboxes",
  "api_key": "replace-with-server-api-key",
  "max_sandboxes": 10
}
```

`PUT /api/v1/servers/:serverId` 接收部分字段，支持：

```json
{
  "pool_id": "pool-default",
  "name": "Node 1 Updated",
  "base_url": "http://node-1:8090",
  "workspace_root": "/workspace/sandboxes",
  "api_key": "new-server-api-key",
  "max_sandboxes": 10,
  "status": "active"
}
```

Server 查询响应不会包含 `apiKeyCiphertext` 或明文 API Key，字段示例：

```json
{
  "id": "server-node-1",
  "poolId": "pool-default",
  "name": "Node 1",
  "baseUrl": "http://node-1:8090",
  "workspaceRoot": "/workspace/sandboxes",
  "maxSandboxes": 10,
  "status": "active",
  "healthStatus": "healthy",
  "lastHealthAt": 1785838035156,
  "lastError": null,
  "currentSandboxes": 0
}
```

健康检查请求目标 Server 的 `/health`：

- HTTP 响应为 2xx：记录 `healthy`；
- 非 2xx、连接失败或超时：记录 `unhealthy`；
- 创建 Server 时自动触发一次；
- 修改 Server 不自动触发健康检查；
- 也可以调用 `POST /api/v1/servers/:serverId/health-check` 手动刷新；
- 当前没有后台定时健康检查。

### 5.5 分配和绑定

```text
POST   /api/v1/pools/:poolId/sandboxes/:sandboxId/allocate
GET    /api/v1/sandboxes/:sandboxId/allocation
DELETE /api/v1/sandboxes/:sandboxId/allocation
```

成功分配响应：

```json
{
  "sandbox_id": "sbi_xxx",
  "pool_id": "pool-default",
  "server_id": "server-node-1",
  "proxy_url": "/api/v1/sandboxes/sbi_xxx/proxy"
}
```

同一 `sandbox_id` 重复在同一个 pool 调用 allocate 会返回原绑定；如果已经属于其他 pool，会返回 `409`。allocate 不调用 OpenSandbox Server，不创建远程沙盒。

### 5.6 按 sandbox_id 代理

```text
ANY /api/v1/sandboxes/:sandboxId/proxy/*path
```

示例：

```text
GET    /api/v1/sandboxes/sbi_xxx/proxy/v1/sandboxes/osb_xxx
POST   /api/v1/sandboxes/sbi_xxx/proxy/v1/sandboxes
DELETE /api/v1/sandboxes/sbi_xxx/proxy/v1/sandboxes/osb_xxx
```

未找到 binding 返回 `404`。目标 Server 为 `disabled` 或 `unhealthy` 时返回 `503`。目标 Server 请求异常一般返回 `502`，响应超时返回 `504`。

### 5.7 按 server_id 代理

```text
ANY /api/v1/servers/:serverId/proxy/*path
```

该接口直接按 `server_id` 找到 Server，不做容量分配，也不创建或修改 binding。它和其他接口一样需要 Cluster API Key，当前实现没有额外的管理员角色鉴权。

## 6. 错误和一致性

### 6.1 错误状态

当前代码实际使用的主要状态码：

| 场景 | 状态码 |
| --- | --- |
| Cluster API Key 缺失或错误 | 401 |
| 资源池、Server 或 binding 不存在 | 404 |
| 资源池或 Server 有关联记录，不能删除 | 409 |
| 没有可用 Server | 409 |
| 请求参数不合法 | 400 |
| Server 为 disabled/unhealthy，不能代理 | 503 |
| 目标 Server 请求失败 | 502 |
| 目标 Server 请求超时 | 504 |

目标 Server 返回的 HTTP 状态码和响应体会直接透传，不会被 Cluster 转换为 Cluster 错误结构。

### 6.2 远程请求失败

allocate 成功后，Cluster 不知道调用方是否已经成功创建远程沙盒。远程创建超时或失败时，binding 不会自动回滚，也不会自动换 Server。调用方需要根据实际远程结果选择重试、继续使用或显式 release。

### 6.3 单实例 SQLite 并发

容量分配使用 SQLite `BEGIN IMMEDIATE`，在单个 Cluster 进程内串行化分配事务。当前部署是单实例服务；没有实现多 Cluster 实例之间的分布式锁或高可用协调。

## 7. Docker 部署

### 7.1 Cluster 部署文件

```text
docker/opensandbox-cluster/
├── Dockerfile
├── docker-compose.yml
├── .env.example
└── README.md
```

Compose 只启动一个 Cluster 容器，不挂载 Docker Socket：

```yaml
services:
  opensandbox-cluster:
    build:
      context: ../..
      dockerfile: docker/opensandbox-cluster/Dockerfile
    ports:
      - "${PORT:-8080}:8080"
    env_file:
      - .env
    volumes:
      - opensandbox-cluster-data:/data
```

容器启动入口会先执行 `src/db/migrate.ts` 中的迁移，再启动 HTTP 服务。数据库路径默认是：

```text
/data/opensandbox-cluster.db
```

### 7.2 Cluster 环境变量

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 宿主机端口映射和应用监听端口 |
| `HOST` | `0.0.0.0` | 应用监听地址 |
| `DATABASE_PATH` | `/data/opensandbox-cluster.db` | 容器内 SQLite 路径 |
| `CLUSTER_SERVICE_API_KEY` | 无 | 必填，Cluster API 鉴权 |
| `SERVER_API_KEY_ENCRYPTION_KEY` | 无 | 必填，必须为 32 字节 |
| `PROXY_CONNECT_TIMEOUT_MS` | `3000` | 当前作为配置项存在，HTTP 客户端未实际使用 |
| `PROXY_RESPONSE_TIMEOUT_MS` | `120000` | 代理响应超时时间 |

### 7.3 节点连接关系

Cluster 容器必须能够访问每个 Server 的 `base_url`。Server 容器不需要加入 Cluster 的 Compose 网络，可以使用宿主机 IP、DNS 或其他 Cluster 可达地址。

当前 Server 节点只保留 DinD 部署：

```text
docker/opensandbox-server/docker-compose.dind.yml
        |
        v
OpenSandbox Server 容器
  |-- /var/lib/docker  -> docker-data volume
  |-- /workspace/sandboxes -> ./workspace/sandboxes
  `-- /offline -> ./offline
        |
        v
    DinD daemon -> Sandbox containers
```

节点注册时，`workspace_root`、`sandbox.toml` 的 `allowed_host_paths` 和 Compose 内的容器路径必须一致。当前示例统一为 `/workspace/sandboxes`。

## 8. FenixAgent 调用顺序

Cluster 只提供资源池和 HTTP 透传能力。上游 Provider 的实际调用顺序是：

```text
首次创建
  1. POST /api/v1/pools/:poolId/sandboxes/:sandboxId/allocate
  2. POST /api/v1/sandboxes/:sandboxId/proxy/v1/sandboxes

后续 get / resume / exec / 文件 / 端口操作
  直接调用 sandbox proxy，不重复 allocate

销毁
  1. 通过 sandbox proxy 删除远程沙盒
  2. 远程删除成功后 DELETE /api/v1/sandboxes/:sandboxId/allocation
```

不同业务镜像的默认容器内 workspace 挂载点由上游 Provider 根据镜像配置决定。Cluster 只处理宿主机侧的 workspace 隔离和路径安全。

## 9. 已验证范围和当前限制

已完成本地验证：

- DinD OpenSandbox Server 启动和健康检查；
- 业务沙盒镜像导入 DinD；
- Cluster Docker 镜像构建、SQLite 初始迁移和健康检查；
- 资源池创建和 Server 注册；
- Server 健康检查；
- allocate 幂等和容量占用；
- 通过 Cluster 代理创建、查询和执行沙盒命令；
- 修改 `workspace_root` 后重新创建沙盒；
- host volume 路径改写并在宿主机验证文件落盘；
- 远程删除、binding release、Server 和资源池清理。

当前限制：

- 单 Cluster 实例；
- SQLite，不支持多实例共享调度；
- 没有后台健康检查；
- 没有远程沙盒状态同步；
- 没有自动释放孤儿 binding；
- 没有自动故障迁移；
- 没有 Web 管理页面；
- OpenSandbox Server 节点当前只验证 DinD 部署；
- 资源池 `status` 当前不会阻止 allocate；
- `PROXY_CONNECT_TIMEOUT_MS` 当前尚未真正应用到 HTTP 连接建立阶段。
