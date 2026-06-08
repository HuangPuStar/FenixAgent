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

## 场景三：需要执行数据迁移（非 DDL）

当功能开发不仅涉及 schema 变更，还需要**对已有数据进行批量修改/搬迁**时，不能直接在 DDL 迁移 SQL 里手写数据操作。这类逻辑必须走代码迁移流程。

### 数据迁移 vs DDL 迁移的区别

| 类型 | 内容 | 执行方式 |
|------|------|----------|
| DDL 迁移（`drizzle/`） | 表结构变更（新增列、索引等） | `bun run db:migrate` 或 `migrate.js` |
| 数据迁移（`data-migrate.ts`） | 已有数据的批量处理/搬迁 | 服务启动时 `runDataMigrations()` 自动执行 |

### 如何新增一个数据迁移

1. 在 `src/services/data-migrates/` 下新建一个文件，实现 `DataMigrate` 接口：

```ts
// src/services/data-migrates/migrate-xxx.ts
import { db } from "../../db";
import { someTable } from "../../db/schema";

export const migrateXxx = {
  name: "migrate-xxx",  // 唯一标识，会写入 data_migrate_record 表
  async run(): Promise<void> {
    // 对已有数据执行批量处理
    // 注意：迁移逻辑需要保证幂等性，避免重复执行时出错
  },
};
```

2. 在 `src/services/data-migrate.ts` 的 `_deps.migrates` 数组中注册：

```ts
import { migrateXxx } from "./data-migrates/migrate-xxx";

export const _deps = {
  migrates: [
    migrateSkillStorageByOrganization,
    migrateXxx,  // 新增的迁移按顺序追加
  ] as DataMigrate[],
  // ...
};
```

### 执行机制

- 服务启动时（`src/index.ts`）自动调用 `runDataMigrations()`。
- 每个迁移执行前会查询 `data_migrate_record` 表，**已执行过的迁移会自动跳过**。
- 迁移成功后将 `name` 写入 `data_migrate_record` 表作为执行记录。
- 迁移按 `_deps.migrates` 数组中的顺序依次执行，不可变更已有迁移的顺序。

### 注意事项

- 数据迁移的 `name` 在 `data_migrate_record` 表中唯一，不可重复。
- 迁移逻辑必须**保证幂等性**：如果中途失败，下次启动会重新执行，避免产生重复数据。
- 迁移中如果创建了文件/目录等副作用，失败时应清理已产生的半成品，防止下次启动误判为已完成。
- 数据迁移的 DDL 变更（如新增表）仍然需要通过 Drizzle 生成 DDL 迁移文件，两者独立但可协同。

---

## 注意事项

- 不要直接手写 SQL 去拼接多个节点，优先让 Drizzle 重新生成。
- 回滚数据库时注意先备份需要保留的数据。
- 重新生成后，要检查 `drizzle/meta/_journal.json`、snapshot 和数据库实际迁移记录是否一致。
- DDL 迁移（`drizzle/` 下的 SQL）只做表结构变更，不要在迁移 SQL 中手写数据操作（UPDATE/INSERT/DELETE），数据操作应走数据迁移流程。
