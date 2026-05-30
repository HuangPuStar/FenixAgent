# Feature: 20260525_F001 - registry-center

## 需求背景

当前 RCS 与 acp-link 的连接模型是：acp-link 在 agent 机器上启动 WebSocket 服务端，RCS 作为客户端去连接 acp-link。这种"反向连接"模型存在两个问题：

1. **部署复杂**：RCS 需要知道每台 agent 机器的地址才能连过去，跨网络环境（NAT、防火墙）尤其麻烦
2. **缺少中心化管控**：没有统一的环境注册视角，无法查看当前有多少台机器注册、状态如何、带有什么标签

本需求将连接模型反转为：**acp-link 启动时主动向 RCS 注册**，RCS 作为注册中心统一管理所有 acp 机器（machine）。

### 第一期回顾（已完成）

第一期实现了 machine 注册、心跳、REST API 查询、前端 Agent 绑定 machine 等功能。但 relay 层存在关键缺口：`handleRelayOpen` 只能找到**本地 spawned Instance** 或通过 `agentId` 匹配的 ACP WS 连接，machine 连接的 `agentId` 为 null，导致远端 machine 上的 agent 无法被 relay 路由过去——注册中心能看到机器但无法实际执行 session。

### 第二期目标

**打通远端执行链路**：改造 relay 层，使 session 能够通过 machine WS 路由到远端 acp-link，由 acp-link 在远端按需 spawn agent 子进程并桥接 stdio。**同时统一模型**：废弃"ACP agent 直连"和"本地 Instance spawn"两条旧路径，所有 agent 执行都走 machine relay，消除多路径维护负担。

### 概念澄清

```
acp-link 注册 → machine（机器）= 一台可运行 agent 的机器
Agent 配置   → Agent（智能体）= 运行在某个 machine 上的 AI 助手，有自己的 prompt/model/skills
Session      → 用户与 Agent 的一次对话，会话数据通过 machine WS 在 RCS 和 acp-link 之间透传
```

- **machine** 是基础设施层概念，代表一台机器（hostname、IP、OS、标签），acp-link 注册后 RCS 通过该连接与机器通信
- **Agent** 是业务层概念，代表一个 AI 助手配置，**必须**绑定一个 machine（`machineId` 外键），运行时 RCS 通过该绑定的 machine 将请求下发给 acp-link 执行
- **Session** 是会话层概念，machine WS 上通过 `session_id` 多路复用区分不同会话
- **Instance** 概念废弃，原有的"本地 agent 进程管理"职责由远端 acp-link 承担

## 目标

- **统一 relay 路径**：所有 agent session 通过 machine WS 路由，移除本地 Instance 路径和 ACP agent 直连路径
- **远端按需 spawn**：acp-link 收到 `session_start` 时 spawn agent 子进程，session 结束时终止
- **session 多路复用**：machine WS 上通过 `session_id` 字段区分不同 session
- **自动重连恢复**：acp-link 断连后自动重连，已运行的子进程继续运行，重连后恢复 session 通信
- **接口向后兼容**：`sendToAgentWs`、`findRunningInstanceByEnvironment`、`spawnInstanceFromEnvironment` 等函数签名不变，内部改为 machine WS 通信，确保 hermes-client、workflow 等调用方无需修改
- **彻底清理死代码**：删除 `src/services/instance.ts`、`src/routes/web/instances.ts`、`src/schemas/instance.schema.ts` 及相关测试文件

## 方案设计

### 整体架构变更

**改造前**（三条 relay 路径）：

```
handleRelayOpen
  ├── 1. findRunningInstanceByEnvironment → openInstanceRelay    (本地 Instance)
  ├── 2. findAcpConnectionByAgentId      → openEventBusRelay    (ACP agent 直连)
  └── 3. "Agent not found"                                      (失败)
```

**改造后**（统一为一条路径）：

```
handleRelayOpen
  └── Environment → AgentConfig.machineId → findMachineConnectionById(machineId)
      → openMachineRelay(ws, relayWsId, machineConn)
```

数据流：

```
前端 ↔ /acp/relay/:agentId ↔ relay-handler ↔ machine WS ↔ acp-link ↔ stdio ↔ agent 子进程
```

`/acp/ws` 端点不再接受 ACP agent 认证（API key / environment secret），只接受 machine 注册（`REGISTRY_SECRET`）。所有连接到 `/acp/ws` 的都是 machine 连接。

### NDJSON 协议扩展

machine WS 上新增 6 种 session 消息类型，所有 ACP 协议数据通过 `session_data.payload` 透传：

```
RCS → acp-link:
  session_start   { session_id, agent_cmd? }     // 请求 spawn agent 子进程
  session_data    { session_id, payload }         // 转发消息到子进程 stdin
  session_end     { session_id }                  // 请求终止子进程

acp-link → RCS:
  session_started  { session_id }                 // 子进程已启动
  session_data     { session_id, payload }        // 子进程 stdout 输出
  session_ended    { session_id, reason }         // 子进程已退出
  session_error    { session_id, error }          // 异常报告
  session_queued   { session_id }                 // 排队等待中（max_sessions 超限）
  session_resumed  { session_id }                 // 重连后恢复已有 session
```

**设计决策**：
- `session_start` 不携带模型配置、skills 等业务参数——这些由前端通过 ACP `init` 消息在 `session_data.payload` 中传递，acp-link 只负责透明转发到子进程 stdin
- acp-link spawn 命令固定为 `<agent_name> acp`（如 `opencode acp`），agent_name 来自注册时的声明
- `session_id` 由 RCS 生成（复用 relay 连接时的 `relayWsId`），作为 machine WS 上的多路复用路由 key，与 opencode 内部的 ACP session ID（`ses_xxx`）无关
- acp-link 收到未知 `session_id` 的 `session_data` 时，自动视为隐式 `session_start`（lazy spawn），兼容无需显式启动的调用方

### RCS 侧 relay 层改造

#### relay-handler.ts

**新增函数**：

- `openMachineRelay(ws, relayWsId, agentId, userId, sessionId, machineConn)`：machine relay 主入口
  1. 发送 `session_start` 到 machine WS，携带 `session_id`（= relayWsId）
  2. 等待 `session_started` / `session_queued` 确认（超时 10s）
  3. 注册 relay entry 到 `RelayConnectionManager`
  4. 设置 `machineConn.entry.onSessionMessage` 回调：
     - `session_started` → 开始转发缓冲消息
     - `session_data` → 解包 payload，`sendToRelayWs(ws, payload)` 转发到前端
     - `session_ended` / `session_error` → 关闭前端 relay WS
  5. 前端 relay WS 消息 → 包裹 `{type: "session_data", session_id, payload}` → 发送到 machine WS
  6. 前端 relay WS 断连 → 发送 `session_end` 到 machine WS

- `handleRelayOpen` 简化为：
  1. 查 Environment → AgentConfig → machineId
  2. `findMachineConnectionById(machineId)` 找 machine WS 连接
  3. 找到 → `openMachineRelay(...)`
  4. 找不到 → 返回 `"Agent not found or offline"`，关闭 relay WS

**删除函数**：`openInstanceRelay()`、`openEventBusRelay()`、`closeInstanceRelay()`、`sendToInstanceRelay()`

**删除 import**：`findInstanceBySessionId`、`findRunningInstanceByEnvironment`、`findAcpConnectionByAgentId`、`sendToAgentWs`、`getCoreRuntime`

#### acp-ws-handler.ts

**AcpConnectionEntry 新增字段**：

```typescript
interface AcpConnectionEntry {
  // ... 现有字段
  wsId: string;  // 连接自身的 ID
  onSessionMessage?: (sessionId: string, type: string, payload: unknown) => void;
}
```

**新增函数**：

- `findMachineConnectionById(machineId: string): AcpConnectionEntry | null`：通过 machineId 找 machine WS 连接
- `findMachineConnectionByAgentId(agentId: string): Promise<AcpConnectionEntry | null>`：查 AgentConfig → machineId → WS 连接

**修改**：`handleAcpWsMessage` 收到 machine 连接的 `session_started`/`session_data`/`session_ended`/`session_error`/`session_queued`/`session_resumed` 时，调用 `entry.onSessionMessage(sessionId, type, payload)` 转发到 relay 层。

**删除函数**：`findAcpConnectionByAgentId()`、`sendToAgentWs()`（签名保留但实现替换，见下节）、`handleRegister()` 中 ACP agent 分支、`handleIdentify()` 整函数

**删除逻辑**：`handleAcpWsOpen` 中 ACP agent 的 EventBus 订阅逻辑

#### routes/acp/index.ts

`/acp/ws` 端点简化：

- 移除 ACP agent 认证路径（API key / environment secret）
- 只保留 `REGISTRY_SECRET` 认证路径（machine 注册）
- 非 machine 连接直接拒绝：`conn.close(4003, "unauthorized")`

### 接口保留、实现替换

以下函数的外部签名保持不变，内部实现从"本地 Instance/ACP WS"改为"machine WS 通信"，确保 **hermes-client**、**workflow/acp-transport**、**meta-agent**、**environment routes** 等调用方一行代码不改。

> **兼容说明**：以下函数的保留是为了避免修改多处调用方。它们属于过渡期兼容层，未来版本可考虑移除并让调用方直接使用 machine relay API。

#### `sendToAgentWs(agentId, msg)`

```typescript
// 保留签名，内部改为通过 machine WS 发送
export function sendToAgentWs(agentId: string, msg: object): boolean {
  const entry = findMachineConnectionByAgentId(agentId);
  if (!entry) return false;
  sendToWs(entry.ws, {
    type: "session_data",
    session_id: `auto_${agentId}`,
    payload: msg,
  });
  return true;
}
```

acp-link 侧配合：收到未知 `session_id` 的 `session_data` 时，自动视为隐式 `session_start`，lazy spawn agent 子进程。

#### `findRunningInstanceByEnvironment(environmentId, userId?)`

```typescript
// 保留签名，内部改为检查 machine 在线状态
export function findRunningInstanceByEnvironment(
  environmentId: string,
  userId?: string,
): SpawnedInstance | undefined {
  // 1. 查 Environment → AgentConfig → machineId
  // 2. 查 machine WS 是否在线
  // 3. 返回虚拟 SpawnedInstance（id = machineId, status = machine.status 映射）
  const entry = findMachineConnectionByEnvironmentId(environmentId);
  if (!entry) return undefined;
  return {
    id: entry.machineId!,
    userId: entry.userId,
    port: 0,
    pid: null,
    status: entry.ws.readyState === 1 ? "running" : "stopped",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date(entry.openTime),
    environmentId,
    instanceNumber: 1,
  };
}
```

#### `sendToInstanceRelay(instanceId, data)`

```typescript
// 保留签名，instanceId 即 machineId
export function sendToInstanceRelay(instanceId: string, data: string): boolean {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return false;
  const parsed = JSON.parse(data);
  sendToWs(entry.ws, {
    type: "session_data",
    session_id: `auto_${instanceId}`,
    payload: parsed,
  });
  return true;
}
```

#### `closeInstanceRelay(instanceId)`

```typescript
// 保留签名，改为发送 session_end 到 machine WS
export function closeInstanceRelay(instanceId: string): void {
  const entry = findMachineConnectionById(instanceId);
  if (!entry) return;
  sendToWs(entry.ws, { type: "session_end", session_id: `auto_${instanceId}` });
}
```

#### `spawnInstanceFromEnvironment(...)`

```typescript
// 保留签名，改为通过 machine WS 请求远端 spawn
export async function spawnInstanceFromEnvironment(
  userId: string,
  environmentId: string,
  prefetchedEnv?: EnvironmentRecord,
  extraEnv?: Record<string, string>,
): Promise<SpawnedInstance> {
  const entry = findMachineConnectionByEnvironmentId(environmentId);
  if (!entry) throw new NotFoundError("No online machine for this environment");

  const sessionId = `auto_${environmentId}_${Date.now()}`;
  sendToWs(entry.ws, { type: "session_start", session_id: sessionId });

  // 等待 session_started（超时 30s）
  const started = await waitForSessionStarted(entry, sessionId, 30000);
  if (!started) throw new AppError("Remote agent spawn timeout", "SPAWN_TIMEOUT", 504);

  return {
    id: entry.machineId!,
    userId,
    port: 0,
    pid: null,
    status: "running",
    command: "",
    error: null,
    apiKey: "",
    createdAt: new Date(),
    environmentId,
    instanceNumber: 1,
  };
}
```

### acp-link 侧 session 管理

#### SessionManager

acp-link 在 client 模式下新增 SessionManager，维护 `Map<sessionId, ChildProcess>`。

**收到 `session_start`**：
1. 检查当前活跃 session 数 < `max_sessions`
2. 超限 → 回复 `session_queued`，加入等待队列
3. 未超限 → `spawn("<agent_name>", ["acp"])`，监听 stdout/stderr
4. 回复 `session_started`

**收到 `session_data`**：
1. 查 `Map<sessionId, ChildProcess>`
2. 将 `payload` 序列化为 NDJSON 写入子进程 stdin
3. 若 session 不存在（lazy spawn）：自动执行 session_start 流程

**收到 `session_end`**：
1. SIGTERM → 等待 5s → SIGKILL
2. 清理 Map
3. 回复 `session_ended`
4. 若等待队列非空，取出下一个立即 spawn

**子进程 stdout 输出**：
- 逐行解析 NDJSON
- 包裹为 `{type: "session_data", session_id, payload}` 发送到 RCS

**子进程退出**：
- 回复 `session_ended`（reason 携带 exit code）
- 清理 Map

#### 重连逻辑

acp-link 断连后自动重连 RCS（指数退避，最大间隔 30s）：

1. 已运行的子进程**继续运行**（不 kill）
2. 重连成功后重新发送 `register`消息
3. 为每个仍存活的子进程发送 `session_resumed { session_id }`
4. RCS 匹配 `pending_reconnect` relay entry，恢复消息桥接

RCS 侧 relay entry 在 machine 断连后：
- relay WS 保持连接，不关
- 标记为 `pending_reconnect`
- 等待 machine 重连后的 `session_resumed` 消息
- 匹配到相同 `session_id` 后恢复 `onSessionMessage` 回调

### 代码删除清单

#### 完全删除

| 文件 | 原因 |
|------|------|
| `src/services/instance.ts` | 本地 Instance 进程管理全部废弃 |
| `src/routes/web/instances.ts` | Instance REST API 路由 |
| `src/schemas/instance.schema.ts` | Instance 校验 schema |
| `src/__tests__/instance-service.test.ts` | Instance 服务测试 |
| `src/__tests__/instance-routes.test.ts` | Instance 路由测试 |
| `src/__tests__/instance-error-codes.test.ts` | Instance 错误码测试 |
| `src/__tests__/instance-getinstance-cleanup.test.ts` | Instance 清理测试 |
| `src/__tests__/instance-meta.test.ts` | Instance meta 测试 |
| `src/__tests__/instance-prefetch-env.test.ts` | Instance prefetch 测试 |
| `src/__tests__/instance-supplement-cleanup.test.ts` | Instance supplement 测试 |

#### 大幅瘦身

| 文件 | 删除内容 |
|------|---------|
| `src/transport/relay/relay-handler.ts` | `openInstanceRelay()`、`openEventBusRelay()`；`handleRelayClose` 中 Instance 相关清理逻辑 |
| `src/transport/relay/index.ts` | `closeInstanceRelay`、`sendToInstanceRelay` export |
| `src/transport/acp-ws-handler.ts` | `handleRegister()` 中 ACP agent 分支（`if (!entry.isMachine)` 部分）、`handleIdentify()`、EventBus 订阅逻辑 |
| `src/routes/acp/index.ts` | `/acp/ws` 的 ACP agent 认证路径 |
| `src/index.ts` | `spawnInstanceFromEnvironment` 启动时预启动逻辑 |
| `src/routes/web/environments.ts` | `/environments/:id/instances` 路由、`spawnInstanceFromEnvironment` 调用 |
| `src/routes/web/index.ts` | `import webInstances` |
| `src/services/environment-web.ts` | `groupActiveInstancesByEnvironment` 引用 |
| `src/services/meta-agent.ts` | 无需改（`spawnInstanceFromEnvironment` 签名保留） |

### 排队机制

当 machine 上活跃 session 数达到 `max_sessions` 时：

1. acp-link 返回 `session_queued`（不 spawn）
2. RCS relay 收到后转发状态给前端（显示"排队中"）
3. 当前活跃 session 结束（`session_ended`）时：
   - acp-link 从队列头取出下一个 `session_id`
   - 立即 spawn，发送 `session_started`
4. 队列超时（默认 120s）：acp-link 发送 `session_error { error: "queue_timeout" }`，RCS 关闭 relay WS 并通知前端

### 前端影响

- Agent 创建/编辑表单的 machine 下拉选择器不变
- 远端 session 执行对前端透明——前端仍然连接 `/acp/relay/:agentId`，消息格式不变
- 新增 status 展示：排队中（`session_queued`）、远端执行中（`session_started`）
- Instance 管理页面移除

## 实现要点

1. **model 统一**：所有 acp-link 连接都是 machine 连接，`/acp/ws` 只接受 machine 注册，移除 ACP agent 认证路径
2. **relay 统一**：`handleRelayOpen` 只有一条路径——查 machine → `openMachineRelay`
3. **兼容层保留**：`sendToAgentWs`、`findRunningInstanceByEnvironment`、`spawnInstanceFromEnvironment`、`sendToInstanceRelay`、`closeInstanceRelay` 签名不变，内部改为 machine WS 通信，加注释说明兼容原因
4. **session 透传**：RCS 不做 agent 协议解析，所有 ACP 消息通过 `session_data.payload` 透明转发
5. **lazy spawn**：acp-link 收到未知 `session_id` 的 `session_data` 时自动 spawn，无需显式 `session_start`
6. **心跳在内存**：machine 的心跳超时检测保持不变，与 session 管理独立
7. **重连恢复**：machine 断连不 kill 子进程，重连后通过 `session_resumed` 恢复 relay 桥接
8. **`@fenix/core` 的 `launchInstance`/`connectInstanceRelay`** 在 RCS 侧不再调用，但 core 包本身保留（acp-link 侧可能仍需使用）
9. **向后兼容**：一期已完成的 machine 注册、心跳、REST API、前端绑定等功能保持不变

## 验收标准

- [ ] `/acp/ws` 拒绝非 machine 连接（API key / environment secret 认证返回 4003）
- [ ] 前端连接 `/acp/relay/:agentId`，Agent 绑定到在线 machine 时，relay 成功建立
- [ ] RCS 向 machine WS 发送 `session_start` 后，acp-link 成功 spawn agent 子进程并回复 `session_started`
- [ ] 前端发送 ACP 消息（init/prompt），通过 `session_data` 在 machine WS 上透传到远端 agent 子进程
- [ ] 远端 agent 子进程 stdout 输出通过 `session_data` 回传到前端 relay WS
- [ ] 前端 relay WS 断连 → RCS 发送 `session_end` → acp-link kill 子进程 → 回复 `session_ended`
- [ ] machine 上活跃 session 数达到 `max_sessions` 时，新请求返回 `session_queued`，有空闲 slot 后自动启动
- [ ] 队列超时（120s）后返回 `session_error`，RCS 关闭 relay WS
- [ ] machine WS 断连后 acp-link 自动重连，已运行子进程继续运行，重连后发送 `session_resumed` 恢复通信
- [ ] RCS 侧 relay WS 在 machine 断连后保持连接，等待 machine 重连恢复
- [ ] acp-link 收到未知 `session_id` 的 `session_data` 时，自动 lazy spawn agent 子进程
- [ ] `sendToAgentWs()` 内部通过 machine WS 发送，hermes-client 无需修改即可工作
- [ ] `findRunningInstanceByEnvironment()` 返回虚拟 SpawnedInstance，workflow 无需修改即可工作
- [ ] `spawnInstanceFromEnvironment()` 通过 machine WS 请求远端 spawn，meta-agent 无需修改即可工作
- [ ] 旧 Instance 管理 API（`/web/instances`）返回 404
- [ ] 旧 ACP agent 注册流程（非 machine 的 register/identify 消息）不再被处理
- [ ] `bun run precheck` 通过
- [ ] 现有测试套件中不受影响的测试仍能通过
- [ ] 不传 `--rcs-url` 时 acp-link 行为与改动前完全一致
- [ ] `REGISTRY_SECRET` 不匹配时注册被拒绝，返回 4003
