# session/load 对话历史未 Replay 问题调查报告

**日期**：2026-06-03
**状态**：已定位根因（Agent 侧问题）

## 问题描述

前端通过侧边栏选择已有会话时，`session/load` JSON-RPC 请求能正确发送，response 能返回，但对话历史未被 replay 显示。用户看到的是空白聊天界面。

## 消息传递链路

```
前端 ACPClient.loadSession()
  → WS /acp/relay/:agentId
    → RCS relay handleRelayMessage()
      → relayHandle.send(jsonRpcRequest)
        → acp-link server.ts case "relay"
          → server.ts handleLoadSession()
            → SDK connection.loadSession()
              → opencode Agent (stdio)
```

回传路径：

```
Agent replay notifications → SDK sessionUpdate 回调 → sendMsg(ws, createNotification(...))
  → acp-link WS → RCS relay onMessage → sendToRelayWs → 前端 WS

Agent response → handleLoadSession → sendMsg(ws, createSuccessResponse(...))
  → acp-link WS → RCS relay onMessage → sendToRelayWs → 前端 WS
```

## 实际观测结果

### 前端 WS 消息时序（实测）

1. **步骤 1**（前端发出请求）：
```json
{"jsonrpc":"2.0","id":3,"method":"session/load","params":{"sessionId":"ses_xxx","cwd":"/path"}}
```

2. **步骤 3**（response 先到）：
```json
{"jsonrpc":"2.0","id":3,"result":{"sessionId":"ses_xxx"}}
```

3. **步骤 2**（replay notification 后到，且只有一个 available_commands_update）：
```json
{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"ses_xxx","update":{"sessionUpdate":"available_commands_update","availableCommands":[...]}}}
```

**实际时序为 1 → 3 → 2**，与 ACP 协议要求的 1 → 2 → 3 不符。且步骤 2 中没有 `user_message_chunk`、`agent_message_chunk`、`tool_call` 等对话历史。

### RCS 服务端日志

```
session loaded: ses_17500420dffeIh27p93bI5rkVZ cwd: /path/to/workspace
[RelayHandle] Inbound ← acp-link: type=undefined  bytes=167   ← response
[RelayHandle] Inbound ← acp-link: type=undefined  bytes=8014  ← notification
```

## 根因分析

通过分层加日志定位，发现两个独立问题：

### 问题 1：response 先于 replay notification（中间层时序问题）

**原因**：ACP SDK 的 `ClientSideConnection.sendRequest()` 在 `await` Agent response 期间不处理 incoming notification。Agent 按 ACP 协议先发 replay notification 再发 response，但 SDK 将 notification 积压，直到 `loadSession()` resolve 后才批量触发 `sessionUpdate` 回调。

**验证**：在 `server.ts handleLoadSession` 中 `loadSession()` resolve 后、发 response 前加 `await setTimeout(0)` 让出事件循环，时序变为 notification 先于 response。但此方案不可靠，已回退。

### 问题 2：对话历史未被 replay（Agent 侧问题，根因）

**原因**：**opencode Agent 在处理 `session/load` 时没有 replay 对话历史**。

验证过程：
1. 在 `SessionManager.sessionUpdate` 回调中加日志 → 无输出
2. 在 `InstanceManager.sessionUpdate` 回调中加日志 → 无输出
3. 在 `server.ts` 的 `sessionUpdate` 回调中加 `setTimeout(0)` → notification 变为先于 response 到达，但内容仍然只有 `available_commands_update`，无对话历史

**结论**：Agent 只发了一个 `available_commands_update` notification，没有 `user_message_chunk`、`agent_message_chunk`、`tool_call` 等对话历史 replay。这是 Agent 侧的实现缺陷。

## 修复

### 已修复

- **`src/transport/relay/relay-handler.ts:249`**：JSON-RPC 消息（无 `type` 字段）不再被 `sessionStarted` 检查阻断

```typescript
// 修复前：只有 list_sessions 类型消息能在 sessionStarted=false 时通过
if (!entry.sessionStarted && parsed.type !== "list_sessions") {

// 修复后：JSON-RPC 消息直接放行
const isJsonRpc = (parsed as Record<string, unknown>).jsonrpc === "2.0";
if (!entry.sessionStarted && !isJsonRpc && parsed.type !== "list_sessions") {
```

### 待修复（Agent 侧）

- opencode Agent 需要在 `session/load` 处理中实现对话历史 replay，通过 `session/update` notification 回传 `user_message_chunk`、`agent_message_chunk`、`tool_call` 等类型的消息
- 或者，如果 opencode 暂不支持 replay，RCS 前端需要做 fallback（load session 后不显示历史，只恢复上下文让用户继续对话）

### 已回退的调试改动

- `server.ts handleLoadSession` 中的 `setTimeout(0)` hack（不可靠，已回退）
- `session-manager.ts` 和 `instance-manager.ts` 的 `sessionUpdate` 回调调试日志（已清理）

## 调试过程

1. 追踪前端 `ACPClient.loadSession()` → `ACPProtocol` → `WSTransport` → RCS relay 的完整消息链路
2. 检查 relay 层 `handleRelayMessage` 的 `sessionStarted` 检查是否阻断 JSON-RPC 消息（发现并修复了放行问题）
3. 检查 `AcpDispatcher.handleLoadSession` 和 `SessionManager.handleJsonRpc` 的 `SESSION_LOAD` 分支
4. 确认消息到达 `server.ts` 的 `handleLoadSession`（通过 `session loaded:` 日志）
5. 在 `SessionManager` 和 `InstanceManager` 的 `sessionUpdate` 回调加日志 — 无输出，确认回调未在 loadSession await 期间触发
6. 在 `server.ts handleLoadSession` 加 `setTimeout(0)` — 确认 notification 积压可以释放，但内容只有 `available_commands_update`，无对话历史
7. 最终确认：opencode Agent 未实现 `session/load` 的对话历史 replay

## 涉及文件

| 文件 | 说明 |
|------|------|
| `src/transport/relay/relay-handler.ts` | relay 消息转发，JSON-RPC 放行修复 |
| `packages/acp-link/src/server.ts` | acp-link WS handler，`handleLoadSession` |
| `packages/acp-link/src/client/session-manager.ts` | SessionManager（旧模式） |
| `packages/acp-link/src/client/instance-manager.ts` | InstanceManager + AcpDispatcher |
| `packages/acp-link/src/acp-dispatcher.ts` | ACP 消息分发器 |
| `packages/acp-link/src/client/client.ts` | 前端 ACPClient |
| `packages/acp-link/src/client/protocol.ts` | 前端协议解析层 |
| `web/components/ACPMain.tsx` | 前端主面板，`handleSelectSession` + bootstrap |
| `web/components/ChatInterface.tsx` | 前端聊天界面，`sessionLoadedHandler` + `handleSessionUpdate` |
