# ACPClient 拆分设计

> 候选 5 的详细设计文档，基于 grilling 讨论结果。

## 架构总览

```
React Hooks (非 owning, 传入 client, 订阅状态)
  └── ACPClient (编排层, thin ~100 行)
       ├── WSTransport     (纯传输, 自动重连)
       ├── ACPProtocol     (解析字节 → 派发类型化事件, 无状态)
       ├── ACPState        (订阅协议事件, 维护状态, EventEmitter 通知)
       └── ACPPending      (request/response 关联 + 超时, 重连后续传)
```

## 文件结构

```
web/src/acp/
  client.ts          → ACPClient (thin orchestration)
  types.ts           → (不变, 协议类型定义)
  transport.ts       → WSTransport
  protocol.ts        → ACPProtocol
  state.ts           → ACPState
  pending.ts         → ACPPending
  emitter.ts         → 通用 EventEmitter 工具
  relay-client.ts    → (不变, 工厂函数)

web/src/hooks/
  useACPConnection.ts  → 订阅连接状态
  useACPSession.ts     → 订阅 session 状态 + actions
  useModels.ts         → (重构, 使用 EventEmitter)
  useCommands.ts       → (重构, 使用 EventEmitter)
```

## 各模块设计

### 1. EventEmitter (`emitter.ts`)

通用类型安全 EventEmitter，所有模块共用。

```typescript
type Handler<T = void> = T extends void ? () => void : (payload: T) => void;

class EventEmitter<Events extends Record<string, any>> {
  private handlers = new Map<string, Set<Handler>>();

  on<Event extends keyof Events>(event: Event, handler: Handler<Events[Event]>): void;
  off<Event extends keyof Events>(event: Event, handler: Handler<Events[Event]>): void;
  emit<Event extends keyof Events>(event: Event, payload: Events[Event]): void;
  removeAllListeners(event?: string): void;
}
```

### 2. WSTransport (`transport.ts`)

纯 WebSocket 传输层，不知道 ACP 协议。

**职责：**
- 连接/断开 WebSocket
- 自动重连（指数退避，最多 3 次）
- 收发原始字符串（不解析 JSON）
- 传播连接状态和关闭原因

**接口：**

```typescript
interface TransportEvents {
  state: { state: "connecting" | "connected" | "disconnected" | "error"; detail?: CloseEvent };
  message: string;  // 原始消息字符串
  reconnecting: { attempt: number; maxAttempts: number };
  reconnectFailed: void;
}

class WSTransport extends EventEmitter<TransportEvents> {
  connect(url: string): void;
  disconnect(): void;
  send(data: string): void;
  get state(): "connecting" | "connected" | "disconnected" | "error";
}
```

**重连策略：**
- 断开后指数退避：1s → 2s → 4s
- 最多 3 次重试
- 达到上限后 emit `reconnectFailed`，保持 error 状态
- 正常关闭（code 1000）不触发重连
- 重连期间 emit `reconnecting` 通知上层

### 3. ACPProtocol (`protocol.ts`)

无状态的 ACP 协议解析层。

**职责：**
- 接收原始字符串 → JSON.parse → 类型化为 ProxyResponse
- 过滤非业务消息（keep_alive）
- 派发类型化事件给上层

**接口：**

```typescript
interface ProtocolEvents {
  // 直接对应 ProxyResponse 的各 type
  status: ProxyStatusMessage["payload"];
  error: ProxyErrorMessage["payload"];
  session_created: ProxySessionCreatedMessage["payload"];
  session_list: ProxySessionListMessage["payload"];
  session_loaded: ProxySessionLoadedMessage["payload"];
  session_resumed: ProxySessionResumedMessage["payload"];
  session_update: { sessionId: string; update: SessionUpdate };
  prompt_complete: ProxyPromptCompleteMessage["payload"];
  permission_request: PermissionRequestPayload;
  browser_tool_call: { callId: string; params: BrowserToolParams };
  model_changed: { modelId: string };
  pong: void;
}

class ACPProtocol extends EventEmitter<ProtocolEvents> {
  /** 喂入原始消息字符串，解析后派发对应事件 */
  handleMessage(raw: string): void;
}
```

### 4. ACPState (`state.ts`)

订阅协议事件，维护 ACP 会话状态，通过 EventEmitter 通知变更。

**职责：**
- 维护 session/capabilities/model/commands 等状态
- 订阅 ACPProtocol 事件，更新内部状态
- 提供 getter 读取当前状态
- 通过 EventEmitter 通知状态变更

**接口：**

```typescript
interface StateEvents {
  connectionStateChange: { state: ConnectionState; error?: string };
  sessionIdChange: string | null;
  capabilitiesChange: AgentCapabilities | null;
  promptCapabilitiesChange: PromptCapabilities | null;
  modelStateChange: SessionModelState | null;
  availableCommandsChange: AvailableCommand[];
}

class ACPState extends EventEmitter<StateEvents> {
  // Getters
  get connectionState(): ConnectionState;
  get sessionId(): string | null;
  get agentCapabilities(): AgentCapabilities | null;
  get promptCapabilities(): PromptCapabilities | null;
  get modelState(): SessionModelState | null;
  get availableCommands(): AvailableCommand[];

  // Derived getters
  get supportsImages(): boolean;
  get supportsModelSelection(): boolean;
  get supportsLoadSession(): boolean;
  get supportsResumeSession(): boolean;
  get supportsSessionList(): boolean;
  get supportsSessionHistory(): boolean;

  /** 连接到 transport + protocol，开始同步状态 */
  bind(transport: WSTransport, protocol: ACPProtocol): void;

  /** 断开所有订阅，重置状态 */
  reset(): void;
}
```

**状态更新规则：**
- `status` (connected) → 更新 capabilities，connectionState = "connected"
- `session_created` → 更新 sessionId + promptCapabilities + modelState
- `session_loaded` / `session_resumed` → 更新 sessionId + promptCapabilities + modelState
- `session_update` (available_commands_update) → 更新 availableCommands
- `model_changed` → 更新 modelState.currentModelId
- disconnect → 清空所有状态为 null/[]
- transport error → connectionState = "error"

### 5. ACPPending (`pending.ts`)

request/response 关联机制，支持重连后续传。

**职责：**
- 发送请求时注册 pending promise
- 收到匹配响应时 resolve
- 超时自动 reject
- WS 重连后恢复 pending 请求（重新发送）
- WS 永久断开时 reject 所有 pending

**接口：**

```typescript
class ACPPending {
  /**
   * 注册 pending 请求。
   * 同一 requestType 同时只能有一个 pending（隐式关联）。
   */
  sendAndWait<TRequest, TResponse>(
    sendFn: (request: TRequest) => void,
    requestType: string,
    request: TRequest,
    responseType: string,
    timeout: number,
  ): Promise<TResponse>;

  /**
   * 尝试用响应匹配 pending 请求。
   * 返回 true 表示匹配成功（已 resolve）。
   */
  tryResolve(responseType: string, payload: any): boolean;

  /** 重连后重新发送所有未完成的 pending 请求 */
  resendAll(): void;

  /** 拒绝所有 pending（用于永久断开） */
  rejectAll(error: Error): void;
}
```

### 6. ACPClient (`client.ts`)

薄编排层，组装四个子模块，暴露统一 API。

**职责：**
- 构造时创建 transport / protocol / state / pending
- 连接 transport → protocol → state 的数据流
- 暴露面向调用者的 public API
- 实现 ACP 业务方法（createSession、sendPrompt 等）

**接口：**

```typescript
class ACPClient {
  constructor(settings: ACPSettings);

  // 生命周期
  connect(): Promise<void>;
  disconnect(): void;
  updateSettings(settings: ACPSettings): void;

  // 状态访问（代理到 state）
  readonly state: ACPState;

  // ACP 操作
  createSession(cwd?: string, permissionMode?: string): void;
  sendPrompt(content: string | ContentBlock[]): void;
  cancel(): void;
  setSessionModel(modelId: string): void;
  respondToPermission(requestId: string, optionId: string | null): void;
  listSessions(request?: ListSessionsRequest): Promise<ListSessionsResponse>;
  loadSession(request: LoadSessionRequest): Promise<string>;
  resumeSession(request: ResumeSessionRequest): Promise<string>;

  // 事件回调（代理到 state 的 EventEmitter，兼容现有调用者）
  onConnectionStateChange(handler: (state: ConnectionState, error?: string) => void): () => void;
  onSessionUpdate(handler: SessionUpdateHandler): () => void;
  onSessionCreated(handler: SessionCreatedHandler): () => void;
  onPromptComplete(handler: PromptCompleteHandler): () => void;
  onPermissionRequest(handler: PermissionRequestHandler): () => void;
  onBrowserToolCall(handler: BrowserToolCallHandler): () => void;
  onErrorMessage(handler: ErrorMessageHandler): () => void;
  onAuthFailure(handler: () => void): () => void;
}
```

**内部编排逻辑（connect）：**
1. `transport.connect(url)` → 等待 "connected" 事件
2. connected 后发 `{ type: "connect" }` 握手（这是 ACP 协议要求，不属于 transport）
3. transport.on("message") → protocol.handleMessage(raw)
4. protocol 事件 → state 自动更新（state.bind 已完成）
5. pending.tryResolve 在收到 protocol 事件时调用
6. transport.on("reconnecting") → 不动 pending（重连后 resendAll）
7. transport.on("reconnectFailed") → pending.rejectAll

### 7. React Hooks

**useACPConnection(client)**:
```typescript
function useACPConnection(client: ACPClient): {
  connectionState: ConnectionState;
  error: string | null;
};
```
- 订阅 `state.on("connectionStateChange")`
- 返回连接状态和错误信息

**useACPSession(client)**:
```typescript
function useACPSession(client: ACPClient): {
  sessionId: string | null;
  capabilities: AgentCapabilities | null;
  supportsImages: boolean;
  supportsSessionHistory: boolean;
};
```
- 订阅 sessionId / capabilities 变更

**useModels(client)** — 重构现有，使用 `state.on("modelStateChange")` 替代 `setModelStateChangedHandler`。

**useCommands(client)** — 重构现有，使用 `state.on("availableCommandsChange")` 替代 `setAvailableCommandsChangedHandler`。

## 调用者迁移

现有调用者（ACPConnect、ACPDirectView、ACPMain、ChatInterface 等）的迁移策略：

1. **ACPClient 构造和 connect/disconnect 不变** — public API 兼容
2. **Handler 注册改为 `client.onXxx(handler)` 返回 unsubscribe 函数** — 替代 `setXxxHandler`，更符合 useEffect cleanup 模式
3. **State getter 不变** — `client.state.modelState` 替代 `client.modelState`
4. **新增 hook 可逐步采用** — 现有直接使用 handler 的代码不需要立即迁移

## 测试策略

| 模块 | 测试方式 |
|------|---------|
| WSTransport | Mock WebSocket（构造假的 ws 对象），测试连接/断开/重连/退避 |
| ACPProtocol | 纯函数测试：喂入 JSON 字符串，验证 emit 的事件 |
| ACPState | Mock protocol EventEmitter，验证状态更新和通知 |
| ACPPending | 测试 resolve/reject/timeout/resendAll |
| ACPClient | Integration：mock transport，测试完整编排流程 |
| Hooks | React Testing Library：mock ACPClient，验证 re-render |
