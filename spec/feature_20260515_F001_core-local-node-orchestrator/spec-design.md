# Feature: 20260515_F001 - core-local-node-orchestrator

## 需求背景

`plugin-sdk` 的生命周期接口已经收口，`plugin-opencode` 也已经能独立完成本地 runtime 的环境准备、实例启停和 relay 连接。但当前仓库里还缺少真正承接这些能力的 `core` 层：

- `packages/core` 目前基本还是空壳，没有 node registry、plugin registry、orchestrator 和统一状态模型
- `plugin-opencode` 只能被直接调用，尚未经过 `core` 编排，无法验证“平台服务只组装 `AgentLaunchSpec`，`core` 负责调度”的目标边界
- 如果不先把本地 `node` 场景在 `core` 内跑通，后续远端 node / remote host 设计会缺少一个稳定基线

结合前两份设计文档，本阶段不再继续扩展 `plugin-sdk`，也不改 `src` 接入层，而是单独完成 `packages/core` 的第一轮可运行实现，让 `core` 先支持“本地 node + 单 engine plugin”的最小闭环，并配套完成单元测试。

## 目标

- 让 `packages/core` 具备最小可用的本地 node 调度能力。
- 明确 `core` 内部第一批稳定模块：plugin registry、node registry、instance orchestrator、runtime state store。
- 让 `core` 可以基于 `instanceId + AgentLaunchSpec + engineType` 驱动一次 `prepare -> start -> relay -> stop` 生命周期。
- 先只支持 `mode = local` 的 node，不在本轮实现 remote RPC、心跳和跨机调度。
- 先只验证 `plugin-opencode` 这一个真实 engine plugin，但 `core` 的接口设计不能写死为 opencode 专用。
- 本轮不改 `src/services/instance.ts`、`src/transport/acp-relay-handler.ts` 或任何旧接入逻辑，只交付 `packages/core` 本身及其测试。

## 方案设计

### 一、推荐方案

本轮采用“最小 core 编排内核 + 显式 registry + 内存态运行状态 + 单元测试先行”的方案。

推荐原因：

- 与 `20260514_F001_engine-plugin-architecture` 中“后台服务选择 node，core 统一编排生命周期”的方向一致
- 能直接消费 `plugin-sdk` 和 `plugin-opencode` 现有接口，不需要先倒逼插件层重构
- 不碰 `src` 接入层，风险更可控，也方便后续分阶段迁移

不采用的方案：

- 方案 B：先在 `src/services/instance.ts` 外面包一层假 core
  - 缺点是 `core` 仍然没有独立运行价值，后续还要再拆一遍
- 方案 C：直接把 remote node 一起设计和实现
  - 缺点是本轮问题域会被放大，难以确认 core 本地编排本身是否成立

### 二、范围边界

本 feature 只解决 `packages/core` 的本地编排闭环，不在这一轮完成：

- `src` 旧服务层接入与迁移
- 远端 node 注册、心跳、RPC 和事件回传
- 多 node 调度策略，如容量打分、亲和性、自动重试
- 数据库存储、持久化状态回放
- 多 engine 组合测试之外的真实联调接入

本轮完成后的预期结果是：

- `packages/core` 可以注册一个或多个 engine plugin
- `packages/core` 可以注册一个本地 node，并校验该 node 是否支持目标 `engineType`
- 上层传入 `LaunchInstanceRequest` 后，`core` 可以驱动一次完整生命周期
- 生命周期状态、relay handle 和错误信息都能通过统一模型暴露给调用方
- `packages/core` 除单元测试外，还提供一个可手动执行的 integration 入口，便于验证真实 plugin 联调链路

### 三、核心分层

#### 3.1 Core 对外职责

`core` 对上层暴露的是“运行时编排能力”，而不是插件实现细节。

它负责：

- 管理 engine plugin 注册表
- 管理可调度 node 注册表
- 校验 engineType 与 node capability 是否匹配
- 编排 `prepare -> start -> connectRelay -> stop`
- 维护统一的实例运行时状态
- 对调用方返回稳定的查询和控制接口

它不负责：

- 组装业务侧 `AgentLaunchSpec`
- 决定数据库里的 environment / session / instance 真相
- 落盘 provider 私有配置
- 处理 remote node 通信协议

#### 3.2 与 plugin-sdk 的边界

`core` 只能依赖 `@mothership/plugin-sdk` 的稳定接口：

- `EnginePlugin`
- `EngineRuntime`
- `AgentLaunchSpec`
- `EngineRelayHandle`

`core` 不允许依赖 `plugin-opencode` 的私有模块路径，也不读取其内部状态结构。

#### 3.3 与 plugin-opencode 的边界

对 `core` 来说，`plugin-opencode` 只是一个 `engineType = "opencode"` 的实现。

`core` 可以知道：

- 该插件的 `meta.id`
- 该插件能创建 `EngineRuntime`

`core` 不应该知道：

- `acp-link` 的启动命令格式
- 本地 WS token 捕获方式
- `.opencode/opencode.json` 如何落盘

### 四、核心模块设计

建议 `packages/core/src/` 首批结构如下：

```text
packages/core/src/
  index.ts
  types/
    core-node.ts
    runtime-instance.ts
    launch-request.ts
  registry/
    engine-plugin-registry.ts
    core-node-registry.ts
  runtime/
    runtime-instance-store.ts
    instance-orchestrator.ts
  facade/
    core-runtime.ts
  __tests__/
```

#### 4.1 `EnginePluginRegistry`

职责：

- 注册 `EnginePlugin`
- 按 `engineType` 查询插件
- 拒绝重复注册
- 为 orchestrator 提供只读查找能力

建议接口：

```ts
export interface EnginePluginRegistry {
  register(plugin: EnginePlugin): void;
  get(engineType: string): EnginePlugin | null;
  list(): EnginePlugin[];
}
```

设计要求：

- `meta.id` 作为唯一键
- 重复注册同一 `meta.id` 时抛出明确错误
- 不在 registry 内缓存 runtime 实例，避免把“插件定义”和“实例运行态”混在一起

#### 4.2 `CoreNodeRegistry`

本轮 node 只支持本地模式，但模型仍按未来可扩展方式定义。

```ts
export interface CoreNode {
  id: string;
  mode: "local";
  engineTypes: string[];
  status: "online" | "offline";
  metadata?: Record<string, unknown>;
}
```

职责：

- 注册本地 node
- 查询 node
- 校验 node 是否支持某个 engineType
- 维护 node 在线状态

建议接口：

```ts
export interface CoreNodeRegistry {
  register(node: CoreNode): void;
  get(nodeId: string): CoreNode | null;
  list(): CoreNode[];
  setStatus(nodeId: string, status: "online" | "offline"): void;
  supportsEngine(nodeId: string, engineType: string): boolean;
}
```

设计要求：

- 本轮允许只存在一个默认本地 node，例如 `local-default`
- 但接口不能写死单例，后续扩到多本地 node 或 remote node 时不用重做

#### 4.3 `RuntimeInstanceStore`

`core` 需要维护自己的一份运行态快照，用来表达编排视角下的实例状态，而不是插件内部私有状态。

```ts
export type RuntimeInstanceStatus =
  | "created"
  | "preparing"
  | "prepared"
  | "starting"
  | "running"
  | "stopping"
  | "stopped"
  | "error";

export interface RuntimeInstanceRecord {
  instanceId: string;
  engineType: string;
  nodeId: string;
  status: RuntimeInstanceStatus;
  launchSpec: AgentLaunchSpec;
  relayConnected: boolean;
  errorMessage?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

说明：

- 这份状态是 `core` 编排层的 truth，不等于 plugin 内部 runtime state
- `launchSpec` 在本轮可以直接缓存在内存中，方便 stop/reconnect/query 时读取
- `relayConnected` 是编排层状态，不要求插件暴露底层 WS 细节

#### 4.4 `InstanceOrchestrator`

这是本 feature 的核心模块，负责把 registry、store 和 plugin runtime 串起来。

建议接口：

```ts
export interface LaunchInstanceRequest {
  instanceId: string;
  engineType: string;
  nodeId: string;
  launchSpec: AgentLaunchSpec;
}

export interface InstanceOrchestrator {
  launch(request: LaunchInstanceRequest): Promise<RuntimeInstanceRecord>;
  connectRelay(input: { instanceId: string; sessionId?: string }): Promise<EngineRelayHandle>;
  stop(instanceId: string): Promise<void>;
  get(instanceId: string): RuntimeInstanceRecord | null;
  list(): RuntimeInstanceRecord[];
}
```

核心流程：

1. 校验 `instanceId` 未重复
2. 从 `EnginePluginRegistry` 取出目标插件
3. 从 `CoreNodeRegistry` 校验 node 在线且支持该 `engineType`
4. 创建该实例专属的 `EngineRuntime`
5. 更新 store 状态为 `preparing`
6. 调用 `runtime.prepareEnvironment()`
7. 更新 store 状态为 `prepared`
8. 更新 store 状态为 `starting`
9. 调用 `runtime.startInstance()`
10. 更新 store 状态为 `running`

设计约束：

- 本轮采用“一次 launch 对应一个 runtime 实例”的模型，避免多个运行实例共享同一个 runtime 对象
- runtime 句柄需要由 orchestrator 内部缓存，以便后续 `connectRelay()` 和 `stop()` 复用
- 任一步骤失败时，store 必须转成 `error`，并记录 `errorMessage`

### 五、Facade 设计

为避免上层直接操作多个 registry/store/orchestrator，`core` 应提供一个轻量 facade，例如 `createCoreRuntime()`。

建议接口：

```ts
export interface CoreRuntime {
  registerPlugin(plugin: EnginePlugin): void;
  registerNode(node: CoreNode): void;

  launchInstance(request: LaunchInstanceRequest): Promise<RuntimeInstanceRecord>;
  connectInstanceRelay(input: {
    instanceId: string;
    sessionId?: string;
  }): Promise<EngineRelayHandle>;
  stopInstance(instanceId: string): Promise<void>;

  getInstance(instanceId: string): RuntimeInstanceRecord | null;
  listInstances(): RuntimeInstanceRecord[];
  listPlugins(): EnginePlugin[];
  listNodes(): CoreNode[];
}
```

这样后续无论是 `src` 旧层适配，还是新 server 接入，都只需要依赖这个 facade。

### 六、错误模型与行为约定

本轮不需要引入复杂错误继承体系，但要统一几类明确错误：

- `PLUGIN_NOT_FOUND`
- `NODE_NOT_FOUND`
- `NODE_OFFLINE`
- `ENGINE_NOT_SUPPORTED`
- `INSTANCE_ALREADY_EXISTS`
- `INSTANCE_NOT_FOUND`
- `INVALID_INSTANCE_STATE`

行为约定：

- `launchInstance()` 失败后保留实例记录，状态为 `error`
- `connectInstanceRelay()` 仅允许 `running` 状态调用
- `stopInstance()` 对已 `stopped` 的实例幂等返回
- `stopInstance()` 对不存在实例返回 `INSTANCE_NOT_FOUND`

### 七、本地 node 运行模式

本轮只支持由 `core` 直接发起调度的本地 node，因此不需要 remote transport。

推荐默认模式：

- 在测试和本地开发中，先注册一个 `local-default` node
- `engineTypes` 至少包含 `"opencode"`
- orchestrator 在启动实例时不区分“发给 node”还是“直接调用 plugin”，本轮统一由本地 node 直接承接

这样做的意义是：

- 对外 API 已经具备 node 这一层抽象
- 内部实现仍保持最小路径，避免为了 future remote 提前引入 RPC 复杂度

### 八、测试策略

本轮以 `packages/core` 单元测试为主，重点验证编排语义，不依赖真实子进程或真实 WebSocket。

建议测试分层如下：

- `engine-plugin-registry.test.ts`
  - 注册成功
  - 重复注册报错
  - 未注册插件查询返回 `null`

- `core-node-registry.test.ts`
  - 本地 node 注册与查询
  - 在线状态切换
  - engine capability 校验

- `runtime-instance-store.test.ts`
  - 创建、更新、查询状态
  - 错误状态写入

- `instance-orchestrator.test.ts`
  - `launch()` 成功串通 `prepare -> start`
  - `connectRelay()` 仅在 `running` 状态成功
  - `stop()` 串通插件 runtime，并正确更新状态
  - plugin 缺失、node 离线、engine 不支持、重复 instanceId、plugin 抛错等异常路径

- `core-runtime.test.ts`
  - facade 注册插件和 node 后可直接完成一次完整流程

测试实现建议：

- 在 `packages/core/src/__tests__/fixtures/` 下提供一个 fake engine plugin
- fake runtime 通过内存数组记录调用顺序，用来断言 orchestrator 生命周期是否按预期执行
- relay handle 使用最小 stub 实现，不依赖真实网络

### 九、Integration 测试入口

除了单元测试，本轮还需要像 `packages/plugin-opencode/integration/` 一样，为 `packages/core` 提供一个真实链路 integration 入口，方便手动验证“core 编排 + 真实 plugin”是否跑通。

建议目录结构：

```text
packages/core/
  integration/
    .gitignore
    core-runtime.conf.json
    core-runtime.local.json
    core-runtime.integration.test.ts
    README.md
```

#### 9.1 目标定位

这组 integration 测试不是为了替代单元测试，而是用于手动验证以下真实链路：

- 注册 `plugin-opencode`
- 注册本地 `local-default` node
- 通过 `core.launchInstance()` 驱动 `prepare -> start`
- 通过 `core.connectInstanceRelay()` 建立真实 relay
- 通过 relay 发送 `connect -> new_session -> prompt`
- 收到期望的 agent 响应后，再通过 `core.stopInstance()` 清理实例

#### 9.2 配置约定

配置方式尽量复用 `plugin-opencode/integration` 的约定：

- `core-runtime.conf.json`
  - 可提交模板
  - 只保留占位值和默认配置
- `core-runtime.local.json`
  - 本地私有配置
  - 写入真实 workspace、模型参数、密钥和成功匹配条件
  - 加入 `.gitignore`

建议配置结构：

```ts
interface CoreIntegrationConfig {
  enabled: boolean;
  instanceId?: string;
  nodeId?: string;
  engineType: string;
  launchTimeoutMs?: number;
  relayReadyDelayMs?: number;
  responseTimeoutMs?: number;
  launchSpec: AgentLaunchSpec;
  relay: {
    requestMessages: Record<string, unknown>[];
    successMatch: {
      type?: string;
      sessionUpdate?: string;
      rawIncludes?: string;
    };
  };
}
```

其中：

- `engineType` 本轮默认写 `"opencode"`
- `nodeId` 本轮默认写 `"local-default"`
- `launchSpec` 和 `relay` 结构尽量与 `plugin-opencode` integration 配置保持一致，减少维护两套模板的心智负担

#### 9.3 Integration 用例行为

`core-runtime.integration.test.ts` 建议执行以下流程：

1. 读取 `core-runtime.local.json`，未启用则直接跳过
2. 创建 `core runtime facade`
3. 注册 `plugin-opencode`
4. 注册一个 `local-default` 本地 node，声明支持 `"opencode"`
5. 调用 `launchInstance()`
6. 等待短暂 ready delay 后调用 `connectInstanceRelay()`
7. 按顺序发送 `connect -> new_session -> prompt`
8. 监听 relay 消息直到匹配 `successMatch`
9. 调用 `stopInstance()` 清理实例

成功判定建议与 `plugin-opencode` 版本一致，默认以：

- `type = "session_update"`
- `sessionUpdate = "agent_message_chunk"`

作为最小成功信号。

#### 9.4 日志与排错

integration 测试需要输出阶段日志，便于判断问题卡在哪一层。推荐阶段名如下：

- `registerPlugin:start/ok/error`
- `registerNode:start/ok/error`
- `launchInstance:start/ok/error`
- `connectRelay:start/ok/error`
- `waitForConnectedStatus:start/ok/error`
- `waitForSessionCreated:start/ok/error`
- `waitForExpectedResponse:start/ok/error`
- `stopInstance:start/ok/error`

如果最终超时，至少输出：

- 当前 `successMatch`
- 最后一条收到的 relay 消息
- 当前实例状态快照

这样可以快速判断是：

- `core` 编排状态没推进到 `running`
- relay 没接起来
- 真实 plugin 启动成功但消息匹配条件写错

#### 9.5 与单元测试的边界

这组 integration 入口只用于手动真实验证，因此：

- 默认 `enabled = false`
- 不纳入常规 CI 必跑集
- 允许依赖真实 `plugin-opencode`、真实 workspace 和真实模型密钥
- 但测试文件本身仍应保持可提交，敏感配置只放在 `.local.json`

## 实现要点

- `core` 内部要区分三类对象：插件定义、插件 runtime、实例运行态，不能混成一个 map。
- `launchInstance()` 成功后需要同时缓存 `RuntimeInstanceRecord` 和 `EngineRuntime`，后者仅供 orchestrator 内部复用。
- 为了让测试稳定，store 和 orchestrator 的时间戳建议通过可注入 `now()` 函数生成，而不是直接散落调用 `new Date()`。
- `packages/core/src/index.ts` 只导出 facade、registry、核心类型和必要测试友好的工厂，不暴露内部私有缓存实现。
- 这轮不做并发调度优化，但需要避免明显的状态污染，例如同一个 `instanceId` 被重复 launch。
- 与 `20260514_F002_plugin-opencode-runtime` 的接口对接必须严格停留在 `plugin-sdk` 公共接口层。

## 验收标准

- [ ] `packages/core` 新增 plugin registry、node registry、runtime instance store、instance orchestrator 和 facade 的最小实现。
- [ ] `core` 可以注册 `plugin-opencode` 这类 engine plugin，但代码层不依赖其私有实现细节。
- [ ] `core` 可以在本地 node 上完成一次 `prepare -> start -> connectRelay -> stop` 的完整编排闭环。
- [ ] `connectInstanceRelay()` 只允许在实例 `running` 时执行，错误路径返回明确错误。
- [ ] `stopInstance()` 具备幂等行为，并能把实例状态更新为 `stopped`。
- [ ] `packages/core` 具备完整单元测试，覆盖注册表、store、orchestrator 和 facade 的成功/失败路径。
- [ ] `packages/core` 提供 `integration/` 目录下的手动真实链路测试入口，配置方式与 `plugin-opencode` integration 保持一致。
- [ ] 本轮不修改 `src` 目录中的旧接入代码，`packages/core` 可独立通过类型检查和测试。
