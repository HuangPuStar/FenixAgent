# 备份与恢复

## 1. 现状先说清楚

本仓**当前没有备份脚本、没有备份点约定、也没有定时备份任务**；`/health` 只表达进程存活，不是 readiness。`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §11 已把「备份点、失败回滚、不可逆迁移补偿证据」登记为优化项。因此本文分两部分：**要备份什么、按什么顺序恢复**是从代码与编排里读出的事实；**怎么备份**是人工口径，落地脚本之前必须手工执行并自行校验。

同理，恢复失败时的自动回滚也不存在——回滚边界只到「换回旧镜像 + 恢复备份点」，见[升级](./upgrade.md)。

## 2. 需要备份的对象

| 对象 | 默认位置 | 内容 | 丢失后的后果 |
| --- | --- | --- | --- |
| PostgreSQL | `DATABASE_URL` 指向的实例；compose 里是 `postgres-data` 卷 | 全部权威状态：身份与组织、资源与权限、Agent 配置、实例、工作流定义与运行、以及 `data_migrate_record` 与 `drizzle."__drizzle_migrations"` 两条迁移进度记录 | 无法从文件重建；迁移进度丢失会导致迁移重跑或错误跳过 |
| `SKILL_DIR` | `./data/skills`（容器内 `/app/data/skills`） | 按组织分目录的 skill 源目录与 zip 归档（`data/skills/<orgId>/<name>`） | DB 里只剩元数据，skill 内容不可恢复 |
| `WORKSPACE_ROOT` | `<运行目录>/workspaces`（容器内 `/app/workspaces`；可由 `WORKSPACE_ROOT` 覆盖） | 每个用户的 Agent 工作区，路径公式 `{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}` | 用户文件与 Agent 产物丢失。注意：DB 的 `workspacePath` 是历史字段，不能用来推导真实目录 |
| 日志目录 | `LOG_DIR`，默认相对进程 cwd 的 `logs` | `rcs.<yyyy-MM-dd>.log`（全量）与 `rcs.err.<yyyy-MM-dd>.log`（error 及以上），日期为 UTC；超过 `LOG_RETENTION_DAYS`（默认 30）的文件在跨日时清理 | 只影响事后排障，不影响业务数据 |
| peri 全局目录 | 容器内 `/root/.peri`（`Dockerfile` 声明为 `VOLUME`） | peri 插件与 CLI 配置（镜像构建时安装了 hindsight-memory 插件，运行期还会写入） | 容器重建后需要重新安装/配置插件 |
| `./workflow` 目录 | 编排挂载的 `workflow` 目录（容器 `/app/workflow`） | `Dockerfile` 与两个编排都创建/挂载它，但当前代码树里没有写入方，内容按代码无从断定（可能为空，也可能被运行期工具使用） | 工作流定义与运行记录都在数据库里，不受影响；备份时保守纳入，避免与运行期外部工具的口径不一致 |
| 部署输入（`docker/prod/.env` 或根 `.env`、`deploy/assembly/*.json`、前端产物） | 仓库/编排目录 | 编排与发布参数。代码与 `apps/web/dist` 可由版本重建，但 **`.env` 是唯一副本** | 需要重新配置；密钥若未另行保管则要重新签发 |
| Redis（仅在配置了 `RCS_REDIS_URL` 时） | 外部 Redis 实例 | Y.Doc 快照（`chat:{rcsSessionId}` / `session:{rcsSessionId}`，滑动 TTL 默认 7 天）与缓存 | 影响有限：快照是 trailing 节流的尽力而为写入，**权威是 Agent 侧 ACP session 历史**，可经 `load_session` 回放重建 |

敏感项：`data/password.txt`（系统管理员初始口令，路径由 `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 指定）与任何含密钥的 `.env`。它们必须按密钥材料保管，不得随普通备份包分发、不得进日志。备份 `./data` 时如需排除，请在打包命令里显式排除。

## 3. 编排实际挂了什么（决定数据是否落在宿主机上）

| 卷 / 目录 | 根 `docker-compose.yml` | `docker/prod/docker-compose.yml` |
| --- | --- | --- |
| 数据库 | 命名卷 `postgres-data` | 命名卷 `postgres-data` |
| `./data`（含 `SKILL_DIR`、口令文件） | 挂载 | 挂载 |
| `./workflow` | 挂载 | 挂载 |
| `./workspaces`（`WORKSPACE_ROOT`） | 挂载 | **未挂载** |
| `./logs`（`LOG_DIR`） | **未挂载** | 挂载 |
| `/root/.peri` | 命名卷 `rcs-peri-home` | 未命名（`Dockerfile` 的 `VOLUME` 会生成匿名卷） |

对应风险（升级/迁移前必须先确认，否则「重建容器」会静默丢数据）：

- 根编排未挂 `logs`：容器重建即丢日志。
- prod 编排未挂 `workspaces`：`WORKSPACE_ROOT` 默认落在容器内的 `/app/workspaces`，容器重建即丢用户工作区。生产请显式设置 `WORKSPACE_ROOT` 并挂载该目录。
- prod 编排的 `/root/.peri` 是匿名卷：`up -d` 重建默认复用，但 `docker compose down -v` 或 `--renew-anon-volumes` 会丢弃它。
- 相对路径按**编排文件所在目录**解析：prod 下数据实际在 `docker/prod/data`、`docker/prod/workflow`、`docker/prod/logs`。

## 4. 临时备份口径（仓库暂无脚本）

原则：数据库与文件目录的快照要尽量取在**同一时间点**——数据迁移会同时改库与改文件，两者错位会让「记录已落库、应用读不到文件」这类状态无法自愈。安全的做法是先在维护窗口停掉应用与数据迁移，再依次取快照。

```bash
# 1) 数据库逻辑备份（postgres 容器自带 pg_dump / pg_restore）
docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml \
  exec -T postgres pg_dump -U rcs -Fc rcs > rcs-$(date +%Y%m%d).dump

# 2) 文件目录（在数据目录所在机器上执行；按实际 WORKSPACE_ROOT / LOG_DIR 调整路径）
tar -czf data-$(date +%Y%m%d).tar.gz       -C docker/prod data
tar -czf workspaces-$(date +%Y%m%d).tar.gz -C <WORKSPACE_ROOT> .
tar -czf logs-$(date +%Y%m%d).tar.gz       -C docker/prod logs

# 3) peri 全局目录（prod 编排为匿名卷，先查名字再打包）
docker volume ls | grep -i peri
docker run --rm -v <卷名>:/from -v "$PWD":/to alpine tar -czf /to/peri-$(date +%Y%m%d).tar.gz -C /from .
```

这些都是通用工具的人工操作，不是仓库能力：脚本、保留策略、校验（例如「备份包能否在空环境恢复」的演练）都还不存在。引入自动备份时，请把它登记到 §11 的优化项台账，并把本节替换为脚本入口。

## 5. 恢复顺序

1. **先恢复数据库**到与应用版本匹配的迁移状态：
   ```bash
   docker compose --env-file docker/prod/.env -f docker/prod/docker-compose.yml \
     exec -T postgres pg_restore -U rcs -d rcs --clean --if-exists < rcs-YYYYmmdd.dump
   ```
2. **恢复文件目录**：`SKILL_DIR`、`WORKSPACE_ROOT`、`workflow`、peri 目录（按需）。必须在启动应用前完成，否则应用会先读到空目录并可能写入新状态。
3. **核对迁移进度**：比对 `drizzle."__drizzle_migrations"` 与 `data_migrate_record` 的内容是否与该版本代码期望的迁移集合一致；缺的补跑（[升级](./upgrade.md) 的发布顺序），多的必须查明来源后再决定——不要只改记录。
4. **启动应用**（`up -d rcs`）→ 检查 `/health` 的 `status` 与 `commitId`，再抽查一次交互式 Chat 与文件访问。

与不可逆迁移的关系：若备份点位于某个 `DROP` 迁移之前，恢复数据库等于退回旧结构，此时**必须同时用对应旧版本的镜像启动**，否则新代码会因缺列/缺表直接失败。反过来，若已执行过 `compensation: "none"` 的数据迁移，回退到旧版本也无法恢复被删除的旧副本——只能从备份点恢复文件。
