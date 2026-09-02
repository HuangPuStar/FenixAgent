# FenixAgent 进阶部署指南

本目录以 `docker-compose.yml` 为主编排。先启动主编排，再按需启动独立的可选服务；远端 Sandbox 则需要先在主服务中配置为执行节点。

## 主服务

主编排文件：[docker-compose.yml](docker-compose.yml)。它当前包含 FenixAgent、PostgreSQL 和 Agent Sites，并创建供附加服务使用的 `fenix-ver-net` 网络。

```bash
cp docker/prod/.env.example docker/prod/.env
# 编辑 docker/prod/.env，至少设置 OPENAI_API_KEY、REGISTRY_SECRET、
# AGENT_SITES_MASTER_KEY 和 RCS_API_KEYS。
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d
```

主服务启动后，可通过 `docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml ps` 查看状态。

## 可选部署

| 能力 | 编排文件 | 启动前配置 | 启动命令 |
| --- | --- | --- | --- |
| 模型网关与配额治理（LiteLLM） | `docker-compose.litellm.yml` | 在主 `.env` 中设置 `LITELLM_MASTER_KEY`、`LITELLM_SALT_KEY`、`LITELLM_UI_PASSWORD`；并配置 Fenix 可访问的 `RCS_MODEL_GATEWAY_*` | `docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.litellm.yml up -d` |
| Agent 记忆（Hindsight） | `docker-compose.hindsight.yml` | 复制并填写 `.env.hindsight`；在主 `.env` 中设置 `HINDSIGHT_MCP_URL` | `docker compose --env-file docker/prod/.env.hindsight -f docker/prod/docker-compose.hindsight.yml up -d` |
| 知识库（RagFlow） | `docker-compose.ragflow.yml` | 复制并填写 `.env.ragflow`；在主 `.env` 中设置 RCS 容器可访问的 `RAGFLOW_API_URL` 与 `RAGFLOW_API_KEY` | `docker compose --env-file docker/prod/.env.ragflow -f docker/prod/docker-compose.ragflow.yml up -d` |

复制可选服务模板：

```bash
cp docker/prod/.env.hindsight.example docker/prod/.env.hindsight
cp docker/prod/.env.ragflow.example docker/prod/.env.ragflow
```

Hindsight 使用主编排创建的 `fenix-ver-net`，因此必须在主服务启动后再启动。LiteLLM 和 RagFlow 均为独立编排，主服务需要通过可路由地址访问它们；不要假设 `rcs` 容器可直接解析其服务名。

修改主 `.env` 中的 `HINDSIGHT_MCP_URL`、`RAGFLOW_API_URL` 或其他 RCS 配置后，重新创建 RCS 容器使其生效：

```bash
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d rcs
```

## 可选执行节点配置

### 使用 OpenCode Sandbox 替代本机节点

`docker-compose.opencode.yml` 中的 OpenCode Sandbox 用于替代 RCS 进程内的 `local-default` 节点，而不是与其并列增加一个执行节点。仅启动 Sandbox 不会改变 Agent 的默认路由；必须先在主服务 `.env` 中设置：

```dotenv
# 必须与 docker-compose.opencode.yml 中的 RCS_MACHINE_ID 相同。
RCS_DEFAULT_MACHINE_ID=mach_xxx
# 禁止 RCS 在主服务容器内执行 Agent。
RCS_DISABLE_LOCAL_EXECUTION=true
```

随后重新创建主服务，使默认 Machine 记录生效，再单独启动 Sandbox：

```bash
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d rcs
docker compose -f docker/prod/docker-compose.opencode.yml up -d
```

Sandbox 中的 `RCS_SECRET` 必须与主 `.env` 的 `REGISTRY_SECRET` 一致，`RCS_MACHINE_ID` 必须与 `RCS_DEFAULT_MACHINE_ID` 一致。这样未显式绑定 Machine 的 Agent 会被路由到 OpenCode Sandbox，而不会在主服务容器内运行。

### 使用其他 Sandbox 作为默认节点

CCB、DSH 和 Peri Sandbox 也可以像 OpenCode Sandbox 一样替代本机节点：在主 `.env` 中将 `RCS_DEFAULT_MACHINE_ID` 设置为该 Sandbox 的 `RCS_MACHINE_ID`，并设置 `RCS_DISABLE_LOCAL_EXECUTION=true`；重新创建 RCS 后再启动对应 Sandbox。默认节点由主服务自动创建，不需要预先在 Fenix 控制台创建 Machine。

### 动态接入执行节点

如需为特定 Agent 增加独立执行节点，先在 Fenix 控制台创建 Machine 并取得 `RCS_MACHINE_ID`，再以该 ID 启动 Sandbox，最后将目标 Agent 显式绑定到该 Machine。此方式是在默认节点之外增加可选执行节点，不影响未绑定 Agent 的默认路由。

### 执行隔离选择

OpenCode、CCB、DSH 与 Peri Sandbox 均是一个完整的共享沙盒执行节点：连接到同一节点的 Agent 在该沙盒环境中运行，彼此不做 Agent 或用户维度的隔离。它们适合开发、验证或信任边界一致的执行场景。

### 沙盒集群（OpenSandbox Cluster）

沙盒集群（OpenSandbox Cluster） 是独立的对接流程，不使用上述默认节点或动态 Machine 接入方式。它按用户提供细粒度的沙盒隔离，每个用户的 Agent 运行在独立隔离单元中。面向多用户或需要更强执行隔离的生产场景时，请参阅 [OpenSandbox Cluster 与 Fenix 集成指南](../opensandbox-cluster/deploy/fenix-integration.md)。

| 执行节点 | 部署入口 | 说明 |
| --- | --- | --- |
| OpenCode Sandbox | `docker/prod/docker-compose.opencode.yml` | 共享沙盒；可作为默认节点或动态节点接入。 |
| CCB Sandbox | [docker/sandbox-ccb/docker-compose.yml](../sandbox-ccb/docker-compose.yml) | 共享沙盒；可作为默认节点或动态节点接入。 |
| DSH Sandbox | [docker/sandbox-dsh/README.md](../sandbox-dsh/README.md) | 共享沙盒；DeepSeek Harness 通过 CCB 槽位接入。 |
| Peri Sandbox | [docker/sandbox-peri/docker-compose.yml](../sandbox-peri/docker-compose.yml) | 共享沙盒；可作为默认节点或动态节点接入。 |

切换默认 Sandbox 时，确认新节点已连接后再停止原节点，避免同一个 `RCS_MACHINE_ID` 重复连接。
