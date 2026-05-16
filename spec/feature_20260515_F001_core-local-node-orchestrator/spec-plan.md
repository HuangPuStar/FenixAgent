# core-local-node-orchestrator 执行计划

**目标:** 为 `packages/core` 落地最小可运行的本地 node 编排内核，完成 `plugin registry + node registry + runtime instance store + orchestrator + facade` 闭环，并提供单元测试与手动 integration 入口。

**技术栈:** Bun、TypeScript、workspace package、`@mothership/plugin-sdk`、`@mothership/opencode`

**设计文档:** `spec/feature_20260515_F001_core-local-node-orchestrator/spec-design.md`

---

## 改动总览

本次改动集中在 `packages/core/src` 的四层结构：`types/errors/registry` 先固化编排契约，`runtime` 承接状态与生命周期，`facade` 负责对外装配，`integration` 提供真实 plugin 手动联调入口。
Task 1 先定义核心类型、错误模型和双注册表；Task 2 在这些契约上补齐运行态 store 与 fake plugin 夹具；Task 3 复用前两步的契约实现生命周期 orchestrator；Task 4 再把 orchestrator 包装成 `createCoreRuntime()` 并建立受控导出面与 integration 目录。
经代码分析确认，当前 `packages/core` 只有 `package.json` 和 `tsconfig.json`，`src/` 与 `integration/` 都不存在，因此本计划以新增文件为主，不需要迁移旧实现或兼容历史调用点。
关键设计决策是把插件定义、插件 runtime、实例运行态拆成三层对象：`EnginePluginRegistry` 只管插件定义，`RuntimeInstanceStore` 只管编排态与 runtime 缓存，`InstanceOrchestrator` 只管生命周期推进，避免把 `plugin-opencode` 内部状态模型泄漏到 `core`。

---

### Task 0: 环境准备

**背景:**
本 feature 只交付 `packages/core` 及其测试，不改 `src/` 旧接入层，因此先确认 Bun 测试器、TypeScript 配置解析和 workspace 包脚本在当前仓库内可直接使用。
经代码确认，根目录 `package.json` 已声明 workspace，`packages/core/package.json` 已具备 `build`、`typecheck`、`test` 脚本，前端构建与数据库都不是本轮前置依赖。

**执行步骤:**
- [x] 验证 Bun 与 workspace 测试命令可用
  - 位置: 仓库根目录 `/Users/liyuan/Work/mothership-beta_new`
  - 执行 `bun --version` 确认运行时存在，再执行 `bun test --help >/dev/null` 确认测试器可启动
  - 原因: 后续四个 Task 的单元测试与 integration 入口都依赖 Bun 提供的测试执行器
- [x] 验证 `packages/core` 的 TypeScript 配置可被解析
  - 位置: `packages/core/tsconfig.json`
  - 执行 `bunx tsc -p packages/core/tsconfig.json --showConfig >/dev/null`，确认 `extends ../../tsconfig.base.json`、路径别名和 `types: ["bun"]` 可正常解析
  - 原因: `packages/core/src` 当前尚未创建，使用 `--showConfig` 可以在实现前验证编译配置链路，而不会因为暂时没有输入文件报错

**检查步骤:**
- [x] 检查 Bun 可用
  - `cd /Users/liyuan/Work/mothership-beta_new && bun --version`
  - 预期: 输出 Bun 版本号，不报 `command not found`
- [x] 检查测试器可用
  - `cd /Users/liyuan/Work/mothership-beta_new && bun test --help >/dev/null`
  - 预期: 命令返回成功退出码，无测试框架初始化错误
- [x] 检查 `packages/core` 的 TypeScript 配置可解析
  - `cd /Users/liyuan/Work/mothership-beta_new && bunx tsc -p packages/core/tsconfig.json --showConfig >/dev/null`
  - 预期: 命令返回成功退出码，无 `Cannot find tsconfig` 或路径别名解析错误

---

### Task 1: 核心类型与注册表


**背景:**
`packages/core` 当前只有包级配置文件，尚未建立 `src/`、稳定类型和注册表实现，`plugin-opencode` 也还没有通过 `core` 暴露统一编排入口。
经代码分析确认，`packages/plugin-sdk/src/engine-plugin.ts` 中 `EnginePlugin.meta.id` 是仓库内唯一稳定的 engine key，仓库中不存在可复用的 `EnginePluginRegistry`、`CoreNodeRegistry` 和 `CoreRuntimeError` 实现。
本 Task 先固化本地 node 编排的类型边界、错误模型与双注册表，让 Task 2 的运行态 store 和 Task 3 的 orchestrator 直接建立在稳定契约之上。

**涉及文件:**
- 新建: `packages/core/src/types/core-node.ts`
- 新建: `packages/core/src/types/runtime-instance.ts`
- 新建: `packages/core/src/types/launch-request.ts`
- 新建: `packages/core/src/errors/core-runtime-error.ts`
- 新建: `packages/core/src/registry/engine-plugin-registry.ts`
- 新建: `packages/core/src/registry/core-node-registry.ts`
- 新建: `packages/core/src/__tests__/engine-plugin-registry.test.ts`
- 新建: `packages/core/src/__tests__/core-node-registry.test.ts`

**执行步骤:**
- [x] 在 `packages/core/src/types/core-node.ts` 定义本地 node 稳定类型
  - 位置: 新文件，文件顶部先写模块级文档注释，随后定义并导出类型
  - 写入 `CoreNodeMode = "local"`、`CoreNodeStatus = "online" | "offline"`、`CoreNode` 接口，字段固定为 `id`、`mode`、`engineTypes`、`status`、`metadata?`
  - 追加 `CreateCoreNodeInput` 类型，结构与 `CoreNode` 对齐但保留只读输入语义，供注册表在 `register()` 中接收
  - 原因: node 模型是 orchestrator 校验 node 可调度性的唯一来源，Task 3 直接依赖这里的状态和值域
- [x] 在 `packages/core/src/types/runtime-instance.ts` 建立编排层运行态记录模型
  - 位置: 新文件顶部引入 `AgentLaunchSpec`，随后定义状态枚举和记录接口
  - 写入 `RuntimeInstanceStatus = "created" | "preparing" | "prepared" | "starting" | "running" | "stopping" | "stopped" | "error"`，以及 `RuntimeInstanceRecord` 接口，字段固定为 `instanceId`、`engineType`、`nodeId`、`status`、`launchSpec`、`relayConnected`、`errorMessage?`、`createdAt`、`updatedAt`
  - 同文件补 `RuntimeInstanceSnapshot` 类型，使用 `Readonly<RuntimeInstanceRecord>` 包装记录，作为 registry/store/orchestrator 对外返回的统一视图
  - 原因: `plugin-opencode` 已有自己的 `RuntimeInstanceState`，`core` 需要独立的编排层 truth，避免直接复用插件内部状态结构
- [x] 在 `packages/core/src/types/launch-request.ts` 定义 launch 与 relay 请求类型
  - 位置: 新文件顶部引入 `AgentLaunchSpec`，中部定义请求接口，尾部导出最小查询参数类型
  - 写入 `LaunchInstanceRequest` 接口，字段固定为 `instanceId`、`engineType`、`nodeId`、`launchSpec`
  - 写入 `ConnectInstanceRelayRequest` 接口，字段固定为 `instanceId`、`sessionId?`
  - 追加 `StopInstanceRequest` 类型，字段固定为 `instanceId`，供 orchestrator 和 facade 后续共用
  - 原因: 设计文档已把 `launch`、`connectRelay`、`stop` 的输入边界固定下来，Task 3 和 Task 4 需要直接复用这些类型
- [x] 在 `packages/core/src/errors/core-runtime-error.ts` 实现稳定错误模型
  - 位置: 新文件顶部定义错误码类型，随后实现错误类与辅助函数
  - 定义 `CoreRuntimeErrorCode` 字面量联合，至少包含 `DUPLICATE_ENGINE_PLUGIN`、`PLUGIN_NOT_FOUND`、`DUPLICATE_CORE_NODE`、`NODE_NOT_FOUND`、`NODE_OFFLINE`、`ENGINE_NOT_SUPPORTED`、`INSTANCE_ALREADY_EXISTS`、`INSTANCE_NOT_FOUND`、`INVALID_INSTANCE_STATE`
  - 实现 `CoreRuntimeError extends Error`，公开字段固定为 `code`、`details?`，构造函数签名写成 `(code: CoreRuntimeErrorCode, message: string, details?: Record<string, unknown>)`
  - 在文件尾部追加 `isCoreRuntimeError(error: unknown): error is CoreRuntimeError` 和 `createCoreRuntimeError(...)` 辅助函数，统一后续抛错入口
  - 原因: 当前仓库里的实例相关错误大多直接 `throw new Error(...)`，`packages/core` 需要先确立可断言的具名错误，测试和 orchestrator 异常路径才能稳定落地
- [x] 在 `packages/core/src/registry/engine-plugin-registry.ts` 实现 engine plugin 注册表
  - 位置: 新文件顶部引入 `EnginePlugin` 与 `CoreRuntimeError`，中部实现 `EnginePluginRegistry` 类，底部导出只读接口类型
  - 用私有 `Map<string, EnginePlugin>` 保存注册结果，key 固定取 `plugin.meta.id`；`register(plugin)` 在写入前校验重复 key，命中时抛出 `CoreRuntimeError` 且 `code` 为 `DUPLICATE_ENGINE_PLUGIN`
  - 实现 `get(engineType)` 返回 `EnginePlugin | null`，`require(engineType)` 在缺失时抛出 `PLUGIN_NOT_FOUND`，`list()` 返回按注册顺序复制出的数组，`has(engineType)` 返回布尔值
  - 给 `register()` 增加 `return plugin` 返回值，让 Task 4 facade 在链式初始化时直接复用注册结果
  - 原因: 经代码确认 `meta.id` 是当前唯一稳定 engine key，registry 必须围绕它建立确定行为，不能额外推导别名
- [x] 在 `packages/core/src/registry/core-node-registry.ts` 实现本地 node 注册表
  - 位置: 新文件顶部引入 `CoreNode` 相关类型与 `CoreRuntimeError`，中部实现 `CoreNodeRegistry` 类，底部导出只读接口类型
  - 用私有 `Map<string, CoreNode>` 保存节点；`register(input)` 将 `engineTypes` 规范化为去重后的数组并复制 `metadata`，重复 `id` 直接抛出 `DUPLICATE_CORE_NODE`
  - 实现 `get(nodeId)` 返回 `CoreNode | null`，`require(nodeId)` 在缺失时抛出 `NODE_NOT_FOUND`，`list()` 返回节点副本数组，`setStatus(nodeId, status)` 在原节点基础上覆写状态并回写 Map
  - 实现 `supportsEngine(nodeId, engineType)`：先通过 `require(nodeId)` 取节点，再基于 `engineTypes.includes(engineType)` 返回布尔值；该方法不夹带在线状态判断，在线校验留给 orchestrator
  - 原因: node registry 负责声明能力和状态，不混入生命周期编排逻辑，Task 3 可以直接用 `require()`、`supportsEngine()` 组合出明确错误路径
- [x] 为 `EnginePluginRegistry` 与 `CoreNodeRegistry` 编写单元测试
  - 测试文件: `packages/core/src/__tests__/engine-plugin-registry.test.ts`、`packages/core/src/__tests__/core-node-registry.test.ts`
  - 测试场景:
    - `EnginePluginRegistry`: 注册 `meta.id = "opencode"` 的 fake plugin 后，`get()`、`require()`、`has()`、`list()` 返回一致结果
    - `EnginePluginRegistry`: 重复注册同一 `meta.id` 抛出 `CoreRuntimeError`，`code` 为 `DUPLICATE_ENGINE_PLUGIN`
    - `EnginePluginRegistry`: 查询未注册 engine 返回 `null`，`require()` 抛出 `PLUGIN_NOT_FOUND`
    - `CoreNodeRegistry`: 注册 `local-default` 后，`get()`、`require()`、`list()` 返回复制后的节点数据，`engineTypes` 保持去重
    - `CoreNodeRegistry`: `setStatus("local-default", "offline")` 更新状态后，`get()` 返回 `offline`
    - `CoreNodeRegistry`: `supportsEngine("local-default", "opencode")` 返回 `true`，查询不存在 node 抛出 `NODE_NOT_FOUND`
    - `CoreNodeRegistry`: 重复注册同一 `id` 抛出 `CoreRuntimeError`，`code` 为 `DUPLICATE_CORE_NODE`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/engine-plugin-registry.test.ts packages/core/src/__tests__/core-node-registry.test.ts`
  - 预期: 两个测试文件全部通过，断言覆盖注册成功、重复注册、缺失查询、状态更新与 capability 校验

**检查步骤:**
- [x] 检查 Task 1 的类型与注册表文件已创建
  - `cd /Users/liyuan/Work/mothership-beta_new && find packages/core/src -maxdepth 2 -type f | sort`
  - 预期: 输出包含 `types/`、`errors/`、`registry/` 和 `__tests__/` 下的全部 Task 1 文件
- [x] 检查错误码与注册表方法签名已落地
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "DUPLICATE_ENGINE_PLUGIN|PLUGIN_NOT_FOUND|class EnginePluginRegistry|class CoreNodeRegistry|supportsEngine\\(" packages/core/src`
  - 预期: 输出 `core-runtime-error.ts`、`engine-plugin-registry.ts`、`core-node-registry.ts` 中对应定义
- [x] 检查 `meta.id` 仍是 engine plugin 的唯一稳定 key
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "meta\\.id" packages/plugin-sdk packages/plugin-opencode packages/core`
  - 预期: `plugin-sdk` 暴露 `meta.id`，`plugin-opencode` 固定返回 `id: \"opencode\"`，`packages/core` 的 engine registry 以该字段作为 Map key
- [x] 检查本 Task 单元测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/engine-plugin-registry.test.ts packages/core/src/__tests__/core-node-registry.test.ts`
  - 预期: 两个测试文件全部通过，无类型错误和断言失败

---

### Task 2: 运行态 store 与测试夹具

**背景:**
Task 1 已经把 `RuntimeInstanceRecord`、`LaunchInstanceRequest` 和 `CoreRuntimeError` 的边界固定下来，但 `packages/core` 仍缺少真正承接生命周期状态推进的内存 store，Task 3 的 orchestrator 还没有可复用的状态真相来源。
经代码分析确认，`packages/plugin-opencode/src/runtime/opencode-runtime.ts` 当前只在插件内部用 `Map<string, RuntimeInstanceState>` 保存私有状态，仓库里不存在 `RuntimeInstanceStore`、`FakeEnginePlugin` 或可注入 `now()` 时间源实现。
本 Task 先补齐编排层 store、测试夹具和时间注入约定，让 Task 3 可以专注串接 registry、runtime cache 与错误路径，而不再自行拼装测试替身或散落写时间戳。

**涉及文件:**
- 新建: `packages/core/src/runtime/runtime-instance-store.ts`
- 新建: `packages/core/src/__tests__/runtime-instance-store.test.ts`
- 新建: `packages/core/src/__tests__/fixtures/fake-engine-plugin.ts`

**执行步骤:**
- [x] 在 `packages/core/src/runtime/runtime-instance-store.ts` 实现编排层实例 store 的公共接口与默认工厂
  - 位置: 新文件顶部先引入 `AgentLaunchSpec`、`EnginePlugin`、`EngineRuntime`、`EngineRelayHandle`、`RuntimeInstanceRecord`、`RuntimeInstanceSnapshot`、`RuntimeInstanceStatus` 与 `CoreRuntimeError`
  - 先定义并导出 `RuntimeClock = () => Date`、`RuntimeInstanceRuntimeEntry`、`CreateRuntimeInstanceRecordInput`、`UpdateRuntimeInstanceRecordInput`、`RuntimeInstanceStore` 接口和 `createRuntimeInstanceStore(options?: { now?: RuntimeClock })` 工厂函数
  - `RuntimeInstanceRuntimeEntry` 固定包含 `plugin: EnginePlugin`、`runtime: EngineRuntime`、`relay: EngineRelayHandle | null`，把插件定义、运行时实例和 relay 缓存与 Task 1 的 `RuntimeInstanceRecord` 明确分层，避免 orchestrator 在多个 Map 中重复维护同一份索引
  - 原因: Task 3 需要一个既能管理状态快照、又能缓存 `plugin.createRuntime()` 结果的最小持久面，接口必须先稳定下来
- [x] 在 `createRuntimeInstanceStore()` 中实现记录创建、快照返回和重复实例保护
  - 位置: `packages/core/src/runtime/runtime-instance-store.ts` 的工厂函数内部，使用私有 `Map<string, RuntimeInstanceRecord>` 与 `Map<string, RuntimeInstanceRuntimeEntry>` 保存状态和 runtime 缓存
  - 实现 `create(input)`：拒绝重复 `instanceId`，命中时抛出 `createCoreRuntimeError("INSTANCE_ALREADY_EXISTS", ...)`；写入的初始记录固定为 `status: "created"`、`relayConnected: false`、`errorMessage: undefined`，`createdAt` 与 `updatedAt` 都取 `options.now?.() ?? new Date()` 的单次结果，`launchSpec` 与可能的 `runtimeEntry` 都保存副本
  - 实现 `get(instanceId)`、`require(instanceId)`、`list()` 和内部 `toSnapshot(record)`，返回值统一复制对象与时间字段，禁止把内部可变引用直接暴露给测试或后续 orchestrator
  - 原因: `plugin-opencode` 的 `getInstanceState()` 直接返回内部对象引用，`core` 层需要更强的只读快照语义来避免测试和业务代码误改 store 内部状态
- [x] 在 `packages/core/src/runtime/runtime-instance-store.ts` 实现状态推进、错误写入和 runtime 缓存访问方法
  - 位置: 同文件 `create()` 相关方法之后，按 `update -> attachRuntime -> getRuntimeEntry -> setRelay -> clearRelay -> delete` 顺序追加
  - 实现 `update(instanceId, input)`：基于已存在记录覆写 `status`、`relayConnected`、`errorMessage` 等显式字段，未传字段保持原值，`updatedAt` 每次都使用最新 `now()`；当 `status !== "error"` 时强制清空 `errorMessage`，确保错误态只由最新一次失败写入决定
  - 实现 `attachRuntime(instanceId, runtimeEntry)` 和 `getRuntimeEntry(instanceId)`：前者把 `plugin/runtime/relay` 缓存绑定到实例，后者返回 `{ ...entry, relay }` 风格的副本；实现 `setRelay(instanceId, relay)` 时同时把记录的 `relayConnected` 置为 `true` 并刷新 `updatedAt`，实现 `clearRelay(instanceId)` 时把缓存 relay 置空并把 `relayConnected` 置为 `false`
  - 实现 `delete(instanceId)`：同时删除记录和 runtime 缓存并返回布尔值；保留该方法给 Task 3 的 stop/清理分支复用，不在本 Task 引入额外状态迁移规则
  - 原因: orchestrator 的 `launch/connectRelay/stop` 会反复访问同一实例的 runtime 和 relay，store 需要提供确定的缓存入口，而不是让 orchestrator 自己额外维护 `Map`
- [x] 在 `packages/core/src/__tests__/fixtures/fake-engine-plugin.ts` 建立可复用的 fake plugin、fake runtime 与最小 relay 夹具
  - 位置: 新文件顶部引入 `EnginePlugin`、`EngineRuntime`、`EngineRelayHandle`、`PrepareEnvironmentInput`、`StartInstanceInput`、`StopInstanceInput`、`ConnectRelayInput`
  - 导出 `FakeEngineCall` 联合类型、`FakeEnginePluginOptions`、`FakeEngineRuntimeState`、`FakeRelayHandle`、`createFakeEnginePlugin(options?)`、`createFakeRelayHandle()` 与 `createFakeEngineRuntimeState()`；其中 `createFakeEnginePlugin()` 固定返回 `meta.id = options.engineType ?? "fake-engine"` 的 `EnginePlugin`
  - fake runtime 使用内存数组顺序记录 `prepare:start:stop:connectRelay` 调用，分别缓存最后一次输入参数；`connectRelay()` 复用同一个 relay stub，relay 仅实现 `state`、`send()`、`close()` 和 `sentMessages` 记录，保持与 `packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts` 相同的“最小句柄 + 调用痕迹断言”模式
  - 追加 `failOnPrepare`、`failOnStart`、`failOnConnectRelay`、`failOnStop` 四个注入钩子，每个钩子都直接抛出调用方提供的错误对象，让 Task 3 能稳定覆盖插件异常路径而不依赖真实子进程或 WebSocket
  - 原因: 设计文档要求 orchestrator 单元测试聚焦编排语义，fake plugin 必须一次性提供成功路径、异常路径和调用顺序断言能力
- [x] 为 `RuntimeInstanceStore` 编写单元测试并覆盖时间注入与 runtime 缓存行为
  - 测试文件: `packages/core/src/__tests__/runtime-instance-store.test.ts`
  - 测试场景:
    - 创建记录: `create()` 传入 `instanceId = "inst_store"`、`engineType = "opencode"`、`nodeId = "local-default"`、固定 `launchSpec`、固定 `now()` → 返回 `status = "created"`、`relayConnected = false`，且 `createdAt`、`updatedAt` 等于注入时间
    - 快照隔离: 修改 `get()` 或 `list()` 返回对象上的 `status`、`launchSpec.workspace` → 再次 `get()` 仍保留 store 内部原始值
    - 状态推进: 依次 `update(..., { status: "preparing" })`、`update(..., { status: "error", errorMessage: "boom" })`、`update(..., { status: "running" })` → `updatedAt` 按注入时间递增，且离开 `error` 状态后 `errorMessage` 被清空
    - runtime 缓存: 用 `createFakeEnginePlugin()` 生成 runtime entry，执行 `attachRuntime()`、`setRelay()`、`clearRelay()` → `getRuntimeEntry()` 返回同一 runtime 与 relay 状态变化，记录的 `relayConnected` 与之同步
    - 重复实例保护: 对同一 `instanceId` 连续调用两次 `create()` → 第二次抛出 `CoreRuntimeError` 且 `code = "INSTANCE_ALREADY_EXISTS"`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/runtime-instance-store.test.ts`
  - 预期: 测试文件全部通过，断言覆盖创建、更新时间、错误态清理、快照隔离、runtime 缓存与重复实例错误

**检查步骤:**
- [x] 检查 `RuntimeInstanceStore` 接口、时间注入类型和 runtime 缓存入口已落地
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "RuntimeClock|createRuntimeInstanceStore|attachRuntime|getRuntimeEntry|setRelay|clearRelay" packages/core/src/runtime/runtime-instance-store.ts`
  - 预期: 输出包含时间源类型、store 工厂和 runtime/relay 缓存相关方法定义
- [x] 检查 fake plugin 夹具已提供调用顺序记录和故障注入能力
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "FakeEngineCall|createFakeEnginePlugin|failOnPrepare|failOnStart|failOnConnectRelay|failOnStop|sentMessages" packages/core/src/__tests__/fixtures/fake-engine-plugin.ts`
  - 预期: 输出包含 fake plugin 工厂、四个失败注入钩子和 relay 消息记录字段
- [x] 检查 store 已复用 Task 1 的运行态类型与错误码
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "RuntimeInstanceRecord|RuntimeInstanceStatus|INSTANCE_ALREADY_EXISTS|CoreRuntimeError" packages/core/src/runtime/runtime-instance-store.ts packages/core/src/__tests__/runtime-instance-store.test.ts`
  - 预期: 输出显示 store 与测试直接依赖 Task 1 的类型和错误模型，没有重新定义状态枚举或错误码
- [x] 检查本 Task 单元测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/runtime-instance-store.test.ts`
  - 预期: 测试文件全部通过，无断言失败和类型错误

---

### Task 3: 生命周期 orchestrator

**背景:**
Task 1 已定义 `LaunchInstanceRequest`、`ConnectInstanceRelayRequest`、`CoreRuntimeError` 与双注册表契约，Task 2 已约定 `RuntimeInstanceStore`、runtime cache 和 `createFakeEnginePlugin()` 夹具，但 `packages/core` 仍缺少真正承接生命周期编排的 orchestrator。
经代码分析确认，仓库当前只有 `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 直接暴露 `prepareEnvironment()`、`startInstance()`、`connectRelay()`、`stopInstance()`，`packages/core` 内不存在 `InstanceOrchestrator` 实现，也不存在任何 `launch/connectRelay/stop` 的 core 编排调用层。
本 Task 把 registry、store、runtime cache 和错误模型串成统一入口，直接产出 Task 4 facade 可复用的最小生命周期服务，并把所有失败路径稳定收敛到 `error` 状态。

**涉及文件:**
- 新建: `packages/core/src/runtime/instance-orchestrator.ts`
- 新建: `packages/core/src/__tests__/instance-orchestrator.test.ts`

**执行步骤:**
- [x] 在 `packages/core/src/runtime/instance-orchestrator.ts` 定义 orchestrator 接口、依赖注入类型和默认工厂
  - 位置: 新文件顶部先引入 `EngineRelayHandle`、`EnginePlugin`、`EngineRuntime`、`ConnectRelayInput`、`StartInstanceInput`、`StopInstanceInput`、`PrepareEnvironmentInput`、Task 1 的 `LaunchInstanceRequest`、`ConnectInstanceRelayRequest`、`RuntimeInstanceRecord`、`RuntimeInstanceSnapshot`、`CoreRuntimeError`，以及 Task 1/2 的 `EnginePluginRegistry`、`CoreNodeRegistry`、`RuntimeInstanceStore`
  - 先定义并导出 `InstanceOrchestrator` 接口，公开方法固定为 `launch(request)`, `connectRelay(request)`, `stop(instanceId)`, `get(instanceId)`, `list()`；再定义 `CreateInstanceOrchestratorOptions`，字段固定为 `pluginRegistry`、`nodeRegistry`、`store`
  - 在文件底部导出 `createInstanceOrchestrator(options)` 工厂函数，返回闭包对象而不是 class，保持与 `packages/plugin-opencode/src/plugin.ts`、`packages/plugin-opencode/src/runtime/opencode-runtime.ts` 的函数式工厂风格一致
  - 原因: Task 4 需要一个可直接注入 facade 的稳定工厂入口，接口和依赖面必须先固定，避免后续再改调用契约
- [x] 在 `createInstanceOrchestrator()` 中实现 `launch()` 的前置校验、runtime 创建和状态推进主流程
  - 位置: `packages/core/src/runtime/instance-orchestrator.ts` 的工厂函数内部，先写私有辅助函数 `markInstanceError(instanceId, error)` 与 `toInvalidStateError(instanceId, status, action)`，再实现 `async launch(request)`
  - `launch()` 开头先调用 `store.get(request.instanceId)` 拒绝重复实例，命中时抛出 `createCoreRuntimeError("INSTANCE_ALREADY_EXISTS", ...)`；随后用 `pluginRegistry.require(request.engineType)` 获取插件，用 `nodeRegistry.require(request.nodeId)` 获取 node，并在同一方法内按顺序校验 `node.status === "online"` 与 `nodeRegistry.supportsEngine(request.nodeId, request.engineType)`，失败分别抛出 `NODE_OFFLINE`、`ENGINE_NOT_SUPPORTED`
  - 校验通过后固定执行 `const runtime = plugin.createRuntime()`，立刻调用 `store.create({ instanceId, engineType, nodeId, launchSpec })` 创建初始记录，再调用 `store.attachRuntime(instanceId, { plugin, runtime, relay: null })` 绑定 runtime 句柄
  - 之后按确定顺序推进状态：`store.update(instanceId, { status: "preparing" })` → `runtime.prepareEnvironment({ instanceId, launchSpec })` → `store.update(instanceId, { status: "prepared" })` → `store.update(instanceId, { status: "starting" })` → `runtime.startInstance({ instanceId })` → `store.update(instanceId, { status: "running", relayConnected: false })`
  - `launch()` 成功返回 `store.require(instanceId)` 的只读快照；`prepareEnvironment()`、`startInstance()` 抛错时统一走 `markInstanceError()`，确保 store 状态固定变为 `error` 且 `errorMessage` 写入异常文本
  - 原因: 设计文档已固定 `launch()` 的生命周期必须是 `preparing -> prepared -> starting -> running`，并且 orchestrator 需要把 plugin runtime 私有状态收束成 core 编排层的唯一真相
- [x] 在 `packages/core/src/runtime/instance-orchestrator.ts` 实现 `connectRelay()`，只允许 running 态复用缓存 runtime
  - 位置: `launch()` 之后实现 `async connectRelay(request)`，方法开始先通过 `store.require(request.instanceId)` 读取记录，再通过 `store.getRuntimeEntry(request.instanceId)` 读取缓存的 `plugin/runtime/relay`
  - 对记录状态执行严格校验：非 `running` 直接抛出 `createCoreRuntimeError("INVALID_INSTANCE_STATE", ...)`，错误 `details` 固定带上 `instanceId`、`currentStatus`、`action: "connectRelay"`；缺失 runtime entry 直接抛出 `INSTANCE_NOT_FOUND`，避免绕过 launch 直接连 relay
  - 命中 `runtimeEntry.relay` 且 `runtimeEntry.relay.state === "open"` 时直接返回已有句柄；否则调用 `runtimeEntry.runtime.connectRelay({ instanceId: request.instanceId, sessionId: request.sessionId })` 建立新 relay，成功后执行 `store.setRelay(instanceId, relay)` 并返回该句柄
  - `connectRelay()` 的任何异常都调用 `markInstanceError(instanceId, error)`，让记录的 `status` 变为 `error`、`errorMessage` 写入失败原因，且不额外清理 runtime 缓存，保留给 `stop()` 处理
  - 原因: `packages/plugin-opencode/src/runtime/opencode-runtime.ts` 已经支持重复 `connectRelay()` 复用同一句柄，orchestrator 只需要复用 Task 2 的 runtime cache 并补齐 core 层状态约束和错误落盘
- [x] 在 `packages/core/src/runtime/instance-orchestrator.ts` 实现 `stop()`、`get()`、`list()` 和错误收敛辅助逻辑
  - 位置: `connectRelay()` 之后实现 `async stop(instanceId)`，文件尾部实现 `get()` 与 `list()`
  - `stop(instanceId)` 先用 `store.require(instanceId)` 读取记录；记录不存在时让 `store.require()` 直接抛出 `INSTANCE_NOT_FOUND`；记录状态为 `stopped` 时直接返回，不再调用 runtime，保证幂等
  - 其余状态统一执行 `store.update(instanceId, { status: "stopping" })`，再从 `store.getRuntimeEntry(instanceId)` 读取缓存 runtime；读取不到时抛出 `INSTANCE_NOT_FOUND`；命中 `relay?.state === "open"` 时先 `await relay.close()`，再 `await runtime.stopInstance({ instanceId })`，随后执行 `store.clearRelay(instanceId)` 和 `store.update(instanceId, { status: "stopped", relayConnected: false })`
  - `stop()` 的任一步失败也统一调用 `markInstanceError(instanceId, error)`；`get(instanceId)` 直接返回 `store.get(instanceId)`，`list()` 直接返回 `store.list()`，不在 orchestrator 内复制第二份状态集合
  - `markInstanceError(instanceId, error)` 固定将消息提取为 `error instanceof Error ? error.message : String(error)`，并调用 `store.update(instanceId, { status: "error", relayConnected: false, errorMessage })`；另写私有辅助函数 `createErroredInstanceRecord(request, error)` 放在 `launch()` 前半段的 `plugin.createRuntime()` 调用外层 `try/catch` 中使用：当 runtime 尚未创建、`store.create()` 尚未发生时，执行 `store.create({ instanceId: request.instanceId, engineType: request.engineType, nodeId: request.nodeId, launchSpec: request.launchSpec })`，随后立刻调用 `markInstanceError(request.instanceId, error)`，确保 `plugin.createRuntime()` 失败也会留下 `error` 快照
  - 原因: stop 是最后一个生命周期出口，必须同时满足幂等、错误可见性和 runtime cache 回收语义，后续 facade 才能把它当成统一清理入口
- [x] 为 `InstanceOrchestrator` 编写单元测试并覆盖成功路径、非法状态和错误落盘
  - 测试文件: `packages/core/src/__tests__/instance-orchestrator.test.ts`
  - 测试场景:
    - 生命周期成功路径: 使用 Task 1 的 `EnginePluginRegistry`、`CoreNodeRegistry`、Task 2 的 `createRuntimeInstanceStore()` 与 `createFakeEnginePlugin()`，执行 `launch()` → `connectRelay()` → `stop()` → 断言 store 状态依次落到 `running`、`relayConnected = true`、`stopped`，且 fake runtime 调用顺序固定为 `prepare -> start -> connectRelay -> stop`
    - launch 前置校验: 对重复 `instanceId`、不存在插件、`offline` node、不支持目标 `engineType` 分别调用 `launch()` → 断言抛出 `INSTANCE_ALREADY_EXISTS`、`PLUGIN_NOT_FOUND`、`NODE_OFFLINE`、`ENGINE_NOT_SUPPORTED`
    - launch 失败落盘: 让 fake plugin 注入 `failOnPrepare` 和 `failOnStart` → `launch()` 抛错后 `store.get(instanceId)` 返回 `status = "error"` 且 `errorMessage` 为注入异常文本
    - relay 约束: 未启动实例直接 `connectRelay()`、以及手工把记录推进到 `prepared` 后调用 `connectRelay()` → 断言抛出 `INVALID_INSTANCE_STATE`；重复 `connectRelay()` 返回同一 relay 句柄且 fake runtime 的 `connectRelay` 调用次数保持为 1
    - relay 失败落盘: fake plugin 注入 `failOnConnectRelay` → `connectRelay()` 抛错后记录进入 `error`，`errorMessage` 保留连接失败文本
    - stop 语义: 对 `stopped` 记录重复调用 `stop()` 不再新增 fake runtime `stop` 调用；对不存在实例调用 `stop()` 抛出 `INSTANCE_NOT_FOUND`；对 `failOnStop` 注入错误后记录进入 `error`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/instance-orchestrator.test.ts`
  - 预期: 测试文件全部通过，断言覆盖 launch 状态推进、runtime cache 复用、relay 状态约束、stop 幂等与所有关键错误码

**检查步骤:**
- [x] 检查 orchestrator 已定义完整生命周期接口与工厂入口
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "interface InstanceOrchestrator|createInstanceOrchestrator|launch\\(|connectRelay\\(|stop\\(|get\\(|list\\(" packages/core/src/runtime/instance-orchestrator.ts`
  - 预期: 输出包含 Task 3 约定的五个公开方法和工厂函数定义
- [x] 检查 `launch()` 状态推进顺序、runtime cache 绑定和错误收敛逻辑已落地
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "preparing|prepared|starting|running|attachRuntime|markInstanceError|INSTANCE_ALREADY_EXISTS|ENGINE_NOT_SUPPORTED|NODE_OFFLINE" packages/core/src/runtime/instance-orchestrator.ts`
  - 预期: 输出显示 `launch()` 依次推进四个状态、绑定 runtime 缓存，并对重复实例、node 离线和 engine 不支持给出明确错误码
- [x] 检查 `connectRelay()` 与 `stop()` 已复用 Task 2 的 runtime/relay 缓存并执行状态守卫
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "getRuntimeEntry|setRelay|clearRelay|INVALID_INSTANCE_STATE|INSTANCE_NOT_FOUND|relay.state === \\\"open\\\"" packages/core/src/runtime/instance-orchestrator.ts`
  - 预期: 输出包含 relay 缓存访问、running 态限制、stop 幂等与缺失实例错误处理
- [x] 检查本 Task 单元测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/instance-orchestrator.test.ts`
  - 预期: 测试文件全部通过，无断言失败和类型错误

---

### Task 4: Facade、导出与 integration 入口

**背景:**
Task 1~3 已经约定 registry、store、orchestrator 的类型、状态与错误边界，但 `packages/core` 目前仍没有包级公开入口，外部调用方还不能像 `@mothership/opencode` 一样通过单一工厂完成装配和生命周期操作。
经代码确认，`packages/core/src/index.ts` 与 `packages/core/integration/` 目录当前都不存在；`packages/plugin-opencode/src/index.ts` 只暴露 `createEnginePlugin()`，`packages/plugin-opencode/integration/` 则已经固定了 “README + `.gitignore` + 可提交模板配置 + 默认关闭的真实链路测试” 结构。
本 Task 在 Task 3 的 orchestrator 之上补齐 facade、公开导出面和手动真实联调入口，让后续接入层只依赖 `createCoreRuntime()` 与受控导出，不直接触碰 runtime cache 等内部实现。

**涉及文件:**
- 新建: `packages/core/src/facade/core-runtime.ts`
- 新建: `packages/core/src/index.ts`
- 新建: `packages/core/src/__tests__/core-runtime.test.ts`
- 新建: `packages/core/integration/.gitignore`
- 新建: `packages/core/integration/README.md`
- 新建: `packages/core/integration/core-runtime.conf.json`
- 新建: `packages/core/integration/core-runtime.integration.test.ts`

**执行步骤:**
- [x] 在 `packages/core/src/facade/core-runtime.ts` 定义 facade 的公开类型、构造选项与唯一工厂入口
  - 位置: 新文件顶部先引入 `EnginePlugin`、`EngineRelayHandle`、Task 1 的 `CoreNode`、`CreateCoreNodeInput`、`LaunchInstanceRequest`、`ConnectInstanceRelayRequest`、`RuntimeInstanceSnapshot`，以及 Task 1~3 的 `EnginePluginRegistry`、`CoreNodeRegistry`、`RuntimeInstanceStore`、`createRuntimeInstanceStore()`、`createInstanceOrchestrator()`
  - 先定义并导出 `CoreRuntimeFacade` 接口，公开方法固定为 `registerPlugin(plugin)`、`registerNode(node)`、`launchInstance(request)`、`connectInstanceRelay(request)`、`stopInstance(instanceId)`、`getInstance(instanceId)`、`listInstances()`、`getNode(nodeId)`、`listNodes()`、`getPlugin(engineType)`、`listPlugins()`；再定义 `CreateCoreRuntimeOptions`，字段固定为 `plugins?: EnginePlugin[]`、`nodes?: CreateCoreNodeInput[]`、`store?: RuntimeInstanceStore`
  - 在文件底部导出 `createCoreRuntime(options?: CreateCoreRuntimeOptions): CoreRuntimeFacade`，明确这是 `@mothership/core` 的唯一装配工厂
  - 原因: 包外调用面需要像 `plugin-opencode` 的 `createEnginePlugin()` 一样单点进入，同时把 Task 3 的 orchestrator 包装成稳定 facade，隔离内部装配细节
- [x] 在 `createCoreRuntime()` 中一次性装配 registry、store 与 orchestrator，并仅暴露 facade 方法
  - 位置: `packages/core/src/facade/core-runtime.ts` 的 `createCoreRuntime()` 函数体内部，按 `create registries -> resolve store -> create orchestrator -> preload plugins/nodes -> return facade object` 的顺序实现
  - 固定创建 `const pluginRegistry = new EnginePluginRegistry()`、`const nodeRegistry = new CoreNodeRegistry()`、`const instanceStore = options?.store ?? createRuntimeInstanceStore()`、`const orchestrator = createInstanceOrchestrator({ pluginRegistry, nodeRegistry, store: instanceStore })`
  - 紧接着顺序注册 `options.plugins` 与 `options.nodes`，分别调用 `pluginRegistry.register(plugin)`、`nodeRegistry.register(node)`；返回对象中的生命周期方法直接委托给 orchestrator：`launchInstance(request)` 调 `orchestrator.launch(request)`，`connectInstanceRelay(request)` 调 `orchestrator.connectRelay(request)`，`stopInstance(instanceId)` 调 `orchestrator.stop(instanceId)`
  - 返回对象中的查询与注册方法只透传 registry / orchestrator 的公开能力，不暴露 `instanceStore`、不返回 runtime entry、也不导出任何 `attachRuntime/getRuntimeEntry/setRelay` 类内部缓存接口
  - 原因: 设计文档要求 `createCoreRuntime()` 内部一次性装配 registry、store、orchestrator，并让上层只看见 facade 级方法，不能把 runtime cache 变成公开 API
- [x] 在 `packages/core/src/index.ts` 建立受控导出面，只导出 facade、registry、核心类型和必要测试友好工厂
  - 位置: 新文件顶部写包级文档注释，随后按 `facade -> registry -> types -> errors -> test-friendly factories` 顺序组织 `export` 与 `export type`
  - 导出 `createCoreRuntime` 与 `CoreRuntimeFacade`；导出 `EnginePluginRegistry`、`CoreNodeRegistry`；导出 Task 1 的 `CoreNode`、`CreateCoreNodeInput`、`RuntimeInstanceStatus`、`RuntimeInstanceRecord`、`RuntimeInstanceSnapshot`、`LaunchInstanceRequest`、`ConnectInstanceRelayRequest`、`StopInstanceRequest`、`CoreRuntimeError`、`CoreRuntimeErrorCode`、`isCoreRuntimeError`
  - 额外导出 `createRuntimeInstanceStore` 作为测试友好工厂，并保留 `RuntimeInstanceStore` 类型导出；不要从该文件导出 `createInstanceOrchestrator`、`InstanceOrchestrator`、`RuntimeInstanceRuntimeEntry`、`getRuntimeEntry` 或任何 runtime cache 内部实现
  - 原因: `packages/plugin-opencode/README.md` 已明确包外入口只暴露公开 API，`@mothership/core` 也需要同样的受控导出边界，保证未来接入层不会直接依赖 orchestrator 内脏
- [x] 在 `packages/core/integration/.gitignore`、`packages/core/integration/README.md`、`packages/core/integration/core-runtime.conf.json` 建立与 `packages/plugin-opencode/integration/` 对齐的手动联调目录
  - 位置: 三个新文件全部放在 `packages/core/integration/` 根目录；`.gitignore` 只写 `core-runtime.local.json`，保持与 `plugin-opencode/integration/.gitignore` 同样的私有配置隔离模式
  - `README.md` 参照 `packages/plugin-opencode/integration/README.md` 的章节顺序，固定写明用途、配置方式、运行命令 `bun test ./core-runtime.integration.test.ts`、成功判定与排错提示；正文明确说明该目录用于真实链路手动验证，不纳入常规 CI
  - `core-runtime.conf.json` 固定提供可提交模板，字段包含 `enabled: false`、`instanceId`、`nodeId: "local-default"`、`engineType: "opencode"`、`launchSpec`、`relay.requestMessages`、`relay.successMatch`，其中 `launchSpec` 和 `relay.payload.cwd` 保持占位路径，确保默认关闭且不携带真实密钥
  - 原因: `plugin-opencode` 已经验证这种目录组织能同时满足可提交模板、私有本地覆盖和默认不触发真实环境测试，`packages/core` 直接对齐可减少后续维护成本
- [x] 在 `packages/core/integration/core-runtime.integration.test.ts` 编排真实插件链路，固定走 `createCoreRuntime()` facade 调用
  - 位置: 新文件顶部参照 `packages/plugin-opencode/integration/opencode-runtime.integration.test.ts` 引入 `describe`、`test`、`existsSync`、`readFileSync`、`AgentLaunchSpec`、`EngineRelayHandle`、`EngineRelayMessage`；从 `@mothership/opencode` 引入 `createEnginePlugin`，从 `../src/index` 引入 `createCoreRuntime`
  - 先复制 `CONFIG_PATHS`、`loadIntegrationConfig()`、`buildLaunchSpec()`、`withTimeout()`、`runStep()`、`matchesExpectedResponse()`、`waitForExpectedResponse()`、`sendRequestMessagesInOrder()` 这些经过验证的辅助函数命名与行为；配置加载顺序固定为 `core-runtime.local.json` 优先、`core-runtime.conf.json` 兜底，`enabled !== true` 时直接 `test.skip`
  - 在测试主体里固定执行 `const runtime = createCoreRuntime()`，随后调用 `runtime.registerPlugin(createEnginePlugin())` 与 `runtime.registerNode({ id: config.nodeId ?? "local-default", mode: "local", engineTypes: [config.engineType], status: "online" })`；再按顺序驱动 `runtime.launchInstance({ instanceId, engineType: config.engineType, nodeId: config.nodeId ?? "local-default", launchSpec })`、`runtime.connectInstanceRelay({ instanceId })`、发送 ACP 请求消息、等待 `successMatch` 命中的真实响应，最后在 `finally` 中先关闭 relay 再调用 `runtime.stopInstance(instanceId)`
  - 文件顶部补一段文档注释，明确这是默认关闭的真实链路验证入口；不要把该测试文件并入 `packages/core/package.json` 的常规 `test` 脚本，也不要新增自动执行钩子
  - 原因: 本 Task 需要验证 facade 没有破坏 `@mothership/opencode` 的真实链路能力，同时保持和 `plugin-opencode` 一致的“手动开启、默认跳过”测试策略
- [x] 为 `createCoreRuntime()` facade 编写单元测试
  - 测试文件: `packages/core/src/__tests__/core-runtime.test.ts`
  - 测试场景:
    - 预注册装配: `createCoreRuntime({ plugins: [fakePlugin], nodes: [localNode] })` → `listPlugins()`、`getPlugin("fake-engine")`、`listNodes()`、`getNode("local-default")` 返回预期对象
    - 生命周期委托: 调用 `launchInstance()` → `connectInstanceRelay()` → `stopInstance("inst_core")` → `getInstance()` 与 `listInstances()` 依次反映 `running`、`relayConnected = true`、`stopped`
    - 导出约束: 读取 `packages/core/src/index.ts` 的模块导出 → 包含 `createCoreRuntime`、`EnginePluginRegistry`、`CoreNodeRegistry`、`createRuntimeInstanceStore`，不包含 `createInstanceOrchestrator`、`RuntimeInstanceRuntimeEntry`
    - facade 隔离: 对 `getInstance()` 返回快照执行字段改写，再次查询同一实例 → 不出现 runtime cache 字段，也不污染 store 内部状态
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/core-runtime.test.ts`
  - 预期: 测试文件全部通过，断言覆盖 facade 装配、生命周期委托、受控导出与快照隔离

**检查步骤:**
- [x] 检查 `createCoreRuntime()` 已在 facade 内部一次性装配 registry、store 与 orchestrator
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "createCoreRuntime|new EnginePluginRegistry|new CoreNodeRegistry|createRuntimeInstanceStore|createInstanceOrchestrator|registerPlugin\\(|launchInstance\\(|connectInstanceRelay\\(|stopInstance\\(" packages/core/src/facade/core-runtime.ts`
  - 预期: 输出包含 facade 工厂、三类依赖装配和仅通过 facade 方法暴露生命周期操作的实现
- [x] 检查 `packages/core/src/index.ts` 的公开导出面受控，没有泄漏 orchestrator/runtime cache 内部实现
  - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "createCoreRuntime|EnginePluginRegistry|CoreNodeRegistry|createRuntimeInstanceStore|createInstanceOrchestrator|RuntimeInstanceRuntimeEntry" packages/core/src/index.ts`
  - 预期: 输出包含 facade、registry、核心类型与测试友好工厂导出，不包含 `createInstanceOrchestrator` 和 `RuntimeInstanceRuntimeEntry` 的导出语句
- [x] 检查 integration 目录结构、默认关闭配置和真实插件入口已对齐 `plugin-opencode`
  - `cd /Users/liyuan/Work/mothership-beta_new && find packages/core/integration -maxdepth 1 -type f | sort && rg -n "\"enabled\": false|createEnginePlugin|registerPlugin|local-default|launchInstance|connectInstanceRelay|stopInstance" packages/core/integration`
  - 预期: 输出包含 `.gitignore`、`README.md`、`core-runtime.conf.json`、`core-runtime.integration.test.ts`，并显示模板配置默认关闭、真实测试通过 `@mothership/opencode` 注册插件和 `local-default` node 后驱动完整链路
- [x] 检查本 Task 单元测试通过
  - `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/core-runtime.test.ts`
  - 预期: facade 单元测试全部通过；integration 测试文件存在但不在本命令中执行

---

### Task 5: 本地 node 编排闭环验收

**前置条件:**
- 工作目录: `/Users/liyuan/Work/mothership-beta_new`
- 依赖环境: 已完成 Task 1~4，对应源码和测试文件已落地
- 手动 integration 配置: 按 `packages/core/integration/README.md` 复制 `core-runtime.conf.json` 为 `core-runtime.local.json`，填入真实 `launchSpec.workspace`、模型密钥和 `relay.requestMessages`

**端到端验证:**

1. [x] 运行 `packages/core` 完整测试套件确保无回归
   - `cd /Users/liyuan/Work/mothership-beta_new/packages/core && bun test`
   - 预期: `packages/core/src/__tests__/` 下所有测试全部通过
   - 失败排查: 先检查 Task 1~4 各自的单测步骤，重点看 Task 3 的状态推进断言和 Task 4 的导出约束断言

2. [x] 运行 `packages/core` 类型检查
   - `cd /Users/liyuan/Work/mothership-beta_new/packages/core && bun run typecheck`
   - 预期: TypeScript 检查通过，无缺失导出、路径别名或 `strict` 模式错误
   - 失败排查: 检查 Task 1 的类型导出、Task 2 的 `RuntimeInstanceStore` 接口和 Task 4 的 `index.ts` 导出面

3. [x] 验证 `createCoreRuntime()` 只暴露受控公开入口
   - `cd /Users/liyuan/Work/mothership-beta_new && rg -n "createCoreRuntime|EnginePluginRegistry|CoreNodeRegistry|createRuntimeInstanceStore|createInstanceOrchestrator|RuntimeInstanceRuntimeEntry" packages/core/src/index.ts`
   - 预期: 输出包含 `createCoreRuntime`、两类 registry 和 `createRuntimeInstanceStore`，不出现 `createInstanceOrchestrator`、`RuntimeInstanceRuntimeEntry` 的导出语句
   - 失败排查: 检查 Task 4 的 `packages/core/src/index.ts` 导出整理步骤

4. [x] 验证本地 node 生命周期编排闭环已落地
   - `cd /Users/liyuan/Work/mothership-beta_new && bun test packages/core/src/__tests__/instance-orchestrator.test.ts packages/core/src/__tests__/core-runtime.test.ts`
   - 预期: 断言覆盖 `launch -> connectRelay -> stop`、`relayConnected` 切换、stop 幂等和错误路径，测试全部通过
   - 失败排查: 检查 Task 2 的 fake plugin/relay 夹具、Task 3 的 runtime cache 与 `markInstanceError()` 实现

5. [x] 验证真实 plugin 的手动 integration 入口可被发现且默认关闭
   - `cd /Users/liyuan/Work/mothership-beta_new && find packages/core/integration -maxdepth 1 -type f | sort && rg -n "\"enabled\": false|createEnginePlugin|registerPlugin|local-default|launchInstance|connectInstanceRelay|stopInstance" packages/core/integration`
   - 预期: 输出包含 `.gitignore`、`README.md`、`core-runtime.conf.json`、`core-runtime.integration.test.ts`，且模板配置默认关闭，测试主体通过 `@mothership/opencode` 注册真实插件并驱动完整链路
   - 失败排查: 检查 Task 4 的 integration 目录搭建步骤与 `core-runtime.integration.test.ts` 中的 facade 调用顺序

6. [x] 手动运行真实链路 integration 测试
   - `cd /Users/liyuan/Work/mothership-beta_new/packages/core/integration && bun test ./core-runtime.integration.test.ts`
   - 预期: 在 `core-runtime.local.json` 已启用且配置真实环境时，日志按 `registerPlugin:start/ok`、`registerNode:start/ok`、`launchInstance:start/ok`、`connectRelay:start/ok`、`waitForExpectedResponse:start/ok` 顺序推进，并最终完成 `stopInstance`
   - 失败排查: 先核对 `core-runtime.local.json` 的 `launchSpec` 与 `successMatch`，再检查 Task 4 的 integration 辅助函数是否与 `plugin-opencode` 模板保持一致
