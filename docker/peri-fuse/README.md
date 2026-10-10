# Peri-Fuse（LLM 观测依赖）

平台的 **LLM 观测服务**：Agent（peri）的模型调用 Trace、成本与调试信息上报到这里，在控制台查看。
Peri-Fuse 是 Langfuse 的兼容实现——单容器 + 内嵌 Turso/SQLite，不需要 ClickHouse / Redis / S3 / Worker。

**平台侧没有转接层**：上报由 **Agent 进程直连** Peri-Fuse（peri 的 langfuse-client 读 `LANGFUSE_BASE_URL` /
`LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` 三个同名环境变量）；主服务只负责把这组键随 Agent 启动参数
透传下去（`packages/resources/agent-config/src/server/services/agent-launch-spec/memory-env.ts` 的
`buildLangfuseEnv()`），自身不访问本服务。三键的声明面在 `packages/resources/agent-config/fenix.module.ts`，
宿主配置投影在 `apps/server/src/config.ts` 的 `langfuse*`；**改值需重启主服务**（装配期固化）。

## 前置条件

1. Docker Engine 与 Docker Compose ≥ 2.20。
2. 随主服务启动时**主服务项目必须先起**（`fenix-server` 由主服务项目创建——dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`；本目录以 `external: true` 引用）。
3. 宿主能拉缺省版本 `ghcr.io/konghayao/peri-fuse:0.5.0`（版本用本目录 `.env` 的 `PERIFUSE_VERSION` 覆盖，缺省值写在 compose 的插值里）；本目录 `./data` 可写（首次启动自动创建）。
4. Agent 进程所在的机器能访问你选定的上报地址（见下面「容器内地址 vs 宿主地址」）。

## 配置

| 键 | 位置 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `PERIFUSE_BIND_ADDR` | 本目录 `.env` | 默认 `127.0.0.1` | 宿主发布地址；Agent 在别的机器且要经宿主地址直连时改 `0.0.0.0` 或那台机器可达的网卡地址 |
| `PERIFUSE_HOST_PORT` | 本目录 `.env` | 默认 `23332` | 宿主发布端口（容器内固定 23332）；控制台与 `LANGFUSE_BASE_URL` 都用它 |
| `PERIFUSE_VERSION` | 本目录 `.env`（覆盖 compose 缺省） | 默认 `0.5.0`（写在 compose 的插值缺省里） | 镜像 tag；只在显式钉这台机器的版本时才写（`.env.example` 里是注释行，取消注释才生效），见「升级」 |
| `PERIFUSE_SALT` | 本目录 `.env` | 可选 | API key 哈希盐（密钥）；留空则首次启动自动生成到 `./data/.salt`。**首次签发 key 后再改值会让已有 key 全部失效** |
| `LANGFUSE_BASE_URL` | 主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`） | 接入观测时必填 | Agent 进程侧的上报基址，取值见下节；未配置则不注入，peri 侧会走它的默认 SaaS 端点（等于没接自托管） |
| `LANGFUSE_PUBLIC_KEY` | 主服务 env | 接入观测时必填 | 在 Peri-Fuse 控制台的项目里签发的 public key（`pk-lf-…`） |
| `LANGFUSE_SECRET_KEY` | 主服务 env | 接入观测时必填 | 同一对里的 secret key（`sk-lf-…`）；密钥只随受信 relay 通道下发，不进日志 |

其余旋钮（telemetry 保留期 `PERIFUSE_TELEMETRY_RETENTION_DAYS`、远程 Turso、Gateway 代理）**不在本目录开
`.env` 开关**：它们与容器内存储、端口是同一组契约，要改就编辑本目录 `docker-compose.yml` 的 `environment:`
（远程 Turso 的键见 Peri-Fuse 上游 README）。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `peri-fuse` | 是 | 上报方是 Agent 进程：本地执行的 Agent 跑在 `rcs` 容器内、沙箱执行的跑在各自节点容器内，都按服务名 `peri-fuse:23332` 直连它（命中契约 §3 的成员判定标准——「需要访问主服务的执行节点」要与它通信） |

本目录只有一个服务，没有辅助服务需要留在项目默认网络。

## 容器内地址 vs 宿主地址

`LANGFUSE_BASE_URL` 是**基址**（写到端口为止，Langfuse 兼容 API 走它下面的 `/api/public/**`）：

| 场景 | 填什么 |
| --- | --- |
| 容器形态（Agent 跑在 `rcs` 或沙箱容器里） | `LANGFUSE_BASE_URL=http://peri-fuse:23332`（经 `fenix-server`；这是同机编排下的推荐值） |
| 本地源码运行（`bun run dev`，Agent 跑在宿主） | `LANGFUSE_BASE_URL=http://localhost:23332`（宿主回环口，端口以 `PERIFUSE_HOST_PORT` 为准） |
| Agent 在别的机器 | 那台机器可达的宿主地址（先把 `PERIFUSE_BIND_ADDR` 放开；Peri-Fuse 自身无鉴权面隔离，别直接暴露公网） |

写错地址不会让主服务报错——上报失败只丢 Trace，业务对话照常。排查「控制台没有数据」时先核对这条地址。

## 接入步骤

1. 起服务：`./docker/deploy.sh up`（先在 `docker/deploy.env` 打开 `FENIX_FEATURE_PERI_FUSE=true`），或按本目录开头注释独立启动。
2. 打开控制台 `http://localhost:23332`（端口以 `PERIFUSE_HOST_PORT` 为准），进入项目设置创建 API key，记下配对的 `pk-lf-…` 与 `sk-lf-…`。
3. 把三个键写进主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`）：

   ```bash
   LANGFUSE_BASE_URL=http://peri-fuse:23332
   LANGFUSE_PUBLIC_KEY=pk-lf-…
   LANGFUSE_SECRET_KEY=sk-lf-…
   ```

4. 重启主服务（三键在装配期读入）。之后新起的 Agent 实例即开始上报；已运行的实例要用新参数重启才会带上三键。
5. 触发一次 Agent 对话，回到控制台确认出现 Trace。

## 数据与迁移

数据在本目录 `./data`（bind 到容器内 `/app/data`，即 `PERIFUSE_HOME`；相对本 compose 文件解析，`./data` 不进版本控制）：

- `langfuse.turso.db`：项目、账号、API key；
- `telemetry.turso.db`：Trace / Observation / Score；
- `gateway.turso.db` 与加密密钥、`.salt`：Gateway 代理与 API key 哈希盐。

备份/搬迁：停容器后整目录复制即可（运行中直接复制 SQLite 文件不保证一致）。升级镜像**不动这份数据**。

## 验证

```bash
docker compose -f docker/peri-fuse/docker-compose.yml ps                      # 期望 peri-fuse 为 healthy
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:23332/api/public/health   # 期望 200
```

## 升级

```bash
# 1. 选目标版本 tag：跟 release 用语义版本（0.5.0 / 0.5），跟主线用提交短哈希 tag
#    （README 的 tags list 即当前可用值；2026-10-10 核对 `latest` / `main` 指向比 0.5.0 新的提交构建）
# 2. 钉版本，任选一处：
#    - 改本目录 docker-compose.yml 的插值缺省值（进版本控制，随交付面走，所有人默认用这个版本）
#    - 在本目录 .env 里写 PERIFUSE_VERSION（只钉这台机器，compose 缺省值随交付面更新时这里不受影响）
# 3. 拉取并滚动重启：
docker compose -f docker/peri-fuse/docker-compose.yml pull
docker compose -f docker/peri-fuse/docker-compose.yml up -d
```

## 已知项与边界

1. **鉴权面**：数据 API 需要项目 API key，MCP 端点（`/mcp`）与静态页是公开只读；Peri-Fuse 没有平台级多租户隔离，因此宿主端口默认只绑回环。
2. **规模上限**：单文件 SQLite 的写入能力有上限，适合本地开发 / 小队 / 单机部署；更大的量按上游 README 换远程 Turso（本目录未开该开关）。
3. **观测故障不影响业务**：服务没起或地址写错时，Agent 上报失败只丢 Trace，不阻塞对话与工作流。
