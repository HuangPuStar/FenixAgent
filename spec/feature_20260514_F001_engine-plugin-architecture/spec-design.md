# Feature: 20260514_F001 - engine-plugin-architecture

## 需求背景

当前系统已经有本地进程管理、relay、workspace 和配置解析等能力，但这些能力仍然较强地绑定在具体 engine 实现上。随着后续接入 `opencode`、`cc` 等不同 agent engine，如果继续沿用“每新增一种 engine 就改一遍后台主流程”的方式，`core` 会逐渐承担过多引擎私有细节，难以复用，也不利于远端 node 调度。

这次设计要解决的核心问题是：把“平台业务编排”“运行时调度”“引擎私有实现”三层边界切开，让后台服务只负责组装启动参数并选择 node，`core` 负责统一编排生命周期，engine 差异全部收敛到 plugin。

## 目标

- 让 `core` 成为统一的运行时调度内核，能够一致地调度本地和远端 node。
- 用 `plugin-sdk` 定义稳定的 engine 适配接口，让新增 engine 时不需要改 `core` 主调度流程。
- 明确 `AgentLaunchSpec` 的职责：它是一次启动请求的标准化输入，不是运行时状态，也不是 node 环境定义。
- 统一生命周期顺序为 `prepareEnvironment -> startInstance -> connectRelay -> stopInstance`。
- 远端优先采用“一个通用 `engine-node` host + 多个 engine plugins”的模型，避免每种 engine 单独发明一套 remote host。

## 方案设计

### 架构结论

- `engine` 是引擎类型插件，不是运行实例，也不是远端节点。
- `node` 是执行资源，分为 `local` 和 `remote`。
- 后台服务负责选择目标 `node`，并组装 `AgentLaunchSpec`。
- `core` 只负责编排和校验，不负责业务实体管理与引擎私有实现。
- `plugin-sdk` 只定义引擎适配接口和共享类型，不承载远端接入协议。
- `AgentLaunchSpec` 是统一启动配置，不承担调度职责，也不表达 node 自身环境。

### 分层职责

#### 后台服务

负责：

- 管理平台业务实体，如 `environment / instance / session`
- 解析平台配置并组装 `AgentLaunchSpec`
- 选择目标 `node`
- 调用 `core` 发起启动、停止、relay 连接等流程

不负责：

- 直接实现 engine 私有进程管理
- 直接处理远端 node RPC

#### core

负责：

- 接收后台服务传入的 `AgentLaunchSpec` 和运行参数
- 校验目标 `node` 是否存在、在线且支持指定 `engineType`
- 编排统一生命周期
- 管理 relay、事件和状态桥接
- 在本地 node 与远端 node 之间提供一致的调度抽象

不负责：

- 管理 `environment / instance / session` 的业务真相
- 数据库存储和业务仓储
- HTTP 路由或后台服务 API
- node 选择策略和 placement 决策
- 引擎私有启动命令、配置文件格式和 keep_alive 细节

#### engine plugin

插件表示一种 engine 类型，例如：

- `opencode`
- `cc`

负责：

- 消费统一的 `AgentLaunchSpec`
- 在 `prepareEnvironment` 阶段完成启动前资源准备
- 启停实例
- 建立 relay
- 将 engine 私有行为映射为统一生命周期

#### engine node

node 是实际可调度的执行资源，也是 `core` 进行容量调度和远端命令投递的目标。

- 本地 node：由 `core` 发起调度，具体启动逻辑由 plugin 实现
- 远端 node：独立部署在其他机器上，注册到 `core`
- 一个 node 可以同时运行多个 agent 实例

远端推荐采用通用 plugin host：

- 只维护一个 `engine-node`
- 在 node 内加载 `plugin-opencode`、`plugin-cc`
- node 向 `core` 声明自己支持的 `engineTypes`

这一层建议拆成两个对象：

- `EngineNode`：供注册、心跳和调度使用的节点摘要
- `node runtime state`：节点内部运行态，由 node 自己维护；`core` 可以读取，但不拥有其真相

#### remote control protocol

远端协议独立于 `plugin-sdk`，推荐采用 RPC 风格，而不是 REST 资源接口风格。

它只负责：

- `registerNode`
- `heartbeat`
- `prepareEnvironment`
- `startInstance`
- `stopInstance`
- `connectRelay`
- `publishRuntimeEvent`

建议拆成两层：

- command RPC：`core -> engine-node`
- event stream：`engine-node -> core`

最小消息模型示意：

```ts
export interface RemoteRpcRequest<TPayload = unknown> {
  requestId: string;
  method:
    | "registerNode"
    | "heartbeat"
    | "prepareEnvironment"
    | "startInstance"
    | "stopInstance"
    | "connectRelay";
  payload: TPayload;
}

export interface RemoteRpcResponse<TResult = unknown> {
  requestId: string;
  ok: boolean;
  result?: TResult;
  error?: {
    code: string;
    message: string;
  };
}
```

### 核心模型

#### EnginePlugin / EngineRuntime

```ts
export interface EnginePluginMeta {
  id: string;
  displayName: string;
  version: string;
}

export interface EnginePlugin {
  meta: EnginePluginMeta;
  createRuntime(): EngineRuntime;
}

export interface EngineRuntime {
  prepareEnvironment(input: PrepareEnvironmentInput): Promise<void>;
  startInstance(input: StartInstanceInput): Promise<void>;
  stopInstance(input: StopInstanceInput): Promise<void>;
  connectRelay(input: ConnectRelayInput): Promise<EngineRelayHandle>;
}
```

设计约束：

- 保留显式生命周期方法，不使用宽泛的 `engineCtrl(action, payload)`
- session 列表通过 relay 交互返回，不单独定义 `listSessions`
- plugin-sdk 层统一只暴露一个稳定的 `instanceId`，不额外暴露 node 私有实例标识
- `startInstance` 不负责再次接收和组装 agent 配置；它只能消费前一步已经准备好的环境

#### AgentLaunchSpec

`AgentLaunchSpec` 只描述一次 agent 启动所需的标准化输入，例如：

- `workspace`
- `env`
- `agent`
- `model`
- `skills`
- `mcpServers`

它不描述：

- 调度到哪个 `node`
- node 自身安装了哪些依赖或运行在什么环境里
- 生命周期命令如何下发
- 远端协议如何回调

它的来源是：

- 后台服务基于自身管理的 `environment / instance / session` 等业务数据组装
- 再将 `AgentLaunchSpec` 作为输入传给 `core`

它的注入时机是：

- `core` 在调用 plugin 的 `prepareEnvironment()` 时传入 `AgentLaunchSpec`
- plugin 在该阶段基于 `workspace`、`env` 和其他启动配置完成配置文件生成、环境变量写入、skills/mcp materialization 等准备工作
- `startInstance()` 只在环境准备完成之后执行，不再重复接收 `AgentLaunchSpec`

#### Instance Identity

为避免平台侧和 node/plugin 侧维护两套实例标识，plugin-sdk 层统一只保留一个 `instanceId`。

推荐约定：

- 后台服务维护自己的业务 `instanceId`
- plugin、core、remote node 都以这个 `instanceId` 作为运行时锚点
- node 内部如果确实存在进程 id、容器 id 等私有标识，只保留在实现内部或 `metadata` 中，不提升到 sdk 接口层



#### EngineNode

```ts
export interface EngineNode {
  id: string;
  mode: "local" | "remote";
  engineTypes: string[];
  endpoint?: string;
  status: "online" | "offline" | "error";
  usage: {
    runningInstances: number;
  };
  metadata?: Record<string, unknown>;
  lastHeartbeatAt?: Date;
}
```

说明：

- `engineTypes` 用于表达通用远端 node host 支持多个 engine plugin
- `idle/busy` 不适合多实例 node，调度应基于 `maxInstances` 和 `runningInstances`
- `status` 只表达节点是否可用，不表达当前负载是否已满
- node 当前运行了哪些 runtimes，由 node 自己维护；`core` 不维护 runtime truth，也不负责 runtime 对账

如果 `core` 需要查看 node 当前 runtimes，应通过只读查询获取 snapshot，例如：

```ts
export interface EngineRuntimeSummary {
  instanceId: string;
  engineType: string;
  status: "starting" | "running" | "stopped" | "error";
  startedAt?: Date;
  metadata?: Record<string, unknown>;
}
```

建议通过 node RPC 暴露只读接口：

- `listRuntimes(nodeId) => EngineRuntimeSummary[]`
- `getRuntime(nodeId, instanceId) => EngineRuntimeSummary`

这类数据仅用于查看、诊断和辅助判断，不作为 `core` 内部维护的权威状态。

### 调度流程

#### 本地 node

```text
User/API
  -> Backend Service
  -> choose nodeId
  -> build AgentLaunchSpec
  -> Core
  -> validate nodeId
  -> plugin runtime prepareEnvironment(launchSpec)
  -> plugin runtime startInstance(preparedEnvironment)
  -> plugin runtime connectRelay
```

说明：

- 本地 node 的控制权在 `core`
- 具体启动逻辑在 plugin
- agent 配置必须先在 `prepareEnvironment` 落盘或注入完成，才能进入 `startInstance`

#### 远端 node

```text
engine-node
  -> registerNode(engineTypes=["opencode","cc"])
  -> heartbeat

User/API
  -> Backend Service
  -> choose nodeId
  -> build AgentLaunchSpec
  -> Core
  -> validate nodeId
  -> dispatch prepareEnvironment(launchSpec)
  -> dispatch startInstance(preparedEnvironment)
  -> dispatch connectRelay
  -> remote node routes command to plugin runtime
```

说明：

- 远端 node 必须遵守和本地相同的生命周期约束，不能跳过 `prepareEnvironment` 直接启动实例
- 如果远端协议需要拆分请求体，`prepareEnvironment` 的结果需要返回可被后续 `startInstance` 引用的 prepared handle 或标准化环境摘要

### 代码组织

推荐目录：

```text
packages/
  core/
  plugin-sdk/
  plugin-opencode/
  plugin-cc/
  engine-node/
```

职责分配：

- `plugin-sdk`：只放接口和共享类型
- `core`：放 registry、runtime orchestrator、remote dispatcher
- `plugin-opencode` / `plugin-cc`：放 engine 私有实现
- `engine-node`：通用远端 node host，加载多个 engine plugins

本地执行逻辑放在对应 plugin 包中，例如：

```text
packages/plugin-opencode/src/
  nodes/local-opencode-node.ts
  runtime/
  relay/
  plugin.ts
```

## 实现要点

- 先收口 `plugin-sdk`，统一 `EnginePlugin -> createRuntime()`、`EngineRuntime`、`AgentLaunchSpec`、`PreparedEnvironment` 这些核心接口名。
- 明确 `prepareEnvironment(input + launchSpec) -> preparedEnvironment`，以及 `startInstance(input + preparedEnvironment)`，避免启动阶段重复做配置拼装。
- `core` 只做 node 校验，不做 node 选择。后台服务负责 placement。
- 远端协议与 `plugin-sdk` 分离，避免本地 runtime 接口被远端接入细节污染。
- `plugin-opencode` 作为第一批落地实现，优先复用现有本地进程管理和 relay 逻辑，验证接口是否足够稳定。

## 迁移建议

1. 先收口 `plugin-sdk`
   - 统一 `AgentLaunchSpec`
   - 统一 `prepareEnvironment -> startInstance` 生命周期
   - 删除旧的 runtime spec 命名和混合语义

2. 在 `core` 增加 node 调度相关模块
   - `RuntimeRegistry`
   - `NodeRegistry`
   - `RemoteCommandDispatcher`
   - `RuntimeOrchestrator`

3. 让 `plugin-opencode` 先跑通
   - 复用现有本地进程管理
   - 对齐新的 runtime 接口

4. 新增 `engine-node`
   - 作为远端通用 host
   - 先加载 `plugin-opencode`
   - 后续再接入 `plugin-cc`

## 验收标准

- [ ] `core` 可以统一调度本地和远端 node
- [ ] 后台服务负责组装 `AgentLaunchSpec`，`core` 不管理业务实体
- [ ] `AgentLaunchSpec` 在 `prepareEnvironment` 阶段注入，`startInstance` 只能运行已准备好的环境
- [ ] `plugin-sdk` 只承载 engine 适配接口，不承载远端接入协议
- [ ] 远端采用通用 `engine-node` 加载多个 engine plugins
