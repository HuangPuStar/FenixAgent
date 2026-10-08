# 备份与恢复

## 1. 现状先说清楚

本仓**当前没有备份脚本、没有备份点约定、也没有定时备份任务**；`/health` 只表达进程存活，不是 readiness。`docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §11 已把「备份点、失败回滚、不可逆迁移补偿证据」登记为优化项。因此本文分两部分：**要备份什么、按什么顺序恢复**是从代码与编排里读出的事实；**怎么备份**是人工口径，落地脚本之前必须手工执行并自行校验。

同理，恢复失败时的自动回滚也不存在——回滚边界只到「换回旧镜像 + 恢复备份点」，见[升级](./upgrade.md)。

## 2. 需要备份的对象

| 对象 | 默认位置 | 内容 | 丢失后的后果 |
| --- | --- | --- | --- |
| PostgreSQL | `DATABASE_URL` 指向的实例；编排里是 bind 目录 `docker/common/data/postgres` | 全部权威状态：身份与组织、资源与权限、Agent 配置、实例、工作流定义与运行、以及 `data_migrate_record` 与 `drizzle."__drizzle_migrations"` 两条迁移进度记录 | 无法从文件重建；迁移进度丢失会导致迁移重跑或错误跳过 |
| `SKILL_DIR` | `./data/skills`（容器内 `/app/data/skills`） | 按组织分目录的 skill 源目录与 zip 归档（`data/skills/<orgId>/<name>`） | DB 里只剩元数据，skill 内容不可恢复 |
| `WORKSPACE_ROOT` | `<运行目录>/workspaces`（容器内 `/app/workspaces`；可由 `WORKSPACE_ROOT` 覆盖） | 每个用户的 Agent 工作区，路径公式 `{WORKSPACE_ROOT}/{organizationId}/{userId}/{environmentId}` | 用户文件与 Agent 产物丢失。注意：DB 的 `workspacePath` 是历史字段，不能用来推导真实目录 |
| 日志目录 | `LOG_DIR`，默认相对进程 cwd 的 `logs` | `rcs.<yyyy-MM-dd>.log`（全量）与 `rcs.err.<yyyy-MM-dd>.log`（error 及以上），日期为 UTC；超过 `LOG_RETENTION_DAYS`（默认 30）的文件在跨日时清理 | 只影响事后排障，不影响业务数据 |
| peri 全局目录 | 宿主 `./data/peri-home`（容器内 `/root/.peri`） | peri 插件与 CLI 配置（镜像构建时安装了 hindsight-memory 插件，运行期还会写入） | 容器重建后需要重新安装/配置插件 |
| `./workflow` 目录 | 两份主服务编排都挂载的 `./workflow`（容器 `/app/workflow`；dev 落仓库根，生产落 `docker/main/workflow`） | `Dockerfile` 与两份编排都创建/挂载它，但当前代码树里没有写入方，内容按代码无从断定（可能为空，也可能被运行期工具使用） | 工作流定义与运行记录都在数据库里，不受影响；备份时保守纳入，避免与运行期外部工具的口径不一致 |
| 部署输入（主服务 env——生产 `docker/main/.env`、dev 仓库根 `.env`——、`docker/deploy.env`、各依赖目录的 `.env`、`deploy/assembly/*.json`、前端产物） | 仓库/编排目录 | 编排与发布参数。代码与 `apps/web/dist` 可由版本重建，但 **`.env` 与 `docker/deploy.env` 是唯一副本** | 需要重新配置；密钥若未另行保管则要重新签发 |
| 共享 MySQL（仅在启用 `FENIX_FEATURE_MYSQL` 时） | bind 目录 `docker/common/data/mysql` | Workflow V2 上游栈的定义、版本与运行数据（库 `opencoze`），以及 RAGFlow 的知识库元数据（库 `rag_flow`、文档与切片记录） | 两个栈都不带自己的实例了：这里丢了，上游定义与知识库元数据都不可从别处重建 |
| 网关库（LiteLLM，共享 PostgreSQL 实例内） | 同一个 `docker/common/data/postgres`（库 `litellm`，角色 `litellm`） | Provider 凭据、Virtual Key、预算与用量——模型网关的事实来源 | 网关需要重新配置；已签发的 Virtual Key 与其用量记录丢失 |
| 共享对象存储（共享 RustFS，仅在启用 `FENIX_FEATURE_S3` 时） | bind 目录 `docker/common/data/rustfs` | Workflow 的桶 `opencoze`（画布图片 / 附件）与 `milvus`（向量数据） | 工作流画布产物不可从数据库重建（库里只有元数据与桶内路径） |
| RAGFlow 自带的对象存储（本栈实例 `ragflow-rustfs`，恒随该栈启动） | bind 目录 `docker/ragflow/data/rustfs` | 知识库的桶（每个知识库 / 文件目录一个，桶名即 `kb_id` / `parent_id`，数量随用户行为增长） | 知识库文档与解析产物不可从数据库重建（库里只有元数据与桶内路径） |
| Redis（仅在配置了 `RCS_REDIS_URL` 时） | 外部 Redis 实例 | Y.Doc 快照（`chat:{rcsSessionId}` / `session:{rcsSessionId}`，滑动 TTL 默认 7 天）与缓存 | 影响有限：快照是 trailing 节流的尽力而为写入，**权威是 Agent 侧 ACP session 历史**，可经 `load_session` 回放重建 |

敏感项：`data/password.txt`（系统管理员初始口令，路径由 `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 指定）与任何含密钥的 `.env`。它们必须按密钥材料保管，不得随普通备份包分发、不得进日志。备份 `./data` 时如需排除，请在打包命令里显式排除。

**旧数据目录（共享化之前的落点）**：`docker/ragflow/ragflow_mysql_data`（旧元数据库）、`docker/ragflow/ragflow_minio_data`（旧对象存储）、`${WORKFLOW_STUDIO_DIR}/docker/data/minio`（Workflow 旧对象存储）、LiteLLM 旧自带实例的 bind 目录。它们**不再被任何服务读写**，但在搬迁验收通过并跑过一个业务周期之前**不要删**——那之前的回滚路径依赖它们（[升级](./upgrade.md) §2）。可删条件与各自的操作步骤写在 `docker/ragflow/README.md`「数据搬迁」与 `docker/workflow/README.md` §8；`./docker/deploy.sh down --purge-data` **不会**清理它们（脚本只清各依赖目录的 `./data/`），要删得手动删，删前先 `tar` 留一份。

## 3. 编排实际挂了什么（决定数据是否落在宿主机上）

主服务编排的挂载（数据一律 bind，见 [`docker-topology.md`](./docker-topology.md) §13.8）。**两份编排的挂载清单相同**，
区别只在相对路径的落点：dev 是仓库根，生产是 `docker/main/`（`docker/deploy.sh` 的操作对象）：

| 卷 / 目录 | 主服务编排（dev 根文件 / 生产 `docker/main/`） | 宿主落点 |
| --- | --- | --- |
| 数据库（含共享实例内的网关库 `litellm`） | 挂载（`docker/common/`，随 include） | `docker/common/data/postgres` |
| 共享 MySQL（启用 `FENIX_FEATURE_MYSQL` 时；含 workflow 库 `opencoze` 与 ragflow 库 `rag_flow`） | 挂载 | `docker/common/data/mysql` |
| 共享对象存储 rustfs（启用 `FENIX_FEATURE_S3` 时；含 workflow 的两个固定桶 `opencoze` / `milvus`） | 挂载 | `docker/common/data/rustfs` |
| RAGFlow 自带的对象存储 `ragflow-rustfs`（随 `docker/ragflow/` 启停；含知识库侧随用户行为增长的桶——每个知识库 / 文件目录一个） | 挂载 | `docker/ragflow/data/rustfs` |
| `./data`（含 `SKILL_DIR`、口令文件、`peri-home`） | 挂载 | dev `./data`；生产 `docker/main/data` |
| `./workflow` | 挂载 | dev `./workflow`；生产 `docker/main/workflow` |
| `./workspaces`（`WORKSPACE_ROOT`） | 挂载 | dev `./workspaces`；生产 `docker/main/workspaces` |
| `./logs`（`LOG_DIR`） | **未挂载** | 容器重建即丢日志；需要保留时自行加一条 bind |
| `/root/.peri` | 挂载 | dev `./data/peri-home`；生产 `docker/main/data/peri-home`（不再是匿名卷） |

对应风险：

- 两份主服务编排都未挂 `logs`：容器重建即丢日志。容器形态下如需保留，给 `rcs` 加一条 `./logs:/app/logs` 并把 `LOG_DIR` 指过去。
- 依赖目录（`docker/<name>/`）的数据一律在自己的 `./data/` 或 `./ragflow_*` 一类同级目录下，随该目录一起备份；`./docker/deploy.sh down --purge-data` 会删掉这些目录（**包括 `docker/common/data/` 下的共享实例数据**），**不要**在需要保留数据时使用。共享化之后，消费方（`workflow` / `ragflow` / `litellm`）的**库**都在共享实例里（`docker/common/data/**`）；
  **对象存储分两处**：workflow 的桶在共享实例（`docker/common/data/rustfs`），RAGFlow 的桶在它自带的实例里
  （`docker/ragflow/data/rustfs`，2026-10-08 由共享实例回退而来，见 [`docker-topology.md`](./docker-topology.md) §5）。
  备份与 `--purge-data` 的口径都要同时覆盖这两处。
- 相对路径按**编排文件所在目录**解析：主服务在 dev 是仓库根、生产是 `docker/main/`，依赖目录各自相对自己的目录。

## 4. 临时备份口径（仓库暂无脚本）

原则：数据库与文件目录的快照要尽量取在**同一时间点**——数据迁移会同时改库与改文件，两者错位会让「记录已落库、应用读不到文件」这类状态无法自愈。安全的做法是先在维护窗口停掉应用与数据迁移，再依次取快照。

下面的命令按 **dev 形态**（仓库根编排、数据落仓库根）给出；生产机器上把 `docker compose …` 换成
`docker compose -f docker/main/docker-compose.yml …`（在任意工作目录执行；它自动读 `docker/main/.env`），
文件路径把 `./data`、`./workflow`、`./workspaces` 换成 `docker/main/` 下的同名目录。

```bash
# 1) 数据库逻辑备份（postgres 容器自带 pg_dump / pg_restore）
docker compose exec -T postgres pg_dump -U rcs -Fc rcs > rcs-$(date +%Y%m%d).dump

# 2) 文件目录（在数据目录所在机器上执行；按实际 WORKSPACE_ROOT / LOG_DIR / SKILL_DIR 调整路径）
tar -czf data-$(date +%Y%m%d).tar.gz       -C . data
tar -czf workspaces-$(date +%Y%m%d).tar.gz -C <WORKSPACE_ROOT> .
tar -czf workflow-$(date +%Y%m%d).tar.gz   -C . workflow
tar -czf pgdata-$(date +%Y%m%d).tar.gz     -C docker/common/data postgres

# 2b) 共享实例（启用对应开关时；都在 docker/common/data/ 下，与上面的 pgdata 同属一份交付面）
docker compose --profile mysql exec -T mysql mysqldump -uroot -p"$MYSQL_ROOT_PASSWORD" \
  --databases opencoze rag_flow > mysql-$(date +%Y%m%d).sql     # workflow 与 ragflow 两个库
tar -czf rustfs-$(date +%Y%m%d).tar.gz     -C docker/common/data rustfs      # workflow 的桶（共享实例）
tar -czf ragflow-rustfs-$(date +%Y%m%d).tar.gz -C docker/ragflow/data rustfs # 知识库的桶（RAGFlow 自带实例）
# 对象存储打包同样以停机窗口内取为稳（运行中打包可能取到半写的对象）

# 3) 配置（唯一副本，按密钥材料保管，不要随普通备份分发；生产把 .env 换成 docker/main/.env）
tar -czf config-$(date +%Y%m%d).tar.gz .env docker/deploy.env
```

这些都是通用工具的人工操作，不是仓库能力：脚本、保留策略、校验（例如「备份包能否在空环境恢复」的演练）都还不存在。引入自动备份时，请把它登记到 §11 的优化项台账，并把本节替换为脚本入口。

## 5. 恢复顺序

1. **先恢复数据库**到与应用版本匹配的迁移状态：
   ```bash
   docker compose exec -T postgres pg_restore -U rcs -d rcs --clean --if-exists < rcs-YYYYmmdd.dump
   ```
2. **恢复文件目录**：`SKILL_DIR`、`WORKSPACE_ROOT`、`workflow`、peri 目录（按需）。必须在启动应用前完成，否则应用会先读到空目录并可能写入新状态。
3. **恢复共享实例与自带实例里的依赖数据**（按启用的开关）：把共享 MySQL 的两个库（`opencoze` / `rag_flow`）、共享 rustfs 的数据目录（workflow 的桶）与 `docker/ragflow/data/rustfs`（RAGFlow 自带的桶）按 §4 的备份还原回各自目录。**顺序是先起主服务项目、再起依赖栈**：栈内的一次性初始化服务是幂等的（只建缺失的库 / 桶、只同步口令，不动既有数据；`docker/ragflow/` 的 `ragflow-s3-init` 只对自带实例做能力探测、不建业务桶——多桶模式下桶由 RAGFlow 运行期自建），不会覆盖刚恢复的数据；反过来先起依赖栈会让初始化在空实例上建出新的库 / 固定名桶，与恢复点分叉。
4. **核对迁移进度**：比对 `drizzle."__drizzle_migrations"` 与 `data_migrate_record` 的内容是否与该版本代码期望的迁移集合一致；缺的补跑（[升级](./upgrade.md) 的发布顺序），多的必须查明来源后再决定——不要只改记录。
5. **启动应用**（`up -d rcs`）→ 检查 `/health` 的 `status` 与 `commitId`，再抽查一次交互式 Chat 与文件访问。

与不可逆迁移的关系：若备份点位于某个 `DROP` 迁移之前，恢复数据库等于退回旧结构，此时**必须同时用对应旧版本的镜像启动**，否则新代码会因缺列/缺表直接失败。反过来，若已执行过 `compensation: "none"` 的数据迁移，回退到旧版本也无法恢复被删除的旧副本——只能从备份点恢复文件。
