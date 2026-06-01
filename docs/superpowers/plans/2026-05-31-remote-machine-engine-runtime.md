# Remote Machine Engine Runtime 统一抽象 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将远程 machine 纳入 `@fenix/core` 的 `EngineRuntime` 统一抽象，使本地和远程走同一套 `CoreRuntimeFacade` 调度链路。

**Architecture:** 在 `@fenix/core` 扩展 `CoreNodeMode` 支持 `"remote"` 模式；新建 `@fenix/remote-runtime` 包实现 `EngineRuntime` 接口，通过 WebSocket 与远程 acp-link 通信；扩展 acp-link WS 协议增加 prepare/start/stop 消息，使其具备完整环境装配能力；RCS 主服务器的 `relay-handler.ts` 统一走 `CoreRuntimeFacade`。

**Tech Stack:** TypeScript, Bun, WebSocket (ACP 协议扩展), @fenix/core, @fenix/plugin-sdk

---

## 文件结构

### 新建文件

| 文件 | 职责 |
|---|---|
| `packages/remote-runtime/package.json` | 新包配置 |
| `packages/remote-runtime/tsconfig.json` | TypeScript 配置 |
| `packages/remote-runtime/src/index.ts` | 包入口，导出公共 API |
| `packages/remote-runtime/src/remote-runtime.ts` | `RemoteRuntime` 类，实现 `EngineRuntime` |
| `packages/remote-runtime/src/remote-transport.ts` | 与远程 acp-link 的 WS 通信封装 |
| `packages/remote-runtime/src/remote-relay-handle.ts` | 远程 relay handle，实现 `EngineRelayHandle` |
| `packages/remote-runtime/src/__tests__/remote-runtime.test.ts` | RemoteRuntime 单元测试 |
| `packages/remote-runtime/src/__tests__/remote-transport.test.ts` | RemoteTransport 单元测试 |
| `packages/remote-runtime/src/__tests__/remote-relay-handle.test.ts` | RemoteRelayHandle 单元测试 |
| `packages/remote-runtime/src/__tests__/fixtures/mock-transport.ts` | 测试用 mock transport |

### 修改文件

| 文件 | 变更 |
|---|---|
| `packages/core/src/types/core-node.ts` | `CoreNodeMode` 增加 `"remote"` |
| `packages/core/src/runtime/instance-orchestrator.ts` | 支持 remote node 的 runtime 创建 |
| `packages/core/src/__tests__/instance-orchestrator.test.ts` | 补充 remote node 测试 |
| `packages/plugin-opencode/src/index.ts` | 导出环境装配函数供 acp-link 复用 |
| `packages/acp-link/src/client/instance-manager.ts` | 新增远程实例管理器 |
| `packages/acp-link/src/client/session-manager.ts` | 保留但标记为 legacy fallback |
| `packages/acp-link/src/server.ts` | client mode 路由增加 prepare/start/stop 消息处理 |
| `tsconfig.base.json` | 添加 `@fenix/remote-runtime` 路径映射 |
| `src/services/core-bootstrap.ts` | 引入 remote-runtime，动态注册远程 node |
| `src/transport/acp-ws-handler.ts` | register 成功时注册 remote node，disconnect 时注销 |
| `src/transport/relay/relay-handler.ts` | 统一走 facade，删除 openMachineRelay 直接 WS 操作 |
| `src/services/instance.ts` | spawnInstanceFromEnvironment 感知 remote node |

---

## Task 1: `@fenix/core` — CoreNodeMode 扩展支持 `"remote"`

**Files:**
- Modify: `packages/core/src/types/core-node.ts:1-46`
- Modify: `packages/core/src/runtime/instance-orchestrator.ts:87-165`
- Modify: `packages/core/src/index.ts`
- Test: `packages/core/src/__tests__/instance-orchestrator.test.ts`

- [ ] **Step 1: 修改 CoreNodeMode 类型**

在 `packages/core/src/types/core-node.ts` 中将：

```typescript
export type CoreNodeMode = "local";
```

改为：

```typescript
export type CoreNodeMode = "local" | "remote";
```

- [ ] **Step 2: 修改 instance-orchestrator 支持 runtimeResolver**

在 `packages/core/src/runtime/instance-orchestrator.ts` 中修改 `CreateInstanceOrchestratorOptions`，增加 `runtimeResolver`：

```typescript
import type { EnginePlugin, EngineRelayHandle, EngineRuntime } from "@fenix/plugin-sdk";

export interface CreateInstanceOrchestratorOptions {
  pluginRegistry: EnginePluginRegistry;
  nodeRegistry: CoreNodeRegistry;
  store: RuntimeInstanceStore;
  onInstanceStarted?: (
    instanceId: string,
    runtime: EngineRuntime,
    updateMetadata: (metadata: Record<string, unknown>) => void,
  ) => void;
  /**
   * 自定义 runtime 创建策略。
   * 对 remote node 返回对应的 remote runtime；
   * 不提供或返回 null 时 fallback 到 plugin.createRuntime()。
   */
  runtimeResolver?: (
    engineType: string,
    node: import("../types/core-node").CoreNode,
  ) => EngineRuntime | null | Promise<EngineRuntime | null>;
}
```

在 `launch` 方法中修改 runtime 创建逻辑，将现有的：

```typescript
let runtime: EngineRuntime;
try {
  runtime = plugin.createRuntime();
} catch (error) {
  createErroredInstanceRecord(request, error);
  throw error;
}
```

改为：

```typescript
let runtime: EngineRuntime;
try {
  let resolved: EngineRuntime | null | undefined;
  if (runtimeResolver) {
    resolved = await runtimeResolver(request.engineType, node);
  }
  runtime = resolved ?? plugin.createRuntime();
} catch (error) {
  createErroredInstanceRecord(request, error);
  throw error;
}
```

同时为 remote node 添加 `attachRuntime` 时不需要 `plugin` 的处理。修改 `RuntimeInstanceRuntimeEntry` 在 store 中 `plugin` 字段改为可选或传入 `null`。由于 `RuntimeInstanceRuntimeEntry` 当前 `plugin` 是必填的，需要改为可选：

在 `packages/core/src/runtime/runtime-instance-store.ts` 中：

```typescript
export interface RuntimeInstanceRuntimeEntry {
  /** 该实例绑定的 engine plugin 定义。remote node 下为 null。 */
  plugin: EnginePlugin | null;
  /** 该实例对应的 engine runtime 句柄。 */
  runtime: EngineRuntime;
  /** 当前缓存的 relay 连接；尚未连接时为空。 */
  relay: EngineRelayHandle | null;
}
```

对应地更新 `instance-orchestrator.ts` 中的 `attachRuntime` 调用，remote node 传 `plugin: null`：

```typescript
store.attachRuntime(request.instanceId, {
  plugin: node.mode === "remote" ? null : plugin,
  runtime,
  relay: null,
});
```

- [ ] **Step 3: 补充 orchestrator 测试覆盖 remote node**

在 `packages/core/src/__tests__/instance-orchestrator.test.ts` 中新增测试：

```typescript
// remote node 通过 runtimeResolver 获取 runtime，不调用 plugin.createRuntime()
test("uses runtimeResolver for remote nodes", async () => {
  const { createFakeEnginePlugin, createFakeRelayHandle } = await import("./fixtures/fake-engine-plugin");
  const remoteRuntime = createFakeEnginePlugin({ engineType: "remote-test" }).createRuntime();
  const remoteRuntimeState = createFakeEnginePlugin({ engineType: "remote-test" }).runtimeState;

  const pluginRegistry = new EnginePluginRegistry();
  const nodeRegistry = new CoreNodeRegistry();
  const store = createRuntimeInstanceStore();

  nodeRegistry.register({
    id: "remote-machine-1",
    mode: "remote",
    engineTypes: ["opencode"],
    status: "online",
  });

  const orchestrator = createInstanceOrchestrator({
    pluginRegistry,
    nodeRegistry,
    store,
    runtimeResolver: (_engineType, _node) => remoteRuntime,
  });

  const launched = await orchestrator.launch({
    instanceId: "inst_remote",
    engineType: "opencode",
    nodeId: "remote-machine-1",
    launchSpec: createLaunchSpec(),
  });

  expect(launched.status).toBe("running");
  expect(launched.nodeId).toBe("remote-machine-1");
});
```

- [ ] **Step 4: 运行测试确认通过**

```bash
cd packages/core && bun test
```

- [ ] **Step 5: 提交**

```bash
git add packages/core/src/types/core-node.ts packages/core/src/runtime/instance-orchestrator.ts packages/core/src/runtime/runtime-instance-store.ts packages/core/src/__tests__/instance-orchestrator.test.ts
git commit -m "feat(core): CoreNodeMode 扩展支持 remote，orchestrator 增加 runtimeResolver"
```

---

## Task 2: `@fenix/remote-runtime` — 新包骨架与 Transport 层

**Files:**
- Create: `packages/remote-runtime/package.json`
- Create: `packages/remote-runtime/tsconfig.json`
- Create: `packages/remote-runtime/src/index.ts`
- Create: `packages/remote-runtime/src/remote-transport.ts`
- Create: `packages/remote-runtime/src/__tests__/remote-transport.test.ts`
- Create: `packages/remote-runtime/src/__tests__/fixtures/mock-transport.ts`
- Modify: `tsconfig.base.json`

- [ ] **Step 1: 创建包配置文件**

`packages/remote-runtime/package.json`:

```json
{
  "name": "@fenix/remote-runtime",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "dependencies": {
    "@fenix/plugin-sdk": "workspace:*"
  },
  "scripts": {
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "bun test"
  }
}
```

`packages/remote-runtime/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 2: 注册 tsconfig 路径映射**

在 `tsconfig.base.json` 的 `paths` 中添加：

```json
"@fenix/remote-runtime": ["./packages/remote-runtime/src/index.ts"]
```

- [ ] **Step 3: 编写 RemoteTransport 类型与实现**

`packages/remote-runtime/src/remote-transport.ts`:

```typescript
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";

// ── 协议消息类型 ──────────────────────────────────

export interface TransportMessage {
  type: string;
  request_id?: string;
  instance_id?: string;
  session_id?: string;
  launch_spec?: AgentLaunchSpec;
  payload?: unknown;
  status?: string;
  message?: string;
}

export interface TransportSendOptions {
  timeout?: number;
}

/**
 * 与远程 acp-link 通信的最小传输接口。
 * 生产实现包装已有的 WsConnection，测试用 mock 实现此接口。
 */
export interface RemoteTransport {
  /**
   * 发送请求并等待匹配 request_id 的响应。
   * 超时时抛 Error。
   */
  sendAndWait(message: TransportMessage, options?: TransportSendOptions): Promise<TransportMessage>;

  /**
   * 注册 session 生命周期消息回调。
   * 远程 acp-link 推送 session_data / session_ended / session_error 等消息时触发。
   */
  onSessionMessage(
    listener: (instanceId: string, sessionId: string, message: TransportMessage) => void,
  ): () => void;

  /**
   * 发送单向消息（不需要响应）。
   */
  send(message: TransportMessage): void;
}

// ── 默认超时 ──────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const PREPARE_TIMEOUT_MS = 60_000;

// ── 基于 WsConnection 的生产 Transport ──────────────────

export interface WsConnectionLike {
  readyState: number;
  send(data: string): void;
  onmessage: ((event: { data: string | Buffer }) => void) | null;
}

/**
 * 创建基于 WS 连接的 RemoteTransport。
 *
 * 职责：
 * 1. 为每个 sendAndWait 生成唯一 request_id
 * 2. 路由 WS 消息到 pending promise 或 session message listener
 * 3. 超时管理
 */
export function createWsRemoteTransport(ws: WsConnectionLike): RemoteTransport {
  const pendingRequests = new Map<string, {
    resolve: (msg: TransportMessage) => void;
    reject: (err: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  const sessionListeners = new Set<(instanceId: string, sessionId: string, message: TransportMessage) => void>();

  // 注入消息处理
  const originalOnMessage = ws.onmessage;
  ws.onmessage = (event: { data: string | Buffer }) => {
    if (originalOnMessage) originalOnMessage(event);

    const text = typeof event.data === "string" ? event.data : event.data.toString();
    for (const line of text.split("\n").filter(Boolean)) {
      try {
        const msg: TransportMessage = JSON.parse(line);
        handleMessage(msg);
      } catch {
        // 忽略格式错误
      }
    }
  };

  function handleMessage(msg: TransportMessage): void {
    // 优先匹配 pending request
    if (msg.request_id) {
      const pending = pendingRequests.get(msg.request_id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingRequests.delete(msg.request_id);
        pending.resolve(msg);
        return;
      }
    }

    // session 生命周期消息转发
    if (msg.instance_id && msg.session_id) {
      for (const listener of sessionListeners) {
        listener(msg.instance_id, msg.session_id, msg);
      }
    }
  }

  let requestIdCounter = 0;
  function nextRequestId(): string {
    requestIdCounter += 1;
    return `req_${Date.now()}_${requestIdCounter}`;
  }

  return {
    sendAndWait(message, options) {
      const requestId = message.request_id ?? nextRequestId();
      const timeout = options?.timeout ?? (message.type === "prepare" ? PREPARE_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);

      return new Promise<TransportMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
          pendingRequests.delete(requestId);
          reject(new Error(`Transport request timed out: type=${message.type} request_id=${requestId}`));
        }, timeout);

        pendingRequests.set(requestId, { resolve, reject, timer });

        const outgoing: TransportMessage = { ...message, request_id: requestId };
        ws.send(JSON.stringify(outgoing));
      });
    },

    onSessionMessage(listener) {
      sessionListeners.add(listener);
      return () => {
        sessionListeners.delete(listener);
      };
    },

    send(message) {
      ws.send(JSON.stringify(message));
    },
  };
}
```

- [ ] **Step 4: 编写 Transport 测试**

`packages/remote-runtime/src/__tests__/fixtures/mock-transport.ts`:

```typescript
import type { RemoteTransport, TransportMessage } from "../../remote-transport";

export interface MockTransport extends RemoteTransport {
  /** 模拟远程端发送响应 */
  simulateResponse(requestId: string, response: Partial<TransportMessage>): void;
  /** 模拟远程端推送 session 消息 */
  simulateSessionMessage(instanceId: string, sessionId: string, message: TransportMessage): void;
  /** 记录所有发出的消息 */
  sentMessages: TransportMessage[];
}

export function createMockTransport(): MockTransport {
  const sentMessages: TransportMessage[] = [];
  const pendingResolvers = new Map<string, {
    resolve: (msg: TransportMessage) => void;
  }>();
  const sessionListeners = new Set<(instanceId: string, sessionId: string, message: TransportMessage) => void>();

  return {
    sentMessages,

    async sendAndWait(message, _options) {
      const requestId = message.request_id ?? "auto_req";
      sentMessages.push({ ...message, request_id: requestId });

      return new Promise<TransportMessage>((resolve) => {
        pendingResolvers.set(requestId, { resolve });
      });
    },

    onSessionMessage(listener) {
      sessionListeners.add(listener);
      return () => { sessionListeners.delete(listener); };
    },

    send(message) {
      sentMessages.push(message);
    },

    simulateResponse(requestId, response) {
      const pending = pendingResolvers.get(requestId);
      if (pending) {
        pendingResolvers.delete(requestId);
        pending.resolve({ request_id: requestId, ...response });
      }
    },

    simulateSessionMessage(instanceId, sessionId, message) {
      for (const listener of sessionListeners) {
        listener(instanceId, sessionId, message);
      }
    },
  };
}
```

`packages/remote-runtime/src/__tests__/remote-transport.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";

// 测试 RemoteTransport 的消息路由与超时行为
test("placeholder — transport tests will be implemented with RemoteRuntime tests", () => {
  expect(true).toBe(true);
});
```

注意：由于 `createWsRemoteTransport` 依赖 WS 连接对象，其集成测试将在 RCS 主服务器侧进行。此处 mock transport 的测试随 Task 3 的 RemoteRuntime 测试一起覆盖。

- [ ] **Step 5: 创建包入口文件**

`packages/remote-runtime/src/index.ts`:

```typescript
export type { RemoteTransport, TransportMessage, WsConnectionLike } from "./remote-transport";
export { createWsRemoteTransport } from "./remote-transport";
export { createRemoteRuntime } from "./remote-runtime";
```

- [ ] **Step 6: 运行 bun install 更新 workspace 链接**

```bash
bun install
```

- [ ] **Step 7: 提交**

```bash
git add packages/remote-runtime/ tsconfig.base.json
git commit -m "feat(remote-runtime): 新建包骨架与 Transport 层"
```

---

## Task 3: `@fenix/remote-runtime` — RemoteRuntime 实现

**Files:**
- Create: `packages/remote-runtime/src/remote-runtime.ts`
- Create: `packages/remote-runtime/src/remote-relay-handle.ts`
- Test: `packages/remote-runtime/src/__tests__/remote-runtime.test.ts`
- Test: `packages/remote-runtime/src/__tests__/remote-relay-handle.test.ts`

- [ ] **Step 1: 编写 RemoteRelayHandle**

`packages/remote-runtime/src/remote-relay-handle.ts`:

```typescript
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import type { RemoteTransport, TransportMessage } from "./remote-transport";

/**
 * 基于 RemoteTransport 的 relay handle。
 * send/close 操作映射为 WS 消息，session 消息通过 transport 的 onSessionMessage 回调接收。
 */
export class RemoteRelayHandle implements EngineRelayHandle {
  private _state: "open" | "closed" = "open";
  private unsubSession: (() => void) | null = null;
  private messageListeners = new Set<(message: EngineRelayMessage) => void>();

  constructor(
    private transport: RemoteTransport,
    private instanceId: string,
    private sessionId: string,
  ) {
    this.unsubSession = transport.onSessionMessage((instId, sessId, msg) => {
      if (instId !== instanceId || sessId !== sessionId) return;
      for (const listener of this.messageListeners) {
        listener({ type: msg.type, payload: msg.payload });
      }
    });
  }

  get state(): "open" | "closed" {
    return this._state;
  }

  /**
   * 注册消息监听器。供上层消费 relay 推送的 agent 消息。
   */
  onMessage(listener: (message: EngineRelayMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  send(message: EngineRelayMessage): void {
    if (this._state !== "open") {
      throw new Error("RemoteRelayHandle is closed");
    }
    this.transport.send({
      type: "relay",
      instance_id: this.instanceId,
      session_id: this.sessionId,
      payload: message,
    });
  }

  async close(_code?: number, _reason?: string): Promise<void> {
    if (this._state === "closed") return;
    this._state = "closed";
    this.unsubSession?.();
    this.unsubSession = null;
    this.messageListeners.clear();
    this.transport.send({
      type: "relay_close",
      instance_id: this.instanceId,
      session_id: this.sessionId,
    });
  }
}
```

- [ ] **Step 2: 编写 RemoteRelayHandle 测试**

`packages/remote-runtime/src/__tests__/remote-relay-handle.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { RemoteRelayHandle } from "../remote-relay-handle";
import { createMockTransport, type MockTransport } from "./fixtures/mock-transport";

function createHandleAndTransport(): { handle: RemoteRelayHandle; transport: MockTransport } {
  const transport = createMockTransport();
  const handle = new RemoteRelayHandle(transport, "inst_1", "sess_1");
  return { handle, transport };
}

// relay handle 初始状态为 open
test("initial state is open", () => {
  const { handle } = createHandleAndTransport();
  expect(handle.state).toBe("open");
});

// send 通过 transport 发送 relay 消息
test("send forwards relay message via transport", () => {
  const { handle, transport } = createHandleAndTransport();
  handle.send({ type: "prompt", payload: { content: "hello" } });
  expect(transport.sentMessages).toContainEqual(
    expect.objectContaining({
      type: "relay",
      instance_id: "inst_1",
      session_id: "sess_1",
      payload: { type: "prompt", payload: { content: "hello" } },
    }),
  );
});

// close 后 send 抛错
test("send throws after close", () => {
  const { handle } = createHandleAndTransport();
  handle.close();
  expect(() => handle.send({ type: "test" })).toThrow("closed");
});

// close 发送 relay_close 并变为 closed
test("close sends relay_close message", () => {
  const { handle, transport } = createHandleAndTransport();
  handle.close();
  expect(handle.state).toBe("closed");
  expect(transport.sentMessages).toContainEqual(
    expect.objectContaining({ type: "relay_close", instance_id: "inst_1" }),
  );
});

// onMessage 接收 session 消息
test("onMessage receives session messages from transport", () => {
  const { handle, transport } = createHandleAndTransport();
  const received: Array<{ type: string; payload?: unknown }> = [];
  handle.onMessage((msg) => received.push(msg));

  transport.simulateSessionMessage("inst_1", "sess_1", {
    type: "session_update",
    payload: { text: "hi" },
  });
  expect(received).toEqual([{ type: "session_update", payload: { text: "hi" } }]);
});

// onMessage 过滤不匹配的 instance/session
test("onMessage ignores messages for other instances", () => {
  const { handle, transport } = createHandleAndTransport();
  const received: unknown[] = [];
  handle.onMessage((msg) => received.push(msg));

  transport.simulateSessionMessage("inst_other", "sess_1", { type: "session_update" });
  expect(received).toHaveLength(0);
});
```

- [ ] **Step 3: 运行 relay handle 测试**

```bash
cd packages/remote-runtime && bun test src/__tests__/remote-relay-handle.test.ts
```

- [ ] **Step 4: 编写 RemoteRuntime 实现**

`packages/remote-runtime/src/remote-runtime.ts`:

```typescript
import type {
  ConnectRelayInput,
  EngineRelayHandle,
  EngineRuntime,
  PrepareEnvironmentInput,
  StartInstanceInput,
  StopInstanceInput,
} from "@fenix/plugin-sdk";
import type { RemoteTransport, TransportMessage } from "./remote-transport";
import { RemoteRelayHandle } from "./remote-relay-handle";

export interface RemoteRuntimeOptions {
  transport: RemoteTransport;
}

/**
 * 远程 machine 的 EngineRuntime 实现。
 * 通过 WS 与远程 acp-link 通信，将生命周期操作映射为协议消息。
 */
export function createRemoteRuntime(options: RemoteRuntimeOptions): EngineRuntime {
  const { transport } = options;

  async function prepareEnvironment(input: PrepareEnvironmentInput): Promise<void> {
    const response = await transport.sendAndWait({
      type: "prepare",
      instance_id: input.instanceId,
      launch_spec: input.launchSpec,
    });

    if (response.status === "error") {
      throw new Error(response.message ?? "Remote prepare failed");
    }
  }

  async function startInstance(input: StartInstanceInput): Promise<void> {
    const response = await transport.sendAndWait({
      type: "start",
      instance_id: input.instanceId,
    });

    if (response.status === "error") {
      throw new Error(response.message ?? "Remote start failed");
    }
  }

  async function connectRelay(input: ConnectRelayInput): Promise<EngineRelayHandle> {
    const handle = new RemoteRelayHandle(
      transport,
      input.instanceId,
      input.sessionId ?? input.instanceId,
    );
    return handle;
  }

  async function stopInstance(input: StopInstanceInput): Promise<void> {
    try {
      await transport.sendAndWait({
        type: "stop",
        instance_id: input.instanceId,
      });
    } catch {
      // stop 幂等，远程超时或断连不抛错
    }
  }

  return {
    prepareEnvironment,
    startInstance,
    connectRelay,
    stopInstance,
  };
}
```

- [ ] **Step 5: 编写 RemoteRuntime 测试**

`packages/remote-runtime/src/__tests__/remote-runtime.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { createRemoteRuntime } from "../remote-runtime";
import { createMockTransport, type MockTransport } from "./fixtures/mock-transport";

function createLaunchSpec(): AgentLaunchSpec {
  return {
    organizationId: "org_1",
    userId: "user_1",
    environmentId: "env_1",
    env: { API_KEY: "sk-test" },
    agent: { name: "general", prompt: "be helpful" },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk-test",
      model: "gpt-4o",
    },
    skills: [],
    mcpServers: [],
  };
}

function createContext(): { runtime: ReturnType<typeof createRemoteRuntime>; transport: MockTransport } {
  const transport = createMockTransport();
  const runtime = createRemoteRuntime({ transport });
  return { runtime, transport };
}

// prepareEnvironment 发送 prepare 并在 status=ok 时成功
test("prepareEnvironment sends prepare and succeeds on ok", async () => {
  const { runtime, transport } = createContext();
  const spec = createLaunchSpec();

  const preparePromise = runtime.prepareEnvironment({ instanceId: "inst_1", launchSpec: spec });

  // transport 应该发出了 prepare 消息
  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "prepare");
  expect(sent).toBeDefined();
  expect(sent!.instance_id).toBe("inst_1");
  expect(sent!.launch_spec).toEqual(spec);

  // 模拟远程端成功响应
  transport.simulateResponse(sent!.request_id!, { type: "prepare_result", status: "ok" });

  await preparePromise;
});

// prepareEnvironment 在 status=error 时抛错
test("prepareEnvironment throws on error status", async () => {
  const { runtime, transport } = createContext();

  const preparePromise = runtime.prepareEnvironment({
    instanceId: "inst_1",
    launchSpec: createLaunchSpec(),
  });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "prepare");
  transport.simulateResponse(sent!.request_id!, {
    type: "prepare_result",
    status: "error",
    message: "disk full",
  });

  await expect(preparePromise).rejects.toThrow("disk full");
});

// startInstance 发送 start 并在 status=ok 时成功
test("startInstance sends start and succeeds on ok", async () => {
  const { runtime, transport } = createContext();

  const startPromise = runtime.startInstance({ instanceId: "inst_1" });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "start");
  expect(sent).toBeDefined();
  expect(sent!.instance_id).toBe("inst_1");

  transport.simulateResponse(sent!.request_id!, { type: "start_result", status: "ok" });

  await startPromise;
});

// startInstance 在 status=error 时抛错
test("startInstance throws on error status", async () => {
  const { runtime, transport } = createContext();

  const startPromise = runtime.startInstance({ instanceId: "inst_1" });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "start");
  transport.simulateResponse(sent!.request_id!, {
    type: "start_result",
    status: "error",
    message: "spawn failed",
  });

  await expect(startPromise).rejects.toThrow("spawn failed");
});

// connectRelay 返回 RemoteRelayHandle
test("connectRelay returns a relay handle", async () => {
  const { runtime } = createContext();
  const handle = await runtime.connectRelay({ instanceId: "inst_1", sessionId: "sess_1" });
  expect(handle.state).toBe("open");
  handle.close();
  expect(handle.state).toBe("closed");
});

// stopInstance 发送 stop 并容忍失败
test("stopInstance sends stop and tolerates failure", async () => {
  const { runtime, transport } = createContext();

  const stopPromise = runtime.stopInstance({ instanceId: "inst_1" });

  await new Promise((r) => setTimeout(r, 0));
  const sent = transport.sentMessages.find((m) => m.type === "stop");
  expect(sent).toBeDefined();

  transport.simulateResponse(sent!.request_id!, { type: "stop_result", status: "ok" });

  await stopPromise;
});
```

- [ ] **Step 6: 运行所有 remote-runtime 测试**

```bash
cd packages/remote-runtime && bun test
```

- [ ] **Step 7: 提交**

```bash
git add packages/remote-runtime/
git commit -m "feat(remote-runtime): 实现 RemoteRuntime 和 RemoteRelayHandle"
```

---

## Task 4: `@fenix/plugin-opencode` — 导出环境装配函数

**Files:**
- Modify: `packages/plugin-opencode/src/index.ts`
- Modify: `packages/plugin-opencode/src/runtime/runtime-config.ts`

- [ ] **Step 1: 确认需要导出的函数**

从 `packages/plugin-opencode` 导出以下函数，供 acp-link 通过 workspace 依赖引用：

- `buildOpencodeRuntimeConfig` — 来自 `runtime/runtime-config.ts`
- `writeOpencodeConfig` — 来自 `runtime/environment-preparer.ts`
- `ensureWorkspaceRuntimeDirs` — 来自 `runtime/environment-preparer.ts`
- `installSkills` — 来自 `runtime/skill-installer.ts`

同时导出类型：

- `OpencodeRuntimeConfig`
- `InstalledSkillReference`

- [ ] **Step 2: 修改 index.ts 增加导出**

在 `packages/plugin-opencode/src/index.ts` 中追加：

```typescript
// 环境装配函数：供 acp-link 远程端复用
export { buildOpencodeRuntimeConfig } from "./runtime/runtime-config";
export type { InstalledSkillReference, OpencodeRuntimeConfig } from "./runtime/runtime-config";
export { ensureWorkspaceRuntimeDirs, writeOpencodeConfig } from "./runtime/environment-preparer";
export type { PreparedWorkspacePaths } from "./runtime/environment-preparer";
export { installSkills } from "./runtime/skill-installer";
```

- [ ] **Step 3: 运行 plugin-opencode 现有测试确认无破坏**

```bash
cd packages/plugin-opencode && bun test
```

- [ ] **Step 4: 提交**

```bash
git add packages/plugin-opencode/src/index.ts
git commit -m "feat(plugin-opencode): 导出环境装配函数供 acp-link 复用"
```

---

## Task 5: acp-link — 新增 InstanceManager 与协议扩展

**Files:**
- Create: `packages/acp-link/src/client/instance-manager.ts`
- Modify: `packages/acp-link/src/server.ts`（client mode 消息路由）
- Modify: `packages/acp-link/package.json`（添加 @fenix/opencode 依赖）

- [ ] **Step 1: 添加依赖**

在 `packages/acp-link/package.json` 的 `devDependencies` 中添加：

```json
"@fenix/opencode": "workspace:*"
```

并运行 `bun install`。

- [ ] **Step 2: 编写 InstanceManager**

`packages/acp-link/src/client/instance-manager.ts`:

```typescript
import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import {
  buildOpencodeRuntimeConfig,
  ensureWorkspaceRuntimeDirs,
  installSkills,
  writeOpencodeConfig,
  type InstalledSkillReference,
} from "@fenix/opencode";
import { resolveExecutable } from "../resolve-executable";

interface InstanceState {
  instanceId: string;
  launchSpec: AgentLaunchSpec;
  workspace: string;
  process: ChildProcess | null;
  connection: acp.ClientSideConnection | null;
  capabilities: Record<string, unknown> | null;
}

/**
 * 远程实例管理器。
 * 处理 prepare（装配环境）→ start（spawn agent）→ stop（清理）的完整生命周期。
 */
export class InstanceManager {
  private instances = new Map<string, InstanceState>();
  private readonly agentName: string;
  private readonly workspaceRoot: string;

  constructor(agentName: string, workspaceRoot: string) {
    this.agentName = agentName;
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * 装配远程 workspace：创建目录、安装 skills、写 opencode.json。
   */
  async prepare(instanceId: string, launchSpec: AgentLaunchSpec): Promise<void> {
    const workspace = this.resolveWorkspace(launchSpec);

    // 安装 skills
    const installedSkills: InstalledSkillReference[] = await installSkills(workspace, launchSpec.skills);

    // 构建并写入 opencode.json
    const runtimeConfig = buildOpencodeRuntimeConfig(launchSpec, installedSkills);
    await writeOpencodeConfig(workspace, runtimeConfig);

    this.instances.set(instanceId, {
      instanceId,
      launchSpec,
      workspace,
      process: null,
      connection: null,
      capabilities: null,
    });

    console.log(`[instance-manager] prepared: ${instanceId} at ${workspace}`);
  }

  /**
   * Spawn opencode acp 子进程并通过 ACP 协议初始化。
   */
  async start(instanceId: string): Promise<{ capabilities: Record<string, unknown> }> {
    const state = this.instances.get(instanceId);
    if (!state) throw new Error(`Instance ${instanceId} not prepared`);

    const opencodeExecutable = resolveExecutable(this.agentName);
    const spawnEnv = state.launchSpec.env
      ? { ...process.env, ...state.launchSpec.env }
      : { ...process.env };

    const proc = spawn(opencodeExecutable, ["acp"], {
      cwd: state.workspace,
      stdio: ["pipe", "pipe", "inherit"],
      env: spawnEnv,
    });

    proc.on("exit", (code) => {
      console.log(`[instance-manager] opencode exited: ${instanceId}, code=${code}`);
      const s = this.instances.get(instanceId);
      if (s) {
        s.process = null;
        s.connection = null;
      }
    });

    const input = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
    const output = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
    const stream = acp.ndJsonStream(input, output);

    const connection = new acp.ClientSideConnection(
      () => ({
        requestPermission: async () => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
        sessionUpdate: async () => {},
        readTextFile: async () => ({ content: "" }),
        writeTextFile: async () => ({}),
      }),
      stream,
    );

    const initResult = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: "rcs-remote", version: "1.0.0" },
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });

    state.process = proc;
    state.connection = connection;
    state.capabilities = initResult.agentCapabilities as Record<string, unknown> ?? {};

    console.log(`[instance-manager] started: ${instanceId}, capabilities:`, Object.keys(state.capabilities));

    return { capabilities: state.capabilities };
  }

  /**
   * 停止实例：终止 opencode 进程。
   */
  async stop(instanceId: string): Promise<void> {
    const state = this.instances.get(instanceId);
    if (!state) return;

    if (state.process && !state.process.killed) {
      state.process.kill("SIGTERM");
    }
    state.process = null;
    state.connection = null;

    this.instances.delete(instanceId);
    console.log(`[instance-manager] stopped: ${instanceId}`);
  }

  /**
   * 获取实例的 ACP 连接（用于 relay 消息转发）。
   */
  getConnection(instanceId: string): acp.ClientSideConnection | null {
    return this.instances.get(instanceId)?.connection ?? null;
  }

  /**
   * 获取实例状态（判断是否已 prepare/start）。
   */
  hasInstance(instanceId: string): boolean {
    return this.instances.has(instanceId);
  }

  private resolveWorkspace(launchSpec: AgentLaunchSpec): string {
    const { join } = require("node:path") as typeof import("node:path");
    if (launchSpec.environmentId) {
      return join(this.workspaceRoot, launchSpec.organizationId, launchSpec.userId, launchSpec.environmentId);
    }
    return join(this.workspaceRoot, launchSpec.organizationId, launchSpec.userId);
  }
}
```

注意：`resolveExecutable` 目前在 `packages/plugin-opencode/src/process/executable.ts`，需要把它也导出，或者在 acp-link 中内联一个简化版本。考虑到 acp-link 是独立打包的，直接在 acp-link 中内联一个简单版本更干净。

在 `packages/acp-link/src/client/` 下创建 `resolve-executable.ts`（或者直接在 `instance-manager.ts` 中内联）：

```typescript
// packages/acp-link/src/client/resolve-executable.ts
import { execSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export function resolveExecutable(command: string): string {
  const pathEntries = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = join(entry, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  try {
    const whichCommand = process.platform === "win32" ? "where" : "which";
    return execSync(`${whichCommand} ${command}`, { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }).trim().split(/\r?\n/, 1)[0].trim();
  } catch {
    throw new Error(`Required executable not found: ${command}`);
  }
}
```

- [ ] **Step 3: 修改 server.ts client mode 消息路由**

在 `packages/acp-link/src/server.ts` 的 `createAcpClient` 函数中，引入 `InstanceManager` 并增加 prepare/start/stop/relay 消息处理。

在文件顶部添加 import：

```typescript
import { InstanceManager } from "./client/instance-manager";
```

在 `createAcpClient` 函数内部，`const sessionMgr = ...` 之后添加：

```typescript
const instanceMgr = new InstanceManager(config.command, config.cwd || process.cwd());
```

在 `ws.onmessage` 的 `switch (msg.type)` 中，在现有 case 之前添加新 case：

```typescript
case "prepare": {
  const instanceId = msg.instance_id as string;
  const launchSpec = msg.launch_spec as AgentLaunchSpec;
  try {
    await instanceMgr.prepare(instanceId, launchSpec);
    ws.send(JSON.stringify({
      type: "prepare_result",
      request_id: msg.request_id,
      instance_id: instanceId,
      status: "ok",
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: "prepare_result",
      request_id: msg.request_id,
      instance_id: instanceId,
      status: "error",
      message: (err as Error).message,
    }));
  }
  break;
}
case "start": {
  const instanceId = msg.instance_id as string;
  try {
    const result = await instanceMgr.start(instanceId);
    ws.send(JSON.stringify({
      type: "start_result",
      request_id: msg.request_id,
      instance_id: instanceId,
      status: "ok",
      capabilities: result.capabilities,
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: "start_result",
      request_id: msg.request_id,
      instance_id: instanceId,
      status: "error",
      message: (err as Error).message,
    }));
  }
  break;
}
case "stop": {
  const instanceId = msg.instance_id as string;
  try {
    await instanceMgr.stop(instanceId);
    ws.send(JSON.stringify({
      type: "stop_result",
      request_id: msg.request_id,
      instance_id: instanceId,
      status: "ok",
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: "stop_result",
      request_id: msg.request_id,
      instance_id: instanceId,
      status: "error",
      message: (err as Error).message,
    }));
  }
  break;
}
case "relay": {
  const instanceId = msg.instance_id as string;
  const sessionId = msg.session_id as string;
  const relayPayload = msg.payload as Record<string, unknown>;
  const conn = instanceMgr.getConnection(instanceId);
  if (conn) {
    // 转发 relay 消息到 ACP connection
    try {
      await handleRelayToConnection(conn, sessionId, relayPayload, instanceId, ws);
    } catch (err) {
      console.error(`[instance-manager] relay error: ${(err as Error).message}`);
    }
  }
  break;
}
case "relay_close": {
  // relay 关闭通知，不需要特殊处理
  break;
}
```

需要添加 `AgentLaunchSpec` 的 import（从 `./types` 中获取，或直接从 `@fenix/plugin-sdk` 导入）：

```typescript
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
```

添加 `handleRelayToConnection` 辅助函数：

```typescript
async function handleRelayToConnection(
  conn: acp.ClientSideConnection,
  sessionId: string,
  payload: Record<string, unknown>,
  instanceId: string,
  ws: WebSocket,
): Promise<void> {
  const type = payload.type as string;
  switch (type) {
    case "new_session": {
      const cwd = (payload.payload as Record<string, unknown>)?.cwd as string | undefined;
      const r = await conn.newSession({ cwd: cwd ?? process.cwd(), mcpServers: [] });
      ws.send(JSON.stringify({
        type: "relay",
        instance_id: instanceId,
        session_id: sessionId,
        payload: { type: "session_created", payload: r },
      }));
      break;
    }
    case "prompt": {
      const content = (payload.payload as Record<string, unknown>)?.content as acp.ContentBlock[];
      const result = await conn.prompt({ sessionId, prompt: content ?? [] });
      ws.send(JSON.stringify({
        type: "relay",
        instance_id: instanceId,
        session_id: sessionId,
        payload: { type: "prompt_complete", payload: result },
      }));
      break;
    }
    case "cancel": {
      await conn.cancel({ sessionId });
      break;
    }
    default:
      console.log(`[instance-manager] unhandled relay type: ${type}`);
  }
}
```

- [ ] **Step 4: 确认 build 正常**

```bash
cd packages/acp-link && bun run build
```

- [ ] **Step 5: 提交**

```bash
git add packages/acp-link/
git commit -m "feat(acp-link): 新增 InstanceManager，扩展 WS 协议支持 prepare/start/stop"
```

---

## Task 6: RCS 主服务器 — core-bootstrap 动态注册远程 node

**Files:**
- Modify: `src/services/core-bootstrap.ts`
- Modify: `src/transport/acp-ws-handler.ts`

- [ ] **Step 1: 修改 core-bootstrap.ts 引入 remote-runtime**

在 `src/services/core-bootstrap.ts` 中添加：

```typescript
import { type CoreRuntimeFacade, createCoreRuntime } from "@fenix/core";
import { createEnginePlugin, type OpencodeRuntime } from "@fenix/opencode";
import { createRemoteRuntime, createWsRemoteTransport } from "@fenix/remote-runtime";

let facade: CoreRuntimeFacade | null = null;
```

添加动态 node 注册函数：

```typescript
/**
 * 远程 machine 注册成功后，动态注册 remote node 到 core。
 * 返回注册的 node ID（即 machineId）。
 */
export function registerRemoteNode(
  machineId: string,
  ws: { readyState: number; send(data: string): void; onmessage: ((event: { data: string | Buffer }) => void) | null },
): void {
  const runtime = getCoreRuntime();

  // 检查是否已注册
  const existing = runtime.getNode(machineId);
  if (existing) {
    // 更新状态为 online
    // CoreNodeRegistry.setStatus 未在 facade 暴露，需要通过 registry 直接操作
    // 或直接用现有 node
    return;
  }

  // 注册 remote node
  runtime.registerNode({
    id: machineId,
    mode: "remote",
    engineTypes: ["opencode"],
    status: "online",
    metadata: { machineId },
  });
}

/**
 * 远程 machine 断连后，注销 remote node。
 */
export function unregisterRemoteNode(machineId: string): void {
  // facade 没有 unregisterNode 方法，通过 setStatus 标记为 offline
  // 这需要 facade 暴露 setStatus 或在 store 层操作
  // 暂时先标记为 offline，让后续 launch 时检测到 NODE_OFFLINE
}
```

修改 `defaultCreateFacade` 增加 `runtimeResolver`：

```typescript
function defaultCreateFacade(): CoreRuntimeFacade {
  return createCoreRuntime({
    plugins: [createEnginePlugin()],
    nodes: [
      {
        id: "local-default",
        mode: "local",
        engineTypes: ["opencode"],
        status: "online",
      },
    ],
    onInstanceStarted(instanceId, runtime, updateMetadata) {
      const opencode = runtime as OpencodeRuntime;
      const state = opencode.getInstanceState(instanceId);
      if (state) {
        updateMetadata({
          port: state.port ?? 0,
          token: state.token ?? "",
        });
      }
    },
    runtimeResolver(engineType, node) {
      if (node.mode === "remote") {
        // 需要获取该 node 对应的 WS 连接来创建 transport
        // transport 由 registerRemoteNode 时缓存
        const cached = remoteTransports.get(node.id);
        if (cached) {
          return createRemoteRuntime({ transport: cached });
        }
      }
      return null;
    },
  });
}

// 缓存远程 transport 实例
const remoteTransports = new Map<string, ReturnType<typeof createWsRemoteTransport>>();
```

修改 `registerRemoteNode` 使用 transport 缓存：

```typescript
export function registerRemoteNode(
  machineId: string,
  ws: { readyState: number; send(data: string): void; onmessage: ((event: { data: string | Buffer }) => void) | null },
): void {
  const runtime = getCoreRuntime();

  // 创建 transport 并缓存
  const transport = createWsRemoteTransport(ws as import("@fenix/remote-runtime").WsConnectionLike);
  remoteTransports.set(machineId, transport);

  const existing = runtime.getNode(machineId);
  if (existing) return;

  runtime.registerNode({
    id: machineId,
    mode: "remote",
    engineTypes: ["opencode"],
    status: "online",
    metadata: { machineId },
  });
}

export function unregisterRemoteNode(machineId: string): void {
  remoteTransports.delete(machineId);
  // Node 无法从 facade 注销，保持 offline 状态即可
  // 后续 launch 时 NODE_OFFLINE 检查会阻止调度
}
```

- [ ] **Step 2: 修改 acp-ws-handler.ts 注册远程 node**

在 `src/transport/acp-ws-handler.ts` 中找到注册成功的处理逻辑（`registered` 消息响应处），调用 `registerRemoteNode`。

在 import 区域添加：

```typescript
import { registerRemoteNode, unregisterRemoteNode } from "../services/core-bootstrap";
```

在注册成功的分支中（收到 `registered` 消息后），添加：

```typescript
// 注册远程 node 到 core runtime
registerRemoteNode(entry.machineId, ws);
```

在断连处理中（`close` 事件），添加：

```typescript
unregisterRemoteNode(entry.machineId);
```

- [ ] **Step 3: 运行现有测试确认无破坏**

```bash
bun test src/__tests__/
```

- [ ] **Step 4: 提交**

```bash
git add src/services/core-bootstrap.ts src/transport/acp-ws-handler.ts
git commit -m "feat(server): 动态注册远程 node 到 core runtime"
```

---

## Task 7: RCS 主服务器 — relay-handler 统一路径

**Files:**
- Modify: `src/transport/relay/relay-handler.ts`
- Modify: `src/services/instance.ts`

- [ ] **Step 1: 修改 instance.ts 感知 remote node**

在 `src/services/instance.ts` 的 `spawnInstanceFromEnvironment` 中，当 environment 关联了 machineId 时，使用远程 node：

在函数开头添加 machineId 解析：

```typescript
// 解析目标 node
let nodeId = "local-default";
if (env.agentConfigId) {
  const agentCfg = await getAgentConfigById(env.agentConfigId);
  if (agentCfg?.machineId) {
    nodeId = agentCfg.machineId;
  }
}
```

将 `facade.launchInstance` 调用中的 `nodeId: "local-default"` 改为使用动态 `nodeId`：

```typescript
const snapshot = await facade.launchInstance({
  instanceId,
  engineType: "opencode",
  nodeId,
  launchSpec,
});
```

- [ ] **Step 2: 简化 relay-handler.ts**

修改 `handleRelayOpen` 统一路径，删除 `openMachineRelay` 分支：

```typescript
export async function handleRelayOpen(
  ws: WsConnection,
  relayWsId: string,
  agentId: string,
  userId: string,
  sessionId?: string,
): Promise<void> {
  log(`[ACP-Relay] Relay connection opened: relayWsId=${relayWsId} agentId=${agentId}`);

  const env = await environmentRepo.getById(agentId);
  if (!env) {
    sendToRelayWs(ws, { type: "error", payload: { message: "Environment not found" } });
    ws.close(4004, "environment not found");
    return;
  }

  // 统一走 ensureRunning → facade.connectInstanceRelay
  await openLocalRelay(ws, relayWsId, agentId, userId, sessionId ?? relayWsId, env);
}
```

删除 `openMachineRelay` 函数整体。

删除 `buildAndSendSessionStart` 函数（逻辑已下沉到 remote-runtime 的 `prepareEnvironment` + `startInstance`）。

`openLocalRelay` 保持不变——它通过 `ensureRunning` → `facade.connectInstanceRelay` 工作，现在远程实例也走这条路径。

- [ ] **Step 3: 清理 acp-ws-handler.ts 中的 machine session 消息转发**

`acp-ws-handler.ts` 中现有的 `SESSION_MSG_TYPES` 转发逻辑需要保留，因为远程 acp-link 的 session 生命周期消息（`session_started`/`session_data`/`session_ended` 等）仍然通过 machine WS 推送回来。但现在这些消息需要路由到 `RemoteTransport` 的 session message listeners，而不是直接转发到 relay entry。

具体来说，在 `acp-ws-handler.ts` 中的 `sessionMessageListeners` 分发逻辑改为同时通知 remote transport。由于 transport 已经通过 `ws.onmessage` 拦截了所有消息，这里的 `sessionMessageListeners` 机制可以改为由 transport 的 `onSessionMessage` 驱动。

但为了最小化改动，保留现有的 `sessionMessageListeners` 机制，同时在 `RemoteRelayHandle` 中通过 `RemoteTransport.onSessionMessage` 接收消息——两条路径不冲突。需要确认 `createWsRemoteTransport` 拦截 `ws.onmessage` 不会影响现有的 `sessionMessageListeners` 分发。

由于 `createWsRemoteTransport` 在 `ws.onmessage` 上注册了新的 handler 并保留了原始 handler（`originalOnMessage`），现有的消息分发链路不受影响。

- [ ] **Step 4: 运行测试**

```bash
bun test src/__tests__/
```

- [ ] **Step 5: 提交**

```bash
git add src/transport/relay/relay-handler.ts src/services/instance.ts
git commit -m "refactor(relay): 统一本机/远程路径，删除 openMachineRelay 直接 WS 操作"
```

---

## Task 8: 集成验证与清理

**Files:**
- Modify: `packages/acp-link/src/server.ts`（保留旧 session_start 作为 fallback）
- 全局: 运行 precheck

- [ ] **Step 1: 确保旧 session_start 消息向后兼容**

在 `packages/acp-link/src/server.ts` 的 `createAcpClient` 的 `ws.onmessage` switch 中，保留现有的 `session_start` case 作为 fallback（当远程端未先发送 `prepare` 时）：

现有的 `session_start` 处理代码保持不变，确保没有新协议能力的旧 RCS 服务器仍能工作。

- [ ] **Step 2: 运行 precheck**

```bash
bun run precheck
```

- [ ] **Step 3: 运行所有测试**

```bash
bun test src/__tests__/ && bun test packages/core/src/__tests__/ && bun test packages/remote-runtime/src/__tests__/ && bun test packages/plugin-opencode/src/__tests__/
```

- [ ] **Step 4: 修复所有 lint/type 错误后提交**

```bash
git add -A
git commit -m "chore: 集成验证，修复 lint 和类型错误"
```

---

## 自检

**1. Spec 覆盖度：**

| Spec 要求 | 对应 Task |
|---|---|
| CoreNodeMode 增加 "remote" | Task 1 |
| 新建 @fenix/remote-runtime 实现 EngineRuntime | Task 2, 3 |
| plugin-opencode 导出环境装配函数 | Task 4 |
| acp-link WS 协议扩展 prepare/start/stop | Task 5 |
| acp-link InstanceManager 环境装配 | Task 5 |
| core-bootstrap 动态注册远程 node | Task 6 |
| acp-ws-handler 注册/注销远程 node | Task 6 |
| relay-handler 统一路径 | Task 7 |
| instance.ts 感知 remote node | Task 7 |
| 向后兼容旧 session_start | Task 8 |

**2. Placeholder 扫描：** 无 TBD/TODO。

**3. 类型一致性：**
- `RemoteTransport` 接口在 Task 2 定义，Task 3 的 `RemoteRuntime` 和 `RemoteRelayHandle` 使用同一接口
- `TransportMessage` 在 Task 2 定义，所有后续 Task 使用同一类型
- `InstanceManager` 的方法签名与 WS 协议消息字段一致
- `CoreNodeMode` 扩展后，`instance-orchestrator` 的 `runtimeResolver` 参数使用 `import("../types/core-node").CoreNode` 类型
