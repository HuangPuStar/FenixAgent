# Environment Service 层深化 — 路由业务逻辑下沉

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `web/environments` 路由中的业务逻辑（路径校验、workspace 初始化、Agent 配置解析、auto-start 编排）下沉到 `src/services/environment.ts`，使路由只做参数提取 + 委托。

**Architecture:** 当前 Environment Service 是对 Repository 的 1:1 透传。路由承担了路径安全校验、目录创建、Agent 配置 ID↔Name 双向解析等业务逻辑。重构后将这些逻辑全部集中到 Service 层，路由变成薄壳。Service 抛出自定义错误（ADR-0004），路由通过 Elysia `onError` 统一处理。

**Tech Stack:** Elysia、Drizzle ORM、Zod、Node.js `fs`/`path`

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `src/services/environment.ts` | 新增业务函数：创建/更新 Environment 的完整流程 |
| Modify | `src/routes/web/environments.ts` | 删除内联业务逻辑，改为委托 Service |
| Create | `src/errors.ts` | 自定义错误类（ValidationError、NotFoundError、ConflictError） |
| Modify | `src/services/config-pg.ts` | 确保 `getAgentConfigById` 已导出 |
| Create | `src/__tests__/environment-service.test.ts` | Environment Service 单元测试 |

---

### Task 1: 创建自定义错误类

**Files:**
- Create: `src/errors.ts`

- [ ] **Step 1: 创建错误类文件**

```typescript
// src/errors.ts

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 500,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, "VALIDATION_ERROR", 400);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends AppError {
  constructor(message: string) {
    super(message, "NOT_FOUND", 404);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, "ALREADY_EXISTS", 409);
    this.name = "ConflictError";
  }
}

export class ConfigWriteError extends AppError {
  constructor(message: string) {
    super(message, "CONFIG_WRITE_ERROR", 500);
    this.name = "ConfigWriteError";
  }
}
```

- [ ] **Step 2: 验证文件无语法错误**

Run: `bun run typecheck`
Expected: 无新增类型错误

- [ ] **Step 3: Commit**

```bash
git add src/errors.ts
git commit -m "feat: 添加自定义错误类（AppError/Validation/NotFound/Conflict）"
```

---

### Task 2: 在 Environment Service 中添加路径校验和 workspace 初始化

**Files:**
- Modify: `src/services/environment.ts`

- [ ] **Step 1: 写路径校验的失败测试**

```typescript
// src/__tests__/environment-service.test.ts
import { describe, test, expect } from "bun:test";
import { validateWorkspacePath } from "../services/environment";

describe("validateWorkspacePath", () => {
  test("拒绝非绝对路径", () => {
    expect(validateWorkspacePath("relative/path")).toBe("workspace 路径必须是绝对路径");
  });

  test("拒绝根目录", () => {
    expect(validateWorkspacePath("/")).toContain("系统目录");
  });

  test("拒绝 /etc", () => {
    expect(validateWorkspacePath("/etc")).toContain("系统目录");
  });

  test("拒绝 /usr 子路径", () => {
    expect(validateWorkspacePath("/usr/local/bin")).toContain("系统目录");
  });

  test("接受合法路径", () => {
    expect(validateWorkspacePath("/home/user/project")).toBeNull();
  });

  test("接受 /tmp 子路径", () => {
    expect(validateWorkspacePath("/tmp/my-workspace")).toBeNull();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test src/__tests__/environment-service.test.ts`
Expected: FAIL — `validateWorkspacePath` not exported

- [ ] **Step 3: 在 environment.ts 中实现路径校验**

在 `src/services/environment.ts` 顶部添加路径相关常量和函数，从路由文件中原样提取：

```typescript
import { isAbsolute, resolve } from "node:path";
import { mkdirSync, realpathSync } from "node:fs";

const BLOCKED_PATHS = [
  "/", "/etc", "/usr", "/bin", "/sbin", "/var", "/sys", "/proc",
  "/dev", "/boot", "/lib", "/root",
];

export function validateWorkspacePath(p: string): string | null {
  if (!isAbsolute(p)) return "workspace 路径必须是绝对路径";
  const normalized = resolve(p);
  if (BLOCKED_PATHS.includes(normalized))
    return `不允许使用系统目录: ${normalized}`;
  for (const blocked of BLOCKED_PATHS) {
    if (blocked !== "/" && normalized.startsWith(blocked + "/")) {
      return `不允许使用系统目录下的路径: ${normalized}`;
    }
  }
  return null;
}

export function ensureWorkspaceDir(workspacePath: string): string {
  mkdirSync(workspacePath, { recursive: true });
  return realpathSync(workspacePath);
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/environment-service.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/environment.ts src/__tests__/environment-service.test.ts
git commit -m "feat: Environment Service 添加路径校验和 workspace 初始化"
```

---

### Task 3: 添加 createWebEnvironment 函数

**Files:**
- Modify: `src/services/environment.ts`
- Modify: `src/__tests__/environment-service.test.ts`

- [ ] **Step 1: 写 createWebEnvironment 的失败测试**

在 `src/__tests__/environment-service.test.ts` 底部追加：

```typescript
import { randomBytes } from "node:crypto";

// Mock config-pg
const mockGetAgentConfigById = bun.mock.module("../services/config-pg", () => ({
  getAgentConfigById: async (id: string) => id === "agent-1" ? { id: "agent-1", name: "test-agent" } : null,
  getAgentConfig: async (userId: string, name: string) => name === "test-agent" ? { id: "agent-1", name: "test-agent" } : null,
}));

describe("createWebEnvironment 参数校验", () => {
  test("缺少 name 时抛出 ValidationError", async () => {
    const { createWebEnvironment } = await import("../services/environment");
    expect(createWebEnvironment({ userId: "u1", workspacePath: "/tmp/test", name: "" })).rejects.toThrow("name");
  });

  test("name 不符合 kebab-case 时抛出 ValidationError", async () => {
    const { createWebEnvironment } = await import("../services/environment");
    expect(createWebEnvironment({ userId: "u1", workspacePath: "/tmp/test", name: "INVALID" })).rejects.toThrow();
  });

  test("路径不合法时抛出 ValidationError", async () => {
    const { createWebEnvironment } = await import("../services/environment");
    expect(createWebEnvironment({ userId: "u1", workspacePath: "/etc", name: "my-env" })).rejects.toThrow("系统目录");
  });
});
```

> **注意：** 实际 mock 方式取决于 bun test 的模块隔离。如果 `mock.module` 在测试文件中不可靠，改为直接测试纯函数 `validateWorkspacePath` 即可，集成测试留给路由层。核心目标是确保路径校验逻辑在 Service 层可被独立调用。

- [ ] **Step 2: 实现 createWebEnvironment**

在 `src/services/environment.ts` 中添加：

```typescript
import { AppError, ValidationError, NotFoundError, ConflictError, ConfigWriteError } from "../errors";
import * as configPg from "./config-pg";

function generateEnvSecret(): string {
  return `env_secret_${randomBytes(24).toString("hex")}`;
}

const KEBAB_CASE_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

export interface CreateWebEnvironmentParams {
  name: string;
  description?: string;
  agentName?: string;
  agentConfigId?: string;
  workspacePath: string;
  autoStart?: boolean;
  userId: string;
}

export async function createWebEnvironment(params: CreateWebEnvironmentParams) {
  const { name, description, autoStart, userId } = params;
  let { workspacePath } = params;

  // 名称校验
  if (!name || !KEBAB_CASE_RE.test(name)) {
    throw new ValidationError("name 必须为 kebab-case 格式（小写字母、数字、连字符）");
  }

  // 路径校验
  const pathError = validateWorkspacePath(workspacePath);
  if (pathError) throw new ValidationError(pathError);

  // Agent 配置解析
  let resolvedAgentName = params.agentName ?? null;
  let resolvedAgentConfigId = params.agentConfigId ?? null;

  if (params.agentConfigId) {
    const agent = await configPg.getAgentConfigById(params.agentConfigId);
    if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
    resolvedAgentName = agent.name;
  } else if (params.agentName) {
    const agent = await configPg.getAgentConfig(userId, params.agentName);
    if (!agent) throw new ValidationError(`Agent '${params.agentName}' 不存在`);
    resolvedAgentConfigId = agent.id;
  }

  // workspace 目录初始化
  try {
    workspacePath = ensureWorkspaceDir(workspacePath);
  } catch (err: any) {
    throw new ConfigWriteError(`无法创建目录: ${err.message}`);
  }

  // 创建记录
  const secret = generateEnvSecret();
  let record;
  try {
    record = await environmentRepo.create({
      name,
      description,
      workspacePath,
      agentName: resolvedAgentName,
      status: "idle",
      secret,
      userId,
      autoStart: autoStart === true,
      agentConfigId: resolvedAgentConfigId,
    });
  } catch (err: any) {
    if (err.message?.includes("unique") || err.message?.includes("duplicate") || err.message?.includes("UNIQUE")) {
      throw new ConflictError(`环境名称 '${name}' 已存在`);
    }
    throw err;
  }

  return record;
}
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 4: Commit**

```bash
git add src/services/environment.ts
git commit -m "feat: Environment Service 添加 createWebEnvironment 业务函数"
```

---

### Task 4: 添加 updateWebEnvironment 和 ownership 检查

**Files:**
- Modify: `src/services/environment.ts`

- [ ] **Step 1: 实现 getOwnedEnvironment 和 updateWebEnvironment**

```typescript
export interface UpdateWebEnvironmentParams {
  name?: string;
  description?: string | null;
  workspacePath?: string;
  agentName?: string | null;
  agentConfigId?: string | null;
  autoStart?: boolean;
}

/** 获取 Environment 并验证归属，未找到或不属于该用户时抛出 NotFoundError */
export async function getOwnedEnvironment(envId: string, userId: string) {
  const env = await environmentRepo.getById(envId);
  if (!env || env.userId !== userId) {
    throw new NotFoundError("环境不存在");
  }
  return env;
}

export async function updateWebEnvironment(envId: string, userId: string, params: UpdateWebEnvironmentParams) {
  const env = await getOwnedEnvironment(envId, userId);
  const patch: Record<string, unknown> = {};

  if (params.name !== undefined) {
    if (!KEBAB_CASE_RE.test(params.name)) {
      throw new ValidationError("name 必须为 kebab-case 格式");
    }
    patch.name = params.name;
  }
  if (params.workspacePath !== undefined) {
    const pathError = validateWorkspacePath(params.workspacePath);
    if (pathError) throw new ValidationError(pathError);
    patch.workspacePath = ensureWorkspaceDir(params.workspacePath);
  }
  if (params.agentConfigId !== undefined) {
    if (params.agentConfigId) {
      const agent = await configPg.getAgentConfigById(params.agentConfigId);
      if (!agent) throw new ValidationError(`AgentConfig '${params.agentConfigId}' 不存在`);
      patch.agentConfigId = params.agentConfigId;
      patch.agentName = agent.name;
    } else {
      patch.agentConfigId = null;
    }
  } else if (params.agentName !== undefined) {
    if (params.agentName) {
      const agent = await configPg.getAgentConfig(userId, params.agentName);
      if (!agent) throw new ValidationError(`Agent '${params.agentName}' 不存在`);
      patch.agentConfigId = agent.id;
    }
    patch.agentName = params.agentName ?? null;
  }
  if (params.description !== undefined) {
    patch.description = params.description;
  }
  if (params.autoStart !== undefined) {
    patch.autoStart = !!params.autoStart;
  }

  await environmentRepo.update(envId, patch);
  return environmentRepo.getById(envId);
}
```

- [ ] **Step 2: 运行类型检查**

Run: `bun run typecheck`
Expected: 无新增错误

- [ ] **Step 3: Commit**

```bash
git add src/services/environment.ts
git commit -m "feat: Environment Service 添加 updateWebEnvironment 和 ownership 检查"
```

---

### Task 5: 重构路由使用新 Service 函数

**Files:**
- Modify: `src/routes/web/environments.ts`

- [ ] **Step 1: 替换 POST /environments 路由**

将路由文件中的内联逻辑替换为 Service 调用。新路由处理器：

```typescript
import {
  createWebEnvironment,
  updateWebEnvironment,
  getOwnedEnvironment,
  deleteEnvironment,
  sanitizeResponse,
} from "../../services/environment";
// 删除: validateWorkspacePath, generateEnvSecret, sanitizeResponse 从路由本地
// 删除: import { mkdirSync, realpathSync } from "node:fs";
// 删除: import { isAbsolute, resolve } from "node:path";
// 删除: import { randomBytes } from "node:crypto";
// 删除: import * as configPg from "../../services/config-pg";
```

> **注意：** `sanitizeResponse` 需要先从路由移动到 Service 中导出。在 environment.ts 底部添加：

```typescript
export function sanitizeResponse(row: EnvironmentRecord) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    workspace_path: row.workspacePath,
    agent_name: row.agentName ?? null,
    agent_config_id: (row as any).agentConfigId ?? null,
    status: row.status,
    machine_name: row.machineName ?? null,
    branch: row.branch ?? null,
    auto_start: row.autoStart ?? false,
    last_poll_at: row.lastPollAt
      ? Math.floor(new Date(row.lastPollAt).getTime() / 1000)
      : null,
    created_at: Math.floor(new Date(row.createdAt).getTime() / 1000),
    updated_at: Math.floor(new Date(row.updatedAt).getTime() / 1000),
  };
}
```

POST `/environments` 路由变为：

```typescript
app.post("/environments", async ({ store, body, error }) => {
  const user = store.user!;
  const b = body as { name: string; description?: string; agentName?: string; agentConfigId?: string; autoStart?: boolean; workspacePath: string };

  let record;
  try {
    record = await createWebEnvironment({
      name: b.name,
      description: b.description,
      agentName: b.agentName,
      agentConfigId: b.agentConfigId,
      workspacePath: b.workspacePath,
      autoStart: b.autoStart,
      userId: user.id,
    });
  } catch (err: any) {
    if (err.statusCode) return error(err.statusCode, { error: { type: err.code, message: err.message } });
    throw err;
  }

  if (b.autoStart && record.userId) {
    spawnInstanceFromEnvironment(record.userId, record.id)
      .then(() => console.log(`[RCS] Auto-started instance for new environment: ${record.name}`))
      .catch((err: any) => console.error(`[RCS] Failed to auto-start instance for ${record.name}: ${err.message}`));
  }

  return { ...sanitizeResponse(record), secret: record.secret };
}, { sessionAuth: true, body: "create-environment-request" });
```

- [ ] **Step 2: 替换 PUT /environments/:id 路由**

```typescript
app.put("/environments/:id", async ({ store, params, body, error }) => {
  const user = store.user!;
  const b = body as { name?: string; description?: string | null; workspacePath?: string; agentName?: string | null; agentConfigId?: string | null; autoStart?: boolean };

  try {
    const updated = await updateWebEnvironment(params.id, user.id, {
      name: b.name,
      description: b.description,
      workspacePath: b.workspacePath,
      agentName: b.agentName,
      agentConfigId: b.agentConfigId,
      autoStart: b.autoStart,
    });
    return sanitizeResponse(updated!);
  } catch (err: any) {
    if (err.statusCode) return error(err.statusCode, { error: { type: err.code, message: err.message } });
    throw err;
  }
}, { sessionAuth: true, body: "update-environment-request" });
```

- [ ] **Step 3: 替换 GET/DELETE 路由中的 ownership 检查**

```typescript
app.get("/environments/:id", async ({ store, params, error }) => {
  const user = store.user!;
  try {
    const env = await getOwnedEnvironment(params.id, user.id);
    return { ...sanitizeResponse(env), secret: env.secret };
  } catch (err: any) {
    if (err.statusCode) return error(err.statusCode, { error: { type: err.code, message: err.message } });
    throw err;
  }
}, { sessionAuth: true });

app.delete("/environments/:id", async ({ store, params, error }) => {
  const user = store.user!;
  try {
    await getOwnedEnvironment(params.id, user.id);
    await deleteEnvironment(params.id);
    return { ok: true as const };
  } catch (err: any) {
    if (err.statusCode) return error(err.statusCode, { error: { type: err.code, message: err.message } });
    throw err;
  }
}, { sessionAuth: true });
```

- [ ] **Step 4: 删除路由中不再使用的本地函数和 import**

删除以下路由本地定义：
- `generateEnvSecret()`
- `BLOCKED_PATHS` 常量
- `validateWorkspacePath()` 函数
- `sanitizeResponse()` 函数（已移到 Service）

删除以下 import：
- `mkdirSync, realpathSync` from `node:fs`
- `isAbsolute, resolve` from `node:path`
- `randomBytes` from `node:crypto`
- `environmentRepo` from `../../repositories`（如果路由中不再直接使用）
- `configPg` import

- [ ] **Step 5: 运行类型检查和已有测试**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 通过

- [ ] **Step 6: Commit**

```bash
git add src/routes/web/environments.ts src/services/environment.ts
git commit -m "refactor: web/environments 路由业务逻辑下沉到 Service 层"
```

---

### Task 6: 将 Elysia onError 接入自定义错误类

**Files:**
- Modify: `src/plugins/error-handler.ts`（如果存在）或 `src/index.ts` 中的 onError hook

- [ ] **Step 1: 在全局 onError 中处理 AppError**

确保 Elysia 全局 `onError` handler 能识别 `AppError` 并自动转换为正确的 HTTP 响应：

```typescript
import { AppError } from "../errors";

// 在 onError handler 中添加:
.onError(({ error: err }) => {
  if (err instanceof AppError) {
    return new Response(JSON.stringify({
      error: { type: err.code, message: err.message },
    }), {
      status: err.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  }
  // ... 现有错误处理逻辑
})
```

- [ ] **Step 2: 简化路由中的 try-catch**

现在路由可以进一步简化，不再需要手动 `if (err.statusCode) return error(...)` — 全局 onError 自动处理：

```typescript
app.post("/environments", async ({ store, body }) => {
  const user = store.user!;
  const b = body as CreateEnvironmentRequest;
  const record = await createWebEnvironment({ ...b, userId: user.id });

  if (b.autoStart && record.userId) {
    spawnInstanceFromEnvironment(record.userId, record.id)
      .then(() => console.log(`[RCS] Auto-started: ${record.name}`))
      .catch((e) => console.error(`[RCS] Auto-start failed: ${e.message}`));
  }

  return { ...sanitizeResponse(record), secret: record.secret };
}, { sessionAuth: true, body: "create-environment-request" });
```

- [ ] **Step 3: 运行全量测试**

Run: `bun run typecheck && bun test src/__tests__/`
Expected: 通过

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: Elysia onError 接入 AppError，简化路由 try-catch"
```

---

## Self-Review

**Spec coverage:** Environment 创建（路径校验、Agent 解析、目录创建、唯一性检查）、更新（同上）、ownership 检查、删除 — 全部覆盖。

**Placeholder scan:** 无 TBD/TODO，所有代码步骤包含完整实现。

**Type consistency:** `CreateWebEnvironmentParams`、`UpdateWebEnvironmentParams`、`AppError` 等类型在 Task 1-4 中定义，Task 5-6 消费时名称一致。`sanitizeResponse` 从路由移到 Service 后签名不变。
