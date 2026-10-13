# 迁移

迁移分三类，混淆它们是最常见的出错来源：

| 类型 | 内容 | 执行入口 | 何时跑 |
| --- | --- | --- | --- |
| DDL 迁移 | 表结构变更（建表、加列、索引） | `bun run db:migrate`（本地/源码）或镜像内 `bun migrate.js` | 发布期的第一步，先于数据迁移与新版本进程 |
| 数据迁移 | 已有数据的批量处理与搬迁（可含文件副作用） | `bun run run-data-migrations`（= `bun run db/data-migration-runner.ts`）或镜像内 `bun data-migration-runner.js` | DDL 之后、新版本进程之前，**每次发布执行一次** |
| `db:push` | 直接把 schema 推平到库 | `bun run db:push` | 仅本地开发；**禁止**在生产使用 |

数据操作不得写进 DDL 迁移的 SQL 文件里：表结构由 Drizzle 生成、数据搬迁要幂等可重试并需要依赖/校验/补偿，两者交付方式不同（口径见 `drizzle/README.md` 场景四）。

## 1. DDL 迁移

标准流程：

```bash
# 1) 改表定义：改到表的 owner 包（packages/**/db/schema.ts，经 @fenix/<pkg>/db 公开）
#    或宿主 apps/server/src/db/schema.ts（只剩身份表转出、data_migrate_record 与暂留的旧授权表）
# 2) 生成迁移
bun run db:generate --name <module>-<change>
# 3) 审查 drizzle/<新节点>.sql 与 drizzle/meta/*（_journal.json 与 snapshot）
# 4) 应用
bun run db:migrate
# 5) 涉及存量数据搬迁/回填时，另跑数据迁移（下一节）
```

前置条件与硬约束：

- `drizzle.config.ts` 的 `schema` 必须声明**全部** owner 包路径与宿主 schema。漏声明一族，`db:generate` 会把那一族的表误判为已删除并生成 `DROP`。
- 表定义换手不得改变 DDL：`bun run check:schema-ddl-drift` 比对「`drizzle.config.ts` 声明的 schema 集合 → 最新 snapshot」的差异，必须为零。
- 已发布节点的 SQL 文件与 `_journal.json` 条目不可手改；`when` 时间戳异常会导致节点被跳过，三种异常形态与补偿口径见 `drizzle/README.md` 场景三。
- 提交迁移时必须提交完整 `drizzle/` 迁移链，不能遗漏 `drizzle/meta/*`。
- 禁止手写 SQL 迁移绕过 Drizzle。

连接串来源（两处行为不同，升级/排障时看准）：

- `bun run db:migrate` 经 `drizzle-kit` 读 `process.env.DATABASE_URL`，`drizzle.config.ts` 在缺失时回落到源码默认值 `postgres://rcs:rcs@localhost:5432/rcs`（只适合本地）。
- 生产入口 `scripts/migrate.ts`（镜像内 `migrate.js`）**没有回退**：缺 `DATABASE_URL` 立即 `exit 1`，理由写在文件头——连接串与口令不得写入源码。

并发与失败语义（`scripts/migrate.ts`）：

- 同一数据库上的所有 `migrate.js` 进程抢同一把 `pg_advisory_lock`（key 是仓库内常量），因此多副本同时启动不会互相撞出 `already exists`。
- 失败**一律 fail-closed**：任何异常都是退出码 1。历史上「message 含 `already exists` 就当成功」的容忍已删除，它曾把真实失败伪装成成功，让流水线无法失败停止。
- 诊断中的 `DATABASE_URL` 原文与口令段会被掩码后输出，不要指望在日志里回捞连接串。

历史 `db:push` 建库的基线化：这类库没有 `drizzle."__drizzle_migrations"` 记录，首次跑 `migrate.js` 会在重复建表处失败。需要**一次显式基线化**（人工确认「结构确实已存在」的最后一个节点后插入一行进度记录），步骤见 `drizzle/README.md` 场景 3.4；`migrate.js` 不做自动基线化。

## 2. 数据迁移

```bash
# 与应用进程相同的环境变量（DATABASE_URL、RCS_API_KEYS 等必填项由 loadServerEnv 校验）
# 与应用进程相同的数据卷挂载（镜像内 /app/data，skillDir 默认 ./data/skills）
bun run run-data-migrations
```

前置条件（每一条都对应一次真实事故形态）：

- **必须在 DDL 迁移之后**：迁移读写新结构，顺序颠倒会因缺列/缺表失败。
- **必须早于新版本应用进程**：迁移结果要让新代码直接可用；这也保证它早于启动期的 builtin 同步。
- **必须与应用共享同一份环境变量与数据卷**：迁移既写库也写文件（skill 归档/复制），卷不一致会留下「记录已落库、应用却读不到迁移后文件」的状态，而记录已写入使重跑变成跳过，无法靠重试自愈。
- **不要写进容器启动命令**：每个副本各跑一次含文件副作用的迁移不是幂等并发安全。

执行模型（`apps/server/src/services/data-migrate.ts`，契约在 `@fenix/platform-sdk` 的 `migration/data-migration`）：

1. 读 `data_migrate_record` 得到已完成集合，已应用的迁移直接 `skip applied migrate`。
2. 执行前校验 `dependsOn`，缺失即失败（不静默跳过）；报错区分「注册表内未完成」与「不在注册表内（ID 被改名或移除）」。
3. 输出静态元信息：`依赖=[…]；预期数据量=<expectedRows>；锁风险=<lockRisk>；可观测字段=[…]`。
4. `run` → `verify`：`verify` 失败与 `run` 失败同等对待——**记录只在结果已验证完整后才落库**。
5. 失败时按 `compensation` 补偿并 fail-stop：后续迁移不执行；补偿本身失败只记录，不掩盖原始错误。

注册表位置：`apps/server/src/services/data-migrate.ts` 的 `MIGRATIONS` 数组。数组顺序只是便于阅读的声明顺序，**依赖一律由 `dependsOn` 表达**，重排注册表不得改变迁移语义。

当前注册表里的三支迁移：

| ID | 作用 | 锁风险 | 补偿 |
| --- | --- | --- | --- |
| `migrate-agent-config-model-id` | 把 `agent_config` 的历史 `model` 文本解析成 `model_id` 引用，随后清空旧列 | `row-level` | `none`（旧原文不保留副本，撤销只会让该行彻底失去模型配置） |
| `migrate-skill-storage-by-organization` | 把 `data/skills/<name>` 的遗留目录分发到 `data/skills/<orgId>/<name>`，成功后就地删除旧目录 | `none`（只写文件系统） | `none`（旧目录删除后不留第二份副本；靠幂等重跑收敛） |
| `access-control/20260919-backfill-resource-visibility` | 把旧 `resource_permission` 的「公开读」授权单向回填到四张受控资源主表的 `visibility` 列 | `row-level` | `handler`（可撤销已回填部分） |

新增一支迁移：在 owner 模块内实现 `DataMigration`（`name` 用 `<模块>/<YYYYMMDD>-<名字>`，历史 ID 不改名——ID 是 `data_migrate_record` 的幂等判据与发布契约）→ 在 `MIGRATIONS` 注册 → 保证 `run` 幂等可重试、`verify` 能从目标侧断言结果完整、`compensation` 显式声明（要「没有补偿」就写 `{ kind: "none", reason }` 说明靠什么收敛）。

生产侧注意：生产迁移入口是 `scripts/migrate.ts` 构建出的 `migrate.js`；应用镜像与迁移镜像都从同一份源码构建，交付方式见[升级](./upgrade.md)。

## 3. 迁移指标与观测

- 迁移的**声明值**（`metadata.expectedRows` / `lockRisk` / `observableFields`）在执行前输出，**实际影响行数**由迁移自己经 `context.log` 输出，二者在发布日志里互相印证。只有声明没有实测，无法判断迁移是否真的动到了预期数据。
- 锁风险按行数增长的用 `row-level`（实现必须是逐行或分批提交，不得把整个迁移包进一个长事务）；`table-level` 表示执行期间相关表并发写入会阻塞，发布方据此决定是否避开业务高峰。

## 4. 不可逆迁移

**先看这条**：`DROP` 与「删除旧副本」的迁移无法靠回滚代码恢复，只能靠备份。备份与恢复的口径见[备份与恢复](./backup-and-restore.md)。

本仓现有的不可逆案例：

| 文件 / 迁移 | 不可逆动作 |
| --- | --- |
| `drizzle/0001_auto-generated.sql` | `ALTER TABLE "provider" DROP COLUMN "npm"` |
| `drizzle/0003_skill-storage-by-org.sql` | `ALTER TABLE "skill" DROP COLUMN "content_path"`（配套的数据迁移搬移并删除旧目录） |
| `drizzle/0004_agent-config-optimization.sql` | `ALTER TABLE "agent_config" DROP COLUMN "knowledge"` |
| `drizzle/0006_agent-config-extra-cleanup.sql` | `agent_config` 删除 `steps` / `mode` / `permission` / `variant` / `temperature` / `top_p` / `disable` / `hidden` / `color` 九列 |
| `drizzle/0023_agent-instance.sql` | `DROP TABLE IF EXISTS "scheduled_task"` |
| `drizzle/0025_remove-environment-max-sessions.sql` | `ALTER TABLE "environment" DROP COLUMN "max_sessions"` |
| 数据迁移 `migrate-skill-storage-by-organization` | 分发完成后删除旧目录，不留第二份副本 |
| 数据迁移 `migrate-agent-config-model-id` | 回填后清空旧 `model` 原文 |

注意事项：

- 只回滚 DDL 而不同步迁移记录会留下不一致状态；正确顺序是「先回滚结构，再从 `drizzle."__drizzle_migrations"` 删除对应记录」，细节见 `drizzle/README.md` 场景 3.1。
- 若被回滚的迁移还伴随了数据写入或文件搬迁，不能只靠回滚 DDL + 删记录处理，必须额外设计数据补偿。
- **先回填再 DROP 必须拆成两次发布**：同一发布内先回填再删旧结构，会让回填丧失可核验的对照源，而 DROP 是唯一不可逆步骤。本仓已有先例——`resource_permission` 的回填已上线，`DROP TABLE resource_permission` 按裁决推迟到下一发布，回填必须在 DROP 之前于全部环境执行完毕（见 `apps/server/src/services/data-migrates/backfill-resource-visibility.ts` 文件头与 `apps/server/src/db/schema.ts` 的移除条件标注）。
- 迁移设计必须考虑已有数据、锁范围、回滚或补偿策略，以及多实例并发启动时的幂等性。

## 5. 与门禁的关系

改动 schema 后除本文件流程外，还需跑与变更类型匹配的门禁：`bun run check:schema-ddl-drift`（表定义换手不改 DDL）、`bun run precheck`（含生成物比对与依赖边界检查）；涉及存量数据变更时执行 `bun run run-data-migrations`。
