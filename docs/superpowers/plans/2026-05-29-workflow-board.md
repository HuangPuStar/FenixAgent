# Workflow Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `workflow_board` entity so that an org can have multiple kanban boards, each independently managing its own Job cards, with Owner/Member roles.

**Architecture:** New `workflow_board` DB table + CRUD route. `workflow_job` gains a `boardId` FK. Frontend adds a `BoardSelector` dropdown in the kanban toolbar. Board ownership is determined by `workflow_board.userId` — no separate member table needed.

**Tech Stack:** Drizzle ORM, Elysia (action-dispatch routes), React 19, shadcn/ui (Popover/DropdownMenu), i18n (react-i18next), zod/v4.

**Spec:** `docs/superpowers/specs/2026-05-29-workflow-board-design.md`

---

## File Structure

### Backend — New Files

| File | Responsibility |
|------|---------------|
| `src/repositories/workflow-board.ts` | Board CRUD data access (interface + impl) |
| `src/routes/web/workflow-boards.ts` | Board API route (action dispatch) |
| `src/schemas/workflow-board.schema.ts` | Request validation schemas |

### Backend — Modified Files

| File | Change |
|------|--------|
| `src/db/schema.ts` | Add `workflowBoard` table; add `boardId` column to `workflowJob` |
| `drizzle/` | Generated migration |
| `src/repositories/index.ts` | Export new board repo functions |
| `src/routes/web/index.ts` | Register `workflow-boards` route |
| `src/routes/web/workflow-jobs.ts` | `create`/`list` actions use `boardId` |
| `src/services/workflow/workflow-job-events.ts` | No change needed — `boardId` is carried in `extra` by caller |

### Frontend — New Files

| File | Responsibility |
|------|---------------|
| `web/src/api/workflow-boards.ts` | Board API client |
| `web/src/pages/workflow/components/BoardSelector.tsx` | Board dropdown selector component |

### Frontend — Modified Files

| File | Change |
|------|--------|
| `web/src/pages/workflow/WorkflowKanban.tsx` | Add `BoardSelector`, `boardId` state, pass to Job list/dialog |
| `web/src/pages/workflow/components/KanbanJobDialog.tsx` | Accept and send `boardId` when creating Job |
| `web/src/api/workflow-jobs.ts` | `create`/`list` accept `boardId` param |
| `web/src/i18n/locales/en/kanban.json` | Board-related English keys |
| `web/src/i18n/locales/zh/kanban.json` | Board-related Chinese keys |

---

## Task 1: Database Schema

**Files:**
- Modify: `src/db/schema.ts`

- [ ] **Step 1: Add `workflowBoard` table to schema.ts**

Add after the `workflowJob` table definition (around line 759), before `workflowTrigger`:

```typescript
// ────────────────────────────────────────────
// Workflow Board（看板面板）
// ────────────────────────────────────────────

export const workflowBoard = pgTable(
  "workflow_board",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    name: varchar("name", { length: 100 }).notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    orgNameIdx: uniqueIndex("idx_workflow_board_org_name").on(table.organizationId, table.name),
    orgIdx: index("idx_workflow_board_org").on(table.organizationId),
  }),
);
```

- [ ] **Step 2: Add `boardId` column to `workflowJob` table**

In the `workflowJob` table definition, add `boardId` field after `id`:

```typescript
export const workflowJob = pgTable(
  "workflow_job",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    boardId: uuid("board_id")
      .notNull()
      .references(() => workflowBoard.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").notNull(),
    // ... rest unchanged
  },
  // ... indexes unchanged, add one new:
  (table) => ({
    orgIdx: index("idx_workflow_job_org").on(table.organizationId),
    statusIdx: index("idx_workflow_job_status").on(table.organizationId, table.status),
    workflowIdx: index("idx_workflow_job_workflow").on(table.workflowId),
    boardIdx: index("idx_workflow_job_board").on(table.boardId),
  }),
);
```

- [ ] **Step 3: Generate migration**

Run:
```bash
bunx drizzle-kit generate --name workflow-board
```

Expected: New migration files in `drizzle/` directory.

- [ ] **Step 4: Apply migration to dev database**

Run:
```bash
bun run db:push
```

Expected: Schema synced, no errors.

- [ ] **Step 5: Verify schema**

Run:
```bash
bun run precheck
```

Expected: tsc passes, biome passes.

- [ ] **Step 6: Commit**

```bash
git add src/db/schema.ts drizzle/
git commit -m "feat(workflow): add workflow_board table and boardId to workflow_job"
```

---

## Task 2: Board Repository

**Files:**
- Create: `src/repositories/workflow-board.ts`
- Modify: `src/repositories/index.ts`

- [ ] **Step 1: Create `src/repositories/workflow-board.ts`**

```typescript
/**
 * Workflow Board Repository。
 *
 * 管理看板面板的 CRUD。
 */

import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { workflowBoard } from "../db/schema";

// ── 类型 ──

export interface WorkflowBoardRow {
  id: string;
  organizationId: string;
  name: string;
  userId: string;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ── CRUD ──

/** 创建 Board */
export async function createBoard(
  organizationId: string,
  userId: string,
  data: { name: string; isDefault?: boolean },
): Promise<WorkflowBoardRow> {
  const [row] = await db
    .insert(workflowBoard)
    .values({
      organizationId,
      userId,
      name: data.name,
      isDefault: data.isDefault ?? false,
    })
    .returning();
  return row as WorkflowBoardRow;
}

/** 获取单个 Board */
export async function getBoard(boardId: string, organizationId: string): Promise<WorkflowBoardRow | null> {
  const [row] = await db
    .select()
    .from(workflowBoard)
    .where(and(eq(workflowBoard.id, boardId), eq(workflowBoard.organizationId, organizationId)))
    .limit(1);
  return (row as WorkflowBoardRow) ?? null;
}

/** 列出组织的所有 Board（default 排最前，其余按创建时间） */
export async function listBoards(organizationId: string): Promise<WorkflowBoardRow[]> {
  const rows = await db
    .select()
    .from(workflowBoard)
    .where(eq(workflowBoard.organizationId, organizationId))
    .orderBy(asc(workflowBoard.isDefault), asc(workflowBoard.createdAt));
  return rows as WorkflowBoardRow[];
}

/** 重命名 Board */
export async function updateBoard(boardId: string, organizationId: string, name: string): Promise<boolean> {
  const result = await db
    .update(workflowBoard)
    .set({ name, updatedAt: new Date() })
    .where(and(eq(workflowBoard.id, boardId), eq(workflowBoard.organizationId, organizationId)))
    .returning();
  return result.length > 0;
}

/** 删除 Board */
export async function deleteBoard(boardId: string, organizationId: string): Promise<boolean> {
  const result = await db
    .delete(workflowBoard)
    .where(and(eq(workflowBoard.id, boardId), eq(workflowBoard.organizationId, organizationId)))
    .returning();
  return result.length > 0;
}

/** 获取组织的 default board（不存在时返回 null） */
export async function getDefaultBoard(organizationId: string): Promise<WorkflowBoardRow | null> {
  const [row] = await db
    .select()
    .from(workflowBoard)
    .where(and(eq(workflowBoard.organizationId, organizationId), eq(workflowBoard.isDefault, true)))
    .limit(1);
  return (row as WorkflowBoardRow) ?? null;
}

/** 确保 default board 存在，不存在则创建 */
export async function ensureDefaultBoard(organizationId: string, userId: string): Promise<WorkflowBoardRow> {
  const existing = await getDefaultBoard(organizationId);
  if (existing) return existing;
  return createBoard(organizationId, userId, { name: "Default Board", isDefault: true });
}
```

- [ ] **Step 2: Export from `src/repositories/index.ts`**

Add at the end of the file, in the appropriate section:

```typescript
export type { WorkflowBoardRow } from "./workflow-board";
export {
  createBoard,
  deleteBoard,
  ensureDefaultBoard,
  getBoard,
  getDefaultBoard,
  listBoards,
  updateBoard,
} from "./workflow-board";
```

- [ ] **Step 3: Verify types compile**

Run:
```bash
npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: No type errors related to new files.

- [ ] **Step 4: Commit**

```bash
git add src/repositories/workflow-board.ts src/repositories/index.ts
git commit -m "feat(workflow): add workflow-board repository"
```

---

## Task 3: Board Schema Validation

**Files:**
- Create: `src/schemas/workflow-board.schema.ts`

- [ ] **Step 1: Create schema file**

```typescript
import * as z from "zod/v4";

export const BoardCreateSchema = z.object({
  action: z.literal("create"),
  name: z.string().min(1).max(100),
});

export const BoardUpdateSchema = z.object({
  action: z.literal("update"),
  boardId: z.string().min(1),
  name: z.string().min(1).max(100),
});

export const BoardDeleteSchema = z.object({
  action: z.literal("delete"),
  boardId: z.string().min(1),
});

export const BoardGetSchema = z.object({
  action: z.literal("get"),
  boardId: z.string().min(1),
});

export const BoardListSchema = z.object({
  action: z.literal("list"),
});
```

- [ ] **Step 2: Commit**

```bash
git add src/schemas/workflow-board.schema.ts
git commit -m "feat(workflow): add workflow-board schema validation"
```

---

## Task 4: Board API Route

**Files:**
- Create: `src/routes/web/workflow-boards.ts`
- Modify: `src/routes/web/index.ts`

- [ ] **Step 1: Create `src/routes/web/workflow-boards.ts`**

```typescript
/**
 * Workflow Boards API 路由。
 *
 * POST /web/workflow-boards — action 分发，管理看板面板的创建、查询、重命名、删除。
 */

import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  createBoard,
  deleteBoard,
  ensureDefaultBoard,
  getBoard,
  listBoards,
  updateBoard,
} from "../../repositories/workflow-board";

const app = new Elysia({ name: "web-workflow-boards" }).use(authGuardPlugin);

app.post(
  "/workflow-boards",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia type inference limitation with sessionAuth
  async ({ store, body, error }: any) => {
    const authCtx = store.authContext!;
    const payload = body as Record<string, unknown>;
    const action = payload.action as string;

    try {
      switch (action) {
        case "list": {
          let boards = await listBoards(authCtx.organizationId);
          // 自动确保 default board 存在
          if (boards.length === 0) {
            const defaultBoard = await ensureDefaultBoard(authCtx.organizationId, authCtx.userId);
            boards = await listBoards(authCtx.organizationId);
            void defaultBoard;
          }
          return { success: true, data: boards };
        }

        case "get": {
          const boardId = payload.boardId as string;
          if (!boardId) return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          const board = await getBoard(boardId, authCtx.organizationId);
          if (!board) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
          return { success: true, data: board };
        }

        case "create": {
          const name = payload.name as string;
          if (!name?.trim()) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "name is required" } });
          }
          try {
            const board = await createBoard(authCtx.organizationId, authCtx.userId, { name: name.trim() });
            return { success: true, data: board };
          } catch (err: unknown) {
            // 唯一约束冲突
            if (String(err).includes("idx_workflow_board_org_name")) {
              return error(409, { error: { type: "CONFLICT", message: "Board name already exists" } });
            }
            throw err;
          }
        }

        case "update": {
          const boardId = payload.boardId as string;
          const name = payload.name as string;
          if (!boardId) return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          if (!name?.trim()) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "name is required" } });
          }
          const board = await getBoard(boardId, authCtx.organizationId);
          if (!board) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
          // Owner 权限校验
          if (board.userId !== authCtx.userId) {
            return error(403, { error: { type: "FORBIDDEN", message: "Only the board owner can rename it" } });
          }
          try {
            const ok = await updateBoard(boardId, authCtx.organizationId, name.trim());
            if (!ok) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
            return { success: true };
          } catch (err: unknown) {
            if (String(err).includes("idx_workflow_board_org_name")) {
              return error(409, { error: { type: "CONFLICT", message: "Board name already exists" } });
            }
            throw err;
          }
        }

        case "delete": {
          const boardId = payload.boardId as string;
          if (!boardId) return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
          const board = await getBoard(boardId, authCtx.organizationId);
          if (!board) return error(404, { error: { type: "NOT_FOUND", message: "Board not found" } });
          // Owner 权限校验
          if (board.userId !== authCtx.userId) {
            return error(403, { error: { type: "FORBIDDEN", message: "Only the board owner can delete it" } });
          }
          // Default board 不可删除
          if (board.isDefault) {
            return error(400, { error: { type: "VALIDATION_ERROR", message: "Cannot delete the default board" } });
          }
          const deleted = await deleteBoard(boardId, authCtx.organizationId);
          return { success: true, data: deleted };
        }

        default:
          return error(400, { error: { type: "VALIDATION_ERROR", message: `Unknown action: ${action}` } });
      }
    } catch (err: unknown) {
      console.error("[workflow-boards] Error:", err);
      const message = err instanceof Error ? err.message : "Unknown error";
      return error(500, { error: { type: "INTERNAL_ERROR", message } });
    }
  },
  { sessionAuth: true },
);

export default app;
```

- [ ] **Step 2: Register route in `src/routes/web/index.ts`**

Add import and `.use()`:

```typescript
import webWorkflowBoards from "./workflow-boards";

// Add .use(webWorkflowBoards) after webWorkflowJobsSse:
  .use(webWorkflowBoards)
```

Full context — the updated section:
```typescript
import webWorkflowBoards from "./workflow-boards";
// ... existing imports ...

const webApp = new Elysia({ name: "web", prefix: "/web" })
  // ... existing routes ...
  .use(webWorkflowJobs)
  .use(webWorkflowJobsSse)
  .use(webWorkflowBoards)
  .use(webWorkflowSse);
```

- [ ] **Step 3: Verify build**

Run:
```bash
npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/routes/web/workflow-boards.ts src/routes/web/index.ts
git commit -m "feat(workflow): add workflow-boards API route"
```

---

## Task 5: Modify workflow-jobs Route (boardId)

**Files:**
- Modify: `src/routes/web/workflow-jobs.ts`
- Modify: `src/repositories/workflow-job.ts`

- [ ] **Step 1: Update `src/repositories/workflow-job.ts`**

Add `boardId` parameter to `createJob`:

```typescript
export async function createJob(
  organizationId: string,
  userId: string,
  data: { boardId: string; workflowId: string; version: number; params?: Record<string, unknown> },
): Promise<WorkflowJobRow> {
  const [row] = await db
    .insert(workflowJob)
    .values({
      boardId: data.boardId,
      organizationId,
      userId,
      workflowId: data.workflowId,
      version: data.version,
      params: data.params ?? null,
      status: "ready",
    })
    .returning();
  return row as WorkflowJobRow;
}
```

Add `boardId` filter to `listJobs`:

```typescript
export async function listJobs(organizationId: string, boardId?: string): Promise<WorkflowJobListItem[]> {
  const conditions = [eq(workflowJob.organizationId, organizationId)];
  if (boardId) {
    conditions.push(eq(workflowJob.boardId, boardId));
  }

  const rows = await db
    .select({
      job: workflowJob,
      workflowName: workflow.name,
      userName: user.name,
    })
    .from(workflowJob)
    .innerJoin(workflow, eq(workflowJob.workflowId, workflow.id))
    .leftJoin(user, eq(workflowJob.userId, user.id))
    .where(and(...conditions))
    .orderBy(desc(workflowJob.updatedAt));

  return rows.map((r) => ({
    ...(r.job as WorkflowJobRow),
    workflowName: r.workflowName,
    userName: r.userName ?? null,
  }));
}
```

- [ ] **Step 2: Update `src/routes/web/workflow-jobs.ts` — create action**

In the `create` case, add `boardId` extraction and pass to `createJob`:

```typescript
case "create": {
  const workflowId = payload.workflowId as string;
  const boardId = payload.boardId as string;
  const params = payload.params as Record<string, unknown> | undefined;
  if (!workflowId) {
    return error(400, { error: { type: "VALIDATION_ERROR", message: "workflowId is required" } });
  }
  if (!boardId) {
    return error(400, { error: { type: "VALIDATION_ERROR", message: "boardId is required" } });
  }
  const wf = await getWorkflowDef(workflowId, authCtx.organizationId);
  if (!wf) return error(404, { error: { type: "NOT_FOUND", message: "Workflow not found" } });
  const version = wf.latestVersion ?? 0;

  const job = await createJob(authCtx.organizationId, authCtx.userId, { boardId, workflowId, version, params });
  publishJobEvent(authCtx.organizationId, "job.created", { jobId: job.id, boardId });
  return { success: true, data: job };
}
```

- [ ] **Step 3: Update `src/routes/web/workflow-jobs.ts` — list action**

In the `list` case, add `boardId` extraction and pass to `listJobs`:

```typescript
case "list": {
  const boardId = payload.boardId as string | undefined;
  const jobs = await listJobs(authCtx.organizationId, boardId);
  return { success: true, data: jobs };
}
```

- [ ] **Step 4: Update `src/repositories/index.ts` export if function signature changed**

The `createJob` signature changed — no change needed in `index.ts` since the export is the function itself.

- [ ] **Step 5: Verify build**

Run:
```bash
npx tsc --noEmit --pretty 2>&1 | head -20
```

Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/repositories/workflow-job.ts src/routes/web/workflow-jobs.ts
git commit -m "feat(workflow): add boardId to workflow-job create/list"
```

---

## Task 6: Frontend Board API Client

**Files:**
- Create: `web/src/api/workflow-boards.ts`
- Modify: `web/src/api/workflow-jobs.ts`

- [ ] **Step 1: Create `web/src/api/workflow-boards.ts`**

```typescript
/**
 * Workflow Boards API Client。
 *
 * 对接后端 POST /web/workflow-boards，通过 action 字段分发。
 */

// ── 类型 ──

export interface WorkflowBoard {
  id: string;
  organizationId: string;
  name: string;
  userId: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

// ── helpers ──

async function postAction(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch("/web/workflow-boards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Unknown error");
  return json.data;
}

// ── API ──

export const workflowBoardsApi = {
  async list(): Promise<WorkflowBoard[]> {
    const data = await postAction("list");
    return Array.isArray(data) ? data : [];
  },

  async get(boardId: string): Promise<WorkflowBoard> {
    return postAction("get", { boardId }) as Promise<WorkflowBoard>;
  },

  async create(name: string): Promise<WorkflowBoard> {
    return postAction("create", { name }) as Promise<WorkflowBoard>;
  },

  async update(boardId: string, name: string): Promise<void> {
    await postAction("update", { boardId, name });
  },

  async delete(boardId: string): Promise<void> {
    await postAction("delete", { boardId });
  },
};
```

- [ ] **Step 2: Update `web/src/api/workflow-jobs.ts` — add `boardId` to create/list**

Change the `create` method signature:

```typescript
async create(boardId: string, workflowId: string, params?: Record<string, unknown>): Promise<WorkflowJob> {
  return postAction("create", { boardId, workflowId, params }) as Promise<WorkflowJob>;
},
```

Change the `list` method to accept optional `boardId`:

```typescript
async list(boardId?: string): Promise<WorkflowJob[]> {
  const data = await postAction("list", boardId ? { boardId } : {});
  return Array.isArray(data) ? data : [];
},
```

- [ ] **Step 3: Commit**

```bash
git add web/src/api/workflow-boards.ts web/src/api/workflow-jobs.ts
git commit -m "feat(workflow): add workflow-boards API client, update jobs client with boardId"
```

---

## Task 7: Frontend i18n

**Files:**
- Modify: `web/src/i18n/locales/en/kanban.json`
- Modify: `web/src/i18n/locales/zh/kanban.json`

- [ ] **Step 1: Add English board keys to `web/src/i18n/locales/en/kanban.json`**

Add these keys (append to existing JSON):

```json
{
  "board_selector_placeholder": "Select board...",
  "board_create": "New Board",
  "board_create_title": "Create Board",
  "board_create_placeholder": "Board name",
  "board_create_confirm": "Create",
  "board_create_creating": "Creating...",
  "board_rename": "Rename",
  "board_rename_title": "Rename Board",
  "board_rename_placeholder": "Board name",
  "board_rename_confirm": "Save",
  "board_delete": "Delete Board",
  "board_delete_confirm": "Delete board \"{{name}}\" and all its jobs?",
  "board_default_name": "Default Board",
  "board_owner_badge": "Owner",
  "board_cannot_delete_default": "Cannot delete the default board"
}
```

- [ ] **Step 2: Add Chinese board keys to `web/src/i18n/locales/zh/kanban.json`**

Add these keys (append to existing JSON):

```json
{
  "board_selector_placeholder": "选择看板...",
  "board_create": "新建看板",
  "board_create_title": "创建看板",
  "board_create_placeholder": "看板名称",
  "board_create_confirm": "创建",
  "board_create_creating": "创建中...",
  "board_rename": "重命名",
  "board_rename_title": "重命名看板",
  "board_rename_placeholder": "看板名称",
  "board_rename_confirm": "保存",
  "board_delete": "删除看板",
  "board_delete_confirm": "删除看板「{{name}}」及其所有 Job？",
  "board_default_name": "默认看板",
  "board_owner_badge": "所有者",
  "board_cannot_delete_default": "无法删除默认看板"
}
```

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/kanban.json web/src/i18n/locales/zh/kanban.json
git commit -m "feat(workflow): add board-related i18n keys"
```

---

## Task 8: BoardSelector Component

**Files:**
- Create: `web/src/pages/workflow/components/BoardSelector.tsx`

- [ ] **Step 1: Create `BoardSelector.tsx`**

```typescript
import { Check, ChevronsUpDown, MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WorkflowBoard } from "../../../api/workflow-boards";
import { workflowBoardsApi } from "../../../api/workflow-boards";

interface BoardSelectorProps {
  currentUserId: string;
  selectedBoardId: string | null;
  onSelect: (boardId: string) => void;
  onBoardsChange: () => void;
}

export function BoardSelector({ currentUserId, selectedBoardId, onSelect, onBoardsChange }: BoardSelectorProps) {
  const { t } = useTranslation("kanban");
  const [boards, setBoards] = useState<WorkflowBoard[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);

  // Dialog states
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameBoard, setRenameBoard] = useState<WorkflowBoard | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);

  const loadBoards = useCallback(async () => {
    setLoading(true);
    try {
      const data = await workflowBoardsApi.list();
      setBoards(data);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadBoards();
  }, [loadBoards]);

  // Auto-select default board or first board
  useEffect(() => {
    if (boards.length > 0 && !selectedBoardId) {
      const defaultBoard = boards.find((b) => b.isDefault);
      onSelect(defaultBoard?.id ?? boards[0].id);
    }
  }, [boards, selectedBoardId, onSelect]);

  const selectedBoard = boards.find((b) => b.id === selectedBoardId);

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const board = await workflowBoardsApi.create(createName.trim());
      setCreateDialogOpen(false);
      setCreateName("");
      await loadBoards();
      onSelect(board.id);
      onBoardsChange();
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [createName, loadBoards, onSelect, onBoardsChange]);

  const handleRename = useCallback(async () => {
    if (!renameBoard || !renameName.trim()) return;
    setRenaming(true);
    try {
      await workflowBoardsApi.update(renameBoard.id, renameName.trim());
      setRenameDialogOpen(false);
      setRenameBoard(null);
      setRenameName("");
      await loadBoards();
      onBoardsChange();
    } catch (err) {
      console.error(err);
      toast.error((err as Error).message);
    } finally {
      setRenaming(false);
    }
  }, [renameBoard, renameName, loadBoards, onBoardsChange]);

  const handleDelete = useCallback(
    async (board: WorkflowBoard) => {
      if (board.isDefault) {
        toast.error(t("board_cannot_delete_default"));
        return;
      }
      if (!confirm(t("board_delete_confirm", { name: board.name }))) return;
      try {
        await workflowBoardsApi.delete(board.id);
        await loadBoards();
        onBoardsChange();
      } catch (err) {
        console.error(err);
        toast.error((err as Error).message);
      }
    },
    [loadBoards, onBoardsChange, t],
  );

  const isOwner = useCallback(
    (board: WorkflowBoard) => board.userId === currentUserId,
    [currentUserId],
  );

  return (
    <>
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              role="combobox"
              aria-expanded={open}
              className="w-[200px] justify-between text-xs"
              disabled={loading}
            >
              {selectedBoard?.name ?? t("board_selector_placeholder")}
              <ChevronsUpDown size={14} className="ml-1 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[240px] p-0" align="start">
            <Command>
              <CommandInput placeholder={t("board_selector_placeholder")} className="text-xs" />
              <CommandList>
                <CommandEmpty>{t("board_selector_placeholder")}</CommandEmpty>
                <CommandGroup>
                  {boards.map((board) => (
                    <CommandItem
                      key={board.id}
                      value={board.name}
                      onSelect={() => {
                        onSelect(board.id);
                        setOpen(false);
                      }}
                      className="flex items-center justify-between text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <Check size={13} className={selectedBoardId === board.id ? "opacity-100" : "opacity-0"} />
                        <span>{board.name}</span>
                        {board.isDefault && (
                          <span className="text-[10px] text-text-dim bg-surface-2 px-1.5 py-0.5 rounded">
                            default
                          </span>
                        )}
                      </div>
                      {isOwner(board) && !board.isDefault && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                          }}
                          className="p-1 hover:bg-surface-hover rounded"
                        >
                          <MoreHorizontal size={13} />
                        </button>
                      )}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        <Button
          variant="ghost"
          size="sm"
          className="text-xs gap-1"
          onClick={() => setCreateDialogOpen(true)}
        >
          <Plus size={13} />
          {t("board_create")}
        </Button>

        {/* Owner actions for current board */}
        {selectedBoard && isOwner(selectedBoard) && (
          <div className="flex items-center gap-1 ml-1">
            <button
              type="button"
              title={t("board_rename")}
              onClick={() => {
                setRenameBoard(selectedBoard);
                setRenameName(selectedBoard.name);
                setRenameDialogOpen(true);
              }}
              className="p-1.5 text-text-dim hover:text-text-primary hover:bg-surface-hover rounded transition-colors"
            >
              <Pencil size={12} />
            </button>
            {!selectedBoard.isDefault && (
              <button
                type="button"
                title={t("board_delete")}
                onClick={() => handleDelete(selectedBoard)}
                className="p-1.5 text-text-dim hover:text-red-500 hover:bg-surface-hover rounded transition-colors"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      {/* Create Board Dialog */}
      <Dialog open={createDialogOpen} onOpenChange={(v) => !v && setCreateDialogOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("board_create_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold tracking-wide uppercase text-text-dim">
                {t("board_create_placeholder")}
              </Label>
              <Input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder={t("board_create_placeholder")}
                className="h-8 text-sm"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateDialogOpen(false)}>
              {t("dialog_cancel")}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating ? t("board_create_creating") : t("board_create_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Rename Board Dialog */}
      <Dialog open={renameDialogOpen} onOpenChange={(v) => !v && setRenameDialogOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("board_rename_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-[11px] font-semibold tracking-wide uppercase text-text-dim">
                {t("board_rename_placeholder")}
              </Label>
              <Input
                value={renameName}
                onChange={(e) => setRenameName(e.target.value)}
                placeholder={t("board_rename_placeholder")}
                className="h-8 text-sm"
                autoFocus
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameDialogOpen(false)}>
              {t("dialog_cancel")}
            </Button>
            <Button size="sm" onClick={handleRename} disabled={renaming || !renameName.trim()}>
              {renaming ? t("board_create_creating") : t("board_rename_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/components/BoardSelector.tsx
git commit -m "feat(workflow): add BoardSelector component"
```

---

## Task 9: Integrate Board into WorkflowKanban

**Files:**
- Modify: `web/src/pages/workflow/WorkflowKanban.tsx`
- Modify: `web/src/pages/workflow/components/KanbanJobDialog.tsx`

- [ ] **Step 1: Update `WorkflowKanban.tsx`**

The key changes:
1. Add `boardId` state
2. Add `BoardSelector` in toolbar
3. Pass `boardId` to Job list and dialog
4. Get `currentUserId` from auth context

Replace the component:

```typescript
import { Loader, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WorkflowJob } from "../../api/workflow-jobs";
import { workflowJobsApi } from "../../api/workflow-jobs";
import { BoardSelector } from "./components/BoardSelector";
import { KanbanColumn } from "./components/KanbanColumn";
import { KanbanJobDialog } from "./components/KanbanJobDialog";

const COMPLETED_COLLAPSE_LIMIT = 10;

export function WorkflowKanban() {
  const { t } = useTranslation("kanban");
  const [jobs, setJobs] = useState<WorkflowJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAllCompleted, setShowAllCompleted] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editJob, setEditJob] = useState<WorkflowJob | null>(null);

  // Board state
  const [boardId, setBoardId] = useState<string | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string>("");

  // Fetch current user info once
  useEffect(() => {
    fetch("/web/auth/get-session", { credentials: "include" })
      .then((res) => res.json())
      .then((data) => {
        setCurrentUserId(data?.user?.id ?? "");
      })
      .catch(() => {});
  }, []);

  const loadJobs = useCallback(async () => {
    if (!boardId) return;
    try {
      setLoading(true);
      setError(null);
      const data = await workflowJobsApi.list(boardId);
      setJobs(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    loadJobs();
  }, [loadJobs]);

  // SSE 实时更新
  useEffect(() => {
    const es = workflowJobsApi.createEventSource();
    es.onmessage = () => {
      loadJobs();
    };
    return () => es.close();
  }, [loadJobs]);

  const grouped = useMemo(() => {
    const ready = jobs.filter((j) => j.status === "ready");
    const running = jobs.filter((j) => j.status === "running");
    const suspended = jobs.filter((j) => j.status === "suspended");
    const completed = jobs.filter((j) => j.status === "completed");
    return { ready, running, suspended, completed };
  }, [jobs]);

  const completedToShow = showAllCompleted ? grouped.completed : grouped.completed.slice(0, COMPLETED_COLLAPSE_LIMIT);
  const hasMoreCompleted = grouped.completed.length > COMPLETED_COLLAPSE_LIMIT;

  const handleEditParams = useCallback((job: WorkflowJob) => {
    setEditJob(job);
    setDialogOpen(true);
  }, []);

  const handleDialogClose = useCallback(() => {
    setDialogOpen(false);
    setEditJob(null);
  }, []);

  const handleBoardSelect = useCallback((id: string) => {
    setBoardId(id);
  }, []);

  if (loading && jobs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted text-sm p-6">
        {t("load_failed", { error })}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border-subtle bg-surface-1 flex-shrink-0">
        <BoardSelector
          currentUserId={currentUserId}
          selectedBoardId={boardId}
          onSelect={handleBoardSelect}
          onBoardsChange={loadJobs}
        />
        <button
          type="button"
          onClick={loadJobs}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-text-secondary text-xs hover:bg-surface-hover transition-colors"
        >
          <RefreshCw size={12} />
          {t("refresh")}
        </button>
      </div>

      {/* Board */}
      {boardId ? (
        <div className="flex flex-1 min-h-0 overflow-hidden bg-surface-0">
          <KanbanColumn titleKey="col_ready" jobs={grouped.ready} onRefresh={loadJobs} onEditParams={handleEditParams} />
          <KanbanColumn
            titleKey="col_running"
            jobs={grouped.running}
            onRefresh={loadJobs}
            onEditParams={handleEditParams}
          />
          <KanbanColumn
            titleKey="col_suspended"
            jobs={grouped.suspended}
            onRefresh={loadJobs}
            onEditParams={handleEditParams}
          />
          <div className="flex flex-col min-w-[260px] flex-1">
            <KanbanColumn
              titleKey="col_completed"
              jobs={completedToShow}
              onRefresh={loadJobs}
              onEditParams={handleEditParams}
            />
            {hasMoreCompleted && !showAllCompleted && (
              <button
                type="button"
                onClick={() => setShowAllCompleted(true)}
                className="text-[11px] text-brand hover:text-brand-light py-2 text-center flex-shrink-0 transition-colors"
              >
                {t("completed_show_more", { count: grouped.completed.length - COMPLETED_COLLAPSE_LIMIT })}
              </button>
            )}
            {showAllCompleted && hasMoreCompleted && (
              <button
                type="button"
                onClick={() => setShowAllCompleted(false)}
                className="text-[11px] text-brand hover:text-brand-light py-2 text-center flex-shrink-0 transition-colors"
              >
                {t("completed_show_less")}
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center text-text-muted text-sm">
          <Loader className="h-4 w-4 animate-spin mr-2" />
          {t("refresh")}
        </div>
      )}

      <KanbanJobDialog
        open={dialogOpen}
        onClose={handleDialogClose}
        editJob={editJob}
        onRefresh={loadJobs}
        boardId={boardId}
      />
    </div>
  );
}
```

- [ ] **Step 2: Update `KanbanJobDialog.tsx` — accept and send `boardId`**

Add `boardId` to the props interface:

```typescript
interface KanbanJobDialogProps {
  open: boolean;
  onClose: () => void;
  editJob: WorkflowJob | null;
  onRefresh: () => void;
  boardId: string | null;
}
```

Update the component signature:

```typescript
export function KanbanJobDialog({ open, onClose, editJob, onRefresh, boardId }: KanbanJobDialogProps) {
```

Update `handleSubmit` — in the `create` case, pass `boardId`:

```typescript
await workflowJobsApi.create(boardId!, selectedId, paramValues);
```

- [ ] **Step 3: Verify build**

Run:
```bash
bun run build:web
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/WorkflowKanban.tsx web/src/pages/workflow/components/KanbanJobDialog.tsx
git commit -m "feat(workflow): integrate BoardSelector into WorkflowKanban and KanbanJobDialog"
```

---

## Task 10: Final Verification

**Files:** None — verification only.

- [ ] **Step 1: Run full precheck**

```bash
bun run precheck
```

Expected: All checks pass (biome format, import sort, tsc, biome check).

- [ ] **Step 2: Run backend tests**

```bash
bun test src/__tests__/
```

Expected: All existing tests pass. No regressions.

- [ ] **Step 3: Run frontend build**

```bash
bun run build:web
```

Expected: Build succeeds, no errors.

- [ ] **Step 4: Final commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix(workflow): final cleanup for board feature"
```
