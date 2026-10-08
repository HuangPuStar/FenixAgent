# 升级

升级的核心约束是一条顺序：**DDL 迁移 → 数据迁移 → 新版本应用进程**。顺序颠倒会因为缺列/缺表直接失败（fail-stop，不会静默跳过），而数据迁移提前跑在多副本上则不是纯 DB no-op。

## 1. 发布顺序

| 步骤 | 入口 | 前置条件 |
| --- | --- | --- |
| 0. 部署面校验 | 源码形态是 `bun run release --check`（改过模块声明或装配 profile 时先 `bun run release` 重新生成产物） | 无需数据库与容器；退出码非 0 即停，不进入第 1 步 |
| 1. DDL 迁移 | 镜像内 `bun migrate.js`（`Dockerfile` 的 `migrate` 阶段 / 应用镜像内同名文件）；源码形态是 `bun run scripts/migrate.ts`（与 `migrate.js` 同一脚本） | 能连到 `DATABASE_URL`；未设置时入口直接退出 1 |
| 2. 数据迁移 | 镜像内 `bun data-migration-runner.js`（`Dockerfile` 的 `data-migrate` 阶段）；源码形态是 `bun run run-data-migrations` | DDL 已完成；与应用**相同**的环境变量与**相同**的数据卷 |
| 3. 应用进程 | `bun dist/index.js` | 上两步退出码均为 0 |

`bun run db:migrate`（drizzle-kit）应用的是同一条 `drizzle/` 迁移链，但它缺 `DATABASE_URL` 时会回落到本地默认
连接串，因此**不在发布顺序里**；两者差别见[迁移](./migration.md)。

这条顺序在 `Dockerfile` 的两个构建阶段（`AS migrate` / `AS data-migrate`）、`db/data-migration-runner.ts` 的文件头与 `apps/server/src/bootstrap/host-startup.ts` 的启动序注释里都写明了。

在迁移之前还有一道**部署面校验**（第 0 步，部署入口 `release`）：它不读数据库、不启停容器，价值全在失败判断——
按 `deploy/assembly/<profile>.json` 校验模块 ID 已注册、`kind` 匹配槽位、`dependsOn` 闭包与 capability 唯一，
按各模块 manifest 校验依赖服务与健康检查齐备，并用字节比对拦住「声明改了、`deploy/manifests/` 与
`deploy/compose/overlays/` 没跟上」的漂移。装不起来的发布组合必须在迁移与部署之前失败，而不是等容器启动才抛错。

这条顺序有两条执行路径，按部署形态选：

| 路径 | 命令 | 说明 |
| --- | --- | --- |
| 源码 / 单机（新部署面 `deploy/compose`） | `bun run release --deploy` | 一次跑完上表第 0～2 步，再接容器部署（即第 3 步的应用进程）：部署面校验 → DDL 迁移（`bun run scripts/migrate.ts`）→ 数据迁移（`bun run run-data-migrations`）→ 容器部署（命令取自 `deploy/manifests/profiles/<profile>.json` 的 `compose.up`）。前一步非零退出就不进入下一步，失败输出给出「在哪一步失败、失败原因、可重跑性」，进程退出码非 0 |
| 镜像升级（`docker/prod/`） | 见 §2 | 迁移用镜像的 `migrate` / `data-migrate` 阶段单独跑，应用进程由编排拉起；`--deploy` 走的是 `deploy/compose/base.yml`，不驱动这套编排 |

`release` 默认仍然**只做生成与校验**（不带开关时生成部署面，`--check` 只校验，`--check` 与 `--deploy` 互斥）：
迁移与容器启停都委托既有权威入口（`scripts/migrate.ts`、`db/data-migration-runner.ts`、部署视图里的
`docker compose ... up -d`），本仓不为这两步再实现第二套机制。

注意两个**不要**：

- 不要像 `migrate.js` 那样把数据迁移写进容器启动命令：那会让每个副本各跑一次含文件副作用的迁移。
- 不要靠「应用进程启动会跑迁移」来交付数据迁移：宿主启动序里没有它。

## 2. 镜像升级（`docker/prod/` 编排）

```bash
# 0) 备份（后续步骤可能包含不可逆迁移），见 备份与恢复
# 1) 更新 docker/prod/docker-compose.yml 的 image: 到目标版本 tag
# 2) DDL 迁移：用新版本的 migrate 阶段镜像
docker build -f Dockerfile --target migrate -t fenix-migrate:<tag> .
docker run --rm -e DATABASE_URL=<连接串> fenix-migrate:<tag>
# 3) 数据迁移：用新版本的 data-migrate 阶段镜像，注入与应用相同的 env、挂载相同的数据卷
docker build -f Dockerfile --target data-migrate -t fenix-data-migrate:<tag> .
docker run --rm -e DATABASE_URL=<连接串> -e RCS_API_KEYS=<密钥> \
  -v <宿主数据目录>:/app/data fenix-data-migrate:<tag>
# 4) 启动新版本应用
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml up -d
```

配套事实：

- 应用容器自身的启动命令仍会跑一次 `bun migrate.js`，多副本同时启动由 `pg_advisory_lock` 串行化（锁 key 是 `scripts/migrate.ts` 里的常量），因此步骤 2 与步骤 4 重叠也不会互相撞车；把第 2 步单独跑出来的价值是**让迁移失败早于流量切换暴露**。
- 离线交付：`build-image.sh` 构建 runtime 镜像并 `docker save` 成 tar（脚本末尾打印目标机 `docker load` 命令）。
- 可选编排（litellm / hindsight / ragflow / opencode）与主服务是独立升级单元，主服务重启不会顺带升级它们；Hindsight 依赖主编排的网络，重建顺序仍要先主后附。

## 3. 源码升级（本地 / 单机）

```bash
git pull
bun install
bun run scripts/migrate.ts    # DDL（与镜像内 migrate.js 同一入口；本地开发改结构时仍可用 bun run db:migrate）
bun run run-data-migrations   # 数据迁移（幂等，已应用项按 data_migrate_record 跳过）
bun run build:web             # 前端有改动时必须，后端挂载 apps/web/dist
bash restart-server.sh
```

跑在 `deploy/compose` 编排里的单机形态改用统一入口 `bun run release --deploy`（§1），它把上面前两步与容器
部署串成一条失败即停的序列。

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
- [ ] 应用启动后 `/health` 返回 `status: "ok"`，`commitId` 为新版本。
- [ ] 关键路径抽查：一次交互式 Chat、一次外部 API 调用（或工作流/定时任务，按本次改动范围选择）。
