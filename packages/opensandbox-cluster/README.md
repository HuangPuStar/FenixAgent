# OpenSandbox Cluster

独立的 OpenSandbox Server 集群调度和 HTTP 透传服务，使用 SQLite 保存资源池、Server 和 sandbox binding。

## 本地启动

```bash
cp .env.example .env
bun install
bun run src/db/migrate.ts
bun run dev
```

`CLUSTER_SERVICE_API_KEY` 用于调用方鉴权；`SERVER_API_KEY_ENCRYPTION_KEY` 必须是 32 字节密钥，用于加密 SQLite 中的 OpenSandbox Server API Key。

## Docker 部署

统一部署文件位于 [`docker/opensandbox-cluster`](../../docker/opensandbox-cluster/README.md)：

```bash
cd ../../docker/opensandbox-cluster
cp .env.example .env
docker compose up -d --build
```

## 调用顺序

```text
创建资源池/Server
  -> POST /api/v1/pools/:poolId/sandboxes/:sandboxId/allocate
  -> 通过 /api/v1/sandboxes/:sandboxId/proxy/... 调用 OpenSandbox
  -> 远程删除成功后 DELETE /api/v1/sandboxes/:sandboxId/allocation
```

`allocate` 对同一 `sandbox_id` 幂等，后续查询和代理不需要再次分配。

每个 OpenSandbox Server 注册时必须提供自己的 `workspace_root`。DinD 示例：

```json
{
  "workspace_root": "/workspace"
}
```

创建沙盒时，调用方可以在 `volumes[*].host.path` 中传入相对路径。Fenix 等上游业务应先把稳定的用户目录前缀写入路径，例如：

```text
user-123/ws
```

Cluster 只负责在代理到 OpenSandbox Server 前拼接：

```text
{server.workspace_root}/user-123/ws
```

Cluster 不感知 `userId` 和其他业务语义，也不会把 `sandbox_id` 插入宿主机路径。`ws`、`/ws` 和 `./ws` 都会被规范化为同一个相对路径；`mountPath` 和 PVC volume 不会被改写，`..`、Windows 绝对路径和 NUL 字符会被拒绝。OpenSandbox Server 节点的 Compose 挂载路径、`sandbox.toml` 的 `storage.allowed_host_paths` 和 Cluster 的 `workspace_root` 必须保持一致。
