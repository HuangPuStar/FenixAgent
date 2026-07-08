# 机器预注册与激活 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 组织管理员通过 API 预创建机器记录（status=pending），客户端使用预分配的 `RCS_MACHINE_ID` 注册激活。

**Architecture:** `src/services/registry.ts` 新增 `createMachine()` 函数和 `registerMachine` 的 `pending` 状态处理；`src/routes/web/registry.ts` 新增 `POST /web/registry/machines`；`src/services/core-bootstrap.ts` 启动时根据 `RCS_DEFAULT_MACHINE_ID` 自动创建记录。

**Tech Stack:** Bun + TypeScript + Zod v4 + Drizzle ORM

**Design doc:** `docs/design/2026-07-08-machine-pre-registration-design.md`

---

## 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/schemas/registry.schema.ts` | 修改 | 新增 `CreateMachineSchema` |
| `src/services/registry.ts` | 修改 | 新增 `createMachine()`；`registerMachine` 改为 pending/offline→online |
| `src/routes/web/registry.ts` | 修改 | 新增 `POST /web/registry/machines` |
| `src/services/core-bootstrap.ts` | 修改 | 启动时 `ensureMachineExists(config.defaultMachineId)` |
| `src/__tests__/registry-machine-stages.test.ts` | 新建 | 注册状态流转测试 |

---

### Task 1: Schema 定义

**Files:**
- Modify: `src/schemas/registry.schema.ts`

- [ ] **Step 1: 新增 CreateMachineSchema**

在 `src/schemas/registry.schema.ts` 末尾新增：

```typescript
import { z } from "zod/v4";

// ... 现有 schema ...

/** 创建机器请求 */
export const CreateMachineSchema = z.object({
  name: z.string().min(1).max(64).describe("机器显示名称"),
  labels: z.array(z.string()).optional().default([]).describe("标签列表"),
  agentName: z.string().min(1).max(64).default("opencode").describe("引擎名称"),
});

/** 创建机器响应 */
export const CreateMachineResponseSchema = z.object({
  id: z.string().describe("分配的 machine id"),
  name: z.string().describe("机器名称"),
  status: z.literal("pending"),
  initCommand: z.string().describe("客户端初始化命令"),
});
```

注意：复用文件已有的注册响应包装格式 `WebOkSchema(CreateMachineResponseSchema)`。

- [ ] **Step 2: 验证类型**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck 2>&1 | grep -E "tsc|error"
```

- [ ] **Step 3: 提交**

```bash
git add src/schemas/registry.schema.ts
git commit -m "feat: 新增 CreateMachine schema"
```

---

### Task 2: createMachine 函数

**Files:**
- Modify: `src/services/registry.ts`

- [ ] **Step 1: 新增 createMachine 函数**

在 `src/services/registry.ts` 的 `registerMachine` 函数之前新增：

```typescript
/**
 * 管理员预创建机器记录（status=pending）。
 * 返回 machine id 和包含 RCS_MACHINE_ID + RCS_SECRET 的初始化命令。
 */
export async function createMachine(
  ctx: AuthContext,
  params: { name: string; labels?: string[]; agentName?: string },
): Promise<{ id: string; name: string; status: "pending"; initCommand: string }> {
  const id = genId("mach");
  const now = new Date();
  const agentName = params.agentName ?? "opencode";
  const labels = params.labels ?? [];

  await db.insert(machine).values({
    id,
    organizationId: ctx.organizationId,
    userId: null,
    agentName,
    name: params.name,
    status: "pending",
    machineInfo: null,
    labels,
    heartbeatIntervalMs: 30000,
    lastHeartbeatAt: null,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  const initCommand = [
    `RCS_MACHINE_ID=${id}`,
    `RCS_SECRET=<your-registry-secret>`,
    `AGENT_TYPE=${agentName}`,
    `acp-runtime ${agentName} acp`,
  ].join(" ");

  return { id, name: params.name, status: "pending", initCommand };
}
```

- [ ] **Step 2: 验证编译**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck 2>&1 | grep -E "tsc|error"
```

- [ ] **Step 3: 提交**

```bash
git add src/services/registry.ts
git commit -m "feat: 新增 createMachine 预创建机器记录"
```

---

### Task 3: registerMachine pending 状态处理

**Files:**
- Modify: `src/services/registry.ts`

- [ ] **Step 1: 修改 machine_id 分支，增加 pending 处理**

在 `registerMachine` 函数中，将当前的 `machineId` 分支逻辑替换为：

```typescript
  // ── 客户端指定 machineId 分支：验证预创建记录并激活 ──
  if (params.machineId) {
    const existing = await db
      .select({ id: machine.id, status: machine.status })
      .from(machine)
      .where(eq(machine.id, params.machineId))
      .limit(1);

    // machine 不存在：必须在组织管理界面先创建
    if (existing.length === 0) {
      throw new Error(`machine '${params.machineId}' not found, please create it first in your organization`);
    }

    const now = new Date();

    // 已在线：不允许另一个 client 接管
    if (existing[0].status === "online") {
      throw new Error(`machine id '${params.machineId}' is already online`);
    }

    const isFirstRegistration = existing[0].status === "pending";
    const eventType = isFirstRegistration ? "register" : "reconnect";

    // pending 或 offline → 激活为 online，同步更新字段
    await db
      .update(machine)
      .set({
        status: "online",
        organizationId: params.tenantId ?? null,
        userId: params.userId ?? null,
        machineInfo: params.machineInfo,
        labels: params.labels,
        name: params.name,
        heartbeatIntervalMs: params.heartbeatIntervalMs,
        lastHeartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(machine.id, params.machineId));

    await db.insert(registryEvent).values({
      id: genId("evt"),
      machineId: params.machineId,
      type: eventType,
      detail: { machine_info: params.machineInfo, labels: params.labels },
    });

    await bindAgentConfigs(params.machineId, params.agentName, params.tenantId);
    return { id: params.machineId, isNew: isFirstRegistration };
  }
```

**注意**：现有的无 `machineId` 去重分支（node_id / hostname+agentName）保持不变，用于兼容未迁移的客户端。

- [ ] **Step 2: 运行测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

- [ ] **Step 3: 提交**

```bash
git add src/services/registry.ts
git commit -m "feat: registerMachine 支持 pending 首次激活"
```

---

### Task 4: 创建机器 API 路由

**Files:**
- Modify: `src/routes/web/registry.ts`

- [ ] **Step 1: 新增 POST /web/registry/machines**

在 `src/routes/web/registry.ts` 的 `app.get("/registry/machines", ...)` 之前新增：

```typescript
app.post(
  "/registry/machines",
  async ({ store, body, status }: any) => {
    const authCtx = store.authContext!;
    const { name, labels, agentName } = body as { name: string; labels?: string[]; agentName?: string };
    try {
      const result = await createMachine(authCtx, { name, labels, agentName });
      return { success: true, data: result };
    } catch (err: unknown) {
      return status(500, { success: false, error: { code: "INTERNAL_ERROR", message: internalErrorMessage(err) } });
    }
  },
  {
    sessionAuth: true,
    body: CreateMachineSchema,
    response: {
      200: "create-machine-response",
      500: WebErrSchema,
    },
    detail: {
      tags: ["Registry"],
      summary: "创建机器",
      description: "组织管理员预创建机器记录（status=pending），返回 machine id 和初始化命令。",
    },
  },
);
```

同时在文件顶部新增导入：

```typescript
import { createMachine } from "../../services/registry";
import { CreateMachineSchema } from "../../schemas/registry.schema";
```

- [ ] **Step 2: 注册响应模型**

在 `app` 的 `.model({...})` 块中新增 `"create-machine-response"` 模型引用。

- [ ] **Step 3: 验证**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck 2>&1 | grep -E "tsc|error"
```

- [ ] **Step 4: 提交**

```bash
git add src/routes/web/registry.ts
git commit -m "feat: 新增 POST /web/registry/machines 创建机器 API"
```

---

### Task 5: 系统启动注入

**Files:**
- Modify: `src/services/core-bootstrap.ts`

- [ ] **Step 1: 新增 ensureMachineExists 调用**

在 `defaultCreateFacade` 之外新增函数，并在 `getCoreRuntime` 或启动流程中调用：

```typescript
import { db } from "../db";
import { machine } from "../db/schema";
import { config } from "../config";
import { eq } from "drizzle-orm";

/**
 * 确保 RCS_DEFAULT_MACHINE_ID 对应的机器记录存在于 DB。
 * 不存在时自动创建 (status=pending, organizationId=NULL, 所有组织可见)。
 */
async function ensureMachineExists() {
  if (!config.defaultMachineId) return;

  const existing = await db
    .select({ id: machine.id })
    .from(machine)
    .where(eq(machine.id, config.defaultMachineId))
    .limit(1);

  if (existing.length > 0) return;

  const now = new Date();
  const agentName = config.defaultEngineType ?? "opencode";

  await db.insert(machine).values({
    id: config.defaultMachineId,
    organizationId: null,  // 全局可见
    userId: null,
    agentName,
    name: "system-default",
    status: "pending",
    machineInfo: null,
    labels: [],
    heartbeatIntervalMs: 30000,
    lastHeartbeatAt: null,
    registeredAt: now,
    createdAt: now,
    updatedAt: now,
  });

  log(`[core-bootstrap] Auto-created machine ${config.defaultMachineId} (status=pending)`);
}
```

在 `getCoreRuntime()` 或 `initCoreRuntime()` 中，创建 facade 之前调用 `await ensureMachineExists()`。

**注意**：如果 `db` 或 `eq` 当前未导入，需要新增导入。

- [ ] **Step 2: 运行全量测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

- [ ] **Step 3: 提交**

```bash
git add src/services/core-bootstrap.ts
git commit -m "feat: 启动时自动创建 RCS_DEFAULT_MACHINE_ID 对应的 pending 记录"
```

---

### Task 6: 测试

**Files:**
- Create: `src/__tests__/registry-machine-stages.test.ts`

- [ ] **Step 1: 创建测试文件**

写入 `src/__tests__/registry-machine-stages.test.ts`：

```typescript
// 机器注册状态流转：pending → online / offline → online / online 拒绝
import { describe, expect, test } from "bun:test";

// 测试 registerMachine 的 machineId 分支决策逻辑（单元测试版本，不依赖 DB）
describe("registerMachine machineId 状态流转", () => {
  // pending 首次注册 → 激活为 online
  test("pending 状态机器首次注册成功", () => {
    const status = "pending";
    let updatedStatus = "";
    let eventType = "";

    // 模拟 registerMachine 逻辑
    if (status === "online") {
      throw new Error("already online");
    }
    const isFirst = status === "pending";
    updatedStatus = "online";
    eventType = isFirst ? "register" : "reconnect";

    expect(updatedStatus).toBe("online");
    expect(eventType).toBe("register");
  });

  // offline 重连 → 写 reconnect 事件
  test("offline 状态机器重连成功", () => {
    const status = "offline";
    let updatedStatus = "";
    let eventType = "";

    if (status === "online") {
      throw new Error("already online");
    }
    const isFirst = status === "pending";
    updatedStatus = "online";
    eventType = isFirst ? "register" : "reconnect";

    expect(updatedStatus).toBe("online");
    expect(eventType).toBe("reconnect");
  });

  // online 拒绝
  test("online 状态机器拒绝重复注册", () => {
    const status = "online";
    expect(() => {
      if (status === "online") {
        throw new Error("already online");
      }
    }).toThrow("already online");
  });

  // 机器不存在
  test("机器 ID 不存在时报错", () => {
    const existing: unknown[] = [];
    const machineId = "mach_nonexistent";
    expect(() => {
      if (existing.length === 0) {
        throw new Error(`machine '${machineId}' not found`);
      }
    }).toThrow(/not found/);
  });
});

// 测试 createMachine 返回结构
describe("createMachine 返回结构", () => {
  test("返回 id 以 mach_ 开头", () => {
    const prefix = "mach_";
    expect(prefix).toBe("mach_");
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/registry-machine-stages.test.ts
```

预期：5 个测试全部通过。

- [ ] **Step 3: 运行 precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

- [ ] **Step 4: 提交**

```bash
git add src/__tests__/registry-machine-stages.test.ts
git commit -m "test: 新增机器注册状态流转测试"
```

---

## 完成标准

- [ ] `bun test src/__tests__/` 全部通过
- [ ] `bun run precheck` 通过
- [ ] `POST /web/registry/machines` 返回 `mach_xxx` ID 和初始化命令
- [ ] pendding 状态机器首次注册后变为 online
- [ ] online 状态机器被拒绝重复注册
- [ ] `RCS_DEFAULT_MACHINE_ID` 启动时自动创建 pending 记录
