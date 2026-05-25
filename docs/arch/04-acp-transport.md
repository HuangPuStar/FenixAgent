# ACP 传输层

> 对应文件：`src/transport/event-bus.ts`、`src/transport/acp-ws-handler.ts`、`src/transport/acp-relay-handler.ts`、`src/transport/sse-writer.ts`、`src/transport/acp-sse-writer.ts`、`src/transport/ws-handler.ts`、`src/transport/ws-types.ts`

## 这个模块干什么

传输层是 RCS 的消息中枢。它解决的核心问题是：**让前端和 AI Agent 之间能实时双向通信**。

前端和 Agent 不直接连接，中间隔着 RCS 服务器。传输层就是这段中间路——它接收一方的消息，转发给另一方，同时把消息广播给其他需要知道的模块（比如 Hermes IM 网关需要知道 Agent 的回复内容）。

## 三个核心组件

### 1. EventBus（`event-bus.ts`）

**一句话**：进程内的消息广播中心。

EventBus 是一个 pub/sub 系统，运行在同一个进程内（不是 Redis、不是消息队列）。它的作用是：当一条消息到达时，通知所有关心这条消息的人。

RCS 里有两套 EventBus：

| EventBus | key | 用途 |
|----------|-----|------|
| Session EventBus | sessionId | v1/v2 Worker 的事件流 |
| ACP EventBus | agentId（即 environmentId） | ACP 协议的消息路由 |

每条消息有一个 direction 标记：

- **inbound**（Agent → RCS）——Agent 发来的消息、状态更新、streaming chunk 等
- **outbound**（RCS → Agent）——要发给 Agent 的指令、prompt 等

EventBus 内部维护一个环形缓冲区（最多 5000 条），支持通过 `getEventsSince(seqNum)` 做增量拉取，用于 SSE 事件流补发。

### 2. ACP WS Handler（`acp-ws-handler.ts`）

**一句话**：处理 acp-link Agent 的 WebSocket 连接和注册。

这个模块管的是 `/acp/ws` 端点——acp-link Agent 连接 RCS 的入口。

**连接生命周期**：

```text
acp-link 连接 /acp/ws?token=xxx
        │
        ▼
  apiKeyAuth 校验（WS upgrade 阶段）
        │
        ▼
  创建 AcpConnectionEntry（记录 agentId、userId、WS 引用等）
        │
        ▼
  收到 register 或 identify 消息
        │
        ├─ 绑定到已有环境（持久 or 临时）
        ├─ 订阅 ACP EventBus（outbound 消息 → 转发给 acp-link）
        └─ 自动创建 session（如果环境还没有 session）
        │
        ▼
  进入稳态：
  - acp-link 发消息 → publish 到 EventBus（inbound）
  - EventBus outbound → 转发给 acp-link
  - 定时 keep_alive（默认 20s）
  - 无活动超时检测（keepalive × 3）
        │
        ▼
  断连处理：
  - 持久环境 → 状态改为 idle（不删除）
  - 临时环境 → 删除记录和关联 session
  - 通知 relay：agent 已离线
```

**两种绑定方式**：

- **直接 WS 注册**：acp-link 发送 `{"type": "register"}` 消息，服务端创建一个临时环境记录
- **WS + environment.secret 绑定**：WS upgrade 时 secret 匹配到持久环境，连接直接绑定，不需要 register 消息

### 3. ACP Relay Handler（`acp-relay-handler.ts`）

**一句话**：处理前端与 Agent 之间的 WebSocket 中继。

这个模块管的是 `/acp/relay/:agentId` 端点——前端连上来，通过 RCS 和 Agent 双向通信。

**两种工作模式**：

```text
前端连接 /acp/relay/:agentId?sessionId=xxx
        │
        ▼
  有 spawned instance 吗？
        │
   ┌────┴────┐
   YES       NO
   │         │
   ▼         ▼
 Instance   EventBus
 模式        模式
```

**Instance 模式**（优先）：

当前端要和某个 Agent 通信时，如果这个 Agent 有一个 spawned 的 acp-link 子进程（通过 Instance 服务 spawn 的），relay 会直接建立一条本地 WebSocket 连接到 `ws://127.0.0.1:{port}/ws`。

这条本地 WS 连接按 **instanceId** 做 key 存储（不是 agentId），所以同一个 environment 的多个实例有各自独立的连接。多个前端 relay 可以复用同一条本地 WS。

```text
前端 A ──WS──→ relay ──→┐
前端 B ──WS──→ relay ──→├── 本地 WS ──→ acp-link 进程（端口 8888）
前端 C ──WS──→ relay ──→┘
```

**EventBus 模式**（回退）：

如果没有 spawned instance（比如 acp-link 是直接通过 `/acp/ws` 连接的，不是 spawn 出来的），relay 就退回到 EventBus 模式——通过 ACP EventBus 订阅 agent 的 inbound 消息，通过 `sendToAgentWs()` 发送 outbound 消息。

```text
前端 ──WS──→ relay ──subscribe──→ ACP EventBus ──→ acp-link WS
前端 ──WS──→ relay ──publish───→ ACP EventBus ──→ (广播给 subscriber)
```

**消息过滤**：

relay 向前端转发消息时，会过滤掉以下内容：
- `keep_alive` 消息（前端不需要知道）
- `pong` 消息
- 由 `keep_alive` 引起的 error 消息

**relay 断连不影响 Agent**：

前端关闭或刷新页面时，relay 的 WebSocket 断开，但 acp-link 子进程继续运行，本地 WS 也保留（只是停止转发到前端）。只有用户在控制面板上主动点击"删除"时，才会终止子进程。

## 数据流向总结

```text
                    acp-link Agent
                         │
                    WS /acp/ws
                         │
                         ▼
               ┌── ACP WS Handler ──┐
               │  注册、心跳、断连   │
               └────────┬───────────┘
                        │
                   ACP EventBus
                   (pub/sub 中枢)
                        │
          ┌─────────────┼─────────────┐
          │             │             │
          ▼             ▼             ▼
    Relay Handler   Hermes      SSE Writer
    (前端中继)      (IM 网关)   (v2 事件流)
          │
     WS /acp/relay/:agentId
          │
          ▼
       前端 React
```

## 和其他模块的关系

- `acp-ws-handler.ts` → `repositories/environment.ts`（环境状态更新）
- `acp-ws-handler.ts` → `services/environment.ts`（断连时删除环境）
- `acp-ws-handler.ts` → `event-bus.ts`（消息发布/订阅）
- `acp-relay-handler.ts` → `acp-ws-handler.ts`（查找 agent 的 WS 连接、发送消息）
- `acp-relay-handler.ts` → `services/instance.ts`（查找 spawned instance）
- `acp-relay-handler.ts` → `event-bus.ts`（Instance 模式下发布消息到 EventBus）
- `services/event-service.ts` → `event-bus.ts`（薄封装，统一 Service 层的 EventBus 访问入口）
- `services/hermes-client.ts` → `event-bus.ts`（订阅 Agent 回复，转发到 IM 平台）
