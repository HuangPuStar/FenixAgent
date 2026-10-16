# 升级

升级的核心约束是一条顺序：**DDL 迁移 → 数据迁移 → 新版本应用进程**。顺序颠倒会因为缺列/缺表直接失败（fail-stop，不会静默跳过），而数据迁移提前跑在多副本上则不是纯 DB no-op。

## 1. 发布顺序

| 步骤 | 入口 | 前置条件 |
| --- | --- | --- |
| 1. DDL 迁移 | 镜像内 `bun migrate.js`（`Dockerfile` 的 `migrate` 阶段 / 应用镜像内同名文件）；源码形态是 `bun run scripts/migrate.ts`（与 `migrate.js` 同一脚本） | 能连到 `DATABASE_URL`；未设置时入口直接退出 1 |
| 2. 数据迁移 | 镜像内 `bun data-migration-runner.js`（`Dockerfile` 的 `data-migrate` 阶段）；源码形态是 `bun run run-data-migrations` | DDL 已完成；与应用**相同**的环境变量与**相同**的数据卷 |
| 3. 应用进程 | `bun dist/index.js` | 上两步退出码均为 0 |

`bun run db:migrate`（drizzle-kit）应用的是同一条 `drizzle/` 迁移链，但它缺 `DATABASE_URL` 时会回落到本地默认
连接串，因此**不在发布顺序里**；两者差别见[迁移](./migration.md)。

这条顺序在 `Dockerfile` 的两个构建阶段（`AS migrate` / `AS data-migrate`）、`db/data-migration-runner.ts` 的文件头与 `apps/server/src/bootstrap/host-startup.ts` 的启动序注释里都写明了。

这条顺序有两条执行路径，按部署形态选：

| 路径 | 命令 | 说明 |
| --- | --- | --- |
| 容器（单机 prod） | 交付面里的 `./deploy.sh deploy` | 一次跑完三步：`docker compose pull rcs` → `docker compose run --rm rcs bun migrate.js` → `docker compose run --rm rcs bun data-migration-runner.js` → `./docker/deploy.sh up`。每一步前一步非零退出就不进入下一步，失败输出给出「在哪一步失败、失败原因、可重跑性」，进程退出码非 0 |
| 源码 | 见 §3 | 三步分别手工执行 |

注意两个**不要**：

- 不要像 `migrate.js` 那样把数据迁移写进容器启动命令：那会让每个副本各跑一次含文件副作用的迁移。
- 不要靠「应用进程启动会跑迁移」来交付数据迁移：宿主启动序里没有它。
- **较旧的发布镜像没有独立数据迁移入口**（`data-migration-runner.js` 是后来才随镜像发布的，旧版本在应用启动时自行执行
  数据迁移）：`deploy.sh` 检测不到该文件会打印「跳过本步」继续启动，属预期行为，不是迁移被静默吞掉
  （见 [`docker-topology.md`](./docker-topology.md) §10）。升级到带入口的镜像后这一步自动恢复。

## 2. 镜像升级（容器编排）

```bash
# 0) 备份（后续步骤可能包含不可逆迁移），见 备份与恢复
# 1) 更新 docker/main/docker-compose.yml 的 rcs image: 到目标版本 tag（进版本控制、经评审合入；仓库根 dev 编排的同一行同步更新）
# 2) 同步交付面到部署机（生产不在仓库工作区里跑，见 部署 §2.4）：在仓库执行 ./docker/deploy.sh export <目标目录>，
#    在部署机上 diff 核对被跳过的文件后再进入下一步
# 3) 迁移 + 启动：一条命令跑完三步。本节命令都在交付面的 docker/ 目录里执行（仓库里会被守卫拒绝）
./deploy.sh deploy
```

配套事实：

- 应用容器自身的启动命令仍会跑一次 `bun migrate.js`，多副本同时启动由 `pg_advisory_lock` 串行化（锁 key 是 `scripts/migrate.ts` 里的常量），因此第 2 步与容器启动重叠也不会互相撞车；把迁移单独跑出来的价值是**让迁移失败早于流量切换暴露**。
- 核对本机实际版本用 `./deploy.sh ps`（镜像 tag/digest 可见）。
- 离线交付：`docker/build-image.sh` 构建 runtime 镜像并 `docker save` 成 tar（脚本末尾打印目标机 `docker load` 命令）。
- 依赖（litellm / hindsight / ragflow / sandbox 节点等）与主服务是独立升级单元：默认只在 `deploy` 时 `pull` 并收敛主服务，依赖按自己的目录单独 `docker compose up -d`。Hindsight 一类需要经 `fenix-server` 访问主服务的依赖，重建顺序仍要先主后附。
- **依赖实例口径**：每个依赖栈自带依赖实例，库与桶都不在主服务这边——`docker/litellm/` 自带 `litellm-postgres`（库 `litellm`，`DATABASE_URL` 指向 `litellm-postgres:5432`）、`docker/workflow/` 自带 `mysql` 与 `rustfs`（库 `opencoze`、桶 `opencoze` / `milvus`）、`docker/ragflow/` 自带 `ragflow-mysql` 与 `ragflow-rustfs`（库 `rag_flow`，桶由 RAGFlow 运行期按知识库 / 文件目录自建）；数据各落自己目录的 `./data/` 下。升级依赖时按该目录单独 `up -d` 收敛，栈内的一次性初始化服务随它一起跑（幂等：只建缺失的库 / 桶、只同步口令，不动既有数据；ragflow 侧不预建桶，它的 `ragflow-s3-init` 只对自带实例做能力探测），失败则该栈的主服务不启动；判定看 `docker ps -a` 里的 `Exited (0)` 与日志末行的完成行（[排障](./troubleshooting.md) §15）。**workflow 侧自 2026-10-14 起多两个前置一次性服务**：`assets-init` 先从 server 镜像展开初始化资产（因此 `WORKFLOW_STUDIO_TAG` 不得低于带资产的首个发布），`atlas-init` 再做 schema 收敛——升级时换 tag 后重跑 `up -d` 即可，它的数据目录已随交付面收到 `docker/workflow/data/`（搬迁口径见该目录 README §8、编排体系 §13.21）。
- **回滚到旧编排要多读一件事**：回退到共享实例时代的编排（`docker/common/` 提供 `postgres` / `redis` / `mysql` / `rustfs`，各栈接入消费）时，数据仍在**旧数据目录**里（共享实例的 `docker/common/data/{postgres,mysql,rustfs}`，以及更早的各栈自带实例落点 `docker/ragflow/ragflow_mysql_data`、`ragflow_minio_data`、`<上游源码目录>/docker/data/minio`（`<上游源码目录>` 指旧部署里的上游源码 clone，若沿用旧文档口径即 `/opt/workflow-studio`）、litellm 旧实例的 bind 目录，以及 Workflow 栈内服务的旧数据目录 `<上游源码目录>/docker/data/` 下的 `bitnami/{elasticsearch,redis,etcd}` 与 `milvus`（后者自 2026-10-14 起滚进 `docker/workflow/data/`，见 `docker/workflow/README.md` §8）），所以旧目录在那次迁移验收通过并跑过一个业务周期之前不删——删了就只能从备份恢复（保留与可删条件见[备份与恢复](./backup-and-restore.md) §2 与各目录 README）；不存在「把共享实例里的数据搬回各栈」的自动路径。
- 回滚同样只改这一行：把 `image:` 改回上一个 tag，再 `./deploy.sh up`（必要时先按 §1 跑迁移回滚口径，见 §5）。

## 3. 源码升级（本地 / 单机）

```bash
git pull
bun install
bun run scripts/migrate.ts    # DDL（与镜像内 migrate.js 同一入口；本地开发改结构时仍可用 bun run db:migrate）
bun run run-data-migrations   # 数据迁移（幂等，已应用项按 data_migrate_record 跳过）
bun run build:web             # 前端有改动时必须，后端挂载 apps/web/dist
bash restart-server.sh
```

容器形态的单机升级改用统一入口 `./docker/deploy.sh deploy`（§1），它把上面前两步与主服务收敛串成一条
失败即停的序列。

## 4. 迁移失败的判定

| 环节 | 失败表现 | 含义与处置 |
| --- | --- | --- |
| DDL 迁移 | 日志 `[migrate] DDL 迁移失败：<原因>` 或 `[migrate] 连接数据库或获取迁移锁失败：…`，退出码 1 | 迁移入口已**不再**把 `already exists` 当成功，任何失败都非 0。先看诊断里的 `Caused by` 链，再按 `drizzle/README.md` 场景三核对「库真实结构 / `drizzle."__drizzle_migrations"` 记录 / 仓库迁移文件」三处。 |
| 数据迁移：依赖未满足 | `[data-migrate] 迁移 'X' 的依赖未完成：…` | 报错会区分「依赖在本次注册表内但尚未落库」（执行失败，补跑即可）与「依赖不在注册表内」（ID 被改名或移除，需人工核对，因为迁移 ID 是发布契约）。 |
| 数据迁移：run / verify 失败 | `[data-migrate] 数据迁移失败，后续迁移不再执行：…`，退出码 1 | 后续迁移不执行、**不写完成记录**；失败前会按迁移声明的 `compensation` 做补偿，补偿自身的失败只记录不掩盖原始错误。 |
| 迁移记录已落库但应用读不到迁移后文件 | 数据迁移的典型症状：文件卷与迁移进程挂载不一致 | 记录写入使重跑变成跳过，无法自愈——这正是「数据迁移必须与应用共用同一数据卷」的原因。 |

重跑是常规收敛路径：`data_migrate_record` 里已有的名字会被跳过，契约要求每个迁移的 `run` 幂等，`compensation.kind: "none"` 的迁移就是靠幂等重跑收敛到完成态。

## 5. 回滚边界

**可以回滚**：

- 应用镜像 / 代码回滚到上一个 tag 或提交，前提是该版本之后**没有应用过不可逆迁移**，且没有执行过 `compensation: "none"` 的数据迁移。
- DDL 回滚：靠人工编写补偿 SQL 并核对迁移记录，口径见 `drizzle/README.md` 场景三（先回滚结构，再删记录；伴随数据写入的迁移不能只回滚 DDL）。
- 依赖编排回滚到共享实例时代的版本：把该目录的 compose 与镜像 tag 换回旧版本即可，**前提是旧数据目录还在**（见 §2 的第 3 条）——旧编排读的是 `docker/common/data/**` 与各目录的旧落点，与新编排各栈自带的实例数据互不影响。

**不可回滚**（本仓现状）：

| 类型 | 具体案例 | 为什么不可回滚 |
| --- | --- | --- |
| DDL：删表 | `drizzle/0023_agent-instance.sql` 的 `DROP TABLE IF EXISTS "scheduled_task"` | 表与数据一起消失，只能从备份恢复。 |
| DDL：删列 | `drizzle/0025_remove-environment-max-sessions.sql`（`environment.max_sessions`）、`drizzle/0003_skill-storage-by-org.sql`（`skill.content_path`）、`drizzle/0004` / `0006`（`agent_config` 若干列）、`drizzle/0001`（`provider."npm"`） | 列内数据被丢弃；回滚镜像不会把列变回来。 |
| 数据迁移 | `migrate-skill-storage-by-organization`（搬 skill 文件并删除旧目录）、`migrate-agent-config-model-id`（清空旧 `model` 原文） | 两者都声明 `compensation.kind = "none"`：旧副本被删除，补偿等于销毁唯一副本；失败后靠幂等重跑收敛。 |

回滚前必须确认的四件事：

1. 该版本区间的迁移链里有没有 `DROP TABLE` / `DROP COLUMN`（`grep -n "DROP " drizzle/*.sql` 即可看到全部候选，含上表列出的历史节点）。
2. `data_migrate_record` 里有没有本版本引入的迁移记录——**记录一旦写入即为「已应用」，回滚镜像不会撤销它**，旧代码配新数据形态要单独确认兼容性。
3. 备份点是否覆盖到该迁移之前的时点（见[备份与恢复](./backup-and-restore.md)）。
4. 对外契约（`/api/*` 等）是否需要按协议单独评估兼容性，而不是跟着内部实现一起回滚。

不可逆案例的完整清单与注意事项见[迁移](./migration.md#_4-不可逆迁移)。

## 6. 升级检查清单

- [ ] 备份点已建立，且恢复路径可用（数据库 + `SKILL_DIR` + `WORKSPACE_ROOT` 等文件目录）。
- [ ] 新版本镜像 tag 与 `GIT_COMMIT_SHA` 已记录，便于与 `/health` 的 `commitId` 对照。
- [ ] 本次迁移链中是否包含不可逆步骤已确认，回滚边界已写明。
- [ ] DDL 迁移退出码 0；日志含 `[migrate] DDL 迁移已全部应用。`
- [ ] 数据迁移退出码 0；逐条核对了元信息行（预期数据量 / 锁风险 / 可观测字段）与迁移自己输出的实际影响行数。
- [ ] 本次升级若重建了依赖栈（`ragflow` / `workflow` / `litellm`）：栈内一次性初始化服务是 `Exited (0)`、日志末行是完成行（`docker ps -a`；失败时该栈主服务不会启动）。
- [ ] 应用启动后 `/health` 返回 `status: "ok"`，`commitId` 为新版本。
- [ ] 关键路径抽查：一次交互式 Chat、一次外部 API 调用（或工作流/定时任务，按本次改动范围选择）。
