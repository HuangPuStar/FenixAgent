# 创建与销毁 API

所有路径以 `CLUSTER_URL` 为根，带 Cluster Bearer 认证；JSON 请求带 `Content-Type: application/json`。HTTP 错误响应保留 `error.code`、`error.message` 用于诊断。

## 资源模式

`POST /api/v2/pools/{poolId}/sandboxes`：

```json
{
  "sandbox_id": "<任务唯一业务ID>",
  "lease_seconds": 3600,
  "resources": { "cpu": 0.5, "memoryMb": 512, "diskGb": 5, "gpuCount": 0 },
  "sandbox": {
    "image": { "uri": "<任务镜像:tag>" },
    "entrypoint": ["sleep", "infinity"]
  }
}
```

示例配额和镜像需换成任务实际值。创建需要同一节点同时满足四项资源。`lease_seconds` 至少 60，不超过池最大租期；到期即拒绝代理访问，销毁后归还预留。

`201` 创建成功，`202` 为待确认；响应包含 `sandbox_id`、`provider_sandbox_id`、`proxy_url`、`state`、`resources`、`expires_at`（epoch milliseconds）。通过 `Location` 或 `GET /api/v2/sandboxes/{sandboxId}` 查询。读取状态可有界轮询，例如间隔 5 秒、最多 12 次；仍未完成则报告状态，不能声称失败后立即另建。

销毁：`DELETE /api/v2/sandboxes/{sandboxId}`。`204` 已销毁并清理记录；`202` 回收中。资源只在确认销毁后归还。

## 数量模式

1. `POST /api/v1/pools/{poolId}/sandboxes/{sandboxId}/allocate`，带 `If-None-Match: *`。返回绑定、`proxy_url`、`allocation_etag`；`409` 表示已有绑定或容量不足，先查询原因。
2. `POST {proxy_url}/v1/sandboxes`，带 `If-None-Match: *` 及 `If-Match: <allocation_etag 的 JSON 字符串>`。例如 ETag 为 `abc` 时，头值是 `"abc"`，包含双引号。

原生创建 body：

```json
{
  "image": { "uri": "<任务镜像:tag>" },
  "entrypoint": ["sleep", "infinity"],
  "resourceLimits": { "cpu": "500m", "memory": "512Mi", "disk": "5Gi", "gpu": "0" },
  "timeout": 3600
}
```

数量模式原生接口遵循 OpenSandbox 资源格式：CPU 核数乘 1000 转为 `m`，内存 MB 对应 `Mi`，硬盘 GB 对应 `Gi`，GPU 数量为字符串。`timeout` 是沙盒使用秒数，至少 60；省略/null 不自动销毁。原生返回的 `id` 是真实 ID。

创建后可以 `GET /api/v1/sandboxes/{sandboxId}/allocation` 获取关联信息。出现未知结果时只查询/诊断，不能再次 POST 原生创建。

释放顺序：

```text
DELETE {proxy_url}/v1/sandboxes/{provider_sandbox_id}
GET    {proxy_url}/v1/sandboxes/{provider_sandbox_id}  → 确认 404
GET    /api/v1/sandboxes/{sandboxId}/allocation       → 读取最新 allocation_etag
DELETE /api/v1/sandboxes/{sandboxId}/allocation      → If-Match: 最新 ETag 的 JSON 字符串
```

真实 ID 写入绑定后 ETag 会变化，不复用创建前的 ETag。释放返回 `409` 时重新核实分配代次，不能去掉条件头强制释放。

## 查询与挂载

- `GET /api/v1/sandbox-allocations?pool_id={poolId}&page=1&pageSize=20` 查询绑定列表，也可筛选 `server_id`、模式和状态。
- `GET /api/v1/pools/{poolId}/resources` 逐节点返回剩余容量。
- 资源模式持久挂载使用 `resources.volumes`，字段为 `name`、`source`、`target`、`readOnly`；数量模式使用原生 `volumes[*].host.path`、`mountPath`。
- 挂载 source/host.path 由调用方提供任务前缀相对路径，如 `task-123/ws`，Cluster 映射到节点 `/workspace/task-123/ws`。需要目标机器已有数据时，先确认该目录实际位于选中节点；绑定不会自动迁移。
