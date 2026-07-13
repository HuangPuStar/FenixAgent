# socket.io 分布式 WS 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 用 socket.io + Redis 替换三条原生 WebSocket 链路（/acp/relay、/acp/ws、/acp/file-ws），支持多节点水平扩展。

**Architecture:** 四层分层 — socket.io transport（三 namespace）→ 业务逻辑层（不变）→ TransportStore 状态适配器（MemoryStore | RedisStore）→ Redis Adapter 跨节点路由。ACP JSON-RPC 2.0 协议完全不变。

**Tech Stack:** socket.io + socket.io-client + @socket.io/redis-adapter + ioredis + Bun + Elysia + TypeScript

---

## 文件结构

| 文件 | 角色 | 操作 |
|------|------|------|
| `src/transport/socketio-server.ts` | socket.io server 初始化，注册三个 namespace 及认证中间件 | **Create** |
| `src/transport/store/types.ts` | TransportStore 接口定义 | **Create** |
| `src/transport/store/memory-store.ts` | MemoryStore 实现（Map） | **Create** |
| `src/transport/store/redis-store.ts` | RedisStore 实现（ioredis） | **Create** |
| `src/transport/store/factory.ts` | createStore() 工厂（环境变量切换） | **Create** |
| `src/transport/relay/relay-handler.ts` | Elysia WS → socket.io Socket 适配 | **Modify** |
| `src/transport/relay/connection-manager.ts` | 内存 Map → TransportStore | **Modify** |
| `src/transport/acp-ws-handler.ts` | 原生 WS → socket.io Socket 适配，MachineCache → TransportStore | **Modify** |
| `src/transport/event-bus.ts` | 进程内 pub/sub → TransportStore.publish/subscribe | **Modify** |
| `src/transport/file-ws-handler.ts` | 原生 WS → socket.io Socket 适配 | **Modify** |
| `src/routes/acp/index.ts` | 移除 Elysia WS 路由，socket.io 替代 | **Modify** |
| `src/index.ts` | socket.io server 初始化 + store 加载 | **Modify** |
| `src/types/store.ts` | 移除 WsConnection 依赖，socket.io Socket 类型 | **Modify** |
| `src/env.ts` | 新增 RCS_REDIS_URL 验证 | **Modify** |
| `packages/acp-link/src/client/transport.ts` | 原生 WebSocket → socket.io-client，删除手写重连/心跳 | **Modify** |
| `packages/acp-link/src/client/client.ts` | ACPClient 适配 socket.io transport 事件模型 | **Modify** |
| `web/src/acp/relay-client.ts` | buildRelayUrl → socket.io namespace + auth | **Modify** |
| `package.json` | 新增 4 个依赖 | **Modify** |
| `docker-compose.yml` 或新文件 | Redis 容器 | **Modify** |

---

### Task 1: 安装新依赖

**Files:**
- Modify: `package.json`

- [ ] **Step 1: 添加 socket.io / ioredis 依赖**

```bash
cd /Users/konghayao/code/pazhou/remote-control-server
bun add socket.io ioredis @socket.io/redis-adapter
```

- [ ] **Step 2: 添加前端 socket.io-client 依赖**

```bash
bun add socket.io-client
```

- [ ] **Step 3: 验证安装**

```bash
bun run --silent -e "console.log(require('socket.io').Server ? 'socket.io OK' : 'FAIL')"
bun run --silent -e "console.log(require('ioredis').default ? 'ioredis OK' : 'FAIL')"
bun run --silent -e "console.log(require('socket.io-client').io ? 'socket.io-client OK' : 'FAIL')"
```

Expected: 三个 "OK"

- [ ] **Step 4: 提交**

```bash
git add package.json bun.lock
git commit -m "chore: 添加 socket.io / ioredis / redis-adapter 依赖"
```

---

### Task 2: TransportStore 状态适配器层

**Files:**
- Create: `src/transport/store/types.ts`
- Create: `src/transport/store/memory-store.ts`
- Create: `src/transport/store/redis-store.ts`
- Create: `src/transport/store/factory.ts`
- Modify: `src/env.ts`

- [ ] **Step 1: 定义 TransportStore 接口**

创建 `src/transport/store/types.ts`：

```typescript
/** socket.io socketId → connection tracking data */
export interface SocketMeta {
  socketId: string;
  connectedAt: number;
  namespace: "/relay" | "/machine" | "/file";
}

export interface TransportStore {
  // ── Relay 连接映射 ──
  /** 将 instanceId 映射到 relay socketId */
  setRelaySocket(instanceId: string, socketId: string): Promise<void>;
  getRelaySocket(instanceId: string): Promise<string | null>;
  delRelaySocket(instanceId: string): Promise<void>;

  // ── Machine 注册表 ──
  /** 将 machineId 映射到 machine socketId */
  setMachineSocket(machineId: string, socketId: string): Promise<void>;
  getMachineSocket(machineId: string): Promise<string | null>;
  delMachineSocket(machineId: string): Promise<void>;

  // ── EventBus 替代 (Pub/Sub) ──
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<() => void>;

  // ── 生命周期 ──
  /** 检查后端连接是否健康 */
  healthCheck(): Promise<boolean>;
  /** 关闭连接释放资源 */
  close(): Promise<void>;
}
```

- [ ] **Step 2: 实现 MemoryStore**

创建 `src/transport/store/memory-store.ts`：

```typescript
import type { TransportStore } from "./types";

/** 单节点/开发环境使用，纯内存实现 */
export class MemoryStore implements TransportStore {
  private relayMap = new Map<string, string>();
  private machineMap = new Map<string, string>();
  private subscribers = new Map<string, Set<(message: string) => void>>();

  async setRelaySocket(instanceId: string, socketId: string) {
    this.relayMap.set(instanceId, socketId);
  }
  async getRelaySocket(instanceId: string) {
    return this.relayMap.get(instanceId) ?? null;
  }
  async delRelaySocket(instanceId: string) {
    this.relayMap.delete(instanceId);
  }

  async setMachineSocket(machineId: string, socketId: string) {
    this.machineMap.set(machineId, socketId);
  }
  async getMachineSocket(machineId: string) {
    return this.machineMap.get(machineId) ?? null;
  }
  async delMachineSocket(machineId: string) {
    this.machineMap.delete(machineId);
  }

  async publish(channel: string, message: string) {
    const subs = this.subscribers.get(channel);
    if (subs) {
      for (const handler of subs) {
        try { handler(message); } catch { /* ignore */ }
      }
    }
  }
  async subscribe(channel: string, handler: (message: string) => void) {
    let subs = this.subscribers.get(channel);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(channel, subs);
    }
    subs.add(handler);
    return () => {
      subs?.delete(handler);
      if (subs?.size === 0) this.subscribers.delete(channel);
    };
  }

  async healthCheck() { return true; }
  async close() {
    this.relayMap.clear();
    this.machineMap.clear();
    this.subscribers.clear();
  }
}
```

- [ ] **Step 3: 实现 RedisStore**

创建 `src/transport/store/redis-store.ts`：

```typescript
import Redis from "ioredis";
import type { TransportStore } from "./types";

interface RedisStoreOptions {
  url: string;
  /** Key prefix for namespacing, default "rcs:" */
  keyPrefix?: string;
}

/** 多节点/生产环境使用，基于 ioredis */
export class RedisStore implements TransportStore {
  private redis: Redis;
  private subRedis: Redis; // 独立连接用于 subscribe（阻塞模式）
  private prefix: string;

  constructor(options: RedisStoreOptions) {
    this.prefix = options.keyPrefix ?? "rcs:";
    this.redis = new Redis(options.url, {
      lazyConnect: true,
      keyPrefix: this.prefix,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
    // Redis subscribe 需要独立连接，因为 subscribe 会阻塞其他命令
    this.subRedis = new Redis(options.url, {
      lazyConnect: true,
      keyPrefix: this.prefix,
      retryStrategy: (times) => Math.min(times * 200, 5000),
    });
  }

  private relayKey(instanceId: string) { return `relay:${instanceId}`; }
  private machineKey(machineId: string) { return `machine:${machineId}`; }
  private pubsubChannel(channel: string) { return `events:${channel}`; }

  async setRelaySocket(instanceId: string, socketId: string) {
    await this.redis.set(this.relayKey(instanceId), socketId);
  }
  async getRelaySocket(instanceId: string) {
    return await this.redis.get(this.relayKey(instanceId));
  }
  async delRelaySocket(instanceId: string) {
    await this.redis.del(this.relayKey(instanceId));
  }

  async setMachineSocket(machineId: string, socketId: string) {
    await this.redis.set(this.machineKey(machineId), socketId);
  }
  async getMachineSocket(machineId: string) {
    return await this.redis.get(this.machineKey(machineId));
  }
  async delMachineSocket(machineId: string) {
    await this.redis.del(this.machineKey(machineId));
  }

  async publish(channel: string, message: string) {
    await this.redis.publish(this.pubsubChannel(channel), message);
  }
  async subscribe(channel: string, handler: (message: string) => void) {
    await this.subRedis.subscribe(this.pubsubChannel(channel));
    const listener = (ch: string, msg: string) => {
      if (ch === this.pubsubChannel(channel)) handler(msg);
    };
    this.subRedis.on("message", listener);
    return async () => {
      this.subRedis.off("message", listener);
      await this.subRedis.unsubscribe(this.pubsubChannel(channel));
    };
  }

  async healthCheck() {
    try {
      await this.redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  async close() {
    this.subRedis.disconnect();
    this.redis.disconnect();
  }
}
```

- [ ] **Step 4: 实现工厂函数**

创建 `src/transport/store/factory.ts`：

```typescript
import { config } from "../../config";
import type { TransportStore } from "./types";
import { MemoryStore } from "./memory-store";
import { RedisStore } from "./redis-store";

let _store: TransportStore | null = null;

/** 获取全局 TransportStore 单例。有 RCS_REDIS_URL 时创建 RedisStore，否则 MemoryStore。 */
export function getTransportStore(): TransportStore {
  if (_store) return _store;

  const redisUrl = process.env.RCS_REDIS_URL;
  if (redisUrl) {
    _store = new RedisStore({ url: redisUrl });
  } else {
    _store = new MemoryStore();
  }
  return _store;
}

/** 关闭并重置 store（用于 graceful shutdown 和测试） */
export async function closeTransportStore(): Promise<void> {
  if (_store) {
    await _store.close();
    _store = null;
  }
}
```

- [ ] **Step 5: 新增 RCS_REDIS_URL 环境变量**

在 `src/env.ts` 的 `envSchema` 中添加（可选字段，不设则不启用 Redis）：

```typescript
// 在 envSchema 对象中添加：
RCS_REDIS_URL: z.string().url().optional(),
```

- [ ] **Step 6: 提交**

```bash
git add src/transport/store/ src/env.ts
git commit -m "feat: 新增 TransportStore 状态适配器层 (MemoryStore | RedisStore)"
```

---

### Task 3: socket.io Server 初始化 + index.ts 集成

**Files:**
- Create: `src/transport/socketio-server.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: 创建 socket.io server 初始化模块**

创建 `src/transport/socketio-server.ts`：

```typescript
import { createLogger } from "@fenix/logger";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import Redis from "ioredis";
import type { Server as BunServer } from "bun";

const logger = createLogger("socketio-server");

/** 初始化 socket.io Server，返回实例。在 src/index.ts 中调用。 */
export function initSocketIOServer(httpServer: BunServer): SocketIOServer {
  const io = new SocketIOServer(httpServer, {
    // socket.io 默认路径 /socket.io/ 用于握手和传输
    path: "/socket.io/",
    // 允许跨域（前端可能在不同端口开发）
    cors: { origin: true, credentials: true },
    // 连接超时
    connectTimeout: 10000,
    // 不启用 HTTP 长轮询退化（仅 WebSocket）
    transports: ["websocket"],
  });

  // Redis Adapter：有 RCS_REDIS_URL 则启用跨节点广播
  const redisUrl = process.env.RCS_REDIS_URL;
  if (redisUrl) {
    const pubClient = new Redis(redisUrl, { lazyConnect: false, retryStrategy: (t) => Math.min(t * 200, 5000) });
    const subClient = pubClient.duplicate();
    io.adapter(createAdapter(pubClient, subClient));
    logger.info("Redis Adapter enabled for cross-node broadcasting");
  } else {
    logger.info("Running in single-node mode (no Redis)");
  }

  return io;
}
```

- [ ] **Step 2: 修改 src/index.ts 集成 socket.io**

需要在 Elysia app 创建后、listen 前初始化 socket.io。在 `src/index.ts` 中：

```typescript
// 新增 import
import { initSocketIOServer } from "./transport/socketio-server";
import { getTransportStore, closeTransportStore } from "./transport/store/factory";

// 在 app.listen() 之前添加 socket.io server attach
const io = initSocketIOServer(app.server!);
// 将 io 实例挂载到全局，供 namespace 注册使用
(globalThis as Record<string, unknown>).__socketio = io;

// 注册三个 namespace（通过动态 import 延迟加载，避免循环依赖）
await import("./transport/socketio-namespaces");

// 在 graceful shutdown 中添加 socket.io 和 store 清理
// 在现有 closeAllRelayConnections / closeAllAcpConnections 之后添加：
io.close();
await closeTransportStore();
```

- [ ] **Step 3: 提交**

```bash
git add src/transport/socketio-server.ts src/index.ts
git commit -m "feat: socket.io server 初始化 + Redis Adapter 集成"
```

---

### Task 4: 三个 socket.io Namespace 注册

**Files:**
- Create: `src/transport/socketio-namespaces.ts`
- Modify: `src/routes/acp/index.ts`（移除 WS 路由）

- [ ] **Step 1: 创建 namespace 注册模块**

创建 `src/transport/socketio-namespaces.ts`：

```typescript
import { createLogger } from "@fenix/logger";
import { v4 as uuid } from "uuid";
import type { Server as SocketIOServer, Socket } from "socket.io";
import { validateEnv } from "../env";
import { AppError } from "../errors";
import { authenticateRequest } from "../plugins/auth";
import { environmentRepo } from "../repositories";
import type { RequestAuthResult } from "../plugins/auth";
import { handleRelayClose, handleRelayMessage, handleRelayOpen } from "./relay";
import { handleAcpWsClose, handleAcpWsMessage, handleAcpWsOpen } from "./acp-ws-handler";
import { handleFileWsClose, handleFileWsMessage, handleFileWsOpen } from "./file-ws-handler";

const logger = createLogger("socketio-namespaces");

/** socket.io Socket → WsConnection 适配器，保持业务 handler 签名不变 */
function socketToWsConn(socket: Socket) {
  return {
    send: (data: string) => socket.send(data),
    close: (code?: number, reason?: string) => socket.disconnect(),
    get readyState() { return socket.connected ? 1 : 3; },
  };
}

export function registerNamespaces(io: SocketIOServer): void {
  // ──────────── Namespace /relay ────────────
  io.of("/relay").use(async (socket, next) => {
    try {
      // socket.io 的 auth handshake 中无法直接获取 Elysia request 对象
      // 需要从 socket.handshake 中构建认证上下文
      const request = socket.request;
      const authResult = await authenticateRequest(request);
      if (!authResult?.user) {
        return next(new Error("unauthorized"));
      }
      // 挂载到 socket.data 供后续使用
      socket.data.authResult = authResult;
      socket.data.userId = authResult.user.id;
      socket.data.agentId = socket.handshake.query.agentId as string;
      socket.data.sessionId = socket.handshake.query.sessionId as string | undefined;
      socket.data.organizationId = (socket.handshake.query.activeOrganizationId as string) ||
        authResult.authContext?.organizationId;

      // 验证 agent 归属
      const env = await environmentRepo.getById(socket.data.agentId);
      if (!env) return next(new Error("agent not found"));
      socket.data.env = env;

      next();
    } catch (err) {
      if (err instanceof AppError && err.code === "RATE_LIMITED") {
        return next(new Error("rate_limited"));
      }
      next(new Error("auth error"));
    }
  });

  io.of("/relay").on("connection", (socket) => {
    const wsId = `relay_${uuid().replace(/-/g, "")}`;
    logger.info(`[Relay] connection: wsId=${wsId} agentId=${socket.data.agentId}`);

    const ws = socketToWsConn(socket);

    handleRelayOpen(
      ws,
      wsId,
      socket.data.agentId,
      socket.data.userId,
      socket.data.sessionId,
    );

    socket.on("message", (data) => {
      const payload = typeof data === "string" ? data : data;
      handleRelayMessage(ws, wsId, payload);
    });

    socket.on("disconnect", (reason) => {
      handleRelayClose(ws, wsId, undefined, reason);
    });
  });

  // ──────────── Namespace /machine ────────────
  io.of("/machine").use((socket, next) => {
    const secret = socket.handshake.query.secret as string;
    const registrySecret = validateEnv().REGISTRY_SECRET;
    if (!secret || !registrySecret || secret !== registrySecret) {
      return next(new Error("unauthorized"));
    }
    next();
  });

  io.of("/machine").on("connection", (socket) => {
    const wsId = `acp_ws_${uuid().replace(/-/g, "")}`;
    logger.info(`[Machine] connection: wsId=${wsId}`);

    const ws = socketToWsConn(socket);

    handleAcpWsOpen(ws, wsId, "__machine__", null, true);

    socket.on("message", (data) => {
      const payload = typeof data === "object" && data !== null
        ? data as Record<string, unknown>
        : data as string;
      handleAcpWsMessage(ws, wsId, payload);
    });

    socket.on("disconnect", (reason) => {
      handleAcpWsClose(ws, wsId, undefined, reason);
    });
  });

  // ──────────── Namespace /file ────────────
  io.of("/file").use((socket, next) => {
    const secret = socket.handshake.query.secret as string;
    const registrySecret = validateEnv().REGISTRY_SECRET;
    if (!secret || !registrySecret || secret !== registrySecret) {
      return next(new Error("unauthorized"));
    }
    next();
  });

  io.of("/file").on("connection", (socket) => {
    const wsId = `file_ws_${uuid().replace(/-/g, "")}`;
    logger.info(`[File] connection: wsId=${wsId}`);

    const ws = socketToWsConn(socket);

    handleFileWsOpen(ws, wsId);

    socket.on("message", (data) => {
      const payload = typeof data === "object" && data !== null
        ? data as Record<string, unknown>
        : data as string;
      handleFileWsMessage(ws, wsId, payload);
    });

    socket.on("disconnect", (reason) => {
      handleFileWsClose(ws, wsId);
    });
  });

  logger.info("All socket.io namespaces registered: /relay, /machine, /file");
}
```

- [ ] **Step 2: 修改 src/routes/acp/index.ts 移除 WS 注册**

删除三个 `.ws()` 调用（`/ws`、`/file-ws`、`/relay/:agentId`），仅保留 `GET /acp/agents` HTTP 端点。同时移除非必要的 import。

需要移除的代码段：
- `src/routes/acp/index.ts:78-261`（三个 `.ws()` 端点块）
- 相关的 schema import（`AcpRelayParamsSchema`、`AcpRelayQuerySchema`、`AcpRegistrySecretQuerySchema`）
- 相关的 handler import（`handleAcpWsOpen`、`handleFileWsOpen`、`handleRelayOpen` 等在 route 文件内的引用）

保留的 import：
```typescript
import Elysia from "elysia";
import { environmentRepo } from "../../repositories";
import { AcpAgentListResponseSchema } from "../../schemas";
import { authGuardPlugin } from "../../plugins/auth";
```

- [ ] **Step 3: 提交**

```bash
git add src/transport/socketio-namespaces.ts src/routes/acp/index.ts
git commit -m "feat: 注册三个 socket.io namespace 替代 Elysia WS 路由"
```

---

### Task 5: 业务 handler 适配 — relay-handler.ts

**Files:**
- Modify: `src/transport/relay/relay-handler.ts`
- Modify: `src/types/store.ts`

- [ ] **Step 1: RelayConnectionEntry 类型移除 WsConnection**

在 `src/types/store.ts` 的 `RelayConnectionEntry` 中，将 `ws: WsConnection` 改为 `ws: WsConnection`（保持 WsConnection 接口不变，由 `socketToWsConn()` 适配），**无需修改**。relay-handler 已经在使用 WsConnection 接口，`socketToWsConn()` 已实现这个接口。

- [ ] **Step 2: connection-manager 适配 TransportStore**

在 `src/transport/relay/connection-manager.ts` 中，新增 `TransportStore` 集成（渐进式，原 Manager 继续工作，同时写入 store 供跨节点查找）：

```typescript
import { getTransportStore } from "../store/factory";

// 在 add 方法中添加 store 同步：
add(wsId: string, entry: RelayConnectionEntry): void {
  // ... 原有逻辑 ...
  this.connections.set(wsId, entry);
  // 同步到 TransportStore（跨节点可见）
  if (entry.instanceId) {
    getTransportStore().setRelaySocket(entry.instanceId, wsId).catch(() => {});
  }
}

// 在 remove 方法中添加 store 清理：
remove(wsId: string): void {
  // ... 原有清理逻辑 ...
  const entry = this.connections.get(wsId); // 在 delete 之前获取
  this.connections.delete(wsId);
  // 清理 TransportStore
  if (entry?.instanceId) {
    getTransportStore().delRelaySocket(entry.instanceId).catch(() => {});
  }
}
```

- [ ] **Step 3: 提交**

```bash
git add src/transport/relay/connection-manager.ts
git commit -m "feat: relay connection-manager 集成 TransportStore 跨节点同步"
```

---

### Task 6: 业务 handler 适配 — acp-ws-handler.ts EventBus

**Files:**
- Modify: `src/transport/acp-ws-handler.ts`
- Modify: `src/transport/event-bus.ts`

- [ ] **Step 1: EventBus 集成 TransportStore Pub/Sub**

在 `src/transport/event-bus.ts` 的 `EventBus.publish()` 方法中，在本地 subscriber 循环后添加跨节点广播：

```typescript
import { getTransportStore } from "./store/factory";

// 在 publish 方法的本地广播之后添加：
publish(event: Omit<SessionEvent, "seqNum" | "createdAt">): SessionEvent {
  // ... 原有本地发布逻辑 ...

  // 跨节点广播：通过 TransportStore Pub/Sub 发送到其他 RCS 节点
  try {
    getTransportStore().publish(
      `session:${event.sessionId}`,
      JSON.stringify(full),
    ).catch((err) => logError("[EventBus] cross-node publish error:", err));
  } catch {
    // TransportStore 未初始化时忽略（测试环境）
  }

  return full;
}
```

- [ ] **Step 2: acp-ws-handler 集成 TransportStore**

在 `src/transport/acp-ws-handler.ts` 中，将 `handleMachineRegister` 中的内存 cache 同步到 TransportStore：

```typescript
import { getTransportStore } from "./store/factory";

// 在 handleMachineRegister 注册成功后：
await getTransportStore().setMachineSocket(result.id, entry.wsId).catch(() => {});

// 在 performMachineCleanup 中清理：
await getTransportStore().delMachineSocket(machineId).catch(() => {});
```

- [ ] **Step 3: 提交**

```bash
git add src/transport/event-bus.ts src/transport/acp-ws-handler.ts
git commit -m "feat: EventBus + MachineCache 集成 TransportStore Pub/Sub 和 KV"
```

---

### Task 7: 清理 acp/index.ts 中残留的 Elysia WS 引用

**Files:**
- Modify: `src/routes/acp/index.ts`

- [ ] **Step 1: 确认只保留 HTTP GET /agents 路由**

完整内容应为：

```typescript
import Elysia from "elysia";
import { environmentRepo } from "../../repositories";
import { AcpAgentListResponseSchema } from "../../schemas";
import { authGuardPlugin } from "../../plugins/auth";

function toAcpAgentResponse(env: NonNullable<Awaited<ReturnType<typeof environmentRepo.getById>>>) {
  return {
    id: env.id,
    agent_name: env.machineName,
    status: (env.status === "active" ? "online" : "offline") as "online" | "offline",
    max_sessions: env.maxSessions,
    last_seen_at: env.lastPollAt ? env.lastPollAt.getTime() / 1000 : null,
    created_at: env.createdAt.getTime() / 1000,
  };
}

const app = new Elysia({ name: "acp", prefix: "/acp" })
  .use(authGuardPlugin)
  .model({ "acp-agent-list-response": AcpAgentListResponseSchema })
  .get("/agents", async ({ store }: any) => {
    const authCtx = store.authContext;
    const orgId = authCtx?.organizationId ?? store.user!.id;
    const teamEnvs = await environmentRepo.listByOrganizationId(orgId);
    const acpEnvs = teamEnvs.filter((e) => e.workerType === "acp");
    return acpEnvs.map((a) => toAcpAgentResponse(a));
  }, {
    sessionAuth: true,
    response: "acp-agent-list-response",
    detail: {
      tags: ["ACP"],
      summary: "获取 ACP Agent 列表",
      description: "返回当前组织下所有使用 ACP worker 的环境列表及在线状态摘要。",
    },
  });

export default app;
```

- [ ] **Step 2: 提交**

```bash
git add src/routes/acp/index.ts
git commit -m "refactor: acp routes 仅保留 HTTP /agents，WS 迁移到 socket.io namespace"
```

---

### Task 8: index.ts — socket.io 最终集成 + graceful shutdown

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: 在 app.listen 后初始化 socket.io**

在 `src/index.ts` 底部，`app.listen()` 之后添加：

```typescript
// 初始化 socket.io server（三个 namespace：/relay /machine /file）
import { initSocketIOServer } from "./transport/socketio-server";
import { registerNamespaces } from "./transport/socketio-namespaces";
const io = initSocketIOServer(app.server!);
registerNamespaces(io);
startupLog.info("socket.io server attached with namespaces: /relay, /machine, /file");
```

- [ ] **Step 2: 在 graceful shutdown 中添加清理**

在 `process.on("SIGTERM"`) 或现有的 shutdown 逻辑中，添加：

```typescript
// 在 closeAllRelayConnections() / closeAllAcpConnections() 之后：
import { closeTransportStore } from "./transport/store/factory";
try {
  io.close();
  await closeTransportStore();
  startupLog.info("socket.io server and TransportStore closed");
} catch (err) {
  startupLog.error("Error closing socket.io server:", err);
}
```

- [ ] **Step 3: 提交**

```bash
git add src/index.ts
git commit -m "feat: index.ts 集成 socket.io server + graceful shutdown"
```

---

### Task 9: 前端 — socket.io-client Transport 替换

**Files:**
- Modify: `packages/acp-link/src/client/transport.ts`
- Modify: `packages/acp-link/src/client/client.ts`

- [ ] **Step 1: 重写 WSTransport 为 SocketIOTransport**

修改 `packages/acp-link/src/client/transport.ts`：

```typescript
import { io, Socket } from "socket.io-client";
import { EventEmitter } from "./emitter.js";

export type TransportState = "connecting" | "connected" | "disconnected" | "error";

export interface TransportEvents {
  state: { state: TransportState; detail?: CloseEvent };
  message: string;
  reconnecting: { attempt: number; maxAttempts: number };
  reconnectFailed: undefined;
  [key: string]: unknown;
}

/**
 * socket.io 传输层，替代原生 WebSocket。
 *
 * 职责：
 * - 连接/断开 socket.io socket
 * - 自动重连 + 心跳（socket.io 内置）
 * - 收发原始字符串
 * - 传播连接状态
 */
export class SocketIOTransport extends EventEmitter<TransportEvents> {
  private socket: Socket | null = null;
  private _state: TransportState = "disconnected";
  private namespace = "";
  private query: Record<string, string> = {};

  get state(): TransportState {
    return this._state;
  }

  connect(namespace: string, query?: Record<string, string>): void {
    this.namespace = namespace;
    this.query = query ?? {};
    this.createConnection();
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }
    this.socket = null;
    this.setState("disconnected");
  }

  send(data: string): void {
    if (!this.socket?.connected) {
      throw new Error("Socket not connected");
    }
    this.socket.send(data);
  }

  private createConnection(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
    }

    this.setState("connecting");

    const socket = io(this.namespace, {
      query: this.query,
      transports: ["websocket"],
      // socket.io 自带指数退避重连
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30000,
      // 30s 超时
      timeout: 30000,
      // 不自动连接（由 ACPClient.connect() 控制）
      autoConnect: true,
    });

    this.socket = socket;

    socket.on("connect", () => {
      this.setState("connected");
    });

    socket.on("disconnect", (reason) => {
      if (reason === "io client disconnect") {
        this.setState("disconnected");
      } else {
        // socket.io 会自动重连，不手动处理
      }
    });

    socket.on("connect_error", (_err) => {
      // connect_error 后 socket.io 会自动重试
    });

    socket.on("reconnect_attempt", (attempt) => {
      this.emit("reconnecting", { attempt, maxAttempts: 10 });
    });

    socket.on("reconnect_failed", () => {
      this.setState("error");
      this.emit("reconnectFailed");
    });

    socket.on("message", (data: string) => {
      this.emit("message", data);
    });
  }

  private setState(state: TransportState, detail?: CloseEvent): void {
    this._state = state;
    this.emit("state", { state, detail });
  }
}

// 保持向后兼容：WSTransport 导出为 SocketIOTransport 的别名
export { SocketIOTransport as WSTransport };
```

- [ ] **Step 2: 修改 ACPClient 适配 socket.io transport**

修改 `packages/acp-link/src/client/client.ts`：

```typescript
// import { WSTransport } from "./transport.js";  // 旧
import { SocketIOTransport } from "./transport.js"; // 新

// 在 constructor 中：
constructor(settings: ACPSettings) {
  this.transport = new SocketIOTransport();  // 替换 new WSTransport()
  // ... 其余不变 ...

// 在 connect 方法中：
async connect(): Promise<void> {
  this.disconnect();
  
  // socket.io 需要 namespace 和 query 参数
  const ns = this.settings.namespace ?? "/relay";
  const query: Record<string, string> = {
    agentId: this.settings.agentId ?? "",
    sessionId: this.settings.sessionId ?? "",
  };
  if (this.settings.activeOrganizationId) {
    query.activeOrganizationId = this.settings.activeOrganizationId;
  }

  this.connecting = true;

  return new Promise<void>((resolve, reject) => {
    this.connectResolve = resolve;
    this.connectReject = reject;
    try {
      this.transport.connect(ns, query);
    } catch (error) {
      this.connecting = false;
      reject(error);
    }
  });
}

// 移除 startHeartbeat/stopHeartbeat（socket.io 自带心跳）
// 移除 ACPClient 中所有 heartbeat 相关代码（heartbeatInterval, heartbeatTimeout, missedPongs, HEARTBEAT_INTERVAL_MS 等）
```

- [ ] **Step 3: 更新 ACPSettings 类型**

在 `packages/acp-link/src/types.ts` 中，扩展 `ACPSettings`：

```typescript
export interface ACPSettings {
  proxyUrl?: string;  // 保留兼容但不再使用
  token?: string;
  cwd?: string;
  // socket.io 新增字段
  namespace?: string;   // socket.io namespace，默认 "/relay"
  agentId?: string;     // agent ID，作为 query param
  sessionId?: string;   // session ID，作为 query param
  activeOrganizationId?: string; // 组织 ID
}
```

- [ ] **Step 4: 提交**

```bash
git add packages/acp-link/src/client/transport.ts packages/acp-link/src/client/client.ts packages/acp-link/src/types.ts
git commit -m "feat: 前端 transport 原生 WebSocket → socket.io-client，移除手写重连/心跳"
```

---

### Task 10: 前端 — relay-client.ts 适配 socket.io

**Files:**
- Modify: `web/src/acp/relay-client.ts`

- [ ] **Step 1: 重写 relay-client.ts**

```typescript
import { ACPClient } from "./client";
import type { ACPSettings } from "./types";

/**
 * Create an ACPClient that connects to an agent through the socket.io /relay namespace.
 * Authentication is handled via cookies (better-auth session).
 */
export function createRelayClient(agentId: string, sessionId?: string): ACPClient {
  const activeOrgId = localStorage.getItem("active_org_id") ?? undefined;

  const settings: ACPSettings = {
    namespace: "/relay",
    agentId,
    sessionId: sessionId ?? undefined,
    activeOrganizationId: activeOrgId,
  };

  return new ACPClient(settings);
}
```

- [ ] **Step 2: 提交**

```bash
git add web/src/acp/relay-client.ts
git commit -m "feat: relay-client 适配 socket.io namespace + query params"
```

---

### Task 11: docker-compose 添加 Redis 容器

**Files:**
- Modify: `docker-compose.yml` 或 `docker-compose.prod.yml`

- [ ] **Step 1: 添加 Redis 服务**

```yaml
redis:
  image: redis:7-alpine
  ports:
    - "6379:6379"
  volumes:
    - redis_data:/data
  restart: unless-stopped
  healthcheck:
    test: ["CMD", "redis-cli", "ping"]
    interval: 10s
    timeout: 3s
    retries: 3
```

在 volumes 中添加 `redis_data:`。

- [ ] **Step 2: 在 RCS 服务中添加环境变量和依赖**

```yaml
rcs:
  # ... 现有配置 ...
  environment:
    # ... 现有 env ...
    - RCS_REDIS_URL=redis://redis:6379  # 多节点时启用
  depends_on:
    - redis
```

- [ ] **Step 3: 提交**

```bash
git add docker-compose.yml
git commit -m "chore: docker-compose 添加 Redis 7 容器"
```

---

### Task 12: 构建验证 + precheck

**Files:**
- 无新增，验证以上所有改动

- [ ] **Step 1: 安装依赖并检查**

```bash
bun install
```

- [ ] **Step 2: 前端构建**

```bash
bun run build:web
```

Expected: 构建成功，无错误

- [ ] **Step 3: 后端类型检查**

```bash
bun run tsc --noEmit
```

Expected: 0 error

- [ ] **Step 4: Lint 检查**

```bash
bun run lint
```

Expected: 无新 error/warning

- [ ] **Step 5: 运行全量 precheck**

```bash
bun run precheck
```

Expected: 全部通过

- [ ] **Step 6: 提交**

```bash
git add .
git commit -m "chore: 构建验证通过 — precheck 全绿"
```

---

### Task 13: 集成测试（可选，需启动服务）

**Files:**
- Create: `src/__tests__/socketio-integration.test.ts`

- [ ] **Step 1: 编写 socket.io 连接测试**

```typescript
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { io } from "socket.io-client";

// 假设服务已启动在 3000 端口
const BASE = "http://localhost:3000";

describe("socket.io relay namespace", () => {
  test("should reject unauthenticated connection", async () => {
    const socket = io(`${BASE}/relay`, {
      transports: ["websocket"],
      autoConnect: false,
    });

    await expect(
      new Promise((_, reject) => {
        socket.on("connect_error", (err) => reject(err));
        socket.connect();
      })
    ).rejects.toBeTruthy();

    socket.disconnect();
  });
});
```

- [ ] **Step 2: 运行测试**

```bash
bun test src/__tests__/socketio-integration.test.ts
```

- [ ] **Step 3: 提交**

```bash
git add src/__tests__/socketio-integration.test.ts
git commit -m "test: socket.io relay namespace 认证测试"
```
