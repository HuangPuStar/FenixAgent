# 注册中心架构修复：恢复本地 Machine 能力

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 恢复 Phase 2 注册中心合并时丢失的本地 spawn 能力，建立统一的 relay 入口（本地/远端 machine 两条路径）。

**Architecture:** relay 连接时查 environment → agentConfig → machineId。有 machineId 走远端 machine WS 传完整 launch spec；无 machineId 走本地 CoreRuntimeFacade spawn（旧架构路径）。恢复 auto-start 和 graceful shutdown。远端 machine 的 `session_start` 协议升级为携带完整 launch spec。

**Tech Stack:** Elysia, Drizzle ORM, CoreRuntimeFacade (@fenix/core), WebSocket (ACP protocol), opencode plugin

---

## File Structure

### 恢复的文件
| 文件 | 职责 |
|---|---|
| `src/services/instance.ts` | 本地 spawn 能力（ensureRunning, spawnInstanceFromEnvironment, stopAllInstances 等） |
| `src/schemas/instance.schema.ts` | Instance 相关请求/响应 schema |

### 修改的文件
| 文件 | 变更内容 |
|---|---|
| `src/index.ts` | 恢复 auto-start、stopAllInstances import |
| `src/transport/relay/relay-handler.ts` | 统一入口：无 machineId → 本地 spawn；有 machineId → 远端传完整 launch spec |
| `src/transport/acp-ws-handler.ts` | 恢复本地 acp-link 回连支持（boundEnvId 模式） |
| `src/services/environment-web.ts` | `groupActiveInstancesByEnvironment` 改为调用 instance.ts |
| `src/routes/web/environments.ts` | `spawnInstanceFromEnvironment` 改为从 instance.ts import |
| `src/routes/web/index.ts` | 无变化（instances 路由已删除，environments 路由已包含 enter） |
| `src/schemas/index.ts` | 恢复 instance schema 导出 |
| `packages/acp-link/src/server.ts` | `session_start` handler 接收完整 launch spec |

---

## Task 1: 恢复 instance.ts

**Files:**
- Create: `src/services/instance.ts`
- Reference: `git show bfdc7c97e51cdfe1f6043493ff70d49a7ca95e27^:src/services/instance.ts`

- [ ] **Step 1: 从 git 历史恢复 instance.ts**

旧文件有 403 行。核心是恢复以下公共 API：

- `spawnInstanceFromEnvironment(userId, environmentId, prefetchedEnv?, extraEnv?)`
- `ensureRunning(userId, environmentId)`
- `findRunningInstanceByEnvironment(environmentId, userId?)`
- `listInstances(organizationId)`
- `listInstancesByEnvironment(environmentId)`
- `getRunningInstancesByEnvironment(environmentId)`
- `groupActiveInstancesByEnvironment()`
- `getInstance(id, userId?)`
- `stopInstance(id, organizationId)`
- `stopAllInstances()`
- `enterEnvironment(userId, environmentId, instanceNumber?)`
- `listInstancesResponse(environmentId)`

内部依赖：`getCoreRuntime()`, `buildLaunchSpec()`, `getAgentConfigById()`, `getAgentFullConfig()`, `environmentRepo`, `_sessionRepo`

直接从 git 恢复：
```bash
git show bfdc7c97e51cdfe1f6043493ff70d49a7ca95e27^:src/services/instance.ts > src/services/instance.ts
```

- [ ] **Step 2: 验证恢复的文件没有 import 错误**

确认以下 import 在当前代码库中仍然存在：
- `@fenix/core` 的 `RuntimeInstanceSnapshot` 类型
- `../config` 的 `getBaseUrl`
- `../errors` 的 `AppError`, `NotFoundError`
- `../logger` 的 `log`, `error`
- `../repositories` 的 `environmentRepo`, `EnvironmentRecord`
- `../types/store` 的 `InstanceSupplement`
- `../services/config-pg` 的 `getAgentConfigById`, `getAgentFullConfig`, `AgentFullConfig`
- `../services/core-bootstrap` 的 `getCoreRuntime`
- `../services/launch-spec-builder` 的 `buildLaunchSpec`
- `../services/session` 的 `_sessionRepo`

Run: `grep -n "from '" src/services/instance.ts`
Run: `bun run tsc --noEmit 2>&1 | head -30`

- [ ] **Step 3: Commit**

```bash
git add src/services/instance.ts
git commit -m "feat: 恢复本地 Instance spawn 能力 (instance.ts)"
```

---

## Task 2: 恢复 instance.schema.ts 和 schema 导出

**Files:**
- Create: `src/schemas/instance.schema.ts`
- Modify: `src/schemas/index.ts`

- [ ] **Step 1: 从 git 历史恢复 instance.schema.ts**

```bash
git show bfdc7c97e51cdfe1f6043493ff70d49a7ca95e27^:src/schemas/instance.schema.ts > src/schemas/instance.schema.ts
```

- [ ] **Step 2: 在 schemas/index.ts 添加 instance schema 导出**

在 `src/schemas/index.ts` 的 `// Environments` 导出块之前添加：

```typescript
// Instances
export {
  type DeleteInstanceResponse,
  DeleteInstanceResponseSchema,
  type InstanceInfo,
  InstanceInfoSchema,
  type InstanceListResponse,
  InstanceListResponseSchema,
  InstanceStatusSchema,
  type InstanceStatus,
  type SpawnInstanceFromEnvironmentRequest,
  SpawnInstanceFromEnvironmentRequestSchema,
} from "./instance.schema";
```

- [ ] **Step 3: 验证类型检查通过**

Run: `bun run tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/schemas/instance.schema.ts src/schemas/index.ts
git commit -m "feat: 恢复 instance schema 定义和导出"
```

---

## Task 3: 恢复 acp-ws-handler 本地连接支持

**Files:**
- Modify: `src/transport/acp-ws-handler.ts`

当前 `handleAcpWsOpen` 只处理 `isMachine=true`，非 machine 连接直接拒绝。需要恢复本地 acp-link 回连场景（`boundEnvId` 有值，非 machine）。

- [ ] **Step 1: 修改 handleAcpWsOpen 恢复本地 acp-link 连接路径**

在 `handleAcpWsOpen` 函数中，`isMachine` 分支之后、`ws.close(4003, ...)` 之前，恢复 boundEnvId 连接路径：

```typescript
export function handleAcpWsOpen(
  ws: WsConnection,
  wsId: string,
  userId: string,
  boundEnvId?: string | null,
  isMachine?: boolean,
): void {
  if (isMachine) {
    // machine 连接（现有逻辑不变）
    log(`[ACP-WS] Machine connection opened: wsId=${wsId}`);
    connections.set(wsId, {
      agentId: null,
      boundEnvId: null,
      userId,
      unsub: null,
      keepalive: null,
      ws,
      openTime: Date.now(),
      lastClientActivity: Date.now(),
      capabilities: null,
      isMachine: true,
      machineId: null,
      wsId,
    });
    return;
  }

  // 本地 acp-link 回连（旧架构路径）
  if (boundEnvId) {
    log(`[ACP-WS] Local acp-link connection opened: wsId=${wsId} boundEnvId=${boundEnvId}`);
    const { handleAcpConnect } = await import("../services/environment");
    handleAcpConnect(boundEnvId).catch(() => {});

    const keepalive = setInterval(() => {
      const entry = connections.get(wsId);
      if (!entry || entry.ws.readyState !== 1) {
        clearInterval(keepalive);
        return;
      }
      const silenceMs = Date.now() - entry.lastClientActivity;
      if (silenceMs > _CLIENT_ACTIVITY_TIMEOUT_MS) {
        log(`[ACP-WS] Client inactive for ${Math.round(silenceMs / 1000)}s, closing dead connection`);
        try {
          entry.ws.close(1000, "client inactive");
        } catch {
          clearInterval(keepalive);
        }
        return;
      }
      sendToWs(entry.ws, { type: "keep_alive" });
    }, SERVER_KEEPALIVE_INTERVAL_MS);

    connections.set(wsId, {
      agentId: boundEnvId,
      boundEnvId,
      userId,
      unsub: null,
      keepalive,
      ws,
      openTime: Date.now(),
      lastClientActivity: Date.now(),
      capabilities: null,
      isMachine: false,
      machineId: null,
      wsId,
    });

    // 订阅 EventBus
    const { getAcpEventBus } = await import("./event-bus");
    const bus = getAcpEventBus(boundEnvId);
    const unsub = bus.subscribe((event: import("./event-bus").SessionEvent) => {
      const entry = connections.get(wsId);
      if (!entry || entry.ws.readyState !== 1) return;
      if (event.direction !== "outbound") return;
      sendToWs(entry.ws, event.payload as object);
    });
    const entry = connections.get(wsId);
    if (entry) entry.unsub = unsub;
    return;
  }

  // 既非 machine 也非 boundEnvId — 拒绝
  log(`[ACP-WS] Unidentified connection rejected: wsId=${wsId}`);
  ws.close(4003, "Unidentified connection; provide either boundEnvId or registry secret");
}
```

注意：函数需要改为 `async`。

- [ ] **Step 2: 恢复 handleAcpWsMessage 中本地 acp-link 的消息处理**

在 `handleAcpWsMessage` 的消息分发中，本地 acp-link 连接需要恢复 identify、keep_alive 处理。当前 `isMachine` 分支只处理 machine 的 session 消息和 register，但本地连接的 identify 等消息被跳过了。

在现有 `msg.type === "register"` 处理之后，添加本地连接的消息处理：

```typescript
// 本地 acp-link 连接的消息处理
if (!entry.isMachine && entry.agentId) {
  if (msg.type === "identify") {
    // 旧架构 identify：绑定 agentId
    const agentId = msg.agent_id as string;
    if (agentId) {
      entry.agentId = agentId;
      entry.boundEnvId = agentId;
      sendToWs(entry.ws, { type: "identified", agent_id: agentId });
      log(`[ACP-WS] Agent identified: wsId=${wsId} agentId=${agentId}`);
    }
    continue;
  }
  if (msg.type === "keep_alive") {
    touchEnvironmentPoll(entry.agentId).catch(() => {});
    continue;
  }
}
```

- [ ] **Step 3: 恢复 handleAcpWsClose 中本地连接的清理**

当前 close handler 中 machine 断连走 `handleMachineDisconnect`，但本地 acp-link 断连需要通知 environment 服务。确认现有逻辑中 `if (!entry.isMachine)` 分支存在，如不存在则补充 environment disconnect 通知。

检查现有 close handler 是否已有非 machine 分支的处理，如果没有则在 `if (entry.isMachine)` 块之后补充。

- [ ] **Step 4: 运行类型检查**

Run: `bun run tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/transport/acp-ws-handler.ts
git commit -m "feat: 恢复本地 acp-link WS 连接支持 (boundEnvId 模式)"
```

---

## Task 4: 统一 relay 入口（relay-handler.ts 核心改造）

**Files:**
- Modify: `src/transport/relay/relay-handler.ts`

当前 `handleRelayOpen` 只走远端 machine 路径。改为：无 machineId → 本地 spawn 路径；有 machineId → 远端 machine 路径。

- [ ] **Step 1: 修改 handleRelayOpen 统一分发**

将现有 `handleRelayOpen` 改为先查 environment → agentConfig，根据 machineId 决定路径：

```typescript
export async function handleRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`);

  const env = await environmentRepo.getById(agentId);
  if (!env) {
    sendToRelayWs(ws, { type: "error", payload: { message: "Environment not found" } });
    ws.close(4004, "environment not found");
    return;
  }

  // 查 agentConfig 获取 machineId
  let machineId: string | null = null;
  if (env.agentConfigId) {
    const agentCfg = await getAgentConfigById(env.agentConfigId);
    machineId = agentCfg?.machineId ?? null;
  }

  if (machineId) {
    // 远端 machine 路径
    const machineConn = findMachineConnectionById(machineId);
    if (!machineConn) {
      sendToRelayWs(ws, { type: "error", payload: { message: "Machine offline" } });
      ws.close(4004, "machine offline");
      return;
    }
    setAgentMachineCache(agentId, machineId);
    const agentPrompt = await resolveAgentPrompt(env);
    openMachineRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, machineConn, agentPrompt, env);
  } else {
    // 本地路径（默认 machine）
    openLocalRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, env);
  }
}
```

- [ ] **Step 2: 实现 openLocalRelay**

新增本地路径函数。本地路径走旧架构：ensureRunning → acp-link spawn → 回连 → EventBus 转发：

```typescript
async function openLocalRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  env: EnvironmentRecord,
): Promise<void> {
  // 动态 import 避免循环依赖
  const { ensureRunning } = await import("../../services/instance");

  try {
    const result = await ensureRunning(userId, agentId);
    log(`[ACP-Relay] Local instance ${result.status}: instanceId=${result.instance.id} envId=${agentId}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    sendToRelayWs(ws, { type: "error", payload: { message: `Failed to start local instance: ${msg}` } });
    ws.close(1011, "spawn failed");
    return;
  }

  // 本地 acp-link spawn 后通过 /acp/ws 回连，relay 通过 EventBus 订阅转发
  const relayKeepalive = setInterval(() => {
    const entry = manager.get(relayWsId);
    if (!entry || entry.ws.readyState !== 1) {
      clearInterval(relayKeepalive);
      return;
    }
    sendToRelayWs(entry.ws, { type: "keep_alive" });
  }, RELAY_KEEPALIVE_INTERVAL_MS);

  const entry: RelayConnectionEntry = {
    agentId,
    userId,
    unsub: null,
    keepalive: relayKeepalive,
    ws,
    openTime: Date.now(),
    instanceId: null,
    relayHandle: null,
    relayUnsub: null,
    outboundBuffer: [],
    sessionStarted: true, // 本地路径 spawn 后即视为就绪
  };
  manager.add(relayWsId, entry);

  // 订阅 EventBus 转发 outbound 消息到前端
  const { getAcpEventBus } = await import("../event-bus");
  const bus = getAcpEventBus(agentId);
  const unsub = bus.subscribe((event: import("../event-bus").SessionEvent) => {
    if (event.direction !== "outbound") return;
    const e = manager.get(relayWsId);
    if (!e || e.ws.readyState !== 1) return;
    sendToRelayWs(e.ws, event.payload as object);
  });
  entry.unsub = unsub;

  log(`[ACP-Relay] Local relay established: relayWsId=${relayWsId} agentId=${agentId}`);
}
```

- [ ] **Step 3: 提取 resolveAgentPrompt 辅助函数**

从 agentConfig 中提取 prompt（供远端 machine 路径使用）：

```typescript
async function resolveAgentPrompt(env: EnvironmentRecord): Promise<string | undefined> {
  if (!env.agentConfigId) return undefined;
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  return (agentCfg?.prompt as string) ?? undefined;
}
```

- [ ] **Step 4: 更新 openMachineRelay 签名**

当前 `openMachineRelay` 接收 `agentPrompt` 参数。改为也接收 `env` 以便组装完整 launch spec（Task 6 做协议升级，此处先保持 agent_prompt 传参不变）：

```typescript
function openMachineRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  machineConn: AcpConnectionEntry,
  agentPrompt: string | undefined,
  _env: EnvironmentRecord,
): void {
```

- [ ] **Step 5: 更新兼容层导出**

确认 `relay-handler.ts` 底部的兼容层函数（`findRunningInstanceByEnvironment`, `spawnInstanceFromEnvironment` 等）改为从 `instance.ts` re-export 或直接委托。

将现有 stub 实现替换为：

```typescript
export { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment } from "../../services/instance";
```

- [ ] **Step 6: 运行类型检查**

Run: `bun run tsc --noEmit`

- [ ] **Step 7: Commit**

```bash
git add src/transport/relay/relay-handler.ts
git commit -m "feat: 统一 relay 入口 — 无 machineId 走本地 spawn，有 machineId 走远端"
```

---

## Task 5: 修复 environment-web.ts 和 environments.ts 的 import

**Files:**
- Modify: `src/services/environment-web.ts`
- Modify: `src/routes/web/environments.ts`

- [ ] **Step 1: environment-web.ts 恢复 instance.ts import**

将 stub `groupActiveInstancesByEnvironment` 函数替换为从 instance.ts import：

删除 `environment-web.ts` 第 12-18 行的 stub 函数，添加 import：

```typescript
import { groupActiveInstancesByEnvironment } from "./instance";
```

- [ ] **Step 2: environments.ts 修改 spawnInstanceFromEnvironment import**

当前第 19 行：
```typescript
import { spawnInstanceFromEnvironment } from "../../transport/relay";
```

改为：
```typescript
import { spawnInstanceFromEnvironment, enterEnvironment } from "../../services/instance";
```

同时删除第 18 行的 `enterEnvironment` import：
```typescript
// 删除: import { enterEnvironment } from "../../services/environment-web";
```

- [ ] **Step 3: 运行类型检查**

Run: `bun run tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/services/environment-web.ts src/routes/web/environments.ts
git commit -m "fix: environment-web.ts 恢复 instance.ts 真实实现"
```

---

## Task 6: 恢复 index.ts auto-start 和 graceful shutdown

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 恢复 import**

在 `src/index.ts` 顶部添加：

```typescript
import { existsSync } from "node:fs";
import { environmentRepo } from "./repositories";
import { findRunningInstanceByEnvironment, spawnInstanceFromEnvironment, stopAllInstances } from "./services/instance";
import { resolveWorkspacePath } from "./services/workspace-resolver";
```

- [ ] **Step 2: 恢复 auto-start 逻辑**

将第 63 行的注释 `// Auto-start 逻辑已废弃：...` 替换为：

```typescript
// Auto-start instances for all environments on server boot
(async () => {
  const envs = await environmentRepo.listAll();
  for (const env of envs) {
    if (!env.userId) continue;
    if (!env.organizationId) continue;
    if (!env.autoStart) continue;
    // 只为没有 machineId 的 environment 本地 spawn（有 machineId 的由远端 machine 管理）
    if (env.agentConfigId) {
      const { getAgentConfigById } = await import("./services/config/agent-config");
      const agentCfg = await getAgentConfigById(env.agentConfigId);
      if (agentCfg?.machineId) continue;
    }
    const cwd = resolveWorkspacePath(env.organizationId, env.userId, env.id);
    if (!existsSync(cwd)) {
      console.log(`[RCS] Skipping environment ${env.name}: workspace directory does not exist (${cwd})`);
      continue;
    }
    const existing = findRunningInstanceByEnvironment(env.id);
    if (existing) continue;
    try {
      await spawnInstanceFromEnvironment(env.userId, env.id);
      console.log(`[RCS] Auto-started instance for environment: ${env.name} (${env.id})`);
    } catch (err: unknown) {
      console.error(
        `[RCS] Failed to auto-start instance for ${env.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
})();
```

保留现有的 `startMachineSweep` 调用不变。

- [ ] **Step 3: 恢复 graceful shutdown 中的 stopAllInstances**

在 `gracefulShutdown` 函数中，`closeAllRelayConnections()` 之后添加：

```typescript
await stopAllInstances();
```

- [ ] **Step 4: 运行类型检查**

Run: `bun run tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat: 恢复 auto-start 和 graceful shutdown (本地 instance 管理)"
```

---

## Task 7: 远端 machine session_start 协议升级

**Files:**
- Modify: `src/transport/relay/relay-handler.ts` (openMachineRelay 中的 session_start 消息)
- Modify: `packages/acp-link/src/server.ts` (client mode 的 session_start 处理)

- [ ] **Step 1: relay-handler.ts 组装完整 launch spec**

在 `openMachineRelay` 函数中，当前发送：
```typescript
sendToWs(machineConn.ws, { type: "session_start", session_id: sessionId, agent_prompt: agentPrompt });
```

改为组装完整 launch spec：

```typescript
// 组装完整 launch spec 发送给远端 machine
const { buildLaunchSpec } = await import("../../services/launch-spec-builder");
const { getAgentFullConfig, getAgentConfigById: getAgentCfg } = await import("../../services/config-pg");

let launchSpecPayload: Record<string, unknown> = { agent_prompt: agentPrompt };

if (env.agentConfigId) {
  try {
    const agentCfg = await getAgentCfg(env.agentConfigId);
    if (agentCfg) {
      const fullConfig = await getAgentFullConfig(
        { organizationId: env.organizationId ?? "", userId: env.userId ?? "", role: "owner" },
        agentCfg.id,
      );
      const spec = await buildLaunchSpec({
        organizationId: env.organizationId ?? userId,
        userId: env.userId ?? userId,
        environmentId: agentId,
        agentName: agentCfg.name,
        agentConfigId: env.agentConfigId,
        agentPrompt: agentPrompt ?? null,
        modelRef: typeof (fullConfig.agentConfig as Record<string, unknown>)?.model === "string"
          ? (fullConfig.agentConfig as Record<string, unknown>).model as string
          : null,
        fullConfig,
        environmentSecret: env.secret,
        extraEnv: {
          USER_META_API_KEY: env.secret,
          USER_META_BASE_URL: (await import("../../config")).getBaseUrl(),
        },
      });
      launchSpecPayload = { launch_spec: spec, agent_prompt: agentPrompt };
    }
  } catch (err) {
    logError("[ACP-Relay] Failed to build launch spec for remote machine:", err);
    // fallback: 仅传 agent_prompt
  }
}

sendToWs(machineConn.ws, {
  type: "session_start",
  session_id: sessionId,
  ...launchSpecPayload,
});
```

- [ ] **Step 2: acp-link server.ts 的 client mode 处理 session_start**

在 `packages/acp-link/src/server.ts` 的 `createAcpClient` 函数中，`session_start` 消息处理改为识别 launch_spec：

找到 `case "session_start"` 的处理（约第 330 行附近），修改为：

```typescript
if (msg.type === "session_start") {
  const sessionId = msg.session_id as string;
  const launchSpec = msg.launch_spec;

  if (launchSpec) {
    // 完整 launch spec 模式：用 opencode plugin 逻辑执行
    console.log(`[acp-client] session_start with launch_spec for ${sessionId}`);
    try {
      const result = await sessionMgr.startWithSpec(sessionId, launchSpec);
      if (result === "started") {
        // session_started 已由 SessionManager 内部发送
      } else if (result === "queued") {
        ws.send(JSON.stringify({ type: "session_queued", session_id: sessionId }));
      } else {
        ws.send(JSON.stringify({ type: "session_error", session_id: sessionId, error: "spawn failed" }));
      }
    } catch (err) {
      ws.send(JSON.stringify({ type: "session_error", session_id: sessionId, error: (err as Error).message }));
    }
  } else {
    // 兼容旧模式：仅 agent_prompt
    console.log(`[acp-client] session_start (legacy) for ${sessionId}`);
    const agentPrompt = msg.agent_prompt as string | undefined;
    try {
      const result = await sessionMgr.start(sessionId, agentPrompt);
      // ... 现有逻辑不变
    }
  }
}
```

- [ ] **Step 3: SessionManager 添加 startWithSpec 方法**

在 `packages/acp-link/src/client/session-manager.ts` 中添加：

```typescript
async startWithSpec(sessionId: string, launchSpec: unknown): Promise<"started" | "queued" | "failed"> {
  // 按 launch spec 中的信息准备环境和 spawn
  // 与旧架构 opencode plugin 的 prepareEnvironment + spawn 逻辑一致
  const spec = launchSpec as Record<string, unknown>;
  const env = spec.extraEnv as Record<string, string> ?? {};
  const command = spec.command as string ?? "opencode";
  const args = spec.args as string[] ?? [];
  const cwd = spec.cwd as string ?? process.cwd();

  // 复用现有 start 方法的 spawn 逻辑
  return this.start(sessionId, spec.agent_prompt as string | undefined, { env, command, args, cwd });
}
```

注意：这需要修改 `SessionManager.start()` 的签名以接受可选的 spawn 参数。具体实现取决于 `SessionManager` 当前的 spawn 逻辑。

- [ ] **Step 4: 运行类型检查**

Run: `bun run tsc --noEmit`
Run: `cd web && bun run tsc --noEmit`

- [ ] **Step 5: Commit**

```bash
git add src/transport/relay/relay-handler.ts packages/acp-link/src/server.ts packages/acp-link/src/client/session-manager.ts
git commit -m "feat: 远端 machine session_start 协议升级 — 携带完整 launch spec"
```

---

## Task 8: 运行 precheck 和测试验证

**Files:** 无变更

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`

Expected: 通过（格式化 + import 排序 + tsc + biome check）

- [ ] **Step 2: 运行后端测试**

Run: `bun test src/__tests__/`

Expected: 所有测试通过

- [ ] **Step 3: 运行前端测试**

Run: `bun test web/src/__tests__/`

Expected: 所有测试通过

- [ ] **Step 4: 最终 commit（如有 precheck 自动修复）**

```bash
git add -A
git commit -m "chore: precheck 修复"
```

---

## 验证清单（手动，非自动化步骤）

实现者在提交所有代码后，需手动验证以下场景：

1. **本地 spawn**：启动 RCS → auto-start 为 autoStart=true 的 environment 本地 spawn instance → 后端日志出现 `[RCS] Auto-started instance for environment`
2. **本地 relay**：前端打开 agent 面板 → relay 连接 → 无 machineId → 本地 ensureRunning → agent 正常交互
3. **远端 machine relay**：agentConfig 绑定 machineId → acp-link 注册 → relay 连接 → 消息正常转发
4. **graceful shutdown**：Ctrl+C → 日志显示 stopAllInstances 清理

---

## Spec 自审

**Spec 覆盖检查：**
- ✅ 恢复本地 spawn 能力 → Task 1
- ✅ 恢复 instance schema → Task 2
- ✅ 恢复本地 acp-link WS 连接 → Task 3
- ✅ 统一 relay 入口（本地/远端） → Task 4
- ✅ 修复 environment-web.ts stub → Task 5
- ✅ 恢复 auto-start + graceful shutdown → Task 6
- ✅ 远端 machine launch spec 协议升级 → Task 7
- ✅ 验证 → Task 8

**Placeholder 扫描：** 无 TBD/TODO/实现后填充。

**类型一致性：**
- `spawnInstanceFromEnvironment` 在 Task 1 恢复，Task 5 environments.ts 改为从 instance.ts import，签名一致
- `ensureRunning` 在 Task 1 恢复，Task 4 relay-handler.ts 动态 import 使用，签名一致
- `handleRelayOpen` 签名不变（ws, relayWsId, agentId, userId, sessionId?）
- `openMachineRelay` 新增 `_env` 参数但现有调用已更新
