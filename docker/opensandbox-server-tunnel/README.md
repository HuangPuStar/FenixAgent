# OpenSandbox Server tunnel 部署

本目录用于以 tunnel 模式启动 OpenSandbox Server。Server 内的 `frpc` 会主动连接 Cluster 的 `frps`，因此 Server 不需要向 Cluster 提供入站端口，也不会发布 Server 管理端口或沙盒端口。

契约与边界见 [`docs/operations/docker-topology.md`](../../docs/operations/docker-topology.md)（§3 网络分层、§6 依赖目录契约）。

## 前置条件

- Docker Engine + Compose v2（≥ 2.20），且允许特权容器与 `cgroup: host`。
- Cluster 已启动，且 Server 所在机器能访问 `${FRP_PUBLIC_ADDRESS}:${FRP_BIND_PORT}`（默认 `7000`）。
- 与 `../opensandbox-server/` 同源的镜像：默认用 `docker-compose.yml` 里写死的发布 tag；离线自建时执行
  `docker build -f docker/opensandbox-server/Dockerfile -t <本目录声明的那一个 tag> docker/opensandbox-server`（在仓库根），
  两个目录的 `image:` 行必须同 tag。

本目录没有 compose 插值键，因此不提供 `.env.example`：配置全在下面两个文件里。

## 准备配置

1. 在 Cluster 创建 tunnel Server，或将已停止的 direct Server 切换为 tunnel。
2. 从 Cluster 下载该 Server 专属的配置：

   ```bash
   ./fenix-sandbox-ops.sh cluster server tunnel \
     <server-id> /path/to/aos-sandbox/docker/opensandbox-server-tunnel/frpc.toml
   ```

   对新建的 tunnel Server，创建时传入 `transport_mode=tunnel`；对已有 direct Server，必须先停止 Server，再执行上述命令。
3. 准备本目录下的 `sandbox.toml`、`workspace/`、`offline/`、`data/docker/` 和 `data/opensandbox/`，可以参考上级 Server 目录中的 `sandbox.toml.example`。

```bash
cp ../opensandbox-server/sandbox.toml.example sandbox.toml
mkdir -p data/docker data/opensandbox workspace offline
chmod 600 frpc.toml   # entrypoint 会校验权限：只允许 400 / 600 / 440 / 640
```

`frpc.toml` 含有 Server 的隧道凭证，不要提交到 Git；文件权限应为 `0600` 或更严格。

## 启动与停止

在本目录执行：

```bash
docker compose up -d
docker compose ps
docker compose logs -f opensandbox-server
docker compose stop
```

也可由一键入口启动：在 `docker/deploy.env` 里打开 `FENIX_FEATURE_OPENSANDBOX_SERVER_TUNNEL=true`，再执行 `./docker/deploy.sh up`。

## 网络接入清单

本目录**不接入** `fenix-server`：tunnel 模式没有任何入站流量，Server 与 frpc 只出站连接 frps，因此全部服务留在项目默认网络即可。反过来说它也不依赖主服务项目先启动，可以单独部署。

## 数据落点

`./data/docker`（DinD 内部镜像与容器）、`./data/opensandbox`（Server 状态）、`./workspace`（沙盒数据）都是 bind 挂载，随本目录整体搬迁/备份。与 `../opensandbox-server/` 的项目名（`opensandbox-server` / `opensandbox-server-tunnel`）不同，两者的数据与容器互不覆盖。

`frpc` 配置了自动重连；Cluster 或 frps 短暂中断后，Server 不需要手工重启。
