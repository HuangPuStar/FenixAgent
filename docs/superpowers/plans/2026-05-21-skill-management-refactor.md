# Skill Management Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Simplify skill management to global-only skills + agent-skill association via join table, with sync at instance launch.

**Architecture:** Remove workspace/agent-specific skills and the enabled/disabled toggle. Introduce a new `agent_config_skill` join table for many-to-many agent↔skill associations. The SkillsPage becomes a pure global skill CRUD page. The AgentsPage FormDialog gains a "Skills" tab with checkbox selection. At launch time, `getAgentFullConfig()` queries the join table and returns associated skills.

**Tech Stack:** Drizzle ORM, PostgreSQL, Elysia, React, TanStack Router, i18next

---

## File Structure

### New Files
- `src/services/config/agent-config-skill.ts` — join table CRUD for agent↔skill associations

### Modified Files
- `src/db/schema.ts` — add `agentConfigSkill` table, remove columns from `skill` table
- `src/services/config/skill.ts` — remove workspace/enable/disable functions
- `src/services/skill.ts` — remove workspace functions, `listSkillSources`, enable/disable
- `src/services/skill-fs.ts` — remove `enabled` param from `listSkillsFromDir`
- `src/services/config/aggregate.ts` — query join table instead of `skill.agentConfigId`
- `src/services/launch-spec-builder.ts` — remove `enabled` filter
- `src/services/config/agent-config.ts` — add `skillIds` to settable fields
- `src/services/config-pg.ts` — re-export new module
- `src/routes/web/config/skills.ts` — remove workspace_list/enable/disable actions
- `src/routes/web/config/agents.ts` — sync skill associations on create/set
- `web/src/pages/SkillsPage.tsx` — simplify to flat global skill list
- `web/src/pages/AgentsPage.tsx` — add skills tab with checkbox list
- `web/src/types/config.ts` — update SkillInfo, add SkillInfoMinimal
- `web/src/i18n/locales/en/skills.json` — remove workspace/enable/disable keys
- `web/src/i18n/locales/zh/skills.json` — same
- `web/src/i18n/locales/en/agents.json` — add skills tab keys
- `web/src/i18n/locales/zh/agents.json` — add skills tab keys

### Test Files
- `src/__tests__/skill-service.test.ts` — remove workspace/enable/disable tests
- `src/__tests__/launch-spec-skills.test.ts` — update for new association model
- `src/__tests__/agent-config-skill.test.ts` — new tests for join table CRUD
- Other skill test files — remove workspace/enable/disable related tests

---

### Task 1: Add `agentConfigSkill` table to schema

**Files:**
- Modify: `src/db/schema.ts:519-544`

- [ ] **Step 1: Add the `agentConfigSkill` join table after the `skill` table definition**

Insert after line 544 (after the `skill` table closing `);`):

```typescript
// Agent↔Skill 多对多关联
export const agentConfigSkill = pgTable(
  "agent_config_skill",
  {
    agentConfigId: uuid("agent_config_id")
      .notNull()
      .references(() => agentConfig.id, { onDelete: "cascade" }),
    skillId: uuid("skill_id")
      .notNull()
      .references(() => skill.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    pk: uniqueIndex("idx_agent_config_skill_pk").on(table.agentConfigId, table.skillId),
  }),
);
```

- [ ] **Step 2: Remove `environmentId`, `agentConfigId`, `enabled` columns from `skill` table**

In `src/db/schema.ts`, replace the `skill` table definition (lines 520-544) with:

```typescript
// 技能元数据（全局技能库，内容保留在文件系统）
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
    contentPath: text("content_path"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_skill_org_name").on(table.organizationId, table.name),
  }),
);
```

- [ ] **Step 3: Run `bun run db:push` to sync schema changes**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bunx drizzle-kit push`

Expected: Schema pushed, old columns dropped, new table created. May need to confirm data loss for dropped columns.

- [ ] **Step 4: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: add agent_config_skill join table, simplify skill table"
```

---

### Task 2: Create `agent-config-skill.ts` service for join table CRUD

**Files:**
- Create: `src/services/config/agent-config-skill.ts`
- Test: `src/__tests__/agent-config-skill.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/agent-config-skill.test.ts`:

```typescript
import { afterEach, describe, expect, mock, test } from "bun:test";

// mock db before import
const mockSelect = mock(() => ({
  from: mock(() => ({
    where: mock(() => Promise.resolve([])),
  })),
}));
const mockInsert = mock(() => ({
  values: mock(() => ({
    onConflictDoNothing: mock(() => Promise.resolve(undefined)),
  })),
}));
const mockDelete = mock(() => ({
  where: mock(() => Promise.resolve(undefined)),
}));

mock.module("../../db", () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    delete: mockDelete,
  },
}));

mock.module("../../db/schema", () => ({
  agentConfigSkill: {
    agentConfigId: "agent_config_id",
    skillId: "skill_id",
    createdAt: "created_at",
  },
}));

const { listAgentSkillIds, syncAgentSkills } = await import("../services/config/agent-config-skill");

// listAgentSkillIds 应该查询关联表返回 skillId 数组
describe("agent-config-skill", () => {
  afterEach(() => {
    mockSelect.mockClear();
    mockInsert.mockClear();
    mockDelete.mockClear();
  });

  // 测试 listAgentSkillIds 查询关联
  test("listAgentSkillIds returns array of skill IDs", async () => {
    const result = await listAgentSkillIds("agent-uuid-1");
    expect(Array.isArray(result)).toBe(true);
  });

  // 测试 syncAgentSkills 清空时调用 delete
  test("syncAgentSkills with empty array clears all associations", async () => {
    await syncAgentSkills("agent-uuid-1", []);
    expect(mockDelete).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/agent-config-skill.test.ts`
Expected: FAIL — module not found or function not exported

- [ ] **Step 3: Write the implementation**

Create `src/services/config/agent-config-skill.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfigSkill } from "../../db/schema";

/** 查询 Agent 关联的所有 skillId */
export async function listAgentSkillIds(agentConfigId: string): Promise<string[]> {
  const rows = await db
    .select({ skillId: agentConfigSkill.skillId })
    .from(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfigId));
  return rows.map((r) => r.skillId);
}

/** 全量覆盖 Agent 的技能关联（先删后插） */
export async function syncAgentSkills(agentConfigId: string, skillIds: string[]): Promise<void> {
  await db
    .delete(agentConfigSkill)
    .where(eq(agentConfigSkill.agentConfigId, agentConfigId));

  if (skillIds.length === 0) return;

  await db.insert(agentConfigSkill).values(
    skillIds.map((skillId) => ({
      agentConfigId,
      skillId,
    })),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/agent-config-skill.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/config/agent-config-skill.ts src/__tests__/agent-config-skill.test.ts
git commit -m "feat: add agent-config-skill service for join table CRUD"
```

---

### Task 3: Re-export new module from config-pg.ts

**Files:**
- Modify: `src/services/config-pg.ts`

- [ ] **Step 1: Add re-export for agent-config-skill**

Add to the exports in `src/services/config-pg.ts`:

```typescript
export { listAgentSkillIds, syncAgentSkills } from "./config/agent-config-skill";
```

- [ ] **Step 2: Verify import works**

Run: `bun -e "import { listAgentSkillIds } from './src/services/config-pg'; console.log('OK')"` from project root.
Expected: Prints "OK"

- [ ] **Step 3: Commit**

```bash
git add src/services/config-pg.ts
git commit -m "feat: re-export agent-config-skill from config-pg barrel"
```

---

### Task 4: Clean up `src/services/config/skill.ts`

**Files:**
- Modify: `src/services/config/skill.ts`
- Test: `src/__tests__/skill-service.test.ts`

- [ ] **Step 1: Remove `listWorkspaceSkills`, `enableSkill`, `disableSkill` functions**

In `src/services/config/skill.ts`:
- Delete the `listWorkspaceSkills` function (lines ~30-35)
- Delete the `enableSkill` function (lines ~102-109)
- Delete the `disableSkill` function (lines ~111-118)
- Simplify `listSkills` — remove `agentConfigId` parameter, only query global skills:

```typescript
export async function listSkills(ctx: AuthContext) {
  return db.select().from(skill).where(eq(skill.organizationId, ctx.organizationId));
}
```

- Simplify `getSkill` — remove `environmentId` parameter:

```typescript
export async function getSkill(ctx: AuthContext, name: string) {
  const rows = await db
    .select()
    .from(skill)
    .where(and(eq(skill.organizationId, ctx.organizationId), eq(skill.name, name)))
    .limit(1);
  return rows[0] ?? null;
}
```

- Simplify `upsertSkill` — remove `environmentId`, `agentConfigId`, `enabled` from data parameter, update WHERE clause:

```typescript
export async function upsertSkill(
  ctx: AuthContext,
  name: string,
  data: {
    description?: string;
    contentPath?: string;
    metadata?: Record<string, unknown>;
  },
) {
```

The upsert WHERE should only match on `organizationId` + `name`.

- [ ] **Step 2: Run existing tests to see what breaks**

Run: `bun test src/__tests__/skill-service.test.ts`
Expected: Some failures due to removed functions and changed signatures

- [ ] **Step 3: Update tests**

In `src/__tests__/skill-service.test.ts`:
- Remove tests for `listWorkspaceSkills`, `enableSkill`, `disableSkill`
- Update `listSkills` tests to remove `agentConfigId` param
- Update `upsertSkill` tests to remove `environmentId`, `agentConfigId`, `enabled` params

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/skill-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/config/skill.ts src/__tests__/skill-service.test.ts
git commit -m "refactor: clean up config/skill.ts — remove workspace/enable/disable"
```

---

### Task 5: Clean up `src/services/skill.ts` (orchestration layer)

**Files:**
- Modify: `src/services/skill.ts`
- Modify: `src/services/skill-fs.ts`

- [ ] **Step 1: Remove workspace functions from `src/services/skill.ts`**

Delete these functions:
- `getWorkspaceSkillDir` (line ~416-418)
- `listWorkspaceSkills` (line ~420-423)
- `listSkillSources` (line ~425-490)
- `getWorkspaceSkill` (line ~492-506)
- `setWorkspaceSkill` (line ~508-518)
- `deleteWorkspaceSkill` (line ~520-525)
- `importWorkspaceSkillDirectories` (line ~527-565)
- `enableSkill` (line ~241-249)
- `disableSkill` (line ~251-254)

- [ ] **Step 2: Remove `enabled` parameter from `listSkillsFromDir` in `src/services/skill-fs.ts`**

Find the `listSkillsFromDir` function (line ~267-279) and remove the `enabled` parameter and its filtering logic. The function should return all skills from the directory without filtering by enabled status.

- [ ] **Step 3: Verify no other files import the removed functions**

Run: `grep -rn "listSkillSources\|enableSkill\|disableSkill\|listWorkspaceSkills\|getWorkspaceSkill\|setWorkspaceSkill\|deleteWorkspaceSkill\|importWorkspaceSkillDirectories\|getWorkspaceSkillDir" src/ --include="*.ts" | grep -v "__tests__" | grep -v "node_modules"`

Expected: No results (all references cleaned up)

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/`
Expected: All pass (some test files for removed features may need deletion — see Task 10)

- [ ] **Step 5: Commit**

```bash
git add src/services/skill.ts src/services/skill-fs.ts
git commit -m "refactor: remove workspace/enable/disable from skill service layer"
```

---

### Task 6: Update `aggregate.ts` to query join table

**Files:**
- Modify: `src/services/config/aggregate.ts`
- Test: `src/__tests__/launch-spec-skills.test.ts`

- [ ] **Step 1: Rewrite `getAgentFullConfig` to use join table**

Replace the entire content of `src/services/config/aggregate.ts`:

```typescript
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agentConfig, agentConfigSkill, mcpServer, provider, skill } from "../../db/schema";
import type { AuthContext } from "../../plugins/auth";

export interface AgentFullConfig {
  agentConfig: typeof agentConfig.$inferSelect | null;
  providers: (typeof provider.$inferSelect)[];
  skills: (typeof skill.$inferSelect)[];
  mcpServers: (typeof mcpServer.$inferSelect)[];
}

/** 获取组织全局技能 */
function listGlobalSkills(orgId: string) {
  return db.select().from(skill).where(eq(skill.organizationId, orgId));
}

export async function getAgentFullConfig(ctx: AuthContext, agentConfigId: string | null): Promise<AgentFullConfig> {
  if (!agentConfigId) {
    const [providers, mcpServers, skills] = await Promise.all([
      db.select().from(provider).where(eq(provider.organizationId, ctx.organizationId)),
      db
        .select()
        .from(mcpServer)
        .where(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.enabled, true)),
      listGlobalSkills(ctx.organizationId),
    ]);
    return { agentConfig: null, providers, skills, mcpServers };
  }

  // 并行拉取 providers、mcpServers、agentConfig
  const [providers, mcpServers, acRows, skillBindings] = await Promise.all([
    db.select().from(provider).where(eq(provider.organizationId, ctx.organizationId)),
    db
      .select()
      .from(mcpServer)
      .where(eq(mcpServer.organizationId, ctx.organizationId), eq(mcpServer.enabled, true)),
    db
      .select()
      .from(agentConfig)
      .where(eq(agentConfig.id, agentConfigId), eq(agentConfig.organizationId, ctx.organizationId))
      .limit(1),
    db
      .select({ skillId: agentConfigSkill.skillId })
      .from(agentConfigSkill)
      .where(eq(agentConfigSkill.agentConfigId, agentConfigId)),
  ]);

  const [ac] = acRows;

  // 根据 join 结果查询 skill 详情
  let skills: (typeof skill.$inferSelect)[] = [];
  if (ac && skillBindings.length > 0) {
    const skillIds = skillBindings.map((b) => b.skillId);
    skills = await db.select().from(skill).where(
      sql`${skill.id} IN (${sql.join(skillIds.map((id) => sql`${id}`), sql`, `)})`
    );
  }

  return { agentConfig: ac ?? null, providers, skills, mcpServers };
}
```

Note: The `sql` import from `drizzle-orm` needs to be added. For the `IN` query, use Drizzle's `inArray`:

```typescript
import { eq, inArray } from "drizzle-orm";
// ...
skills = await db.select().from(skill).where(inArray(skill.id, skillIds));
```

- [ ] **Step 2: Update launch spec builder to remove `enabled` filter**

In `src/services/launch-spec-builder.ts` lines 144-153, change:

```typescript
const skills = fullConfig.skills
  .filter((s) => s.enabled)
  .flatMap((s) => {
```

to:

```typescript
const skills = fullConfig.skills.flatMap((s) => {
```

Remove the `.filter((s) => s.enabled)` line entirely.

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/launch-spec-skills.test.ts`
Expected: Some failures due to changed structure — update test mocks to match new query pattern

- [ ] **Step 4: Update launch-spec-skills tests**

Update `src/__tests__/launch-spec-skills.test.ts` to:
- Remove `enabled` field from mock skill data
- Remove tests that check enabled/disabled filtering
- Ensure tests cover "skills from join table are included in launch spec"

- [ ] **Step 5: Run tests to verify**

Run: `bun test src/__tests__/launch-spec-skills.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/services/config/aggregate.ts src/services/launch-spec-builder.ts src/__tests__/launch-spec-skills.test.ts
git commit -m "refactor: aggregate queries agent_config_skill join table, remove enabled filter"
```

---

### Task 7: Update skill config route — remove workspace/enable/disable actions

**Files:**
- Modify: `src/routes/web/config/skills.ts`

- [ ] **Step 1: Remove workspace_list, enable, disable handlers and action cases**

In `src/routes/web/config/skills.ts`:
- Delete `handleWorkspaceList` function
- Delete `handleEnable` function
- Delete `handleDisable` function
- Remove `workspace_list`, `enable`, `disable` from the action switch
- Remove `source` and `workspaceId` parameters from `handleGet`, `handleSet`, `handleDelete` — they no longer need workspace context
- Simplify `handleUpload` to remove workspace-related branches
- Remove the `handleList` function's workspace fallback — it should just call `listSkills` from config-pg

The simplified action switch becomes:

```typescript
switch (action) {
  case "list": return await handleList(authCtx);
  case "get": return await handleGet(authCtx, payload, errFn);
  case "set": return await handleSet(authCtx, payload, errFn);
  case "delete": return await handleDelete(authCtx, payload, errFn);
}
```

- [ ] **Step 2: Verify route compiles**

Run: `bun run typecheck`
Expected: No errors in this file (other files may still have errors)

- [ ] **Step 3: Commit**

```bash
git add src/routes/web/config/skills.ts
git commit -m "refactor: remove workspace/enable/disable from skill config route"
```

---

### Task 8: Update agent config route — sync skill associations on create/set

**Files:**
- Modify: `src/routes/web/config/agents.ts`
- Modify: `src/services/config/agent-config.ts`

- [ ] **Step 1: Add `syncAgentSkills` call to `handleSet` in agents route**

In `src/routes/web/config/agents.ts`, modify `handleSet` (around line 128):

After `await configPg.updateAgentConfig(ctx, name, updateData);` and after the knowledge sync block, add:

```typescript
// Sync skill associations
if (data.skillIds !== undefined) {
  const skillIds = Array.isArray(data.skillIds) ? data.skillIds as string[] : [];
  await configPg.syncAgentSkills(updatedAgent.id, skillIds);
}
```

- [ ] **Step 2: Add `syncAgentSkills` call to `handleCreate`**

Similarly in `handleCreate`, after `syncAgentKnowledgeBindingsById`, add:

```typescript
if (data.skillIds !== undefined) {
  const skillIds = Array.isArray(data.skillIds) ? data.skillIds as string[] : [];
  await configPg.syncAgentSkills(createdAgent.id, skillIds);
}
```

- [ ] **Step 3: Return `skillIds` in `handleGet`**

In `handleGet`, after loading the agent, query the skill associations:

```typescript
const skillIds = await configPg.listAgentSkillIds(agent.id);
```

And add `skillIds` to the response object.

- [ ] **Step 4: Return `skillIds` in `handleList`**

In `handleList`, after loading agents, add `skillIds` to each agent:

```typescript
skillIds: (await listAgentSkillIds(a.id)),
```

- [ ] **Step 5: Add import for configPg**

Ensure the import `import * as configPg from "../../../services/config-pg";` already exists (it does).

- [ ] **Step 6: Verify compilation**

Run: `bun run typecheck`
Expected: No errors in this file

- [ ] **Step 7: Commit**

```bash
git add src/routes/web/config/agents.ts
git commit -m "feat: sync skill associations on agent create/set"
```

---

### Task 9: Simplify SkillsPage frontend

**Files:**
- Modify: `web/src/pages/SkillsPage.tsx`
- Modify: `web/src/i18n/locales/en/skills.json`
- Modify: `web/src/i18n/locales/zh/skills.json`
- Modify: `web/src/types/config.ts`
- Test: `web/src/__tests__/config-skills-page.test.ts`

- [ ] **Step 1: Update `web/src/types/config.ts`**

Remove `SkillSourceInfo`, `SkillSourceStatus` types (or simplify). Update `SkillInfo` to remove `enabled` field:

```typescript
export interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

export interface SkillDetail {
  name: string;
  description: string;
  content: string;
  path: string;
  metadata: Record<string, string>;
}
```

- [ ] **Step 2: Rewrite SkillsPage as flat skill list**

Replace `web/src/pages/SkillsPage.tsx` with a simplified version that:
- Uses `action: "list"` to load all global skills (returns flat array, not sources)
- Displays skills in a simple DataTable (name, description columns)
- Has "New Skill" and "Upload Skill" buttons
- Edit/Delete per-row actions
- No expandable rows, no source concept, no enable/disable toggle
- Keeps the existing FormDialog for create/edit (text + upload tabs)
- Keeps upload/import logic

Key structural changes:
- Remove `SkillSubrow` component entirely
- Remove `SourceStatusBadge` component
- Remove `SkillSourceInfo` type usage
- `loadSources` becomes `loadSkills` that calls `{ action: "list" }` and sets a flat `SkillInfo[]` state
- DataTable columns: name, description (with row actions for edit/delete)
- Remove `expandableRow` and `defaultExpandAll` from DataTable
- Remove batch selection (or keep simple batch delete)

The main data loading:

```typescript
const loadSkills = useCallback(async () => {
  setLoading(true);
  try {
    const { data: res, error: resErr } = await client.web.config.skills.post({ action: "list" });
    if (resErr) throw new Error(resErr.message ?? t("toast.loadListFailed"));
    const d = unwrapConfigData(res) ?? res;
    setSkills(Array.isArray(d) ? d : []);
  } catch (e) {
    console.error(t("toast.loadListFailed"), e);
    toast.error(t("toast.loadListFailedWith", { message: e instanceof Error ? e.message : t("toast.saveFailed") }));
  } finally {
    setLoading(false);
  }
}, [t]);
```

- [ ] **Step 3: Update i18n files**

In `web/src/i18n/locales/en/skills.json`, remove these keys:
- `status.online`, `status.offline`, `status.timeout` (keep `status.global` if still used, or remove all)
- `column.source`, `column.status`, `column.skillCount` → replace with `column.name`, `column.description`
- `btn.disable`, `btn.enable` (keep `btn.edit`, `btn.delete`, `btn.createSkill`, `btn.uploadSkill`, `btn.batchDelete`, `btn.reselect`)
- `confirm.deleteWorkspaceDescription`, `confirm.editWorkspaceTitle`, `confirm.editWorkspaceDescription`, `confirm.batchDeleteWorkspaceHint`
- `toast.disabled`, `toast.enabled`, `toast.toggleFailed`

Add new keys:
- `column.name`: "Skill Name"
- `column.description`: "Description"

Apply the same changes to `web/src/i18n/locales/zh/skills.json`.

- [ ] **Step 4: Update frontend tests**

Update `web/src/__tests__/config-skills-page.test.ts` to match simplified structure:
- Remove tests for source-related utility functions
- Update form validation tests if signatures changed

- [ ] **Step 5: Run frontend tests**

Run: `bun test web/src/__tests__/config-skills-page.test.ts`
Expected: PASS

- [ ] **Step 6: Build frontend**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web`
Expected: Successful build

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/SkillsPage.tsx web/src/types/config.ts web/src/i18n/locales/en/skills.json web/src/i18n/locales/zh/skills.json web/src/__tests__/config-skills-page.test.ts
git commit -m "feat: simplify SkillsPage to global skill CRUD only"
```

---

### Task 10: Add Skills tab to AgentsPage FormDialog

**Files:**
- Modify: `web/src/pages/AgentsPage.tsx`
- Modify: `web/src/i18n/locales/en/agents.json`
- Modify: `web/src/i18n/locales/zh/agents.json`

- [ ] **Step 1: Add i18n keys for skills tab**

In `web/src/i18n/locales/en/agents.json`, add to `dialog.tabs`:

```json
{
  "dialog": {
    "tabs": {
      "basic": "Basic Config",
      "knowledge": "Knowledge Base",
      "permission": "Permissions",
      "skills": "Skills"
    }
  },
  "skills": {
    "tabTitle": "Bind Skills",
    "selectedCount": "{{count}} skill(s) selected",
    "noOptions": "No skills available"
  }
}
```

In `web/src/i18n/locales/zh/agents.json`, add matching Chinese translations:

```json
{
  "dialog": {
    "tabs": {
      "basic": "基础配置",
      "knowledge": "知识库",
      "permission": "权限",
      "skills": "技能"
    }
  },
  "skills": {
    "tabTitle": "绑定技能",
    "selectedCount": "已选择 {{count}} 个技能",
    "noOptions": "暂无可用技能"
  }
}
```

- [ ] **Step 2: Add state variables for skill selection**

In `AgentsPage.tsx`, add state after existing form state (around line 164):

```typescript
const [formSkillIds, setFormSkillIds] = useState<string[]>([]);
const [skillOptions, setSkillOptions] = useState<{ id: string; name: string; description: string }[]>([]);
```

Update the tab type:

```typescript
const [activeTab, setActiveTab] = useState<"basic" | "knowledge" | "permission" | "skills">("basic");
```

- [ ] **Step 3: Add skill options loading function**

Add a function to load available global skills:

```typescript
const loadSkillOptions = useCallback(async () => {
  try {
    const { data: skillsData, error: skillsErr } = await client.web.config.skills.post({ action: "list" });
    if (skillsErr) return;
    const data = unwrapConfigData(skillsData) ?? skillsData;
    setSkillOptions(Array.isArray(data) ? data.map((s: any) => ({ id: s.id, name: s.name, description: s.description ?? "" })) : []);
  } catch {
    /* silent */
  }
}, []);
```

Call it in `useEffect` alongside other loads:

```typescript
useEffect(() => {
  loadAgents();
  loadModelOptions();
  loadKnowledgeOptions();
  loadSkillOptions();
}, [loadAgents, loadModelOptions, loadKnowledgeOptions, loadSkillOptions]);
```

- [ ] **Step 4: Initialize skillIds in handleOpenCreate and handleOpenEdit**

In `handleOpenCreate`, add:

```typescript
setFormSkillIds([]);
```

In `handleOpenEdit`, after loading agent detail, parse the `skillIds` field:

```typescript
setFormSkillIds(Array.isArray(detail.skillIds) ? detail.skillIds : []);
```

- [ ] **Step 5: Include skillIds in handleSave payload**

In `buildAgentPayload` function (or directly in `handleSave`), add `skillIds` to the data:

```typescript
const data: Record<string, unknown> = {
  ...buildAgentPayload({...}),
  skillIds: formSkillIds,
};
```

- [ ] **Step 6: Add Skills tab button and content to FormDialog**

Add a fourth tab button after the permission tab button (around line 543):

```tsx
<button
  type="button"
  className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${activeTab === "skills" ? "bg-surface-1 text-text-primary shadow-sm" : "text-text-muted hover:text-text-secondary"}`}
  onClick={() => setActiveTab("skills")}
>
  {t("dialog.tabs.skills")}
</button>
```

Add the skills tab content after the permission tab section (around line 751):

```tsx
{activeTab === "skills" && (
  <div className="space-y-4 max-h-[55vh] overflow-y-auto">
    <div className="rounded-lg border border-border-subtle p-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-text-bright">{t("skills.tabTitle")}</p>
          <p className="text-xs text-text-muted">
            {t("skills.selectedCount", { count: formSkillIds.length })}
          </p>
        </div>
      </div>
      <div className="mt-3 space-y-2">
        {skillOptions.length === 0 ? (
          <p className="text-sm text-text-muted">{t("skills.noOptions")}</p>
        ) : (
          skillOptions.map((item) => {
            const checked = formSkillIds.includes(item.id);
            return (
              <label
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border-subtle px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium text-text-bright">{item.name}</p>
                  {item.description && <p className="text-xs text-text-muted">{item.description}</p>}
                </div>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => {
                    setFormSkillIds((current) =>
                      e.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id),
                    );
                  }}
                />
              </label>
            );
          })
        )}
      </div>
    </div>
  </div>
)}
```

- [ ] **Step 7: Build and verify**

Run: `bun run build:web`
Expected: Successful build

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/AgentsPage.tsx web/src/i18n/locales/en/agents.json web/src/i18n/locales/zh/agents.json
git commit -m "feat: add Skills tab to agent config dialog with checkbox selection"
```

---

### Task 11: Clean up obsolete test files

**Files:**
- Delete or update: `src/__tests__/skill-source-error-status.test.ts`
- Delete or update: `src/__tests__/skill-import-shared-validation.test.ts` (workspace-related tests)
- Update: any other test files that reference removed functions

- [ ] **Step 1: Identify all test files referencing removed functionality**

Run: `grep -rn "listSkillSources\|enableSkill\|disableSkill\|listWorkspaceSkills\|getWorkspaceSkill\|setWorkspaceSkill\|deleteWorkspaceSkill\|importWorkspaceSkillDirectories\|workspace_list\|SourceStatus\|SkillSourceInfo" src/__tests__/ web/src/__tests__/ --include="*.ts" --include="*.tsx" -l`

- [ ] **Step 2: Remove or update each file**

For each file found:
- If the entire file tests removed functionality (e.g., `skill-source-error-status.test.ts`), delete it
- If partially relevant, remove the specific test cases that test removed functionality

- [ ] **Step 3: Run all tests**

Run: `bun test src/__tests__/`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -A src/__tests__/ web/src/__tests__/
git commit -m "test: clean up obsolete skill workspace/enable/disable tests"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 2: Run full lint**

Run: `bun run lint`
Expected: No new errors

- [ ] **Step 3: Run all backend tests**

Run: `bun test src/__tests__/`
Expected: All pass

- [ ] **Step 4: Run all frontend tests**

Run: `bun test web/src/__tests__/`
Expected: All pass

- [ ] **Step 5: Build frontend**

Run: `bun run build:web`
Expected: Successful build

- [ ] **Step 6: Manual smoke test**

Start dev server with `bun run dev`, then:
1. Open `/ctrl/skills` — should show flat skill list, no sources/workspaces
2. Create a global skill
3. Open `/ctrl/agents` — edit an agent
4. Verify "Skills" tab shows with global skills checkboxes
5. Select skills, save
6. Re-open agent — verify selections persisted
7. Launch an agent instance — verify skills are passed in launch spec (check backend logs)
