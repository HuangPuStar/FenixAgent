# sandbox-ccb — CCB 沙箱执行节点

把 **CCB（Claude Code Bridge，npm `claude-code-best`）** 以 **docker 容器**形态接入 FenixAgent 的
**执行节点（Machine）**：容器内 `acp-runtime` 以 `AGENT_TYPE=ccb` 主动连主服务并注册机器，主服务按
**ccb 槽位**（`createCcbHandler()`）管理 Agent 生命周期、权限与会话，引擎命令是镜像里的 `ccb --acp`。

- 引擎类型：**`ccb`**（`AGENT_TYPE=ccb`，`ENGINE_TYPES` 见 `apps/server/src/services/config/types.ts`；
  该数组里另有 `claude-code`，本镜像不使用它）。
- **与 `docker/sandbox-dsh/` 同名不同实**：dsh 也注册为 `AGENT_TYPE=ccb`，但它靠
  `RCS_CCB_COMMAND=node` + `RCS_CCB_ARGS=/usr/local/bin/dsh-acp-wrapper.js` 把 ccb 槽位指向自己的 wrapper
  （伪装）。本目录**不设这两个键**，跑的是真正的 ccb。两者在主服务看来都是 ccb 槽位的机器，靠
  `RCS_MACHINE_ID` 区分，可各部署一台。
- 与 `docker/sandbox-opencode/`、`docker/sandbox-peri/` 同族：差别只在镜像里装的引擎。

## 工作原理

```text
RCS 主服务器                        sandbox-ccb 容器
┌──────────────────┐    ACP/WS   ┌────────────────────────────────────────┐
│ 按 ccb 槽位        │◄────────────│ bun /usr/local/bin/acp-runtime.js       │
│ 管理生命周期/会话   │             │   ccb --acp  (AGENT_TYPE=ccb)          │
└──────────────────┘             │        │                               │
                                 │        ▼                               │
                                 │   ccb CLI（claude-code-best）           │
                                 │   cwd = /app/workspaces                │
                                 └────────────────────────────────────────┘
```

- `acp-runtime.js` 在**镜像内**由本仓库 `packages/acp-runtime-cli` 构建（bundle 为独立 JS），运行时只需 `bun`。
- ccb handler 在 `prepareWorkspace` 阶段把 Agent 的模型配置写进工作区（`.claude/settings.local.json`、
  `CLAUDE.md`），再启动引擎——**模型不在容器内配置**。
- 镜像预装：`claude-code-best@2.8.1`、hindsight 记忆插件（`ccb plugin marketplace add KonghaYao/hindsight-plugin`
  → `install hindsight-memory`，构建期装入、随镜像固化）、python3、git、ripgrep、jq、zip/unzip；
  npm registry 指向 npmmirror。（与同族的 opencode / peri 镜像不同，本镜像**没有** `uv`/`uvx`。）

## 镜像构建与发布

本目录的 compose **从源码构建**（`build: context ../../ + dockerfile docker/sandbox-ccb/Dockerfile`），
**不使用 CI 发布的镜像**。

CI 发布链路（`.github/workflows/docker-publish-sandbox.yml`，matrix 项 `ccb`）：

| 项 | 值 |
| --- | --- |
| 镜像名 | `ghcr.io/<owner>/<repo 小写>-sandbox-ccb`（本仓库即 `ghcr.io/huangpustar/fenixagent-sandbox-ccb`） |
| tag（push `v*` tag） | `<v标签>-ccb`，如 `v0.4.0-beta.1-ccb` |
| tag（`workflow_dispatch` 指定非 `latest` 版本） | `<version>-ccb` |
| tag（其余情况） | `sha-<7 位短 SHA>-ccb` |
| 平台 | `linux/amd64`、`linux/arm64` |
| 构建参数 | `CACHE_BUST=<run_id>` |

`CACHE_BUST` 的意义：hindsight 插件内容由远端仓库默认分支决定，Docker 层缓存看不见它——命令串不变就会复用旧层，
于是「重建镜像以拿到新插件」会静默装回旧版本。CI 每次构建都传入，手工构建时按「升级」一节处理。

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
| `AGENT_TYPE` | 镜像 `ENV`（不可在 `.env` 改） | `ccb`。改了会让主服务按错误的槽位管理 Agent |
| `FENIX_FEATURE_SANDBOX_CCB` | `docker/deploy.env` | 是否随主服务一键启动本节点（`true` 才启动） |
| `RCS_CCB_COMMAND` / `RCS_CCB_ARGS` | 未使用 | ccb 槽位的引擎命令覆盖键（dsh 用它做伪装）。本目录不声明，引擎命令取自镜像 `CMD`（`ccb --acp`） |

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `sandbox-ccb` | 是 | 节点是主动出网的一方（容器内 `acp-runtime` 作为 WS 客户端连 `RCS_URL`，不需要被反向访问），但**要按服务名连主服务**：同机一键启动时脚本注入 `ws://rcs:3000`，`rcs` 只在 `fenix-server` 内可解析。因此声明 `networks: [fenix-server]`（`external: true`）。代价是该网络内的 `postgres` / `redis` 对本容器也可达——节点跑的是自家 agent 运行时，接受这一条；若要完全隔离，见下。 |

**不发布宿主端口**：容器只出网（compose 里没有 `ports:`）。调试用
`docker compose -f docker/sandbox-ccb/docker-compose.yml exec sandbox-ccb bash`。

**独立节点机器**（本机没有平台）：网络名不会被谁创建，先执行 `docker network create fenix-server`
（只为名字解析，不引入额外服务），或在 `.env` 填宿主可达的 `RCS_URL`（如 `ws://192.168.1.10:3001`）
并删掉 compose 里的 `networks` 段——后者更彻底地隔离，代价是 `RCS_URL` 必须手工维护且随主服务端口变化。

## 数据与挂载

| 宿主路径 | 容器路径 | 说明 |
| --- | --- | --- |
| 本目录 `./data/workspaces/` | `/app/workspaces` | 工作区；ccb handler 写下的 `.claude/settings.local.json` 与 `CLAUDE.md` 也在其中。bind 挂载，随交付目录整体搬迁/备份 |

镜像里 ccb 的插件随镜像固化；运行期若在 HOME 下写状态（登录态、缓存等）容器重建会丢，见「已知限制」。

## 验证

```bash
# 1. 配置解析：不启动容器、不构建镜像（用行内测试值满足 ${VAR:?}）
RCS_URL=ws://rcs:3000 RCS_SECRET=x RCS_MACHINE_ID=mach_x \
  docker compose -f docker/sandbox-ccb/docker-compose.yml config

# 2. 启动并看日志
docker compose -f docker/sandbox-ccb/docker-compose.yml up -d
docker compose -f docker/sandbox-ccb/docker-compose.yml logs -f
```

日志预期（关键行）：

```text
RCS 在线 (ws://…)                              # 主服务可达
启动 ACP Runtime 节点...
  Agent Type:   ccb
  Workspace:    /app/workspaces (cwd)
[acp-client] registered successfully, machineId: mach_…
```

失败时的典型日志：`RCS (ws://…) 未响应，请先启动 RCS`（地址不可达）、
`[acp-client] disconnected (…), reconnecting in …ms`（密钥或机器 ID 不对）。控制台「执行节点」页应显示该机器在线。

## 升级

```bash
# 1. 改 Dockerfile 里的版本（claude-code-best@<版本>）后重建并重启
docker compose -f docker/sandbox-ccb/docker-compose.yml build --build-arg CACHE_BUST=$(date +%s)
docker compose -f docker/sandbox-ccb/docker-compose.yml up -d
```

- 工作区数据在本目录 `./data/workspaces`，重建容器不影响。
- `--build-arg CACHE_BUST=…`（或 `--no-cache`）是必要的：hindsight 插件来自远端仓库，
  否则「重建以拿到新插件」会静默复用旧层。
- 升级后按「验证」一节回归：节点上线、模型下发、会话可用。

## 已知限制

- **单容器多会话共享**：连到同一节点的 Agent 共用这个沙箱，不做 Agent 或用户维度的隔离。
- **只持久化工作区**：镜像里 ccb 的插件在构建期装入、随镜像固化；运行期在 HOME 下写的状态（登录态、缓存、会话记录等）
  容器重建会丢失。**不整体补挂 `./data/…`**：插件装在 HOME 的 `.claude` 下，整体 bind 会把镜像里已固化的插件盖掉；
  确需保留某一类状态时，应针对该子目录单独挂载，不要挂整个 HOME。
- **与 dsh 节点同槽位**：两者都以 `AGENT_TYPE=ccb` 注册，同一台主服务上并存时务必用不同的
  `RCS_MACHINE_ID`，并按镜像区分用途。
