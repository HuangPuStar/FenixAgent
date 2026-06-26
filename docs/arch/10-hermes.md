# Channel 与 Hermes

> 对应文件：`src/services/hermes-client.ts`、`src/services/channel-binding.ts`、`src/services/channel-provider.ts`

## 这个模块干什么

这个模块让 RCS 能接入各种聊天平台（飞书、Telegram、Discord、企业微信等），把用户的聊天消息转发给 AI Agent，再把 Agent 的回复发回聊天平台。

Hermes 是一个独立的消息网关服务，负责和各种聊天平台的 API 对接。RCS 的 HermesClient 作为 WebSocket 客户端连接 Hermes，收发消息。

## 架构

```text
飞书 / Telegram / Discord / 企业微信 / ...
                    │
                    ▼
            ┌──────────────┐
            │   Hermes     │  独立的消息网关服务
            │   网关        │  统一各种聊天平台的 API
            └──────┬───────┘
                   │ WebSocket
                   ▼
            ┌──────────────┐
            │ HermesClient │  RCS 内的客户端
            │              │  订阅平台消息，路由到 Agent
            └──────┬───────┘
                   │
          ┌────────┼────────┐
          │        │        │
          ▼        ▼        ▼
    findBinding  route   ensureOutbound
    (匹配绑定)  (发消息)  (订阅回复)
```

## 三个组件

### ChannelBinding（`channel-binding.ts`）

记录"哪个聊天群的哪个 Agent"。存在 `channel_binding` 表中：

- `platform`：平台名（feishu、telegram 等）
- `chatId`：聊天群/对话 ID
- `agentId`：对应的 Agent（environment）ID
- `enabled`：是否启用该绑定

当 Hermes 发来一条消息时，`findBindingForMessage(platform, chatId)` 查找匹配的绑定，决定把消息路由给哪个 Agent。

### HermesClient（`hermes-client.ts`）

Hermes 网关的 WebSocket 客户端。核心职责：

**连接管理**：
- 启动时连接 Hermes，订阅所有平台消息
- 断连后指数退避重连（2s → 4s → 8s → ... → 最多 60s）
- 心跳：每 30s 发 ping，60s 没收到 pong 就断开重连
- 平台状态变化时自动订阅新上线的平台

**消息路由（inbound）**：

```text
Hermes 发来消息 {platform, chat_id, text, ...}
        │
        ▼
  findBindingForMessage(platform, chatId)
        │
        ├── 没找到绑定 → 丢弃，打日志
        │
        ▼
  找到绑定 → routeToAgent(agentId, message)
        │
        ├── 优先发到 spawned instance 的本地 WS
        │   （sendToInstanceLocalWs）
        │
        └── 回退发到 acp-link 的直连 WS
            （sendToAgentWs）
```

**回复路由（outbound）**：

Agent 的回复需要发回聊天平台。做法是订阅 Agent 的 ACP EventBus，监听 Agent 的 streaming 输出：

```text
订阅 EventBus inbound 事件
        │
        ├── session_update + agent_message_chunk → 积累文本
        │
        └── prompt_complete → 把积累的文本发回 Hermes
                               hermes.send(platform, chatId, text)
                               清空积累的文本
```

`bindingUnsubs: Map<string, () => void>` 按 `platform:chatId:agentId` 作为 key 去重，确保同一绑定不会重复订阅 EventBus。绑定删除时调用对应的 unsubscribe 函数清理。调整绑定关系时，先 teardown 旧绑定再 setup 新绑定。

### ChannelProvider（`channel-provider.ts`）

平台相关的辅助逻辑（如消息格式适配），目前是薄封装。

## 启动条件

HermesClient 只在配置了 `HERMES_URL` 环境变量时才启动。没配就完全不初始化，不影响其他功能。

可选的 `HERMES_PLATFORMS` 环境变量指定订阅哪些平台（逗号分隔），默认订阅所有已知平台。

## 和其他模块的关系

- → `services/channel-binding.ts`：查找消息对应的 Agent 绑定
- → `transport/relay`：查 running instance 发消息（`findRunningInstanceByEnvironment`、`sendToInstanceRelay`）
- → `transport/acp-ws-handler.ts`：回退方式发送消息到 Agent（`sendToAgentWs`）
- → `transport/event-bus.ts`：订阅 Agent 回复事件（通过 event-service 封装）
- ← `index.ts`：启动和停止 HermesClient
- ← `routes/web/channels.ts`：管理绑定关系、查询 Hermes 状态
