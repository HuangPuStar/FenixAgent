# sandbox-peri — Peri 沙箱执行节点

把 [Peri](https://github.com/konghayao/peri)（`peri` CLI）以 **docker 容器**形态接入 FenixAgent 的
**执行节点（Machine）**：容器内 `acp-runtime` 以 `AGENT_TYPE=peri` 主动连主服务并注册机器，主服务把它当作
peri 引擎槽位的节点管理 Agent 生命周期、权限与会话。

- 引擎类型：**`peri`**（`AGENT_TYPE=peri`，`ENGINE_TYPES` 见 `apps/server/src/services/config/types.ts`）。
- **peri 原生节点**：走 peri handler（workspace 物化由它完成，`.peri/settings.json` 无条件写出），
  不需要 `IS_PERI`，也不需要 dsh 那种 `RCS_CCB_COMMAND` / `RCS_CCB_ARGS` 伪装。
- 与同族目录的差别只在镜像里装的引擎：`docker/sandbox-opencode/`（opencode 原生槽位）、
  `docker/sandbox-ccb/`（真正的 ccb/Claude Code Bridge）、`docker/sandbox-dsh/`（DeepSeek Harness 伪装 ccb 槽位）。

## 工作原理

```text
RCS 主服务器                        sandbox-peri 容器
┌──────────────────┐    ACP/WS   ┌────────────────────────────────────────┐
│ 按 peri 槽位       │◄────────────│ bun /usr/local/bin/acp-runtime.js       │
│ 管理生命周期/会话   │             │   peri acp  (AGENT_TYPE=peri)          │
└──────────────────┘             │        │                               │
                                 │        ▼                               │
                                 │   peri CLI（/opt/.peri-binary）         │
                                 │   cwd = /app/workspaces                │
                                 └────────────────────────────────────────┘
```

- `acp-runtime.js` 在**镜像内**由本仓库 `packages/acp-runtime-cli` 构建（bundle 为独立 JS），运行时只需 `bun`。
- peri CLI 由官方 `install.sh` 装进 `/opt/.peri-binary` 并注入 `PATH`；hindsight 记忆插件
  （`KonghaYao/hindsight-plugin` → `hindsight-memory`）与 `@peri-code/workflow`（ultracode 依赖）
  **在镜像构建期装好**，随镜像固化。
- 模型不在容器内配置：主服务为 Agent 绑定模型后由 peri handler 下发。

## 镜像构建与发布

本目录的 compose **从源码构建**（`build: context ../../ + dockerfile docker/sandbox-peri/Dockerfile`），
**不使用 CI 发布的镜像**。

CI 发布链路（`.github/workflows/docker-publish-sandbox.yml`，matrix 项 `peri`）：

| 项 | 值 |
| --- | --- |
| 镜像名 | `ghcr.io/<owner>/<repo 小写>-sandbox-peri`（本仓库即 `ghcr.io/huangpustar/fenixagent-sandbox-peri`） |
| tag（push `v*` tag） | `<v标签>-peri`，如 `v0.4.0-beta.1-peri` |
| tag（`workflow_dispatch` 指定非 `latest` 版本） | `<version>-peri` |
| tag（其余情况） | `sha-<7 位短 SHA>-peri` |
| 平台 | `linux/amd64`、`linux/arm64` |
| 构建参数 | `CACHE_BUST=<run_id>` |

`CACHE_BUST` 的意义：hindsight 插件内容由远端仓库默认分支决定，Docker 层缓存看不见它——命令串不变就会复用旧层，
于是「重建镜像以拿到新插件」会静默装回旧版本。CI 每次构建都传入，手工构建时按下面的「升级」一节处理。
发布镜像的消费方是 OpenSandbox 集群（`RCS_DEFAULT_SANDBOX_IMAGE` + `RCS_DEFAULT_SANDBOX_AGENT_TYPE=peri`，
见 `docker/opensandbox-cluster/deploy/fenix-integration.md`）。

## 前置条件

- Docker + Compose v2（本目录可独立部署到一台专用机器）。
- 主服务已启动，且**该地址对本容器可达**（见「网络接入清单」）。
- 一个 `RCS_MACHINE_ID`：控制台预创建的 Machine；作为默认节点用时与主服务根 `.env` 的
  `RCS_DEFAULT_MACHINE_ID` 一致。
- 首次 `up` 时若本目录下没有 `data/`，Docker 会自动创建（属主 root）。

## 配置

| 键 | 位置 | 说明 |
| --- | --- | --- |
| `RCS_URL` | 本目录 `.env`（模板 `.env.example`） | 必填。主服务的 WS 地址，如 `ws://192.168.1.10:3001`；缺省由 `docker/deploy.sh` 注入 `ws://rcs:3000`（同机语义，依赖 `fenix-server` 的 DNS，见下） |
| `RCS_SECRET` | 同上 | 必填。注册用共享密钥，取值必须等于主服务侧的 `REGISTRY_SECRET`（顶层 `docker-compose.yml` 注明它是「与 sandbox / 控制台共享的密钥」）。随主服务启动时由 `docker/deploy.sh` 自动派生（本目录 `.env` ＞ 根 `.env` 的 `RCS_SECRET` ＞ `REGISTRY_SECRET`，见 `docker/lib/config.sh`），无需手填；独立部署时手填同值 |
| `RCS_MACHINE_ID` | 同上 | 必填。机器 ID，空值同样视为缺失（compose 用 `${VAR:?}`） |
| `TZ` | 同上 | 可调，默认 `Asia/Shanghai`（compose 写 `${TZ:-Asia/Shanghai}`） |
| `AGENT_TYPE` | 镜像 `ENV`（不可在 `.env` 改） | `peri`。改了会让主服务按错误的槽位管理 Agent |
| `FENIX_FEATURE_SANDBOX_PERI` | `docker/deploy.env` | 是否随主服务一键启动本节点（`true` 才启动） |

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `sandbox-peri` | 是 | 节点是主动出网的一方（容器内 `acp-runtime` 作为 WS 客户端连 `RCS_URL`，不需要被反向访问），但**要按服务名连主服务**：同机一键启动时脚本注入 `ws://rcs:3000`，`rcs` 只在 `fenix-server` 内可解析。因此声明 `networks: [fenix-server]`（`external: true`）。代价是该网络内的 `postgres` / `redis` 对本容器也可达——节点跑的是自家 agent 运行时，接受这一条；若要完全隔离，见下。 |

**不发布宿主端口**：容器只出网（compose 里没有 `ports:`）。调试用
`docker compose -f docker/sandbox-peri/docker-compose.yml exec sandbox-peri bash`。

**独立节点机器**（本机没有平台）：网络名不会被谁创建，先执行 `docker network create fenix-server`
（只为名字解析，不引入额外服务），或在 `.env` 填宿主可达的 `RCS_URL`（如 `ws://192.168.1.10:3001`）
并删掉 compose 里的 `networks` 段——后者更彻底地隔离，代价是 `RCS_URL` 必须手工维护且随主服务端口变化。

## 数据与挂载

| 宿主路径 | 容器路径 | 说明 |
| --- | --- | --- |
| 本目录 `./data/peri-home/` | `/root/.peri` | peri 全局目录（CLI 级配置与状态）。随交付目录整体搬迁/备份 |
| `../../workspaces`（仓库根） | `/app/workspaces` | 工作区。**本地开发语义**：让 file API / 前端文件面板与容器内 agent 看到同一份文件 |

`../../workspaces` 的语义随交付面变化，这是它与「独立节点机器」的差异：

- **同机本地开发**（本仓库就在这台机器上）：指向仓库根的 `workspaces/`，与源码运行的主服务共享同一份文件。
- **独立节点机器**：该相对路径落在**这台机器上 compose 文件所在目录**的相对位置——若整仓交付，就是该机仓库根的
  `workspaces/`；若只交付 `docker/` 目录，就成了交付目录里的 `workspaces/`（不存在时 Docker 自动创建）。
  建议改成该机器自己的路径：绝对路径（如 `/srv/fenix/workspaces`）或本目录的 `./data/workspaces`，
  避免工作区位置随交付面的形状漂移。
- 容器以 root 运行，工作区里新建的文件属主是 root。

## 验证

```bash
# 1. 配置解析：不启动容器、不构建镜像（用行内测试值满足 ${VAR:?}）
RCS_URL=ws://rcs:3000 RCS_SECRET=x RCS_MACHINE_ID=mach_x \
  docker compose -f docker/sandbox-peri/docker-compose.yml config

# 2. 启动并看日志
docker compose -f docker/sandbox-peri/docker-compose.yml up -d
docker compose -f docker/sandbox-peri/docker-compose.yml logs -f
```

日志预期（关键行）：

```text
RCS 在线 (ws://…)                              # 主服务可达
启动 ACP Runtime 节点...
  Agent Type:   peri
  Workspace:    /app/workspaces (cwd)
[acp-client] registered successfully, machineId: mach_…
```

失败时的典型日志：`RCS (ws://…) 未响应，请先启动 RCS`（地址不可达）、
`[acp-client] disconnected (…), reconnecting in …ms`（密钥或机器 ID 不对）。控制台「执行节点」页应显示该机器在线。

## 升级

```bash
# 1. 改 Dockerfile 里的版本（peri CLI 安装源、@peri-code/workflow 等）后重建并重启
docker compose -f docker/sandbox-peri/docker-compose.yml build --build-arg CACHE_BUST=$(date +%s)
docker compose -f docker/sandbox-peri/docker-compose.yml up -d
```

- 工作区与 peri 全局目录都在宿主 `./data/` 与 `../../workspaces`，重建容器不影响数据。
- peri CLI 由官方 `install.sh` 安装（当前不带版本参数，取默认分支产物）：升级 peri 必须
  `--build-arg CACHE_BUST=…` 或 `--no-cache`，否则会静默复用旧层（见上「镜像构建与发布」）。
- 升级后按「验证」一节回归：节点上线、模型下发、会话可用。

## 已知限制

- **单容器多会话共享**：连到同一节点的 Agent 共用这个沙箱，不做 Agent 或用户维度的隔离。
- **镜像即交付面**：hindsight 插件随镜像固化（不在 `./data` 里），要换插件版本必须重建镜像。
