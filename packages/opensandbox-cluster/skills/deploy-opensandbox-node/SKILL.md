---
name: deploy-opensandbox-node
description: 在目标机器上用 Docker 启动 OpenSandbox Server，并注册到 OpenSandbox Cluster 资源池。用于部署执行节点、接入机器、添加节点，支持 direct 直连和 frpc 隧道。
---

# 部署并接入 OpenSandbox 节点

完成目标机器部署、Cluster 注册及健康验证。节点使用镜像 `ghcr.io/huangpustar/fenixagent-opensandbox-server:v0.2.0`，通过容器内独立 Docker daemon 运行沙盒。

## 1. 确定目标与参数

先检查用户已给的信息和可用配置，只询问缺失项：

- 目标机器的执行入口（本机终端、SSH 或已有远程工具）、持久化部署目录。
- `CLUSTER_URL`、`CLUSTER_SERVICE_API_KEY`、目标 `POOL_ID`、唯一 `SERVER_ID`。
- 连接方式：Cluster 能访问节点入站端口时用 direct；节点仅能出站时用 tunnel，节点 frpc 主动连接 Cluster 的 frps。
- 容量：数量池使用 `max_sandboxes`；资源池使用 CPU 核数（可小数）、内存 MB、硬盘 GB、GPU 数量。优先探测机器资源，再确认可分配预算，不把整机容量直接当成空闲预算。

调用 `GET /api/v1/pools/{poolId}` 读取 `schedulingMode`，`GET /api/v1/servers/{serverId}` 检查已有注册。存在时核实归属和配置，避免重复创建或覆盖已有部署。没有合适资源池时，按用户要求通过 `POST /api/v1/pools` 创建；参数见 `{CLUSTER_URL}/openapi` 或 `/openapi/json`。

所有 Cluster 请求使用 `Authorization: Bearer <CLUSTER_SERVICE_API_KEY>`。节点的 `NODE_API_KEY` 是另一把密钥，写入节点配置并用于注册。密钥从用户提供的环境或安全文件读取，不写进回复、命令跟踪或 Git。

## 2. 检查机器并准备文件

在目标机器验证 Docker Engine、Compose v2 ≥ 2.20、可用端口及磁盘空间。部署需要 `privileged` 和 `cgroup: host`；权限不足时说明缺什么，不擅自重启 Docker 或修改主机安全配置。

读取 [部署文件与网络说明](references/deployment.md)，将本 Skill 的以下文件复制到目标部署目录：

- `assets/compose.yaml`
- `assets/direct.yaml` 或 `assets/tunnel.yaml`
- `assets/sandbox.toml.example` → `sandbox.toml`

这些模板可独立部署，不要求目标机器运行 FenixAgent 主服务。

配置 `sandbox.toml`：

1. `server.api_key` 设置独立随机节点密钥，可用 `openssl rand -hex 32` 生成；保留在权限受限文件中。
2. direct 的 `docker.host_ip` 使用节点及 Cluster 可达的机器 IP；tunnel 可使用节点容器内回环地址 `127.0.0.1`。
3. `storage.allowed_host_paths` 与容器挂载路径、注册的 `workspace_root` 保持为 `/workspace`。
4. direct 的端口段须与 `direct.yaml` 一致；占用时成套调整配置与端口映射。

使用 `umask 077` 创建配置，创建 `data/docker`、`data/opensandbox`、`workspace`、`offline` 目录。不要将宿主机 `/var/run/docker.sock` 挂载到节点。

## 3. 注册并启动

完整注册字段、direct/tunnel 的先后顺序见 [部署文件与网络说明](references/deployment.md)。

- **direct**：先启动节点，验证 `/health`，再注册 `base_url`。地址必须从 Cluster 所在网络可达，不能用目标机器的 localhost 代替跨机地址。
- **tunnel**：先注册 `transport_mode=tunnel`，下载该节点的 `frpc.toml` 到部署目录，设置权限 `0600`，再启动节点。Cluster/frps 须已部署且登录端口可达。

注册使用 `POST /api/v1/servers`，JSON 中的 `api_key` 与 `sandbox.toml` 一致。用 `jq --arg` 或结构化 HTTP 客户端生成包含密钥的 JSON，避免手工拼接。请求结果未知时先按 `SERVER_ID` 查询，不换 ID 重复注册。

不要因为接入失败而改动 Cluster、frps 或其他现有节点。只有用户明确要求迁移已有节点连接模式时，才执行迁移流程。

## 4. 验证与交付

1. `docker compose ... ps` 确认节点 healthy。
2. `POST /api/v1/servers/{serverId}/health-check`，再 `GET /api/v1/servers/{serverId}` 确认 `healthStatus=healthy`。
3. 资源池用 `GET /api/v1/servers/{serverId}/resources` 核对四维容量；数量池核对 `maxSandboxes`。
4. tunnel 未连通时检查目标机器到 frps 的出站连通性、`frpc.toml` 权限和节点日志；direct 检查 API 地址、端口、节点密钥及路由。读取日志时脱敏。

完成后给出池 ID、节点 ID、连接方式、容量、健康结果、部署目录和启动/停止命令。失败时保留诊断信息，说明已完成哪一步及是否留下注册或容器；不删除不属于本次任务的数据。
