# 远程 Machine 纳入 EngineRuntime 统一抽象

## 背景

当前 RCS 的实例生命周期存在两条割裂的路径：

- **本地路径**：通过 `CoreRuntimeFacade` → `plugin-opencode` 的 `EngineRuntime` 接口，走 `prepareEnvironment → startInstance → connectRelay → stopInstance` 完整生命周期
- **远程路径**：`relay-handler.ts` 直接操作 WebSocket，发送 `session_start` 给 acp-link，acp-link 的 `SessionManager` 只提取 `extraEnv` 和 `cwd` 就裸 spawn opencode——`AgentLaunchSpec` 中的 model、mcpServers、skills、knowledge 配置全部被丢弃

远程路径绕过了 `EngineRuntime` 抽象，导致远程机器上的 agent 缺少配置文件、skills 安装、MCP 挂载等关键环境装配。

## 目标

将远程 machine 纳入 `@fenix/core` 的 `EngineRuntime` 统一抽象，使本地和远程走同一套 `CoreRuntimeFacade` 调度链路，远程 acp-link 具备完整的环境装配能力。

## 架构设计

### 整体架构

```
┌─ RCS 服务器 ─────────────────────────────────────────────────┐
│                                                               │
│  relay-handler.ts (调度层)                                     │
│       │                                                       │
│       ▼                                                       │
│  CoreRuntimeFacade                                            │
│       │                                                       │
│       ├── 本地: plugin-opencode (local node)                   │
│       │     prepareEnvironment → 本地写 opencode.json          │
│       │     startInstance → 进程内 spawn acp-link              │
│       │     connectRelay → 本地 WS relay handle                │
│       │                                                       │
│       └── 远程: @fenix/remote-runtime (remote node)            │
│             prepareEnvironment → WS 发 prepare 给远程          │
│             startInstance → WS 发 start 给远程                 │
│             connectRelay → 远程 WS relay handle                │
│             stopInstance → WS 发 stop 给远程                   │
│                                                               │
└───────────────────────────────────────────────────────────────┘
          │ WebSocket (ACP 协议扩展)
          ▼
┌─ 远程机器 ────────────────────────────────────────────────────┐
│                                                               │
│  acp-link (client mode)                                       │
│       │                                                       │
│       ├── prepare → 创建 workspace 目录、写 opencode.json、    │
│       │              下载安装 skills                           │
│       ├── start → spawn opencode acp 子进程                   │
│       ├── session 生命周期消息转发 (session_data/ended/...)    │
│       └── stop → 终止进程、清理资源                            │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### 涉及变更的包

| 包 | 角色 | 变更内容 |
|---|---|---|
| `@fenix/core` | 核心调度 | `CoreNodeMode` 增加 `"remote"`；orchestrator 对 remote node 使用 remote runtime |
| `@fenix/remote-runtime` (新包) | 远程 runtime 实现 | 实现 `EngineRuntime` 接口，通过 WS 与远程 acp-link 通信 |
| `@fenix/plugin-opencode` | 本地 runtime | 提取 `buildOpencodeRuntimeConfig`、`writeOpencodeConfig`、`installSkills` 为可复用模块 |
| `acp-link` | 远程执行代理 | 扩展 WS 协议，增加 prepare/start/stop 消息处理，内嵌环境装配逻辑 |
| `@fenix/plugin-sdk` | 接口定义 | 如需扩展接口则在此修改 |
| RCS 主服务器 | 集成 | `core-bootstrap.ts` 动态注册远程 node；`relay-handler.ts` 统一走 facade |

## 详细设计

### 1. `@fenix/core` — CoreNodeMode 扩展

**`packages/core/src/types/core-node.ts`**：

```typescript
export type CoreNodeMode = "local" | "remote";
```

`CoreNode` 和 `CreateCoreNodeInput` 的 `mode` 字段接受 `"remote"`。remote node 需要在 `metadata` 中携带远程连接信息：

```typescript
interface RemoteNodeMetadata {
  machineId: string;       // 远程 machine 标识
  // 其他信息按需扩展
}
```

**`instance-orchestrator.ts`**：launch 流程对 remote node 使用不同的 runtime 工厂。具体来说，orchestrator 不直接创建 runtime，而是通过一个可配置的 `runtimeResolver` 根据 node mode 选择 runtime：

```typescript
// orchestrator 在 launch 时：
const node = nodeRegistry.require(request.nodeId);
// node.mode === "remote" 时，使用 remote runtime
// node.mode === "local" 时，使用 plugin.createRuntime()（现有行为）
```

### 2. `@fenix/remote-runtime` (新包)

实现 `EngineRuntime` 接口，通过 WebSocket 与远程 acp-link 通信。

**核心类 `RemoteRuntime`**：

```typescript
class RemoteRuntime implements EngineRuntime {
  constructor(private transport: RemoteTransport) {}

  async prepareEnvironment(input: PrepareEnvironmentInput): Promise<void> {
    // 序列化 AgentLaunchSpec，通过 WS 发送给远程 acp-link
    const result = await this.transport.sendAndWait("prepare", {
      instance_id: input.instanceId,
      launch_spec: input.launchSpec,
    });
    if (result.status === "error") throw new Error(result.message);
  }

  async startInstance(input: StartInstanceInput): Promise<void> {
    const result = await this.transport.sendAndWait("start", {
      instance_id: input.instanceId,
    });
    if (result.status === "error") throw new Error(result.message);
  }

  async connectRelay(input: ConnectRelayInput): Promise<EngineRelayHandle> {
    // 返回一个基于 WS 的 relay handle
    // 消息通过 transport 转发到远程 acp-link
    return new RemoteRelayHandle(this.transport, input.instanceId, input.sessionId);
  }

  async stopInstance(input: StopInstanceInput): Promise<void> {
    const result = await this.transport.sendAndWait("stop", {
      instance_id: input.instanceId,
    });
    // stop 失败不抛错（幂等）
  }
}
```

**`RemoteTransport`**：封装与远程 acp-link 的 WebSocket 通信，提供 `sendAndWait` 方法实现请求-响应模式（基于 request ID 匹配），以及 `onMessage` 监听远程推送的 session 生命周期消息。

**`RemoteRelayHandle`**：实现 `EngineRelayHandle` 接口，将 send/close 操作映射为远程 WS 消息，将远程推送的 session 消息通过 `onMessage` 回调传递。

**runtime 工厂**：

```typescript
interface RemoteRuntimeOptions {
  transport: RemoteTransport;
}

function createRemoteRuntime(options: RemoteRuntimeOptions): EngineRuntime {
  return new RemoteRuntime(options.transport);
}
```

### 3. `@fenix/plugin-opencode` — 提取共享模块

将以下逻辑提取为可被 acp-link 复用的独立模块：

- `buildOpencodeRuntimeConfig(launchSpec, skills)` → 把 `AgentLaunchSpec` 转成 `opencode.json` 格式
- `writeOpencodeConfig(workspace, config)` → 写入 `.opencode/opencode.json`
- `ensureWorkspaceRuntimeDirs(workspace)` → 创建 `.opencode/` 和 `.opencode/skills/` 目录
- `installSkills(workspace, skills)` → 下载并解压 skill 包

提取方式：从 `plugin-opencode` 导出这些函数，acp-link 通过 workspace 依赖引用。不新建包，因为这些函数依赖 `AgentLaunchSpec` 类型和 `OpencodeRuntimeConfig` 类型，本身就属于 opencode 生态。

### 4. acp-link — WS 协议扩展与环境装配

**新增 WS 消息类型**：

| 方向 | 类型 | 说明 |
|---|---|---|
| RCS → acp-link | `prepare` | 携带 `instance_id` + `AgentLaunchSpec` |
| acp-link → RCS | `prepare_result` | `{ status: "ok" \| "error", message? }` |
| RCS → acp-link | `start` | 携带 `instance_id` |
| acp-link → RCS | `start_result` | `{ status: "ok" \| "error", message?, capabilities? }` |
| RCS → acp-link | `stop` | 携带 `instance_id` |
| acp-link → RCS | `stop_result` | `{ status: "ok" \| "error", message? }` |
| RCS → acp-link | `relay` | 携带 `instance_id` + `session_id` + relay 消息体 |
| acp-link → RCS | `relay` | 携带 `instance_id` + `session_id` + relay 消息体 |

**acp-link 端新增 `InstanceManager`**：

替代现有 `SessionManager`，管理多个远程实例：

```typescript
class InstanceManager {
  private instances = new Map<string, InstanceState>();

  async prepare(instanceId: string, launchSpec: AgentLaunchSpec): Promise<void> {
    // 1. resolveWorkspace：基于 launchSpec 中的 org/user/envId 计算 workspace 路径
    // 2. ensureWorkspaceRuntimeDirs
    // 3. installSkills
    // 4. buildOpencodeRuntimeConfig
    // 5. writeOpencodeConfig
  }

  async start(instanceId: string): Promise<Capabilities> {
    // 1. 从 instance state 读取 workspace 和配置
    // 2. spawn opencode acp 子进程
    // 3. ACP initialize
    // 4. 返回 capabilities
  }

  async stop(instanceId: string): Promise<void> {
    // 1. kill opencode 子进程
    // 2. 清理 instance state
  }

  // relay 消息转发
  async sendRelay(instanceId: string, sessionId: string, message: unknown): Promise<void> {
    // 转发到对应实例的 ACP connection
  }
}
```

**保留现有 client mode 兼容**：`register`/`registered`/`heartbeat`/`session_start`（旧） 等消息类型继续支持，作为 fallback。新协议通过 `prepare` → `start` → `relay` 走完整生命周期。acp-link 收到 `session_start` 时仍按旧逻辑处理（向后兼容），收到 `prepare` 时走新的 `InstanceManager` 路径。

### 5. RCS 主服务器集成

**`core-bootstrap.ts`**：

- 引入 `@fenix/remote-runtime`
- 新增 `registerRemoteNode(machineId, transport)` 函数，当远程 acp-link 注册成功时调用
- 新增 `unregisterRemoteNode(machineId)` 函数，当远程 acp-link 断连时调用

**`acp-ws-handler.ts`**：

- `register` 消息处理成功后，调用 `registerRemoteNode(machineId, transport)` 将远程 machine 注册为 core node
- `disconnect` 时调用 `unregisterRemoteNode(machineId)` 清理

**`relay-handler.ts`**：

- `handleRelayOpen` 简化为统一路径：
  1. `ensureRunning(userId, agentId)` — 内部判断 local/remote node
  2. `facade.connectInstanceRelay({ instanceId, sessionId })` — 统一 relay
- 删除 `openMachineRelay` 函数（其逻辑下沉到 remote-runtime 的 `connectRelay`）
- 删除 `buildAndSendSessionStart`（其逻辑由 remote-runtime 的 `prepareEnvironment` + `startInstance` 替代）

**`instance.ts`**：

- `spawnInstanceFromEnvironment` 需要感知 node 类型：当 environment 关联了 machineId 时，nodeId 使用远程 machineId 而非 `"local-default"`
- `ensureRunning` 对远程实例可能需要不同的并发策略（远程 machine 可能有自己的并发限制）

### 6. 远程 Transport 层设计

`@fenix/remote-runtime` 的 `RemoteTransport` 需要与 `acp-ws-handler.ts` 中的现有 WS 连接协作：

- 远程 acp-link 连接到 `/acp/ws` 后，RCS 端持有其 `WsConnection` 对象
- `RemoteTransport` 包装这个 `WsConnection`，提供面向 runtime 的消息收发接口
- 使用 request ID 实现请求-响应匹配（`prepare` → `prepare_result` 等）
- session 生命周期消息（`session_data`/`session_ended` 等）通过回调机制传递给 `RemoteRelayHandle`

## 向后兼容

- acp-link 现有的 `session_start` 旧协议继续支持，收到 `session_start`（无 `prepare` 前置）时走旧 `SessionManager` 逻辑
- 现有本地路径完全不变，`plugin-opencode` 不受影响
- 远程 node 的注册是动态的，不影响 static 的 `local-default` node

## 测试策略

- `@fenix/core`：扩展现有 orchestrator 测试，覆盖 remote node 的 launch/connect/stop
- `@fenix/remote-runtime`：使用 mock transport 测试各生命周期方法的协议交互
- acp-link `InstanceManager`：单元测试 prepare/start/stop 的逻辑正确性
- RCS 集成：relay-handler 统一路径的端到端测试（mock remote transport）
