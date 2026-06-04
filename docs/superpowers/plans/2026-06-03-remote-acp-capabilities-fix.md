# 远程 ACP 路径 capabilities 对齐修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让远程节点的 ACP 能力（session/list、session/load 等）与本地节点完全对齐，前端能正确获取 capabilities。

**Architecture:** 本地路径中 acp-link server 的 `handleConnect` 会主动推送 `{type:"status", payload:{capabilities}}` 到前端。远程路径中 agent capabilities 只在 `InstanceManager.start()` 时获取并存在 dispatcher 的 state 中，前端无法通过 relay 获取。修复方案：确保远程路径中 status（带 capabilities）能正确到达前端，对齐本地路径的完整消息链路。

**Tech Stack:** TypeScript, ACP JSON-RPC protocol, WebSocket relay

---

## 问题根因

### 本地路径（正常工作）

```
前端 WS 连接 → 发 {type:"connect"} → relay-handle WS → acp-link server
→ handleConnect() → agent initialize → 返回 capabilities
→ sendMsg(ws, {type:"status", payload:{connected:true, capabilities}})
→ relay-handle onmessage → emit(parsed) → relay-handler onMessage
→ sendToRelayWs → 前端 protocol 收到 status → ACPState.setCapabilities
→ supportsSessionList = true → 前端可以调 listSessions
```

### 远程路径（断点）

```
前端 WS 连接 → 发 {type:"connect"} → RemoteRelayHandle.send()
→ transport.send({type:"relay", payload:{type:"connect"}})
→ 远程 acp-link client relay case → dispatcher.handleMessage({type:"connect"})
→ handleTransportMessage case "connect"
→ this.send({type:"status", payload:{connected:true, capabilities}})
→ relaySend 包装为 {type:"relay", payload:{type:"status",...}}
→ RCS acp-ws-handler injectMessage → RemoteTransport.handleMessage
→ sessionListeners → RemoteRelayHandle.onMessage
→ payload.type === "status" → listener({type:"status", payload:{...}})
→ relay-handler onMessage → type === "status" → sendToRelayWs → 前端
```

**理论上是通的**，但实际不工作。可能的原因有多个，需要逐个排查并修复。本计划分两步：先在本地 relay-handler 层面做一个防御性修复确保 capabilities 一定能到达前端，再排查远程链路中可能的断点。

## 涉及文件

| 文件 | 职责 |
|------|------|
| `src/transport/relay/relay-handler.ts` | relay 连接管理，forward 消息到前端 |
| `packages/remote-runtime/src/remote-relay-handle.ts` | 远程 relay handle，区分传输层和 JSON-RPC 消息 |
| `packages/acp-link/src/acp-dispatcher.ts` | ACP 消息分发器，处理 connect/status 等 |
| `packages/acp-link/src/client/instance-manager.ts` | 远程实例管理，创建 dispatcher |
| `packages/acp-link/src/client/state.ts` | 前端 ACP 状态管理 |
| `packages/acp-link/src/client/client.ts` | 前端 ACP 客户端 |

---

### Task 1: 在 relay-handler 中确保 capabilities 一定能到达前端

**问题：** relay-handler 的 `openLocalRelay` 在第 158 行发了一个不带 capabilities 的 status：`{type:"status", payload:{connected:true, agent_prompt}}`。本地路径靠 acp-link server 的 `handleConnect` 回传带 capabilities 的 status。远程路径中这个回传可能失败或被吞。

**修复：** 在 relay-handler 中，`handle` 的 `onMessage` 回调已经会转发 agent 的 status（含 capabilities）。但第 158 行的初始 status 不含 capabilities。如果远程路径的 agent status 没到达，前端就永远不知道支持哪些能力。

**确保对齐的方案：** relay-handler 层面不需要改——它已经正确转发所有 onMessage 收到的消息。问题可能在于远程路径的 `RemoteRelayHandle.onMessage` 没有收到 agent 的 status。需要确保远程链路完整。

**Files:**
- Modify: `src/transport/relay/relay-handler.ts:155-181`

- [ ] **Step 1: 在 relay-handler 的初始 status 中添加 capabilities（如果可获取）**

当前第 158 行只发 agent_prompt，不传 capabilities。如果实例已经在运行，可以从 core facade 获取 capabilities 并一并传递。但更简洁的方案是确保 agent 的 status 一定能通过 onMessage 回调到达。

先不做这步修改，先排查远程链路。

- [ ] **Step 2: 在 RemoteRelayHandle.onMessage 中添加调试日志**

在 `packages/remote-runtime/src/remote-relay-handle.ts` 的 `onSessionMessage` 回调中添加日志，确认远程 agent 的 status 消息是否到达。

```typescript
// remote-relay-handle.ts constructor 内
this.unsubSession = transport.onSessionMessage((instId, _sessId, msg) => {
  if (instId !== instanceId) return;
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (!payload || typeof payload !== "object") return;

  console.log(`[RemoteRelayHandle] onSessionMessage: instId=${instId} payload.type=${payload.type} jsonrpc=${(payload as Record<string, unknown>).jsonrpc}`);

  // 传输层消息
  if (typeof payload.type === "string") {
    console.log(`[RemoteRelayHandle] Forwarding transport message: type=${payload.type}`);
    for (const listener of this.messageListeners) {
      listener({ type: payload.type, payload: payload.payload });
    }
    return;
  }

  // JSON-RPC 消息
  if ((payload as Record<string, unknown>).jsonrpc === "2.0") {
    for (const listener of this.messageListeners) {
      listener(payload as unknown as EngineRelayMessage);
    }
    return;
  }
});
```

- [ ] **Step 3: Commit 调试日志**

```bash
git add packages/remote-runtime/src/remote-relay-handle.ts
git commit -m "chore(remote): 添加 RemoteRelayHandle 调试日志排查 capabilities 传递"
```

---

### Task 2: 确保远程 dispatcher 的 status 消息能回传到 RCS

**问题：** 远程 acp-link client 的 `relay` case 中，`dispatcher.handleMessage(relayPayload)` 处理 `{type:"connect"}` 后调用 `this.send({type:"status", ...})`。`send` 回调是 `relaySend`，它会把消息包装为 `{type:"relay", payload:{type:"status",...}}` 通过 WS 发回 RCS。

**Files:**
- Modify: `packages/acp-link/src/acp-dispatcher.ts:80-93`
- Modify: `packages/acp-link/src/server.ts:387-410`

- [ ] **Step 1: 在 acp-dispatcher 的 handleTransportMessage connect case 添加日志**

```typescript
// acp-dispatcher.ts handleTransportMessage case "connect"
case "connect":
  console.log(`[AcpDispatcher] connect received, hasConnection=${!!this.state.connection}, hasCapabilities=${!!this.state.agentCapabilities}`);
  if (this.state.connection) {
    this.send({
      type: "status",
      payload: {
        connected: true,
        agentInfo: { name: "remote-agent" },
        capabilities: this.state.agentCapabilities,
      },
    });
    console.log(`[AcpDispatcher] status sent with capabilities:`, JSON.stringify(this.state.agentCapabilities?.sessionCapabilities));
  }
  break;
```

- [ ] **Step 2: 在远程 acp-link client 的 relay case 添加日志**

```typescript
// server.ts createAcpClient relay case (line ~387)
case "relay": {
  const instId = msg.instance_id as string;
  const sessId = msg.session_id as string;
  const relayPayload = msg.payload;
  console.log(`[acp-client] relay received: instId=${instId} payload.type=${(relayPayload as Record<string, unknown>)?.type}`);
  if (instanceMgr.hasInstance(instId)) {
    const dispatcher = instanceMgr.getDispatcher(instId);
    if (dispatcher) {
      try {
        await dispatcher.handleMessage(relayPayload);
      } catch (err) {
        // ... existing error handling
      }
    }
  }
  // ... rest unchanged
}
```

- [ ] **Step 3: Commit 调试日志**

```bash
git add packages/acp-link/src/acp-dispatcher.ts packages/acp-link/src/server.ts
git commit -m "chore(acp): 添加远程链路调试日志排查 capabilities 回传"
```

---

### Task 3: 修复核心问题——确保远程路径的 capabilities 到达前端

基于调试日志确认断点后，实施核心修复。根据分析，最可能的断点是：

1. **远程 acp-link client 的 `relay` case 没有将 dispatcher 的 response 通过 `relaySend` 回传**——但实际上 dispatcher 的 `send` 回调就是 `relaySend`，所以应该能回传。
2. **RCS 的 `acp-ws-handler` 没有将 `relay` 类型消息路由到 `remoteTransport.injectMessage`**——但代码第 225-228 行已经做了。
3. **时序问题**：前端发 `connect` 时，远程 agent 的 `start` 可能还没完成，dispatcher 还没创建。

如果是时序问题（最可能），修复方案是：**在 relay-handler 的 `openLocalRelay` 完成后，主动获取 capabilities 并发送一个补充的 status 消息到前端**。

**Files:**
- Modify: `src/transport/relay/relay-handler.ts:155-181`

- [ ] **Step 1: 在 openLocalRelay 中，relay handle ready 后发送补充 status**

核心思路：relay handle 的 `onMessage` 回调已经会转发 agent 的 status。但如果 agent 的 status 在 `onMessage` 注册前就已经发出（时序问题），就会丢失。修复方式是在 `onMessage` 注册后，主动通过 relay handle 发送一个 `connect` 消息触发 agent 回传 status。

但更可靠的方案是：**不依赖 agent 的 connect/status 握手，而是在 relay-handler 层面直接从 RCS 已知的信息中构建 status 发给前端**。

远程实例的 capabilities 在 `InstanceManager.start()` 时通过 `start_result` 返回给了 RCS 的 `RemoteTransport`。但 `RemoteTransport` 只 resolve 了 `sendAndWait` 的 pending，capabilities 数据没有暴露给 relay-handler。

最简洁的方案：**让前端发的 `{type:"connect"}` 通过远程链路到达 dispatcher，dispatcher 回传 status（含 capabilities），确保这条链路完整且时序正确**。

在 `relay-handler.ts` 中，当前第 158 行发的初始 status 不含 capabilities。前端的 `connect` 消息通过 `outboundBuffer` 或直接通过 `relayHandle.send()` 发到 agent。agent 回传 status 后，通过 `onMessage` 转发到前端。

**关键修复：确保 `onMessage` 回调在初始 status 发送前注册，且 agent 的 status 能正确透传。**

当前代码流程：
1. 第 158 行：发初始 status（不含 capabilities）
2. 第 162 行：注册 `onMessage` 回调
3. 第 183 行：flush pending messages（包含前端的 `{type:"connect"}`）

如果前端的 `connect` 消息被 flush 后触发 agent 回传 status，此时 `onMessage` 已经注册，status 应该能到达前端。

**真正的问题可能是：前端的 `connect` 消息在 relay-handler flush pending 时被发送，但此时远程 agent 的 `start` 可能还没完成，dispatcher 还没创建，`{type:"connect"}` 到达远程 acp-link client 时没有对应的 dispatcher 处理。**

修复方案：在 `relay-handler.ts` 的 `openLocalRelay` 中，flush pending 消息后，**额外发送一个 `{type:"connect"}` 到 relay handle** 触发 agent 回传 status。这保证了即使在 flush 时 agent 还没 ready，后续的 connect 也能触发 status 回传。

```typescript
// relay-handler.ts openLocalRelay 中，flush pending 之后

// 5. 回放设置期间缓存的前端消息（connect、new_session 等）
const pending = pendingRelayMessages.get(relayWsId) ?? [];
pendingRelayMessages.delete(relayWsId);
if (pending.length > 0) {
  log(`[ACP-Relay] Flushing ${pending.length} pending message(s) for relayWsId=${relayWsId}`);
  for (const msg of pending) {
    try {
      entry.relayHandle!.send(msg as { type: string; payload?: unknown });
    } catch (err) {
      logError("[ACP-Relay] Failed to send buffered message:", err);
    }
  }
}

// 6. 对齐本地路径：发送 connect 触发 agent 回传 status（含 capabilities）
//    本地路径中 acp-link server handleConnect 会自动推送 capabilities，
//    远程路径依赖 dispatcher.handleTransportMessage("connect") 回传。
//    前端发的 connect 可能在 agent start 完成前被 flush 导致丢失，
//    这里额外发一次确保 capabilities 一定能到达前端。
try {
  entry.relayHandle!.send({ type: "connect" });
} catch {
  /* relay handle 可能还没 ready，忽略 */
}
```

- [ ] **Step 2: Commit 核心修复**

```bash
git add src/transport/relay/relay-handler.ts
git commit -m "fix(relay): 补发 connect 触发远程 agent 回传 capabilities

远程路径中前端发的 connect 可能在 agent start 完成前被 flush，
导致 dispatcher 未创建、capabilities 未回传。在 flush 后补发一次
connect 确保 agent status（含 sessionCapabilities 等）到达前端。"
```

---

### Task 4: 清理调试日志

**Files:**
- Modify: `packages/remote-runtime/src/remote-relay-handle.ts`
- Modify: `packages/acp-link/src/acp-dispatcher.ts`
- Modify: `packages/acp-link/src/server.ts`

- [ ] **Step 1: 移除 Task 1 和 Task 2 添加的调试日志**

删除 `console.log` 调试语句，保留有意义的日志（如 warning/error）。

- [ ] **Step 2: Commit 清理**

```bash
git add packages/remote-runtime/src/remote-relay-handle.ts packages/acp-link/src/acp-dispatcher.ts packages/acp-link/src/server.ts
git commit -m "chore: 清理远程链路调试日志"
```

---

### Task 5: 验证远程路径 capabilities 到达前端

- [ ] **Step 1: 启动 RCS + 远程 acp-link，检查前端 console 日志**

在前端浏览器 console 中，连接远程 agent 后检查：
- `ACPState.agentCapabilities` 是否非 null
- `ACPState.supportsSessionList` 是否为 true
- 侧边栏是否显示历史会话列表

- [ ] **Step 2: 检查 WS 消息流**

在浏览器 Network > WS tab 中，确认：
1. 收到 `{type:"status", payload:{connected:true, agent_prompt:...}}`（relay 层）
2. 收到 `{type:"status", payload:{connected:true, capabilities:{sessionCapabilities:{list:...}}}}`（agent 层）
3. 前端发送了 `session/list` JSON-RPC request
4. 收到了 `session/list` 的 JSON-RPC response

- [ ] **Step 3: 如果仍然不工作，回退到 Task 3 的备选方案**

如果补发 connect 仍然不工作（说明远程 acp-link client 的 relay case 没有正确处理），备选方案是在 RCS relay-handler 层面直接从 `InstanceManager` 获取 capabilities 并注入 status：

```typescript
// 备选：直接从远程 start_result 获取 capabilities 并注入
// 这需要在 RemoteTransport 或 RemoteRelayHandle 中暴露 capabilities
// 或者通过 core facade 的 instance store 获取
```

---

## Self-Review

**1. Spec 覆盖：** 核心需求是远程路径的 capabilities 对齐本地。Task 3 是核心修复，Task 1/2 是诊断步骤，Task 4 清理，Task 5 验证。

**2. 占位符扫描：** 备选方案（Task 5 Step 3）有部分占位符，但标注为"如果仍然不工作"的备选路径，实际执行时会根据 Task 5 Step 1/2 的结果决定是否需要。

**3. 类型一致性：** 所有涉及的类型（`EngineRelayMessage`、`TransportMessage`、`AgentCapabilities`）均为已有类型，未引入新类型。
