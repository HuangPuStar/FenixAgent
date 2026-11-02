# `docker/dev/` —— 本地开发的可选组件

仓库根 `docker compose up -d` **默认只起 `postgres` + `rcs`**（两者都内联在根 `docker-compose.yml`）。本目录
是**其余组件**的编排：每个组件一份 `docker-compose.<组件>.yml`，由根文件用 `include:` 复制进**同一个项目**
（`fenix`）与同一张网络（`fenix-server`），用 `--profile <组件名>` 按需启动。

## 组件启停命令

```bash
docker compose up -d                                        # postgres + rcs
docker compose --profile redis up -d                        # 加一组组件
docker compose --profile litellm --profile ragflow up -d    # 加两套组件
docker compose stop litellm litellm-postgres                # 停单组（容器留着）；要连容器一起删用 rm -sf
docker compose config                                       # 只解析、不起容器，随时可跑
```

> `--profile <组件> down` **不是**「只停那一组」：`down` 作用于**整个项目**，实测会连 `postgres` / `rcs`
> 一起停掉（本机实测：`--profile opt down` 把无 profile 的服务也移除了）。要停单组就点名服务名。

组件名（`--profile` 的取值）：`redis`、`litellm`、`ragflow`、`hindsight`、`agent-sites`、`opensandbox`。

组件需要做接入配置，见下面章节说明。

## 组件接入配置

### redis

```bash
docker compose --profile redis up -d
```

**组件可覆盖的键**：

无。`redis` 服务内联在根 `docker-compose.yml`，参数写死，没有插值键。

**主服务接入**：

| 键 | 容器形态（rcs 在容器里） | 源码形态（rcs 在宿主机） |
| --- | --- | --- |
| `RCS_REDIS_URL` | `redis://redis:6379` | 用不上——本编排的 `redis` **没有映射宿主端口**（容器间按服务名直连即可）；要用容器里的 redis 就走容器形态 |

不配即回退进程内 Map、Y.Doc 快照不持久化（见根编排 `redis` 段注释）。

### litellm

```bash
docker compose --profile litellm up -d
```

入口：控制台 <http://127.0.0.1:4000/litellm/ui>（账号 `admin`）；平台访问的基址是 `http://litellm:4000/litellm`。

**组件可覆盖的键**：

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `LITELLM_MASTER_KEY` | `litellm-master-key-123` | 网关管理密钥；rcs 侧用同一插值键自动同值 |
| `LITELLM_SALT_KEY` | `litellm-salt-key-123` | 库内 Provider 凭据的加密盐，换值后已有凭据解不开 |
| `LITELLM_DB_PASSWORD` | `litellm123` | `litellm-postgres` 的口令 |
| `LITELLM_UI_PASSWORD` | `admin123` | 管理控制台口令（账号 `admin`） |
| `LITELLM_PORT` | `4000` | 宿主回环端口 |

**主服务接入**：

| 键 | 容器形态 | 源码形态 |
| --- | --- | --- |
| `RCS_MODEL_GATEWAY_BASE_URL` | `http://litellm:4000/litellm` | `http://127.0.0.1:4000/litellm` |
| `RCS_MODEL_GATEWAY_ADMIN_KEY` | 与 `LITELLM_MASTER_KEY` 同值（默认 `litellm-master-key-123`） | 同左 |
| `RCS_MODEL_GATEWAY_ADMIN_UI_URL` | `http://127.0.0.1:4000/litellm/ui` | 同左（浏览器都在宿主机上） |
| `RCS_MODEL_GATEWAY_CREDENTIAL_ENCRYPTION_KEY` | 自定一串，平台侧加密存门户凭据 | 同左 |
| `RCS_MODEL_GATEWAY_TYPE` | 默认已是 `litellm`，不必写 | 同左 |

- 网关路由都挂在 `/litellm` 前缀下（**缺前缀会 404**）。
- 用沙盒时还要考虑 `RCS_MODEL_GATEWAY_PUBLIC_BASE_URL`，见 opensandbox 小节。

**接入之后**：

模型是在 LiteLLM 后台配的，平台不会自动发现。进 `/ctrl/admin/model-gateway`，先「检查状态」、
再「同步模型」，把网关的模型目录同步成平台的 Gateway Provider——少这一步模型列表是空的。

### ragflow

```bash
docker compose --profile ragflow up -d
```

入口：Web <http://127.0.0.1:18080>；API `http://127.0.0.1:19380`。

**组件可覆盖的键**：

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `RAGFLOW_MYSQL_PASSWORD` | `ragflow123` | `ragflow-mysql` 的 `ragflow` 账号口令 |
| `RAGFLOW_MYSQL_ROOT_PASSWORD` | `ragflow123` | `ragflow-mysql` 的 root 口令 |
| `RAGFLOW_REDIS_PASSWORD` | `ragflow123` | `ragflow-redis` 的口令（同时用于 `--requirepass` 与健康检查） |
| `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` | `ragflow` / `ragflow123` | `ragflow-rustfs` 的凭据 |
| `RAGFLOW_WEB_PORT` / `RAGFLOW_API_PORT` | `18080` / `19380` | 宿主回环端口 |
| `GOTENBERG_PORT` | `3200` | 宿主回环端口 |

**主服务接入**：

先在 ragflow 注册一个账户，并配置好模型和生成 API_KEY

| 键 | 容器形态 | 源码形态 |
| --- | --- | --- |
| `RAGFLOW_API_URL` | `http://ragflow:9380` | `http://127.0.0.1:19380` |
| `RAGFLOW_API_KEY` | 在 RAGFlow Web（<http://127.0.0.1:18080>）里生成 | 同左 |
| `GOTENBERG_URL` | `http://gotenberg:3000` | `http://127.0.0.1:3200`（宿主默认值即此） |

**接入之后**：接上即可用，知识库在知识库页面里建。

### hindsight

hindsight 启动前需要配模型：在**仓库根 `.env`** 里填 `DASHSCOPE_API_KEY`（阿里云百炼 Key）。如果使用其他模型提供商，参考 hindsight 官方配置文档。

```bash
docker compose --profile hindsight up -d
```

入口：API `http://127.0.0.1:8888`；控制台 <http://127.0.0.1:9999>。

**组件可覆盖的键**：

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | **空（必填）** | 阿里云百炼 Key，hindsight 用它做 LLM / Embedding / Reranker。**全部组件里唯一必须填真值、且只能填在仓库根 `.env` 的键**；不填则启动即报缺少 API Key |
| `HINDSIGHT_API_HOST_PORT` / `HINDSIGHT_CP_HOST_PORT` | `8888` / `9999` | 宿主回环端口 |

**主服务接入**：

| 键 | 容器形态 | 源码形态 |
| --- | --- | --- |
| `HINDSIGHT_MCP_URL` | `http://hindsight:8888` | `http://127.0.0.1:8888` |

**接入之后**：接上即可用，记忆能力按对应功能入口使用。

### agent-sites

```bash
docker compose --profile agent-sites up -d
```

**组件可覆盖的键**：

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `AGENT_SITES_MASTER_KEY` | `agent-sites-master-key-123` | 站点部署密钥；rcs 侧用同一插值键自动同值 |
| `AGENT_SITES_PORT` | `26778` | 宿主回环端口（仅供本机调试；站点访问经 RCS 反向代理） |

**主服务接入**：

| 键 | 容器形态 | 源码形态 |
| --- | --- | --- |
| `AGENT_SITES_BASE_URL` | `http://agent-sites:3000` | `http://127.0.0.1:26778` |
| `AGENT_SITES_MASTER_KEY` | 与组件侧 `AGENT_SITES_MASTER_KEY` 同值（默认 `agent-sites-master-key-123`） | 同左 |

**接入之后**：接上即可用，站点能力按对应功能入口使用。

### opensandbox

准备（`cp docker/dev/sandbox.toml.example docker/dev/sandbox.toml`）。注意，如果opensandbox需要走内网访问，配置 network_mode = "host"。

```bash
docker compose --profile opensandbox up -d
```

入口：cluster API <http://127.0.0.1:8080>；节点 Server <http://127.0.0.1:8090>。

**组件可覆盖的键**：

| 键 | 默认值 | 影响 |
| --- | --- | --- |
| `CLUSTER_SERVICE_API_KEY` | `clustersvc123` | 沙盒集群 API Key；rcs 侧用同一插值键自动同值 |
| `SERVER_API_KEY_ENCRYPTION_KEY` | `opensandbox-dev-encrypt-key-0001` | **必须恰好 32 个字符**，否则 cluster 启动失败 |
| `FRP_PUBLIC_ADDRESS` | `host.docker.internal` | 节点回连 frps 用，**从节点容器看必须可达**（不能写 `127.0.0.1`）；Linux / 跨机组网按 `sandbox.toml.example` 的注释改 |
| `FRP_TOKEN` | `frp123` | 只允许 `[A-Za-z0-9_-]` |
| `FRP_BIND_PORT` / `OPENSANDBOX_CLUSTER_PORT` / `OPENSANDBOX_SERVER_PORT` | `7000` / `8080` / `8090` | 宿主端口 |
| `SANDBOX_PORT_MIN` / `SANDBOX_PORT_MAX` | `10000` / `10100` | 沙盒实例端口范围，**改了要同步 `sandbox.toml` 的 `port_range_min/max`** |
| `PROXY_CONNECT_TIMEOUT_MS` / `PROXY_RESPONSE_TIMEOUT_MS` | `3000` / `120000` | cluster 代理的建连与响应超时（毫秒），通常不需要改 |

**主服务接入**：

| 键 | 容器形态 | 源码形态 |
| --- | --- | --- |
| `RCS_SANDBOX_ENABLED` | `true` | 同左 |
| `RCS_SANDBOX_CLUSTER_URL` | `http://opensandbox-cluster:8080` | `http://127.0.0.1:8080` |
| `RCS_SANDBOX_CLUSTER_API_KEY` | 与 `CLUSTER_SERVICE_API_KEY` 同值（默认 `clustersvc123`） | 同左 |
| `RCS_DEFAULT_SANDBOX_POOL_ID` / `_IMAGE` / `_RESOURCES_JSON` / `_EXTRA_JSON` | 资源池建好后回填，见下面「接入之后」 | 同左 |
| `RCS_MODEL_GATEWAY_PUBLIC_BASE_URL` | 用沙盒时：沙盒里的 Agent 访问模型网关不能走 `127.0.0.1`（那是沙盒自己），按沙盒容器的网络位置写；不填则回退到 `RCS_MODEL_GATEWAY_BASE_URL` | 同左 |

`RCS_DEFAULT_SANDBOX_AGENT_TYPE` 默认 `peri`，不必写。

**接入之后**（光接上还不行，平台侧还没有池子）：

1. 进 `/ctrl/admin/sandbox`：先「新建资源池」，再给池「新建 server」节点——`workspace root` 要与 Server 端
   `sandbox.toml` 的 `storage.allowed_host_paths` 一致（dev 默认都是 `/workspace`），需要时再补镜像。
2. 把资源池 ID 回填 `.env` 的 `RCS_DEFAULT_SANDBOX_POOL_ID`（连同 `RCS_DEFAULT_SANDBOX_IMAGE` /
   `_RESOURCES_JSON` / `_EXTRA_JSON`），**重启主服务**。
3. 之后在 Agent 配置里选用这个沙盒池。

节点侧的完整准备（DinD、离线镜像、`sandbox.toml`、注册到 Cluster 的字段语义）见
[`docker/opensandbox-server/README.md`](../opensandbox-server/README.md) 与
[`docker/opensandbox-cluster/README.md`](../opensandbox-cluster/README.md)。

## 数据落点

各组件的运行数据都在 `docker/dev/data/<组件>/` 下（bind 挂载，随目录整体备份/搬迁）。
**唯一例外**：`opensandbox-server` 的 DinD 内部 Docker 状态用命名卷 `fenix_opensandbox-server-dind-docker`
（macOS 的 virtiofs bind 不支持 dockerd 需要的 chmod，用它会让节点启动即崩；它不是需要备份的用户数据）。
需要彻底重置沙盒节点时：`docker volume rm fenix_opensandbox-server-dind-docker`。
仓库根 `.gitignore` 的 `data` 规则匹配任意深度，这些数据不进版本控制。

## 排障

- **容器起不来但 `config` 能过**：先看 `docker compose logs <服务>`。多数是镜像拉取失败（网络）或端口被占。
- **ragflow 起不来**：它要等四个依赖 healthy，外加一次性探测 `ragflow-s3-init` 跑完才放行；首次还要等
  Infinity 初始化。`docker compose ps` 看谁没就绪。上游镜像只发布 amd64，arm64 主机是模拟运行，慢是正常的。
- **`ragflow-s3-init` 退出码非 0**：ragflow 会因此**一直不启动**（这是设计，不是故障——探测的就是
  RAGFlow 首次上传会走的那条路）。`docker compose logs ragflow-s3-init` 看是端点不可达还是凭据不对；
  若是凭据，检查 `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY` 是否被只改了 `ragflow-rustfs` 那一处。
- **opensandbox-server 一直 not healthy**：它在容器内起 Docker（DinD），首次要把预打包的
  `opensandbox/execd:v1.0.18` 镜像 `docker load` 进容器内 DinD（该镜像已在构建镜像时经 skopeo 打进
  `/opt/opensandbox/seed-images/`，Server 启动时自动 load，不需要联网拉取）；`start_period` 后才转 healthy，
  `docker compose logs opensandbox-server` 看进度。
- **改了默认值不生效**：确认写的是**仓库根 `.env`**（compose 的项目目录是根文件所在目录），不是本目录。
- **接了组件但主服务仍用不上**：确认改完 `.env` 后**重建容器/重启进程**（`restart` 不重读 `.env`），
  并核对写的是对应形态那一列的取值（服务名还是回环端口）。

## 什么时候用

- **本地开发 FenixAgent 本身**（改代码、跑 `bun run dev`、调试功能）：用本目录。组件按需 `--profile`
  追加，默认值开箱可用，全部数据落在仓库内。
