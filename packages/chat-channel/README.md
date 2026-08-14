# @fenix/chat-channel

Chat 域独立包（合并原 `@fenix/acp-server` 全部能力）。覆盖三层职责：

- **协议基础（`src/protocol/`）**：ACP 入站规范化边界（`ACPChannel`，acp-link 私有帧与 JSON-RPC `session/update` 帧统一为规范化事件）、前端 action → ACP JSON-RPC 翻译、双格式兼容解析。
- **聚合层（`src/state/`）**：把规范化事件投影到 Yjs CRDT 文档（Chat Doc / Session Doc），微批次合并、Redis 快照持久化与广播回调。
- **控制面（`src/channel/`）**：YJS 前端 WebSocket 生命周期（Gateway）、会话频道与 Action/Ack 协议（SessionChannel / CommandCoordinator）、relay 入站消费与断链清理（RelayEventHandler）、同 `rcsSessionId` fan-out 与背压（YjsBroadcaster）。

宿主（主服务）只保留桥接层 `src/services/chat-channel-bootstrap.ts`（装配 `ChatChannelController` 单例），包内不直接 import 任何宿主模块。

架构契约见 `docs/arch/19-yjs-chat-streaming.md`（实现基线）；设计决策见 `spec/global/adr/2026-08-04-chat-channel-package-design.md`。

## 安装

```bash
bun add @fenix/chat-channel
```

依赖 `yjs`。Redis 模式额外依赖 `ioredis`，不用 Redis 可不装。

## 目录结构

```
src/
├── channel/     # 控制面（C3/C6/C7）：gateway、session-channel、command-coordinator、
│                #   relay-event-handler、broadcaster、connection-registry、action-forward
├── protocol/    # ACPChannel（私有帧规范化）、translator、config-options
├── state/       # aggregator、doc-manager、chat-writer、factory、permission、yjs-store
├── persist/     # redis provider（跨节点 pub/sub + CAS 快照持久化）
├── transport/   # createYjsWsClient（前端同构 WS 客户端）
├── util/        # createDeterministicRcsSessionId、stableKey
├── schema.ts    # Chat Doc / Session Doc 新 schema 与规范化事件类型
└── index.ts     # 稳定导出面
```

## 快速开始

### 后端：聚合层 DocManager

`DocManager` 管理 Chat / Session 两套 Y.Doc 的完整生命周期——创建、加载、写入、广播、关闭，
内置规范化事件微批次合并（默认 16ms 窗口）。

```typescript
import { DocManager } from "@fenix/chat-channel";

const dm = new DocManager({
  getRedis: () => getRedisConnection(),           // 惰性求值，Redis 不可用时自动降级 no-op
  onYjsUpdate: (docName, update) => {
    // 将所有 Y.Doc 变更广播给前端
    broadcastToClients(docName, Buffer.from(update).toString("base64"));
  },
  onError: (ctx, err) => logError(ctx, err),
});

// 打开两份 Doc（内存/Redis 模式）
await dm.openChat("rcs_agent001.user001");
await dm.openSession("user-1", "agent-1", "rcs_agent001.user001");

// 规范化事件写入（ACPChannel 翻译后的唯一入站形态；文本增量自动合并）
dm.processNormalizedEvent("rcs_agent001.user001", {
  type: "message_delta",
  update: { sessionUpdate: "agent_message_chunk" },
  content: { type: "text", text: "你好！" },
});
dm.processNormalizedEvent("rcs_agent001.user001", {
  type: "tool_call_started",
  update: { toolCallId: "t1", name: "read_file", status: "running" },
  content: null,
});
dm.processNormalizedEvent("rcs_agent001.user001", {
  type: "turn_completed",
  update: { stopReason: "end_turn" },
  content: null,
});

// 用户消息由服务端单写（返回 turnId，后续增量以此做映射幂等）
const turnId = dm.registerUserMessage("rcs_agent001.user001", "帮我读一下文件");

// 会话切换前原地清空旧内容（避免 destroy+recreate 竞态）
dm.clearChatDocContent("rcs_agent001.user001");
dm.clearSessionDocContent("rcs_agent001.user001");

// 清理（断链/回收路径：先注销广播监听再 destroy，见 channel/relay-event-handler.ts）
await dm.closeChat("rcs_agent001.user001");
await dm.closeSession("rcs_agent001.user001");
await dm.closeAll();
```

### 控制面：ChatChannelController（宿主桥接）

控制面各模块为纯协议实现，宿主能力全部经 `ChatChannelDependencies` 构造器注入
（环境解析、workspace、实例生命周期、relay 连接、空闲监控、Redis 快照、日志），
宿主侧通过 `src/services/chat-channel-bootstrap.ts` 装配单例：

```typescript
import { getChatChannelController } from "src/services/chat-channel-bootstrap";

const controller = getChatChannelController();
// WebSocket open / message / close 全部委托给 controller.gateway
await controller.gateway.handleOpen(ws, wsId, userId, agentId, rcsSessionId, sessionId);
await controller.gateway.handleMessage(ws, wsId, text);
controller.gateway.handleClose(wsId);
```

- Action 经 `SessionChannel` 归一化（信封字段由服务端按会话绑定补充）后进入 `CommandCoordinator`：
  `commandId` 幂等去重（每 `rcsSessionId` 进程内 Map，随实例生命周期释放）、
  `accepted → committed → duplicate` 两阶段 Ack、`ActionError` 稳定错误码、有界串行队列。
- 前端断开只释放连接级资源与 relay 引用计数；`relay_closed`（Instance ACP session 断链）
  删除该 `rcsSessionId` 的 Chat Doc / Session Doc / 广播订阅并触发实例级回收（两类断链语义）。
- 事件日志体系与租约不实现（评审决策）：`leaseEpoch` 类型占位，防重复副作用由 `commandId` 去重承担。

### 前端：消费 Yjs 状态

WS 连接通过 `createYjsWsClient` 管理（同构实现，浏览器和 Bun 均可使用），
两套 Doc 通过 `createYjsStore` + `useChatState` / `useSessionState` hook 消费。

```typescript
import { createDeterministicRcsSessionId, createYjsWsClient } from "@fenix/chat-channel";
import { useChatState } from "./hooks/use-chat-state";
import { useSessionState } from "./hooks/use-session-state";
import { buildYjsUrl } from "./yjs/yjs-ws"; // 项目侧提供 URL

function ChatPanel({ agentId }: { agentId: string }) {
  const userId = useUserId();
  const rcsSessionId = createDeterministicRcsSessionId(agentId, userId);

  const { state: chat, applyUpdate: chatApply } = useChatState(rcsSessionId);
  const { state: session, applyUpdate: sessionApply } = useSessionState(rcsSessionId);

  // Chat Doc（消息时间线）：entries / blocks / toolCalls 派生
  session.messages;             // 扁平消息列表
  session.structuredMessages;   // 结构化时间线
  session.streaming;            // { text, reasoning } 流式增量
  session.tools;                // 工具执行状态
  session.artifacts;            // 受授权资源引用

  // Session Doc（会话元信息 / Agent 状态）
  session.status;               // 展示状态（由 turnStatus 派生）
  session.turnStatus;           // 权威活动 turn 状态（Session Doc session.activeTurnStatus 平铺投影）
  session.turnUpdatedAt;        // 活动 turn 更新时间戳（Session Doc session.activeTurnUpdatedAt）

  useEffect(() => {
    const client = createYjsWsClient({
      url: buildYjsUrl(agentId),
      onYjsUpdate: (docName, data) => {
        // applyUpdate 签名 (docName, data)，内部按前缀路由（chat:/session:）；
        // 两个 hook 各持独立 store，必须都投递，否则对应快照不更新
        chatApply(docName, data);
        sessionApply(docName, data);
      },
      onConnectionState: (state) => setConnectionStatus(state),
    });
    client.connect();
    return () => client.disconnect();
  }, [agentId]);
}
```

发送 Action 时携带 `commandId`（UUID，重试复用同一 ID）：

```typescript
client.send({
  action: "send_prompt",
  commandId: crypto.randomUUID(),
  content: [{ type: "text", text: "你好" }],
});
```

## 协议基础

### ACPChannel（入站规范化）

```typescript
import { extractAcpEvent, extractJsonRpc, normalizeAcpMessage } from "@fenix/chat-channel";
```

- `extractJsonRpc`：兼容原始 `{ jsonrpc: "2.0", ... }` 与包裹 `{ type, payload: { jsonrpc: "2.0", ... } }`。
- `extractAcpEvent`：从 EngineRelay 消息提取事件类型与载荷（兼容 session/update 通知、session_data 包裹、原始引擎格式）。
- `normalizeAcpMessage`：把 acp-link 私有帧（`agent_message_chunk` / `agent_thought_chunk` / `prompt_complete` 等）
  翻译为规范化事件（`session/update` 语义）；聚合层只消费规范化事件，不接受私有帧。

### action → ACP JSON-RPC（translator）

```typescript
import { translateSimpleAction } from "@fenix/chat-channel";

translateSimpleAction({ action: "load_session", sessionId: "ses_001" }, workspacePath, rpcId);
// → { jsonrpc: "2.0", id: rpcId, method: "session/load", params: { sessionId: "ses_001", cwd: workspacePath } }
```

`cwd` 由服务端根据已认证 environment 注入，浏览器传入值不可信。

### util

```typescript
import { createDeterministicRcsSessionId, stableKey } from "@fenix/chat-channel";

createDeterministicRcsSessionId("agent-1", "user-1", sessionId?) // → "rcs_..."
// 前后端同构实现；同一 agent + user（+ DB session）始终生成相同 ID，作为 Y.Doc 命名 key

stableKey(value) // 对 JSON-like 值做稳定序列化（Map 按 key 排序），用于 memo/useMemo 去重
```

### transport (ws)

```typescript
import { createYjsWsClient } from "@fenix/chat-channel";

const client = createYjsWsClient({
  url: "ws://localhost:3000/acp/yjs/agent-1",
  onYjsUpdate: (docName, data) => { /* data 已解码为 Uint8Array */ },
  onConnectionState: (state) => { /* "connecting" | "connected" | "disconnected" */ },
});
client.connect();
client.send({ action: "send_prompt", commandId: "...", content: [...] });
client.disconnect();
```

同构实现：浏览器用 `window.WebSocket`，Bun 用 `globalThis.WebSocket`；自动重连（指数退避）；
自动解析 `{ type: "yjs:update", docName, data }` 并 base64 解码。URL 由调用方传入。

## 类型

```typescript
import type {
  // 协议基础
  NormalizedEvent, NormalizedEventType, SessionUpdate,
  // Action / Ack 协议
  ClientAction, ActionAck, ActionError, ActionType, Command,
  // Doc schema（5.2/5.3 投影类型）
  ChatEntry, ContentBlock, ToolCallProjection,
  SessionInfoProjection, AgentStatusProjection,
  PermissionProjection, TurnStatus,
  PublicError,
  // 前端快照
  ChatStateSnapshot, SessionStateSnapshot, SessionStatus,
} from "@fenix/chat-channel";
```

> 注：包对外统一导出 acp-link 的 `ContentBlock`（协议块类型）；Chat 域内部块类型
> （`schema.ts`）名字冲突，需从包内直接引用。

## 测试

```bash
cd packages/chat-channel && bun test
```

测试 seam 为 SessionChannel 协议层：包内集成测试实例化 `ChatChannelController`
（注入 fake 依赖：假 relay、假环境解析、内存 Redis 桩），用假连接对象发送 Action，
断言 `action_ack` / `action_error` 与 `yjs:update` 投影结果。无真实网络、无真实 Agent 进程。

## License

MIT
