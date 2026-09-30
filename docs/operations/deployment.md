# 部署

本文只描述本仓当前代码与编排里真实存在的入口：依赖服务、必需环境变量、环境文件来源、启动顺序与启动后自检。可选集成（模型网关、知识库、记忆、Agent Sites、远端 Sandbox）的编排细节见 `docker/prod/README.md`，此处不复述。

## 1. 依赖服务

| 服务 | 必需性 | 依据与默认口径 |
| --- | --- | --- |
| PostgreSQL | **必需** | `DATABASE_URL` 在宿主 schema 中是必填且无默认值，缺失即启动失败（`apps/server/src/env.ts`）。本地可用根 `docker-compose.yml` 的 `postgres` 服务（`postgres:16-alpine`，库/用户 `rcs`，宿主 5432）。 |
| Redis | 可选 | `RCS_REDIS_URL`。未配置时缓存回退进程内 Map（`apps/server/src/services/cache.ts`），且 Y.Doc 快照**不做持久化**（`packages/chat-channel/src/server/services/doc-manager-instance.ts`：`getRedisConnection()` 为 `null` 即跳过）。仓库自带的两个主编排都不包含 Redis 服务。 |
| 外部能力（LiteLLM / Hindsight / RagFlow / Agent Sites / Sandbox） | 可选 | 各自独立编排，未部署只代表对应能力不可用，不阻断主服务启动；入口见 `docker/prod/README.md`。 |

## 2. 部署形态

### 2.1 本地源码运行

```bash
docker compose up -d postgres     # 仅数据库
bun install
bun run db:migrate                # DDL 迁移
bash restart-server.sh            # 停掉占用 RCS_PORT 的旧进程 → build:web → bun run dev
```

服务默认在 <http://localhost:3000/>（`RCS_HOST` / `RCS_PORT`）。前端单独热更新用 `bun run dev:web`；但后端挂载的是 `apps/web/dist/`，页面要看到改动必须 `bun run build:web`。

### 2.2 单机 Docker Compose

```bash
docker compose up --build -d
```

访问 <http://localhost:3001/>（编排把宿主 3001 映射到容器 3000）。`rcs` 服务的启动命令是 `bun migrate.js && exec bun --no-install run dist/index.js`：**DDL 迁移先于应用进程**，数据迁移不在这条命令里（见[升级](./upgrade.md)）。

### 2.3 生产编排（`docker/prod/`）

```bash
cp docker/prod/.env.example docker/prod/.env
# 编辑 docker/prod/.env：至少设置 OPENAI_API_KEY、REGISTRY_SECRET、AGENT_SITES_MASTER_KEY
#（编排对这三键做了不带默认值的变量插值，缺值时 compose 会以空串代入并告警）
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d
```

- 宿主端口 38879 → 容器 3000。
- 相对路径一律相对**编排文件所在目录**解析，不是仓库根：`env_file` 指向 `docker/prod/.env`，数据卷落在 `docker/prod/data`、`docker/prod/workflow`、`docker/prod/logs`。
- 编排里 `rcs` 的 `image:` 是固定 tag（当前为 `ghcr.io/huangpustar/fenixagent:sha-f00efc9`）；CI 在 main 与 `v*` tag 上构建并推送镜像（`.github/workflows/docker-publish.yml`，标签含分支名、semver 与 `sha-<commit>`），部署方需要按自己的镜像仓库把这一行改成要发布的版本。
- 可选能力按需叠加：`docker-compose.litellm.yml`、`docker-compose.hindsight.yml`、`docker-compose.ragflow.yml`、`docker-compose.opencode.yml`。Hindsight 依赖主编排创建的 `fenix-ver-net`，必须在主服务之后启动；LiteLLM 与 RagFlow 是独立编排，主服务必须用 rcs 容器**可路由**的地址访问它们，不能写 `localhost`。
- 修改主 `.env` 中的配置后需重建容器才生效：`docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d rcs`。

### 2.4 生成式部署面（`deploy/compose` + `release`）

`deploy/compose/` 是上面两套编排的**目标归属**：`base.yml` 手写（主服务 `rcs` + 必需的 PostgreSQL，外加
`--profile redis` 可选的 Redis），模块的依赖服务由 `deploy/compose/overlays/<module>.yml` 按声明生成——叠加或
撤下某个 overlay 就是该模块依赖面的启停开关，主服务本身不受影响（所有已声明服务都是 `required: false`）。

```bash
# 1) 生成/校验部署面（不带开关时只生成产物；--check 只校验漂移，均不启停容器）
bun run release

# 2) 起容器：命令文本由生成器给出，取自 deploy/manifests/profiles/<profile>.json 的 compose.up
docker compose -f deploy/compose/base.yml -f deploy/compose/overlays/knowledge.yml up -d

# 或一次跑完整条发布顺序：部署面校验 → DDL 迁移 → 数据迁移 → 容器部署（前一步失败即停）
bun run release --deploy

# 3) 停：同一组 -f 换成 down；只撤下某个 overlay 即停该模块的依赖服务
docker compose -f deploy/compose/base.yml -f deploy/compose/overlays/knowledge.yml down
```

- 真相来源是各模块的 `fenix.module.ts`（`dependencyServices`）；`deploy/manifests/` 与
  `deploy/compose/overlays/` 都是生成物，带「勿手改」头注释并进版本控制，改了声明必须重新生成（见
  `deploy/manifests/README.md`）。发布顺序与失败判定见[升级](./upgrade.md) §1。
- 装配 profile 默认是 `<RCS_APPLICATION_ROOT>/deploy/assembly/ce.json`，可用 `RCS_ASSEMBLY_PROFILE_PATH`
  指定别的 profile 文件（绝对路径）。
- 与既有入口的关系：仓库根 `docker-compose.yml`（本地开发）与 `docker/prod/docker-compose.yml`（生产）仍是
  **当前正在使用的入口**，本目录是这些编排的目标归属。两处并存期间，主服务进程的改动需要同时落到
  `base.yml` 与正在使用的那一份；收敛方案与边界见 `deploy/compose/README.md`。

## 3. 环境变量与三份模板

| 文件 | 场景 | 说明 |
| --- | --- | --- |
| `deploy/env/rcs.example` | 部署环境变量清单的**真相来源** | 覆盖宿主 `apps/server/src/env.ts` 的自有键 + 全部模块 `fenix.module.ts` 的 `envDefinitions`。 |
| `.env.example` | 本地开发起点 | `cp .env.example .env`；Bun 启动时自动读取仓库根 `.env`。 |
| `docker/prod/.env.example` | 生产编排起点 | `cp docker/prod/.env.example docker/prod/.env`。 |

使用口径：

- 三份模板都是**生成物**：键行一律是注释行，取消注释后才生效，未填写的键走代码默认值；密钥类键不写任何取值，真实值来自部署平台的 secret store、K8s/Docker secret 或受控文件。直接手改模板会被 `precheck` 的 `env-example` 步骤（按字节比对）判为漂移。
- 每个键的元信息行给出「必填／默认值／改值需重启／是否密钥」；**必填 = 未设置即启动失败**。
- 要增删键，改声明处后重新生成：宿主键改 `apps/server/src/env.ts`，有唯一模块 owner 的部署键改对应 `fenix.module.ts` 的 `envDefinitions`，然后执行 `bun run scripts/generate-env-example.ts`。同名键不得在两处声明——`assertNoHostKeyOverride()` 会在启动期直接拒绝。
- 少数键由包直读、未进声明面（`LOG_LEVEL` / `LOG_FORMAT` / `LOG_DIR` / `LOG_RETENTION_DAYS`，消费方 `packages/logger`），它们只出现在 `.env.example` 与 `docker/prod/.env.example` 的「声明面之外的键」小节里。
- 密钥纪律：`.env`、`data/password.txt` 一类文件不得进入源码、日志或响应，也不得随普通备份分发。

### 3.1 用 `deploy/env/rcs.example` 生成自己的环境文件

`deploy/env/rcs.example` 是**清单与逐键说明**，不是可直接加载的配置（键行全部是注释）。按部署形态选一条路径：

1. 本地开发：`cp .env.example .env`，按需取消注释；Bun 启动时自动读取仓库根 `.env`。
2. 单机 / 生产编排：`cp docker/prod/.env.example docker/prod/.env`，再填 `OPENAI_API_KEY`、`REGISTRY_SECRET`、`AGENT_SITES_MASTER_KEY` 等编排强制插值的键。
3. 其他部署平台（K8s、系统服务、受控文件）：以 `deploy/env/rcs.example` 逐行核对要配哪些键，把**非密钥**项写进部署清单、**密钥**项交给平台的 secret store；不要把它们合并回仓库文件。填完后用「启动日志 + `GET /health`」验证：必填项缺失会在启动期直接失败并指出键名。

## 4. 启动顺序（代码事实）

入口是 `apps/server/src/main.ts`，启动序与关闭序集中在 `apps/server/src/bootstrap/host-startup.ts`，两侧都不可重排：

1. `interceptConsole()` 必须在其他代码之前执行，统一接管 `console.*` 日志。
2. `resolveAssemblyEnv()` 读取装配 profile：路径默认由 `RCS_APPLICATION_ROOT` 决定（镜像 runtime 阶段固定为 `/app`），即 `<root>/deploy/assembly/ce.json`；源码运行时按模块位置反推仓库根。要换别的 profile 就设 `RCS_ASSEMBLY_PROFILE_PATH`（绝对路径，覆盖上面的默认值）。**文件缺失会直接 ENOENT 退出**。profile 只能选择已编译进 `apps/generated/module-registry.ts` 的模块 ID，选择未注册模块会在启动时抛错而不是静默降级。
3. `applyEnv(env)` 之后进入宿主启动序：
   - 关键序列：`initDb` → 模块装配（`wirePermissions`）→ 模型网关（`initModelGateway`，其中包含系统管理员 `ensureSystemAdmin` 与沙盒 provider 投影）。
   - 随后依次是：启动前取数端口绑定 → 沙盒默认池初始化与崩溃恢复 → Core runtime → 调度器（`RCS_DISABLE_SCHEDULER=true` 时跳过启动，注意它**不是**全局只读模式）→ builtin 同步 → 自定义节点工具注册 → Hermes → RagFlow 体检 → 巡检定时器 → 空闲监视。
   - 业务数据迁移**不在**这条序列里，由发布任务承担（见[升级](./upgrade.md)）。
4. 构造 Elysia app：注册 CORS、OpenAPI、`/health`、`/`（302 → `/ctrl/`）、`/ctrl/*` 静态资源、`/web/*`、`/api/*` 以及各模块在装配期登记的顶层协议入口（`/acp/*`、`/hooks/*`、`/workflow-ui/*` 等，通配兜底最后注册），最后 `app.listen({ port, hostname })`。
   前置约束：应用请求体上限 100MB；WebSocket `maxPayloadLength` 由 `RCS_FILE_WS_MAX_PAYLOAD_MB` 决定。
5. 关闭：`SIGINT` / `SIGTERM` 触发 `shutdownHostRuntime`（总预算 10s，逐阶段独立超时，超时只记日志不阻断后续阶段），完成后 `process.exit(0)`。并发或重复信号只关一次。

## 5. 启动后自检

```bash
curl -s http://<host>:<port>/health
# {"status":"ok","commitId":"<sha>","startedAt":"<iso>","version":"<semver>"}
```

- `commitId` 来自构建期注入的 `GIT_COMMIT_SHA`（本地调试回退 `git rev-parse HEAD`）。用它比对部署的到底是哪个提交：`git rev-parse HEAD`。
- 容器编排的健康检查就是 `GET /health`（编排文件与 `Dockerfile` 的 `HEALTHCHECK` 一致），`docker compose ... ps` 显示 health 状态即可。
- `/health` **只表达进程存活**，不区分「依赖就绪」；当前仓没有 readiness 端点，这一点在 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §11 中登记为优化项。需要确认依赖可用时，改为观察启动日志中各阶段的 `startupLog` 输出与首个业务请求。
- 首次启动会创建系统管理员 `admin@fenix.com`，初始口令写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`（默认 `./data/password.txt`）。该文件是敏感产物：读取后应立即改密并按密钥材料保管，不要进日志或普通备份包。

## 6. 静态资源与前端产物

后端从 `apps/web/dist/` 挂载控制台静态资源。只改前端源码而不执行 `bun run build:web`，运行的仍是旧产物——这是本地与生产都容易踩的坑，也是「构建镜像前先 `build:web`」的原因（`build-image.sh` 已把它放进构建流程）。
