# 排障

本页只收已经在本仓被记录或能在代码里核对到的坑，逐条给出「症状 → 定位 → 处置」。通用入口先放在最前面。

## 0. 先看日志与健康状态

- 日志文件：`${LOG_DIR}/rcs.<yyyy-MM-dd>.log`（全量）与 `${LOG_DIR}/rcs.err.<yyyy-MM-dd>.log`（error 及以上）。`LOG_DIR` 默认是**相对进程 cwd 的** `logs`——容器里 cwd 是 `/app`，所以是 `/app/logs`；`LOG_RETENTION_DAYS`（默认 30）在跨日时清理过期文件，排障要看旧日志请先确认它还在。
- 日志级别：`LOG_LEVEL=debug` 才会输出前端轮询、WebSocket/ACP/file-ws 连接与消息路由等 debug 内容（清单见 `packages/logger/src/index.ts` 文件头）。
- 控制台/接口读取：`GET /api/system/logs`（列举白名单化的日志源）、`/api/system/logs/search`、`/api/system/logs/download`（导出同一投影的 JSON Lines），需要系统 key（`RCS_SYSTEM_API_KEYS`）。响应里只有服务端枚举出的 `sourceId`，不接受文件名或路径。
- 存活与版本：`curl -s http://<host>:<port>/health` → `status` / `commitId` / `startedAt` / `version`；`commitId` 与 `git rev-parse HEAD` 对照可确认跑的是哪个版本。

```bash
docker compose logs -f --tail=200 rcs                        # 容器形态（仓库根）
tail -f logs/rcs.$(date -u +%F).log                          # 源码形态
```

## 1. 端口占用 / `EADDRINUSE`

**症状**：启动或新建本地 Agent 实例时报端口被占用；`8888–8999` 段被别的东西占着；生产上表现为本地执行反复失败。

**背景（代码事实）**：本地引擎（peri / opencode / ccb）现在是在**宿主进程内**启动 acp-link WS 服务器（`packages/plugin-peri/src/process/acp-link-process-manager.ts` 等，注释写明「不再 spawn 子进程」），端口由 `PortAllocator` 在 `8888–8999` 内探测分配（`packages/plugin-peri/src/process/port-allocator.ts`，段满抛 `No available port in range 8888-8999`）。远端执行节点侧仍是独立进程（机器上跑 `acp-runtime.js` 作为 acp-link 客户端，例如 `docker/sandbox-dsh/README.md`）。**服务重启不会自动清理这些进程**：机器侧的旧进程、以及历史架构留下的独立 acp-link 进程，都可能在重启后继续占着端口。

**定位**：

```bash
lsof -nP -iTCP -sTCP:LISTEN | grep -E ':(88[0-9]{2}|89[0-9]{2})'
ps aux | grep -iE 'acp-link|acp-runtime' | grep -v grep
lsof -tiTCP:$RCS_PORT -sTCP:LISTEN      # 宿主/容器主端口是否被别的进程占着
```

**处置**：先确认占用者的归属——监听在 `127.0.0.1:88xx` 的 `bun` 进程属于本 RCS 进程内的 acp-link；机器上独立的 `acp-runtime` 属于对应执行节点。按归属清理残留进程（或用 `bash restart-server.sh` 停掉占用 `RCS_PORT` 的旧进程），再重试；不要指望重启 RCS 会顺带回收机器侧进程。

## 2. relay 断连不等于终止 Agent 子进程

**症状**：前端显示会话/实例断开，但机器上 Agent 进程仍在跑并占资源；或者以为「关掉页面/断开 WebSocket」就能释放实例，结果实例与端口一直活着。

**背景**：relay 断连只关闭连接，**不等于**终止 Agent 子进程；实例释放必须走对应的生命周期管理。本地节点的 stub 信道刻意「恒 connected」以免节点级断连把健康实例误标 error，实例级死亡由 relay 死亡信号触发 `terminateLocalDeadInstance`（`packages/resources/machine/src/services/local-node-service.ts` 文件头注释）。实例生命周期的权威入口是 `AgentInstanceRuntimeCoordinator`（`ensureRuntime` / `restartRuntime` / `stopRuntime` / `deleteRuntime`，`packages/agent-runtime/src/server/services/agent-instance-runtime-coordinator.ts`）。

**定位**：先用 `/health` 与实例管理入口确认实例状态，再看机器侧进程与端口（同上一节命令）。

**处置**：需要回收就在实例管理入口执行 stop/delete（或对应的沙盒/机器侧停止动作），不要靠关连接或杀 WS 代替。

## 3. 配了远程 Machine，文件操作报 503 / 422

**症状**：环境绑定了执行节点，但文件列表、上传、下载等操作返回 `503 file_service_unavailable`；或返回 `422 config_error`。

**背景（`packages/resources/machine/src/server/services/remote-file-service.ts`）**：`getRemoteMachineId` 有明确的三分语义——没配 machineId → 走本地 FS；**配了 machineId 但不在 DB machine 表里 → 422 config_error**（配置错误）；**配了且在表里但 file-ws 未连接 → 503**，此时明确拒绝本地回退，避免「以为文件在远程、实际落在本地」的分裂场景。路由优先级是「显式 Machine（`agentConfig.machineId`）> Sandbox Instance Machine > 默认 Machine（`RCS_DEFAULT_MACHINE_ID`）> 本地 FS」；`RCS_DEFAULT_MACHINE_ID` 指向的默认机器由宿主启动引导 `ensureDefaultMachine` 自动补齐（`apps/server/src/services/core-bootstrap.ts`）。

**定位**：

```bash
psql "$DATABASE_URL" -c "select id, machine_info from machine order by id;"   # 机器是否登记
docker compose logs --tail=200 rcs | grep -i "file-ws"
```

**处置**：503 先恢复 file-ws 连接（机器侧重启/重连对应运行时）；422 则去机器管理面确认该 ID 是否存在或是否写错。**不要**通过删除 `machineId` 让它“回落本地”来掩盖问题——那会把用户在远程的预期悄悄改成落到平台机器上。

## 4. workspace 路径与实际目录对不上

**症状**：Agent 在某个目录里执行，用户却在别处找不到文件；或换机器/换部署后老工作区“消失”。

**背景**：DB 的 `workspacePath` 是**历史字段，不得用于推导真实目录**；真实路径运行时按 `{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}` 计算，未设置 `WORKSPACE_ROOT` 时回落 `<进程 cwd>/workspaces`（`apps/server/src/bootstrap/workspace-path.ts`）。浏览器传入的 workspace/cwd 不可信，ACP action 的 `cwd` 由服务端按已认证的 environment 注入。

**定位**：`echo $WORKSPACE_ROOT`（或容器内 cwd 推导），再看实际落盘：`ls <WORKSPACE_ROOT>/<orgId>/<userId>/`。

**处置**：以 `WORKSPACE_ROOT`（或 cwd 默认值）为准排查目录；迁移部署时确认该目录已被挂载（见[备份与恢复](./backup-and-restore.md) 第 3 节的挂载表）——prod 编排默认并不挂载它。

## 5. 改了前端却看到旧页面

**症状**：源码改了、服务重启了，页面还是旧的；或部署后样式/接口对不上。

**背景**：后端从 `apps/web/dist/` 挂载控制台静态资源，前端源码改动必须重新构建才生效。

**处置**：`bun run build:web` 后重启服务（`bash restart-server.sh` 已包含 `build:web`）；镜像构建流程同样先构建前端（`build-image.sh`）。

## 6. 数据迁移没有执行 / 被跳过

**症状**：新版本起来了，但数据还是旧的；或日志里只有 `skip applied migrate '...'`。

**背景**：应用进程启动**不执行**数据迁移——它只属于发布步骤（见[升级](./upgrade.md)）。已应用的迁移按 `data_migrate_record.name` 跳过，这是幂等判据：迁移 ID 一旦落库就是发布契约，改名会被判为未应用而重跑。

**定位**：

```bash
psql "$DATABASE_URL" -c 'select name from data_migrate_record order by name;'
grep -n "MIGRATIONS" -A 6 apps/server/src/services/data-migrate.ts    # 本次版本的注册表
```

**处置**：缺哪支补跑哪支（`bun run run-data-migrations`）；出现「注册表里有、但记录里没有且不执行」时看依赖报错——`dependsOn` 缺失是失败而不是跳过。若记录里有本次注册表**没有**的名字，说明 ID 被改名或移除，需要人工核对后再动，别直接删记录。

## 7. `db:generate` 生成了删表迁移

**症状**：没动某张表，生成的迁移里却出现 `DROP TABLE`。

**背景**：`drizzle.config.ts` 的 `schema` 列表必须声明**全部** owner 包路径与宿主 schema；漏声明一族，`db:generate` 会把那一族判为已删除。

**处置**：先补齐 `drizzle.config.ts` 的声明，删掉误生成的迁移文件与 snapshot 后重新生成；提交前用 `bun run check:schema-ddl-drift` 验证「表定义换手不改 DDL」。

## 8. 迁移报 `already exists`

**症状**：`migrate.js` 输出 `... already exists` 并失败。

**背景**：这个错误**就是真实失败**，不是「库是 db:push 建的」的信号——把它当成功的历史容忍已删除（`scripts/migrate.ts` 文件头说明了原因与当时的真实诱因：并发 DDL 现在由 `pg_advisory_lock` 串行化）。常见成因是上次迁移部分执行后留下不一致状态。

**处置**：按 `drizzle/README.md` 场景三核对「库真实结构 / `drizzle."__drizzle_migrations"` 记录 / 仓库迁移文件」三处，编写补偿 SQL 后再重跑；历史 `db:push` 库走场景 3.4 的显式基线化。**不要**把这个错误过滤掉继续发布。

## 9. 日志不见了

**症状**：容器重建后日志没了；或本地服务在 `logs/` 里找不到今天的文件。

**背景**：`LOG_DIR` 默认相对进程 cwd；日期段按 **UTC** 切分（`new Date().toISOString().slice(0,10)`），跨日才切换文件；超过 `LOG_RETENTION_DAYS`（默认 30）的文件在跨日时清理。挂载上，顶层 `docker-compose.yml` 不挂 `logs`（容器重建即丢）——见[备份与恢复](./backup-and-restore.md) §3。

**处置**：容器形态固定 `LOG_DIR=/app/logs` 并挂载该目录；排障前先确认时区与日期段（UTC），再确认文件还在保留期内。

## 10. Chat 刷新恢复 / 多标签页异常

**症状**：刷新后历史内容残缺；多标签页状态不一致；或者以为快照丢了就等于会话丢了。

**背景**：

- 快照持久化需要 Redis（`RCS_REDIS_URL`）。未配置时 `getRedisConnection()` 为 `null`，DocManager 直接跳过持久化——**队列里的快照没有落盘**，刷新恢复只能依赖进程内存与 Agent 侧回放。
- 快照本身**不是权威**：节流窗口内崩溃会丢窗口内的更新，权威是 Agent 侧 ACP session 历史，可经 `load_session` 回放重建（`packages/chat-channel/src/persist/redis.ts` 文件头）。
- 参数旋钮：`RCS_YJS_SNAPSHOT_INTERVAL_MS`（默认 2000，trailing 节流窗口）、`RCS_YJS_SNAPSHOT_IDLE_MS`（默认 500，静默期）、`RCS_YJS_SNAPSHOT_TTL_SECONDS`（默认 604800，滑动 TTL）、`YJS_MAX_CLIENTS`（默认 200，WebSocket 连接上限）。

**处置**：先确认是否配置了 Redis 及其连通性；再按上面的旋钮核对是否被改小到影响体验；多标签页问题先确认是否超出 `YJS_MAX_CLIENTS`。

## 11. 定时任务不执行

**症状**：设了定时任务但不跑。

**背景**：`RCS_DISABLE_SCHEDULER=true` **只**跳过启动期的 `schedulerService.start()`，它不是全局只读模式（`apps/server/src/bootstrap/scheduler-startup.ts`）。

**处置**：确认该变量取值与进程实际环境（容器 `environment` 优先于 `env_file`）；容器改配置后需要重建容器才生效。

## 12. RagFlow / Hindsight / 模型网关连不上

**症状**：知识库或记忆能力报连接失败。

**背景**：它们都是**独立编排**（`docker/<name>/docker-compose.yml`，由 `docker/deploy.env` 的 feature 开关启停），主服务必须通过 rcs 容器**可路由**的地址访问，不能写 `localhost`：同机部署用共享网络 `fenix-server` 上的服务名（如 `http://ragflow:9380`），跨机部署用宿主可达地址。连不上也可能不是地址问题：这三者都消费 `docker/common/` 的共享实例（ragflow 只消费其中的 `mysql`——它的对象存储是自带实例，见[编排体系](./docker-topology.md) §5），栈没起来时先在 §15 看它的一次性初始化服务。

**处置**：改成容器网络内可解析的地址（或宿主可达 IP），改完重建 `rcs` 容器：`docker compose up -d rcs`（仓库根）。网络分层见[编排体系](./docker-topology.md) §3。

## 13. 切换默认执行节点后出现重复连接

**症状**：同一个 `RCS_MACHINE_ID` 有两个节点同时连上来；或新节点没接管、旧节点还在接流量。

**背景**：用 Sandbox 替代本机节点时，需要同时设置 `RCS_DEFAULT_MACHINE_ID` 与 `RCS_DISABLE_LOCAL_EXECUTION=true`，Sandbox 的 `RCS_SECRET` 必须与主服务的 `REGISTRY_SECRET` 一致，`RCS_MACHINE_ID` 必须与 `RCS_DEFAULT_MACHINE_ID` 一致（各 sandbox 目录的 README，见[编排体系](./docker-topology.md) §6）。

**处置**：**先起新节点并确认已连接，再停旧节点**，避免同一个 `RCS_MACHINE_ID` 重复连接。

## 14. 改了配置但行为没变

**症状**：改了 `.env` 里的某个键，服务行为不变。

**背景**：模板里标了「改值需重启」的键在**装配期**被固化——它们参与模块配置投影，不是运行期热读；容器形态下 `.env` 也不等于进程环境（`environment` 段优先于 `env_file`）。

**处置**：改完环境文件后重建容器（`up -d rcs`）或重启进程；确认取值来自哪一层（编排 `environment` / `env_file` / 平台 secret store）。注意宿主与模块**同名键不得两处声明**，`assertNoHostKeyOverride()` 会在启动期直接拒绝——若启动即失败，先看这条错误。

## 15. 共享实例没起来 / 栈内初始化服务失败

**症状**：依赖栈的主服务（`ragflow`、`coze-server`、`litellm`）没起来或反复重启；起来了但报连不上库 / 桶；
主服务侧调用对应能力（知识库、工作流、模型网关）失败。

**背景**：`docker/common/` 的四个服务是**共享实例**（`postgres` / `redis` / `rustfs` / `mysql`），只提供实例、不做
任何栈的业务初始化；库、账号、桶由消费方**栈内的一次性初始化服务**创建（`docker/workflow/` 的 `mysql-init` /
`s3-init`、`docker/ragflow/` 的 `ragflow-mysql-init` / `ragflow-s3-init`、`docker/litellm/` 的 `litellm-db-init`）。
`docker/ragflow/` 有一处不同：它的对象存储是**本栈自带实例** `ragflow-rustfs`（不接 `fenix-server`、不受
`FENIX_FEATURE_S3` 影响），它的 `ragflow-s3-init` 探测的是这个实例，就绪由同项目的 `service_healthy` 保证——
见[编排体系](./docker-topology.md) §5。初始化非 0 退出时，依赖它的主服务不会启动——这是设计行为，不是
「容器没拉起来」。跨项目的 `depends_on` 不成立，
所以「共享实例是否就绪」是初始化服务自己等的（带超时，失败时按分支给判定）。

**定位**（先看退出码，再看日志末行）：

```bash
docker ps -a                      # 一次性服务必须 Exited (0)；非 0 时它依赖的栈内主服务会缺位或反复重启
docker compose -f docker/workflow/docker-compose.yml ps -a mysql-init s3-init
docker compose -f docker/litellm/docker-compose.yml ps -a litellm-db-init
docker compose --env-file docker/ragflow/.env --env-file ./.env \
  -f docker/ragflow/docker-compose.yml ps -a            # 两个初始化服务 + ragflow

# 日志末行就是结论：脚本按阶段（①②③④）输出，失败时给原始报错 + 判定分支
docker compose -f docker/litellm/docker-compose.yml logs --tail=50 litellm-db-init
docker compose --env-file docker/ragflow/.env --env-file ./.env \
  -f docker/ragflow/docker-compose.yml logs --tail=50 ragflow-mysql-init ragflow-s3-init
# workflow 要带上游 .env，命令照该目录 README §6

# 共享实例自己：开关没开时它直接缺位（postgres 恒启动，其余看 FENIX_FEATURE_*）
docker compose -f docker-compose.yml ps postgres mysql rustfs redis
```

**处置**（按日志末尾给出的判定分支走）：

| 判定 | 处置 |
| --- | --- |
| 实例不可达 | 对应开关是否打开（`FENIX_FEATURE_MYSQL` / `FENIX_FEATURE_S3`；`postgres` 恒启动；ragflow 的**对象存储**不需要开关，它自带实例，改为看 `docker compose -f docker/ragflow/docker-compose.yml ps ragflow-rustfs`）、顶层项目是否已起（`fenix-server` 由它创建，依赖只引用）、消费方容器是否真在 `fenix-server` 上（`docker network inspect fenix-server`） |
| 认证失败 | 实例里已有的账号口令与 `.env` 不一致——口令写在实例的数据目录里，改 `.env` 不会改库里已有的账号；workflow 还要核对上游 `docker/.env` 的同名键（两处必须同值） |
| 账号 / 库已存在但口令不同 | 幂等初始化只同步**自己那本账**的口令：把 `.env` 改对后重跑初始化服务（`up -d --force-recreate <init 服务>`），不要进库手工 `ALTER` |
| 建桶被拒 / 桶不属于当前凭据 | 共享实例（workflow）：根 `.env` 的 `RUSTFS_ACCESS_KEY` / `RUSTFS_SECRET_KEY` 与实例启动时用的那份不一致；或该桶由同一实例上的另一对凭据创建。ragflow 的本栈自带实例：凭据在本目录 `.env` 的 `RAGFLOW_S3_ACCESS_KEY` / `RAGFLOW_S3_SECRET_KEY`（改完要重建 `ragflow-rustfs` 才生效）。独立部署时最常踩：漏了 `--env-file ./.env`，compose 退回编排里的默认凭据 |

重跑初始化服务是**常规收敛路径**（幂等，不动既有数据）；不要用「手工建库 / 手工建桶」绕过它——下次重跑会与手工结果
漂移，而且失败原因（配置没打开、口令不一致、服务名解析不到）会被掩盖。共享实例的数据落点在
`docker/common/data/**`，进容器前先确认你要看的数据确实在那里（[备份与恢复](./backup-and-restore.md) §3）。
