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

默认 Compose 同时启动 Cluster 和单实例 `frps`：

- Cluster API：宿主机 `8080`；
- FRP 登录端口：宿主机 `7000`，供 Server 的 `frpc` 主动连接；
- FRP Plugin `8081` 和 vhost `7080`：仅 Docker 内部网络可见，不对宿主机发布。

`.env` 至少配置：

```env
FRP_PUBLIC_ADDRESS=cluster.example.com
FRP_BIND_PORT=7000
FRP_TOKEN=replace-with-a-url-safe-random-token
```

`FRP_TOKEN` 同时用于 frpc/frps 登录认证和 frps 回调 Cluster Plugin；建议只使用字母、数字、`-`、`_`。`FRP_BIND_PORT` 修改后，必须重新下载对应 Server 的 `frpc.toml`。

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
## Server 连接模式

Server 支持 `direct` 与 `tunnel` 两种 transport：

- `direct`：Cluster 直接访问 Server 的 `base_url`，Server 需要提供可达端口；
- `tunnel`：Server 内的 `frpc` 主动连接 Cluster 的 `frps`，Cluster 通过 FRP vhost 访问 Server，Server 不需要发布宿主机端口。

tunnel 配置有两种入口，二选一：

- 新建 Server：在 `POST /api/v1/servers` 中设置 `transport_mode=tunnel`；
- 迁移已有 direct Server：先停机，再调用 `PUT /api/v1/servers/:serverId/tunnel`，由接口检查离线并切换模式。

完成任一入口后，再调用 `GET /api/v1/servers/:serverId/tunnel/frpc.toml` 下载配置。

然后将文件安全地挂载到 Server 的 `/etc/frp/frpc.toml`，使用 `docker-compose.tunnel.yml` 重启或启动 Server，等待 FRP 连接恢复。
