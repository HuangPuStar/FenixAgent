# Workflow Definition Persistence + Versioning 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现工作流定义的数据库持久化 + 文件系统存储 + 版本管理（草稿/发布/latest 标签），前端提供列表页、编辑器集成（保存/发布）、版本历史页。

**Architecture:** 两张表（`workflow` 元数据 + `workflowVersion` 版本内容），YAML 文件存文件系统（`~/.agents/workflows/<teamId>/<workflowId>/`），数据库只存文件路径引用。后端独立路由 `POST /web/workflow-defs` 处理 12 个 action。前端新增列表页和版本历史页，编辑器集成保存/发布功能。

**Tech Stack:** Drizzle ORM + PostgreSQL（数据库）、Node.js fs（文件系统）、Elysia（路由）、React + @xyflow/react（前端）

---

## File Structure

### 后端新建文件

| 文件 | 职责 |
|------|------|
| `src/repositories/workflow-def.ts` | Repository 接口 + Drizzle 实现（workflow + workflowVersion 的 CRUD） |
| `src/services/workflow/workflow-fs.ts` | 文件系统操作（创建目录、读/写 YAML 文件、扫描恢复） |
| `src/routes/web/workflow-defs.ts` | API 路由（POST /web/workflow-defs，12 个 action 分发） |
| `src/__tests__/workflow-def.test.ts` | 后端测试（Repository + 路由） |

### 后端修改文件

| 文件 | 变更 |
|------|------|
| `src/db/schema.ts` | 修改 `workflow` 表（删 steps/enabled，加 latestVersion/storagePath），新建 `workflowVersion` 表，修改 `workflowRun` 表（加 version） |
| `src/index.ts` | 挂载新路由 `webWorkflowDefs` |
| `src/repositories/index.ts` | Re-export workflow-def repo |

### 前端新建文件

| 文件 | 职责 |
|------|------|
| `web/src/api/workflow-defs.ts` | API client（12 个 action 对应的方法） |
| `web/src/pages/workflow/WorkflowList.tsx` | 工作流列表页（表格 + 新建/删除/恢复） |
| `web/src/pages/workflow/WorkflowVersions.tsx` | 版本历史页（版本列表 + 恢复操作） |

### 前端修改文件

| 文件 | 变更 |
|------|------|
| `web/src/pages/WorkflowPage.tsx` | 路由改造：默认显示列表页，新增 /:id/edit 和 /:id/versions 路由 |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 集成保存/发布功能，接收 workflowId prop，加载/保存草稿 |

---

## Task 1: Database Schema 变更

**Files:**
- Modify: `src/db/schema.ts:526-569`
- Test: `src/__tests__/workflow-schema.test.ts`（可选，验证表定义正确）

### Step 1: 修改 workflow 表，删除 steps/enabled，新增 latestVersion/storagePath

在 `src/db/schema.ts` 中，将 workflow 表定义替换为：

```typescript
// Workflow 定义
export const workflow = pgTable(
  "workflow",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => team.id, { onDelete: "cascade" }),
    name: varchar("name").notNull(),
    description: text("description"),
    latestVersion: integer("latest_version"),
    storagePath: text("storage_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    teamNameIdx: uniqueIndex("idx_workflow_team_name").on(table.teamId, table.name),
  }),
);
```

注意：删除了 `steps: jsonb("steps").notNull()` 和 `enabled: boolean("enabled").notNull().default(true)`。新增了 `latestVersion: integer("latest_version")`（nullable，NULL=从未发布）和 `storagePath: text("storage_path")`。

### Step 2: 新建 workflowVersion 表

在 workflowRun 表定义之前插入：

```typescript
// Workflow 版本（草稿 + 已发布）
export const workflowVersion = pgTable(
  "workflow_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workflowId: uuid("workflow_id")
      .notNull()
      .references(() => workflow.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    filePath: text("file_path").notNull(),
    status: varchar("status", { length: 20 }).notNull(), // "draft" | "published"
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowVersionIdx: uniqueIndex("idx_workflow_version_unique").on(table.workflowId, table.version),
  }),
);
```

### Step 3: 修改 workflowRun 表，加 version 字段

在 workflowRun 表定义中新增一个字段（在 `workflowId` 之后）：

```typescript
version: integer("version"), // nullable：NULL=草稿执行，数字=已发布版本执行
```

### Step 4: 推送 schema 到数据库

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push
```

Expected: schema 同步成功，workflow 表删除 steps/enabled 列，新增 latest_version/storage_path 列；workflow_version 表创建成功；workflow_run 表新增 version 列。

### Step 5: Commit

```bash
git add src/db/schema.ts
git commit -m "feat: workflow definition schema — version table + storage path"
```

---

## Task 2: 文件系统服务

**Files:**
- Create: `src/services/workflow/workflow-fs.ts`
- Test: `src/__tests__/workflow-fs.test.ts`

### Step 1: 编写 workflow-fs 测试

创建 `src/__tests__/workflow-fs.test.ts`：

```typescript
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, exists, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ensureWorkflowDir,
  writeYamlFile,
  readYamlFile,
  listRecoverable,
  buildStoragePath,
} from "../services/workflow/workflow-fs";

let testRoot: string;

beforeEach(async () => {
  testRoot = join(tmpdir(), `wf-fs-test-${Date.now()}`);
  await mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("workflow-fs", () => {
  test("buildStoragePath 拼接正确路径", () => {
    const path = buildStoragePath(testRoot, "team-1", "wf-abc");
    expect(path).toBe(join(testRoot, "team-1", "wf-abc"));
  });

  test("ensureWorkflowDir 创建目录", async () => {
    const dir = buildStoragePath(testRoot, "team-1", "wf-abc");
    await ensureWorkflowDir(dir);
    expect(await exists(dir)).toBe(true);
  });

  test("writeYamlFile + readYamlFile 写读一致", async () => {
    const dir = buildStoragePath(testRoot, "team-1", "wf-abc");
    await ensureWorkflowDir(dir);
    const yaml = "schema_version: \"1\"\nname: test\n";
    await writeYamlFile(dir, "draft.yaml", yaml);
    const content = await readYamlFile(dir, "draft.yaml");
    expect(content).toBe(yaml);
  });

  test("readYamlFile 文件不存在返回 null", async () => {
    const dir = buildStoragePath(testRoot, "team-1", "wf-abc");
    await ensureWorkflowDir(dir);
    const content = await readYamlFile(dir, "draft.yaml");
    expect(content).toBeNull();
  });

  test("listRecoverable 返回文件存在但不在排除列表中的目录", async () => {
    // 创建 team-1 下两个工作流目录
    const dir1 = buildStoragePath(testRoot, "team-1", "wf-exists");
    const dir2 = buildStoragePath(testRoot, "team-1", "wf-orphan");
    await ensureWorkflowDir(dir1);
    await ensureWorkflowDir(dir2);
    await writeYamlFile(dir1, "draft.yaml", "name: exists\n");
    await writeYamlFile(dir2, "draft.yaml", "name: orphan\n");

    // 排除 wf-exists
    const result = await listRecoverable(testRoot, "team-1", new Set(["wf-exists"]));
    expect(result).toEqual(["wf-orphan"]);
  });
});
```

### Step 2: 运行测试确认失败

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/workflow-fs.test.ts
```

Expected: FAIL — 模块 `../services/workflow/workflow-fs` 不存在。

### Step 3: 实现 workflow-fs.ts

创建 `src/services/workflow/workflow-fs.ts`：

```typescript
/**
 * Workflow 文件系统操作。
 *
 * 所有工作流 YAML 文件存储在 ~/.agents/workflows/<teamId>/<workflowId>/ 下。
 * 目录名使用 workflowId（非 name），保证重命名不影响路径。
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 工作流文件存储根目录 */
export const WORKFLOW_BASE_DIR = join(homedir(), ".agents", "workflows");

/** 拼接工作流目录绝对路径 */
export function buildStoragePath(baseDir: string, teamId: string, workflowId: string): string {
  return join(baseDir, teamId, workflowId);
}

/** 确保工作流目录存在 */
export async function ensureWorkflowDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** 写入 YAML 文件 */
export async function writeYamlFile(dir: string, fileName: string, content: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, fileName), content, "utf-8");
}

/** 读取 YAML 文件，不存在返回 null */
export async function readYamlFile(dir: string, fileName: string): Promise<string | null> {
  const filePath = join(dir, fileName);
  if (!existsSync(filePath)) return null;
  return readFile(filePath, "utf-8");
}

/**
 * 扫描文件系统中可恢复的孤立工作流目录。
 * 返回在文件系统中存在但不在 excludeIds 集合中的 workflowId 列表。
 */
export async function listRecoverable(baseDir: string, teamId: string, excludeIds: Set<string>): Promise<string[]> {
  const teamDir = join(baseDir, teamId);
  if (!existsSync(teamDir)) return [];

  const entries = await readdir(teamDir, { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

  return dirs.filter((id) => !excludeIds.has(id));
}
```

### Step 4: 运行测试确认通过

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/workflow-fs.test.ts
```

Expected: 5 tests PASS。

### Step 5: Commit

```bash
git add src/services/workflow/workflow-fs.ts src/__tests__/workflow-fs.test.ts
git commit -m "feat: workflow filesystem service — read/write YAML + recoverable scan"
```

---

## Task 3: Workflow Definition Repository

**Files:**
- Create: `src/repositories/workflow-def.ts`
- Modify: `src/repositories/index.ts`
- Test: `src/__tests__/workflow-def-repo.test.ts`

### Step 1: 编写 repository 测试

创建 `src/__tests__/workflow-def-repo.test.ts`：

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { workflow, workflowVersion } from "../db/schema";
import {
  createWorkflowDef,
  saveDraft,
  publishVersion,
  listWorkflowDefs,
  getWorkflowDef,
  getVersions,
  getVersionYaml,
  setLatestVersion,
  deleteWorkflowDef,
  updateWorkflowMeta,
  listRecoverableWorkflows,
  recoverWorkflows,
  type WorkflowDefRow,
  type WorkflowVersionRow,
} from "../repositories/workflow-def";

// 测试用的 teamId 和 userId（需要在数据库中存在）
const TEST_TEAM_ID = "00000000-0000-0000-0000-000000000001";
const TEST_USER_ID = "test-user-workflow-def";

// 使用临时目录避免污染真实文件系统
const TEST_STORAGE_ROOT = join(tmpdir(), `wf-repo-test-${Date.now()}`);

// 直接 mock workflow-fs 的目录路径
let testDir: string;

// 辅助：创建测试工作流（直接写 DB + 文件系统）
async function seedWorkflow(name: string): Promise<string> {
  const [row] = await db
    .insert(workflow)
    .values({
      userId: TEST_USER_ID,
      teamId: TEST_TEAM_ID,
      name,
      storagePath: join(testDir, TEST_TEAM_ID, "placeholder"),
    })
    .returning();
  return row.id;
}

describe("workflow-def repository", () => {
  beforeEach(async () => {
    testDir = TEST_STORAGE_ROOT;
    // 清理测试数据
    await db.delete(workflowVersion).where(eq(workflowVersion.createdBy, TEST_USER_ID));
    await db.delete(workflow).where(eq(workflow.userId, TEST_USER_ID));
  });

  test("createWorkflowDef 创建工作流 + 草稿版本", async () => {
    const result = await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "test-workflow", description: "test desc" },
      testDir,
    );

    expect(result.id).toBeDefined();
    expect(result.name).toBe("test-workflow");
    expect(result.storagePath).toContain(TEST_TEAM_ID);
    expect(result.storagePath).toContain(result.id);

    // 验证文件系统目录已创建（由 workflow-fs 的 ensureWorkflowDir 完成）
    const { existsSync } = await import("node:fs");
    expect(existsSync(result.storagePath!)).toBe(true);
  });

  test("saveDraft 保存草稿 YAML", async () => {
    const wf = await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "save-draft-test", description: "" },
      testDir,
    );

    await saveDraft(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID }, "name: hello\n");

    const yaml = await getVersionYaml(wf.id, 0);
    expect(yaml).toBe("name: hello\n");
  });

  test("publishVersion 发布版本并更新 latest", async () => {
    const wf = await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "publish-test", description: "" },
      testDir,
    );

    await saveDraft(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID }, "name: v1-content\n");
    const v = await publishVersion(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID });

    expect(v.version).toBe(1);
    expect(v.status).toBe("published");

    // 验证 latestVersion 已更新
    const updated = await getWorkflowDef(wf.id, TEST_TEAM_ID);
    expect(updated?.latestVersion).toBe(1);

    // 验证 v1.yaml 文件内容
    const yaml = await getVersionYaml(wf.id, 1);
    expect(yaml).toBe("name: v1-content\n");
  });

  test("listWorkflowDefs 列出工作流", async () => {
    await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "list-1", description: "" },
      testDir,
    );
    await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "list-2", description: "" },
      testDir,
    );

    const list = await listWorkflowDefs(TEST_TEAM_ID);
    expect(list.length).toBeGreaterThanOrEqual(2);
    const names = list.map((w) => w.name);
    expect(names).toContain("list-1");
    expect(names).toContain("list-2");
  });

  test("setLatestVersion 移动 latest 指针", async () => {
    const wf = await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "rollback-test", description: "" },
      testDir,
    );

    await saveDraft(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID }, "name: v1\n");
    await publishVersion(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID });

    await saveDraft(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID }, "name: v2\n");
    await publishVersion(wf.id, { teamId: TEST_TEAM_ID, userId: TEST_USER_ID });

    // 回滚到 v1
    await setLatestVersion(wf.id, TEST_TEAM_ID, 1);

    const updated = await getWorkflowDef(wf.id, TEST_TEAM_ID);
    expect(updated?.latestVersion).toBe(1);
  });

  test("deleteWorkflowDef 只删数据库记录", async () => {
    const wf = await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "delete-test", description: "" },
      testDir,
    );

    const storagePath = wf.storagePath!;
    const { existsSync } = await import("node:fs");

    await deleteWorkflowDef(wf.id, TEST_TEAM_ID);

    // 数据库记录已删
    const found = await getWorkflowDef(wf.id, TEST_TEAM_ID);
    expect(found).toBeNull();

    // 文件系统目录仍然存在
    expect(existsSync(storagePath)).toBe(true);
  });

  test("updateWorkflowMeta 更新名称和描述", async () => {
    const wf = await createWorkflowDef(
      { teamId: TEST_TEAM_ID, userId: TEST_USER_ID },
      { name: "old-name", description: "old-desc" },
      testDir,
    );

    await updateWorkflowMeta(wf.id, TEST_TEAM_ID, { name: "new-name", description: "new-desc" });

    const updated = await getWorkflowDef(wf.id, TEST_TEAM_ID);
    expect(updated?.name).toBe("new-name");
    expect(updated?.description).toBe("new-desc");
  });
});
```

### Step 2: 运行测试确认失败

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/workflow-def-repo.test.ts
```

Expected: FAIL — 模块不存在。

### Step 3: 实现 repository

创建 `src/repositories/workflow-def.ts`：

```typescript
/**
 * Workflow Definition Repository。
 *
 * 管理工作流定义（workflow 表）和版本（workflowVersion 表）的 CRUD。
 * YAML 内容通过 workflow-fs 读写文件系统，数据库只存路径引用。
 */

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db";
import { workflow, workflowVersion } from "../db/schema";
import {
  buildStoragePath,
  ensureWorkflowDir,
  readYamlFile,
  writeYamlFile,
  listRecoverable as fsListRecoverable,
  WORKFLOW_BASE_DIR,
} from "../services/workflow/workflow-fs";

// ── 类型 ──

export interface WorkflowDefRow {
  id: string;
  userId: string;
  teamId: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  storagePath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowVersionRow {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: Date;
}

export interface AuthCtx {
  teamId: string;
  userId: string;
}

// ── CRUD ──

/** 创建工作流定义 + 空草稿目录 */
export async function createWorkflowDef(
  ctx: AuthCtx,
  data: { name: string; description?: string },
  baseDir: string = WORKFLOW_BASE_DIR,
): Promise<WorkflowDefRow> {
  const [row] = await db
    .insert(workflow)
    .values({
      userId: ctx.userId,
      teamId: ctx.teamId,
      name: data.name,
      description: data.description ?? null,
      storagePath: "", // 先空，拿到 id 后更新
    })
    .returning();

  // 用 id 拼接 storagePath
  const storagePath = buildStoragePath(baseDir, ctx.teamId, row.id);
  await db.update(workflow).set({ storagePath }).where(eq(workflow.id, row.id));

  // 确保文件系统目录存在
  await ensureWorkflowDir(storagePath);

  return { ...row, storagePath };
}

/** 保存草稿（upsert version=0） */
export async function saveDraft(
  workflowId: string,
  ctx: AuthCtx,
  yaml: string,
): Promise<void> {
  const [wf] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.teamId, ctx.teamId)))
    .limit(1);
  if (!wf || !wf.storagePath) throw new Error("Workflow not found");

  const fileName = "draft.yaml";
  await writeYamlFile(wf.storagePath, fileName, yaml);

  // Upsert version=0
  const existing = await db
    .select()
    .from(workflowVersion)
    .where(and(eq(workflowVersion.workflowId, workflowId), eq(workflowVersion.version, 0)))
    .limit(1);

  if (existing.length > 0) {
    await db
      .update(workflowVersion)
      .set({ filePath: fileName })
      .where(eq(workflowVersion.id, existing[0].id));
  } else {
    await db.insert(workflowVersion).values({
      workflowId,
      version: 0,
      filePath: fileName,
      status: "draft",
      createdBy: ctx.userId,
    });
  }

  // 更新 workflow.updatedAt
  await db.update(workflow).set({ updatedAt: new Date() }).where(eq(workflow.id, workflowId));
}

/** 发布版本：复制草稿内容到 v{n}.yaml，更新 latestVersion */
export async function publishVersion(
  workflowId: string,
  ctx: AuthCtx,
): Promise<WorkflowVersionRow> {
  const [wf] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.teamId, ctx.teamId)))
    .limit(1);
  if (!wf || !wf.storagePath) throw new Error("Workflow not found");

  // 读取草稿内容
  const draftYaml = await readYamlFile(wf.storagePath, "draft.yaml");
  if (!draftYaml) throw new Error("No draft to publish");

  // 计算新版本号
  const nextVersion = (wf.latestVersion ?? 0) + 1;
  const fileName = `v${nextVersion}.yaml`;

  // 写入文件
  await writeYamlFile(wf.storagePath, fileName, draftYaml);

  // 插入版本记录
  const [vRow] = await db
    .insert(workflowVersion)
    .values({
      workflowId,
      version: nextVersion,
      filePath: fileName,
      status: "published",
      createdBy: ctx.userId,
    })
    .returning();

  // 更新 latestVersion
  await db.update(workflow).set({ latestVersion: nextVersion }).where(eq(workflow.id, workflowId));

  return vRow;
}

/** 列出工作流（按 updatedAt 降序） */
export async function listWorkflowDefs(teamId: string): Promise<WorkflowDefRow[]> {
  return db
    .select()
    .from(workflow)
    .where(eq(workflow.teamId, teamId))
    .orderBy(desc(workflow.updatedAt));
}

/** 获取单个工作流 */
export async function getWorkflowDef(
  workflowId: string,
  teamId: string,
): Promise<WorkflowDefRow | null> {
  const [row] = await db
    .select()
    .from(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.teamId, teamId)))
    .limit(1);
  return row ?? null;
}

/** 获取版本历史列表（不含草稿） */
export async function getVersions(
  workflowId: string,
  teamId: string,
): Promise<WorkflowVersionRow[]> {
  // 先验证 workflow 属于该 team
  const wf = await getWorkflowDef(workflowId, teamId);
  if (!wf) return [];

  return db
    .select()
    .from(workflowVersion)
    .where(and(eq(workflowVersion.workflowId, workflowId), sql`${workflowVersion.version} > 0`))
    .orderBy(desc(workflowVersion.version));
}

/** 获取特定版本的 YAML 内容 */
export async function getVersionYaml(
  workflowId: string,
  version: number,
): Promise<string | null> {
  const [wf] = await db
    .select()
    .from(workflow)
    .where(eq(workflow.id, workflowId))
    .limit(1);
  if (!wf?.storagePath) return null;

  const fileName = version === 0 ? "draft.yaml" : `v${version}.yaml`;
  return readYamlFile(wf.storagePath, fileName);
}

/** 设置 latest 指针到指定版本（回滚） */
export async function setLatestVersion(
  workflowId: string,
  teamId: string,
  version: number,
): Promise<void> {
  // 验证版本存在
  const [vRow] = await db
    .select()
    .from(workflowVersion)
    .where(and(eq(workflowVersion.workflowId, workflowId), eq(workflowVersion.version, version)))
    .limit(1);
  if (!vRow) throw new Error(`Version ${version} not found`);

  await db
    .update(workflow)
    .set({ latestVersion: version })
    .where(and(eq(workflow.id, workflowId), eq(workflow.teamId, teamId)));
}

/** 删除工作流（只删数据库，不动文件系统） */
export async function deleteWorkflowDef(
  workflowId: string,
  teamId: string,
): Promise<boolean> {
  // version 行由 CASCADE 自动删除
  const result = await db
    .delete(workflow)
    .where(and(eq(workflow.id, workflowId), eq(workflow.teamId, teamId)))
    .returning();
  return result.length > 0;
}

/** 更新工作流元数据（name, description） */
export async function updateWorkflowMeta(
  workflowId: string,
  teamId: string,
  data: { name?: string; description?: string },
): Promise<WorkflowDefRow | null> {
  const updates: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) updates.name = data.name;
  if (data.description !== undefined) updates.description = data.description;

  const [row] = await db
    .update(workflow)
    .set(updates)
    .where(and(eq(workflow.id, workflowId), eq(workflow.teamId, teamId)))
    .returning();
  return row ?? null;
}

/** 扫描文件系统中可恢复的孤立工作流 */
export async function listRecoverableWorkflows(
  teamId: string,
): Promise<string[]> {
  // 获取数据库中已有的 workflowId 集合
  const existing = await db
    .select({ id: workflow.id })
    .from(workflow)
    .where(eq(workflow.teamId, teamId));
  const existingIds = new Set(existing.map((r) => r.id));

  return fsListRecoverable(WORKFLOW_BASE_DIR, teamId, existingIds);
}

/** 从文件系统恢复工作流 */
export async function recoverWorkflows(
  ctx: AuthCtx,
  workflowIds: string[],
): Promise<WorkflowDefRow[]> {
  const results: WorkflowDefRow[] = [];
  for (const wid of workflowIds) {
    const dir = buildStoragePath(WORKFLOW_BASE_DIR, ctx.teamId, wid);
    // 尝试读取 draft.yaml 获取 name
    const draftYaml = await readYamlFile(dir, "draft.yaml");
    let name = wid;
    if (draftYaml) {
      const match = draftYaml.match(/^name:\s*(.+)$/m);
      if (match) name = match[1].trim();
    }

    const [row] = await db
      .insert(workflow)
      .values({
        id: wid,
        userId: ctx.userId,
        teamId: ctx.teamId,
        name,
        storagePath: dir,
      })
      .returning();

    // 重建 draft version 记录
    if (draftYaml) {
      await db.insert(workflowVersion).values({
        workflowId: wid,
        version: 0,
        filePath: "draft.yaml",
        status: "draft",
        createdBy: ctx.userId,
      }).onConflictDoNothing();
    }

    // 扫描已发布版本
    const { readdir: readdirFn } = await import("node:fs/promises");
    try {
      const files = await readdirFn(dir);
      const versionFiles = files.filter((f) => /^v(\d+)\.yaml$/.test(f));
      for (const f of versionFiles) {
        const ver = parseInt(f.match(/^v(\d+)\.yaml$/)![1], 10);
        await db.insert(workflowVersion).values({
          workflowId: wid,
          version: ver,
          filePath: f,
          status: "published",
          createdBy: ctx.userId,
        }).onConflictDoNothing();
      }
      // 更新 latestVersion
      if (versionFiles.length > 0) {
        const maxVer = Math.max(...versionFiles.map((f) => parseInt(f.match(/^v(\d+)/)![1], 10)));
        await db.update(workflow).set({ latestVersion: maxVer }).where(eq(workflow.id, wid));
      }
    } catch {
      // 目录不存在或为空
    }

    results.push({ ...row, storagePath: dir });
  }
  return results;
}

/** 恢复草稿到编辑器（从已发布版本复制内容到草稿） */
export async function restoreVersionToDraft(
  workflowId: string,
  ctx: AuthCtx,
  version: number,
): Promise<void> {
  const yaml = await getVersionYaml(workflowId, version);
  if (!yaml) throw new Error(`Version ${version} not found`);
  await saveDraft(workflowId, ctx, yaml);
}
```

### Step 4: 更新 repositories/index.ts

在 `src/repositories/index.ts` 末尾添加 re-export：

```typescript
export type { WorkflowDefRow, WorkflowVersionRow, AuthCtx as WorkflowAuthCtx } from "./workflow-def";
export {
  createWorkflowDef,
  saveDraft,
  publishVersion,
  listWorkflowDefs,
  getWorkflowDef,
  getVersions,
  getVersionYaml,
  setLatestVersion,
  deleteWorkflowDef,
  updateWorkflowMeta,
  listRecoverableWorkflows,
  recoverWorkflows,
  restoreVersionToDraft,
} from "./workflow-def";
```

### Step 5: 运行测试

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/workflow-def-repo.test.ts
```

Expected: 需要数据库连接。如果 CI 环境无 DB，可跳过集成测试，依赖本地验证。

### Step 6: Commit

```bash
git add src/repositories/workflow-def.ts src/repositories/index.ts src/__tests__/workflow-def-repo.test.ts
git commit -m "feat: workflow definition repository — CRUD + version management"
```

---

## Task 4: 后端 API 路由 + 挂载

**Files:**
- Create: `src/routes/web/workflow-defs.ts`
- Modify: `src/index.ts`（挂载新路由）

### Step 1: 创建 workflow-defs 路由

创建 `src/routes/web/workflow-defs.ts`：

```typescript
/**
 * Workflow Definition API 路由。
 *
 * POST /web/workflow-defs — action 分发，管理工作流定义和版本。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { loadTeamContext } from "../../services/team-context";
import {
  createWorkflowDef,
  saveDraft,
  publishVersion,
  listWorkflowDefs,
  getWorkflowDef,
  getVersions,
  getVersionYaml,
  setLatestVersion,
  deleteWorkflowDef,
  updateWorkflowMeta,
  listRecoverableWorkflows,
  recoverWorkflows,
  restoreVersionToDraft,
} from "../../repositories/workflow-def";

const app = new Elysia({ name: "web-workflow-defs", prefix: "/web" }).use(authGuardPlugin);

app.post(
  "/workflow-defs",
  async ({ store, body, error, request }: any) => {
    const authCtx = (await loadTeamContext(store.user!, request as any))!;
    if (!authCtx) return error(401, { error: { type: "UNAUTHORIZED", message: "No team context" } });

    const payload = body as Record<string, unknown>;
    const action = payload.action as string;

    try {
      switch (action) {
        case "create": {
          const name = payload.name as string;
          const description = payload.description as string | undefined;
          if (!name || !name.trim()) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "name is required" } });
          }
          const row = await createWorkflowDef(authCtx, { name: name.trim(), description });
          return { success: true, data: row };
        }

        case "save": {
          const workflowId = payload.workflowId as string;
          const yaml = payload.yaml as string;
          if (!workflowId || !yaml) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and yaml are required" } });
          }
          await saveDraft(workflowId, authCtx, yaml);
          return { success: true };
        }

        case "publish": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          }
          const vRow = await publishVersion(workflowId, authCtx);
          return { success: true, data: vRow };
        }

        case "list": {
          const list = await listWorkflowDefs(authCtx.teamId);
          return { success: true, data: list };
        }

        case "get": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const wf = await getWorkflowDef(workflowId, authCtx.teamId);
          if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          // 附带草稿 YAML 内容
          const draftYaml = await getVersionYaml(workflowId, 0);
          return { success: true, data: { ...wf, draftYaml } };
        }

        case "getVersions": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const versions = await getVersions(workflowId, authCtx.teamId);
          return { success: true, data: versions };
        }

        case "getVersion": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and version are required" } });
          }
          const yaml = await getVersionYaml(workflowId, version);
          if (!yaml) return error(404, { error: { type: "NOT_FOUND", message: "Version not found" } });
          return { success: true, data: { workflowId, version, yaml } };
        }

        case "setLatest": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and version are required" } });
          }
          await setLatestVersion(workflowId, authCtx.teamId, version);
          return { success: true };
        }

        case "delete": {
          const workflowId = payload.workflowId as string;
          if (!workflowId) return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const deleted = await deleteWorkflowDef(workflowId, authCtx.teamId);
          if (!deleted) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          return { success: true };
        }

        case "updateMeta": {
          const workflowId = payload.workflowId as string;
          const name = payload.name as string | undefined;
          const description = payload.description as string | undefined;
          if (!workflowId) return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
          const updated = await updateWorkflowMeta(workflowId, authCtx.teamId, { name, description });
          if (!updated) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
          return { success: true, data: updated };
        }

        case "recover": {
          const ids = await listRecoverableWorkflows(authCtx.teamId);
          return { success: true, data: ids };
        }

        case "recoverApply": {
          const workflowIds = payload.workflowIds as string[];
          if (!Array.isArray(workflowIds) || workflowIds.length === 0) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowIds array is required" } });
          }
          const recovered = await recoverWorkflows(authCtx, workflowIds);
          return { success: true, data: recovered };
        }

        case "restoreToDraft": {
          const workflowId = payload.workflowId as string;
          const version = payload.version as number;
          if (!workflowId || version === undefined) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId and version are required" } });
          }
          await restoreVersionToDraft(workflowId, authCtx, version);
          return { success: true };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      console.error("[workflow-defs] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
```

### Step 2: 挂载路由到 index.ts

在 `src/index.ts` 中：

1. 添加 import（在 `webWorkflowEngine` import 旁边）：
```typescript
import webWorkflowDefs from "./routes/web/workflow-defs";
```

2. 在 `.use(webWorkflowEngine)` 之后添加：
```typescript
.use(webWorkflowDefs)
```

### Step 3: 验证启动

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev
```

Expected: 服务正常启动，无 import 错误。Swagger 文档 `/docs/swagger` 出现新的 "Workflow Defs" 标签。

### Step 4: Commit

```bash
git add src/routes/web/workflow-defs.ts src/index.ts
git commit -m "feat: workflow-defs API route — 13 action dispatch"
```

---

## Task 5: 前端 API Client

**Files:**
- Create: `web/src/api/workflow-defs.ts`

### Step 1: 创建 API client

创建 `web/src/api/workflow-defs.ts`：

```typescript
/**
 * Workflow Definition API Client。
 *
 * 对接后端 POST /web/workflow-defs，通过 action 字段分发。
 */

// ── 类型定义 ──

export interface WorkflowDefItem {
  id: string;
  userId: string;
  teamId: string;
  name: string;
  description: string | null;
  latestVersion: number | null;
  storagePath: string | null;
  createdAt: string;
  updatedAt: string;
  draftYaml?: string | null;
}

export interface WorkflowVersionItem {
  id: string;
  workflowId: string;
  version: number;
  filePath: string;
  status: string;
  createdBy: string;
  createdAt: string;
}

export interface VersionYamlResponse {
  workflowId: string;
  version: number;
  yaml: string;
}

// ── API Helper ──

async defFetch<T>(
  action: string,
  extra?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch("/web/workflow-defs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });

  const json = await res.json();

  if (!res.ok) {
    const errInfo = json.error ?? { message: res.statusText };
    throw new Error(errInfo.message ?? errInfo.type ?? `请求失败 (${res.status})`);
  }

  return json.success && json.data !== undefined ? (json.data as T) : (json as T);
}

// ── API Methods ──

export const workflowDefApi = {
  /** 创建工作流 */
  async create(name: string, description?: string): Promise<WorkflowDefItem> {
    return defFetch<WorkflowDefItem>("create", { name, description });
  },

  /** 保存草稿 */
  async save(workflowId: string, yaml: string): Promise<void> {
    await defFetch("save", { workflowId, yaml });
  },

  /** 发布版本 */
  async publish(workflowId: string): Promise<WorkflowVersionItem> {
    return defFetch<WorkflowVersionItem>("publish", { workflowId });
  },

  /** 列出工作流 */
  async list(): Promise<WorkflowDefItem[]> {
    return defFetch<WorkflowDefItem[]>("list");
  },

  /** 获取单个工作流（含草稿内容） */
  async get(workflowId: string): Promise<WorkflowDefItem> {
    return defFetch<WorkflowDefItem>("get", { workflowId });
  },

  /** 获取版本历史 */
  async getVersions(workflowId: string): Promise<WorkflowVersionItem[]> {
    return defFetch<WorkflowVersionItem[]>("getVersions", { workflowId });
  },

  /** 获取特定版本 YAML */
  async getVersion(workflowId: string, version: number): Promise<VersionYamlResponse> {
    return defFetch<VersionYamlResponse>("getVersion", { workflowId, version });
  },

  /** 设置 latest 指针（回滚） */
  async setLatest(workflowId: string, version: number): Promise<void> {
    await defFetch("setLatest", { workflowId, version });
  },

  /** 删除工作流 */
  async delete(workflowId: string): Promise<void> {
    await defFetch("delete", { workflowId });
  },

  /** 更新元数据 */
  async updateMeta(workflowId: string, data: { name?: string; description?: string }): Promise<WorkflowDefItem> {
    return defFetch<WorkflowDefItem>("updateMeta", { workflowId, ...data });
  },

  /** 扫描可恢复的工作流 ID */
  async recover(): Promise<string[]> {
    return defFetch<string[]>("recover");
  },

  /** 执行恢复 */
  async recoverApply(workflowIds: string[]): Promise<WorkflowDefItem[]> {
    return defFetch<WorkflowDefItem[]>("recoverApply", { workflowIds });
  },

  /** 恢复版本到草稿 */
  async restoreToDraft(workflowId: string, version: number): Promise<void> {
    await defFetch("restoreToDraft", { workflowId, version });
  },
};
```

注意：`defFetch` 函数名前面缺少 `function` 关键字，需要修正为 `async function defFetch<T>(...)`。

### Step 2: 验证构建

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: 构建成功，无类型错误。

### Step 3: Commit

```bash
git add web/src/api/workflow-defs.ts
git commit -m "feat: workflow-defs frontend API client"
```

---

## Task 6: 前端工作流列表页

**Files:**
- Create: `web/src/pages/workflow/WorkflowList.tsx`

### Step 1: 创建 WorkflowList 组件

创建 `web/src/pages/workflow/WorkflowList.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  Inbox,
  Loader,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  Edit3,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
import { workflowDefApi, type WorkflowDefItem } from "../../api/workflow-defs";

interface WorkflowListProps {
  onEditWorkflow: (workflowId: string) => void;
  onViewVersions: (workflowId: string) => void;
}

export function WorkflowList({ onEditWorkflow, onViewVersions }: WorkflowListProps) {
  const [workflows, setWorkflows] = useState<WorkflowDefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // 恢复相关
  const [recoverableIds, setRecoverableIds] = useState<string[]>([]);
  const [selectedRecoverIds, setSelectedRecoverIds] = useState<Set<string>>(new Set());
  const [showRecoverPanel, setShowRecoverPanel] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await workflowDefApi.list();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const filtered = workflows.filter((w) => {
    if (searchQuery && !w.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const wf = await workflowDefApi.create(createName.trim(), createDesc.trim() || undefined);
      setShowCreateDialog(false);
      setCreateName("");
      setCreateDesc("");
      onEditWorkflow(wf.id);
    } catch (err) {
      console.error(err);
      alert("创建失败: " + (err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [createName, createDesc, onEditWorkflow]);

  const handleDelete = useCallback(
    async (wf: WorkflowDefItem) => {
      if (!confirm(`确定要删除「${wf.name}」吗？数据库记录将被删除，但文件系统保留。`)) return;
      try {
        await workflowDefApi.delete(wf.id);
        loadList();
      } catch (err) {
        console.error(err);
        alert("删除失败: " + (err as Error).message);
      }
    },
    [loadList],
  );

  const handleScanRecover = useCallback(async () => {
    try {
      const ids = await workflowDefApi.recover();
      setRecoverableIds(ids);
      setSelectedRecoverIds(new Set());
      setShowRecoverPanel(true);
    } catch (err) {
      console.error(err);
      alert("扫描失败: " + (err as Error).message);
    }
  }, []);

  const handleRecoverApply = useCallback(async () => {
    if (selectedRecoverIds.size === 0) return;
    setRecovering(true);
    try {
      await workflowDefApi.recoverApply(Array.from(selectedRecoverIds));
      setShowRecoverPanel(false);
      loadList();
    } catch (err) {
      console.error(err);
      alert("恢复失败: " + (err as Error).message);
    } finally {
      setRecovering(false);
    }
  }, [selectedRecoverIds, loadList]);

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return new Date(iso).toLocaleDateString("zh-CN");
  }

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 标题栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>工作流</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={handleScanRecover}
            style={{
              display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
              border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
              fontSize: 12, color: "#374151", cursor: "pointer",
            }}
          >
            <RotateCcw size={13} /> 扫描恢复
          </button>
          <button
            type="button"
            onClick={loadList}
            style={{
              display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
              border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
              fontSize: 12, color: "#374151", cursor: "pointer",
            }}
          >
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <div
          style={{
            display: "flex", alignItems: "center", gap: 6, flex: 1, maxWidth: 260,
            border: "1px solid #e5e7eb", borderRadius: 6, padding: "5px 10px", background: "#fff",
          }}
        >
          <Search size={13} style={{ color: "#9ca3af", flexShrink: 0 }} />
          <input
            placeholder="搜索工作流名称..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ border: "none", outline: "none", fontSize: 12, width: "100%", background: "transparent" }}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "6px 12px",
            border: "none", borderRadius: 6, background: "#3b82f6", color: "#fff",
            fontSize: 12, fontWeight: 500, cursor: "pointer",
          }}
        >
          <Plus size={14} /> 新建工作流
        </button>
      </div>

      {/* 恢复面板 */}
      {showRecoverPanel && (
        <div style={{
          marginBottom: 16, padding: 12, border: "1px solid #f59e0b", borderRadius: 8,
          background: "#fffbeb", fontSize: 12,
        }}>
          <div style={{ fontWeight: 600, marginBottom: 8, color: "#92400e" }}>
            可恢复的工作流（{recoverableIds.length} 个）
          </div>
          {recoverableIds.length === 0 ? (
            <p style={{ color: "#9ca3af" }}>没有找到可恢复的工作流。</p>
          ) : (
            <>
              {recoverableIds.map((id) => (
                <label key={id} style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, cursor: "pointer" }}>
                  <input
                    type="checkbox"
                    checked={selectedRecoverIds.has(id)}
                    onChange={(e) => {
                      setSelectedRecoverIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(id);
                        else next.delete(id);
                        return next;
                      });
                    }}
                  />
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{id}</span>
                </label>
              ))}
              <button
                type="button"
                onClick={handleRecoverApply}
                disabled={recovering || selectedRecoverIds.size === 0}
                style={{
                  marginTop: 8, padding: "4px 10px", border: "none", borderRadius: 4,
                  background: "#f59e0b", color: "#fff", fontSize: 11, cursor: recovering ? "not-allowed" : "pointer",
                }}
              >
                {recovering ? "恢复中..." : `恢复选中 (${selectedRecoverIds.size})`}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowRecoverPanel(false)}
            style={{ marginTop: 4, background: "none", border: "none", color: "#92400e", cursor: "pointer", fontSize: 11 }}
          >
            关闭
          </button>
        </div>
      )}

      {/* 新建对话框 */}
      {showCreateDialog && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
          background: "rgba(0,0,0,0.3)", display: "flex", alignItems: "center",
          justifyContent: "center", zIndex: 1000,
        }}>
          <div style={{
            background: "#fff", borderRadius: 8, padding: 24, width: 380,
            boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
          }}>
            <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>新建工作流</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>名称 *</label>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-workflow"
                autoFocus
                style={{
                  width: "100%", padding: "6px 10px", border: "1px solid #e5e7eb",
                  borderRadius: 6, fontSize: 13, outline: "none",
                }}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>描述</label>
              <textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="工作流描述（可选）"
                rows={2}
                style={{
                  width: "100%", padding: "6px 10px", border: "1px solid #e5e7eb",
                  borderRadius: 6, fontSize: 13, outline: "none", resize: "vertical",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => { setShowCreateDialog(false); setCreateName(""); setCreateDesc(""); }}
                style={{
                  padding: "6px 12px", border: "1px solid #e5e7eb", borderRadius: 6,
                  background: "#fff", fontSize: 12, cursor: "pointer",
                }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !createName.trim()}
                style={{
                  padding: "6px 12px", border: "none", borderRadius: 6,
                  background: "#3b82f6", color: "#fff", fontSize: 12,
                  cursor: creating ? "not-allowed" : "pointer",
                }}
              >
                {creating ? "创建中..." : "创建并编辑"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 13 }}>
          <Loader size={20} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
          <p style={{ marginTop: 8 }}>加载中...</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>加载失败: {error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>
            {searchQuery ? "没有匹配的工作流" : "暂无工作流"}
          </p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>
            点击「新建工作流」创建你的第一个工作流
          </p>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {/* 表头 */}
          <div
            style={{
              display: "grid", gridTemplateColumns: "2fr 100px 120px 80px",
              gap: 8, padding: "8px 16px", background: "#f9fafb",
              borderBottom: "1px solid #e5e7eb", fontSize: 11, fontWeight: 600,
              color: "#6b7280", textTransform: "uppercase", letterSpacing: 0.5,
            }}
          >
            <span>名称</span>
            <span>最新版本</span>
            <span>最后修改</span>
            <span></span>
          </div>

          {/* 数据行 */}
          {filtered.map((wf) => (
            <div
              key={wf.id}
              onClick={() => onEditWorkflow(wf.id)}
              style={{
                display: "grid", gridTemplateColumns: "2fr 100px 120px 80px",
                gap: 8, padding: "10px 16px", borderBottom: "1px solid #f3f4f6",
                cursor: "pointer", transition: "background 0.1s", fontSize: 12, alignItems: "center",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "")}
            >
              <div>
                <div style={{ fontWeight: 500, color: "#111827" }}>{wf.name}</div>
                {wf.description && (
                  <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{wf.description}</div>
                )}
              </div>
              <div style={{ color: wf.latestVersion ? "#22c55e" : "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
                {wf.latestVersion ? `v${wf.latestVersion}` : "未发布"}
              </div>
              <div style={{ color: "#6b7280" }}>{relativeTime(wf.updatedAt)}</div>
              <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  title="版本历史"
                  onClick={() => onViewVersions(wf.id)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, border: "none", background: "none",
                    borderRadius: 4, color: "#6b7280", cursor: "pointer",
                  }}
                >
                  <ChevronRight size={13} />
                </button>
                <button
                  type="button"
                  title="删除"
                  onClick={() => handleDelete(wf)}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 26, height: 26, border: "none", background: "none",
                    borderRadius: 4, color: "#ef4444", cursor: "pointer",
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {workflows.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: "#9ca3af", textAlign: "center" }}>
          共 {workflows.length} 个工作流
        </div>
      )}
    </div>
  );
}
```

### Step 2: 验证构建

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: 构建成功。

### Step 3: Commit

```bash
git add web/src/pages/workflow/WorkflowList.tsx
git commit -m "feat: WorkflowList page — table + create/delete/recover"
```

---

## Task 7: 前端路由改造

**Files:**
- Modify: `web/src/pages/WorkflowPage.tsx`

### Step 1: 重写 WorkflowPage 路由

替换 `web/src/pages/WorkflowPage.tsx` 全部内容：

```tsx
import { useCallback, useEffect, useState } from "react";
import { WorkflowList } from "./workflow/WorkflowList";
import { WorkflowEditor } from "./workflow/WorkflowEditor";
import { WorkflowVersions } from "./workflow/WorkflowVersions";
import { WorkflowRuns } from "./workflow/WorkflowRuns";
import { WorkflowRunDetail } from "./workflow/WorkflowRunDetail";
import { Pencil, History, ArrowLeft } from "lucide-react";

type WfView = "list" | "edit" | "versions" | "runs" | "detail";

interface WfRoute {
  view: WfView;
  workflowId?: string;
  runId?: string;
}

function parseWfPath(): WfRoute {
  const path = window.location.pathname.replace(/^\/ctrl\/?/, "");
  const parts = path.split("/");

  if (parts[0] !== "workflow") return { view: "list" };

  // /ctrl/workflow/runs/:runId
  if (parts[1] === "runs" && parts[2]) {
    return { view: "detail", runId: parts[2] };
  }
  // /ctrl/workflow/runs
  if (parts[1] === "runs") {
    return { view: "runs" };
  }
  // /ctrl/workflow/:workflowId/versions
  if (parts[1] && parts[2] === "versions") {
    return { view: "versions", workflowId: parts[1] };
  }
  // /ctrl/workflow/:workflowId/edit
  if (parts[1] && parts[2] === "edit") {
    return { view: "edit", workflowId: parts[1] };
  }
  // /ctrl/workflow（默认列表页）
  return { view: "list" };
}

const TAB_ITEMS = [
  { id: "list" as const, label: "工作流", icon: Pencil },
  { id: "runs" as const, label: "运行记录", icon: History },
];

export function WorkflowPage() {
  const [route, setRoute] = useState(parseWfPath);

  useEffect(() => {
    const sync = () => setRoute(parseWfPath());
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  const navigateTo = useCallback((view: WfView, workflowId?: string, runId?: string) => {
    let path = "/ctrl/workflow";
    if (view === "runs") path = "/ctrl/workflow/runs";
    if (view === "detail" && runId) path = `/ctrl/workflow/runs/${runId}`;
    if (view === "edit" && workflowId) path = `/ctrl/workflow/${workflowId}/edit`;
    if (view === "versions" && workflowId) path = `/ctrl/workflow/${workflowId}/versions`;
    window.history.pushState(null, "", path);
    setRoute({ view, workflowId, runId });
  }, []);

  // 全屏独立视图（无 Tab 框架）
  if (route.view === "detail" && route.runId) {
    return <WorkflowRunDetail runId={route.runId} onBack={() => navigateTo("runs")} />;
  }

  if (route.view === "edit" && route.workflowId) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "0 16px",
          borderBottom: "1px solid #e5e7eb", background: "#fff", minHeight: 40, flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => navigateTo("list")}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
              border: "none", background: "none", fontSize: 12, color: "#6b7280", cursor: "pointer",
            }}
          >
            <ArrowLeft size={14} /> 返回列表
          </button>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <WorkflowEditor
            workflowId={route.workflowId}
            onViewRuns={() => navigateTo("runs")}
            onRunStarted={(runId) => navigateTo("detail", undefined, runId)}
          />
        </div>
      </div>
    );
  }

  if (route.view === "versions" && route.workflowId) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: 8, padding: "0 16px",
          borderBottom: "1px solid #e5e7eb", background: "#fff", minHeight: 40, flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => navigateTo("list")}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
              border: "none", background: "none", fontSize: 12, color: "#6b7280", cursor: "pointer",
            }}
          >
            <ArrowLeft size={14} /> 返回列表
          </button>
          <button
            type="button"
            onClick={() => navigateTo("edit", route.workflowId)}
            style={{
              display: "flex", alignItems: "center", gap: 4, padding: "4px 8px",
              border: "none", background: "none", fontSize: 12, color: "#6b7280", cursor: "pointer",
            }}
          >
            <Pencil size={14} /> 编辑器
          </button>
        </div>
        <div style={{ flex: 1, overflow: "hidden" }}>
          <WorkflowVersions
            workflowId={route.workflowId}
            onEditWorkflow={(id) => navigateTo("edit", id)}
          />
        </div>
      </div>
    );
  }

  // Tab 框架：工作流列表 / 运行记录
  const activeTab = route.view === "detail" ? "runs" : route.view === "list" ? "list" : "runs";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div
        style={{
          display: "flex", alignItems: "center", gap: 0, padding: "0 20px",
          borderBottom: "1px solid #e5e7eb", background: "#fff", minHeight: 40, flexShrink: 0,
        }}
      >
        {TAB_ITEMS.map((tab) => {
          const isActive = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => navigateTo(tab.id)}
              style={{
                display: "flex", alignItems: "center", gap: 5, padding: "8px 14px",
                border: "none", background: "none", fontSize: 12,
                fontWeight: isActive ? 600 : 400, color: isActive ? "#111827" : "#6b7280",
                borderBottom: isActive ? "2px solid #3b82f6" : "2px solid transparent",
                cursor: "pointer", transition: "color 0.15s, border-color 0.15s",
              }}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, overflow: "hidden" }}>
        {activeTab === "list" ? (
          <WorkflowList
            onEditWorkflow={(id) => navigateTo("edit", id)}
            onViewVersions={(id) => navigateTo("versions", id)}
          />
        ) : (
          <WorkflowRuns onSelectRun={(id) => navigateTo("detail", undefined, id)} />
        )}
      </div>
    </div>
  );
}
```

### Step 2: 验证构建

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: 构建成功（WorkflowVersions 组件尚未创建，需要先创建占位文件）。

### Step 3: 创建 WorkflowVersions 占位

创建 `web/src/pages/workflow/WorkflowVersions.tsx` 最小占位（Task 9 会完善）：

```tsx
interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowVersions({ workflowId }: WorkflowVersionsProps) {
  return (
    <div style={{ padding: 24 }}>
      <p style={{ color: "#9ca3af", fontSize: 13 }}>版本历史（开发中）— workflowId: {workflowId}</p>
    </div>
  );
}
```

### Step 4: 验证构建 + Commit

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
git add web/src/pages/WorkflowPage.tsx web/src/pages/workflow/WorkflowList.tsx web/src/pages/workflow/WorkflowVersions.tsx
git commit -m "feat: workflow routing — list/edit/versions/runs sub-routes"
```

---

## Task 8: 编辑器集成 — 保存/发布/加载

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

### Step 1: 修改 WorkflowEditor props 和状态

在 `WorkflowEditor.tsx` 中：

1. 修改 `WorkflowEditorProps` 接口，添加 `workflowId` prop：

```typescript
interface WorkflowEditorProps {
  workflowId: string;
  onViewRuns?: () => void;
  onRunStarted?: (runId: string) => void;
}
```

2. 在 `WorkflowEditorInner` 组件顶部添加新状态：

```typescript
const [savedWorkflowId] = useState(workflowId);
const [lastSavedYaml, setLastSavedYaml] = useState("");
const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
const [publishing, setPublishing] = useState(false);
```

3. 添加 import：

```typescript
import { workflowDefApi } from "../../api/workflow-defs";
import { Save, Upload as PublishIcon } from "lucide-react"; // PublishIcon = 避免和 Upload 重名
```

注意：`Upload` 已经被 import 了，改名为 `PublishIcon` 不行（lucide 不支持 alias）。直接用新 icon：改 import 为增加 `Rocket`：

```typescript
import { ..., Rocket, Save } from "lucide-react";
```

### Step 2: 添加加载工作流草稿的 effect

在 `WorkflowEditorInner` 中添加初始加载 effect（在现有 state 声明之后）：

```typescript
// 加载已保存的工作流草稿
useEffect(() => {
  if (!savedWorkflowId) return;
  (async () => {
    try {
      const wf = await workflowDefApi.get(savedWorkflowId);
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(newMeta);
        setLastSavedYaml(wf.draftYaml);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      }
      // 同步 meta 中的 name/description
      if (wf.name) updateMeta({ name: wf.name });
      if (wf.description) updateMeta({ description: wf.description });
    } catch (err) {
      console.error("加载工作流失败:", err);
    }
  })();
}, [savedWorkflowId]); // 仅在 workflowId 变化时触发
```

注意：`setNodes`, `setEdges`, `setMeta`, `fitView`, `updateMeta` 不应放在依赖数组中（避免循环）。使用 `// eslint-disable-next-line` 或直接只用 `savedWorkflowId`。

### Step 3: 添加保存草稿方法

```typescript
const handleSaveDraft = useCallback(async () => {
  const y = syncYaml();
  setSaveStatus("saving");
  try {
    await workflowDefApi.save(savedWorkflowId, y);
    setLastSavedYaml(y);
    setSaveStatus("saved");
    setTimeout(() => setSaveStatus("idle"), 2000);
  } catch (err) {
    console.error(err);
    alert("保存失败: " + (err as Error).message);
    setSaveStatus("idle");
  }
}, [syncYaml, savedWorkflowId]);
```

### Step 4: 添加发布方法

```typescript
const handlePublish = useCallback(async () => {
  // 先保存草稿
  const y = syncYaml();
  setSaveStatus("saving");
  try {
    await workflowDefApi.save(savedWorkflowId, y);
    setLastSavedYaml(y);
    setSaveStatus("idle");
  } catch (err) {
    console.error(err);
    alert("保存失败: " + (err as Error).message);
    setSaveStatus("idle");
    return;
  }

  // 发布
  setPublishing(true);
  try {
    const result = await workflowDefApi.publish(savedWorkflowId);
    alert(`已发布为 v${result.version}`);
  } catch (err) {
    console.error(err);
    alert("发布失败: " + (err as Error).message);
  } finally {
    setPublishing(false);
  }
}, [syncYaml, savedWorkflowId]);
```

### Step 5: 修改 handleRun — 自动保存再执行

替换现有的 `handleRun`：

```typescript
const handleRun = useCallback(async () => {
  const y = syncYaml();
  setRunning(true);
  setDryRunResult(null);

  // 自动保存草稿
  try {
    await workflowDefApi.save(savedWorkflowId, y);
  } catch (err) {
    console.error("自动保存失败:", err);
    // 继续执行，不因保存失败阻断
  }

  try {
    const result = await workflowEngineApi.run(y);
    if (onRunStarted) {
      onRunStarted(result.runId);
    } else {
      alert(`工作流已提交，runId: ${result.runId}`);
    }
  } catch (err) {
    console.error(err);
    alert("执行失败: " + (err as Error).message);
  } finally {
    setRunning(false);
  }
}, [syncYaml, savedWorkflowId, onRunStarted]);
```

### Step 6: 添加 Cmd+S 快捷键 + 工具栏按钮

在 `WorkflowEditorInner` 的 return 中，工具栏 Panel 里，在 `[校验] [执行]` 之前添加保存和发布按钮：

```tsx
<button
  type="button"
  className="wf-toolbar-btn"
  onClick={handleSaveDraft}
  disabled={saveStatus === "saving"}
  title="保存草稿 (Cmd+S)"
>
  <Save size={15} />
</button>
<button
  type="button"
  className="wf-toolbar-btn"
  onClick={handlePublish}
  disabled={publishing}
  title="发布版本"
  style={{ color: "#22c55e" }}
>
  <Rocket size={15} />
</button>
```

添加 Cmd+S 快捷键 effect：

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "s") {
      e.preventDefault();
      handleSaveDraft();
    }
  };
  window.addEventListener("keydown", handler);
  return () => window.removeEventListener("keydown", handler);
}, [handleSaveDraft]);
```

在工具栏下方添加保存状态指示器（在 dryRunResult 提示之前）：

```tsx
{saveStatus === "saving" && (
  <div style={{
    position: "absolute", top: 52, left: "50%", transform: "translateX(-50%)",
    background: "#eff6ff", border: "1px solid #93c5fd", borderRadius: 8,
    padding: "6px 12px", fontSize: 11, color: "#1d4ed8", zIndex: 10,
  }}>
    保存中...
  </div>
)}
{saveStatus === "saved" && (
  <div style={{
    position: "absolute", top: 52, left: "50%", transform: "translateX(-50%)",
    background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8,
    padding: "6px 12px", fontSize: 11, color: "#166534", zIndex: 10,
  }}>
    已保存
  </div>
)}
```

### Step 7: 验证构建 + Commit

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat: editor save/publish integration — Cmd+S + auto-save before run"
```

---

## Task 9: 版本历史页

**Files:**
- Modify: `web/src/pages/workflow/WorkflowVersions.tsx`（替换占位内容）

### Step 1: 实现 WorkflowVersions 组件

替换 `web/src/pages/workflow/WorkflowVersions.tsx`：

```tsx
import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Inbox,
  Loader,
  RefreshCw,
  RotateCcw,
  Star,
} from "lucide-react";
import { workflowDefApi, type WorkflowVersionItem, type WorkflowDefItem } from "../../api/workflow-defs";

interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowVersions({ workflowId }: WorkflowVersionsProps) {
  const [wf, setWf] = useState<WorkflowDefItem | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wfData, versionList] = await Promise.all([
        workflowDefApi.get(workflowId),
        workflowDefApi.getVersions(workflowId),
      ]);
      setWf(wfData);
      setVersions(Array.isArray(versionList) ? versionList : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!confirm(`确定将 latest 指向 v${version}？`)) return;
      try {
        await workflowDefApi.setLatest(workflowId, version);
        loadData();
      } catch (err) {
        console.error(err);
        alert("操作失败: " + (err as Error).message);
      }
    },
    [workflowId, loadData],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!confirm(`将 v${version} 的内容恢复到草稿？当前草稿将被覆盖。`)) return;
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        alert("已恢复到草稿");
      } catch (err) {
        console.error(err);
        alert("恢复失败: " + (err as Error).message);
      }
    },
    [workflowId],
  );

  const handleViewYaml = useCallback(async (version: number) => {
    if (viewingVersion === version) {
      setViewingVersion(null);
      setViewingYaml(null);
      return;
    }
    try {
      const result = await workflowDefApi.getVersion(workflowId, version);
      setViewingVersion(version);
      setViewingYaml(result.yaml);
    } catch (err) {
      console.error(err);
      alert("加载失败: " + (err as Error).message);
    }
  }, [workflowId, viewingVersion]);

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(iso).toLocaleDateString("zh-CN");
  }

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 标题 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>
          版本历史{wf ? ` — ${wf.name}` : ""}
        </h1>
        <button
          type="button"
          onClick={loadData}
          style={{
            display: "flex", alignItems: "center", gap: 5, padding: "5px 10px",
            border: "1px solid #e5e7eb", borderRadius: 6, background: "#fff",
            fontSize: 12, color: "#374151", cursor: "pointer",
          }}
        >
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {/* 当前状态 */}
      {wf && (
        <div style={{
          padding: "10px 16px", background: "#f9fafb", borderRadius: 8,
          border: "1px solid #e5e7eb", marginBottom: 16, fontSize: 12, color: "#6b7280",
          display: "flex", gap: 16,
        }}>
          <span>latest: <strong style={{ color: wf.latestVersion ? "#22c55e" : "#9ca3af" }}>
            {wf.latestVersion ? `v${wf.latestVersion}` : "未设置"}
          </strong></span>
          <span>发布版本数: <strong>{versions.length}</strong></span>
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 13 }}>
          <Loader size={20} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
          <p style={{ marginTop: 8 }}>加载中...</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>加载失败: {error}</p>
        </div>
      ) : versions.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>暂无发布版本</p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>在编辑器中点击「发布」创建第一个版本</p>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;

            return (
              <div key={v.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <div
                  style={{
                    display: "flex", alignItems: "center", gap: 12, padding: "12px 16px",
                    fontSize: 12, cursor: "pointer",
                  }}
                  onClick={() => handleViewYaml(v.version)}
                >
                  {/* 版本号 */}
                  <div style={{
                    fontFamily: "ui-monospace, monospace", fontWeight: 600, color: "#111827",
                    minWidth: 40,
                  }}>
                    v{v.version}
                  </div>

                  {/* latest 标记 */}
                  {isLatest && (
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 3,
                      fontSize: 10, fontWeight: 500, color: "#22c55e", background: "#f0fdf4",
                      padding: "1px 6px", borderRadius: 99,
                    }}>
                      <Star size={10} /> latest
                    </span>
                  )}

                  {/* 时间 + 操作人 */}
                  <span style={{ color: "#9ca3af", fontSize: 11 }}>
                    <Clock size={10} style={{ marginRight: 3, verticalAlign: -1 }} />
                    {relativeTime(v.createdAt)}
                  </span>

                  {/* 操作 */}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {!isLatest && (
                      <button
                        type="button"
                        title="设为 latest"
                        onClick={() => handleSetLatest(v.version)}
                        style={{
                          display: "flex", alignItems: "center", gap: 3, padding: "3px 8px",
                          border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff",
                          fontSize: 10, color: "#6b7280", cursor: "pointer",
                        }}
                      >
                        <Star size={10} /> 设为 latest
                      </button>
                    )}
                    <button
                      type="button"
                      title="恢复到草稿"
                      onClick={() => handleRestoreToDraft(v.version)}
                      style={{
                        display: "flex", alignItems: "center", gap: 3, padding: "3px 8px",
                        border: "1px solid #e5e7eb", borderRadius: 4, background: "#fff",
                        fontSize: 10, color: "#6b7280", cursor: "pointer",
                      }}
                    >
                      <RotateCcw size={10} /> 恢复到草稿
                    </button>
                  </div>
                </div>

                {/* YAML 展开区域 */}
                {isViewing && viewingYaml !== null && (
                  <div style={{ padding: "0 16px 12px" }}>
                    <pre style={{
                      background: "#f9fafb", border: "1px solid #e5e7eb", borderRadius: 6,
                      padding: 10, fontSize: 11, fontFamily: "ui-monospace, monospace",
                      color: "#374151", maxHeight: 300, overflow: "auto", margin: 0,
                      whiteSpace: "pre-wrap",
                    }}>
                      {viewingYaml}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
```

### Step 2: 验证构建 + Commit

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
git add web/src/pages/workflow/WorkflowVersions.tsx
git commit -m "feat: WorkflowVersions page — version list + restore + set latest"
```

---

## Task 10: 集成验证 + 清理

**Files:**
- Delete: `web/src/pages/workflow/workflow-api.ts`（旧版未使用）
- Delete: `web/src/pages/workflow/workflow-utils.ts`（旧版未使用）

### Step 1: 删除旧文件

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && rm web/src/pages/workflow/workflow-api.ts web/src/pages/workflow/workflow-utils.ts
```

### Step 2: 完整构建验证

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web
```

Expected: 构建成功，无错误。

### Step 3: 启动后端验证

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev
```

验证：
1. 访问 `/ctrl/workflow` → 显示工作流列表页（空列表 + 新建按钮）
2. 点击「新建工作流」→ 弹出命名对话框 → 创建后跳转编辑器
3. 编辑器中画节点 → Cmd+S 保存 → 工具栏显示"已保存"
4. 点击发布按钮 → 确认弹窗 → 发布成功
5. 返回列表 → 看到工作流 + 版本号
6. 点击版本历史 → 看到 v1 + latest 标记
7. 点击运行记录 Tab → 显示运行记录列表（复用已有功能）

### Step 4: Final Commit

```bash
git add -A
git commit -m "chore: cleanup old workflow-api files + integration verification"
```
