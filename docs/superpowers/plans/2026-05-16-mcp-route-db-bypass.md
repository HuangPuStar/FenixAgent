# MCP Route 消除 DB 直访，统一走 Service 层

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `src/routes/web/config/mcp.ts` 中 4 处直接 `db` 操作（`mcpTool` 表 CRUD）封装到 `src/services/config/mcp-server.ts`，使路由层不再直接 import db。

**Architecture:** 在 `config/mcp-server.ts` 新增 `mcpToolRepo` 相关函数（`countToolsByServer`、`deleteToolsByServer`、`replaceToolsForServer`、`listToolsByServer`），路由改为调用这些函数。与候选 1 的 Task 2 衔接，但本计划独立可执行。

**Tech Stack:** TypeScript, Drizzle ORM, Bun test

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/config/mcp-server.ts` | Modify | 新增 mcpTool CRUD 函数 |
| `src/routes/web/config/mcp.ts` | Modify | 删除 db/schema/drift import，改调 service |
| `src/__tests__/config-mcp.test.ts` | Modify | 更新 mock（db mock 改为 mcp-server service mock） |

---

### Task 1: 新增 mcpTool Service 函数

**Files:**
- Modify: `src/services/config/mcp-server.ts`

- [ ] **Step 1: 在 mcp-server.ts 添加 mcpTool 操作函数**

在 `src/services/config/mcp-server.ts` 顶部 import 区域追加：

```typescript
import { mcpTool } from "../../db/schema";
import { randomUUID } from "node:crypto";
```

在文件末尾追加：

```typescript
// ────────────────────────────────────────────
// MCP Tool 缓存操作（mcp_tool 表）
// ────────────────────────────────────────────

/** 统计指定 server 的 tool 数量 */
export async function countToolsByServer(serverName: string): Promise<number> {
  const rows = await db.select({ id: mcpTool.id })
    .from(mcpTool)
    .where(eq(mcpTool.serverName, serverName));
  return rows.length;
}

/** 删除指定 server 的所有缓存 tool */
export async function deleteToolsByServer(serverName: string): Promise<void> {
  await db.delete(mcpTool).where(eq(mcpTool.serverName, serverName));
}

/** 替换指定 server 的缓存 tool（先删后插） */
export async function replaceToolsForServer(
  serverName: string,
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
): Promise<void> {
  await deleteToolsByServer(serverName);
  if (tools.length > 0) {
    const now = new Date();
    const rows = tools.map((t) => ({
      id: randomUUID(),
      serverName,
      toolName: t.name,
      description: t.description ?? null,
      inputSchema: t.inputSchema ? JSON.stringify(t.inputSchema) : null,
      inspectedAt: now,
    }));
    await db.insert(mcpTool).values(rows);
  }
}

/** 列出指定 server 的缓存 tool */
export async function listToolsByServer(serverName: string) {
  return db.select()
    .from(mcpTool)
    .where(eq(mcpTool.serverName, serverName));
}
```

注意：需要确认文件顶部已有 `import { eq } from "drizzle-orm";`（已有）。`db` 已在文件顶部导入。

- [ ] **Step 2: Commit**

```bash
git add src/services/config/mcp-server.ts
git commit -m "refactor: 新增 mcpTool CRUD 函数到 config/mcp-server.ts

- countToolsByServer、deleteToolsByServer、replaceToolsForServer、listToolsByServer
- 为消除 mcp 路由 db 直访做准备

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 2: 更新 MCP 路由消除 db 直访

**Files:**
- Modify: `src/routes/web/config/mcp.ts`

- [ ] **Step 1: 替换 db import 为 service import**

修改 `src/routes/web/config/mcp.ts`：

1. 删除以下 import：
```typescript
import { db } from "../../../db";
import { mcpTool } from "../../../db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
```

2. 追加 import（如果候选 1 Task 2 已完成则 `validateMcpConfig`、`isValidMcpName`、`toServerInfo` 已在导入中，只需追加 mcpTool 函数）：
```typescript
import {
  validateMcpConfig,
  isValidMcpName,
  toServerInfo,
  countToolsByServer,
  deleteToolsByServer,
  replaceToolsForServer,
  listToolsByServer,
} from "../../../services/config/mcp-server";
```

如果候选 1 未完成，import 改为：
```typescript
import * as mcpService from "../../../services/config/mcp-server";
```
并在路由内部使用 `mcpService.countToolsByServer` 等。

- [ ] **Step 2: 更新 handleList 中的 db 直访**

将：
```typescript
const tools = await db.select({ id: mcpTool.id })
  .from(mcpTool)
  .where(eq(mcpTool.serverName, s.name));
return { ...toServerInfo(s.name, s), toolsCount: tools.length };
```

替换为：
```typescript
const toolsCount = await countToolsByServer(s.name);
return { ...toServerInfo(s.name, s), toolsCount };
```

- [ ] **Step 3: 更新 handleDelete 中的 db 直访**

将：
```typescript
try {
  await db.delete(mcpTool).where(eq(mcpTool.serverName, name));
} catch {
  // ignore db errors on cleanup
}
```

替换为：
```typescript
try {
  await deleteToolsByServer(name);
} catch {
  // ignore db errors on cleanup
}
```

- [ ] **Step 4: 更新 handleInspect 中的 db 直访**

将：
```typescript
await db.delete(mcpTool).where(eq(mcpTool.serverName, name));
const now = new Date();
if (result.tools.length > 0) {
  const rows = result.tools.map((t) => ({
    id: randomUUID(),
    serverName: name,
    toolName: t.name,
    description: t.description ?? null,
    inputSchema: t.inputSchema ? JSON.stringify(t.inputSchema) : null,
    inspectedAt: now,
  }));
  await db.insert(mcpTool).values(rows);
}
```

替换为：
```typescript
await replaceToolsForServer(name, result.tools);
```

- [ ] **Step 5: 更新 handleListTools 中的 db 直访**

将：
```typescript
const tools = await db.select()
  .from(mcpTool)
  .where(eq(mcpTool.serverName, name));

return {
  success: true,
  data: {
    name,
    tools: tools.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      description: t.description,
      inputSchema: t.inputSchema,
      inspectedAt: t.inspectedAt.getTime(),
    })),
  },
};
```

替换为：
```typescript
const tools = await listToolsByServer(name);

return {
  success: true,
  data: {
    name,
    tools: tools.map((t) => ({
      id: t.id,
      toolName: t.toolName,
      description: t.description,
      inputSchema: t.inputSchema,
      inspectedAt: t.inspectedAt.getTime(),
    })),
  },
};
```

- [ ] **Step 6: Commit**

```bash
git add src/routes/web/config/mcp.ts
git commit -m "refactor: MCP 路由消除 db 直访，统一走 config/mcp-server service

- handleList 改用 countToolsByServer
- handleDelete 改用 deleteToolsByServer
- handleInspect 改用 replaceToolsForServer
- handleListTools 改用 listToolsByServer
- 删除 db/schema/drift/randomUUID import

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

---

### Task 3: 更新测试 mock

**Files:**
- Modify: `src/__tests__/config-mcp.test.ts`

- [ ] **Step 1: 将 db mock 替换为 mcp-server service mock**

修改 `src/__tests__/config-mcp.test.ts`：

1. 删除以下 mock：
```typescript
const _mockDbState: { tools: any[] } = { tools: [] };
mock.module("../db", () => ({
  db: {
    select: () => ({ from: () => ({ where: async () => _mockDbState.tools }) }),
    delete: () => ({ where: async () => {} }),
  },
}));
mock.module("../db/schema", () => ({
  mcpTool: { id: "id", serverName: "server_name" },
}));
mock.module("drizzle-orm", () => ({
  eq: (_col: string, _val: string) => ({ col: _col, val: _val }),
}));
```

2. 追加 mcp-server service mock（在 config-pg mock 之后）：
```typescript
mock.module("../services/config/mcp-server", () => {
  const originalModule = require("../services/config/mcp-server");
  return {
    ...originalModule,
    countToolsByServer: async (_serverName: string) => _mockToolsState.tools.length,
    deleteToolsByServer: async (serverName: string) => {
      _mockToolsState.tools = _mockToolsState.tools.filter((t: any) => t.serverName !== serverName);
    },
    replaceToolsForServer: async (serverName: string, tools: any[]) => {
      _mockToolsState.tools = tools.map((t) => ({
        serverName,
        toolName: t.name,
        description: t.description ?? null,
        inputSchema: t.inputSchema ? JSON.stringify(t.inputSchema) : null,
      }));
    },
    listToolsByServer: async (serverName: string) => _mockToolsState.tools.filter((t: any) => t.serverName === serverName),
  };
});
const _mockToolsState: { tools: any[] } = { tools: [] };
```

3. 更新 `beforeEach`：
```typescript
_mockToolsState.tools = [];
```

注意：由于 mock.module 限制，实际实现可能需要调整 mock 顺序。如果 `../services/config/mcp-server` 的 mock 与 `../services/config-pg`（barrel）冲突，需要在 config-pg mock 中同时 mock `mcp-server` 导出的函数。

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test src/__tests__/config-mcp.test.ts`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/config-mcp.test.ts
git commit -m "refactor: MCP 测试将 db mock 替换为 mcp-server service mock

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```
