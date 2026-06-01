# Relay 链路 Bug 修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 relay 连接链路中 9 个严重问题，使本地路径和远端路径的资源传递、消息路由、生命周期管理、关闭流程全部正确。

**Architecture:** 修复集中在三个文件：`src/transport/relay/relay-handler.ts`（主逻辑）、`src/types/store.ts`（类型）、`src/transport/relay/connection-manager.ts`（连接管理）。本地路径需要补充 `agent_prompt` 传递和 relay handle 关闭通知；远端路径需要统一 `session_id` 和修复 `onSessionMessage` 回调链；全局需要修复 graceful shutdown 顺序和 `handleMachineDisconnected` 调用。

**Tech Stack:** TypeScript, Bun, Elysia WebSocket

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/types/store.ts` | `RelayConnectionEntry` 类型定义 — 添加 `sessionId` 字段 |
| `src/transport/relay/relay-handler.ts` | 主修复文件 — open/message/close 三大流程 |
| `src/transport/relay/connection-manager.ts` | 连接管理 — `add` 防重复 |
| `src/transport/acp-ws-handler.ts` | ACP WS handler — machine 断连通知 relay 层 |
| `packages/plugin-opencode/src/relay/relay-handle.ts` | relay handle — onclose 通知监听器 |
| `src/index.ts` | graceful shutdown 顺序调整 |

---

### Task 1: 在 `RelayConnectionEntry` 中添加 `sessionId` 字段

**Files:**
- Modify: `src/types/store.ts:43-60`

- [ ] **Step 1: 添加 `sessionId` 字段到 `RelayConnectionEntry`**

在 `outboundBuffer` 字段之前添加 `sessionId` 字段：

```typescript
// src/types/store.ts — RelayConnectionEntry 接口
export interface RelayConnectionEntry {
  agentId: string;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  instanceId: string | null;
  relayHandle: EngineRelayHandle | null;
  relayUnsub: (() => void) | null;
  /** 远端路径使用的 sessionId（用于 session_start/session_data/session_end 一致性） */
  sessionId: string;
  outboundBuffer: Record<string, unknown>[];
  /** 等待 session_started 确认后才能转发消息 */
  sessionStarted?: boolean;
  /** machine 断连后标记为待重连，保持 relay WS 连接不关 */
  pendingReconnect?: boolean;
  /** machine 连接的 wsId，用于断连后恢复 onSessionMessage 回调 */
  machineWsId?: string;
}
```

- [ ] **Step 2: Run precheck to verify types compile**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit 2>&1 | head -30`
Expected: 类型错误（因为所有创建 entry 的地方缺少 `sessionId`），这是预期行为，后续 Task 会修复。

---

### Task 2: 修复 graceful shutdown 顺序（C-07）

**Files:**
- Modify: `src/index.ts:197-201`

这是改动最小（1 行）但风险最高的问题，单独修复方便验证。

- [ ] **Step 1: 调整关闭顺序为 relay → ACP → instances**

将 `src/index.ts` 的 `gracefulShutdown` 函数中的关闭顺序从：

```typescript
// 当前（错误）：
closeAllAcpConnections();
closeAllRelayConnections();
await stopAllInstances();
```

改为：

```typescript
// 修复后：
closeAllRelayConnections();
closeAllAcpConnections();
await stopAllInstances();
```

完整上下文（第 197-206 行）：

```typescript
async function gracefulShutdown(signal: string) {
  console.log(`\n[RCS] Received ${signal}, shutting down...`);
  const hermesClient = getHermesClient();
  await hermesClient?.stop();
  closeAllRelayConnections();
  closeAllAcpConnections();
  await stopAllInstances();
  stopScheduler();
  await closeCache();
  await pgClient.end();
  process.exit(0);
}
```

- [ ] **Step 2: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/index.ts
git commit -m "fix: 修复 graceful shutdown 顺序，relay 应先于 ACP 关闭"
```

---

### Task 3: 调用 `handleMachineDisconnected`（C-06）

**Files:**
- Modify: `src/transport/acp-ws-handler.ts:273-279`

- [ ] **Step 1: 在 `handleAcpWsClose` 中 machine 断连时调用 relay 层通知**

在 `handleAcpWsClose` 函数中，`handleMachineDisconnect(entry, reasonStr)` 调用之后，添加 relay 层通知：

```typescript
// src/transport/acp-ws-handler.ts — handleAcpWsClose 函数
// machine 连接断连处理（第 274-279 行区域）
if (entry.isMachine) {
  const reasonStr = reason ?? undefined;
  handleMachineDisconnect(entry, reasonStr).catch(() => {});
  // 通知 relay 层：machine 已断连，标记关联 relay entry
  if (entry.machineId) {
    import("./relay/relay-handler").then(({ handleMachineDisconnected }) => {
      handleMachineDisconnected(entry.machineId!);
    });
  }
}
```

注意：使用动态 `import()` 避免循环依赖（`acp-ws-handler` 已在文件顶部被 `relay-handler` 导入）。

- [ ] **Step 2: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/transport/acp-ws-handler.ts
git commit -m "fix: machine 断连时通知 relay 层，修复 handleMachineDisconnected 未被调用"
```

---

### Task 4: relay handle onclose 通知监听器（C-08）

**Files:**
- Modify: `packages/plugin-opencode/src/relay/relay-handle.ts:146-165`

- [ ] **Step 1: 在 `onclose` 中通过 `emit` 通知所有 `onMessage` 监听器**

将 `socket.onclose` 从静默处理改为通知监听器：

```typescript
  socket.onclose = () => {
    console.log(`[RelayHandle] WS closed for instance ${input.instanceId}`);
    state = "closed";
    clearInterval(keepalive);
    // 通知所有 onMessage 监听器 relay 已关闭
    emit({ type: "relay_closed", payload: { code: "relay_disconnected" } });
    messageBuffer.length = 0;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Relay closed before websocket open"));
    }
  };
```

同样修改 `socket.onerror`：

```typescript
  socket.onerror = () => {
    console.error(`[RelayHandle] WS error for instance ${input.instanceId}`);
    state = "closed";
    clearInterval(keepalive);
    // 通知所有 onMessage 监听器 relay 出错
    emit({ type: "relay_closed", payload: { code: "relay_error" } });
    messageBuffer.length = 0;
    if (!readySettled) {
      readySettled = true;
      rejectReady(new Error("Relay websocket errored before open"));
    }
  };
```

- [ ] **Step 2: 在 `relay-handler.ts` 的 `onMessage` 回调中处理 `relay_closed`**

在 `openLocalRelay` 的 `onMessage` 回调中（第 201 行附近的 `entry.relayUnsub = full.onMessage((message) => { ... })`），在 `if (message.type === "status") return;` 之后添加：

```typescript
entry.relayUnsub = full.onMessage((message) => {
  if (message.type === "status") return;
  // relay handle 内部 WS 关闭/出错 → 通知前端并关闭 relay WS
  if (message.type === "relay_closed") {
    sendToRelayWs(ws, {
      type: "error",
      payload: { message: "Agent connection lost" },
    });
    ws.close(1011, "relay handle closed");
    return;
  }
  const e = manager.get(relayWsId);
  if (!e || e.ws.readyState !== 1) return;
  sendToRelayWs(e.ws, message);
});
```

- [ ] **Step 3: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-opencode/src/relay/relay-handle.ts src/transport/relay/relay-handler.ts
git commit -m "fix: relay handle 关闭/出错时通知监听器，避免前端僵尸连接"
```

---

### Task 5: 远端路径 session_id 统一（C-03）

**Files:**
- Modify: `src/transport/relay/relay-handler.ts` — `openMachineRelay`, `handleRelayMessage`, `handleRelayClose`

- [ ] **Step 1: 在 `openMachineRelay` 的 entry 创建时存储 `sessionId`**

在 `openMachineRelay` 函数中（约第 233 行），创建 entry 时添加 `sessionId` 字段：

```typescript
const entry: RelayConnectionEntry = {
  agentId,
  userId,
  unsub: null,
  keepalive: relayKeepalive,
  ws,
  openTime: Date.now(),
  instanceId: machineConn.machineId,
  relayHandle: null,
  relayUnsub: null,
  sessionId,  // 存储远端路径的 sessionId
  outboundBuffer: [],
  sessionStarted: false,
};
```

同样在 `openLocalRelay` 的 entry 创建时（约第 183 行）添加：

```typescript
const entry: RelayConnectionEntry = {
  agentId,
  userId,
  unsub: null,
  keepalive: relayKeepalive,
  ws,
  openTime: Date.now(),
  instanceId,
  relayHandle: handle,
  relayUnsub: null,
  sessionId,  // 存储本地路径的 sessionId
  outboundBuffer: [],
  sessionStarted: true,
};
```

- [ ] **Step 2: 修改 `handleRelayMessage` 远端路径使用 `entry.sessionId`**

在 `handleRelayMessage` 中（约第 385-389 行），将 `relayWsId` 替换为 `entry.sessionId`：

```typescript
// 远端 machine 路径：通过 machine WS 转发
if (entry.instanceId) {
  const machineConn = findMachineConnectionById(entry.instanceId);
  if (!machineConn) {
    sendToRelayWs(ws, { type: "error", payload: { message: "Machine offline" } });
    return;
  }

  if (!entry.sessionStarted && parsed.type !== "list_sessions") {
    entry.outboundBuffer.push(parsed);
    return;
  }

  sendToWs(machineConn.ws, {
    type: "session_data",
    session_id: entry.sessionId,  // 使用 entry 中存储的 sessionId
    payload: parsed,
  });
  return;
}
```

- [ ] **Step 3: 修改 `handleRelayClose` 远端路径使用 `entry.sessionId`**

在 `handleRelayClose` 中（约第 417-422 行）：

```typescript
// 发送 session_end 到 machine WS（远端路径）
if (entry.instanceId && !entry.relayHandle) {
  const machineConn = findMachineConnectionById(entry.instanceId);
  if (machineConn) {
    sendToWs(machineConn.ws, { type: "session_end", session_id: entry.sessionId });
  }
}
```

- [ ] **Step 4: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/types/store.ts src/transport/relay/relay-handler.ts
git commit -m "fix: 统一远端路径 session_id，解决 session_start/session_data/session_end ID 不一致"
```

---

### Task 6: onSessionMessage 按 sessionId 过滤 + 回调链清理（C-04, C-05）

**Files:**
- Modify: `src/transport/relay/relay-handler.ts` — `openMachineRelay`, `handleRelayClose`
- Modify: `src/types/store.ts` — `RelayConnectionEntry`

这是最复杂的修复。将 `onSessionMessage` 从链式覆盖改为 `sessionId → callback` Map 分发。

- [ ] **Step 1: 在 `AcpConnectionEntry` 中添加 `sessionMessageListeners` Map**

在 `src/types/store.ts` 的 `AcpConnectionEntry` 接口中，替换 `onSessionMessage` 为 `sessionMessageListeners`：

```typescript
export interface AcpConnectionEntry {
  agentId: string | null;
  boundEnvId: string | null;
  userId: string;
  unsub: (() => void) | null;
  keepalive: ReturnType<typeof setInterval> | null;
  ws: WsConnection;
  openTime: number;
  lastClientActivity: number;
  capabilities: Record<string, unknown> | null;
  isMachine: boolean;
  machineId: string | null;
  wsId: string;
  /** relay 层注册的 per-session 消息回调（替代旧的 onSessionMessage 单回调） */
  sessionMessageListeners: Map<string, (sessionId: string, type: string, payload: unknown) => void>;
  /** @deprecated 使用 sessionMessageListeners 代替 */
  onSessionMessage?: (sessionId: string, type: string, payload: unknown) => void;
}
```

- [ ] **Step 2: 修改 `acp-ws-handler.ts` 中 session 消息分发逻辑**

在 `handleAcpWsMessage` 中（约第 228-234 行），将 session 消息从调用单个 `onSessionMessage` 改为遍历 `sessionMessageListeners`：

```typescript
if (entry.isMachine && SESSION_MSG_TYPES.includes(msg.type as string)) {
  const sessionId = msg.session_id as string | undefined;
  if (sessionId) {
    // 新分发模式：按 sessionId 查找注册的回调
    const listener = entry.sessionMessageListeners?.get(sessionId);
    if (listener) {
      listener(sessionId, msg.type as string, (msg as Record<string, unknown>).payload);
    }
    // 兼容旧回调
    if (entry.onSessionMessage) {
      entry.onSessionMessage(sessionId, msg.type as string, (msg as Record<string, unknown>).payload);
    }
  }
  continue;
}
```

- [ ] **Step 3: 在 `handleAcpWsOpen` 中初始化 `sessionMessageListeners`**

在 `handleAcpWsOpen` 中（约第 34 行和第 77 行），machine 连接初始化时添加 `sessionMessageListeners`：

```typescript
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
  sessionMessageListeners: new Map(),
});
```

- [ ] **Step 4: 重写 `openMachineRelay` 的消息回调注册**

替换 `openMachineRelay` 中的 `onSessionMessage` 链式覆盖为 `sessionMessageListeners.set`：

```typescript
function openMachineRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  machineConn: AcpConnectionEntry,
  agentPrompt: string | undefined,
  env: EnvironmentRecord,
): void {
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
    instanceId: machineConn.machineId,
    relayHandle: null,
    relayUnsub: null,
    sessionId,
    outboundBuffer: [],
    sessionStarted: false,
  };
  manager.add(relayWsId, entry);

  // 注册 per-session 消息回调（替代旧的链式 onSessionMessage 覆盖）
  const sessionCallback = (msgSessionId: string, type: string, payload: unknown) => {
    if (msgSessionId !== sessionId) return;
    const e = manager.get(relayWsId);
    if (!e || e.ws.readyState !== 1) return;

    switch (type) {
      case "session_started": {
        e.sessionStarted = true;
        for (const buffered of e.outboundBuffer) {
          sendToWs(machineConn.ws, {
            type: "session_data",
            session_id: sessionId,
            payload: buffered,
          });
        }
        e.outboundBuffer.length = 0;
        const caps = (payload as Record<string, unknown>)?.capabilities ?? {};
        sendToRelayWs(ws, { type: "status", payload: { connected: true, capabilities: caps } });
        break;
      }
      case "session_data":
        sendToRelayWs(ws, payload as object);
        break;
      case "session_ended":
      case "session_error":
        sendToRelayWs(ws, {
          type: "error",
          payload: { message: ((payload as Record<string, unknown>)?.error as string) || "Session ended" },
        });
        ws.close(1000, type);
        break;
      case "session_queued":
        sendToRelayWs(ws, { type: "status", payload: { connected: false, queued: true } });
        break;
      case "session_resumed":
        e.sessionStarted = true;
        sendToRelayWs(ws, { type: "status", payload: { connected: true, resumed: true } });
        break;
    }
  };

  // 初始化 sessionMessageListeners（如果不存在）
  if (!machineConn.sessionMessageListeners) {
    machineConn.sessionMessageListeners = new Map();
  }
  machineConn.sessionMessageListeners.set(sessionId, sessionCallback);

  // 发送 session_start 到 machine WS
  buildAndSendSessionStart(machineConn.ws, sessionId, agentId, userId, agentPrompt, env);

  // 超时处理：10s 内未收到 session_started，则失败
  const spawnTimeout = setTimeout(() => {
    const e = manager.get(relayWsId);
    if (e && !e.sessionStarted) {
      log(`[ACP-Relay] session_start timeout for ${relayWsId}`);
      sendToRelayWs(ws, { type: "error", payload: { message: "Agent spawn timeout" } });
      ws.close(1011, "spawn timeout");
      sendToWs(machineConn.ws, { type: "session_end", session_id: sessionId });
      manager.remove(relayWsId);
    }
  }, 10000);

  // session_started/session_queued/session_error 清除超时
  const timeoutClearCallback = (msgSessionId: string, type: string, _payload: unknown) => {
    if (msgSessionId !== sessionId) return;
    if (type === "session_started" || type === "session_queued" || type === "session_error") {
      clearTimeout(spawnTimeout);
      // 超时回调只需触发一次，收到后移除自身
      machineConn.sessionMessageListeners?.delete(`_timeout_${sessionId}`);
    }
  };
  machineConn.sessionMessageListeners.set(`_timeout_${sessionId}`, timeoutClearCallback);

  log(
    `[ACP-Relay] Machine relay established: relayWsId=${relayWsId} → machineId=${machineConn.machineId} sessionId=${sessionId}`,
  );
}
```

- [ ] **Step 5: 在 `handleRelayClose` 中清理 `sessionMessageListeners`**

在 `handleRelayClose` 中，远端路径发送 `session_end` 的地方（约第 417-422 行），添加 listener 清理：

```typescript
// 发送 session_end 到 machine WS（远端路径）
if (entry.instanceId && !entry.relayHandle) {
  const machineConn = findMachineConnectionById(entry.instanceId);
  if (machineConn) {
    sendToWs(machineConn.ws, { type: "session_end", session_id: entry.sessionId });
    // 清理 sessionMessageListeners 中注册的回调
    machineConn.sessionMessageListeners?.delete(entry.sessionId);
    machineConn.sessionMessageListeners?.delete(`_timeout_${entry.sessionId}`);
  }
}
```

- [ ] **Step 6: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/types/store.ts src/transport/acp-ws-handler.ts src/transport/relay/relay-handler.ts
git commit -m "fix: 重构 onSessionMessage 为 per-session Map 分发，修复多 relay 消息串扰和回调链泄漏"
```

---

### Task 7: 本地路径传递 agent_prompt 和 capabilities（C-01）

**Files:**
- Modify: `src/transport/relay/relay-handler.ts` — `openLocalRelay`, `handleRelayOpen`

- [ ] **Step 1: 将 `resolveAgentPrompt` 提升到 `handleRelayOpen` 公共路径**

在 `handleRelayOpen` 中，将 `resolveAgentPrompt` 调用从只在远端路径执行改为两条路径共用：

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

  // 查 agentConfig 获取 machineId 和 agentPrompt
  let machineId: string | null = null;
  let agentPrompt: string | undefined;
  if (env.agentConfigId) {
    const agentCfg = await getAgentConfigById(env.agentConfigId);
    machineId = agentCfg?.machineId ?? null;
    agentPrompt = agentCfg?.prompt as string ?? undefined;
  }

  if (machineId) {
    const machineConn = findMachineConnectionById(machineId);
    if (!machineConn) {
      sendToRelayWs(ws, { type: "error", payload: { message: "Machine offline" } });
      ws.close(4004, "machine offline");
      return;
    }
    setAgentMachineCache(agentId, machineId);
    openMachineRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, machineConn, agentPrompt, env);
  } else {
    await openLocalRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, env, agentPrompt);
  }
}
```

删除 `resolveAgentPrompt` 函数（已内联到上面的逻辑中）。

- [ ] **Step 2: 修改 `openLocalRelay` 签名，接收并使用 `agentPrompt`**

将 `_env` 改为 `env`，添加 `agentPrompt` 参数，在 `status` 消息中携带 `agent_prompt`：

```typescript
async function openLocalRelay(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId: string,
  env: EnvironmentRecord,
  agentPrompt?: string,
): Promise<void> {
  // ... ensureRunning 和 connectInstanceRelay 逻辑不变 ...

  // 5. 通知前端连接就绪（携带 agent_prompt）
  sendToRelayWs(ws, {
    type: "status",
    payload: { connected: true, agent_prompt: agentPrompt ?? null },
  });
  log(`[ACP-Relay] Local relay established: relayWsId=${relayWsId} agentId=${agentId} instanceId=${instanceId}`);
}
```

- [ ] **Step 3: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/transport/relay/relay-handler.ts
git commit -m "fix: 本地路径传递 agent_prompt，修复资源传递不对称问题"
```

---

### Task 8: 修复 handleRelayClose 本地路径条件（M-02）

**Files:**
- Modify: `src/transport/relay/relay-handler.ts:405-414`

- [ ] **Step 1: 将条件从 `entry.relayHandle && entry.instanceId` 简化为 `entry.relayHandle`**

```typescript
  // 关闭 relay handle（本地路径）
  if (entry.relayHandle) {
    if (entry.instanceId && !manager.hasOtherRelayForInstance(entry.instanceId, relayWsId)) {
      try {
        entry.relayHandle.close(1000, "relay disconnected");
      } catch {
        /* ignore */
      }
    }
    entry.relayUnsub?.();
  }
```

- [ ] **Step 2: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/transport/relay/relay-handler.ts
git commit -m "fix: handleRelayClose 本地路径只检查 relayHandle，避免 instanceId 为空时泄漏"
```

---

### Task 9: 清理兼容层重复代码（M-06, M-07）

**Files:**
- Modify: `src/transport/relay/relay-handler.ts` — 删除 `SpawnedInstance` 定义、`sendToAgentWs` 函数
- Modify: `src/transport/relay/index.ts` — 更新 re-export

- [ ] **Step 1: 删除 `relay-handler.ts` 中的 `SpawnedInstance` 接口（约第 432-444 行）**

删除整个 `export interface SpawnedInstance { ... }` 定义。

- [ ] **Step 2: 删除 `relay-handler.ts` 中的 `sendToAgentWs` 兼容层函数（约第 447-463 行）**

删除整个 `export function sendToAgentWs(agentId: string, msg: object): boolean { ... }` 函数。

- [ ] **Step 3: 更新 `relay/index.ts` 的 re-export**

```typescript
export type { ManagedConnection, RelayConnectionEntry } from "./connection-manager";
export { RelayConnectionManager, sendToRelayWs } from "./connection-manager";
export type { SpawnedInstance } from "../../services/instance";
export {
  closeAllRelayConnections,
  closeInstanceRelay,
  findRunningInstanceByEnvironment,
  handleMachineDisconnected,
  handleRelayClose,
  handleRelayMessage,
  handleRelayOpen,
  sendToInstanceRelay,
  spawnInstanceFromEnvironment,
} from "./relay-handler";
// sendToAgentWs 统一使用 acp-ws-handler.ts 的版本
export { sendToAgentWs } from "../acp-ws-handler";
```

- [ ] **Step 4: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transport/relay/relay-handler.ts src/transport/relay/index.ts
git commit -m "refactor: 删除 SpawnedInstance 重复定义和 sendToAgentWs 兼容层，统一使用 acp-ws-handler 版本"
```

---

### Task 10: `RelayConnectionManager.add` 防重复（M-08）

**Files:**
- Modify: `src/transport/relay/connection-manager.ts:11-13`

- [ ] **Step 1: 在 `add` 方法中先清理已存在的 entry**

```typescript
add(wsId: string, entry: RelayConnectionEntry): void {
  const existing = this.connections.get(wsId);
  if (existing) {
    // 防止重复 add 导致旧 entry 资源泄漏
    if (existing.keepalive) clearInterval(existing.keepalive);
    if (existing.unsub) existing.unsub();
    if (existing.relayUnsub) existing.relayUnsub();
  }
  this.connections.set(wsId, entry);
}
```

- [ ] **Step 2: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/transport/relay/connection-manager.ts
git commit -m "fix: RelayConnectionManager.add 防重复，先清理旧 entry 的资源"
```

---

### Task 11: handleRelayMessage 中 relay handle send 失败时关闭 WS

**Files:**
- Modify: `src/transport/relay/relay-handler.ts:364-368`

- [ ] **Step 1: catch 中向前端发 error 并关闭 WS**

将本地路径的 `relayHandle.send()` 错误处理从静默记录改为通知前端：

```typescript
  // 本地路径：通过 CoreRuntimeFacade relay handle 发送
  if (entry.relayHandle) {
    if (!entry.sessionStarted && parsed.type !== "list_sessions") {
      entry.outboundBuffer.push(parsed);
      return;
    }
    try {
      entry.relayHandle.send(parsed as { type: string; payload?: unknown });
    } catch (err) {
      logError("[ACP-Relay] relay handle send error:", err);
      sendToRelayWs(ws, { type: "error", payload: { message: "Agent connection error" } });
      ws.close(1011, "relay send failed");
    }
    return;
  }
```

- [ ] **Step 2: Run precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/transport/relay/relay-handler.ts
git commit -m "fix: relay handle send 失败时通知前端并关闭 WS，避免僵尸连接"
```

---

### Task 12: 最终验证和清理

- [ ] **Step 1: 运行完整 precheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck`
Expected: PASS — 格式化、lint、类型检查全部通过。

- [ ] **Step 2: 搜索残留的死代码引用**

```bash
grep -rn "resolveAgentPrompt" src/
grep -rn "pendingReconnect" src/
grep -rn "machineWsId" src/
```

确认 `resolveAgentPrompt` 已完全删除（被内联到 `handleRelayOpen`）。确认 `pendingReconnect` 和 `machineWsId` 字段仍保留（`handleMachineDisconnected` 使用）。

- [ ] **Step 3: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore: 清理 relay 重构残留代码"
```
