# `docker/dev/` —— 本地开发的可选组件

默认只起 `postgres` + `rcs`（都在仓库根 `docker-compose.yml` 里）。本目录是**其余组件**的编排，
每个组件一份 `docker-compose.<组件>.yml`，由根文件用 `include:` 复制进**同一个项目**（`fenix`）与
同一张网络（`fenix-server`），用 `--profile <组件名>` 启动。

**这里没有 `docker-compose.yml`，也没有任何 `.env` 文件**——这两点是刻意的：

- 前者会让 `docker/deploy.sh` 与 `scripts/generate-env-example.ts` 的目录发现把它当成一个「依赖目录」
  （它们只认精确文件名 `docker/<dir>/docker-compose.yml`）；
- 后者不必要：组件的每个键都写成 `${VAR:-默认值}` 内联在编排里，想改就在**仓库根 `.env`** 写同名键。

权威文档：`docs/operations/docker-topology.md`。

## 命令

> **前置**：仓库根 `cp .env.example .env` 并为 `RCS_API_KEYS` 填入随机值（只有主服务需要这一步，与仓库根
> `README.md` 的口径一致）——`rcs` 里写的是 `${RCS_API_KEYS:?}`（无默认值），插值先于 profile 过滤，缺它连
> `docker compose config` 都过不去。

```bash
docker compose up -d                                        # postgres + rcs
docker compose --profile redis up -d                        # 加缓存（另需在仓库根 .env 写 RCS_REDIS_URL=redis://redis:6379）
docker compose --profile litellm --profile ragflow up -d    # 加两套组件
docker compose stop litellm litellm-postgres                # 停单组（容器留着）；要连容器一起删用 rm -sf
docker compose config                                       # 只解析、不起容器，随时可跑
```

> `--profile <组件> down` **不是**「只停那一组」：`down` 作用于**整个项目**，实测会连 `postgres` / `rcs`
> 一起停掉（本机实测：`--profile opt down` 把无 profile 的服务也移除了）。要停单组就点名服务名。

组件名（`--profile` 的取值）：`redis`、`litellm`、`ragflow`、`hindsight`、`agent-sites`、`opensandbox`。

## 准备

只有三项：

1. 主服务的 `RCS_API_KEYS`：仓库根 `cp .env.example .env` 后，在**仓库根 `.env`** 里填入随机值（`rcs` 里写的是
   `${RCS_API_KEYS:?}`，无默认值；插值先于 profile 过滤，缺它连 `docker compose config` 都过不去）。
2. hindsight 的模型 Key：在**仓库根 `.env`** 里填 `DASHSCOPE_API_KEY`（阿里云百炼 Key）。
3. opensandbox 的节点配置（`host_ip` 依赖机器与组网形态；模板给的是 macOS / Windows 桌面 Docker 的取值，
   Linux 或跨机组网需按模板注释改这一项）：

```bash
cp docker/dev/sandbox.toml.example docker/dev/sandbox.toml
```

其余组件 `git clone` 后直接可用。默认值只服务本地、**不安全**，生产必须覆盖。

> **界面入口**：litellm 控制台的平台入口（`RCS_MODEL_GATEWAY_ADMIN_UI_URL`）**没有**在 dev 编排里给值——
> `.env.example` 的默认形状是 `http://localhost:4000/ui/`，与本编排的 `/litellm` 前缀不符，照抄会指向错误路径，
> 故不预置。要用控制台就直接访问 <http://127.0.0.1:4000/litellm/ui>；要让 rcs 侧也拿到入口，在仓库根 `.env`
> 里自己写一个正确的值。

## 密钥不要写进本目录

本目录的所有文件都进版本控制，所以这里的取值全是本地假值。要改就写**仓库根 `.env`**（被 `.gitignore`
忽略），**不要改本目录这些行**——两者效果相同，但只有前者不会被推上去。

唯一必须填**真值**的是 `DASHSCOPE_API_KEY`。它的默认值是**空**，不是假 Key：compose 里因此没有
「可填真值的形状」，不会有人顺手填在这里然后推上去；不填的后果是 hindsight 启动即报缺少 API Key，
而不是拿着假 Key 去撞 401。

为什么不干脆把所有键都写成 `${VAR:?}` 必填（那样 compose 里连空位都没有）？因为**插值发生在 profile
过滤之前**：任何一个可选组件里的必填项，都会让 `docker compose config` 乃至「只起 rcs」的 `up -d` 直接
失败（已实测）。内联默认值是「可选组件不拖累默认启动」的唯一形态。

## 可覆盖的键

**组件**的全部键都能在仓库根 `.env` 里写同名键覆盖。下表是完整清单（默认值只服务本地、不安全）。
**主服务自身**的键不在本目录：`RCS_*`、`POSTGRES_PASSWORD` 等在仓库根 `.env.example` 里有注释形式的条目
（那份模板是生成物，不要手改）；`FENIX_HTTP_PORT` / `POSTGRES_PORT` **不在**模板里——它们只内联在仓库根
`docker-compose.yml`，因为 dev 根编排已移出部署面 env 发现范围。要改这两个，直接在仓库根 `.env` 写同名键。

### litellm

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `LITELLM_MASTER_KEY` | `litellm-master-key-123` | 网关管理密钥；rcs 侧用同一插值键自动同值 |
| `LITELLM_SALT_KEY` | `litellm-salt-key-123` | 库内 Provider 凭据的加密盐，换值后已有凭据解不开 |
| `LITELLM_DB_PASSWORD` | `litellm123` | `litellm-postgres` 的口令 |
| `LITELLM_UI_PASSWORD` | `admin123` | 管理控制台口令（账号 `admin`） |
| `LITELLM_PORT` | `4000` | 宿主回环端口 |

入口：控制台 <http://127.0.0.1:4000/litellm/ui>；平台基址 `http://litellm:4000/litellm`。

### ragflow

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `RAGFLOW_MYSQL_PASSWORD` | `ragflow123` | `ragflow-mysql` 的 `ragflow` 账号口令 |
| `RAGFLOW_MYSQL_ROOT_PASSWORD` | `ragflow123` | `ragflow-mysql` 的 root 口令 |
| `RAGFLOW_REDIS_PASSWORD` | `ragflow123` | `ragflow-redis` 的口令（同时用于 `--requirepass` 与健康检查） |
| `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` | `ragflow` / `ragflow123` | `ragflow-rustfs` 的凭据 |
| `RAGFLOW_WEB_PORT` / `RAGFLOW_API_PORT` | `18080` / `19380` | 宿主回环端口 |
| `GOTENBERG_PORT` | `3200` | 宿主回环端口 |

入口：Web <http://127.0.0.1:18080>；API `http://127.0.0.1:19380`。

### hindsight

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | **空（必填）** | 阿里云百炼 Key，hindsight 用它做 LLM / Embedding / Reranker。**全部组件里唯一必须填真值、且只能填在仓库根 `.env` 的键**；不填则启动即报缺少 API Key |
| `HINDSIGHT_API_HOST_PORT` / `HINDSIGHT_CP_HOST_PORT` | `8888` / `9999` | 宿主回环端口 |

### agent-sites

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `AGENT_SITES_MASTER_KEY` | `agent-sites-master-key-123` | 站点部署密钥；rcs 侧用同一插值键自动同值 |
| `AGENT_SITES_PORT` | `26778` | 对外发布端口（站点要供外部访问，非回环） |

### opensandbox

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `CLUSTER_SERVICE_API_KEY` | `clustersvc123` | 沙盒集群 API Key；rcs 侧用同一插值键自动同值 |
| `SERVER_API_KEY_ENCRYPTION_KEY` | `opensandbox-dev-encrypt-key-0001` | **必须恰好 32 个字符**，否则 cluster 启动失败 |
| `FRP_PUBLIC_ADDRESS` | `host.docker.internal` | 节点回连 frps 用，**从节点容器看必须可达**（不能写 `127.0.0.1`）；Linux / 跨机组网按 `sandbox.toml.example` 的注释改 |
| `FRP_TOKEN` | `frp123` | 只允许 `[A-Za-z0-9_-]` |
| `FRP_BIND_PORT` / `OPENSANDBOX_CLUSTER_PORT` / `OPENSANDBOX_SERVER_PORT` | `7000` / `8080` / `8090` | 宿主端口 |
| `SANDBOX_PORT_MIN` / `SANDBOX_PORT_MAX` | `10000` / `10100` | 沙盒实例端口范围，**改了要同步 `sandbox.toml` 的 `port_range_min/max`** |

入口：cluster API <http://127.0.0.1:8080>；节点 Server <http://127.0.0.1:8090>。

### 其他（通常不需要改）

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `PROXY_CONNECT_TIMEOUT_MS` / `PROXY_RESPONSE_TIMEOUT_MS` | `3000` / `120000` | cluster 代理的建连与响应超时（毫秒） |

## 数据落点

各组件的运行数据都在 `docker/dev/data/<组件>/` 下（bind 挂载，随目录整体备份/搬迁）。
**唯一例外**：`opensandbox-server` 的 DinD 内部 Docker 状态用命名卷 `fenix_opensandbox-server-dind-docker`
（macOS 的 virtiofs bind 不支持 dockerd 需要的 chmod，用它会让节点启动即崩；它不是需要备份的用户数据）。
需要彻底重置沙盒节点时：`docker volume rm fenix_opensandbox-server-dind-docker`。
仓库根 `.gitignore` 的 `data` 规则匹配任意深度，这些数据不进版本控制。

## 排障

- **容器起不来但 `config` 能过**：先看 `docker compose logs <服务>`。多数是镜像拉取失败（网络）或端口被占。
  端口冲突最常见的是 `opensandbox`：它一次占四个宿主端口（`OPENSANDBOX_CLUSTER_PORT` / `OPENSANDBOX_SERVER_PORT` /
  `FRP_BIND_PORT` 与整段 `SANDBOX_PORT_MIN`-`SANDBOX_PORT_MAX`），本机若已有另一套沙盒或部署栈在跑就会撞。
  连同默认集的两个（`POSTGRES_PORT` / `FENIX_HTTP_PORT`）一起覆盖即可，例如：
  ```bash
  OPENSANDBOX_CLUSTER_PORT=18081 OPENSANDBOX_SERVER_PORT=18091 FRP_BIND_PORT=17001 \
  SANDBOX_PORT_MIN=12000 SANDBOX_PORT_MAX=12100 POSTGRES_PORT=15433 FENIX_HTTP_PORT=3379 \
  docker compose --profile opensandbox up -d
  ```
  改了 `SANDBOX_PORT_*` 就要同步 `docker/dev/sandbox.toml` 的 `port_range_min/max`。
- **端口冲突**：本目录的默认回环端口（`4000` / `18080` / `19380` / `3200` / `8888` / `9999` / `8080` / `8090`）
  与生产依赖目录的默认值相同。dev 与生产**二选一运行**不冲突；同机并存两套会撞。
  另有 `FRP_BIND_PORT`（默认 `7000`）：它是 frps 的隧道入口，发布到**全部接口**（不带 `127.0.0.1` 前缀），
  沙盒节点按 `FRP_PUBLIC_ADDRESS` 回连它——它不在上面的回环清单里，暴露面按全接口计。
- **hindsight 启动即退出**：日志出现 `check_pg0_writable` 说明数据目录属主不是容器内的 UID 1000。
  `docker compose --profile hindsight down && sudo chown -R 1000:1000 docker/dev/data/hindsight/pg0` 后重起
  （macOS 的 Docker Desktop 通常不需要）。
- **ragflow 起不来**：它要等四个依赖 healthy，外加一次性探测 `ragflow-s3-init` 跑完才放行；首次还要等
  Infinity 初始化。`docker compose ps` 看谁没就绪。上游镜像只发布 amd64，arm64 主机是模拟运行，慢是正常的。
- **`ragflow-s3-init` 退出码非 0**：ragflow 会因此**一直不启动**（这是设计，不是故障——探测的就是
  RAGFlow 首次上传会走的那条路）。`docker compose logs ragflow-s3-init` 看是端点不可达还是凭据不对；
  若是凭据，检查 `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` 是否被只改了 `ragflow-rustfs` 那一处。
- **opensandbox-server 一直 not healthy**：它在容器内起 Docker（DinD），首次要把预打包的
  `opensandbox/execd:v1.0.18` 镜像 `docker load` 进容器内 DinD（该镜像已在构建镜像时经 skopeo 打进
  `/opt/opensandbox/seed-images/`，Server 启动时自动 load，不需要联网拉取）；`start_period` 后才转 healthy，
  `docker compose logs opensandbox-server` 看进度。
  **若日志里出现 `error changing permissions on file for metacopy check` 或 `read-only file system`**，
  那不是启动慢而是启动失败：DinD 的 `/var/lib/docker` 落在 macOS 的 virtiofs bind 上时 dockerd 无法 chmod。
  本编排已把它改用命名卷 `fenix_opensandbox-server-dind-docker`（见该文件头第 5 条偏离）——若仍复现，
  核对这一行是否被改回 bind，而不是去调 healthcheck 参数。
- **改了默认值不生效**：确认写的是**仓库根 `.env`**（compose 的项目目录是根文件所在目录），不是本目录。

## 与生产形态的关系

| | dev | 生产 |
| --- | --- | --- |
| 入口 | 仓库根 `docker-compose.yml` | `docker/main/docker-compose.yml` |
| 主服务镜像 | 本地构建（`build:`） | GHCR 固定 tag，`pull` 拉取 |
| 组件消费方 | 本目录（`include` 进同一项目） | `docker/<组件>/`（各自独立项目，`deploy.sh` 启动） |
| 基础服务 | 根文件内联 | `docker/common/`（`include`） |
| 键来源 | compose 内联默认值 + 仓库根 `.env` | 各目录 `.env`（`deploy.sh init` 生成） |
| 数据 | 仓库根 `./data`、本目录 `data/` | `docker/main/` 下、`docker/common/data/` |

两者同项目名 `fenix`、同网络 `fenix-server`：**二选一运行**。

## 什么时候用哪个

- **本地开发 FenixAgent 本身**（改代码、跑 `bun run dev`、调试功能）：用本目录。组件按需 `--profile`
  追加，默认值开箱可用，全部数据落在仓库内。
- **验证生产形态、或验证 `docker/<组件>/` 那套编排**：走生产入口 `./docker/deploy.sh`，别用本目录代劳。
- 两套同项目名、同网络，**同时运行会互相接管容器**。也不要拿本目录去补 `docker/<组件>/` 缺的服务
  ——那会把两套编排混成一套谁也说不清的形态。
