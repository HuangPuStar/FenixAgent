# socket.io 分布式 WS 改造设计

> 日期: 2026-07-13
> 状态: 设计确认

## 1. 背景与动机

当前 FenixAgent RCS 是一个**单体进程**，所有实时通信基于原生 WebSocket（Elysia 内置 WS），关键组件均为进程内内存结构：

| 组件 | 实现 | 问题 |
|------|------|------|
| `RelayConnectionManager` | `Map<string, RelayConnectionEntry>` | 多实例无法共享 relay 路由 |
| `EventBus` | 进程内 pub/sub | SSE 订阅者跨节点不可达 |
| `MachineCache` | `Map<string, string>` | Remote Agent 连接亲和性锁定当前节点 |

无法支持多 RCS 实例水平扩展。前端的 WS 重连逻辑也是手写指数退避（最多 5 次），体验不稳定。

**改造目标**：用 socket.io + Redis 替换原生 WebSocket，实现：

- ✅ 多实例水平扩展（前端连任意 RCS 节点均可路由到正确 Agent）
- ✅ 前端自动重连、心跳（socket.io 内置，移除手写重连）
- ✅ 跨节点消息广播（Redis Adapter Pub/Sub）
- ✅ 共享 session 状态（Redis KV 替代内存 Map）

## 2. 改造范围

### 2.1 三条 WS 链路全部改造

| 链路 | 当前端点 | 认证 | 改造后 namespace |
|------|---------|------|-----------------|
| Chat Relay | `/acp/relay/:agentId` | better-auth cookie | `/relay` |
| Machine WS | `/acp/ws` | REGISTRY_SECRET 密钥 | `/machine` |
| File WS | `/acp/file-ws` | REGISTRY_SECRET 密钥 | `/file` |

三个 namespace 天然隔离：前端只能连 `/relay`，Machine 只能连 `/machine` 和 `/file`。

### 2.2 明确不改的东西

- **ACP 协议**：JSON-RPC 2.0 消息格式完全不变（`session/new`、`prompt`、`session/update` 等）
- **认证逻辑**：better-auth cookie 和 REGISTRY_SECRET 密钥验证原样保留
- **业务逻辑**：Relay Handler、Machine Handler、File Handler 的转发/注册/文件操作代码不变
- **Agent 实例管理**：`ensureRunning` / `spawn` / `idle monitor` 逻辑不变

## 3. 架构分层

```
┌─────────────────────────────────────────────────────┐
│  前端 Browser / Machine 客户端                        │
│  socket.io-client (替代原生 WS)                       │
├──────────────┬──────────────┬────────────────────────┤
│  namespace   │  /relay      │  /machine    │  /file  │
│  认证        │  cookie      │  密钥         │  密钥   │
├──────────────┴──────────────┴────────────────────────┤
│  业务逻辑层 (完全不变)                                 │
│  Relay Handler / Machine Handler / File Handler       │
│  ACP JSON-RPC 2.0 消息格式不变                        │
├─────────────────────────────────────────────────────┤
│  状态适配器层 (新)                                     │
│  AbstractTransportStore                               │
│  ├── MemoryStore (开发/单节点，Map)                    │
│  └── RedisStore  (生产/多节点，ioredis)                │
├─────────────────────────────────────────────────────┤
│  跨节点路由层 (新)                                     │
│  socket.io Redis Adapter (Pub/Sub 广播)               │
│  自动检测：有 RCS_REDIS_URL 则启用，否则内存模式        │
└─────────────────────────────────────────────────────┘
```

### 3.1 状态适配器设计

```typescript
// 抽象接口
interface TransportStore {
  // Relay 连接管理
  setRelaySocket(instanceId: string, socketId: string): Promise<void>;
  getRelaySocket(instanceId: string): Promise<string | null>;
  delRelaySocket(instanceId: string): Promise<void>;
  
  // Machine 注册表
  setMachineSocket(machineId: string, socketId: string): Promise<void>;
  getMachineSocket(machineId: string): Promise<string | null>;
  delMachineSocket(machineId: string): Promise<void>;
  
  // EventBus 替代 (可选)
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (msg: string) => void): Promise<() => void>;
}
```

切换逻辑：`RCS_REDIS_URL` 环境变量存在时用 `RedisStore`，否则用 `MemoryStore`。

### 3.2 Redis 集群模式支持

ioredis 原生支持三种模式，通过 `RCS_REDIS_URL` 自动识别：

| 模式 | URL 示例 | 场景 |
|------|---------|------|
| 单机 | `redis://redis:6379` | 开发/低负载 |
| Sentinel | `redis+sentinel://sentinel1:26379,sentinel2:26379/0?name=mymaster` | 生产高可用 |
| Cluster | `redis://node1:6379,node2:6379?cluster=true` | 海量分片 |

## 4. 核心改造点

### 4.1 后端

| 文件 | 改造内容 |
|------|---------|
| `src/transport/socketio-server.ts` | **新增**：socket.io server 初始化，注册三个 namespace 及认证中间件 |
| `src/transport/relay/relay-handler.ts` | `ws.open` → `socket.on("connection")`，Elysia WS 对象 → socket.io Socket |
| `src/transport/acp-ws-handler.ts` | 原生 WS 握手 → socket.io `connection` 事件 |
| `src/transport/relay/connection-manager.ts` | 内存 Map → `TransportStore` 接口 |
| `src/transport/event-bus.ts` | 进程内 pub/sub → `TransportStore.publish/subscribe` |
| `src/transport/machine-cache.ts` | 内存 Map → `TransportStore` 接口 |
| `src/transport/store/` | **新增**：`types.ts`、`memory-store.ts`、`redis-store.ts`、`factory.ts` |
| `src/index.ts` | Elysia WS 路由注册 → socket.io server attach，加载 store |

### 4.2 前端

| 文件 | 改造内容 |
|------|---------|
| `packages/acp-link/src/client/transport.ts` | 原生 WebSocket → `socket.io-client`，删除手写重连/心跳 |
| `web/src/acp/relay-client.ts` | `buildRelayUrl` → socket.io namespace + auth 配置 |
| `web/src/acp/client.ts` | ACPClient 连接生命周期适配 socket.io |

### 4.3 依赖新增

```json
{
  "socket.io": "^4.x",
  "socket.io-client": "^4.x",
  "@socket.io/redis-adapter": "^8.x",
  "ioredis": "^5.x"
}
```

## 5. 部署方案 (docker-compose)

```yaml
# RCS 节点可水平扩展
rcs-node-1:
  image: fenixagent
  environment:
    - RCS_REDIS_URL=redis://redis:6379
  depends_on: [redis]

rcs-node-2:  # 按需扩展
  image: fenixagent
  environment:
    - RCS_REDIS_URL=redis://redis:6379
  depends_on: [redis]

redis:
  image: redis:7-alpine

nginx:
  image: nginx:alpine
  # sticky session 可选，socket.io 客户端可自动重连到其他节点
```

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| socket.io 与 ACP 协议兼容性 | 一期先在单节点验证（无 Redis），跑通现有测试 |
| Agent 子进程生命周期 | socket.io 断连不等于 agent 销毁，idle monitor 逻辑保持不变 |
| 文件通道 binary 传输 | socket.io 原生支持 ArrayBuffer/Blob，优于原生 WS |
| Elysia WS 生态兼容 | socket.io server attach 到 Bun HTTP server 即可，不依赖 Elysia WS |
| 性能回退 | 单节点内存模式性能与原生 WS 持平；Redis 模式引入 ~1-2ms 延迟 |
