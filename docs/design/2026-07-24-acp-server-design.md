# @fenix/acp-server 设计

> 日期: 2026-07-24
> 状态: 设计确认

## 1. 背景与动机

当前 ACP 消息流模型：Agent → relay 透明转发 → 前端接收原始 ACP chunk → 前端本地拼装消息状态。

**问题**：

- **前端是状态权威**，但前端不可靠（刷新即丢失、多 TAB 各自维护）
- **多端同步为零**：桌面/手机同时打开同一个 Agent 对话，各自看到不同状态
- **relay 是哑管道**，不关心消息语义，无法提供任何状态服务
- **服务端已有 `EventBus`、`agent-chat-service`**，但都只是进程内转发，不持久化

**改造目标**：服务端成为 ACP 对话状态的权威聚合源，前端退化为状态投影。底层用 Redis 持久化 + Yjs CRDT 保证多端同步。

**控制范围**：整个 Chat 视图的所有状态，排除右侧功能区（Agent 配置、知识库、Settings）。

## 2. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│  前端                                                    │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Chat 页面                                         │  │
│  │                                                    │  │
│  │  ┌───────────┐  ┌─────────────────┐  ┌──────────┐ │  │
│  │  │  Sidebar   │  │  Chat 区         │  │ 右侧     │ │  │
│  │  │            │  │                  │  │ (不由我) │ │  │
│  │  │ session    │  │ 连接状态/Agent   │  │          │ │  │
│  │  │ list       │  │ 消息/流式/工具   │  │ config   │ │  │
│  │  │            │  │ 权限弹窗/输入框  │  │ 知识库   │ │  │
│  │  └─────┬──────┘  └────────┬────────┘  └──────────┘ │  │
│  │        │                  │                          │  │
│  │        │       Chat Doc   │           Session Doc    │  │
│  │        │  ┌──────────┐    │    ┌──────────────┐     │  │
│  │        └──┤ chat:{..}│    └────┤ session      │     │  │
│  │           │ Y.Doc    │         │ :{acpSesId}  │     │  │
│  │           └──────────┘         │ Y.Doc        │     │  │
│  └────────────────┼───────────────┴──────┼─────────────┘  │
│                   │                      │                │
│  ─ ─ ─ ─ ─ relay WS (现有通道，复用) ─ ──┴ ─ ─ ─ ─ ─ ─ ─│
│                   │                      │                │
└───────────────────┼──────────────────────┼────────────────┘
                    │                      │
┌───────────────────┼──────────────────────┼────────────────┐
│  RCS Server       │                      │                │
│                   │                      │                │
│  ┌────────────────┴──── session-state-service ────────┐   │
│  │                                                     │   │
│  │  chDocs: Map<chatKey, Y.Doc>                        │   │
│  │  sesDocs: Map<acpSessionId, Y.Doc>                  │   │
│  │                                                     │   │
│  │  ┌─ Chat Doc 写入 ──────────────────────────────┐   │   │
│  │  │ setConnectionStatus / setAgentInfo            │   │   │
│  │  │ addSession / updateSession                    │   │   │
│  │  │ addPermission / resolvePermission             │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  │                                                     │   │
│  │  ┌─ Session Doc 写入 ───────────────────────────┐   │   │
│  │  │ applyACPEvent (aggregator)                    │   │   │
│  │  │ setLoading / clearLoading                     │   │   │
│  │  └──────────────────────────────────────────────┘   │   │
│  │                                                     │   │
│  └─────────┬───────────────────────────────┬───────────┘   │
│            │                               │                │
│  ┌─────────┴─────┐         ┌───────────────┴──────────┐   │
│  │ Redis Chat Doc │         │ Redis Session Doc        │   │
│  │ chat:{uid}:{aid}│        │ session:{acpSessionId}    │   │
│  └───────────────┘         └──────────────────────────┘   │
│                                                            │
└────────────────────────────────────────────────────────────┘
```

**关键约束**：Yjs Doc key 使用 **ACP session id**（`ses_xxx`），不是 RCS session id（`session_xxx`/`cse_xxx`）。aggregator 和 ACP 协议、前端 ACPClient 统一使用 `ses_xxx`，避免 ID 空间混乱。

## 3. 库设计：`@fenix/acp-server`

### 3.1 目录结构

```
packages/acp-server/
├── package.json              # name: @fenix/acp-server
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── types.ts              # ACPEvent, SessionDoc, ChatDoc, SessionStatus, LoadingState
│   ├── doc-factory.ts        # createChatDoc / createSessionDoc / loadSessionDoc
│   ├── aggregator.ts         # applyACPEvent(doc, event) 纯函数
│   ├── chat-writer.ts        # Chat 层状态写入（setConnection 等）
│   ├── redis-provider.ts     # 薄封装 Redis 持久化 + pub/sub
│   └── __tests__/
│       ├── aggregator.test.ts
│       ├── chat-writer.test.ts
│       └── doc-factory.test.ts
```

**依赖**：`yjs`、`y-redis`（或自建 Redis 持久化 ~60 行），`ioredis` types only。

**零耦合**：不 import relay、Elysia、ACPClient、agent-chat-service 任何模块。

### 3.2 两层 Yjs Doc 模型

#### Chat 全局 Doc（长生命周期，每个 chat 入口一个）

```
Y.Doc("chat:{userId}:{agentId}")
├── agentInfo (Y.Map)
│   ├── id:       string
│   ├── name:     string
│   ├── avatar:   string
│   └── model:    { id, name }
│
├── sessions (Y.Array<Y.Map>)
│   └── [n] → {
│       id:         string          # ACP session id (ses_xxx)
│       title:      string          # 标题（可从首条消息提取）
│       preview:    string          # 最后一条消息预览
│       status:     string          # "idle"|"active"|"done"（summary 级别）
│       lastMsgTs:  number
│   }
│
├── chatMeta (Y.Map)
│   ├── activeSessionId: string    # 当前选中的 ACP session id
│   └── isSwitchingSession: boolean # session 切换过程中
│
├── connection (Y.Map)
│   ├── status:  "disconnected" | "connecting" | "connected"
│   └── since:   number             # 状态变更时间戳
│
└── permissions (Y.Array<Y.Map>)
    └── [n] → {
        id:       string
        tool:     string             # 请求权限的工具名
        args:     unknown            # 工具参数
        level:    "ask"
        status:   "pending" | "approved" | "denied"
        ts:       number
    }
```

#### Session 单例 Doc（每个 ACP session 一个）

```
Y.Doc("session:{acpSessionId}")
├── meta (Y.Map)
│   ├── status:        SessionStatus  # 见下方枚举
│   ├── acpSessionId:  string         # ses_xxx
│   ├── createdAt:     number
│   ├── updatedAt:     number
│   └── loading:       LoadingState | null  # 见下方定义
│
├── messages (Y.Array<Y.Map>)
│   └── [n] → { role: "user"|"assistant", content: string, seq: number, ts: number }
│
├── streaming (Y.Map)
│   ├── text:      string             # 当前流式文本（每次 chunk 累加）
│   └── reasoning: string             # 思考文本
│
├── tools (Y.Map<string, Y.Map>)
│   └── "t1" → { name, status: "running"|"done"|"error", input, output, startedAt }
│
└── artifacts (Y.Array<Y.Map>)
    └── [n] → { kind: "file"|"image"|"url", url: string, title: string, seq: number }
```

### 3.3 Loading 状态定义

```typescript
// types.ts

type SessionStatus =
  | "idle"             // 空闲，等待用户输入
  | "loading"          // 正在加载/恢复 session（有详情在 meta.loading）
  | "thinking"         // Agent 正在思考（尚未产生文本）
  | "responding"       // Agent 正在流式输出文本
  | "tool-calling"     // Agent 正在执行工具
  | "waiting-user"     // 等待用户审批权限
  | "error"            // 出错
  | "done";            // 本轮回复完成

interface LoadingState {
  /** 加载类型，前端据此选不同的 Loading UI */
  kind:
    | "session/bootstrap"       // session/new 或 session/load 中
    | "session/respond"         // 等待 agent 开始回复（发送消息后、第一个 chunk 前）
    | "tool/executing"          // 工具执行中
    | "permission/pending";     // 等待用户审批

  /** 可选提示文本，前端直接显示 */
  label?: string;

  /** 加载开始时间 */
  since: number;
}
```

**Loading 生命周期（全由服务端写入）**：

```
用户发送消息
  → meta.loading = { kind: "session/respond", label: "Agent is thinking...", since: T0 }
  → meta.status = "loading"

Agent 返回第一个 chunk
  → meta.loading = null
  → meta.status = "responding"

Agent 发起 tool_call
  → meta.status = "tool-calling"
  → 如果工具需要用户审批
    → meta.loading = { kind: "permission/pending", label: "Waiting for approval", since: T1 }
    → meta.status = "waiting-user"

用户打开 Chat 页面 / session 恢复
  → meta.loading = { kind: "session/bootstrap", label: "Loading session...", since: T_boot }
  → meta.status = "loading"
  → 恢复完成后 meta.loading = null, meta.status = "idle"
```

**前端只读，零决策**：

```tsx
const { loading, status } = sessionState.meta;

if (loading) {
  return <LoadingIndicator kind={loading.kind} label={loading.label} />;
}

// 无 loading 时按 status 渲染
<ChatView status={status} messages={messages} streaming={streaming} />
```

### 3.4 Aggregator

`applyACPEvent(doc: Y.Doc, event: ACPEvent): void`——纯函数，在 `doc.transact` 包裹中执行：

| ACP 事件 | 状态变更 |
|:--|:--|
| `agent_message_chunk` | `streaming.text += event.text`；`meta.status = "responding"`；`meta.loading = null` |
| `agent_thinking` | `streaming.reasoning += event.text`；`meta.status = "thinking"` |
| `prompt_complete` / `agent_message_complete` | `messages.push(完整消息)`；`streaming.text/元数据` 清空；`meta.status = "done"`；`meta.loading = null` |
| `tool_call_start` | `tools.set(id, { name, status: "running", input })`；`meta.status = "tool-calling"` |
| `tool_call_result` | `tools.get(id).set("status", "done")`；提取 artifacts |
| `permission_request` | → 不在 Session Doc 中，写入 Chat Doc 的 `permissions` |
| `session_update` | `meta.set("status", ...)`、元数据更新 |
| `user_message`（前端发送后服务端记录） | `messages.push(用户消息)`；`meta.status = "loading"`；`meta.loading = { kind: "session/respond" }` |
| `session/error` | `meta.status = "error"`；`meta.loading = null` |

### 3.5 Chat Writer（Chat 全局 Doc 写入函数）

```typescript
// chat-writer.ts——纯 Yjs 操作函数，不做 I/O

interface ChatWriter {
  setConnectionStatus(doc: Y.Doc, status: string): void;
  setAgentInfo(doc: Y.Doc, info: AgentInfo): void;
  addSession(doc: Y.Doc, session: SessionSummary): void;
  updateSession(doc: Y.Doc, acpSessionId: string, patch: Partial<SessionSummary>): void;
  setActiveSession(doc: Y.Doc, acpSessionId: string): void;
  setSwitchingSession(doc: Y.Doc, switching: boolean): void;
  addPermission(doc: Y.Doc, perm: PermissionRequest): void;
  resolvePermission(doc: Y.Doc, permId: string, decision: "approved" | "denied"): void;
}
```

### 3.6 Doc Factory

```typescript
// doc-factory.ts

// Chat 全局
createChatDoc(userId: string, agentId: string, redis: Redis): ChatDoc;
loadChatDoc(userId: string, agentId: string, redis: Redis): ChatDoc;

// Session 单例
createSessionDoc(acpSessionId: string, redis: Redis): SessionDoc;
loadSessionDoc(acpSessionId: string, redis: Redis): SessionDoc;

// key 规范：
//   Chat: "chat:{userId}:{agentId}"
//   Session: "session:{acpSessionId}"  ← ACP 的 ses_xxx，非 RCS id
```

### 3.7 Redis Provider

**职责**：

- `ydoc.on("update")` → `redis.set(docName, updateBuffer)`——状态变更持久化
- `redis.get(docName)` → `Y.applyUpdate(ydoc, buf)`——加载恢复
- `redis.publish(channel, updateBuffer)` + `subscribe`——跨 RCS 实例广播

**Redis key schema**：

```
yjs:chat:{userId}:{agentId}          # Chat Doc
yjs:session:{acpSessionId}           # Session Doc
```

## 4. Service 层：`session-state-service.ts`

### 4.1 职责

- 持有两层 Doc 的映射：`chDocs: Map<chatKey, ChatDoc>` / `sesDocs: Map<acpSessionId, SessionDoc>`
- 编排：openChat → openSession → processACP → closeSession → closeChat
- 向 relay handler 暴露调用点
- 管理 `acpSessionId ↔ relayWsId` 映射（ACP 和 RCS ID 是两个命名空间）

### 4.2 API

```typescript
// ── Chat 级别 ──
openChat(userId: string, agentId: string): Promise<ChatDoc>;
closeChat(userId: string, agentId: string): Promise<void>;

// Chat 状态写入
setConnectionStatus(chatDoc: ChatDoc, status: ConnectionStatus): void;
setAgentInfo(chatDoc: ChatDoc, info: AgentInfo): void;
addSession(chatDoc: ChatDoc, session: SessionSummary): void;
updateSession(chatDoc: ChatDoc, acpSessionId: string, patch: Partial<SessionSummary>): void;

// ── Session 级别 ──
openSession(chatDoc: ChatDoc, acpSessionId: string): Promise<SessionDoc>;
processACP(acpSessionId: string, event: ACPEvent): void;
switchSession(chatDoc: ChatDoc, relayHandle: EngineRelayHandle, acpSessionId: string): Promise<void>;
  // 编排 session 切换：确保 Doc 在内存 → agent session/load → 写 activeSessionId → 推全量
closeSession(acpSessionId: string): Promise<void>;

// ── 用户消息 ──
submitUserMessage(acpSessionId: string, content: string): void;
  // 写入 meta.loading + messages.push(user msg) → 调 ACPClient 发送

// ── 权限 ──
handlePermissionRequest(chatDoc: ChatDoc, acpSessionId: string, perm: ...): void;
resolvePermission(chatDoc: ChatDoc, permId: string, decision: "approved"|"denied"): void;
```

### 4.3 Session 切换流程

```
用户点击 Sidebar 的 session B（acpSessionId = "ses_B"）
  │
  ├─ 前端发送 relay WS 消息（intent，不是直接写 Yjs）
  │     { type: "session:switch", acpSessionId: "ses_B" }
  │
  ├─ 服务端收到 → session-state-service.switchSession()
  │     │
  │     ├─ 1. 确认 ses_B 在内存中
  │     │     if (!sesDocs.has("ses_B")) → loadSessionDoc("ses_B", redis)
  │     │                                    从 Redis 恢复该 session 的完整状态
  │     │
  │     ├─ 2. 通知 agent: relayHandle.send({
  │     │     jsonrpc: "2.0", method: "session/load",
  │     │     params: { sessionId: "ses_B" }
  │     │   })
  │     │   agent 端回放 session 历史（如 agent 有缓存）

  │     │   如果 agent 返回 session/load response（含事件回放），
  │     │   这些事件通过 aggregator 写入 ses_B 的 Session Doc
  │     │   如果 agent 没有历史（新 agent 实例），也不影响——
  │     │   Session Doc 从 Redis 恢复的已有状态就是完整的
  │     │
  │     ├─ 3. chatWriter.setActiveSession(chatDoc, "ses_B")
  │     │     Chat Doc 更新 → 所有连接的前端 Sidebar 同步高亮 B
  │     │
  │     └─ 4. 向前端推送 ses_B 的全量状态（Y.encodeStateAsUpdate）
  │           （其他已连接客户端不需要——它们的 Session Doc 已有 ses_B 的状态）
  │
  └─ 前端收到 Chat Doc update + Session Doc update
        ├─ Sidebar 高亮 session B
        └─ ChatView 渲染 session B 的消息/工具/流式状态
```

**关键原则**：

- **前端只发 intent，不直接写 Yjs**——保证切换动作经过服务端编排
- **旧 session 不丢**——Session Doc 继续在内存中，agent 发来的 ACP 事件仍按事件中的 `sessionId` 路由写入正确的 Doc
- **切换与 agent 的 session/load 解耦**——即使 agent 没缓存，Session Doc 从 Redis 恢复的状态已是完整对话
- **跨 TAB 同步**——TAB A 切 session → Chat Doc 广播 → TAB B 的 Sidebar 也自动高亮新 session

### 4.4 与 relay handler 的集成

```typescript
// relay-handler.ts —— 现有 handleRelayOpen 中
handleRelayOpen → 
  openChat(userId, agentId) 然后 setConnectionStatus("connected") 然后 setAgentInfo(...)

// 现有 handleRelayMessage 中
agent→client 方向:
  processACP(acpSessionId, parseACPEvent(message))

// handleRelayClose 中
  closeSession(acpSessionId) 然后 setConnectionStatus("disconnected")

// relay WS 消息路由（新增 intent 消息类型）
client→server:
  { type: "session:switch", acpSessionId } → switchSession()
  { type: "session:new" }                 → createSession() → addSession()
  { type: "user:send", content }          → submitUserMessage()
  { type: "permission:resolve", permId, decision } → resolvePermission()
```

## 5. 前端 Yjs ↔ React 衔接

### 5.1 `useChatState` Hook（Chat 全局状态）

```typescript
// web/src/hooks/use-chat-state.ts

function useChatState(userId: string, agentId: string) {
  const chatDoc = useRef<Y.Doc>(null);
  const [chatState, setChatState] = useState<ChatState>(...);

  // observe → setState（同下节模式）

  return {
    agentInfo,        // 头部显示
    sessions,         // Sidebar 渲染
    activeSessionId,  // 当前选中的 session
    connection,       // 顶部连接状态
    permissions,      // 权限弹窗
    applyUpdate,      // 供 relay WS 调用
  };
}
```

### 5.2 `useSessionState` Hook（Session Doc）

```typescript
// web/src/hooks/use-session-state.ts

function useSessionState(acpSessionId: string) {
  const ydocRef = useRef<Y.Doc>(null);
  const [state, setState] = useState<SessionState>({
    status: "idle",
    loading: null,
    messages: [],
    streaming: null,
    tools: new Map(),
    artifacts: [],
  });

  useEffect(() => {
    const ydoc = new Y.Doc();
    ydocRef.current = ydoc;

    const meta = ydoc.getMap("meta");
    const messages = ydoc.getArray("messages");
    const streaming = ydoc.getMap("streaming");
    const tools = ydoc.getMap("tools");
    const artifacts = ydoc.getArray("artifacts");

    const updateState = () => setState({
      status: meta.get("status") || "idle",
      loading: meta.get("loading") || null,
      messages: messages.toArray().map(m => m.toJSON()),
      streaming: streaming.size ? streaming.toJSON() : null,
      tools: new Map(Array.from(tools.entries()).map(([k, v]) => [k, v.toJSON()])),
      artifacts: artifacts.toArray().map(a => a.toJSON()),
    });

    meta.observe(updateState);
    messages.observe(updateState);
    streaming.observe(updateState);
    tools.observe(updateState);
    artifacts.observe(updateState);

    updateState();

    return () => ydoc.destroy();
  }, [acpSessionId]);

  const applyUpdate = useCallback((update: Uint8Array) => {
    ydocRef.current && Y.applyUpdate(ydocRef.current, update);
  }, []);

  return { state, applyUpdate };
}
```

### 5.3 Relay WS 分发

```typescript
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "yjs:update" && msg.docName) {
    const binary = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
    // 根据 docName 分发给对应的 hook
    if (msg.docName.startsWith("chat:")) {
      chatApplyUpdate(binary);
    } else if (msg.docName.startsWith("session:")) {
      sessionApplyUpdate(binary);
    }
  }
};
```

### 5.4 组件层次

```tsx
<ChatPage userId={uid} agentId={aid}>
  {/* useChatState → 消费 Chat Doc */}
  <Sidebar
    sessions={sessions}
    activeSessionId={activeSessionId}
    onSelect={(acpSessionId) => {
      // 发 intent，服务端编排切换，不直接写 Yjs
      ws.send({ type: "session:switch", acpSessionId });
    }}
  />
  <ConnectionBar status={connection.status} />
  <PermissionDialog permissions={permissions} />

  <ChatPanel acpSessionId={activeSessionId}>
    {/* useSessionState → 消费 Session Doc */}
    <ChatView
      status={state.status}
      loading={state.loading}       // ← 直接读，服务端决定
      messages={state.messages}
      streaming={state.streaming}
      tools={state.tools}
    />
    <Composer                         // 本地状态，不下沉
      onSubmit={(content) => {
        ws.send({ type: "user:send", acpSessionId: activeSessionId, content });
      }}
    />
  </ChatPanel>

  <RightPanel>                      {/* 不在控制范围 */}
    <AgentConfig />
    <KnowledgeBase />
    <Settings />
  </RightPanel>
</ChatPage>
```

### 5.5 前后端状态分工

| 状态 | 权威源 | 说明 |
|:--|:--|:--|
| `connection.status` | 服务端 | relay 建立/断开时写入 |
| `agentInfo` | 服务端 | chat 初始化时从 config 查询写入 |
| `sessions[]` | 服务端 | session/new 时 push，含 title/preview/status |
| `activeSessionId` | **服务端** | 前端发 `session:switch` intent → 服务端编排切换后写入 Chat Doc → 广播所有前端 |
| `permissions[]` | 服务端 | agent 发 permission request → push；用户审批 → 服务端收到后 update |
| `meta.status` | 服务端 | aggregator 根据 ACP 事件推导写入 |
| `meta.loading` | 服务端 | 服务端全权控制 loading 起止 |
| `messages[]` | 服务端 | aggregator 拼装完整消息 |
| `streaming` | 服务端 | chunk 实时累积 |
| `tools` | 服务端 | tool call 生命周期 |
| `artifacts[]` | 服务端 | 工具输出中的资源提取 |
| 输入框内容 | **前端** | 本地 UI 状态，不进入 Yjs |
| 右侧功能区 | **前端** | 不在控制范围 |

## 6. 与现有系统的关系

| 组件 | 改动 | 说明 |
|:--|:--|:--|
| `packages/acp-server/` | **新增** | 独立库，零耦合 |
| `src/services/session-state-service.ts` | **新增** | Service 封装，编排两层 Doc |
| `src/services/cache.ts` | **不改** | 复用共享 Redis 连接 |
| `src/transport/relay/relay-handler.ts` | **加几行** | open/close/message 时调 service |
| `agent-chat-service.ts` | **不改** | 继续管理 AgentSession/PromptTurn |
| `event-bus.ts` | **不改** | 继续管理 SSE，互不干扰 |
| `connection-manager.ts` | **不改** | 继续管理 WS 连接 |
| 前端 `ChatInterface.tsx` | **改** | 删除 ~380 行状态聚合代码（`applySessionUpdateToEntries` 等），替换为 `useYDoc`/`useChatState` hooks |
| 前端 ACPClient | **保留** | 仅用于发送 session/prompt |

## 7. 可删除的前端代码

| 代码 | 估计行数 | 理由 |
|:--|:--|:--|
| `applySessionUpdateToEntries` | ~220 | 由服务端 aggregator 替代 |
| `findToolCallIndex` | ~10 | Y.Map.get(id) O(1) 直接定位 |
| `mapToolStatus` | ~8 | 不再需要手动映射 |
| `finalizeRunningToolCalls` | ~36 | aggregator 在 prompt_complete 时处理 |
| `handleSessionUpdate` 主体逻辑 | ~100 | 被 useSessionState 的 observe 替代 |
| Loading 状态判定逻辑 | ~30 | 全由 meta.loading 驱动 |
| `toolEndStatusRef` / `wasLoadingBeforeDisconnect` 等 | ~6 refs | 服务端是全量状态，不需要前端 ref 追踪 |
| **合计** | ~**410** | 约占 ChatInterface 状态逻辑的 60%+ |

## 8. 传输层设计

### 8.1 协议无关性

`@fenix/acp-server` 不绑定传输协议。Y.Doc update 是 `Uint8Array` 二进制块。初期复用 relay WS 通道添加 `yjs:update` 消息类型。

### 8.2 初期策略：复用 relay WS

```
relay WS 消息协议新增:

  server→client:
    { type: "yjs:update", docName: "chat:{userId}:{agentId}" | "session:{acpSessionId}", data: <base64> }

  client→server (state intent，服务端编排后写入 Yjs):
    { type: "session:switch", acpSessionId }
    { type: "session:new" }
    { type: "user:send", content }
    { type: "permission:resolve", permId, decision }
```

服务端监听 `ydoc.on("update")` → 通过 relay connection manager 推送给所有该 chat 的前端连接。

### 8.3 迁移到 Socket.IO

| 阶段 | 传输 | 分布式 |
|:--|:--|:--|
| 1. 当前 | relay WS 新增 `yjs:update` | 单实例验证聚合逻辑 |
| 2. 扩展 | 同上 | 多实例 + Redis pub/sub |
| 3. 升级 | Socket.IO 替换 | Socket.IO Redis adapter |

**迁移成本**：`@fenix/acp-server` 一行不改，仅 service 层替换推送代码（`ws.send` → `io.emit`）。

## 9. 分布式与水平扩展

y-redis provider 的 pub/sub 天然解决：

```
Server A 更新 ydoc → redis.publish(update) → Server B subscribe → applyUpdate → 推本地客户端
```

`acp-server` 零改动。

## 10. 风险与边界

### 10.1 Yjs 内存

每个 Y.Doc 在内存中持有完整状态。大规模 session 需考虑：
- Chat/Session 关闭时 `ydoc.destroy()` 释放
- 活跃 session 数由 relay 连接数和 idle 回收机制控制

### 10.2 ACP 事件类型覆盖

初期覆盖核心类型（message_chunk / tool_call / session_update），未识别的类型不做处理。

### 10.3 ACP Session ID 映射

`acpSessionId`（`ses_xxx`）和 `relayWsId`（RCS 层标识）是两个独立命名空间。service 层需维护映射，确保 relay 连接断开时正确清理 Session Doc。

### 10.4 y-redis 兼容性

若不兼容现有 Redis Cluster，自建 pub/sub 层替代（~60 行）。
