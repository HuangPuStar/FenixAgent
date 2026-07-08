# RCS_MACHINE_ID 固定机器标识 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 客户端通过 `RCS_MACHINE_ID` 环境变量指定注册使用的 machine id，服务端用该 ID 创建或接管 machine 记录，实现固定可引用的机器标识。

**Architecture:** 客户端 `bin.ts` 读取环境变量 → `ServerConfig.machineId` → `buildRegisterMessage` 携带 `machine_id` → WebSocket 传输 → 服务端 `acp-ws-handler.ts` 解析 → `registerMachine` 新增 `machineId` 分支（不存在则 INSERT / offline 则 UPDATE / online 则拒绝）。

**Tech Stack:** Bun + TypeScript

**Design doc:** `docs/design/2026-07-08-rcs-machine-id-design.md`

---

## 文件改动清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `packages/acp-link/src/server.ts` | 修改 | `ServerConfig.machineId` + `buildRegisterMessage` 携带 `machine_id` |
| `packages/acp-runtime-cli/src/bin.ts` | 修改 | 读取 `RCS_MACHINE_ID`，传入 `startServer` |
| `src/transport/acp-ws-handler.ts` | 修改 | 解析 `machine_id`，传入 `registerMachine` |
| `src/services/registry.ts` | 修改 | `registerMachine` 新增 `machineId` 参数和逻辑 |
| `packages/acp-link/src/__tests__/client-mode.test.ts` | 修改 | 新增 `machine_id` 字段测试 |

---

### Task 1: ServerConfig 扩展 + buildRegisterMessage

**Files:**
- Modify: `packages/acp-link/src/server.ts`

- [ ] **Step 1: ServerConfig 新增 `machineId` 字段**

在 `ServerConfig` 接口末尾（`name` 字段之后）新增：

```typescript
  /** 客户端指定的 machine id（可选），用于固定 machine 标识 */
  machineId?: string;
```

完整 `ServerConfig` 结尾类似：

```typescript
export interface ServerConfig {
  port: number;
  host: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  rcsUrl?: string;
  rcsSecret?: string;
  tenantId?: string;
  userId?: string;
  labels?: string[];
  /** Agent 类型：opencode（默认）、ccb、claude-code */
  agentType?: AgentType;
  /** 支持的引擎类型列表，注册时上报给 RCS */
  supportedEngineTypes?: { type: string; cliPath?: string }[];
  /** 用户指定的机器显示名称，可选 */
  name?: string;
  /** 客户端指定的 machine id（可选），用于固定 machine 标识 */
  machineId?: string;
}
```

- [ ] **Step 2: buildRegisterMessage 携带 `machine_id`**

在 `buildRegisterMessage` 函数中，`nodeId` 处理之后（约第 195 行），新增：

```typescript
  // 客户端指定的 machine id，用于固定机器标识
  if (config.machineId) {
    msg.machine_id = config.machineId;
  }
```

放在 `return msg;` 之前。

- [ ] **Step 3: 运行现有测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/acp-link/src/__tests__/client-mode.test.ts
```

预期：现有测试全部通过。

- [ ] **Step 4: 提交**

```bash
git add packages/acp-link/src/server.ts
git commit -m "feat: ServerConfig 新增 machineId 字段，注册消息携带 machine_id"
```

---

### Task 2: bin.ts 读取 RCS_MACHINE_ID

**Files:**
- Modify: `packages/acp-runtime-cli/src/bin.ts`

- [ ] **Step 1: 读取环境变量并传入 startServer**

在 `TENANT_ID` 定义行之后新增：

```typescript
const MACHINE_ID = process.env.RCS_MACHINE_ID;
```

在 `startServer` 调用中新增参数 `machineId`：

```typescript
await startServer({
  port: 9315,
  host: "localhost",
  command: command!,
  args: agentArgs,
  cwd: process.cwd(),
  rcsUrl: wsUrl,
  rcsSecret: RCS_SECRET!,
  tenantId: TENANT_ID ?? null,
  userId: USER_ID,
  labels: LABELS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  agentType: AGENT_TYPE,
  supportedEngineTypes: SUPPORTED_ENGINE_TYPES,
  name,
  machineId: MACHINE_ID ?? undefined,  // ← 新增
});
```

- [ ] **Step 2: 启动日志中添加 machine id 信息**

在日志输出区域（约 `Tenant` 日志行之后）新增：

```typescript
if (MACHINE_ID) {
  console.log(`  Machine ID:   ${MACHINE_ID}（客户端指定）`);
}
```

- [ ] **Step 3: 验证**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/acp-runtime-cli/
```

- [ ] **Step 4: 提交**

```bash
git add packages/acp-runtime-cli/src/bin.ts
git commit -m "feat: bin.ts 支持 RCS_MACHINE_ID 环境变量"
```

---

### Task 3: 服务端解析 machine_id

**Files:**
- Modify: `src/transport/acp-ws-handler.ts`

- [ ] **Step 1: 解析 machine_id 并传入 registerMachine**

在 `handleMachineRegister` 函数中，`nodeId` 解析行之后新增：

```typescript
const specifiedMachineId = (msg.machine_id as string) || null;
```

在 `registerMachine` 调用中新增 `machineId` 参数：

```typescript
const result = await registerMachine({
  name,
  agentName,
  machineInfo: machineInfo ?? null,
  labels,
  heartbeatIntervalMs,
  tenantId,
  userId,
  nodeId,
  machineId: specifiedMachineId,  // ← 新增
});
```

- [ ] **Step 2: 运行相关测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/acp-machine-connection-lookup.test.ts
```

- [ ] **Step 3: 提交**

```bash
git add src/transport/acp-ws-handler.ts
git commit -m "feat: acp-ws-handler 解析并传递 machine_id 到 registerMachine"
```

---

### Task 4: registerMachine 核心逻辑

**Files:**
- Modify: `src/services/registry.ts`

- [ ] **Step 1: 新增 `machineId` 参数**

在 `registerMachine` 的 params 类型中新增：

```typescript
export async function registerMachine(params: {
  name: string | null;
  agentName: string;
  machineInfo: Record<string, unknown> | null;
  labels: string[];
  heartbeatIntervalMs: number;
  tenantId: string | null;
  userId: string | null;
  /** 客户端持久化的 node_id，用于精确去重（避免 IP/MAC 变化导致重复注册） */
  nodeId?: string | null;
  /** 客户端指定的 machine id（可选），有值时跳过 ID 生成和去重，直接用该 ID */
  machineId?: string | null;
}): Promise<{ id: string; isNew: boolean }> {
```

- [ ] **Step 2: 插入 machineId 分支逻辑**

在函数体开头（变量声明之后，去重逻辑之前）插入：

```typescript
  // ── 客户端指定 machineId 分支：跳过自动去重，直接用指定 ID ──
  if (params.machineId) {
    const existing = await db
      .select({ id: machine.id, status: machine.status })
      .from(machine)
      .where(eq(machine.id, params.machineId))
      .limit(1);

    const now = new Date();

    // 已在线的机器不允许另一个 client 接管
    if (existing.length > 0 && existing[0].status === "online") {
      throw new Error(`machine id '${params.machineId}' is already online`);
    }

    // 已存在但 offline → UPDATE 接管，同步更新 organizationId
    if (existing.length > 0) {
      await db
        .update(machine)
        .set({
          status: "online",
          organizationId: params.tenantId ?? null,
          userId: params.userId ?? null,
          name: params.name,
          machineInfo: params.machineInfo,
          labels: params.labels,
          heartbeatIntervalMs: params.heartbeatIntervalMs,
          lastHeartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(machine.id, params.machineId));

      await db.insert(registryEvent).values({
        id: genId("evt"),
        machineId: params.machineId,
        type: "reconnect",
        detail: { machine_info: params.machineInfo, labels: params.labels },
      });

      await bindAgentConfigs(params.machineId, params.agentName, params.tenantId);
      return { id: params.machineId, isNew: false };
    }

    // 不存在 → INSERT 新记录
    await db.insert(machine).values({
      id: params.machineId,
      organizationId: params.tenantId ?? null,
      userId: params.userId ?? null,
      agentName: params.agentName,
      name: params.name,
      status: "online",
      machineInfo: params.machineInfo,
      labels: params.labels,
      heartbeatIntervalMs: params.heartbeatIntervalMs,
      lastHeartbeatAt: now,
      registeredAt: now,
      createdAt: now,
      updatedAt: now,
    });

    await db.insert(registryEvent).values({
      id: genId("evt"),
      machineId: params.machineId,
      type: "register",
      detail: { machine_info: params.machineInfo, labels: params.labels },
    });

    await bindAgentConfigs(params.machineId, params.agentName, params.tenantId);
    return { id: params.machineId, isNew: true };
  }

  // ── 原有去重策略（machineId 未指定时）──
```

**注意**：上面的分支逻辑插入在 `const hostname` 定义行**之前**，即 `const hostname = ...` 这一行前插入，现有的去重逻辑完全不受影响。

- [ ] **Step 3: 运行全量测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test src/__tests__/
```

预期：全部通过。

- [ ] **Step 4: 提交**

```bash
git add src/services/registry.ts
git commit -m "feat: registerMachine 支持客户端指定 machineId"
```

---

### Task 5: 测试

**Files:**
- Modify: `packages/acp-link/src/__tests__/client-mode.test.ts`

- [ ] **Step 1: 新增 `machine_id` 字段测试**

在 `client-mode.test.ts` 末尾，`describe("buildRegisterMessage node_id 字段")` 块之后，新增：

```typescript
describe("buildRegisterMessage machine_id 字段", () => {
  // 传入 machineId 时应透传到注册消息
  test("传入 machineId 时透传到注册消息", async () => {
    const { buildRegisterMessage } = await import("../server");
    const config = makeConfig({ machineId: "mach_sandbox_01" });
    const msg = buildRegisterMessage(config, null) as Record<string, unknown>;
    expect(msg.machine_id).toBe("mach_sandbox_01");
  });

  // 不传 machineId 时不应包含 machine_id 字段
  test("不传 machineId 时不包含 machine_id 字段", async () => {
    const { buildRegisterMessage } = await import("../server");
    const config = makeConfig({});
    const msg = buildRegisterMessage(config, null) as Record<string, unknown>;
    expect(msg.machine_id).toBeUndefined();
  });
});
```

需要检查 `makeConfig` 函数签名，确保支持 `machineId`：

```typescript
function makeConfig(overrides?: Partial<ServerConfig>): ServerConfig {
  return {
    port: 9315,
    host: "localhost",
    command: "test",
    args: [],
    cwd: "/tmp",
    ...overrides,
  };
}
```

如果 `makeConfig` 当前接受 `Partial<ServerConfig>`，则无需修改；如果类型不匹配，改为 `Partial<ServerConfig>`。

- [ ] **Step 2: 运行测试**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun test packages/acp-link/src/__tests__/client-mode.test.ts
```

预期：新增 2 个 + 现有全部通过。

- [ ] **Step 3: 运行 precheck**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck
```

- [ ] **Step 4: 提交**

```bash
git add packages/acp-link/src/__tests__/client-mode.test.ts
git commit -m "test: 新增 machine_id 字段注册消息测试"
```

---

## 完成标准

- [ ] `bun test src/__tests__/` 全部通过
- [ ] `bun test packages/acp-link/src/__tests__/` 全部通过
- [ ] `bun run precheck` 通过
- [ ] 不设置 `RCS_MACHINE_ID` 时行为完全不变
- [ ] 设置 `RCS_MACHINE_ID=mach_test` 后注册消息携带 `machine_id`
- [ ] online 状态机器被指定相同 ID 时 client 收到错误退出
