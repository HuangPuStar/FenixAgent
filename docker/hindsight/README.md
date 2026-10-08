# Hindsight（memory 依赖）

平台的**长期记忆服务**：Agent 会话产生的记忆在这里存储与召回。`@fenix/resource-memory` 用
`HINDSIGHT_MCP_URL` 作上游基址（`src/server/facades/hindsight-facade.ts` 以 `/v1/default/banks/{bankId}/**`
转发，唯一消费者）；Agent 运行时经 agent-config 的启动参数装配拿到同一个地址
（`agent-launch-spec/memory-env.ts` 的 `hindsightApiUrl`）；模块的依赖自检是 `HINDSIGHT_MCP_URL` 的
**TCP 可达性**（`packages/resources/memory/fenix.module.ts` 的 `dependencyServices`）。未配置该键（含空串）
即「记忆能力整体未启用」，不影响其他模块。

镜像特性：单容器内含 API（8888）、控制平面控制台（9999）与内嵌 PostgreSQL（`pg0`，数据目录
`/home/hindsight/.pg0`）；进程以 UID 1000 的 `hindsight` 用户 rootless 运行。

## 前置条件

- Docker Engine 与 Docker Compose ≥ 2.20。
- 随主服务启动时**主服务项目必须先起**（`fenix-server` 由主服务项目创建——dev 是仓库根 `docker-compose.yml`，生产是 `docker/main/docker-compose.yml`；本目录以 `external: true` 引用）。
- `DASHSCOPE_API_KEY` 已填（LLM / Embedding / Reranker 三处共用，缺失即启动失败）。
- 宿主能拉 `ghcr.io/vectorize-io/hindsight:0.10.2`，且**能访问 `dashscope.aliyuncs.com`**（启动时要调百炼做模型初始化）。
- `./data/pg0` 可写且属主为 UID 1000（见「数据与迁移」）。

## 配置

| 键 | 位置 | 必需性 | 说明 |
| --- | --- | --- | --- |
| `DASHSCOPE_API_KEY` | 本目录 `.env`（独立部署）；主服务 env 亦可（随主服务启动时脚本把它导出为 shell 环境，§8.5） | 必需 | 阿里云百炼 API Key，LLM / Embedding / Reranker 共用 |
| `HINDSIGHT_API_HOST_PORT` | 本目录 `.env` | 默认 8888 | API 的宿主回环端口（`127.0.0.1`），本地源码运行指向它 |
| `HINDSIGHT_CP_HOST_PORT` | 本目录 `.env` | 默认 9999 | 控制台的宿主回环端口（`127.0.0.1`），管理员浏览器访问 |
| `HINDSIGHT_MCP_URL` | 主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`） | 启用记忆时必填 | 平台访问 Hindsight 的基址；取值见下节。装配期投影进模块配置，**改值需重启主服务** |
| `HINDSIGHT_API_TOKEN` | 主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`） | 可选 | agent-config 管辖：随 Agent 启动参数下发（写进工作区 `.hindsight/workspace.json` 的 `hindsightApiToken`，不作为 env 下发）；未配置时写 `null`。本编排**未**设置服务端鉴权，见「已知项」 |

模型名（`qwen3.6-flash` / `text-embedding-v4` / `qwen3-rerank`）、Embedding 批大小（`64`）与百炼基址写在
本目录 `docker-compose.yml` 的 `environment:` 里，本目录不开对应的 `.env` 开关——它们与服务端端口、模型
初始化是同一组契约，改一处要连另一处一起核对。

## 网络接入清单

| 服务 | 接入 `fenix-server` | 理由 |
| --- | --- | --- |
| `hindsight` | 是 | 出口服务：主服务容器要直连它的 API（契约 §3 的「依赖的对外出口服务」） |

本目录只有一个服务；内嵌 PostgreSQL 在同一个容器进程组里，不存在第二个服务，也没有辅助服务需要留在项目默认网络。

## 容器内地址 vs 宿主地址

`HINDSIGHT_MCP_URL` 是**基址**（平台与 Agent 插件都只往它后面拼 `/v1/default/banks/**`），要写到端口为止，
不要带路径后缀：

| 场景 | 填什么 |
| --- | --- |
| 容器形态（rcs 也在编排里） | `HINDSIGHT_MCP_URL=http://hindsight:8888`（经 `fenix-server`；容器内 API 固定 8888） |
| 本地源码运行（`bun run dev`） | `HINDSIGHT_MCP_URL=http://localhost:8888`（宿主回环口，端口以 `HINDSIGHT_API_HOST_PORT` 为准） |
| 独立部署（记忆服务在别的机器） | 那台机器对主服务可达的地址，端口 8888 |

控制台（`http://localhost:9999`，端口以 `HINDSIGHT_CP_HOST_PORT` 为准）只给管理员在本机浏览器打开，平台不访问它。

## 数据与迁移

数据在 `./data/pg0`（bind 到容器内 `/home/hindsight/.pg0`，相对本 compose 文件解析；`./data/` 不进版本控制）。

**权限**：容器用户是 UID 1000，镜像启动脚本会先探测该目录能否写入，不能就以
「not writable by this container (UID 1000)」退出（脚本明确不做 chown，镜像里也不存在第二个 UID）。Linux
主机上按脚本给的指引处理；macOS 的 Docker Desktop 一般不需要：

```bash
sudo chown -R 1000:1000 docker/hindsight/data/pg0
```

**从旧形态迁过来**（旧编排把数据放在宿主 `~/.hindsight-docker`）：

```bash
docker rm -f fenix-hindsight                                     # 先停：写入中拷库等于拷坏数据（旧编排的容器名就是它）
mkdir -p docker/hindsight/data/pg0
cp -a ~/.hindsight-docker/. docker/hindsight/data/pg0/
sudo chown -R 1000:1000 docker/hindsight/data/pg0             # 仅 Linux 主机需要
docker compose -f docker/hindsight/docker-compose.yml up -d
```

旧文件里声明过但**从未被任何服务挂载**的命名卷（形如 `<项目名>_hindsight-data`）是空卷，用
`docker volume ls | grep hindsight-data` 确认后直接 `docker volume rm <卷名>` 即可，没有数据要搬。

## 验证

```bash
curl -fsS http://127.0.0.1:8888/health            # 预期 200（API 健康端点，镜像内启动脚本用的同一条）
docker compose -f docker/hindsight/docker-compose.yml ps
docker compose -f docker/hindsight/docker-compose.yml logs | tail -20   # 期望出现 "Hindsight is running!"
# 平台侧：控制台点开记忆页，状态应为可用（`/web/hindsight/status`）；或核对 rcs 日志无连接失败
```

启动首次会下载并初始化 Embedding 模型，可能超过 1 分钟；超时上限可用镜像的
`HINDSIGHT_API_MODEL_INIT_TIMEOUT` 调整（本目录未开该开关）。

## 升级

改本目录 `docker-compose.yml` 的 `image` 行为目标版本（固定版本，禁止 `latest`），然后：

```bash
docker compose -f docker/hindsight/docker-compose.yml pull
docker compose -f docker/hindsight/docker-compose.yml up -d
```

升级前备份 `./data/pg0`（内嵌 PostgreSQL 数据目录不能跨大版本降级）；升级后确认控制台可打开、`/health` 为 200，
再在平台侧发一次 recall 验证记忆可读。

## 已知项

- `restart: none` 保持改前现状（本目录未擅自改重启策略）：宿主重启后它不会自行起来，需要
  `./docker/deploy.sh up`（或本目录 `docker compose up -d`）。要让依赖随宿主自启，把该行改成 `unless-stopped`
  并同步本 README。
- 服务端鉴权键**待确认**：本编排没有设置 Hindsight 的 API 鉴权（平台侧 `HINDSIGHT_API_TOKEN` 只是随插件下发
  的凭据，本目录不读它）。当前 API 只发布到回环、跨项目只在 `fenix-server` 内可达，故未鉴权不构成对外暴露；
  要开启鉴权，先在该镜像对应的上游提交（`0.10.2` 的 `org.opencontainers.image.revision` 是
  `5fc4ce20917b916240cef27c212c387a177f115b`）里查鉴权环境变量名，再在 `environment:` 加键，并让平台侧的
  同名值一致。
