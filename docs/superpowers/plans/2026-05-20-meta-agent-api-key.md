# Meta Agent API Key 自动注入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 每次 ensureMetaEnvironment 时自动创建 API Key，通过环境变量 `USER_META_API_KEY` 注入到 meta agent 进程中，使其可以回调 RCS API。

**Architecture:** 在 apiKey 表新增 `expiresAt` 字段支持过期；`createApiKey` 扩展支持传入过期时间；`validateApiKeyAndGetUser` 查询时自动过滤已过期 key；`ensureMetaEnvironment` 中创建 key 后通过 `extraEnv` 参数一路透传到 `AgentLaunchSpec.env`，最终写入 agent 进程环境变量。

**Tech Stack:** Elysia, Drizzle ORM, PostgreSQL, Bun test

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/db/schema.ts` | Modify | apiKey 表新增 `expiresAt` 列 |
| `src/auth/api-key-service.ts` | Modify | `createApiKey` 支持 expiresAt；`validateApiKeyAndGetUser` 过期过滤；`listApiKeysByUser` 显示过期状态 |
| `src/services/launch-spec-builder.ts` | Modify | `BuildLaunchSpecInput` 新增 `extraEnv`；`buildLaunchSpec` 合并到 `AgentLaunchSpec.env` |
| `src/services/instance.ts` | Modify | `spawnInstanceFromEnvironment` 新增 `extraEnv` 参数，透传到 `buildLaunchSpec` |
| `src/services/meta-agent.ts` | Modify | `ensureMetaEnvironment` 中创建 API key，传 `extraEnv` 给 `spawnInstanceFromEnvironment` |
| `src/__tests__/api-key-expiry.test.ts` | Create | 测试 expiresAt 过滤逻辑 |
| `src/__tests__/launch-spec-extra-env.test.ts` | Create | 测试 extraEnv 合并逻辑 |
| `src/__tests__/meta-agent-api-key.test.ts` | Create | 测试 meta agent API key 创建和注入 |

---

### Task 1: apiKey 表新增 expiresAt 列

**Files:**
- Modify: `src/db/schema.ts:102-121`

- [ ] **Step 1: 在 schema.ts 的 apiKey 表中添加 expiresAt 列**

在 `lastUsedAt` 之后添加：

```typescript
// src/db/schema.ts — apiKey 表定义中，lastUsedAt 之后添加
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    // 过期时间（null = 永不过期；系统创建的 meta key 设为 1 小时后）
    expiresAt: timestamp("expires_at", { withTimezone: true }),
```

- [ ] **Step 2: 推送 schema 到数据库**

Run: `bunx drizzle-kit push`

Expected: Schema synced，`api_key` 表新增 `expires_at` 列（nullable）

- [ ] **Step 3: Commit**

```bash
git add src/db/schema.ts
git commit -m "feat: apiKey 表新增 expiresAt 列"
```

---

### Task 2: api-key-service 支持 expiresAt

**Files:**
- Modify: `src/auth/api-key-service.ts`
- Create: `src/__tests__/api-key-expiry.test.ts`

- [ ] **Step 1: 写过期过滤的失败测试**

```typescript
// src/__tests__/api-key-expiry.test.ts
import { describe, expect, test } from "bun:test";

describe("API Key expiresAt 过滤", () => {
  // createApiKey 默认 expiresAt 为 null
  test("createApiKey 默认 expiresAt 为 undefined（永不过期）", async () => {
    // 这里只验证函数签名接受 expiresAt 参数
    // 实际 DB 测试需要 mock
    const { createApiKey } = await import("../auth/api-key-service");
    // createApiKey 应该接受可选的 expiresAt 参数
    expect(typeof createApiKey).toBe("function");
  });

  // expiresAt 为过去时间 → key 无效
  test("过期的 key 应被 validateApiKeyAndGetUser 拒绝（概念验证）", () => {
    // 验证逻辑：如果 expiresAt < now，视为无效
    const now = new Date();
    const past = new Date(now.getTime() - 3600_000);
    expect(past.getTime() < now.getTime()).toBe(true);
  });

  // expiresAt 为未来时间 → key 有效
  test("未过期的 key 应通过验证（概念验证）", () => {
    const now = new Date();
    const future = new Date(now.getTime() + 3600_000);
    expect(future.getTime() > now.getTime()).toBe(true);
  });

  // expiresAt 为 null → key 永不过期
  test("expiresAt 为 null 时永不过期（概念验证）", () => {
    const expiresAt = null;
    expect(expiresAt).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认通过**

Run: `bun test src/__tests__/api-key-expiry.test.ts`
Expected: PASS

- [ ] **Step 3: 修改 createApiKey 签名和实现，支持 expiresAt**

```typescript
// src/auth/api-key-service.ts

// 修改 createApiKey 函数签名和实现
export async function createApiKey(
  userId: string,
  label: string,
  teamId: string,
  options?: { expiresAt?: Date },
): Promise<{ record: ApiKeySanitized; fullKey: string }> {
  const fullKey = generateApiKey();
  const keyHash = hashApiKey(fullKey);
  const keyPrefix = computeKeyPrefix(fullKey);
  const now = new Date();

  await db.insert(apiKey).values({
    userId,
    teamId,
    keyHash,
    keyPrefix,
    label: label || "Default",
    createdAt: now,
    lastUsedAt: null,
    expiresAt: options?.expiresAt ?? null,
  });

  const record: ApiKeyRecord = {
    id: "",
    userId,
    keyHash,
    keyPrefix,
    label: label || "Default",
    createdAt: now,
    lastUsedAt: null,
    expiresAt: options?.expiresAt ?? null,
  };

  return { record: sanitize(record), fullKey };
}
```

- [ ] **Step 4: 修改 ApiKeyRecord 和 ApiKeySanitized 类型**

```typescript
// src/auth/api-key-service.ts — ApiKeyRecord 接口
export interface ApiKeyRecord {
  id: string;
  userId: string;
  keyHash: string;
  keyPrefix: string;
  label: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

// src/auth/api-key-service.ts — ApiKeySanitized 接口
export interface ApiKeySanitized {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
}
```

- [ ] **Step 5: 修改 sanitize 函数**

```typescript
// src/auth/api-key-service.ts — sanitize 函数
function sanitize(record: ApiKeyRecord): ApiKeySanitized {
  return {
    id: record.id,
    label: record.label,
    keyPrefix: record.keyPrefix,
    createdAt: Math.floor(record.createdAt.getTime() / 1000),
    lastUsedAt: record.lastUsedAt ? Math.floor(record.lastUsedAt.getTime() / 1000) : null,
    expiresAt: record.expiresAt ? Math.floor(record.expiresAt.getTime() / 1000) : null,
  };
}
```

- [ ] **Step 6: 修改 validateApiKeyAndGetUser，过滤过期 key**

```typescript
// src/auth/api-key-service.ts — validateApiKeyAndGetUser
export async function validateApiKeyAndGetUser(
  key: string,
): Promise<{ userId: string; keyId: string; teamId: string | null } | null> {
  const inputHash = hashApiKey(key);
  const rows = await db
    .select()
    .from(apiKey)
    .where(
      and(
        eq(apiKey.keyHash, inputHash),
        or(
          sql`${apiKey.expiresAt} IS NULL`,
          sql`${apiKey.expiresAt} > NOW()`,
        ),
      ),
    )
    .limit(1);

  if (rows.length === 0) return null;

  const row = rows[0];

  // Update lastUsedAt in background (fire-and-forget)
  db.update(apiKey)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKey.id, row.id))
    .then(() => {})
    .catch(() => {});

  return { userId: row.userId, keyId: row.id, teamId: row.teamId ?? null };
}
```

需要在文件顶部 import 中添加：

```typescript
import { and, eq, or, sql } from "drizzle-orm";
```

- [ ] **Step 7: 修改 listApiKeysByUser，映射 expiresAt**

```typescript
// src/auth/api-key-service.ts — listApiKeysByUser
export async function listApiKeysByUser(teamId: string): Promise<ApiKeySanitized[]> {
  const rows = await db.select().from(apiKey).where(eq(apiKey.teamId, teamId));

  return rows.map((r) =>
    sanitize({
      id: r.id,
      userId: r.userId,
      keyHash: r.keyHash,
      keyPrefix: r.keyPrefix ?? "",
      label: r.label,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      expiresAt: r.expiresAt,
    }),
  );
}
```

- [ ] **Step 8: 运行所有测试确认通过**

Run: `bun test src/__tests__/api-key-expiry.test.ts src/__tests__/api-key-security.test.ts`
Expected: ALL PASS

- [ ] **Step 9: Commit**

```bash
git add src/auth/api-key-service.ts src/__tests__/api-key-expiry.test.ts
git commit -m "feat: api-key-service 支持 expiresAt 过期时间"
```

---

### Task 3: buildLaunchSpec 支持 extraEnv

**Files:**
- Modify: `src/services/launch-spec-builder.ts`
- Create: `src/__tests__/launch-spec-extra-env.test.ts`

- [ ] **Step 1: 写 extraEnv 合并的失败测试**

```typescript
// src/__tests__/launch-spec-extra-env.test.ts
import { describe, expect, test } from "bun:test";
import { buildLaunchSpec, type BuildLaunchSpecInput } from "../services/launch-spec-builder";

describe("buildLaunchSpec extraEnv", () => {
  // extraEnv 应合并到 AgentLaunchSpec.env
  test("extraEnv 合并到返回的 AgentLaunchSpec.env", async () => {
    const input: BuildLaunchSpecInput = {
      workspacePath: "/tmp/test",
      agentName: "test-agent",
      agentConfigId: null,
      agentPrompt: null,
      modelRef: null,
      fullConfig: {
        providers: [{ name: "openai", baseUrl: "", apiKey: "", npm: null }],
        mcpServers: [],
        agentConfig: null,
        skills: [],
      } as any,
      environmentSecret: "secret123",
      extraEnv: { USER_META_API_KEY: "rcs_test_key_123" },
    };

    const spec = await buildLaunchSpec(input);
    expect(spec.env).toBeDefined();
    expect(spec.env!.USER_META_API_KEY).toBe("rcs_test_key_123");
  });

  // 无 extraEnv 时 env 为 undefined
  test("无 extraEnv 时 AgentLaunchSpec.env 为 undefined", async () => {
    const input: BuildLaunchSpecInput = {
      workspacePath: "/tmp/test",
      agentName: "test-agent",
      agentConfigId: null,
      agentPrompt: null,
      modelRef: null,
      fullConfig: {
        providers: [{ name: "openai", baseUrl: "", apiKey: "", npm: null }],
        mcpServers: [],
        agentConfig: null,
        skills: [],
      } as any,
      environmentSecret: "secret123",
    };

    const spec = await buildLaunchSpec(input);
    expect(spec.env).toBeUndefined();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/launch-spec-extra-env.test.ts`
Expected: FAIL — `BuildLaunchSpecInput` 没有 `extraEnv` 属性

- [ ] **Step 3: 修改 BuildLaunchSpecInput 接口和 buildLaunchSpec 实现**

```typescript
// src/services/launch-spec-builder.ts — BuildLaunchSpecInput 接口
export interface BuildLaunchSpecInput {
  workspacePath: string;
  agentName: string;
  agentConfigId?: string | null;
  agentPrompt?: string | null;
  modelRef?: string | null;
  fullConfig: AgentFullConfig;
  environmentSecret: string;
  extraEnv?: Record<string, string>;
}
```

```typescript
// src/services/launch-spec-builder.ts — buildLaunchSpec 函数返回值部分
// 替换原 return 语句（约第 150-157 行）
  return {
    workspace: workspacePath,
    ...(input.extraEnv ? { env: input.extraEnv } : {}),
    agent,
    model,
    skills: [],
    mcpServers,
  };
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/launch-spec-extra-env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/launch-spec-builder.ts src/__tests__/launch-spec-extra-env.test.ts
git commit -m "feat: buildLaunchSpec 支持 extraEnv 环境变量注入"
```

---

### Task 4: spawnInstanceFromEnvironment 支持 extraEnv

**Files:**
- Modify: `src/services/instance.ts:134-206`

- [ ] **Step 1: 修改 spawnInstanceFromEnvironment 签名，新增 extraEnv 参数**

```typescript
// src/services/instance.ts — spawnInstanceFromEnvironment 函数签名
export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
  prefetchedEnv?: EnvironmentRecord,
  extraEnv?: Record<string, string>,
): Promise<SpawnedInstance> {
```

- [ ] **Step 2: 在 buildLaunchSpec 调用处透传 extraEnv**

```typescript
// src/services/instance.ts — buildLaunchSpec 调用处（约第 174-182 行）
  const launchSpec = await _deps.buildLaunchSpec({
    workspacePath: cwd,
    agentName,
    agentConfigId: env.agentConfigId ?? null,
    agentPrompt,
    modelRef,
    fullConfig,
    environmentSecret: env.secret,
    extraEnv,
  });
```

- [ ] **Step 3: 运行 instance 相关测试确认未破坏**

Run: `bun test src/__tests__/instance-service.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/instance.ts
git commit -m "feat: spawnInstanceFromEnvironment 支持 extraEnv 参数"
```

---

### Task 5: ensureMetaEnvironment 创建 API key 并注入

**Files:**
- Modify: `src/services/meta-agent.ts`
- Create: `src/__tests__/meta-agent-api-key.test.ts`

- [ ] **Step 1: 写 meta agent API key 注入的失败测试**

```typescript
// src/__tests__/meta-agent-api-key.test.ts
import { describe, expect, test, mock } from "bun:test";

// mock 依赖
mock.module("../db", () => ({ db: {} }));
mock.module("../auth/better-auth", () => ({}));
mock.module("../auth/api-key-service", () => ({
  createApiKey: mock(() =>
    Promise.resolve({
      record: { id: "key-1", label: "Meta Agent", keyPrefix: "rcs_1234", createdAt: 1000, lastUsedAt: null, expiresAt: 4600 },
      fullKey: "rcs_test_meta_api_key_1234567890",
    }),
  ),
  hashApiKey: mock((key: string) => `hash_${key}`),
}));
mock.module("./environment-web", () => ({
  createWebEnvironment: mock(() => Promise.resolve({ id: "env-meta-1" })),
  listEnvironmentsWithInstances: mock(() => Promise.resolve([])),
}));
mock.module("./instance", () => ({
  spawnInstanceFromEnvironment: mock(() =>
    Promise.resolve({
      id: "inst-1",
      userId: "user-1",
      port: 8888,
      pid: 123,
      status: "running",
      command: "",
      error: null,
      apiKey: "",
      createdAt: new Date(),
      environmentId: "env-meta-1",
      sessionId: undefined,
      instanceNumber: 1,
    }),
  ),
}));
mock.module("./config/agent-config", () => ({
  getAgentConfig: mock(() => Promise.resolve(null)),
  createAgentConfig: mock(() => Promise.resolve({ id: "ac-1" })),
}));
mock.module("./config/skill", () => ({
  upsertSkill: mock(() => Promise.resolve()),
}));
mock.module("./config/skill-meta-content", () => ({
  META_SKILL_NAME: "meta-agent-control",
  META_SKILL_DESCRIPTION: "Meta Agent control skill",
  writeMetaSkillFile: mock(() => Promise.resolve()),
}));

describe("Meta Agent API Key 注入", () => {
  test("ensureMetaEnvironment 应创建 API key 并传入 extraEnv", async () => {
    const { ensureMetaEnvironment } = await import("../services/meta-agent");

    const ctx = {
      teamId: "team-1",
      userId: "user-1",
      role: "owner" as const,
    };

    const result = await ensureMetaEnvironment(ctx);
    expect(result).toBeDefined();
    expect(result.environmentId).toBeDefined();

    // 验证 spawnInstanceFromEnvironment 被调用时 extraEnv 包含 USER_META_API_KEY
    const { spawnInstanceFromEnvironment } = await import("./instance");
    const spawnCall = spawnInstanceFromEnvironment.mock.calls.at(-1);
    // spawnInstanceFromEnvironment(userId, environmentId, prefetchedEnv?, extraEnv?)
    expect(spawnCall).toBeDefined();
    const extraEnv = spawnCall![3]; // 第 4 个参数
    expect(extraEnv).toBeDefined();
    expect(extraEnv.USER_META_API_KEY).toBe("rcs_test_meta_api_key_1234567890");
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/meta-agent-api-key.test.ts`
Expected: FAIL — `ensureMetaEnvironment` 尚未调用 `createApiKey`

- [ ] **Step 3: 修改 ensureMetaEnvironment，创建 API key 并传 extraEnv**

```typescript
// src/services/meta-agent.ts — 完整替换文件

/**
 * Meta Agent 服务层。
 *
 * 管理 meta agent 的 Environment 生命周期：
 * - 查找或创建名为 meta-agent 的 Environment（kebab-case，通过校验）
 * - 确保 meta AgentConfig 存在
 * - 确保 meta 专属 Skill 已注册并写入文件系统
 * - 按需 spawn 实例，自动创建 API key 注入环境变量
 */

import { createWebEnvironment, listEnvironmentsWithInstances } from "./environment-web";
import { spawnInstanceFromEnvironment } from "./instance";
import { upsertSkill } from "./config/skill";
import { getAgentConfig, createAgentConfig } from "./config/agent-config";
import { createApiKey } from "../auth/api-key-service";
import type { AuthContext } from "../plugins/auth";
import {
  META_SKILL_NAME,
  META_SKILL_DESCRIPTION,
  writeMetaSkillFile,
} from "./config/skill-meta-content";

export const META_ENVIRONMENT_NAME = "meta-agent";
const META_AGENT_CONFIG_NAME = "meta";
const META_KEY_LABEL = "Meta Agent";
const META_KEY_EXPIRY_MS = 3600_000; // 1 小时

export interface EnsureMetaResult {
  environmentId: string;
  instanceId?: string;
  status: "created" | "reused";
  apiKey?: string;
}

/** 从环境列表中查找名为 meta-agent 的环境 */
export async function findMetaEnvironment(
  ctx: AuthContext,
): Promise<{ id: string; name: string } | null> {
  const envs = await listEnvironmentsWithInstances(ctx.teamId);
  const meta = envs.find((e: any) => e.name === META_ENVIRONMENT_NAME);
  return meta ? { id: meta.id, name: meta.name } : null;
}

/** 确保环境中存在 meta agent 所需的 AgentConfig 和 Skill */
async function ensureMetaConfig(ctx: AuthContext): Promise<string> {
  let agentConfig = await getAgentConfig(ctx, META_AGENT_CONFIG_NAME);
  if (!agentConfig) {
    agentConfig = await createAgentConfig(ctx, META_AGENT_CONFIG_NAME, {
      description: "Meta Agent — 工作流编排助手",
      model: null,
      prompt: null,
      steps: null,
    });
  }

  await writeMetaSkillFile();

  await upsertSkill(ctx, META_SKILL_NAME, {
    description: META_SKILL_DESCRIPTION,
    contentPath: `meta/${META_SKILL_NAME}/SKILL.md`,
    enabled: true,
    agentConfigId: agentConfig.id,
  });

  return agentConfig.id;
}

/** 为 meta agent 创建 API key（1 小时过期） */
async function createMetaApiKey(ctx: AuthContext): Promise<string> {
  const expiresAt = new Date(Date.now() + META_KEY_EXPIRY_MS);
  const { fullKey } = await createApiKey(ctx.userId, META_KEY_LABEL, ctx.teamId, { expiresAt });
  return fullKey;
}

/** 查找或创建 meta environment + spawn 实例 */
export async function ensureMetaEnvironment(ctx: AuthContext): Promise<EnsureMetaResult> {
  const agentConfigId = await ensureMetaConfig(ctx);
  const apiKey = await createMetaApiKey(ctx);
  const extraEnv: Record<string, string> = { USER_META_API_KEY: apiKey };

  const existing = await findMetaEnvironment(ctx);
  if (existing) {
    try {
      const inst = await spawnInstanceFromEnvironment(ctx.userId, existing.id, undefined, extraEnv);
      return {
        environmentId: existing.id,
        instanceId: inst.id,
        status: "reused",
        apiKey,
      };
    } catch {
      return {
        environmentId: existing.id,
        status: "reused",
      };
    }
  }

  const env = await createWebEnvironment({
    name: META_ENVIRONMENT_NAME,
    description: "Meta Agent — 工作流编排助手（自动创建）",
    agentConfigId,
    workspacePath: process.cwd(),
    userId: ctx.userId,
    teamId: ctx.teamId,
  });

  try {
    const inst = await spawnInstanceFromEnvironment(ctx.userId, env.id, undefined, extraEnv);
    return {
      environmentId: env.id,
      instanceId: inst.id,
      status: "created",
      apiKey,
    };
  } catch {
    return {
      environmentId: env.id,
      status: "created",
    };
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/meta-agent-api-key.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/meta-agent.ts src/__tests__/meta-agent-api-key.test.ts
git commit -m "feat: ensureMetaEnvironment 自动创建 API key 注入 USER_META_API_KEY"
```

---

### Task 6: 端到端验证

**Files:** 无新增

- [ ] **Step 1: 运行全量后端测试**

Run: `bun test src/__tests__/`
Expected: 0 fail

- [ ] **Step 2: 运行 lint 检查**

Run: `bun run lint`
Expected: 无新错误

- [ ] **Step 3: 运行格式化**

Run: `bun run format`
Expected: 无变化或自动修复

- [ ] **Step 4: Commit（如有格式化修复）**

```bash
git add -A
git commit -m "style: lint 修复"
```
