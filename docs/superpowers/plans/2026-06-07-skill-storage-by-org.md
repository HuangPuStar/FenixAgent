# Skill 存储按组织分层与启动数据迁移 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 skill 文件存储切换为 `data/skills/<organizationId>/<skillName>` 分层结构，删除 `skill.content_path`，并在系统启动时通过通用 `data_migrate` 机制自动迁移旧目录。

**架构：** `skill-fs.ts` 负责统一推导组织级 skill 路径，`skill.ts`、`launch-spec-builder.ts`、`meta-agent.ts`、`web/skills.ts` 全部改为依赖路径函数而不是落库物理路径。启动阶段新增 `data-migrate` runner，按代码顺序执行未记录过的迁移，本次 `migrate-skill-storage-by-organization` 负责把旧目录复制到新结构、重建 zip，并在成功后写入 `data_migrate_record`。

**技术栈：** TypeScript、Bun、Drizzle ORM、PostgreSQL、Biome

---

## 文件结构

**创建：**
- `src/services/data-migrate.ts`
  - 通用启动数据迁移 runner，维护迁移列表并写入 `data_migrate_record`
- `src/services/data-migrates/migrate-skill-storage-by-organization.ts`
  - 执行旧 `data/skills/<skillName>` 到新 `data/skills/<orgId>/<skillName>` 的迁移
- `src/__tests__/data-migrate.test.ts`
  - 覆盖迁移顺序、记录跳过、失败阻断
- `src/__tests__/skill-storage-migrate.test.ts`
  - 覆盖旧 skill 目录迁移、冲突跳过、zip 重建

**修改：**
- `src/db/schema.ts`
  - 删除 `skill.contentPath`，新增 `dataMigrateRecord`
- `src/services/config/types.ts`
  - 删除 `contentPath` 相关类型字段
- `src/services/config/skill.ts`
  - `upsertSkill()` 等配置层接口不再接收或返回 `contentPath`
- `src/services/skill-fs.ts`
  - 新增组织级路径函数并更新 archive helper
- `src/services/skill.ts`
  - skill CRUD、导入、共享访问全部改为按组织和名称现算路径
- `src/services/launch-spec-builder.ts`
  - skill source/archive 路径改为基于 skill 所属组织推导
- `src/services/meta-agent.ts`
  - 内置 skill 同步改为写入组织级目录
- `src/routes/web/skills.ts`
  - 下载 zip 时按 skill 所属组织推导 archive 路径
- `src/index.ts`
  - 在 `initDb()` 之后、`syncBuiltinSkills()` 之前执行 `runDataMigrations()`
- `src/__tests__/skill-fs-archive.test.ts`
  - 更新路径 helper 断言
- `src/__tests__/skill-archive-lifecycle.test.ts`
  - 去掉 `contentPath` 断言，改为组织级路径断言
- `src/__tests__/skill-resource-access.test.ts`
  - 共享 skill 路径解析改为按源组织推导
- `src/__tests__/config-skill-resource-access.test.ts`
  - 配置层共享 skill 类型改造
- `src/__tests__/skill-import-name-overwrite.test.ts`
  - 同名 skill 跨组织不覆盖
- `src/__tests__/skill-import-parallel-deletes.test.ts`
  - 更新 mock 的路径签名
- `src/__tests__/skill-import-shared-validation.test.ts`
  - 更新 mock 的路径签名
- `src/__tests__/launch-spec-builder-errors.test.ts`
  - 覆盖默认 skill 目录缺模型时的错误提示不受本次改造破坏
- `src/__tests__/launch-spec-agent-sharing-access.test.ts`
  - 共享 agent 关联 skill 的路径解析更新
- `src/__tests__/launch-spec-mcp-resource-access.test.ts`
  - 如涉及 skill path 日志或依赖，更新断言

**生成：**
- `drizzle/*`
  - 由 `bun run db:generate --name skill-storage-by-org` 生成的 schema 迁移文件

---

### 任务 1：更新 schema，删除 `content_path` 并引入 `data_migrate_record`

**文件：**
- 修改：`src/db/schema.ts`
- 生成：`drizzle/*`

- [x] **步骤 1：先在 schema 中删除 `skill.contentPath` 并新增 `dataMigrateRecord`**

```ts
export const skill = pgTable(
  "skill",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    name: varchar("name").notNull(),
    description: text("description"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_skill_org_name").on(table.organizationId, table.name),
  }),
);

export const dataMigrateRecord = pgTable(
  "data_migrate_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: varchar("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: uniqueIndex("idx_data_migrate_record_name").on(table.name),
  }),
);
```

- [x] **步骤 2：生成 Drizzle 迁移文件**

运行：`bun run db:generate --name skill-storage-by-org`
预期：`drizzle/` 下出现新的 SQL、snapshot 和 journal 更新，迁移内容包含删除 `content_path` 与新增 `data_migrate_record`

- [x] **步骤 3：用开发库验证 schema 可推送**

运行：`bun run db:push`
预期：命令成功结束，没有 schema 语法错误

- [x] **步骤 4：Commit**

```bash
git add src/db/schema.ts drizzle
git commit -m "feat(skill): 调整 skill schema 并新增数据迁移记录"
```

---

### 任务 2：收口组织级路径函数并先补底层测试

**文件：**
- 修改：`src/services/skill-fs.ts`
- 测试：`src/__tests__/skill-fs-archive.test.ts`

- [x] **步骤 1：先写失败测试，锁定新的路径规则**

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  getSkillArchivePath,
  getSkillMdPath,
  getSkillOrganizationDir,
  getSkillSourceDir,
} from "../services/skill-fs";

describe("skill-fs organization paths", () => {
  // skill 文件路径必须按组织分层，避免同名 skill 覆盖
  test("derives organization-scoped source, md and archive paths", () => {
    const root = "/tmp/skills";
    expect(getSkillOrganizationDir(root, "org_a")).toBe(join(root, "org_a"));
    expect(getSkillSourceDir(root, "org_a", "demo")).toBe(join(root, "org_a", "demo"));
    expect(getSkillMdPath(root, "org_a", "demo")).toBe(join(root, "org_a", "demo", "SKILL.md"));
    expect(getSkillArchivePath(root, "org_a", "demo")).toBe(join(root, "org_a", "demo.zip"));
  });
});
```

- [x] **步骤 2：运行测试确认现有 helper 还不支持新签名**

运行：`bun test src/__tests__/skill-fs-archive.test.ts`
预期：FAIL，提示 `getSkillSourceDir` / `getSkillArchivePath` 参数签名不匹配或路径断言失败

- [x] **步骤 3：在 `skill-fs.ts` 中补齐组织级路径 helper**

```ts
export function getSkillOrganizationDir(skillRoot: string, organizationId: string): string {
  return join(skillRoot, organizationId);
}

export function getSkillSourceDir(skillRoot: string, organizationId: string, name: string): string {
  return join(getSkillOrganizationDir(skillRoot, organizationId), name);
}

export function getSkillMdPath(skillRoot: string, organizationId: string, name: string): string {
  return join(getSkillSourceDir(skillRoot, organizationId, name), "SKILL.md");
}

export function getSkillArchivePath(skillRoot: string, organizationId: string, name: string): string {
  return join(getSkillOrganizationDir(skillRoot, organizationId), `${name}.zip`);
}
```

- [x] **步骤 4：运行测试确认 helper 层通过**

运行：`bun test src/__tests__/skill-fs-archive.test.ts`
预期：PASS，路径断言全部按 `orgId/name` 结构输出

- [x] **步骤 5：Commit**

```bash
git add src/services/skill-fs.ts src/__tests__/skill-fs-archive.test.ts
git commit -m "feat(skill): 收口组织级 skill 路径函数"
```

---

### 任务 3：移除配置层 `contentPath`，让 skill 元数据只保留逻辑字段

**文件：**
- 修改：`src/services/config/types.ts`
- 修改：`src/services/config/skill.ts`
- 测试：`src/__tests__/config-skill-resource-access.test.ts`

- [x] **步骤 1：先写失败测试，要求配置层不再暴露 `contentPath`**

```ts
import { describe, expect, test } from "bun:test";
import { mapSkillRowToConfig } from "../services/config/skill";

describe("config skill mapping", () => {
  // skill 的物理路径由文件系统规则推导，不应继续作为配置字段暴露
  test("does not expose contentPath in config rows", () => {
    const result = mapSkillRowToConfig({
      id: "skill_1",
      userId: "user_1",
      organizationId: "org_1",
      name: "shared",
      description: "demo",
      metadata: null,
      createdAt: new Date("2026-06-07T00:00:00.000Z"),
      updatedAt: new Date("2026-06-07T00:00:00.000Z"),
    });

    expect("contentPath" in result).toBe(false);
  });
});
```

- [x] **步骤 2：运行测试确认旧类型仍依赖 `contentPath`**

运行：`bun test src/__tests__/config-skill-resource-access.test.ts`
预期：FAIL，提示映射函数或返回类型仍含 `contentPath`

- [x] **步骤 3：修改配置层类型和 upsert 数据结构**

```ts
export type SkillUpsertData = {
  name: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
};

export type SkillConfigRow = {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
};
```

```ts
export async function upsertSkill(ctx: AuthContext, id: string | null, data: SkillUpsertData) {
  return db
    .insert(skill)
    .values({
      id: id ?? undefined,
      userId: ctx.userId,
      organizationId: ctx.organizationId,
      name: data.name,
      description: data.description ?? null,
      metadata: data.metadata ?? null,
    })
    .onConflictDoUpdate({
      target: [skill.organizationId, skill.name],
      set: {
        description: data.description ?? null,
        metadata: data.metadata ?? null,
        updatedAt: new Date(),
      },
    });
}
```

- [x] **步骤 4：运行配置层测试确认通过**

运行：`bun test src/__tests__/config-skill-resource-access.test.ts`
预期：PASS，配置层不再依赖 `contentPath`

- [x] **步骤 5：Commit**

```bash
git add src/services/config/types.ts src/services/config/skill.ts src/__tests__/config-skill-resource-access.test.ts
git commit -m "refactor(skill): 从配置层移除 contentPath"
```

---

### 任务 4：重写 skill 服务读写逻辑，统一按组织级路径读文件

**文件：**
- 修改：`src/services/skill.ts`
- 测试：`src/__tests__/skill-archive-lifecycle.test.ts`
- 测试：`src/__tests__/skill-resource-access.test.ts`
- 测试：`src/__tests__/skill-import-name-overwrite.test.ts`
- 测试：`src/__tests__/skill-import-parallel-deletes.test.ts`
- 测试：`src/__tests__/skill-import-shared-validation.test.ts`

- [x] **步骤 1：先写失败测试，锁定同名 skill 跨组织不覆盖与共享 skill 源路径解析**

```ts
test("setSkill writes same name into different organization directories", async () => {
  await setSkill({ organizationId: "org_a", userId: "user_1", role: "owner" }, {
    name: "demo",
    content: "A",
    description: "demo",
  });
  await setSkill({ organizationId: "org_b", userId: "user_2", role: "owner" }, {
    name: "demo",
    content: "B",
    description: "demo",
  });

  expect(writeSkillMd).toHaveBeenCalledWith(expect.stringContaining("/org_a/demo"), "demo", expect.anything(), "A", undefined);
  expect(writeSkillMd).toHaveBeenCalledWith(expect.stringContaining("/org_b/demo"), "demo", expect.anything(), "B", undefined);
});

test("getSkill(resourceKey) resolves shared skill from source organization directory", async () => {
  const detail = await getSkill(ctx, "org_source/shared");
  expect(readSkillDetailFromMd).toHaveBeenCalledWith(expect.stringContaining("/org_source/shared/SKILL.md"));
  expect(detail?.name).toBe("shared");
});
```

- [x] **步骤 2：运行核心 skill 测试确认失败**

运行：`bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-resource-access.test.ts src/__tests__/skill-import-name-overwrite.test.ts src/__tests__/skill-import-parallel-deletes.test.ts src/__tests__/skill-import-shared-validation.test.ts`
预期：FAIL，旧实现仍使用 `contentPath` 或全局 `data/skills/<name>`

- [x] **步骤 3：在 `skill.ts` 中删除 `contentPath` 依赖，改为统一按组织和名称推导**

```ts
function skillContentPath(organizationId: string, name: string): string {
  return _deps.skillFs.getSkillMdPath(getGlobalSkillsDir(), organizationId, name);
}

function skillSourceDir(organizationId: string, name: string): string {
  return _deps.skillFs.getSkillSourceDir(getGlobalSkillsDir(), organizationId, name);
}

function skillArchivePath(organizationId: string, name: string): string {
  return _deps.skillFs.getSkillArchivePath(getGlobalSkillsDir(), organizationId, name);
}
```

```ts
const skillDir = skillSourceDir(ctx.organizationId, safeName);
const archivePath = skillArchivePath(ctx.organizationId, safeName);
await _deps.skillFs.writeSkillMd(skillDir, safeName, descriptionText, data.content, data.metadata);
await _deps.skillFs.buildSkillArchive(skillDir, archivePath);
await _deps.configPg.upsertSkill(ctx, current?.id ?? null, {
  name: safeName,
  description: descriptionText,
  metadata: data.metadata,
});
```

```ts
const sourceOrgId = meta.resourceAccess?.sourceOrganizationId ?? meta.organizationId;
const contentPath = skillContentPath(sourceOrgId, meta.name);
const detail = await _deps.skillFs.readSkillDetailFromMd(contentPath);
```

- [x] **步骤 4：运行 skill 服务测试确认通过**

运行：`bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-resource-access.test.ts src/__tests__/skill-import-name-overwrite.test.ts src/__tests__/skill-import-parallel-deletes.test.ts src/__tests__/skill-import-shared-validation.test.ts`
预期：PASS，所有路径相关测试都改为组织级目录

- [x] **步骤 5：Commit**

```bash
git add src/services/skill.ts src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-resource-access.test.ts src/__tests__/skill-import-name-overwrite.test.ts src/__tests__/skill-import-parallel-deletes.test.ts src/__tests__/skill-import-shared-validation.test.ts
git commit -m "feat(skill): 按组织分层存储 skill 文件"
```

---

### 任务 5：增加启动数据迁移框架和本次 skill 存储迁移

**文件：**
- 创建：`src/services/data-migrate.ts`
- 创建：`src/services/data-migrates/migrate-skill-storage-by-organization.ts`
- 修改：`src/index.ts`
- 测试：`src/__tests__/data-migrate.test.ts`
- 测试：`src/__tests__/skill-storage-migrate.test.ts`

- [x] **步骤 1：先写失败测试，锁定 migrate runner 的顺序、幂等和失败阻断**

```ts
import { beforeEach, describe, expect, mock, test } from "bun:test";

describe("runDataMigrations", () => {
  beforeEach(() => {
    executed.length = 0;
  });

  // 已执行过的 migrate 不应重复执行，未执行过的按声明顺序跑
  test("runs unapplied migrations in order", async () => {
    listAppliedMigrationNames.mockResolvedValue(["migrate-a"]);
    await runDataMigrations();
    expect(executed).toEqual(["migrate-b"]);
  });

  // 任意 migrate 失败都应直接阻断启动，避免系统进入半迁移状态
  test("throws when migration fails", async () => {
    listAppliedMigrationNames.mockResolvedValue([]);
    failingMigration.run = mock(async () => {
      throw new Error("boom");
    });
    await expect(runDataMigrations()).rejects.toThrow("boom");
  });
});
```

```ts
test("moves legacy skill directory into organization-scoped location and rebuilds archive", async () => {
  await migrateSkillStorageByOrganization();
  expect(existsSync(join(root, "org_a", "demo", "SKILL.md"))).toBe(true);
  expect(existsSync(join(root, "org_a", "demo.zip"))).toBe(true);
  expect(existsSync(join(root, "demo"))).toBe(false);
});

test("skips deletion when both legacy and target directories exist", async () => {
  await migrateSkillStorageByOrganization();
  expect(existsSync(join(root, "demo"))).toBe(true);
  expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("target already exists"));
});
```

- [x] **步骤 2：运行迁移测试确认失败**

运行：`bun test src/__tests__/data-migrate.test.ts src/__tests__/skill-storage-migrate.test.ts`
预期：FAIL，runner 和具体 migrate 文件尚不存在

- [x] **步骤 3：实现通用 `data-migrate` runner**

```ts
type DataMigrate = {
  name: string;
  run: () => Promise<void>;
};

const DATA_MIGRATES: DataMigrate[] = [migrateSkillStorageByOrganization];

export async function runDataMigrations(): Promise<void> {
  const applied = new Set(await listDataMigrateRecordNames());
  for (const migrate of DATA_MIGRATES) {
    if (applied.has(migrate.name)) continue;
    await migrate.run();
    await insertDataMigrateRecord(migrate.name);
  }
}
```

- [x] **步骤 4：实现 skill 目录迁移逻辑**

```ts
export const migrateSkillStorageByOrganization = {
  name: "migrate-skill-storage-by-organization",
  async run(): Promise<void> {
    const rows = await listAllSkillsForMigration();
    const root = getGlobalSkillsDir();
    for (const row of rows) {
      const legacyDir = join(root, row.name);
      const targetDir = getSkillSourceDir(root, row.organizationId, row.name);
      const targetArchive = getSkillArchivePath(root, row.organizationId, row.name);
      if (!existsSync(legacyDir)) continue;
      if (existsSync(targetDir)) {
        logWarn(`[data-migrate] skill storage skip name='${row.name}' org='${row.organizationId}' because target already exists`);
        continue;
      }
      await mkdir(dirname(targetDir), { recursive: true });
      cpSync(legacyDir, targetDir, { recursive: true });
      await buildSkillArchive(targetDir, targetArchive);
      await rm(legacyDir, { recursive: true, force: true });
      await rm(join(root, `${row.name}.zip`), { force: true });
    }
  },
} satisfies DataMigrate;
```

- [x] **步骤 5：在启动入口接入 runner**

```ts
await initDb();
await runDataMigrations();

for (const org of organizations) {
  await syncBuiltinSkills({
    organizationId: org.id,
    userId: org.createdBy,
    role: "owner",
  });
}
```

- [x] **步骤 6：运行迁移测试确认通过**

运行：`bun test src/__tests__/data-migrate.test.ts src/__tests__/skill-storage-migrate.test.ts`
预期：PASS，未执行 migrate 会按顺序运行，成功后记账，冲突路径保守跳过

- [x] **步骤 7：Commit**

```bash
git add src/services/data-migrate.ts src/services/data-migrates/migrate-skill-storage-by-organization.ts src/index.ts src/__tests__/data-migrate.test.ts src/__tests__/skill-storage-migrate.test.ts
git commit -m "feat(skill): 增加启动数据迁移并迁移旧 skill 目录"
```

---

### 任务 6：更新 launch spec、内置 skill 同步和下载路由，完成端到端验证

**文件：**
- 修改：`src/services/launch-spec-builder.ts`
- 修改：`src/services/meta-agent.ts`
- 修改：`src/routes/web/skills.ts`
- 测试：`src/__tests__/launch-spec-agent-sharing-access.test.ts`
- 测试：`src/__tests__/launch-spec-mcp-resource-access.test.ts`
- 测试：`src/__tests__/launch-spec-builder-errors.test.ts`

- [x] **步骤 1：先写失败测试，锁定共享 skill 的 source/archive 路径按源组织计算**

```ts
test("buildLaunchSpec resolves shared skill archive from source organization", async () => {
  const spec = await buildLaunchSpec(input);
  expect(spec.skills?.[0]).toMatchObject({
    name: "shared-skill",
    sourceDir: expect.stringContaining("/org_source/shared-skill"),
    archivePath: expect.stringContaining("/org_source/shared-skill.zip"),
  });
});
```

- [x] **步骤 2：运行 launch spec 与路由相关测试确认失败**

运行：`bun test src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/launch-spec-builder-errors.test.ts`
预期：FAIL，旧实现仍从 `contentPath` 或当前组织目录取 skill 文件

- [x] **步骤 3：修改 builder、meta-agent 和下载路由的 skill 路径来源**

```ts
const sourceOrganizationId = row.resourceAccess?.sourceOrganizationId ?? row.organizationId;
const sourceDir = getSkillSourceDir(skillRoot, sourceOrganizationId, row.name);
const archivePath = getSkillArchivePath(skillRoot, sourceOrganizationId, row.name);
```

```ts
const targetDir = getSkillSourceDir(targetRoot, ctx.organizationId, builtin.name);
const archivePath = getSkillArchivePath(targetRoot, ctx.organizationId, builtin.name);
```

```ts
const skillRow = await getReadableSkillByName(ctx, name);
if (!skillRow) throw new NotFoundError(`Skill '${name}' not found`);
const archivePath = getSkillArchivePath(getGlobalSkillsDir(), skillRow.organizationId, name);
```

- [x] **步骤 4：运行相关测试确认通过**

运行：`bun test src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/launch-spec-builder-errors.test.ts`
预期：PASS，launch spec 与下载路径均切到组织级结构

- [x] **步骤 5：执行全量验证**

运行：`bun test src/__tests__/skill-fs-archive.test.ts src/__tests__/config-skill-resource-access.test.ts src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-resource-access.test.ts src/__tests__/skill-import-name-overwrite.test.ts src/__tests__/skill-import-parallel-deletes.test.ts src/__tests__/skill-import-shared-validation.test.ts src/__tests__/data-migrate.test.ts src/__tests__/skill-storage-migrate.test.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/launch-spec-builder-errors.test.ts`
预期：PASS，skill 相关核心回归全部通过

- [x] **步骤 6：执行仓库预检**

运行：`bun run precheck`
预期：PASS，`biome format`、`tsc`、`biome check` 全部通过；如果有仓库外部已知问题，先定位是否为本次改动引入

- [x] **步骤 7：Commit**

```bash
git add src/services/launch-spec-builder.ts src/services/meta-agent.ts src/routes/web/skills.ts src/__tests__/launch-spec-agent-sharing-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts src/__tests__/launch-spec-builder-errors.test.ts
git commit -m "feat(skill): 接通组织级 skill 路径到启动链路"
```

---

## 自检

- 规格覆盖度：已覆盖组织分层路径、删除 `content_path`、启动数据迁移、`data_migrate_record`、共享 skill 路径、launch spec、meta-agent、下载路由和回归测试
- 占位符扫描：计划内没有 `TODO`、`后续实现`、`补充细节` 等占位符
- 类型一致性：全篇统一使用 `organizationId + name` 推导 `sourceDir` / `SKILL.md` / `archivePath`，迁移 runner 统一使用 `dataMigrateRecord`

计划已完成并保存到 `docs/superpowers/plans/2026-06-07-skill-storage-by-org.md`。两种执行方式：

**1. 子代理驱动（推荐）** - 每个任务调度一个新的子代理，任务间进行审查，快速迭代

**2. 内联执行** - 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点

选哪种方式？
