# OpenSandbox Server tunnel 部署

本目录用于以 tunnel 模式启动 OpenSandbox Server。Server 内的 `frpc` 会主动连接 Cluster 的 `frps`，因此 Server 不需要向 Cluster 提供入站端口，也不会发布 Server 管理端口或沙盒端口。

## 准备配置

1. 在 Cluster 创建 tunnel Server，或将已停止的 direct Server 切换为 tunnel。
2. 从 Cluster 下载该 Server 专属的配置：

   ```bash
   ./fenix-sandbox-ops.sh cluster server tunnel \
     <server-id> /path/to/aos-sandbox/docker/opensandbox-server-tunnel/frpc.toml
   ```

   对新建的 tunnel Server，创建时传入 `transport_mode=tunnel`；对已有 direct Server，必须先停止 Server，再执行上述命令。
3. 准备本目录下的 `sandbox.toml`、`workspace/`、`offline/` 和 `data/`。可以参考上级 Server 目录中的 `sandbox.toml.example`。

`frpc.toml` 含有 Server 的隧道凭证，不要提交到 Git；文件权限应为 `0600` 或更严格。

## 启动与停止

在本目录执行：

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f opensandbox-server
docker compose stop
```

Compose 使用独立的 project 和 `docker-data` volume，不会覆盖 `docker/opensandbox-server` 下的 direct/dind 部署。Server 只需要能够访问 `${FRP_PUBLIC_ADDRESS}:${FRP_BIND_PORT}`。

`frpc` 配置了自动重连；Cluster 或 frps 短暂中断后，Server 不需要手工重启。
