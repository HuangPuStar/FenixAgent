# Machine Display Name 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 sandbox 远程机器注册添加 `RCS_MACHINE_NAME` 环境变量支持，使机器在 RCS 侧展示为用户指定的友好名称而非 hostname。

**Architecture:** 从 sandbox 容器的环境变量 `RCS_MACHINE_NAME` 出发，经过 acp-link 的 `ServerConfig` → WS register 消息 → 服务端 `registerMachine()` → `machine` 表 `name` 列 → 前端展示。全链路透传，`name` 为可选字段，不传时保持现有行为（使用 hostname 或 agentName）。

**Tech Stack:** Drizzle ORM schema 迁移、acp-link 包（TypeScript）、ACP WebSocket 协议、React 前端

---

### 数据流概览

```
RCS_MACHINE_NAME (env)
  → start-remote-runtime.ts (读取环境变量)
    → startServer({ name: ... }) (ServerConfig)
      → buildRegisterMessage() (WS register payload: { name: "..." })
        → acp-ws-handler.ts handleMachineRegister() (服务端提取 name)
          → registerMachine({ name: ... }) (registry.ts)
            → machine.name 列 (DB)
              → config/agents.ts machineLabel (前端展示)
```

### 涉及文件

| 文件 | 职责 | 操作 |
|------|------|------|
| `src/db/schema.ts` | machine 表定义 | 修改：新增 `name` 列 |
| `packages/acp-link/src/server.ts` | acp-link 服务端配置与注册消息 | 修改：`ServerConfig` 加 `name`，`buildRegisterMessage()` 透传 |
| `scripts/start-remote-runtime.ts` | 远程 Runtime 启动入口 | 修改：读取 `RCS_MACHINE_NAME` 环境变量 |
| `src/transport/acp-ws-handler.ts` | ACP WS 注册消息处理 | 修改：从消息中提取 `name` 字段 |
| `src/services/registry.ts` | 机器注册服务 | 修改：`registerMachine()` 接收并存储 `name` |
| `src/routes/web/config/agents.ts` | Agent 配置 API | 修改：`machineLabel` 优先使用 `machine.name` |
| `docker/sandbox/docker-compose.yml` | Sandbox Docker 编排 | 修改：添加 `RCS_MACHINE_NAME` 环境变量示例 |
| `src/__tests__/registry-schema.test.ts` | Schema 测试 | 修改：验证 `name` 列存在 |
| `src/__tests__/registry-service.test.ts` | Registry 服务测试 | 修改：验证 `name` 参数透传 |
| `packages/acp-link/src/__tests__/client-mode.test.ts` | acp-link 客户端模式测试 | 修改：验证注册消息包含 `name` |

---

### Task 1: DB Schema — machine 表新增 name 列

**Files:**
- Modify: `src/db/schema.ts:891-905`
- Test: `src/__tests__/registry-schema.test.ts`

- [ ] **Step 1: 在 machine 表添加 name 列**

在 `src/db/schema.ts` 的 `machine` 表定义中，`agentName` 行后面添加 `name` 列：

```typescript
// src/db/schema.ts — machine 表内，agentName 行之后
    agentName: varchar("agent_name").notNull(),
    name: varchar("name"),   // 用户指定的机器显示名称，可选
    status: varchar("status").default("online").notNull(),
```

- [ ] **Step 2: 更新 schema 测试验证 name 列存在**

在 `src/__tests__/registry-schema.test.ts` 的 machine 表测试中，将 `name` 加入 `expectedColumns`：

```typescript
    const expectedColumns = [
      "id",
      "organizationId",
      "userId",
      "agentName",
      "name",
      "status",
      "machineInfo",
      "labels",
      "maxSessions",
      "heartbeatIntervalMs",
      "lastHeartbeatAt",
      "registeredAt",
      "createdAt",
      "updatedAt",
    ];
```

- [ ] **Step 3: 运行测试确认通过**

Run: `bun test src/__tests__/registry-schema.test.ts`
Expected: PASS

- [ ] **Step 4: 生成数据库迁移文件**

Run: `bunx drizzle-kit generate --name machine-name`

确认 `drizzle/` 目录下生成了新迁移 SQL，内容包含 `ALTER TABLE machine ADD COLUMN name character varying`。

- [ ] **Step 5: 同步到开发数据库**

Run: `bun run db:push`

- [ ] **Step 6: 提交**

```bash
git add src/db/schema.ts src/__tests__/registry-schema.test.ts drizzle/
git commit -m "feat(registry): add name column to machine table"
```

---

### Task 2: acp-link — ServerConfig 与注册消息透传 name

**Files:**
- Modify: `packages/acp-link/src/server.ts:52-69,117-160`
- Test: `packages/acp-link/src/__tests__/client-mode.test.ts`

- [ ] **Step 1: 在 ServerConfig 接口添加 name 字段**

在 `packages/acp-link/src/server.ts` 的 `ServerConfig` 接口中添加：

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
  /** Agent 类型：opencode（默认）或 ccb（Claude Code） */
  agentType?: AgentType;
  /** 用户指定的机器显示名称，可选 */
  name?: string;
}
```

- [ ] **Step 2: 在 buildRegisterMessage 中透传 name**

在 `buildRegisterMessage()` 返回的对象中添加 `name` 字段，位于 `agent_name` 之后：

```typescript
  return {
    type: "register",
    agent_name: config.command,
    name: config.name ?? null,
    max_sessions: 5,
    capabilities: { streaming: true },
    // ... 其余不变
  };
```

- [ ] **Step 3: 更新 client-mode 测试验证 name 字段**

在 `packages/acp-link/src/__tests__/client-mode.test.ts` 中找到验证 `buildRegisterMessage` 返回值的测试，添加对 `name` 的断言：

```typescript
// 在现有测试的断言组中添加
// 传入 name 时应透传
test("buildRegisterMessage 透传 name 字段", async () => {
  const { buildRegisterMessage } = await import("../src/server");
  const msg = buildRegisterMessage({
    port: 9315,
    host: "localhost",
    command: "opencode",
    args: ["acp"],
    cwd: "/app",
    labels: ["remote-runtime"],
    name: "sandbox-01",
  }) as Record<string, unknown>;
  expect(msg.name).toBe("sandbox-01");
});

// 不传 name 时应为 null
test("buildRegisterMessage name 默认为 null", async () => {
  const { buildRegisterMessage } = await import("../src/server");
  const msg = buildRegisterMessage({
    port: 9315,
    host: "localhost",
    command: "opencode",
    args: ["acp"],
    cwd: "/app",
    labels: ["remote-runtime"],
  }) as Record<string, unknown>;
  expect(msg.name).toBeNull();
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test packages/acp-link/src/__tests__/client-mode.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add packages/acp-link/src/server.ts packages/acp-link/src/__tests__/client-mode.test.ts
git commit -m "feat(acp-link): add name field to ServerConfig and register message"
```

---

### Task 3: start-remote-runtime — 读取 RCS_MACHINE_NAME 环境变量

**Files:**
- Modify: `scripts/start-remote-runtime.ts`

- [ ] **Step 1: 添加环境变量读取和文档注释**

在 `scripts/start-remote-runtime.ts` 的环境变量配置区（`LABELS` 行之后）添加：

```typescript
const LABELS = process.env.RCS_LABELS || "remote-runtime";
const MACHINE_NAME = process.env.RCS_MACHINE_NAME || "";
const AGENT_TYPE = (process.env.AGENT_TYPE || "opencode") as "opencode" | "ccb";
```

更新文件顶部环境变量文档注释（`RCS_LABELS` 行之后添加）：

```typescript
 *   RCS_MACHINE_NAME    机器显示名称 (可选，不传则使用 hostname)
```

更新 help 输出（`console.log("  RCS_LABELS...")` 行之后添加）：

```typescript
  console.log("  RCS_MACHINE_NAME    机器显示名称 (可选，不传则使用 hostname)");
```

更新启动日志（`Labels:` 行之后添加）：

```typescript
console.log(`  Labels:       ${LABELS}`);
if (MACHINE_NAME) {
  console.log(`  Machine Name: ${MACHINE_NAME}`);
}
```

- [ ] **Step 2: 将 name 传入 startServer**

在 `await startServer({...})` 调用中添加 `name` 字段：

```typescript
await startServer({
  port: 9315,
  host: "localhost",
  command: command!,
  args: agentArgs,
  cwd: process.cwd(),
  rcsUrl: wsUrl,
  rcsSecret: RCS_SECRET,
  tenantId: TENANT_ID,
  userId: USER_ID,
  name: MACHINE_NAME || undefined,
  labels: LABELS.split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  agentType: AGENT_TYPE,
});
```

- [ ] **Step 3: 提交**

```bash
git add scripts/start-remote-runtime.ts
git commit -m "feat(sandbox): read RCS_MACHINE_NAME env var for display name"
```

---

### Task 4: 服务端 — registry 接收并存储 name

**Files:**
- Modify: `src/services/registry.ts:123-180`
- Modify: `src/transport/acp-ws-handler.ts:80-120`
- Test: `src/__tests__/registry-service.test.ts`

- [ ] **Step 1: registerMachine 参数添加 name**

在 `src/services/registry.ts` 的 `registerMachine` 函数参数中添加 `name`：

```typescript
export async function registerMachine(params: {
  agentName: string;
  name: string | null;
  machineInfo: Record<string, unknown> | null;
  labels: string[];
  heartbeatIntervalMs: number;
  tenantId: string | null;
  userId: string | null;
}): Promise<{ id: string }> {
```

在 `registerMachine` 内部，**新增机器 INSERT** 和**已有机器 UPDATE** 的 `set` 中都添加 `name` 字段：

```typescript
// INSERT — db.insert(machine).values({...}) 中添加
    name: params.name,

// UPDATE — db.update(machine).set({...}) 中添加
        name: params.name,
```

- [ ] **Step 2: handleMachineRegister 提取 name 字段**

在 `src/transport/acp-ws-handler.ts` 的 `handleMachineRegister` 函数中，提取 `name` 并传给 `registerMachine`：

```typescript
  const agentName = (msg.agent_name as string) || "unknown";
  const name = (msg.name as string) || null;
  const machineInfo = msg.machine_info as Record<string, unknown> | undefined;
  // ...

  const result = await registerMachine({
    agentName,
    name,
    machineInfo: machineInfo ?? null,
    labels,
    heartbeatIntervalMs,
    tenantId,
    userId,
  });
```

- [ ] **Step 3: 更新 registry-service 测试**

在 `src/__tests__/registry-service.test.ts` 中添加测试：

```typescript
// registerMachine 接受 name 参数
test("registerMachine 函数签名包含 name", async () => {
  const { registerMachine } = await import("../services/registry");
  // 函数存在即可，实际 DB 调用会被 stub 拦截
  expect(typeof registerMachine).toBe("function");
});
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test src/__tests__/registry-service.test.ts src/__tests__/acp-machine-register.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/services/registry.ts src/transport/acp-ws-handler.ts src/__tests__/registry-service.test.ts
git commit -m "feat(registry): accept and store machine name in registerMachine"
```

---

### Task 5: 前端展示 — machineLabel 优先使用 name

**Files:**
- Modify: `src/routes/web/config/agents.ts:95-115`

- [ ] **Step 1: 更新 machineLabel 逻辑优先使用 machine.name**

在 `src/routes/web/config/agents.ts` 中，修改 machine 查询和 label 生成逻辑：

首先在 DB 查询中添加 `name` 字段：

```typescript
      const machineRows = await db
        .select({ id: machine.id, agentName: machine.agentName, name: machine.name, machineInfo: machine.machineInfo })
        .from(machine)
        .where(eq(machine.id, agent.machineId))
        .limit(1);
      const machineRow = machineRows[0];
      if (machineRow) {
        const hostname =
          machineRow.machineInfo && typeof machineRow.machineInfo === "object"
            ? ((machineRow.machineInfo as { hostname?: string }).hostname ?? "")
            : "";
        machineLabel = machineRow.name || hostname || machineRow.agentName;
```

- [ ] **Step 2: 提交**

```bash
git add src/routes/web/config/agents.ts
git commit -m "feat(agents): display machine name in agent config API"
```

---

### Task 6: Docker Compose — 添加 RCS_MACHINE_NAME 示例

**Files:**
- Modify: `docker/sandbox/docker-compose.yml`

- [ ] **Step 1: 在 docker-compose.yml 添加 RCS_MACHINE_NAME 环境变量**

```yaml
        environment:
            RCS_URL: ws://host.docker.internal:3000
            RCS_SECRET: 340b6908-031d-47de-9cfb-26f75818f969
            RCS_TENANT_ID: sbFAPs2nyyL0ZNxTE8CSqXUu6AIPULfL
            RCS_MACHINE_NAME: sandbox-01
            AGENT_TYPE: opencode
```

- [ ] **Step 2: 提交**

```bash
git add docker/sandbox/docker-compose.yml
git commit -m "feat(sandbox): add RCS_MACHINE_NAME to docker-compose example"
```

---

### Task 7: 集成验证

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 全部通过（格式化 + import 排序 + tsc + biome check）

- [ ] **Step 2: 运行全部相关测试**

Run: `bun test src/__tests__/registry-schema.test.ts src/__tests__/registry-service.test.ts src/__tests__/acp-machine-register.test.ts packages/acp-link/src/__tests__/client-mode.test.ts`
Expected: 全部 PASS

- [ ] **Step 3: 重新构建 sandbox 镜像并启动验证**

Run: `docker compose -f docker/sandbox/docker-compose.yml build && docker compose -f docker/sandbox/docker-compose.yml up -d`

查看日志确认 `Machine Name: sandbox-01` 出现在启动输出中：

Run: `docker logs rcs-sandbox --tail 20`

- [ ] **Step 4: 如果前面都是独立提交，squash merge 或保持独立提交均可**

根据团队偏好处理提交历史。
