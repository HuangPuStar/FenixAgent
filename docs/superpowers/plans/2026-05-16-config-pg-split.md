# config-pg.ts God Module 拆分 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 477 行的 `config-pg.ts` 拆分为按子域独立的文件，每个 Config Module（Provider、Model、AgentConfig、McpServer、Skill、UserConfig）各一个文件，加上一个聚合文件。遵循 ADR-0002 "每个模块保留独立的 CRUD 逻辑"。

**Architecture:** 创建 `src/services/config/` 目录，每个子域一个文件。`config-pg.ts` 变为桶文件（barrel file）重新导出所有函数，保持现有调用者零改动。`getAgentFullConfig()` 放在独立的聚合文件中，显式依赖各子域。

**Tech Stack:** TypeScript、Drizzle ORM、PostgreSQL

---

## 受影响文件总览

| 文件 | 操作 | 职责 |
|------|------|------|
| `src/services/config-pg.ts` | 重写为桶文件 | 重新导出所有子域函数 |
| `src/services/config/provider.ts` | 新建 | Provider CRUD（listProviders、getProvider、upsertProvider、deleteProvider） |
| `src/services/config/model.ts` | 新建 | Model CRUD（addModel、updateModel、removeModel） |
| `src/services/config/agent-config.ts` | 新建 | AgentConfig CRUD + AGENT_SETTABLE_FIELDS |
| `src/services/config/mcp-server.ts` | 新建 | McpServer CRUD + setMcpServerEnabled |
| `src/services/config/skill.ts` | 新建 | Skill 元数据 CRUD（listSkills、upsertSkill、deleteSkill、enableSkill、disableSkill） |
| `src/services/config/user-config.ts` | 新建 | UserConfig get/set |
| `src/services/config/aggregate.ts` | 新建 | getAgentFullConfig 跨域聚合 |
| `src/services/config/index.ts` | 新建 | 目录桶文件 |

---

### Task 1: 创建 config 目录结构和 provider.ts

**Files:**
- Create: `src/services/config/provider.ts`
- Create: `src/services/config/index.ts` (占位桶文件)

- [ ] **Step 1: 创建目录**

Run: `mkdir -p src/services/config`

- [ ] **Step 2: 从 config-pg.ts 提取 Provider 函数到独立文件**

创建 `src/services/config/provider.ts`，内容为 `config-pg.ts` 第 1-98 行的 Provider 相关代码：

```typescript
import { db } from "../../db";
import { provider, model } from "../../db/schema";
import { eq, and, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// Provider 操作
// ────────────────────────────────────────────

export async function listProviders(userId: string) {
  const rows = await db.select({
    id: provider.id,
    name: provider.name,
    displayName: provider.displayName,
    npm: provider.npm,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    extraOptions: provider.extraOptions,
    createdAt: provider.createdAt,
    updatedAt: provider.updatedAt,
    modelCount: sql<number>`(SELECT COUNT(*) FROM ${model} WHERE ${model.providerId} = ${provider.id})`,
  })
    .from(provider)
    .where(eq(provider.userId, userId));

  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    displayName: r.displayName,
    npm: r.npm,
    baseUrl: r.baseUrl,
    apiKey: r.apiKey,
    extraOptions: r.extraOptions,
    modelCount: Number(r.modelCount),
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));
}

export async function getProvider(userId: string, name: string) {
  const rows = await db.select().from(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .limit(1);
  if (rows.length === 0) return null;
  const p = rows[0];

  const models = await db.select().from(model)
    .where(eq(model.providerId, p.id));

  return { ...p, models };
}

export async function upsertProvider(
  userId: string,
  name: string,
  data: {
    displayName?: string;
    npm?: string;
    baseUrl?: string;
    apiKey?: string;
    extraOptions?: Record<string, unknown>;
  },
) {
  const existing = await db.select({ id: provider.id }).from(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .limit(1);

  if (existing.length > 0) {
    await db.update(provider)
      .set({
        displayName: data.displayName,
        npm: data.npm,
        baseUrl: data.baseUrl,
        apiKey: data.apiKey,
        extraOptions: data.extraOptions ? JSON.stringify(data.extraOptions) : undefined,
        updatedAt: new Date(),
      })
      .where(eq(provider.id, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db.insert(provider).values({
    userId,
    name,
    displayName: data.displayName,
    npm: data.npm,
    baseUrl: data.baseUrl,
    apiKey: data.apiKey,
    extraOptions: data.extraOptions ? JSON.stringify(data.extraOptions) : undefined,
  }).returning({ id: provider.id });
  return inserted[0].id;
}

export async function deleteProvider(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(provider)
    .where(and(eq(provider.userId, userId), eq(provider.name, name)))
    .returning({ id: provider.id });
  return result.length > 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/services/config/provider.ts
git commit -m "refactor: 从 config-pg.ts 提取 Provider 子域为独立文件"
```

---

### Task 2: 提取 Model 子域

**Files:**
- Create: `src/services/config/model.ts`

- [ ] **Step 1: 创建 model.ts**

创建 `src/services/config/model.ts`，内容为 `config-pg.ts` 第 104-153 行：

```typescript
import { db } from "../../db";
import { model } from "../../db/schema";
import { eq, and } from "drizzle-orm";

// ────────────────────────────────────────────
// Model 操作
// ────────────────────────────────────────────

export async function addModel(
  providerId: string,
  data: {
    modelId: string;
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  await db.insert(model).values({
    providerId,
    modelId: data.modelId,
    displayName: data.displayName,
    modalities: data.modalities ? JSON.stringify(data.modalities) : undefined,
    limitConfig: data.limitConfig ? JSON.stringify(data.limitConfig) : undefined,
    cost: data.cost ? JSON.stringify(data.cost) : undefined,
    options: data.options ? JSON.stringify(data.options) : undefined,
  });
}

export async function updateModel(
  providerId: string,
  modelId: string,
  data: {
    displayName?: string;
    modalities?: unknown;
    limitConfig?: unknown;
    cost?: unknown;
    options?: unknown;
  },
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (data.displayName !== undefined) set.displayName = data.displayName;
  if (data.modalities !== undefined) set.modalities = JSON.stringify(data.modalities);
  if (data.limitConfig !== undefined) set.limitConfig = JSON.stringify(data.limitConfig);
  if (data.cost !== undefined) set.cost = JSON.stringify(data.cost);
  if (data.options !== undefined) set.options = JSON.stringify(data.options);

  await db.update(model).set(set)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)));
}

export async function removeModel(providerId: string, modelId: string): Promise<boolean> {
  const result = await db.delete(model)
    .where(and(eq(model.providerId, providerId), eq(model.modelId, modelId)))
    .returning({ id: model.id });
  return result.length > 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/config/model.ts
git commit -m "refactor: 从 config-pg.ts 提取 Model 子域为独立文件"
```

---

### Task 3: 提取 AgentConfig 子域

**Files:**
- Create: `src/services/config/agent-config.ts`

- [ ] **Step 1: 创建 agent-config.ts**

创建 `src/services/config/agent-config.ts`，内容为 `config-pg.ts` 第 155-227 行：

```typescript
import { db } from "../../db";
import { agentConfig } from "../../db/schema";
import { eq, and } from "drizzle-orm";

// ────────────────────────────────────────────
// Agent Config 操作
// ────────────────────────────────────────────

export const AGENT_SETTABLE_FIELDS = [
  "model", "prompt", "steps", "mode", "permission",
  "variant", "temperature", "topP", "disable", "hidden", "color", "description", "knowledge",
] as const;

export async function listAgentConfigs(userId: string) {
  return db.select().from(agentConfig)
    .where(eq(agentConfig.userId, userId));
}

export async function getAgentConfig(userId: string, name: string) {
  const rows = await db.select().from(agentConfig)
    .where(and(eq(agentConfig.userId, userId), eq(agentConfig.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAgentConfigById(id: string) {
  const rows = await db.select().from(agentConfig)
    .where(eq(agentConfig.id, id))
    .limit(1);
  return rows[0] ?? null;
}

export async function createAgentConfig(
  userId: string,
  name: string,
  data: Record<string, unknown>,
) {
  const values: Record<string, unknown> = { userId, name };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      const val = data[field];
      if (field === "permission" || field === "knowledge") {
        values[field] = val != null ? JSON.stringify(val) : null;
      } else {
        values[field] = val;
      }
    }
  }
  await db.insert(agentConfig).values(values as typeof agentConfig.$inferInsert);
}

export async function updateAgentConfig(
  userId: string,
  name: string,
  data: Record<string, unknown>,
) {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const field of AGENT_SETTABLE_FIELDS) {
    if (data[field] !== undefined) {
      const val = data[field];
      if (field === "permission" || field === "knowledge") {
        set[field] = val != null ? JSON.stringify(val) : null;
      } else {
        set[field] = val;
      }
    }
  }
  await db.update(agentConfig).set(set)
    .where(and(eq(agentConfig.userId, userId), eq(agentConfig.name, name)));
}

export async function deleteAgentConfig(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(agentConfig)
    .where(and(eq(agentConfig.userId, userId), eq(agentConfig.name, name)))
    .returning({ id: agentConfig.id });
  return result.length > 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/config/agent-config.ts
git commit -m "refactor: 从 config-pg.ts 提取 AgentConfig 子域为独立文件"
```

---

### Task 4: 提取 McpServer 子域

**Files:**
- Create: `src/services/config/mcp-server.ts`

- [ ] **Step 1: 创建 mcp-server.ts**

创建 `src/services/config/mcp-server.ts`，内容为 `config-pg.ts` 第 229-280 行：

```typescript
import { db } from "../../db";
import { mcpServer } from "../../db/schema";
import { eq, and } from "drizzle-orm";

// ────────────────────────────────────────────
// MCP Server 操作
// ────────────────────────────────────────────

export async function listMcpServers(userId: string) {
  return db.select().from(mcpServer)
    .where(eq(mcpServer.userId, userId));
}

export async function getMcpServer(userId: string, name: string) {
  const rows = await db.select().from(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .limit(1);
  return rows[0] ?? null;
}

export async function createMcpServer(
  userId: string,
  name: string,
  type: string,
  config: Record<string, unknown>,
) {
  await db.insert(mcpServer).values({
    userId,
    name,
    type,
    config: JSON.stringify(config),
  });
}

export async function updateMcpServer(
  userId: string,
  name: string,
  config: Record<string, unknown>,
) {
  await db.update(mcpServer)
    .set({ config: JSON.stringify(config), updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}

export async function deleteMcpServer(userId: string, name: string): Promise<boolean> {
  const result = await db.delete(mcpServer)
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)))
    .returning({ id: mcpServer.id });
  return result.length > 0;
}

export async function setMcpServerEnabled(userId: string, name: string, enabled: boolean) {
  await db.update(mcpServer)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(mcpServer.userId, userId), eq(mcpServer.name, name)));
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/config/mcp-server.ts
git commit -m "refactor: 从 config-pg.ts 提取 McpServer 子域为独立文件"
```

---

### Task 5: 提取 Skill 元数据子域

**Files:**
- Create: `src/services/config/skill.ts`

- [ ] **Step 1: 创建 skill.ts**

创建 `src/services/config/skill.ts`，内容为 `config-pg.ts` 第 286-392 行。注意这是 **Skill 的 PG 元数据操作**，不是文件系统操作（文件系统操作留在 `services/skill.ts`）：

```typescript
import { db } from "../../db";
import { skill } from "../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// Skill 元数据操作（PG 表）
// ────────────────────────────────────────────

export async function listSkills(userId: string, agentConfigId?: string | null) {
  if (agentConfigId) {
    return db.select().from(skill)
      .where(and(
        eq(skill.userId, userId),
        isNull(skill.environmentId),
        sql`(${skill.agentConfigId} IS NULL OR ${skill.agentConfigId} = ${agentConfigId})`,
      ));
  }
  return db.select().from(skill)
    .where(and(eq(skill.userId, userId), isNull(skill.environmentId)));
}

export async function listWorkspaceSkills(userId: string, environmentId: string) {
  return db.select().from(skill)
    .where(and(eq(skill.userId, userId), eq(skill.environmentId, environmentId)));
}

export async function getSkill(userId: string, name: string, environmentId?: string | null) {
  const conditions = environmentId
    ? and(eq(skill.userId, userId), eq(skill.name, name), eq(skill.environmentId, environmentId))
    : and(eq(skill.userId, userId), eq(skill.name, name), isNull(skill.environmentId));

  const rows = await db.select().from(skill)
    .where(conditions)
    .limit(1);
  return rows[0] ?? null;
}

export async function upsertSkill(
  userId: string,
  name: string,
  data: {
    description?: string;
    contentPath?: string;
    metadata?: Record<string, unknown>;
    enabled?: boolean;
    environmentId?: string | null;
    agentConfigId?: string | null;
  },
) {
  const envId = data.environmentId ?? null;
  const conditions = envId
    ? and(eq(skill.userId, userId), eq(skill.name, name), eq(skill.environmentId, envId))
    : and(eq(skill.userId, userId), eq(skill.name, name), isNull(skill.environmentId));

  const existing = await db.select({ id: skill.id }).from(skill)
    .where(conditions)
    .limit(1);

  const values = {
    description: data.description,
    contentPath: data.contentPath,
    metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
    enabled: data.enabled,
    agentConfigId: data.agentConfigId ?? null,
    updatedAt: new Date(),
  };

  if (existing.length > 0) {
    await db.update(skill).set(values)
      .where(eq(skill.id, existing[0].id));
    return existing[0].id;
  }

  const inserted = await db.insert(skill).values({
    userId,
    environmentId: envId,
    agentConfigId: data.agentConfigId ?? null,
    name,
    description: data.description,
    contentPath: data.contentPath,
    metadata: data.metadata ? JSON.stringify(data.metadata) : undefined,
    enabled: data.enabled ?? true,
  }).returning({ id: skill.id });
  return inserted[0].id;
}

export async function deleteSkill(
  userId: string,
  name: string,
  environmentId?: string | null,
): Promise<boolean> {
  const conditions = environmentId
    ? and(eq(skill.userId, userId), eq(skill.name, name), eq(skill.environmentId, environmentId))
    : and(eq(skill.userId, userId), eq(skill.name, name), isNull(skill.environmentId));

  const result = await db.delete(skill).where(conditions).returning({ id: skill.id });
  return result.length > 0;
}

export async function enableSkill(userId: string, name: string): Promise<boolean> {
  const result = await db.update(skill)
    .set({ enabled: true, updatedAt: new Date() })
    .where(and(eq(skill.userId, userId), eq(skill.name, name)))
    .returning({ id: skill.id });
  return result.length > 0;
}

export async function disableSkill(userId: string, name: string): Promise<boolean> {
  const result = await db.update(skill)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(skill.userId, userId), eq(skill.name, name)))
    .returning({ id: skill.id });
  return result.length > 0;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/config/skill.ts
git commit -m "refactor: 从 config-pg.ts 提取 Skill 元数据子域为独立文件"
```

---

### Task 6: 提取 UserConfig 子域

**Files:**
- Create: `src/services/config/user-config.ts`

- [ ] **Step 1: 创建 user-config.ts**

创建 `src/services/config/user-config.ts`，内容为 `config-pg.ts` 第 394-443 行：

```typescript
import { db } from "../../db";
import { userConfig } from "../../db/schema";
import { eq } from "drizzle-orm";

// ────────────────────────────────────────────
// UserConfig 操作
// ────────────────────────────────────────────

export interface UserConfigData {
  defaultAgent?: string | null;
  currentModel?: string | null;
  smallModel?: string | null;
  permission?: unknown;
}

export async function getUserConfig(userId: string): Promise<UserConfigData> {
  const rows = await db.select().from(userConfig)
    .where(eq(userConfig.userId, userId))
    .limit(1);
  if (rows.length === 0) {
    return { defaultAgent: null, currentModel: null, smallModel: null, permission: null };
  }
  const r = rows[0];
  return {
    defaultAgent: r.defaultAgent,
    currentModel: r.currentModel,
    smallModel: r.smallModel,
    permission: r.permission,
  };
}

export async function setUserConfig(userId: string, patch: UserConfigData) {
  const values: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.defaultAgent !== undefined) values.defaultAgent = patch.defaultAgent;
  if (patch.currentModel !== undefined) values.currentModel = patch.currentModel;
  if (patch.smallModel !== undefined) values.smallModel = patch.smallModel;
  if (patch.permission !== undefined) {
    values.permission = patch.permission != null ? JSON.stringify(patch.permission) : null;
  }

  const existing = await db.select({ userId: userConfig.userId }).from(userConfig)
    .where(eq(userConfig.userId, userId))
    .limit(1);

  if (existing.length > 0) {
    await db.update(userConfig).set(values)
      .where(eq(userConfig.userId, userId));
  } else {
    await db.insert(userConfig).values({
      userId,
      ...values,
    } as typeof userConfig.$inferInsert);
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/services/config/user-config.ts
git commit -m "refactor: 从 config-pg.ts 提取 UserConfig 子域为独立文件"
```

---

### Task 7: 创建聚合文件和桶文件

**Files:**
- Create: `src/services/config/aggregate.ts`
- Create: `src/services/config/index.ts`

- [ ] **Step 1: 创建 aggregate.ts**

`getAgentFullConfig` 是唯一跨子域的函数，需要显式依赖各子域：

```typescript
import { db } from "../../db";
import { agentConfig, provider, skill, mcpServer } from "../../db/schema";
import { eq, and, isNull, sql } from "drizzle-orm";

// ────────────────────────────────────────────
// 批量配置读取（spawn 时一次性获取 Agent 完整配置）
// ────────────────────────────────────────────

export interface AgentFullConfig {
  agentConfig: typeof agentConfig.$inferSelect | null;
  providers: (typeof provider.$inferSelect)[];
  skills: (typeof skill.$inferSelect)[];
  mcpServers: (typeof mcpServer.$inferSelect)[];
}

export async function getAgentFullConfig(userId: string, agentConfigId: string): Promise<AgentFullConfig> {
  const [ac] = await db.select().from(agentConfig)
    .where(and(eq(agentConfig.id, agentConfigId), eq(agentConfig.userId, userId)))
    .limit(1);

  if (!ac) {
    return { agentConfig: null, providers: [], skills: [], mcpServers: [] };
  }

  const [providers, skills, mcpServers] = await Promise.all([
    db.select().from(provider).where(eq(provider.userId, userId)),
    db.select().from(skill).where(and(
      eq(skill.userId, userId),
      isNull(skill.environmentId),
      sql`(${skill.agentConfigId} IS NULL OR ${skill.agentConfigId} = ${agentConfigId})`,
    )),
    db.select().from(mcpServer).where(and(eq(mcpServer.userId, userId), eq(mcpServer.enabled, true))),
  ]);

  return { agentConfig: ac, providers, skills, mcpServers };
}
```

- [ ] **Step 2: 创建 index.ts 桶文件**

```typescript
// Provider
export { listProviders, getProvider, upsertProvider, deleteProvider } from "./provider";

// Model
export { addModel, updateModel, removeModel } from "./model";

// AgentConfig
export {
  AGENT_SETTABLE_FIELDS,
  listAgentConfigs,
  getAgentConfig,
  getAgentConfigById,
  createAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,
} from "./agent-config";

// McpServer
export {
  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,
} from "./mcp-server";

// Skill (元数据)
export {
  listSkills,
  listWorkspaceSkills,
  getSkill,
  upsertSkill,
  deleteSkill,
  enableSkill,
  disableSkill,
} from "./skill";

// UserConfig
export { getUserConfig, setUserConfig } from "./user-config";
export type { UserConfigData } from "./user-config";

// 聚合
export { getAgentFullConfig } from "./aggregate";
export type { AgentFullConfig } from "./aggregate";
```

- [ ] **Step 3: Commit**

```bash
git add src/services/config/aggregate.ts src/services/config/index.ts
git commit -m "refactor: 创建 config 子域聚合文件和桶文件"
```

---

### Task 8: 将 config-pg.ts 改为桶文件

**Files:**
- Modify: `src/services/config-pg.ts`

- [ ] **Step 1: 替换 config-pg.ts 内容**

将 `src/services/config-pg.ts` 的全部内容替换为：

```typescript
// config-pg.ts 现在是桶文件，所有实现已迁移到 src/services/config/ 目录。
// 保持此文件以兼容现有 import 路径（如 import * as configPg from "./config-pg"）。

export {
  listProviders,
  getProvider,
  upsertProvider,
  deleteProvider,

  addModel,
  updateModel,
  removeModel,

  AGENT_SETTABLE_FIELDS,
  listAgentConfigs,
  getAgentConfig,
  getAgentConfigById,
  createAgentConfig,
  updateAgentConfig,
  deleteAgentConfig,

  listMcpServers,
  getMcpServer,
  createMcpServer,
  updateMcpServer,
  deleteMcpServer,
  setMcpServerEnabled,

  listSkills,
  listWorkspaceSkills,
  getSkill,
  upsertSkill,
  deleteSkill,
  enableSkill,
  disableSkill,

  getUserConfig,
  setUserConfig,

  getAgentFullConfig,
} from "./config";

export type { UserConfigData, AgentFullConfig } from "./config";
```

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: 无错误 — 所有现有 `import * as configPg from "./config-pg"` 或具名导入继续工作。

- [ ] **Step 3: 运行全量测试**

Run: `bun test src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/config-pg.ts
git commit -m "refactor: config-pg.ts 改为桶文件，实现迁移到 config/ 子域目录"
```

---

### Task 9: 更新直接导入子域的调用者（可选优化）

**Files:**
- Modify: `src/services/skill.ts`（将 `import * as configPg from "./config-pg"` 改为直接导入 `./config/skill`）
- Modify: `src/routes/web/config/*.ts`（将 config 路由改为直接导入对应子域）
- Modify: `src/services/launch-spec-builder.ts`（如果它使用 getAgentFullConfig）

- [ ] **Step 1: 更新 skill.ts 的导入**

将 `src/services/skill.ts` 第 6 行：

```typescript
import * as configPg from "./config-pg";
```

替换为：

```typescript
import * as configPg from "./config/skill";
```

注意：`skill.ts` 中的 `configPg.listSkills`、`configPg.getSkill`、`configPg.upsertSkill`、`configPg.deleteSkill`、`configPg.enableSkill`、`configPg.disableSkill` 都来自 `config/skill.ts`，所以这个替换是安全的。

- [ ] **Step 2: 搜索并更新其他直接使用 config-pg 的文件**

Run: `grep -rn "from.*config-pg" src/`

对每个匹配的文件，判断它使用了哪些函数，将导入路径改为对应的子域文件。例如：
- 只用 Provider 函数的 → `from "./config/provider"` 或 `from "../../services/config/provider"`
- 只用 AgentConfig 函数的 → `from "./config/agent-config"`
- 用 getAgentFullConfig 的 → `from "./config/aggregate"`
- 用多个子域的 → 保持 `from "./config-pg"` 或 `from "./config"`

- [ ] **Step 3: 运行全量测试**

Run: `bun test src/__tests__/`
Expected: 全部 PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/skill.ts src/routes/web/config/ src/services/launch-spec-builder.ts
git commit -m "refactor: config 调用者改为直接导入子域文件，消除对桶文件的间接依赖"
```

---

### Task 10: 最终验证

- [ ] **Step 1: 确认 config-pg.ts 只有重新导出**

Run: `wc -l src/services/config-pg.ts`
Expected: ~40 行（只有 export 语句）

- [ ] **Step 2: 确认每个子域文件行数合理**

Run: `wc -l src/services/config/*.ts`
Expected: 每个文件 50-120 行，总计约等于原 config-pg.ts 的 477 行

- [ ] **Step 3: 类型检查和全量测试**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 零错误，全部 PASS
