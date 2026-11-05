# OpenSandbox Cluster 架构

## 1. 职责与模块

OpenSandbox Cluster 是独立部署的 Bun 服务，管理资源池和 OpenSandbox Server，完成节点调度、沙盒绑定和 HTTP 代理。资源模式下还负责容量预留、沙盒创建与租期回收；节点执行实际资源限制。

```text
调用方 → Cluster → direct HTTP ───────────→ OpenSandbox Server → Docker / 沙盒
            │   └→ frps vhost → 节点 frpc ─→ OpenSandbox Server
            └→ SQLite
```

| 模块 | 职责 |
| --- | --- |
| `PoolService` / `ServerService` | 池、节点配置及容量校验 |
| `AllocationService` | 数量调度、绑定查询、资源统计 |
| `SandboxLifecycleService` | 资源预留、远端创建与销毁、状态协调 |
| `ReconciliationWorker` | 到期回收与失败重试 |
| `ServerTargetResolver` / `ServerConnectionMonitor` | 连接解析、隧道健康与断线检测 |
| `ProxyService` / `OpenSandboxHttpClient` | 代理授权、节点认证、HTTP 转发与挂载路径改写 |
| `SandboxManagementService` / Web 管理页 | 绑定列表及池、节点、沙盒管理 |

## 2. 调度模式

模式由池的 `scheduling_mode` 决定，默认 `count`。

| 规则 | 数量模式 `count` | 资源模式 `resources` |
| --- | --- | --- |
| 容量 | 节点 `max_sandboxes` | 节点 CPU、内存、硬盘、GPU 容量 |
| 创建 | 调用方分配绑定后，通过代理创建 | Cluster 预留资源后创建 |
| 远端沙盒 ID | 调用方保存，Cluster 观察成功创建并记录关联 | binding 保存 |
| 释放 | 调用方删除远端沙盒后释放绑定 | Cluster 确认销毁后归还资源 |
| 租期 | 绑定持续到显式释放 | 固定租期，到期回收 |

资源单位统一为 CPU 核数（支持小数）、内存 MB、硬盘 GB、GPU 数量。CPU、内存、硬盘须大于 0，GPU 为非负整数。

### 2.1 节点选择

新分配只选择 `active` 节点：direct 节点须为 `healthy`；tunnel 节点须连接为 `connected`、健康且心跳未过期。资源模式还要求池为 `active`；数量模式按节点状态筛选。

- **数量模式**：筛选绑定数小于 `max_sandboxes` 的节点，按已用数量占比升序选择。注册容量须为正整数；更新时允许空闲节点设为 0。
- **资源模式**：逐节点计算 `剩余资源 = 配置容量 - 非终态预留`，四类申请量均不超过同一节点剩余量才可分配。候选节点按分配后的最高资源占比升序选择，相同时按节点 ID 排序。

资源准入使用十进制精确求和与比较。池资源查询按节点返回；跨节点资源不能拼成一次申请。

### 2.2 配置变更约束

- 切换池模式前须移空节点，并释放所有非终态绑定。
- 节点有占用时不能迁移到其他池，缩容不能低于已占用数量或资源。
- `draining` 节点只承接已有绑定；`disabled` 节点拒绝代理访问。
- 删除池或节点前须清除所有外键引用，包含保留的资源模式终态记录；有历史引用的对象可停用。

## 3. 数据模型

表定义位于 [`src/db/schema.ts`](../../packages/opensandbox-cluster/src/db/schema.ts)，使用 SQLite 和 Drizzle 迁移。

```text
sandbox_pool 1 ── N opensandbox_server
sandbox_pool 1 ── N sandbox_binding
opensandbox_server 1 ── N sandbox_binding
opensandbox_server 1 ── 1 opensandbox_server_credential
opensandbox_server 1 ── 1 opensandbox_tunnel_connection
```

### 3.1 池与节点

| 表 | 核心字段 | 含义 |
| --- | --- | --- |
| `sandbox_pool` | `id`、`name`、`status` | 池标识与管理状态 |
| | `scheduling_mode` | 调度模式 |
| | `default_lease_seconds`、`max_lease_seconds` | 资源模式默认和最大租期，均至少 60 秒，默认值不超过最大值 |
| `opensandbox_server` | `id`、`pool_id`、`name` | 节点标识及所属池 |
| | `transport_mode`、`base_url`、`route_host` | direct 地址或 tunnel 路由 |
| | `workspace_root`、`api_key_ciphertext` | 挂载根目录、加密的节点 API Key |
| | `max_sandboxes` | 数量模式容量 |
| | `cpu_capacity`、`memory_capacity_mb`、`disk_capacity_gb`、`gpu_capacity` | 资源模式可分配容量 |
| | `status`、`health_status`、`last_health_at`、`last_error` | 管理与健康状态 |

两表均记录 `created_at`、`updated_at`，时间为 epoch milliseconds。容量按池模式校验，资源模式节点的 `max_sandboxes` 为空。

### 3.2 沙盒绑定

`sandbox_binding` 是节点落点和资源预留的权威记录，`sandbox_id` 为调用方提供的全局唯一业务 ID。

| 字段组 | 字段 | 含义 |
| --- | --- | --- |
| 定位 | `sandbox_id`、`pool_id`、`server_id`、`allocation_mode` | 业务标识、节点与分配模式 |
| 资源 | `cpu`、`memory_mb`、`disk_gb`、`gpu_count` | 资源模式预留量 |
| 创建关联 | `attempt_id`、`request_hash`、`provider_sandbox_id` | 创建尝试标识、请求摘要、真实远端 ID |
| 生命周期 | `state`、`lease_seconds`、`expires_at`、`release_reason` | 状态、固定租期与释放原因 |
| 协调 | `retry_count`、`next_retry_at`、`last_error` | 重试调度与诊断 |
| 时间 | `created_at`、`updated_at` | 创建与更新时间 |

数量模式释放时删除绑定，可复用业务 ID。资源模式保留终态记录，后续申请使用新 ID；`server_id + provider_sandbox_id` 唯一。

数量模式代理观察成功创建后记录真实 ID 与请求中的资源配额；配额仅用于展示，不参与数量调度。历史或未提供的配额保持未知。`attempt_id` 区分数量绑定的分配代次，防止迟到结果写入重建后的绑定。

已分配资源从同节点非终态绑定实时汇总，剩余量由容量减去预留量计算。资源查询中的 `pending` 是 `creating`、`uncertain`、`releasing` 的预留量，已包含在 `allocated` 中。完整创建请求、环境变量和镜像凭据不持久化。

### 3.3 隧道凭证与连接

- `opensandbox_server_credential`：每节点一条注册凭证。`token_hash` 用于校验，`token_ciphertext` 用于生成可重新下载的 `frpc.toml`，并记录吊销与轮换状态。
- `opensandbox_tunnel_connection`：每节点一条当前连接，记录 `frp_run_id`、连接状态、健康状态、心跳和错误。重连更新原记录；回调按 run ID 校验，防止旧连接覆盖新连接。

## 4. 沙盒生命周期

### 4.1 数量模式

1. `allocate` 在事务内选择节点并写入绑定。同一业务 ID、同一池返回原绑定；跨池重复分配返回冲突。
2. 调用方通过绑定代理创建和操作远端沙盒，并保存真实远端 ID。
3. 调用方删除远端沙盒，成功后释放绑定。只删除远端沙盒会继续占用数量额度。

### 4.2 资源模式

1. 校验资源、租期和挂载路径，在事务内选择节点并写入 `creating` 预留；`expires_at` 从预留时开始计算。
2. 向节点发送一次原生创建请求，携带资源限制、有限 `timeout` 和 `opensandbox.cluster.attempt_id` metadata。
3. 获取真实远端 ID 后转为 `active`；结果未知时进入 `uncertain`，由后台查询协调。
4. 主动释放或到期时先保存释放意图，进入 `releasing`。远端删除后查询确认 `404`，再转为终态并归还资源。

| 状态 | 含义 | 占用资源 |
| --- | --- | --- |
| `creating` | 已预留，创建中 | 是 |
| `active` | 已取得远端 ID，可访问 | 是 |
| `uncertain` | 创建结果未知，等待关联查询 | 是 |
| `releasing` | 已要求释放，等待确认销毁 | 是 |
| `released` | 主动释放完成 | 否 |
| `expired` | 到期回收完成 | 否 |
| `failed` | 确认创建失败 | 否 |

同一业务 ID 和相同参数重复创建返回原记录，参数冲突返回 `409`；重试不重置租期。暂停沙盒仍占用资源，租期固定。

### 4.3 故障与回收

`attempt_id` 是查询关联标识，节点不提供基于它的创建幂等保证。因此每条预留只发送一次创建 POST；结果未知时按 metadata 查找，只有唯一匹配才接管远端 ID。空列表不能证明在途创建失败，须继续保留预留；长期无法确认时由运维核实。

原生创建的明确拒绝（除超时外的 4xx、镜像拉取失败）返回创建错误并移除本次记录；网络异常或无法确认的节点错误保留预留。释放意图优先于迟到的创建结果，避免取消后恢复为可用状态。

数量模式支持条件创建和释放，按分配代次防止重复创建或误释放；条件创建通过 metadata 恢复真实 ID，明确失败清理本次绑定，未知结果保留绑定。无条件调用保持原有分配与释放语义。

显式 v2 DELETE 确认销毁后删除记录；自动到期与 v1 分配释放保留终态记录，供查询或显式删除。创建结果未知时，HTTP 错误或空清单都不能作为释放预留的依据。

后台 worker 定期处理到期与待协调记录，采用有界并发和指数退避；进程重启后从持久记录恢复处理。

`expires_at` 是访问和回收期限，到期立即拒绝新的代理请求。节点的相对 `timeout` 提供 Cluster 断联时的回收后备；已建立的请求随远端沙盒销毁终止。

## 5. 连接、认证与代理

### 5.1 节点连接

- **direct**：Cluster 访问节点 `base_url`；注册时和手动触发时检查健康。
- **tunnel**：节点 frpc 主动连接 frps，Cluster 通过 vhost 和 `route_host` 访问节点；建链后及后台定时检查健康，并清理过期连接。

连接模式由 `transport_mode` 决定。direct 切换 tunnel 前须停机并通过离线检查，原绑定和节点 API Key 保留。Cluster 重启时将隧道连接标为断开，等待重建；重连不改变沙盒绑定。

绑定始终路由到原节点；节点故障不会自动迁移沙盒。

### 5.2 代理权限

业务 ID 定位绑定和节点，真实远端 ID 定位节点内沙盒。资源模式代理要求绑定为 `active`、未到期，且目标路径匹配其真实远端 ID；允许读取、沙盒子服务操作及 pause/resume。创建、销毁等生命周期操作通过受管接口执行，资源节点的通用 Server 代理被禁用。

管理、分配和代理 API 使用 `Authorization: Bearer <cluster-service-api-key>`。Cluster 转发时移除调用方认证，注入解密后的节点 `OPEN-SANDBOX-API-KEY`；普通节点查询隐藏密钥。

日志复用 `@fenix/logger`，敏感信息脱敏，日志采集不得影响业务请求和响应。

HTTP 代理保留 query、上游状态码及响应体，过滤 hop-by-hop headers，支持流式请求和响应。`PROXY_RESPONSE_TIMEOUT_MS` 控制请求超时；`PROXY_CONNECT_TIMEOUT_MS` 当前未接入独立连接超时。

### 5.3 挂载路径

代理原生 JSON 创建请求时，将 `volumes[*].host.path` 映射到节点 `workspace_root` 下：

```text
user-123/ws → {workspace_root}/user-123/ws
```

`ws`、`/ws`、`./ws` 统一为相对路径，拒绝越界、Windows 盘符路径和 NUL。`workspace_root` 必须是安全绝对路径且不能为 `/`；容器内 `mountPath` 和 PVC 保持原值。用户目录等业务前缀由调用方提供。

节点 Compose 挂载路径、`sandbox.toml` 的 `storage.allowed_host_paths` 与注册的 `workspace_root` 须一致。

## 6. 接口边界

- `/api/v1`：池、节点、数量模式分配、资源查询和代理。
- `/api/v2`：资源模式沙盒创建、查询与销毁。

管理页复用业务 API。接口参数与响应以服务提供的 `/openapi/json` 为准，使用入口见 [README](../../packages/opensandbox-cluster/README.md)。

## 7. 持久化与部署约束

容量判断、节点选择和绑定写入使用 SQLite `BEGIN IMMEDIATE` 事务，远端 HTTP 调用在事务外执行。当前部署为单 Cluster 实例、单 frps；多实例调度需要共享存储和协调机制。

启动时自动执行数据库迁移。升级前停止服务，备份 SQLite（含 WAL）及 `SERVER_API_KEY_ENCRYPTION_KEY`；数据库与原加密密钥配套恢复。

部署配置见 [Cluster 部署说明](../../docker/opensandbox-cluster/README.md)，节点部署见 [direct](../../docker/opensandbox-server/README.md) 和 [tunnel](../../docker/opensandbox-server-tunnel/README.md)。
