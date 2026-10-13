# sandbox-opencode — OpenCode 沙箱执行节点

把 [OpenCode](https://opencode.ai) 以 **docker 容器**形态接入 FenixAgent 的**执行节点（Machine）**：
容器内 `acp-runtime` 以 `AGENT_TYPE=opencode` 主动连主服务并注册机器，主服务把它当作 opencode 引擎槽位的节点
管理 Agent 生命周期、权限与会话。主服务、前端、权限链路不感知容器的存在。

- 引擎类型：**`opencode`**（`AGENT_TYPE=opencode`，`ENGINE_TYPES` 见 `apps/server/src/services/config/types.ts`）。
- 与 `docker/sandbox-dsh/` 的差别：dsh 是**伪装 ccb 槽位**（`AGENT_TYPE=ccb` + `RCS_CCB_COMMAND` 覆盖引擎命令），
  本目录是 opencode 的**原生槽位**，不做伪装。
- 与 `docker/sandbox-peri/`、`docker/sandbox-ccb/` 同族：都是执行节点目录，差别只在镜像内装的引擎。

## 工作原理

```text
RCS 主服务器                        sandbox-opencode 容器
┌──────────────────┐    ACP/WS   ┌────────────────────────────────────────┐
│ 按 opencode 槽位   │◄────────────│ bun /usr/local/bin/acp-runtime.js       │
│ 管理生命周期/会话   │             │   opencode acp  (AGENT_TYPE=opencode)  │
└──────────────────┘             │        │                               │
                                 │        ▼                               │
                                 │   opencode CLI（+ hindsight 插件）       │
                                 │   cwd = /app/workspaces                │
                                 └────────────────────────────────────────┘
```

- `acp-runtime.js` 在**镜像内**由本仓库 `packages/acp-runtime-cli` 构建（bundle 为独立 JS，不依赖 npm 发布的
  `@fenix-agent/acp-runtime-cli`），运行时只需镜像里的 `bun`。
- 工作目录固定 `/app/workspaces`（Dockerfile 的 `WORKDIR`，也是 acp-runtime 的 cwd）；agent 只能看到这个目录下的文件。
- 镜像预装：`opencode-ai@1.17.12`、hindsight 插件（`opencode plugin @konghayao/opencode-hindsight -g`）、
  `uv`/`uvx`、python3、git、ripgrep、jq、zip/unzip；npm registry 指向 npmmirror。
- **模型不在容器内配置**：主服务为 Agent 绑定模型后由 opencode handler 下发到工作区。

## 镜像构建与发布

本目录的 compose **只引用 CI 发布的镜像**（固定 tag、禁止环境变量插值，§13.7）：

```yaml
image: ghcr.io/huangpustar/fenixagent-sandbox-opencode:v0.7.0-beta.1-opencode
```

CI 发布链路（`.github/workflows/docker-publish-sandbox.yml`，matrix 项 `opencode`）：

| 项 | 值 |
| --- | --- |
| 镜像名 | `ghcr.io/<owner>/<repo 小写>-sandbox-opencode`（本仓库即 `ghcr.io/huangpustar/fenixagent-sandbox-opencode`） |
| tag（push `v*` tag） | `<v标签>-opencode`，如 `v0.4.0-beta.1-opencode` |
| tag（`workflow_dispatch` 指定非 `latest` 版本） | `<version>-opencode` |
| tag（其余情况） | `sha-<7 位短 SHA>-opencode` |
| 平台 | `linux/amd64`、`linux/arm64` |
| 构建参数 | `CACHE_BUST=<run_id>`（本 Dockerfile 未声明该 ARG，仅对 peri / ccb 生效） |

发布镜像有两个消费方：本目录的 compose（执行节点）与 OpenSandbox 集群（`RCS_DEFAULT_SANDBOX_IMAGE`，见
`docker/opensandbox-cluster/deploy/fenix-integration.md`）。

## 前置条件

- Docker + Compose v2（本目录可独立部署到一台专用机器，不要求本机有仓库其余部分）。
- 主服务已启动，且**该地址对本容器可达**（见「网络接入清单」）。
- 一个 `RCS_MACHINE_ID`：控制台预创建的 Machine；作为默认节点用时与主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`）的
  `RCS_DEFAULT_MACHINE_ID` 一致（见 `docs/operations/deployment.md`）。
- 首次 `up` 时若本目录下没有 `data/`，Docker 会自动创建（属主 root）。

## 配置

| 键 | 位置 | 说明 |
| --- | --- | --- |
| `RCS_URL` | 本目录 `.env`（模板 `.env.example`） | 必填。主服务的 WS 地址，如 `ws://192.168.1.10:3001`；缺省由 `docker/deploy.sh` 注入 `ws://rcs:3000`（同机语义，依赖 `fenix-server` 的 DNS，见下） |
| `RCS_SECRET` | 同上 | 必填。注册用共享密钥，取值必须等于主服务侧的 `REGISTRY_SECRET`（两份主服务编排——dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`——都注明它是「与 sandbox / 控制台共享的密钥」）。随主服务启动时由 `docker/deploy.sh` 自动派生（本目录 `.env` ＞ 主服务 env 的 `RCS_SECRET` ＞ `REGISTRY_SECRET`，见 `docker/lib/config.sh`），无需手填；独立部署时手填同值 |
| `RCS_MACHINE_ID` | 同上 | 必填。机器 ID，空值同样视为缺失（compose 用 `${VAR:?}`） |
| `TZ` | 同上 | 可调，默认 `Asia/Shanghai`（compose 写 `${TZ:-Asia/Shanghai}`） |
| `AGENT_TYPE` | 镜像 `ENV`（不可在 `.env` 改） | `opencode`。改了会让主服务按错误的槽位管理 Agent |
| `FENIX_FEATURE_SANDBOX_OPENCODE` | `docker/deploy.env` | 是否随主服务一键启动本节点（`true` 才启动） |

其余可选键（`RCS_TENANT_ID` / `RCS_USER_ID` / `RCS_LABELS` / `RCS_MACHINE_NAME` 等）由容器内 `acp-runtime`
读取，本目录的 `.env.example` 不声明；需要时在 compose 的 `environment:` 里显式加。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `sandbox-opencode` | 是 | 节点是主动出网的一方（容器内 `acp-runtime` 作为 WS 客户端连 `RCS_URL`，不需要被反向访问），但**要按服务名连主服务**：同机一键启动时脚本注入 `ws://rcs:3000`，`rcs` 只在 `fenix-server` 内可解析。因此声明 `networks: [fenix-server]`（`external: true`）。代价是该网络内的 `postgres` / `redis` 对本容器也可达——节点跑的是自家 agent 运行时，接受这一条；若要完全隔离，见下。 |

**不发布宿主端口**：容器只出网（compose 里没有 `ports:`）。调试用
`docker compose -f docker/sandbox-opencode/docker-compose.yml exec sandbox-opencode bash`。

**独立节点机器**（本机没有平台）：网络名不会被谁创建，先执行 `docker network create fenix-server`
（只为名字解析，不引入额外服务），或在 `.env` 填宿主可达的 `RCS_URL`（如 `ws://192.168.1.10:3001`）
并删掉 compose 里的 `networks` 段——后者更彻底地隔离，代价是 `RCS_URL` 必须手工维护且随主服务端口变化。

## 数据与挂载

| 宿主路径 | 容器路径 | 说明 |
| --- | --- | --- |
| 本目录 `./data/workspaces/` | `/app/workspaces` | 工作区（Dockerfile 的 `WORKDIR`，也是 acp-runtime 的 cwd）。bind 挂载，随交付目录整体搬迁/备份；`docker compose down` 不删数据 |
| 本目录 `./data/opencode-config/` | `/root/.config/opencode` | opencode 全局配置；沿用退役 prod 编排的挂载，改为本目录 `./data/` 下 |
| 本目录 `./data/opencode-data/` | `/root/.local/share/opencode` | opencode 运行期状态（登录态、缓存）；不挂则容器重建即丢 |

## 验证

```bash
# 1. 配置解析：不启动容器、不构建镜像（用行内测试值满足 ${VAR:?}）
RCS_URL=ws://rcs:3000 RCS_SECRET=x RCS_MACHINE_ID=mach_x \
  docker compose -f docker/sandbox-opencode/docker-compose.yml config

# 2. 启动并看日志
docker compose -f docker/sandbox-opencode/docker-compose.yml up -d
docker compose -f docker/sandbox-opencode/docker-compose.yml logs -f
```

日志预期（关键行）：

```text
RCS 在线 (ws://…)                              # 主服务可达
启动 ACP Runtime 节点...
  Agent Type:   opencode
  Workspace:    /app/workspaces (cwd)
[acp-client] registered successfully, machineId: mach_…
```

失败时的典型日志：`RCS (ws://…) 未响应，请先启动 RCS`（地址不可达）、
`[acp-client] disconnected (…), reconnecting in …ms`（密钥或机器 ID 不对）。控制台「执行节点」页应显示该机器在线。

## 升级

```bash
# 有新发布 tag 时：改本目录 compose 的 image 行 → 拉取 → 重启
docker compose -f docker/sandbox-opencode/docker-compose.yml pull
docker compose -f docker/sandbox-opencode/docker-compose.yml up -d

# 改了 Dockerfile（opencode-ai@<版本> 等）要自建时：在仓库根构建同 tag 镜像，再 up
docker build --no-cache \
  -f docker/sandbox-opencode/Dockerfile \
  -t ghcr.io/huangpustar/fenixagent-sandbox-opencode:v0.7.0-beta.1-opencode .
docker compose -f docker/sandbox-opencode/docker-compose.yml up -d
```

- 工作区数据在 `./data/workspaces`，重建容器不影响。
- 引擎版本写在 Dockerfile（当前 `opencode-ai@1.17.12`）：升级即改这一行。
- 镜像里 hindsight 插件经 npm 安装（`@konghayao/opencode-hindsight`，未写版本号），而 Dockerfile 没有
  peri / ccb 那样的 `CACHE_BUST` 参数：Docker 层缓存看不见远端包的变化，命令串不变就会复用旧层。
  **自建时用 `--no-cache`**（或后续给该 RUN 加上 `ARG CACHE_BUST` 对齐 peri / ccb）；
  自建会占用发布 tag 的本地镜像，需要回到发布版本时 `docker compose … pull` 覆盖回来。

## 已知限制

- **单容器多会话共享**：连到同一节点的 Agent 共用这个沙箱，不做 Agent 或用户维度的隔离（信任边界一致的场景才适用）。
- **`/app/workspaces` 属主为 root**：容器以 root 运行，工作区里新建的文件属主是 root；需要非 root 属主时自行调整镜像用户。
