# Drizzle 迁移合并提示

## 基本原则

- 一个功能只保留一个新的迁移节点。
- 如果开发过程中为了迭代方便生成了多个迁移节点，合并前必须压缩成一个。
- 提交 PR 前，如果迁移链和远端有冲突，必须先在本地整理完成，不能把冲突状态直接提交上去。

## 场景一：一个功能开发过程中生成了多个节点

目标：把当前功能产生的多个节点压缩成一个节点。

推荐做法：

1. 先回滚数据库到这个功能开始前的迁移节点。
2. 保留当前 `schema.ts` 的最终结果，不手写 SQL 合并。
3. 删除或移开这个功能开发过程中生成的多个本地迁移文件和 snapshot。
4. 使用 Drizzle 重新生成一次迁移。
5. 确认重新生成后，这个功能只对应一个新节点。

## 场景二：功能完成准备提 PR，但迁移节点和远端冲突

目标：在本地先吸收远端新增节点，再重新生成当前功能的迁移节点。

推荐做法：

1. 先回滚数据库到这个功能开始前的迁移节点。
2. 合并远端分支代码。
3. 先执行远端新增的迁移，让本地数据库追上远端最新节点。
4. 保留当前功能在 `schema.ts` 中的最终改动。
5. 删除或移开当前功能原先生成的本地迁移文件和 snapshot。
6. 基于“远端最新节点 + 当前功能最终 schema”重新使用 Drizzle 生成迁移。
7. 确认新的迁移文件只包含当前功能真正新增的变更。

## 场景三：生产迁移冲突或迁移状态异常

目标：先确认生产数据库真实状态，再恢复数据库结构、迁移记录和代码中的迁移文件三者一致。

在生产环境排查时，至少先核对以下三处：

1. 当前数据库真实结构。
2. `drizzle."__drizzle_migrations"` 中的实际迁移记录。
3. 仓库中的迁移文件和 `drizzle/meta/_journal.json`。

### 场景 3.1：生产库执行过一个不应该存在的迁移脚本

典型现象：

- 生产库结构已经被错误迁移改坏。
- `drizzle."__drizzle_migrations"` 中存在这次错误迁移的记录。

处理方式：

1. 先确认这次错误迁移具体改动了哪些结构。
2. 编写补偿 SQL，回滚这次错误迁移带来的结构变更。
3. 在确认数据库结构已经恢复后，从 `drizzle."__drizzle_migrations"` 中移除对应迁移记录。
4. 重新核对数据库结构、迁移记录和本地迁移文件状态一致后，再继续执行新的迁移。

注意事项：

- 删除迁移记录之前，必须先完成数据库结构回滚；不要只删记录不回滚结构。
- 如果这次错误迁移还伴随了数据迁移或数据写入，不能只靠回滚 DDL 和删除记录处理，必须额外设计数据补偿逻辑。

### 场景 3.2：新的单个迁移脚本被跳过执行

典型现象：

- 新迁移文件只有一个。
- 该迁移没有执行，通常是 `drizzle/meta/_journal.json` 中该节点的 `when` 时间戳异常，落后于当前最后一个已执行节点。

处理方式：

1. 确认被跳过的迁移尚未实际执行到生产库。
2. 修复该迁移在 `drizzle/meta/_journal.json` 中对应条目的 `when` 时间戳，使其晚于当前最后一个已执行节点。
3. 重新执行 `db:migrate` 或生产环境对应的 `migrate.js`。

注意事项：

- 修复时间戳前，先确认数据库里确实缺少这次迁移要引入的结构，避免把已执行过的迁移重复跑一遍。
- 只允许修复未正确执行的新迁移节点，不要随意重排历史已稳定节点的顺序。

### 场景 3.3：新的多个迁移脚本中，有一个或多个中间节点被跳过

典型现象：

- 一批新迁移文件里，不是最后一个，而是中间某个或多个节点被跳过。
- 原因通常也是 `drizzle/meta/_journal.json` 中部分节点的 `when` 时间戳异常。
- 后续迁移可能已经部分执行，导致数据库结构处于“半完成”状态。

处理方式：

1. 先确认这一批迁移里哪些节点已执行、哪些节点被跳过、哪些节点受连带影响。
2. 对已错误执行的后续结构变更编写补偿 SQL，先把数据库回滚到“缺失节点执行前”的一致状态。
3. 修复被跳过节点及相关节点在 `drizzle/meta/_journal.json` 中的 `when` 时间戳。
4. 重新执行 `db:migrate` 或生产环境对应的 `migrate.js`，让这一批迁移按正确顺序重新落库。

注意事项：

- 这个场景不要只改时间戳后直接重跑；如果后续迁移已经部分生效，必须先做结构补偿，否则很容易产生重复建表、重复加列或索引冲突。
- 如果其中任一迁移还涉及数据迁移、回填、批量修复等复杂逻辑，不能直接套用上面的 DDL 回滚方法，必须按实际数据状态额外设计补偿方案，先恢复数据和结构一致性，再决定是否重跑迁移。

### 场景 3.4：历史 `db:push` 库需要一次显式基线化

背景：迁移入口曾经把「异常 message 含 `already exists`」当作「库是先 `db:push` 建的」而按成功退出；该容忍已删除，迁移失败一律非 0 退出（理由见 `docs/operations/troubleshooting.md` 第 8 节）。因此历史用 `db:push` 直接推平 schema、没有 `drizzle."__drizzle_migrations"` 记录的环境，第一次执行 `migrate.js` 会在重复建表处失败。

这类库需要**一次显式的基线化**：把「结构确实已经存在的那部分迁移」记为已应用，之后交给 `migrate.js` 继续应用剩余迁移。判定「哪些已经存在」必须由人确认（场景三开头的三处核对点），不能由脚本猜。

处理方式（在能访问数据库的机器上执行，需要 `psql` 与 `jq`）：

1. 先备份数据库——基线化必须可回滚。
2. 核对该库真实结构与迁移链的差异，确定最后一个「结构已经存在」的迁移节点 `<tag>`。
3. 插入一行进度记录即可：drizzle 只按 `created_at` 的最大值判断进度，`hash` 取该迁移 SQL 文件内容的 sha256，`created_at` 取 `_journal.json` 中该节点的 `when`。

```bash
tag=<最后一个已存在的迁移节点，例如 0027_access-control-resource-visibility>
sha=$(shasum -a 256 "drizzle/${tag}.sql" | cut -d' ' -f1)
when=$(jq -r --arg tag "$tag" '.entries[] | select(.tag==$tag) | .when' drizzle/meta/_journal.json)
psql "$DATABASE_URL" -c \
  "insert into drizzle.\"__drizzle_migrations\" (hash, created_at) values ('${sha}', ${when})"
```

4. 重新执行 `migrate.js`：应只应用 `<tag>` 之后的迁移。若仍报 `already exists`，说明基线节点选错或库结构与迁移链不一致，回到第 2 步继续核对——**不要**把该错误当成可忽略。

注意：`drizzle."__drizzle_migrations"` 表不存在时（库从未跑过任何迁移），先执行一次 `migrate.js`：它会在事务外先建好 `drizzle` schema 与该表，再在重复建表处失败；此时按上面第 3 步插入基线行即可。

## 场景四：需要执行数据迁移（非 DDL）

当功能开发不仅涉及 schema 变更，还需要**对已有数据进行批量修改/搬迁**时，不能直接在 DDL 迁移 SQL 里手写数据操作。这类逻辑必须走代码迁移流程。

### 数据迁移 vs DDL 迁移的区别

| 类型 | 内容 | 执行方式 |
|------|------|----------|
| DDL 迁移（`drizzle/`） | 表结构变更（新增列、索引等） | `bun run db:migrate` 或 `migrate.js` |
| 数据迁移（`packages/**/db/data-migrations/`） | 已有数据的批量处理/搬迁 | 部署期入口 `db/data-migration-runner.ts` 执行一次 |

### 如何新增一个数据迁移

迁移代码与 schema 一样归**发起变更的模块**（§6.3），落点是该模块的 `db/data-migrations/`，与它的 `db/schema.ts` 同级。宿主 `src/services/data-migrates/` 只保留没有 owner 包能合法持有的迁移（当前仅四资源 `visibility` 回填，理由见该文件头部）。

1. 在 owner 包新建 `packages/resources/<module>/db/data-migrations/<名字>.ts`，实现 `DataMigration` 契约（`@fenix/platform-sdk` 的 `migration/data-migration`，六个字段全部必填）：

```ts
// packages/resources/agent-config/db/data-migrations/20260924-backfill-xxx.ts
import { agentConfig } from "@fenix/agent-config/db";          // 本包（或别包）owner 的表对象，经包出口 `./db` 取
import type { DataMigration } from "@fenix/platform-sdk";
import { eq } from "drizzle-orm";
import { getAgentConfigDatabase } from "../../src/server/db"; // 库句柄经包内受限入口取，每次调用重新取、不在模块作用域缓存

export const backfillXxx: DataMigration = {
  // 全局唯一 ID，格式 `<模块>/<YYYYMMDD>-<名字>`（日期取首次进入仓库的那天）。
  // 落 data_migrate_record 后即成为发布契约：改名会被判为未应用而重跑。
  name: "agent-config/20260924-backfill-xxx",
  dependsOn: [],                     // 必须已完成的 DDL 或数据迁移 ID
  metadata: {                        // 静态元信息，执行前由 runner 输出
    expectedRows: "约 500 行（按 xxx 判据）",
    lockRisk: "row-level",           // 逐批 UPDATE，不把整个迁移包进一个长事务
    observableFields: ["rows"],      // run 必须输出的字段名
  },
  async run(context) {
    // 幂等、可重试、按批提交；进度经 context.log 输出
    const db = getAgentConfigDatabase();
    const rows = await db.update(agentConfig).set({ /* ... */ }).where(eq(agentConfig.id, "0")).returning({ id: agentConfig.id });
    context.log(`[data-migrate] backfilled xxx rows=${rows.length}`);
  },
  async verify(context) {
    // 从目标侧断言结果已完整；抛错即视为迁移未完成（runner 不写完成记录）
  },
  compensation: { kind: "none", reason: "旧值已不保留副本，靠重跑收敛" }, // 无可补偿也必须显式声明
};
```

2. 在包的 `package.json` 增加 `exports` 子路径指向该文件（与既有迁移同批，例如 `"./db/migration": "./db/data-migrations/<名字>.ts"`）：模块外的消费者只经包出口引用，不穿透路径。
   同一 owner 包出现**第二条及以后**的数据迁移时，两条不得复用 `"./db/migration"` 这一个子路径（后写的会覆盖前写的，而 runner 会因拿不到实现而判装载失败）——从第二条起用带短名的子路径区分，例如 `"./db/migration/<短名>": "./db/data-migrations/<名字>.ts"`，`fenix.module.ts` 的 `load` 也指到对应那一条。既有的 `"./db/migration"` 保持不动：它是已发布迁移的装载入口，改名等于让 runner 找不到实现。

3. 在包的 `fenix.module.ts` 声明该迁移的事实——ID、依赖与实现入口：

```ts
// packages/resources/agent-config/fenix.module.ts
dataMigrations: [
  {
    name: "agent-config/20260924-backfill-xxx", // 与实现的 name 逐字相同
    dependsOn: [],
    load: () => import("@fenix/agent-config/db/migration").then((module) => module.backfillXxx),
  },
],
```

4. 宿主不需要任何改动：部署期入口按装配汇总各模块 manifest 声明的迁移事实（外加宿主自有迁移）后统一执行，装配里增删模块即带动清单。声明与实现的 ID / 依赖在装载时逐字校验，写错会在执行前失败，而不是静默跑成另一条迁移。

### 执行机制

- 由部署期入口 `db/data-migration-runner.ts` 在发布步骤执行一次（镜像内为 `bun data-migration-runner.js`）。
  **应用进程启动不执行数据迁移**：一次性迁移只由部署发布任务承担，避免每个副本各跑一次含文件副作用的迁移。
- 发布顺序固定为：DDL 迁移（`migrate.js`）→ 数据迁移（`data-migration-runner.js`）→ 部署新版本进程。
- 该步骤的运行环境必须与应用一致（同一份环境变量与数据卷）：迁移会读模块配置（如 `skillDir`）并写文件。
- 迁移清单由 `resolveDataMigrations()` 汇总：各模块 manifest 声明的 `dataMigrations` 事实（按 registry 顺序）加宿主自有迁移，重复 ID 与声明/实现不一致都会在执行前失败。
- 每个迁移执行前会查询 `data_migrate_record` 表，**已执行过的迁移会自动跳过**。
- 迁移成功后将 `name` 写入 `data_migrate_record` 表作为执行记录。
- 迁移按清单顺序依次执行；顺序只决定日志顺序，依赖一律由各迁移的 `dependsOn` 表达并在执行前校验。
- 任一迁移失败即中止后续迁移并以非 0 退出，部署流水线据此失败停止。

### 注意事项

- 数据迁移的 `name` 在 `data_migrate_record` 表中唯一，不可重复。
- 迁移逻辑必须**保证幂等性**：如果中途失败，重新执行时会再次尝试，避免产生重复数据。
- 迁移中如果创建了文件/目录等副作用，失败时应清理已产生的半成品，防止下次执行误判为已完成。
- 数据迁移的 DDL 变更（如新增表）仍然需要通过 Drizzle 生成 DDL 迁移文件，两者独立但可协同。

---

## 注意事项

- 不要直接手写 SQL 去拼接多个节点，优先让 Drizzle 重新生成。
- 回滚数据库时注意先备份需要保留的数据。
- 重新生成后，要检查 `drizzle/meta/_journal.json`、snapshot 和数据库实际迁移记录是否一致。
- DDL 迁移（`drizzle/` 下的 SQL）只做表结构变更，不要在迁移 SQL 中手写数据操作（UPDATE/INSERT/DELETE），数据操作应走数据迁移流程。
