# 部署

本文只描述本仓当前代码与编排里真实存在的入口：依赖服务、必需环境变量、环境文件来源、启动顺序与启动后自检。部署结构、方式与拓扑的权威定义见 [`../arch/26-deployment-topology.md`](../arch/26-deployment-topology.md)；可选集成（模型网关、知识库、记忆、Agent Sites、远端 Sandbox）的编排细节见 [`docker-topology.md`](./docker-topology.md)，此处不复述。

## 1. 依赖服务

| 服务 | 必需性 | 依据与默认口径 |
| --- | --- | --- |
| PostgreSQL | **必需** | `DATABASE_URL` 在宿主 schema 中是必填且无默认值，缺失即启动失败（`apps/server/src/env.ts`）。本地可用根 `docker-compose.yml` 的 `postgres` 服务（`postgres:16-alpine`，库/用户 `rcs`，宿主 5432）。 |
| Redis | 可选 | `RCS_REDIS_URL`。未配置时缓存回退进程内 Map（`apps/server/src/services/cache.ts`），且 Y.Doc 快照**不做持久化**（`packages/chat-channel/src/server/services/doc-manager-instance.ts`：`getRedisConnection()` 为 `null` 即跳过）。仓库自带的编排在 dev（根 `docker-compose.yml`）与生产（`docker/main/docker-compose.yml`）里都内联 `redis`，由 `docker/deploy.env` 的 `FENIX_FEATURE_REDIS` 开关（`--profile redis`）启停，数据各落编排同级的 `./data/redis`。 |
| 外部能力（LiteLLM / Hindsight / RagFlow / Agent Sites / Sandbox） | 可选 | 各自独立编排，未部署只代表对应能力不可用，不阻断主服务启动；入口见 [`docker-topology.md`](./docker-topology.md) §6 的 feature 对照表。 |

## 2. 部署形态

### 2.1 本地源码运行

```bash
docker compose up -d postgres     # 仅数据库
bun install
bun run db:migrate                # DDL 迁移
bash restart-server.sh            # 停掉占用 RCS_PORT 的旧进程 → build:web → bun run dev
```

服务默认在 <http://localhost:3000/>（`RCS_HOST` / `RCS_PORT`）。前端单独热更新用 `bun run dev:web`；但后端挂载的是 `apps/web/dist/`，页面要看到改动必须 `bun run build:web`。

### 2.2 单机 Docker Compose（dev 形态，本地构建）

```bash
docker compose up --build -d
```

访问 <http://localhost:3001/>（编排把宿主 3001 映射到容器 3000）。`rcs` 服务的启动命令是 `bun migrate.js && exec bun --no-install run dist/index.js`：**DDL 迁移先于应用进程**，数据迁移不在这条命令里（见[升级](./upgrade.md)）。

### 2.3 生产编排（`docker/deploy.sh`）

一键入口、配置规范与网络分层见 [`docker-topology.md`](./docker-topology.md)（§6 依赖目录契约、§7 配置、§9 脚本）。最小流程：

```bash
./deploy.sh init               # 生成 deploy.env 与各依赖目录的 .env（已存在则跳过，绝不覆盖）
./deploy.sh validate           # 按提示补齐必填项，直到这一步通过
./deploy.sh deploy             # 拉镜像 → DDL 迁移 → 数据迁移 → 启动
```

- 一套配置描述一台机器：依赖开关在 `docker/deploy.env`，应用配置、密钥与组件自己的编排插值变量（如端口）
  在主服务 env（生产 `docker/main/.env`、dev 仓库根 `.env`），各依赖的私有键在 `docker/<name>/.env`；
  同键只定义一次（[`docker-topology.md`](./docker-topology.md) §8）。
- 主服务编排分两份：**dev** 是仓库根 `docker-compose.yml`（带 `build:`，本地构建），**生产**是 `docker/main/docker-compose.yml`
  （无 `build:`，只用发布镜像，`docker/deploy.sh` 的操作对象）。两份文件同项目名 `fenix`、同网络 `fenix-server`，
  **二选一运行**（同时执行会互相接管容器，见 [`docker-topology.md`](./docker-topology.md) §4）。
- `rcs` 的 `image:` 是固定 tag（当前为 `ghcr.io/huangpustar/fenixagent:sha-da5eb54`），发布时**两份编排的同一行都要改**。
  CI 在 main 与 `v*` tag 上构建并推送镜像（`.github/workflows/docker-publish.yml`，标签含分支名、semver 与 `sha-<commit>`）。
- 数据一律 bind 到各编排同级的 `./data/`：主服务在 dev 落仓库根的 `data/`、`workflow/`、`workspaces/`，生产落
  `docker/main/` 下的同名目录；基础服务（`postgres` / `redis`）落各份编排同级的 `data/{postgres,redis}`，
  依赖自带的实例落各自目录的 `data/` 下。备份 = 打包交付目录，搬迁 = 整目录拷走。
- 可选能力按 `docker/deploy.env` 的 `FENIX_FEATURE_<目录名>` 开关启停，每个依赖是独立的 Compose 项目；
  依赖的对外出口服务接入共享网络 `fenix-server`，栈内辅助服务（数据库、缓存、对象存储等）一般留在自己的项目网络
  （`docker/litellm/` 只有两个服务，`litellm-postgres` 与 `litellm` 同接 `fenix-server`；网络分层见
  [`docker-topology.md`](./docker-topology.md) §3）。
- 依赖实例**随组件自带**，不再有 `docker/common/` 那样的共享实例编排：`docker/litellm/` 自带 `litellm-postgres`
  （库 `litellm`）、`docker/workflow/` 自带 `mysql` 与 `rustfs`（库 `opencoze`、桶 `opencoze` / `milvus`）、
  `docker/ragflow/` 自带 `ragflow-mysql` 与 `ragflow-rustfs`（库 `rag_flow`，桶由 RAGFlow 运行期按知识库 /
  文件目录自建）。数据与凭据都只属于各自目录，跨栈互不影响；依赖仍在**主服务项目之后**启动（`fenix-server`
  由主服务项目创建），库 / 桶的创建由各栈自己承担（镜像初始化时建好，或由它栈内的一次性初始化服务建）。
- 开关只门控该依赖自己那一套编排：`FENIX_FEATURE_WORKFLOW=true` 起的就是 workflow 项目（连同它的 `mysql` /
  `rustfs`），不存在另需打开的共享实例开关。
- 修改主服务 env 或 `docker/deploy.env` 后，`./docker/deploy.sh up` 会声明式收敛；只有依赖目录的
  `docker-compose.yml` 或 `.env` 改动才需要单独重启该项目。
- 本节的命令都在**交付面**里执行，不在仓库工作区里执行——见 §2.4。

### 2.4 交付面：生产不在仓库工作区里跑

```bash
./docker/deploy.sh export /opt/fenix        # 在仓库里执行：产出 /opt/fenix/docker
cd /opt/fenix/docker                        # 之后所有命令在交付面里执行
./deploy.sh init && ./deploy.sh validate && ./deploy.sh deploy
```

为什么必须分家：`docker/**/docker-compose.yml`、`deploy.sh`、`lib/config.sh` 全受版本控制，在仓库里起来的那套
环境会被下一次 `git pull` 就地改写——容器重建时按新编排跑，而配置面（`deploy.env`、各 `.env`）与数据目录还
停在旧结构上，故障现场很难归因。同一份工作区还常被切分支、`checkout`、`clean`，运行中的环境经不起这些动作。

导出口径：

- 交付面 = **受版本控制文件的快照**（`git ls-files docker/`）。本机配置（各 `.env`、`deploy.env`）、数据目录
  （`data/`、`main/workflow`、`main/workspaces`）与运行期产物都在 `.gitignore` 里，因此不进交付面，由目标机上的
  `init` 重新落成。
- 排除两个只在仓库里成立的目录：`dev/`（dev 形态的编排由仓库根 `docker-compose.yml` `include`）与
  `compose-explorer/`（读仓库根的本地只读工具）。
- 目标目录里**已存在的文件一律不覆盖**，内容不同时逐条列出，由人 diff 后决定。升级已部署环境的编排走这一步，
  而不是让导出直接改生产。
- 目标目录不能落在仓库内（脚本直接拒绝）。
- 反过来也拦：`docker/` 在 git 工作区内时，`init` / `validate` / `up` / `deploy` / `config` 被直接拒绝并提示先
  `export`（`down` / `ps` / `logs` 只告警，应急停止不被挡）。判定用 `git rev-parse --show-toplevel`，部署机上
  没有 git 即自动放行——`export` 是唯一允许在仓库里执行的命令。
- `docker/sandbox-dsh/` 无发布镜像、构建上下文是仓库根，交付面里构建不了（见该目录 README）：不用它就让
  `FENIX_FEATURE_SANDBOX_DSH` 保持关闭。

历史部署（`docker/prod/`、`deploy/compose/`、根编排当生产用）迁移到本套部署的完整流程、数据落点映射与
OpenSandbox / 端口等部署注意事项见 `docker/README.md`。

## 3. 环境变量与三份模板

| 文件 | 场景 | 说明 |
| --- | --- | --- |
| `.env.example` | 本地开发（dev）起点 | `cp .env.example .env`；Bun 启动时自动读取仓库根 `.env`，dev 编排（根 `docker-compose.yml`）把它作为 `env_file`。 |
| `docker/main/.env.example` | 生产应用配置起点 | `./docker/deploy.sh init` 会把它复制成 `docker/main/.env`；它就在生产编排同目录，compose 自动加载（不必 `--env-file`）。 |
| `docker/deploy.env.example` | 部署配置起点 | `./docker/deploy.sh init` 会把它复制成 `docker/deploy.env`（依赖开关与主服务可选服务；端口等组件插值键写在该组件自己的 `.env`）。 |

使用口径：

- 三份模板都是**生成物**：键行一律是注释行，取消注释后才生效，未填写的键走代码默认值；密钥类键不写任何取值，真实值来自部署平台的 secret store、K8s/Docker secret 或受控文件。直接手改模板会被 `precheck` 的 `env-example` 步骤（按字节比对）判为漂移。
- 两份应用面模板（`.env.example` 与 `docker/main/.env.example`）覆盖**声明面全量键**，键与逐键说明的真相来源是声明处本身：宿主 `apps/server/src/env.ts` 与各模块 `fenix.module.ts` 的 `envDefinitions`。
- 每个键的元信息行给出「必填／默认值／改值需重启／是否密钥」；**必填 = 未设置即启动失败**。
- 要增删键，改声明处后重新生成：宿主键改 `apps/server/src/env.ts`，有唯一模块 owner 的部署键改对应 `fenix.module.ts` 的 `envDefinitions`，然后执行 `bun run scripts/generate-env-example.ts`。同名键不得在两处声明——`assertNoHostKeyOverride()` 会在启动期直接拒绝。
- 少数键由包直读、未进声明面（`LOG_LEVEL` / `LOG_FORMAT` / `LOG_DIR` / `LOG_RETENTION_DAYS`，消费方 `packages/logger`），它们只出现在两份应用面模板的「声明面之外的键」小节里。
- 密钥纪律：`.env`、`data/password.txt` 一类文件不得进入源码、日志或响应，也不得随普通备份分发。

### 3.1 按部署形态生成自己的环境文件

应用面模板是**清单与逐键说明**，不是可直接加载的配置（键行全部是注释）。按部署形态选一条路径：

1. 本地开发（dev）：`cp .env.example .env`，按需取消注释；Bun 启动时自动读取仓库根 `.env`。
2. 单机 / 生产编排：`./docker/deploy.sh init` 生成模板（已存在则跳过），再填 `docker/main/.env` 的应用配置与密钥，以及 `docker/deploy.env` 的依赖开关。
3. 其他部署平台（K8s、系统服务、受控文件）：以 `docker/main/.env.example`（同键集的完整清单，含元信息行）逐行核对要配哪些键，把**非密钥**项写进部署清单、**密钥**项交给平台的 secret store；不要把它们合并回仓库文件。填完后用「启动日志 + `GET /health`」验证：必填项缺失会在启动期直接失败并指出键名。

## 4. 启动顺序（代码事实）

入口是 `apps/server/src/entry.ts`：先初始化观测 SDK，再动态加载 `apps/server/src/main.ts`。启动序与关闭序集中在 `apps/server/src/bootstrap/host-startup.ts`，两侧都不可重排：

1. `entry.ts` 在任何业务模块首次加载前初始化观测 SDK（未配置 endpoint 时为 No-op），再动态导入 `main.ts`，保证 Pino、PG 与 ioredis 的社区补丁先于业务使用。
2. `main.ts` 首先执行 `interceptConsole()`，统一接管后续 `console.*` 日志。
3. `resolveAssemblyEnv()` 读取装配 profile：路径默认由 `RCS_APPLICATION_ROOT` 决定（镜像 runtime 阶段固定为 `/app`），即 `<root>/deploy/assembly/ce.json`；源码运行时按模块位置反推仓库根。要换别的 profile 就设 `RCS_ASSEMBLY_PROFILE_PATH`（绝对路径，覆盖上面的默认值）。**文件缺失会直接 ENOENT 退出**。profile 只能选择已编译进 `apps/generated/module-registry.ts` 的模块 ID，选择未注册模块会在启动时抛错而不是静默降级。
4. `applyEnv(env)` 之后进入宿主启动序：
   - 关键序列：`initDb` → 模块装配（`wirePermissions`）→ 模型网关（`initModelGateway`，其中包含系统管理员 `ensureSystemAdmin` 与沙盒 provider 投影）。
   - 随后依次是：启动前取数端口绑定 → 沙盒默认池初始化与崩溃恢复 → Core runtime → 调度器（`RCS_DISABLE_SCHEDULER=true` 时跳过启动，注意它**不是**全局只读模式）→ builtin 同步 → 自定义节点工具注册 → Hermes → RagFlow 体检 → 巡检定时器 → 空闲监视。
   - 业务数据迁移**不在**这条序列里，由发布任务承担（见[升级](./upgrade.md)）。
5. 构造 Elysia app：注册观测插件与 `/otel` 浏览器入口、CORS、OpenAPI、`/health`、`/`（302 → `/ctrl/`）、`/ctrl/*` 静态资源、`/web/*`、`/api/*` 以及各模块在装配期登记的顶层协议入口（`/acp/*`、`/hooks/*`、`/workflow-ui/*` 等，通配兜底最后注册），最后 `app.listen({ port, hostname })`。
   前置约束：应用请求体上限为 108MiB，为固定 92MiB 上传文件上限预留 multipart 余量（见 `apps/server/src/plugins/body-limit.ts`）；前置反向代理的请求体上限不得低于 108MiB。WebSocket 消息预算统一为 128MiB，`RCS_WS_MAX_PAYLOAD_MB` 与 `RCS_FILE_WS_MAX_PAYLOAD_MB` 默认及最高允许值均为 128；远程单文件和 ZIP 下载实际大小上限也为 92MiB。主服务与远程 acp-link 需同步更新下载限制，原有大于 128 的 WS 配置值须删除或调低。
6. 关闭：`SIGINT` / `SIGTERM` 触发有界排空：只调用一次 `app.stop(false)` 停止接收新请求并等待活跃请求，5s 超时后不再重复 stop，继续执行 `shutdownHostRuntime`（总预算 10s，逐阶段独立超时，超时只记日志不阻断后续阶段），最后刷新观测 SDK（总预算 5s），由显式进程退出关闭剩余连接。stop/清理失败会使退出码为 1；并发或重复信号只关一次。

## 5. 启动后自检

```bash
curl -s http://<host>:<port>/health
# {"status":"ok","commitId":"<sha>","startedAt":"<iso>","version":"<semver>"}
```

- `commitId` 来自构建期注入的 `GIT_COMMIT_SHA`（本地调试回退 `git rev-parse HEAD`）。用它比对部署的到底是哪个提交：`git rev-parse HEAD`。
- 容器编排的健康检查就是 `GET /health`（编排文件与 `Dockerfile` 的 `HEALTHCHECK` 一致），`docker compose ... ps` 显示 health 状态即可。
- `/health` **只表达进程存活**，不区分「依赖就绪」；当前仓没有 readiness 端点，这一点在 `docs/developer/architecture/engineering-standards.md` §11 中登记为优化项。需要确认依赖可用时，改为观察启动日志中各阶段的 `startupLog` 输出与首个业务请求。
- 首次启动会创建系统管理员 `admin@fenix.com`，初始口令写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE`（默认 `./data/password.txt`）。该文件是敏感产物：读取后应立即改密并按密钥材料保管，不要进日志或普通备份包。

## 6. 静态资源与前端产物

后端从 `apps/web/dist/` 挂载控制台静态资源。只改前端源码而不执行 `bun run build:web`，运行的仍是旧产物——这是本地与生产都容易踩的坑，也是「构建镜像前先 `build:web`」的原因（`docker/build-image.sh` 已把它放进构建流程）。
