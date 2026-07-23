# 执行引擎架构：控制与影响逻辑

本文档说明 FenixAgent 项目中三层执行引擎各自的职责、控制链路和相互影响逻辑。

---

## 一、三层执行引擎概览

```
┌─────────────────────────────────────────────────────────────────────┐
│                        用户请求入口                                    │
│         WebSocket Relay  /  OpenAI Chat  /  Workflow  /  Scheduler    │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: 智能体执行引擎（Agent Execution Engine）                      │
│  位置: src/services/instance.ts, agent-chat-service.ts               │
│  职责: 业务层编排 — 决定"做什么"（哪个 Agent、什么配置、多少并发）        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 2: 组织机器执行引擎（Organization Machine Engine）               │
│  位置: src/services/registry.ts, core-bootstrap.ts,                  │
│        src/transport/acp-ws-handler.ts                               │
│  职责: 基础设施层调度 — 决定"在哪做"（本地还是远程机器、节点健康状况）     │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: ACP Runtime 执行引擎（ACP Runtime Engine）                   │
│  位置: packages/core/, packages/acp-link/, packages/acp-runtime-cli/ │
│  职责: 运行时执行 — 决定"怎么做"（prepare → start → relay → stop）     │
└─────────────────────────────────────────────────────────────────────┘
```

三层引擎自顶向下传递控制指令，自底向上反馈状态改变，形成完整的闭环控制。

---

## 二、Layer 1：智能体执行引擎

### 核心职责

| 职责 | 说明 |
|------|------|
| 实例生命周期 | 创建、复用、停止智能体实例 |
| 配置组装 | 将 `AgentConfig` + `Environment` 编译为 `AgentLaunchSpec` |
| 并发控制 | 通过 `maxSessions` 限制单环境并发数 |
| 空闲回收 | 通过 ACP 空闲监控自动停止闲置实例 |
| 多入口适配 | 统一支持 WebSocket Relay、OpenAI Chat、Workflow、Scheduler |

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/instance.ts` | 实例 spawn/stop/list，`ensureRunning`、`spawnInstanceFromEnvironment` |
| `src/services/agent-chat-service.ts` | `openAgentSession` 一站式入口（spawn → relay → turn） |
| `src/services/launch-spec-builder.ts` | `buildLaunchSpec` — 将 Agent 配置编译为 Core 可消费的 spec |
| `src/services/instance-registry.ts` | `globalInstanceRegistry` — 内存补充信息（userId, relay 计数等） |
| `src/services/acp-idle-monitor.ts` | 空闲巡检，满足超时条件自动 `stopInstance` |

### 核心逻辑

**实例启动决策链** (`ensureRunning` → `spawnInstanceFromEnvironment`)：

1. 检查是否已有 running 实例 → 如有则**复用**（避免重复启动）
2. 读取 `EnvironmentRecord`，获取绑定的 `agentConfigId`
3. 通过 `launch-spec-builder.ts` 将 `AgentConfig` 编译为 `AgentLaunchSpec`（模型、Skill、MCP、SystemPrompt、环境变量）
4. **确定执行节点**（nodeId）：`agentConfig.machineId` → `RCS_DEFAULT_MACHINE_ID` 环境变量 → `"local-default"`
5. 调用 `CoreRuntimeFacade.launchInstance()` 委托 Core 层启动
6. 注册 `InstanceSupplement` 到 `globalInstanceRegistry`（userId、environmentId、relayCount 等）

**实例停止**：

- 主动停止：`stopInstance()` → `facade.stopInstance()` + 清理 registry
- 被动停止：ACP 空闲监控 → relay 断开超时 / 业务无活动硬超时 → 自动 `stopInstance()`

---

## 三、Layer 2：组织机器执行引擎

### 核心职责

| 职责 | 说明 |
|------|------|
| 机器注册 | pre-create（DB pending）→ runtime 注册（WS connect + register 消息） |
| 心跳管理 | 30s 间隔心跳 + 90s 超时检测 |
| 节点调度 | 将 machine 注册为 Core 的 remote/local node |
| 断连清理 | WS 断开 / 心跳超时 → DB 置 offline + Core 清理 + relay 关闭 |
| 消息路由 | RCS ↔ remote machine 的 NDJSON over WS 双向通信 |

### 关键文件

| 文件 | 职责 |
|------|------|
| `src/services/registry.ts` | Machine DB CRUD：`listMachines`、`registerMachine`、`disconnectMachine` |
| `src/services/registry-heartbeat.ts` | 心跳管理：`startHeartbeat`、`handleHeartbeat`、`stopHeartbeat` |
| `src/services/core-bootstrap.ts` | Core 初始化 + `registerRemoteNode` / `unregisterRemoteNode` |
| `src/transport/acp-ws-handler.ts` | Machine WS 连接管理：`handleAcpWsOpen`、消息路由、断连处理 |
| `packages/acp-runtime-cli/src/bin.ts` | 远程机器 CLI 入口：启动 Agent + acp-link bridge + 注册到 RCS |

### 核心逻辑

**机器注册流程**：

1. 管理员通过 `POST /web/registry/machines` 预创建 machine 记录（status=pending），获得 `RCS_MACHINE_ID` + `RCS_SECRET`
2. 远程机器运行 `acp-runtime opencode acp`，携带凭据连接到 `WS /acp/ws`
3. 发送 `register` 消息 → `registerMachine()`：更新 DB status=online，写 registryEvent
4. `registerRemoteNode(machineId, ws, acpEntry, engineTypes)`：
   - 创建 `WsRemoteTransport`
   - 注册为 Core 的 remote node（`mode: "remote"`）
   - 缓存 transport 供后续 `launchInstance` 使用

**机器断连清理流程**：

```
WS close / 心跳超时
  → unregisterRemoteNode(machineId)
    → remoteTransports.delete(machineId)        # 清理 transport 缓存
    → runtime.updateNodeStatus(machineId, "offline")  # 节点下线
    → runtime.deleteInstance(所有该节点实例)      # 清理 Core 实例记录
  → disconnectMachine(machineId)
    → DB machine.status = "offline"             # 持久化状态
  → 关闭所有关联 relay 连接                      # 通知前端
```

**节点选择优先级**（Layer 1 决定，Layer 2 执行）：

```
agentConfig.machineId  >  RCS_DEFAULT_MACHINE_ID (env)  >  "local-default"
```

其中 `local-default` 是 RCS 进程内的本地执行节点，使用 EnginePlugin 直接启动进程。

---

## 四、Layer 3：ACP Runtime 执行引擎

### 核心职责

| 职责 | 说明 |
|------|------|
| 类型抽象 | 定义 `EnginePlugin`、`EngineRuntime`、`CoreNode`、`RuntimeInstance` 等核心类型 |
| 实例编排 | `InstanceOrchestrator` 管理四阶段生命周期（prepare → start → relay → stop） |
| 插件路由 | 通过 `engineType` 选择正确的 Engine Plugin（opencode/ccb/claude-code） |
| 远程通信 | `RemoteRuntime` 将 prepare/start/relay 指令通过 WS 转发到远程机器 |
| 桥接代理 | acp-link 在远程机器上桥接 stdio（Agent CLI）↔ WebSocket（RCS） |

### 关键文件

| 文件 | 职责 |
|------|------|
| `packages/core/src/facade/core-runtime.ts` | `createCoreRuntime` — 对外唯一入口，装配所有子系统 |
| `packages/core/src/runtime/instance-orchestrator.ts` | 实例编排器，四阶段生命周期 |
| `packages/core/src/registry/core-node-registry.ts` | 节点注册表，按 id 路由 |
| `packages/core/src/registry/engine-plugin-registry.ts` | 插件注册表，按 engineType 路由 |
| `packages/core/src/types/` | 核心类型定义（CoreNode, LaunchInstanceRequest, RuntimeInstanceStatus） |
| `packages/remote-runtime/` | RemoteRuntime + WsRemoteTransport |
| `packages/acp-link/src/server.ts` | AcpServer — 远程机器上的 WS 桥接服务 |
| `packages/acp-link/src/client/instance-manager.ts` | 远程机器上的实例管理器（prepare/start/stop） |

### 核心逻辑

**实例状态机**（8 态）：

```
created → preparing → prepared → starting → running → stopping → stopped
                                  ↓ (任何步骤失败)
                               error
```

**四阶段生命周期**（`InstanceOrchestrator.launch()`）：

```
Phase 1: prepareEnvironment
  → engineType 路由到正确 plugin
  → 本地: plugin 直接创建 workspace + 写配置文件
  → 远程: RemoteRuntime 通过 WS 发送 { type: "prepare" } 到远程 acp-link
         → InstanceManager.prepare() → 创建 workspace + 写配置文件

Phase 2: startInstance
  → 本地: plugin 直接 spawn Agent CLI 子进程
  → 远程: RemoteRuntime 通过 WS 发送 { type: "start" } 到远程 acp-link
         → InstanceManager.start() → spawn Agent CLI 子进程

Phase 3: connectRelay (前端建立 relay 时触发)
  → 创建 EngineRelayHandle 或 RemoteRelayHandle
  → 双向转发: 前端 ↔ RCS relay ↔ Core relay ↔ (远程 WS) ↔ acp-link ↔ Agent CLI stdio

Phase 4: stopInstance
  → 关闭 relay → 停止 Agent CLI 进程 → 清理资源
```

**runtimeResolver 宏**（`src/services/core-bootstrap.ts:78`）：

这是三层引擎的关键耦合点。当 Core 编排器调用 `runtimeResolver(engineType, node)` 时：
- `node.mode === "remote"` → 返回 `RemoteRuntime`（WS 转发）
- `node.mode === "local"` → 返回插件创建的本地 runtime（进程内启动）

此机制使得 RCS 业务层（Layer 1）**完全无感知本地/远程差异**。

---

## 五、控制链路：请求从进入到响应的完整路径

### 路径 A：前端 Relay 场景（最常见）

```
用户进入 Agent 页面
  │
  ├─ 前端连接 WS /acp/relay/:agentId
  │   │
  │   ├─ Layer 1: ensureRunning(environmentId)
  │   │   ├─ 检查是否已有 running 实例 → 有则复用
  │   │   ├─ 无则 spawnInstanceFromEnvironment()
  │   │   │   ├─ 读取 Environment + AgentConfig
  │   │   │   ├─ buildLaunchSpec() 编译配置
  │   │   │   └─ 确定 nodeId (agentConfig.machineId > default > local-default)
  │   │   │
  │   │   ├─ Layer 2: 远程节点检查
  │   │   │   ├─ findMachineConnectionById(nodeId) → WS 存活检查
  │   │   │   └─ 未连接 → MACHINE_OFFLINE 错误 (503)
  │   │   │
  │   │   └─ Layer 3: facade.launchInstance()
  │   │       ├─ InstanceOrchestrator.launch()
  │   │       │   ├─ runtimeResolver(engineType, node) → RemoteRuntime 或 LocalRuntime
  │   │       │   ├─ prepareEnvironment()  ─┐ (远程: WS → acp-link)
  │   │       │   └─ startInstance()      ─┘
  │   │       └─ status = "running"
  │   │
  │   └─ facade.connectInstanceRelay()
  │       └─ 建立双向 relay 通道
  │
  └─ 前端 ↔ relay ↔ Core relay ↔ (远程 WS) ↔ acp-link ↔ Agent CLI stdio
      │
      └─ 每条消息触发 touchInstanceActivity() (Layer 1 空闲监控)
```

### 路径 B：OpenAI Chat API 场景

```
POST /api/v1/chat/completions
  │
  └─ Layer 1: openAgentSession({ userId, agentConfigId })
      ├─ 解析 agentConfigId → environmentId
      ├─ spawnInstanceFromEnvironment() [同上]
      ├─ connectAgentRelay()
      ├─ 发送 session/new → 开始 PromptTurn
      └─ 流式返回 SSE 响应
```

### 路径 C：Workflow / Scheduler 场景

```
Workflow 节点 / Cron 触发
  │
  └─ agent-chat-transport.ts → openAgentSession()
      └─ [同路径 B]
```

---

## 六、影响逻辑：层与层之间的相互作用

### 6.1 Machine 状态对 Agent 实例的影响

| Machine 事件 | 对 Agent 的影响 |
|-------------|----------------|
| **Machine 注册上线** | 该 machine 上的 agentConfig 可以正常 spawn 实例；Layer 2 将 machine 注册为 remote node，Layer 3 后续可直接调度 |
| **Machine 心跳超时 / WS 断连** | Layer 2 触发 `performMachineCleanup()` → `unregisterRemoteNode()` → 删除该 node 下所有 Core 实例 → Layer 1 的 `globalInstanceRegistry` 对应记录被清理 → 用户下次进入需要重新 `ensureRunning` |
| **Machine 重连** | Layer 2 跳过 DB/core 清理，仅清除旧实例让 `ensureRunning` 重新 launch → 前端 relay 自动重连 |
| **spawn 时 machine 未连接** | Layer 1 在 spawn 前检查 `findMachineConnectionById()` → 抛 `MACHINE_OFFLINE` (503)，阻止启动 |

### 6.2 Agent 配置对 Machine 选择的影响

| 配置项 | 影响 |
|-------|------|
| `agentConfig.machineId` | **最高优先级**。绑定到特定 machine 的 Agent 始终在该机器上运行 |
| `config.defaultMachineId` (环境变量) | 次优先级。Agent 未绑定 machine 时使用 |
| 无上述配置 | 使用 `local-default` 本地节点 |
| `agentConfig.engineType` | 决定使用哪个 Engine Plugin。机器注册时需声明支持的 engineTypes，不匹配则调度失败 |
| `environment.maxSessions` | 限制单环境并发实例数，超过则 `ensureRunning` 返回已有实例 |

### 6.3 空闲监控对实例生命周期的影响

```
ACP 空闲监控（Layer 1: acp-idle-monitor.ts）
  │
  ├─ 双阈值机制
  │   ├─ acpIdleTimeoutSeconds：relay 断开后空闲超时
  │   └─ acpActivityTimeoutSeconds：relay 保持但业务无活动硬超时
  │
  ├─ relay 断开 → markInstanceRelayDetached() → 开始空闲倒计时
  ├─ relay 重连 → markInstanceRelayAttached() → 重置倒计时
  │
  └─ 定时扫描 (sweep interval)
      ├─ 满足阈值 → Layer 1 stopInstance()
      │   → Layer 3 facade.stopInstance()
      │   → 停止 Agent CLI 进程
      └─ 不满足 → 保持运行
```

### 6.4 服务重启对三层引擎的影响

```
服务启动
  │
  ├─ Layer 3: initCoreRuntime()
  │   ├─ 注册 EnginePlugin（opencode/ccb/claude-code）
  │   ├─ 注册 local-default node
  │   └─ 安装 runtimeResolver
  │
  └─ Layer 2: 等待 machine 重新连接
      ├─ 每个 machine 重新 connect → register → registerRemoteNode
      └─ Layer 1: ensureRunning 在下次用户请求时自动重新 spawn
```

### 6.5 状态双向传播

```
       控制流 (自上而下)                    状态流 (自下而上)
═══════════════════════════        ═══════════════════════════

Layer 1                          Layer 1
  │ spawn / stop                    ▲ idle 超时通知
  ▼                                 │
Layer 2                          Layer 2
  │ 节点选择 / 路由                   ▲ machine online/offline
  ▼                                 │
Layer 3                          Layer 3
  │ prepare / start / relay          ▲ status 变更 / error
  ▼                                 │
Agent CLI 进程                    Agent CLI 进程退出 / 异常
```

### 6.6 关键耦合点汇总

| 耦合点 | 位置 | 说明 |
|-------|------|------|
| `runtimeResolver` | `src/services/core-bootstrap.ts:78` | L1/L2 通过它注入远程 transport，L3 通过它获取正确的 runtime 实现 |
| `globalInstanceRegistry` | `src/services/instance-registry.ts` | L1 的业务补充信息（userId、relayCount），L3 无感知 |
| `findMachineConnectionById` | `src/transport/acp-ws-handler.ts` | L1 spawn 前的 L2 连通性检查 |
| `touchInstanceActivity` | `src/services/acp-idle-monitor.ts` | L1 空闲监控的埋点，每条 ACL 消息都触发 |
| `onInstanceStarted` | `src/services/core-bootstrap.ts:75` | L3 实例 started 后回调，写入 pluginMetadata |
| `WsRemoteTransport` | `packages/remote-runtime/` | L2 创建并缓存，L3 通过 `runtimeResolver` 消费 |

---

## 七、关键设计原则

1. **关注点分离**：三层各司其职 — 业务编排 / 基础设施 / 运行时执行
2. **统一抽象**：`runtimeResolver` 宏使上层对 local/remote 无感知
3. **幂等与复用**：`ensureRunning` 优先复用已有实例，避免重复启动
4. **防御性清理**：断连时三层同步清理（DB + Core + registry），不留僵尸实例
5. **自适应调度**：Agent 可绑定到特定 machine，也可以让系统自动分配（default、local）
6. **单一真相来源**：ACP 协议处理只有 `agent-chat-service.ts` 一套权威实现，禁止各入口自行重写
