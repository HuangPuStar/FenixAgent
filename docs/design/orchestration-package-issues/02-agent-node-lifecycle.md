# I2: AgentNode 生命周期 — 状态机 + 连接管理 + 生命周期回收

## What to build

实现 AgentNode 子域的完整生命周期：状态机、AgentNode 对象（持有 WS 信道）、AgentNodeService（引用计数 + 空闲超时回收）。

AgentNode 是"远端 Machine 在本侧的连接生命周期管理类"——被动接收 Machine 连接，管理 WS 信道，提供 send/close，并为上层的 Instance 工厂提供 spawn 能力。

## 具体产出

### 1. `agent-node/types.ts`

- `AgentNodeStatus` 枚举（已在 I1 的 domain.ts 定义，此处可 re-export 或引用）
- `AgentNodeOptions`（machineId、WS socket、超时配置等）
- `AgentNodeServiceConfig`（idleTimeoutMs、maxRetries 等）

### 2. `agent-node/agent-node-fsm.ts` — 状态机

6 种转换：

| 当前状态 | 事件/动作 | 目标状态 | 说明 |
|---------|----------|---------|------|
| uninitialized | `connect()` | connecting | 发起 WS 连接 |
| connecting | WS open | connected | 连接成功 |
| connecting | WS error / timeout | uninitialized | 连接失败，返回初始态 |
| connected | WS close/error | disconnected | 意外断连 |
| disconnected | 自动重连 | connecting | 重试策略 |
| disconnected / connected | `close()` | closing | 主动关闭 |
| closing | WS close 确认 | closed | 关闭完成 |

非法转换应抛错（如从 `connected` 直接 `connect()`）。

### 3. `agent-node/agent-node.ts` — AgentNode 类

```ts
// 核心能力
class AgentNode {
  readonly machineId: string;
  status(): AgentNodeStatus;     // 懒查询当前状态
  send(data: unknown): void;     // 通过 WS 发送（connected 时才合法）
  close(): void;                 // 主动关闭（→ closing → closed）
  
  // 不暴露给外部，由 AgentNodeService 调用
  _handleConnected(): void;      // WS open 回调
  _handleDisconnected(): void;   // WS close 回调
  _spawnInstance(launchSpec): Instance;  // 工厂方法（I3 后用）
}
```

**关键规则**：disconnected 期间 AgentNode 对象不销毁，自动重连。

### 4. `agent-node/agent-node-service.ts` — 生命周期管理

```ts
class AgentNodeService {
  constructor(config: AgentNodeServiceConfig);
  
  /** 被动连接：Machine → AgentNodeService，到达时生成 AgentNode */
  handleIncomingConnection(machineId: string, socket: WebSocket): AgentNode;
  
  /** 获取或等待 AgentNode（无连接时返回 null 或抛 AgentNodeUnavailableError） */
  ensureNode(machineId: string): AgentNode | null;
  
  /** Instance 归还引用 */
  releaseNode(machineId: string): void;
  
  /** 当前管理的 AgentNode 数 */
  activeCount(): number;
}
```

**回收策略**：
- 引用计数：每个 `ensureNode` +1，每个 `releaseNode` -1
- 空闲超时：引用计数归零后启动定时器，超时后 `agentNode.close()`
- 新 `ensureNode` 到达时取消回收定时器

### 5. 测试

文件：`agent-node/agent-node-service.test.ts`

覆盖：
- 正常创建：Machine 连接 → 生成 AgentNode → connected
- 状态转换：connected → disconnected → connecting（自动重连）
- 主动关闭：connected → close() → closing → closed
- 引用计数：ensure ×3 → release ×3 → 空闲超时 → destroyed
- 重连期间：disconnected 状态下的 send() 抛错
- 非法转换：connected 状态调用 connect() 抛错
- 并发连接：同一 machineId 第二个 connection 复用已有 AgentNode

## Acceptance criteria

- [ ] AgentNode FSM 所有合法转换通过测试
- [ ] 非法状态转换正确抛错
- [ ] AgentNodeService 引用计数逻辑正确（无泄漏）
- [ ] 空闲超时回收正确触发和取消
- [ ] `bun test packages/orchestration/agent-node/` 全绿
- [ ] 所有 mock 注入，不依赖真实 WS/DB

## Blocked by

[I1: 编排域包基础](01-package-foundation.md)
