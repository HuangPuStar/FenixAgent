# ACP 会话重命名实现指南

> 面向 Agent 开发者：如何实现 ACP 协议的 session rename（会话重命名）

## 概述

用户在前端通过侧边栏右键/编辑按钮修改会话标题时，前端会通过 ACP 协议发送一条 `session/update` 通知（Notification，非 Request）。Agent 进程需要接收并处理这条通知，在内部更新会话标题，并在后续的 `session/list` 中返回新的 `title` 值。

**核心要点**：这是一条**通知**（无 `id`，无响应），不是请求。Agent 只需要接收并处理即可，不需要返回结果。

## 协议规范

### ACP 规范参考

rename 操作遵循 ACP 协议的 [Session Info Update](https://agentclientprotocol.com/rfds/session-info-update) RFD 草案。该草案定义了一个名为 `session_info_update` 的 session update 类型，通过已有的 `session/update` 通知通道双向传递。

### JSON-RPC 通知格式

前端发送的消息如下：

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "sess_abc123def456",
    "update": {
      "sessionUpdate": "session_info_update",
      "title": "新的会话标题"
    }
  }
}
```

**字段说明**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `method` | `string` | 是 | 固定为 `"session/update"` |
| `params.sessionId` | `string` | 是 | 被重命名的会话 ID |
| `params.update.sessionUpdate` | `string` | 是 | 固定为 `"session_info_update"` |
| `params.update.title` | `string \| null` | 否 | 新的标题；传 `null` 表示清除标题 |
| `params.update.updatedAt` | `string \| null` | 否 | ISO 8601 时间戳，通常由 agent 自行维护 |
| `params.update._meta` | `object \| null` | 否 | 扩展元数据 |

### 与 Request 的区别

`session/delete` 是请求（有 `id`，期望响应）：
```json
{ "jsonrpc": "2.0", "id": 3, "method": "session/delete", "params": { "sessionId": "..." } }
```

`session/update`（rename）是通知（无 `id`，不期望响应）：
```json
{ "jsonrpc": "2.0", "method": "session/update", "params": { ... } }
```

## 传输路径

```
前端 ACPClient.renameSession()
  → WebSocket → Relay Handler
  → acp-dispatcher.handleNotification()
  → AgentSideConnection.agent.notify("session/update", params)
  → Agent 进程 stdin
```

Relay 侧的 `acp-dispatcher` 已经实现了通知转发——收到无 `id` 的 JSON-RPC 消息且 `method` 为 `"session/update"` 时，会通过底层 ACP 连接原样转发给 Agent 进程。

## Agent 实现要点

### 1. 接收通知

在 Agent 进程的 JSON-RPC 消息处理循环中，区分 **Request**（有 `id`）和 **Notification**（无 `id`）。

收到 `method === "session/update"` 且 `id === undefined` 的消息时，检查 `params.update.sessionUpdate` 是否为 `"session_info_update"`。

**伪代码示例**：

```typescript
function handleMessage(msg: JsonRpcMessage) {
  if (msg.method === "session/update" && msg.id === undefined) {
    // 这是一个通知
    const { sessionId, update } = msg.params;
    if (update.sessionUpdate === "session_info_update") {
      handleSessionInfoUpdate(sessionId, update);
    }
    return; // 通知不需要回复
  }
  // ... 处理 Request ...
}
```

### 2. 更新标题

```typescript
function handleSessionInfoUpdate(
  sessionId: string,
  update: { title?: string | null; updatedAt?: string | null }
) {
  const session = findSession(sessionId);
  if (!session) return;

  if (update.title !== undefined) {
    session.title = update.title; // null 表示清除标题
  }
  if (update.updatedAt !== undefined) {
    session.updatedAt = update.updatedAt;
  }
  // 也可自行维护 updatedAt
  session.updatedAt = session.updatedAt ?? new Date().toISOString();

  persistSession(session);
}
```

### 3. 反映到 session/list

`session/list` 返回的 `SessionInfo` 对象应包含最新的 `title`：

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "sessions": [
      {
        "sessionId": "sess_abc123def456",
        "title": "新的会话标题",
        "cwd": "/workspace/org/user/env",
        "updatedAt": "2026-07-22T10:30:00Z"
      }
    ]
  }
}
```

### 4. 类型定义（TypeScript）

```typescript
interface SessionInfoUpdate {
  sessionUpdate: "session_info_update";
  title?: string | null;
  updatedAt?: string | null;
  _meta?: Record<string, unknown> | null;
}
```

## 兼容性

- **不支持 rename 的 Agent**：可以直接忽略 `sessionUpdate === "session_info_update"` 的通知。前端乐观更新标题后，如果 agent 在 `session/list` 中未返回新 title，前端会在下次轮询时恢复旧值。
- **Capability 声明**：目前 ACP 规范未要求 agent 在 capabilities 中显式声明 rename 支持。如果未来规范要求，可在 `agentCapabilities.sessionCapabilities.rename` 中声明。

## 删除操作参考

`session/delete` 是标准 ACP 请求（有 `id`，需回复），Agent 实现时需：

1. 删除会话持久化数据
2. 返回 `{ result: {} }` 或 `{ result: { deleted: true, sessionId: "..." } }`

```json
// 请求
{ "jsonrpc": "2.0", "id": 3, "method": "session/delete", "params": { "sessionId": "sess_abc123" } }

// 响应
{ "jsonrpc": "2.0", "id": 3, "result": {} }
```

## 相关链接

- [ACP Session Info Update RFD](https://agentclientprotocol.com/rfds/session-info-update)
- [ACP Session Delete 规范](https://agentclientprotocol.com/protocol/v1/session-delete)
- [ACP Schema](https://agentclientprotocol.com/protocol/v1/schema)
