# ACP 传输层

> 对应文件：`src/transport/event-bus.ts`、`src/transport/acp-ws-handler.ts`、`src/transport/relay/relay-handler.ts`、`src/transport/relay/connection-manager.ts`、`src/transport/relay/message-router.ts`、`src/transport/relay/index.ts`、`src/transport/file-ws-handler.ts`、`src/transport/sse-writer.ts`、`src/transport/acp-sse-writer.ts`、`src/transport/ws-handler.ts`、`src/transport/ws-types.ts`

## 这个模块干什么

传输层是 RCS 的消息中枢。它解决的核心问题是：**让前端和 AI Agent 之间能实时双向通信**。

前端和 Agent 不直接连接，中间隔着 RCS 服务器。传输层就是这段中间路——它接收一方的消息，转发给另一方，同时把消息广播给其他需要知道的模块（比如 Hermes IM 网关需要知道 Agent 的回复内容）。此外还有独立于 Agent 消息的文件操作通道（File WS Handler）和 SSE 事件流补发能力。

## 核心组件

### 1. EventBus（`event-bus.ts`）

**一句话**：进程内的消息广播中心。

EventBus 是一个 pub/sub 系统，运行在同一个进程内（不是 Redis、不是消息队列）。它的作用是：当一条消息到达时，通知所有关心这条消息的人。

RCS 里有两套 EventBus 注册表：

| EventBus 注册函数 | key | 用途 |
|----------|-----|------|
| `getEventBus(sessionId)` | sessionId | v1/v2 Worker 的事件流 |
| `getAcpEventBus(channelGroupId)` | **任意字符串** | ACP 协议的消息路由 |

每条消息有一个 `direction` 标记：

- **inbound**（Agent → RCS）——Agent 发来的消息、状态更新、streaming chunk 等
- **outbound**（RCS → Agent）——要发给 Agent 的指令、prompt 等

EventBus 内部维护一个环形缓冲区（最多 5000 条），支持通过 `getEventsSince(seqNum)` 做增量拉取，用于 SSE 事件流补发。

**ACP EventBus key 设计**：`channelGroupId` 可以是任何字符串——environmentId、agentId、sessionId 均可。由调用方决定 key 的语义，EventBus 层不做限制。

### 2. ACP WS Handler（`acp-ws-handler.ts`）

**一句话**：处理 acp-link Agent 和远程 Machine 的 WebSocket 连接与注册。

这个模块管的是 `/acp/ws` 端点——是 acp-link Agent 和远程 Machine 连接 RCS 的统一入口。

**连接类型**：连接在 `onOpen` 时通过传入参数区分下述三种身份：

| 连接类型 | 判别条件 | 说明 |
|----------|----------|------|
| **Machine 连接** | `isMachine === true` | 远程节点注册，通过 `handleMachineRegister` 完成注册表登记、心跳建立和 remote transport 绑定 |
| **本地 acp-link 连接** | `boundEnvId` 存在 | 服务端 spawn 的本地 acp-link 回连，绑定到持久 environment |
| **未识别连接** | 两者皆无 | 直接关闭（4003） |

**Machine 注册体系**：

`acp-ws-handler.ts` 同时管理 machine 注册表的核心流程：

- **`isMachine` 标志**：连接类型分发的关键判断字段
- **`registerMachine()`**：将远程 machine 写入 DB registry 表 + 创建 registry event，返回 `{ id, isNew }`
- **`registerRemoteNode()`**：将 machine 注册到 `CoreRuntimeFacade`，使其能接收 `prepare/start/stop` 等远程调度指令
- **`agentMachineCache`**：`agentId → machineId` 的内存缓存，供 `sendToAgentWs()` 快速路由消息到正确的 remote machine。Cache miss 时通过 `findMachineConnectionByAgentId()` 异步查 DB 并回填缓存

**心跳检测**（`registry-heartbeat` 服务）：

- 机器注册后启动 `startHeartbeat(machineId, interval, timeoutCallback)`
- timeout 为 `interval × 3`，触发时执行完整断连清理链：关闭 WS → 更新 DB 状态 → `unregisterRemoteNode()` → 清理 relay 连接 → reconcile instance registry

**Machine 消息路由**：

Machine 连接收到的消息按类型分流：

| 消息类别 | 类型 | 处理方式 |
|----------|------|----------|
| 远程协议消息 | `prepare_result` / `start_result` / `stop_result` / `relay` | 注入到 `entry.remoteTransport`（CoreRuntimeFacade 提供的 transport 通道） |
| Session 生命周期 | `session_started` / `session_data` / `session_ended` / `session_error` / `session_queued` / `session_resumed` | 转发到 relay 层的 `sessionMessageListeners` |
| 心跳 | `heartbeat` | 调用 `handleHeartbeat()` 刷新超时计时器 |
| 注册 | `register` | 走 machine 注册流程 |

**本地 acp-link 连接**（旧架构路径）：

当 `boundEnvId` 存在时，走传统本地 acp-link 流程：订阅 ACP EventBus（outbound 消息 → 转发给 acp-link），定时发送 `keep_alive`，超时检测（`keepalive × 3` 无活动则断开）。

**断连清理**：

- `triggerMachineDisconnect(wsId, machineId, reason)`：主动清理（心跳超时 / sweep 触发），关闭 WS + 完整清理链
- `triggerMachineCleanupByMachineId(machineId, reason)`：entry 已不存在时仅凭 machineId 清理
- `performMachineCleanup(entry, reason)`：核心清理逻辑，检查重连 → 停止心跳 → 清理 relay 连接 → reconcile registry

**`sendToAgentWs(agentId, msg)` 兼容层**：

保留同步签名，优先查 `agentMachineCache` 找对应 machine WS，将消息包装为 `session_data` 发送。Cache miss 时返回 false。此函数被 relay 层和 hermes 等模块使用。

### 3. Relay Handler（`relay/` 目录）

**一句话**：处理前端与 Agent 之间的 WebSocket 中继，统一通过 `CoreRuntimeFacade` 调度。

这个模块管的是 `/acp/relay/:agentId` 端点，当前端连上来时通过 RCS 和 Agent 双向通信。

**组件拆分**：

| 文件 | 职责 |
|------|------|
| `relay-handler.ts` | relay 生命周期管理（open/message/close）、本地 relay 建立、pending buffer 回放、machine 断连/重连处理 |
| `connection-manager.ts` | `RelayConnectionManager` 类和 `sendToRelayWs()` 工具函数，管理前端 relay WS 连接池，支持按 instanceId / agentId 查询 |
| `message-router.ts` | 消息过滤、flush 过滤、EventBus 发布工具 |
| `index.ts` | 统一导出入口，包含兼容层（`spawnInstanceFromEnvironment`、`findRunningInstanceByEnvironment`） |

**统一 relay 架构**（不再区分 Instance 模式 vs EventBus 模式）：

所有 relay 连接统一通过 `CoreRuntimeFacade` 完成：

```text
前端连接 /acp/relay/:agentId
        │
        ▼
  openLocalRelay() 统一入口
        │
        ├── ensureRunning(userId, agentId)     → 确保实例运行（本地或远程）
        │
        └── facade.connectInstanceRelay({       → 连接 relay handle
              instanceId, sessionId
            })
```

`CoreRuntimeFacade.connectInstanceRelay()` 返回一个 `EngineRelayHandle`，它封装了底层差异——无论是本地 acp-link 还是远程 machine，前端 relay 层都通过同一个 handle 收发消息。

**RelayConnectionManager**：

维护 `wsId → RelayConnectionEntry` 的映射，提供：
- `add / get / remove`：基础 CRUD
- `findByInstance(instanceId)`：按实例查连接
- `findByAgentId(agentId)`：按 agent 查所有连接
- `hasOtherRelayForInstance(instanceId, excludeWsId)`：多 relay 复用检测
- `isShuttingDown` 标志：优雅关闭时阻断新连接

**Relay 设置流程详解**（`openLocalRelay`）：

```text
1. ensureRunning() → 创建/复用 instance
2. facade.connectInstanceRelay() → 获取 EngineRelayHandle
3. handle.onMessage 注册 → 监听 agent 消息
4. 发送 status → 前端感知连接就绪
5. 回放 pending buffer → flush 期间缓存的前端消息
6. 补发 connect → 确保收到 agent capabilities
```

**Pending buffer 机制**：从 relay WS 打开到 `EngineRelayHandle` ready 之间存在异步 gap。期间前端发送的消息暂存在 `pendingRelayMessages` Map 中，handle ready 后通过 `filterConnectFromFlush()` 回放（过滤掉 connect 消息，因为 handle auto-connects）。

**Keepalive**：relay 层通过 `RelayConnectionManager` 维护独立的 keepalive 定时器（20s 间隔），向前端发送 `keep_alive` 消息维持 WS 连接。ACP 层的 keep_alive 不透传到前端。

**Session lifetime 控制**：
- `sessionStarted` 标志：agent 未就绪时，非 JSON-RPC 消息缓存到 `outboundBuffer`
- JSON-RPC 消息（`jsonrpc === "2.0"`）不受约束，直接放行
- `session/new` / `session/list` 等方法自动注入 `cwd = workspacePath`

**Machine 断连与重连处理**：

- `handleMachineDisconnected(machineId)`：machine 断连时，关闭该 machine 上所有 agent 的 relay 连接。前端 WS 以 4500 码关闭（前端不自动重连）
- `handleMachineReconnect(machineId)`：machine 重连时，关闭旧 relay 连接，让前端触发重连 → `ensureRunning` 使用新的 transport
- 匹配逻辑：通过 `CoreRuntimeFacade.listInstances()` 找 `nodeId === machineId` 的实例 + `agentMachineCache` 兜底

### 4. File WS Handler（`file-ws-handler.ts`）

**一句话**：独立的文件操作 WebSocket 通道。

这个模块管理 `/file-ws` 端点的连接，允许前端通过远程 machine 执行文件操作（读、写、列目录等）。

**架构**：

- 每个 machine 通过 `register` 消息绑定 file-ws 连接
- `machineFileWsIndex`：`machineId → FileWsConnectionEntry` 快速查找索引
- 支持请求-响应模式：`sendFileOpAndWait(machineId, operation, params, timeoutMs)` 发送 `file_op` 并等待 `file_op_result`
- 连接断开时自动 reject 所有 pending 请求

### 5. SSE Writer（`sse-writer.ts` / `acp-sse-writer.ts`）

**一句话**：提供 EventBus 事件的 SSE 实时流输出。

两个 SSE writer 文件分别服务于 v2 Worker 事件流（`sessionId` key）和 ACP 事件流（`channelGroupId` key）。

**功能**：

- 通过 `createSSEStream(request, sessionId, fromSeqNum)` 创建 SSE Response，支持增量补发（`getEventsSince`）
- 15s keepalive 间隔（SSE `: keepalive\n\n` 注释帧）
- `request.signal.addEventListener("abort")` 自动清理订阅和定时器
- `createWorkerEventStream` 专门服务于 CCR worker 场景，仅输出 outbound 事件

## 数据流向总结

```text
                    acp-link Agent / Remote Machine
                         │
                    WS /acp/ws
                         │
                         ▼
               ┌── ACP WS Handler ──┐
               │  注册、心跳、断连   │
               │  Machine 注册表管理 │
               └────────┬───────────┘
                        │
              ┌─────────┼─────────┐
              │         │         │
              ▼         ▼         ▼
        EventBus    Remote     File WS
        (pub/sub)  Transport   Handler
              │    (machine)   (文件操作)
              │
       ┌──────┼──────┐
       │      │      │
       ▼      ▼      ▼
    Relay   Hermes  SSE Writer
   Handler  (IM网关)  (事件流)
       │
  WS /acp/relay/:agentId
       │
       ▼
    前端 React
```

## 和其他模块的关系

- `acp-ws-handler.ts` → `services/registry.ts`（machine 注册/断连）
- `acp-ws-handler.ts` → `services/registry-heartbeat.ts`（心跳超时管理）
- `acp-ws-handler.ts` → `services/core-bootstrap.ts`（`registerRemoteNode` / `unregisterRemoteNode`）
- `acp-ws-handler.ts` → `services/instance-registry.ts`（machine 断连后 reconcile）
- `relay/relay-handler.ts` → `services/instance.ts`（`ensureRunning` / `spawnInstanceFromEnvironment`）
- `relay/relay-handler.ts` → `services/core-bootstrap.ts`（`getCoreRuntime()` / `connectInstanceRelay`）
- `relay/relay-handler.ts` → `services/acp-idle-monitor.ts`（relay attach/detach + activity touch）
- `relay/connection-manager.ts` → `types/store.ts`（`RelayConnectionEntry` / `ManagedConnection`）
- `relay/message-router.ts` → `event-bus.ts`（`publishToEventBus` / `getAcpEventBus`）
- `file-ws-handler.ts` → `services/registry.ts`（按 machineId 查找远程机器）
- `sse-writer.ts` / `acp-sse-writer.ts` → `event-bus.ts`（订阅 + 增量拉取）
- `services/hermes-client.ts` → `event-bus.ts`（订阅 Agent 回复，转发到 IM 平台）
