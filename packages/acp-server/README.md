# @fenix/acp-server

ACP 对话状态聚合库。将 ACP 事件流写入 Yjs CRDT 文档，通过 `yjs:update` 增量同步到前端。

## 安装

```bash
bun add @fenix/acp-server
```

依赖 `yjs`。Redis 模式额外依赖 `ioredis`，不用 Redis 可不装。

## 快速开始

### 后端：DocManager（推荐）

`DocManager` 管理 Chat / Session 两套 Y.Doc 的完整生命周期——创建、加载、写入、广播、关闭，
内置 ACP 事件微批次合并。

```typescript
import { DocManager } from "@fenix/acp-server";
import { getRedisConnection } from "./services/cache";
import { log, error as logError } from "@fenix/logger";

// 构造时注入 Redis 获取器（惰性求值，支持连接延迟建立）
const dm = new DocManager({
  getRedis: () => getRedisConnection(),
  onYjsUpdate: (docName, update) => {
    // 将所有 Y.Doc 变更广播给前端
    broadcastToClients(docName, Buffer.from(update).toString("base64"));
  },
  onLog: (msg) => log(msg),
  onError: (ctx, err) => logError(ctx, err),
});

// ─── Chat Doc ───
const chatDoc = await dm.openChat("rcs_agent001.user001");
dm.setChatConnectionStatus("rcs_agent001.user001", { status: "connected", since: Date.now() });
dm.setChatAgentInfo("rcs_agent001.user001", { id: "agent-1", name: "助手", model: { id: "gpt-4", name: "GPT-4" } });
dm.setChatCapabilities("rcs_agent001.user001", { streaming: true, tools: true });
dm.setChatModelState("rcs_agent001.user001", { currentModelId: "gpt-4", availableModels: [...] });
dm.setChatModeState("rcs_agent001.user001", { currentModeId: "code", availableModes: [...] });
dm.syncChatSessions("rcs_agent001.user001", [{ sessionId: "ses_001", title: "讨论方案", ... }]);
dm.setChatActiveSession("rcs_agent001.user001", "ses_001");

// ─── Session Doc ───
const sessionDoc = await dm.openSession("user-1", "agent-1", "rcs_agent001.user001");

// ACP 事件写入（内置微批次合并，16ms 窗口内多条消息合并为一个 yjs:update）
dm.processACP("rcs_agent001.user001", { type: "user_message_chunk", payload: { content: { type: "text", text: "你好" } } });
dm.processACP("rcs_agent001.user001", { type: "agent_message_chunk", payload: { content: { type: "text", text: "你好！" } } });
dm.processACP("rcs_agent001.user001", { type: "tool_call", payload: { id: "t1", name: "read_file", input: { path: "/src/app.ts" } } });
dm.processACP("rcs_agent001.user001", { type: "tool_call_result", payload: { id: "t1", output: "..." } });
dm.processACP("rcs_agent001.user001", { type: "prompt_complete", payload: { stopReason: "end_turn" } });

// Session 切换编排
await dm.switchSession(chatDoc, (msg) => relayHandle.send(msg), "rcs_agent001.user001", "ses_new");
// → 自动确保 Session Doc 在内存 → 发 session/load RPC → 更新 activeSessionId

// 会话切换前清空旧内容（原地清空，避免 destroy+recreate 竞态）
dm.clearSessionDocContent("rcs_agent001.user001");

// ─── 清理 ───
await dm.closeSession("rcs_agent001.user001");
await dm.closeChat("rcs_agent001.user001");
// 或一键关闭全部
await dm.closeAll();
```

### 前端：消费 Yjs 状态

两套 Doc 通过 `useChatState` / `useSessionState` hook 消费，字段齐全且类型安全。
WS 连接通过 `createYjsWsClient` 管理（同构实现，浏览器和 Bun 均可使用）。

```typescript
import { createDeterministicRcsSessionId, createYjsWsClient } from "@fenix/acp-server";
import type { ChatStateSnapshot, SessionStateSnapshot } from "@fenix/acp-server";
import { useChatState } from "./hooks/use-chat-state";
import { useSessionState } from "./hooks/use-session-state";
import { buildYjsUrl } from "./yjs/yjs-ws";  // 项目侧提供 URL

function ChatPanel({ agentId }: { agentId: string }) {
  const userId = useUserId();
  const rcsSessionKey = createDeterministicRcsSessionId(agentId, userId);

  // ─── Chat Doc 状态 ───
  const { state: chat, applyUpdate: chatApply } = useChatState(rcsSessionKey);

  chat.agentInfo;        // { id, name, avatar?, model? }
  chat.sessions;         // SessionSummary[]
  chat.activeSessionId;  // string
  chat.connection;       // { status, since }
  chat.capabilities;     // { [key]: any }
  chat.modelState;       // { currentModelId, availableModels[] }
  chat.modeState;        // { currentModeId, availableModes[] }
  chat.availableCommands;// { name, description? }[]
  chat.tokenUsage;       // { totalTokens?, inputTokens?, outputTokens? }
  chat.permissions;      // PermissionRequest[]

  // ─── Session Doc 状态 ───
  const { state: session, applyUpdate: sessionApply } = useSessionState(rcsSessionKey);

  session.acpSessionId;  // ACP 协议层的 session id（ses_xxx）
  session.status;        // "idle" | "loading" | "thinking" | "responding" | "tool-calling" | "waiting-user" | "error" | "done"
  session.loading;       // { kind, label?, since } | null
  session.messages;       // SessionMessage[]
  session.structuredMessages; // StructuredMessage[] — 结构化消息时间线
  session.streaming;     // { text?, reasoning? }
  session.tools;         // Record<string, ToolRun> — 工具执行状态
  session.artifacts;     // ArtifactRef[] — 产物引用

  // 连接 Yjs WS
  useEffect(() => {
    const client = createYjsWsClient({
      url: buildYjsUrl(agentId),
      onYjsUpdate: (docName, data) => {
        if (docName.startsWith("chat:")) chatApply(data);
        else if (docName.startsWith("session:")) sessionApply(data);
      },
      onConnectionState: (state) => setConnectionStatus(state),
    });
    client.connect();
    return () => client.disconnect();
  }, [agentId]);

  // 发送消息——前端只发 intent，不直接写 Y.Doc
  const sendMessage = (text: string) => {
    ws.send({ action: "send_prompt", content: [{ type: "text", text }] });
  };
}
```

也支持在 Bun 服务端作为 WS 客户端使用：

```typescript
import { createYjsWsClient } from "@fenix/acp-server";

const client = createYjsWsClient({
  url: "ws://localhost:3000/acp/yjs/agent-1",
  onYjsUpdate: (docName, data) => {
    // Y.applyUpdate(ydoc, data)...
  },
});
client.connect();
```

## API

### DocManager（推荐）

```typescript
new DocManager(options?: DocManagerOptions)
```

管理 Chat / Session 两套 Y.Doc 的完整生命周期。

**构造选项**：

| 选项 | 类型 | 说明 |
|------|------|------|
| `getRedis` | `() => Redis \| null` | Redis 获取器（惰性求值） |
| `onYjsUpdate` | `(docName, update) => void` | Y.Doc update 广播回调 |
| `onError` | `(context, err) => void` | 错误回调 |
| `onLog` | `(msg) => void` | 日志回调 |
| `acpBatchWindowMs` | `number` | ACP 批处理窗口，默认 16ms |

**实例方法**：

```typescript
// ── Broadcast ──
dm.setBroadcastHandler(handler)                     // 设置/清除广播回调

// ── Chat Doc ──
await dm.openChat(rcsSessionId)                     // 打开或获取 Chat Doc（可选 Redis 恢复）
dm.getChat(rcsSessionId)                            // 获取 Chat Doc（不创建）
await dm.closeChat(rcsSessionId)                    // 关闭并销毁 Chat Doc
dm.getChatYdoc(rcsSessionId)                        // 获取底层 Y.Doc

// ── Chat 状态写入 ──
dm.setChatConnectionStatus(rcsSessionId, status)    // 连接状态
dm.setChatAgentInfo(rcsSessionId, info)             // Agent 信息
dm.setChatCapabilities(rcsSessionId, caps)          // 能力集
dm.setChatModelState(rcsSessionId, state)           // 模型选择
dm.setChatModeState(rcsSessionId, state)            // 模式选择
dm.setChatAvailableCommands(rcsSessionId, cmds)     // 可用命令
dm.setChatTokenUsage(rcsSessionId, usage)           // Token 用量
dm.setChatActiveSession(rcsSessionId, acpSessionId) // 设置活跃 session

// ── Session 列表 ──
dm.registerSession(rcsSessionId, summary)           // 追加 session
dm.syncChatSessions(rcsSessionId, sessions)         // 全量同步（差异检测，无变化跳过事务）
dm.updateSessionSummary(rcsSessionId, id, patch)    // 更新单条 session

// ── Permission ──
dm.handlePermissionRequest(rcsSessionId, perm)      // 添加权限请求
dm.handlePermissionResolution(rcsSessionId, id, d)  // 权限决议

// ── Session Doc ──
await dm.openSession(userId, agentId, rcsSessionId) // 打开或获取 Session Doc
dm.getSession(rcsSessionId)                         // 获取 Session Doc
await dm.closeSession(rcsSessionId)                 // 关闭并销毁 Session Doc
dm.getSessionYdoc(rcsSessionId)                     // 获取底层 Y.Doc
dm.clearSessionDocContent(rcsSessionId)             // 原地清空 Session Doc 内容
dm.hasSessionDocContent(rcsSessionId)               // 检查是否有消息内容

// ── ACP 事件 ──
dm.processACP(rcsSessionId, event)                  // 处理 ACP 事件（内置微批次合并）
dm.registerUserMessage(rcsSessionId, content)       // 注册用户消息

// ── Session 切换 ──
await dm.switchSession(chatDoc, send, rcsSessionId, acpSessionId)
// 编排：确保 Session Doc 在内存 → 发 session/load → 更新 activeSessionId

// ── 清理 ──
await dm.closeAll()                                 // 关闭所有 Doc 并清理内部状态
```

### aggregator

`applyACPEvent(doc.ydoc, event)`

将 ACP 事件写入 Session Doc。`event.type` 支持：`agent_message_chunk`、`agent_thought_chunk`、`prompt_complete`、`agent_message_complete`、`user_message_chunk`、`tool_call`、`tool_call_result`、`tool_call_error`、`tool_call_update`、`plan`、`session_update`、`session_error`、`error`。

### chat-writer

```typescript
syncSessions(ydoc, sessions)            // 全量同步会话列表（差异检测，无变化跳过事务）
setConnectionStatus(ydoc, status)       // 连接状态
setAgentInfo(ydoc, info)                // Agent 信息
setActiveSession(ydoc, sessionId)       // 切换活跃 session
setSwitchingSession(ydoc, switching)    // 设置切换中标志
setCapabilities(ydoc, caps)             // Agent 能力集
setModelState(ydoc, state)              // 模型选择
setModeState(ydoc, state)               // 模式选择
setAvailableCommands(ydoc, commands)    // 可用命令
setTokenUsage(ydoc, usage)              // Token 用量
addSession(ydoc, session)               // 追加一条 session
updateSession(ydoc, id, patch)          // 更新单条 session
addPermission(ydoc, perm)               // 权限请求
resolvePermission(ydoc, id, decision)   // 权限决议
clearSessionYDocContent(ydoc)           // 原地清空 Session Doc（会话切换用）
```

### factory

```typescript
createChatDoc(rcsSessionId, redis?)      // 新建 Chat Doc
loadChatDoc(rcsSessionId, redis?)        // 创建并从 Redis 恢复已有状态
createSessionDoc(rcsSessionId, redis?)   // 新建 Session Doc
loadSessionDoc(rcsSessionId, redis?)     // 创建并从 Redis 恢复已有状态
```

### persist (redis)

```typescript
import { createRedisProvider, persistYjsClearedSnapshotWithCas } from "@fenix/acp-server";

const provider = createRedisProvider(redis, "chat:rcs_agent001.user001", ydoc);
// → ydoc.on("update") 自动持久化到 Redis（CAS 原子写入）
// → Redis Pub/Sub 自动跨实例同步 update
await provider.destroy();

// 持久化清空后的 session 快照（CAS 带重试）
await persistYjsClearedSnapshotWithCas(redis, redisKey, update, clearSessionYDocContent);
```

### protocol (translator)

```typescript
import { translateSimpleAction } from "@fenix/acp-server";

translateSimpleAction({ action: "send_prompt", content: [...] }, workspacePath?)
// → { jsonrpc: "2.0", id: 1, method: "session/prompt", params: { content: [...] } }
```

支持 10 种 action：`send_prompt`、`cancel`、`create_session`、`load_session`、`resume_session`、`list_sessions`、`rename_session`、`delete_session`、`respond_permission`、`set_session_mode`。

### protocol (config-options)

```typescript
import { extractModelStateFromConfigOptions, extractModeStateFromConfigOptions } from "@fenix/acp-server";

extractModelStateFromConfigOptions(configOptions)   // → { currentModelId, availableModels }
extractModeStateFromConfigOptions(configOptions)     // → { currentModeId, availableModes }
```

从 agent status 消息的 `configOptions` 中提取模型和模式选择状态。

### util (id)

```typescript
import { createDeterministicRcsSessionId } from "@fenix/acp-server";

createDeterministicRcsSessionId("agent-1", "user-1")
// → "rcs_YWdlbnQtMQ.dXNlci0x"
```

前后端同构实现。同一 agent + user 始终生成相同 ID，作为 Y.Doc 的命名 key。

### util (key)

```typescript
import { stableKey } from "@fenix/acp-server";

stableKey(value)  // 对 JSON-like 值做稳定序列化
```

Map 按 key 排序，对象按属性名排序，用于 React memo/useMemo 去重。

### transport (ws)

```typescript
import { createYjsWsClient } from "@fenix/acp-server";

const client = createYjsWsClient({
  url: "ws://localhost:3000/acp/yjs/agent-1",
  onYjsUpdate: (docName, data) => { /* data 已解码为 Uint8Array */ },
  onConnectionState: (state) => { /* "connecting" | "connected" | "disconnected" */ },
});
client.connect();
client.send({ action: "send_prompt", content: [...] });
client.disconnect();
```

同构实现：浏览器用 `window.WebSocket`，Bun 用 `globalThis.WebSocket`。
自动重连（指数退避：1s→2s→4s→8s→16s→30s），
自动解析 `{ type: "yjs:update", docName, data }` 消息并 base64 解码。

URL 由调用方传入——不同环境下端口/协议不同，URL 构造逻辑应在项目侧处理。

## 类型

```typescript
import type {
  // 构造选项
  DocManagerOptions,

  // Doc 类型
  ACPEvent, ChatDoc, SessionDoc, RedisProvider,

  // 业务类型
  ConnectionStatus, AgentInfo, SessionSummary, PermissionRequest,

  // 状态快照（前端消费）
  ChatStateSnapshot, SessionStateSnapshot,

  // Session 内部类型
  SessionStatus, LoadingState, TokenUsage, ToolRun, ArtifactRef,
  SessionMessage, StructuredMessage, AssistantChunk,
  CapabilitiesInfo, ModelState, ModeState,
} from "@fenix/acp-server";
```

## License

MIT
