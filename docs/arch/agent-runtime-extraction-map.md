# Agent Runtime 现状提取地图（AGT-00）

> **状态：当前实现提取地图，不是目标架构。**
>
> 本文只描述基线提交 `ba8ab4d1737634b62042290c1735be8744d947bb` 上可观察到的行为，为后续拆包提供定位与特征测试索引。文末接口草案**仅供 ARC-02 讨论，非权威且未冻结**；不得据此绕过 ARC-02，亦不得把本文当作兼容承诺。

## 1. 范围与既有文档

AGT-00 盘点实例创建、复用、停止、ACP relay、LaunchSpec、Environment/节点、引擎调用、取消、超时、并发与资源释放。本文不重新定义已有子系统；细节以以下文档和对应源码为准：

- 编排与实例管理：[`20-orchestration-management.md`](./20-orchestration-management.md)
- Chat/YJS 时序与投影：[`19-yjs-chat-streaming.md`](./19-yjs-chat-streaming.md)
- Chat 错误诊断：[`23-chat-error-diagnostics.md`](./23-chat-error-diagnostics.md)
- Workflow：[`17-workflow.md`](./17-workflow.md)
- Scheduler：[`09-scheduler.md`](./09-scheduler.md)
- Sandbox：[`19-sandbox.md`](./19-sandbox.md)
- 文件与 workspace：[`12-files.md`](./12-files.md)
- CE/EE 目标边界：[`ce-ee-engineering-architecture.md`](../design/ce-ee-engineering-architecture.md)
- 迁移任务与 ARC-02/AGT-00：[`ce-ee-refactoring-collaboration-plan.md`](../design/ce-ee-refactoring-collaboration-plan.md)

本文刻意区分“当前事实”和“候选边界”。尤其不能由本文推导出以下错误结论：relay 关闭等于 Agent 进程停止、所有取消都会发送 ACP `session/cancel`、所有超时都会停止实例、`packages/orchestration` 会启动引擎，或编排域 `LaunchSpec.cwd` 会传给插件。

## 2. 启动调用图

### 2.1 规范创建路径

当前新建运行实例的宿主入口是 `src/services/orchestration-instance.ts#spawnInstanceViaController`：

```text
调用方
  -> beginSpawnReservation(userId, source)
  -> AgentController.spawnInstance(envId, userId)
     -> PgEnvironmentOrchestrationRepo.getEnvironment
        -> createExecutionNodeResolver
           -> 必要时 sandboxExecutionHandler.prepare
     -> 环境级并发检查
     -> LaunchSpecBuilder.build(envId, userId)
        -> 再读 Environment、AgentConfig、Engine，计算编排 cwd
     -> AgentNodeService.ensureNode(machineId)
     -> AgentNode._spawnInstance(launchSpec)
        -> new Instance(instanceId = `inst_${randomUUID()}`)
     -> 注册前二次环境级并发检查
     -> AgentController.#instances.set(instanceId, instance)
  -> LaunchSpecBuilder.build(envId, userId)                 // 宿主再次构建
  -> buildAgentLaunchSpecForCore(launchSpec, extraEnv)
     -> 再读管理侧 Environment 和可读 AgentConfig
     -> buildLaunchSpec(...)                                // 模型、Skill、MCP、知识、记忆、密钥
        -> Skill 归档缺失或过期时重建归档
  -> CoreRuntimeFacade.launchInstance(LaunchInstanceRequest)
     -> InstanceOrchestrator.launch
        -> CoreNodeRegistry.require
        -> runtimeResolver(remote) 或 EnginePlugin.createRuntime(local)
        -> RuntimeInstanceStore.create + attachRuntime
        -> EngineRuntime.prepareEnvironment
        -> EngineRuntime.startInstance
        -> Core 状态更新为 running，写 pluginMetadata
  -> registerSupplement
     -> globalInstanceRegistry.nextInstanceNumber
     -> globalInstanceRegistry.register
  -> 返回编排 Instance
finally
  -> releaseSpawnReservation
```

符号位置：

- 宿主桥接和补偿：`src/services/orchestration-instance.ts`
- 编排 Controller、Instance、Node：`packages/orchestration/src/agent-controller/index.ts`、`packages/orchestration/src/instance/instance.ts`、`packages/orchestration/src/agent-node/agent-node.ts`
- 编排 LaunchSpec：`packages/orchestration/src/launch-spec/launch-spec-builder.ts`
- 实际运行配置：`src/services/launch-spec-builder.ts`
- Core 启动：`packages/core/src/runtime/instance-orchestrator.ts`
- 插件契约：`packages/plugin-sdk/src/agent-launch-spec.ts`
- 本地实现：`packages/plugin-opencode/src/runtime/opencode-runtime.ts`、`packages/plugin-ccb/src/runtime/ccb-runtime.ts`、`packages/plugin-claude-code/src/runtime/claude-code-runtime.ts`
- 远程实现：`packages/remote-runtime/src/remote-runtime.ts`

`AgentController` 只创建编排内存对象并维护 Node 引用；真正的 `prepareEnvironment`、`startInstance` 和进程/远程命令由 Core 选择的 `EngineRuntime` 执行。

### 2.2 单轮会话路径

`src/services/agent-chat-service.ts#openAgentSession` 先按 `organizationId + agentConfigId + userId` 查找或创建 Environment，然后**总是**调用 `spawnInstanceViaController` 创建独立实例，再执行：

```text
connectAgentRelay(instanceId, X-Session-Id ?? "")
  -> CoreRuntimeFacade.connectInstanceRelay
  -> InstanceOrchestrator.connectRelay（同实例已有 open relay 时复用）
createAgentSession(relayHandle, instanceId, stopInstanceViaController)
startPromptTurn(session, X-Session-Id)
  -> session/load（有 ACP session ID）或 session/new
  -> createPromptTurn
```

调用者拿到的 `PromptTurn.dispose()` 先 `release()` 当前 listener/迭代器，再调用 `AgentSession.dispose()` 关闭 relay 并停止该独立实例。relay 或 session 创建失败时，`openAgentSession` 补偿关闭已有 relay 并停止刚创建的实例。

## 3. 运行状态所有者

| 状态/资源 | 当前所有者与键 | 生命周期说明 |
| --- | --- | --- |
| 全局、用户、scheduled 启动额度 | `src/services/agent-concurrency.ts` 的 `pendingReservations: Set<SpawnReservation>` | `beginSpawnReservation` 同步检查并预留，`spawnInstanceViaController.finally` 按对象引用释放 |
| 可复用 Environment 启动合并 | `src/services/environment-startup-lock.ts#EnvironmentStartupLock.inFlight`，键为 `environmentId` | 仅 `ensureRunning` 未指定实例编号且没有运行实例时使用 |
| 编排实例活跃表 | `AgentController.#instances`，键为 `instanceId` | 纯进程内；stop 后移除 |
| Instance 终止与 Node 关系 | `packages/orchestration#Instance.#terminated` 和 `AgentNodeService` 节点引用计数 | `Instance.stop()` 只发停止帧并标记终止，不关闭共享 Node；Controller 归还 Node 引用 |
| Core 快照 | `RuntimeInstanceStore.records`，键为 `instanceId` | 保存状态、node、engine、实际 `AgentLaunchSpec`、错误和元数据；正常 stop 留下 `stopped` 快照，显式 delete 才移除 |
| Core 运行句柄与 relay | `RuntimeInstanceStore.runtimeEntries`，键为 `instanceId` | 保存 plugin/runtime/单个缓存 relay；`connectRelay` 复用 open relay |
| workspace 刷新串行化 | `InstanceOrchestrator.environmentRefreshes`，键为 `organizationId\0userId\0environmentId` | 同 workspace 的刷新 Promise 链，完成后删除 |
| RCS supplement | `src/services/instance-registry.ts` 的 `supplements`、`byEnvironment`、`envCounters` | 保存租户/用户/Environment、实例编号、来源、活动时间和 relayCount；不持久化 |
| 远程 Machine transport | `src/services/core-bootstrap.ts#remoteTransports`，键为 `machineId` | Machine 注册/断开时增删；remote runtime 持有其引用 |
| 远程请求与 session 监听 | `packages/remote-runtime/src/remote-transport.ts` 的 `pendingRequests`、`sessionListeners` | `request_id` 匹配响应；请求完成或超时删除 |
| 本地插件状态 | opencode/ccb runtime 的 `states`，Claude Code runtime 的 `instances`，均以 `instanceId` 为键 | 持有 workspace、进程/服务句柄、端口、token、relay 和错误；各插件 stop 清理 |
| acp-link 服务/进程状态 | 插件 `AcpLinkProcessManager.processes`，键为 `instanceId` | opencode/ccb 还持有端口分配；Claude Code 直接持有 `ChildProcess` |
| Workflow 使用权 | `src/services/workflow/instance-lease.ts#leases`，键为 `instanceId` | 每个 run 在选中实例后同步 acquire，execute settle/连接失败时 release；run 的 `spawnedInstanceIds` 只记录本 run 新建实例 |
| Chat 客户端与共享 relay | `ConnectionRegistry.clients/pendingBuffers/sharedRelays/relayAcquisitions` | 客户端按 `wsId`；relay/创建 Promise 按三元键，引用计数归零才释放 |
| Chat 会话/投影状态 | `SharedRelay`、`SessionChannel`、`RelayEventHandler`、`DocManager` | `rcsSessionId` 绑定当前 `acpSessionId`、RPC/turn 登记、计时器和 `chat:`/`session:` Y.Doc |

这些内存所有者没有统一事务。启动与停止依赖显式补偿和幂等收敛；进程崩溃会同时丢失这些进程内协调状态。

## 4. 标识与绑定地图

| 标识 | 精确格式/来源 | 传播与消费 | 不得混淆 |
| --- | --- | --- | --- |
| 运行实例 ID | `inst_${randomUUID()}`；`AgentNode._spawnInstance` 生成 | Controller、Core、supplement、插件、relay、Workflow、Chat 共用 | 不是任何 session ID |
| 前端实例会话 ID | `ses_inst_{environmentId}_{instanceNumber}`；`src/services/instance-session.ts#createInstanceSessionId` | `enterEnvironment` 返回，浏览器 query 传回；`resolveInstanceNumberFromSession` 用它选择实例 | Agent-session 表已删除；这不是 ACP session |
| ACP session ID | Agent 的 `session/new` 结果 `result.id`/`result.sessionId`，通常为 `ses_*`；缺少消息能力、30 秒握手超时或结果缺 ID 时由 `startPromptTurn` 合成 `ses_*` fallback | `session/load`、`session/prompt`、`session/cancel` 和 Chat 当前会话使用 | 不得当作 RCS/YJS 文档 ID |
| `X-Session-Id` | OpenAI 请求 header，值是 ACP session ID | `openai-chat.ts` 传入 `openAgentSession`；随后同时传给 `connectAgentRelay(instanceId, sessionId)` 和 `startPromptTurn({sessionId})`，后者发送 `session/load` | 不是数据库或前端 `ses_inst_*` ID |
| 物理 RCS 文档 ID | `rcs_${base64url(agentId)}.${base64url(userId)}[.${base64url(sessionId)}]`；UTF-8 完整 Base64URL、去 padding，以 `.` 分隔 | `packages/chat-channel/src/util/id.ts#createDeterministicRcsSessionId`；命名 `chat:{rcsSessionId}`、`session:{rcsSessionId}` 并隔离广播 | 浏览器第三分量通常是确定性的 `ses_inst_*`，不是持久化 Agent-session 记录 |
| Better Auth session ID | Better Auth 数据库 session 行的 `id` | HTTP/WS 认证、用户与组织上下文 | 与 Agent runtime、ACP、RCS session 全部无关 |
| agent-chat JSON-RPC ID | `nextRpcId()`：随机整数段起点后进程内递增 | 分别关联 `session/new|load` 和 `session/prompt`；turn ID 即 prompt RPC ID | 仅进程内关联，不是业务 ID |
| Chat RPC/turn/command ID | `SharedRelay.nextRpcId` 递增；无 shared 时用模块级计数；Y.Doc turn 为 `turn_${Date.now()}_${random}`；`commandId` 由前端提供并按 RCS session 去重 | SessionChannel、RelayEventHandler、投影状态机 | 三者作用域和幂等职责不同 |
| 远程请求 ID | `req_${Date.now()}_${counter}` | `RemoteTransport.pendingRequests` 关联 Machine 响应 | 不是 ACP JSON-RPC ID |
| 连接 ID | `acp_ws_${uuidNoDash}`、`file_ws_${uuidNoDash}`、`yjs_${uuidNoDash}`、`ext_relay_${uuidNoDash}` | 各 WS 注册表与日志 | 连接释放不代表实例停止 |

`src/routes/acp/index.ts` 把 YJS query `sessionId` 注释为“DB 会话标识”已过时：当前浏览器通常传 `ses_inst_*`，其来源是确定性函数而非已删除的 Agent-session 表。本文只记录该陈旧注释，不在 AGT-00 修改它。未来由哪个模块生成实例 ID、ACP fallback ID 和 RCS ID，留给 ARC-02 决策。

## 5. 复用与入口规则

| 入口/条件 | 当前行为 |
| --- | --- |
| `ensureRunning` 未给 `instanceNumber` | 优先复用该 Environment 第一个 running 实例；没有实例时通过 `EnvironmentStartupLock` 合并同环境启动，并在锁内二次检查 |
| `ensureRunning` 给出 `instanceNumber` | 复用精确编号；未运行时检查 Environment、`autoStart` 和 `maxSessions` 后新建 |
| 精确编号不存在且已达 `maxSessions` | 回退到第一个 running 实例；若仍无实例则报上限错误 |
| `openAgentSession` | 仅复用/自动创建 Environment，实例始终独立新建，不走 `ensureRunning` |
| Workflow | 经 `ensureRunning` 复用；新建实例 ID 记入本 run 的 cleanup 集，复用实例不归该 run 所有；所有选中实例均持有 lease |
| Chat | 经 `ensureRunning(..., "interactive", instanceNumber?)`；tab 共享逻辑 relay，但不因最后 tab 关闭而停实例 |
| 外部 `/acp/relay/:agentId` | 只在鉴权后的 Environment running 实例中解析精确 `instanceId` 或首个实例；绝不 spawn |

## 6. Environment、Machine 与 Sandbox

`PgEnvironmentOrchestrationRepo.getEnvironment` 在启用 Sandbox 时不是纯查询。`orchestration-bootstrap.ts#createExecutionNodeResolver` 与 repository fallback 的合并优先级为：

1. `agentNode.kind === "sandbox"`：准备指定 Sandbox pool；
2. `agentNode.kind === "machine"`：使用显式 Machine；
3. 未显式选择且 Sandbox 默认策略启用：准备默认 pool；
4. 只有 `agentNode == null` 时，使用历史 `agent_config.machineId` 列；
5. `RCS_DEFAULT_MACHINE_ID`；
6. 未禁用本地执行时使用 `local-default`；否则无节点并拒绝启动。

Sandbox 准备会创建、复用、重启或恢复基础设施并等待 Machine 注册；完整状态机参见 [`19-sandbox.md`](./19-sandbox.md)。`prepareSandboxNode` 每次生成候选 `sbi_*`，但 `SandboxManager.createOrReuse` 按 provider/pool/user 复用活跃实例，因此 Controller 与多个 LaunchSpec 构建中的重复 Environment 解析必须保持幂等并返回同一 `machineId`。租户归属使用请求 `userId`，不能跨用户复用。

## 7. 三种 Launch 输入及重复读取

| 表示 | 位置 | 内容与当前用途 |
| --- | --- | --- |
| 编排 `LaunchSpec` | `packages/orchestration/src/launch-spec/types.ts` | Environment ID、扁平 AgentConfig、engine、`cwd`、user；用于编排校验和创建 Instance |
| 插件 `AgentLaunchSpec` | `packages/plugin-sdk/src/agent-launch-spec.ts` | organization/user/environment、env、agent、完整 model 凭证、Skill 下载 URL、MCP；传给 Engine `prepareEnvironment` |
| Core `LaunchInstanceRequest` | `packages/core/src/types/launch-request.ts` | `instanceId`、`nodeId`、本地可选 `engineType` 和 `AgentLaunchSpec`；Core 调度输入 |

一次 `spawnInstanceViaController` 中，Controller 先读 Environment，Controller 内的 `LaunchSpecBuilder.build` 又读一次，Controller 返回后宿主再 `build` 一次；随后 `buildAgentLaunchSpecForCore` 从管理 repository 重读 Environment/AgentConfig，并由 `src/services/launch-spec-builder.ts` 读取模型、Provider、Skill、MCP、知识、记忆等资源。Skill 源目录比归档新或归档缺失时，所谓“构建”还会执行归档写入；因此这组读取既重复，也并非全都无副作用。

编排 `LaunchSpec.cwd` 不进入 `AgentLaunchSpec`。opencode/ccb 插件用 `WORKSPACE_ROOT + organizationId + userId + environmentId` 重算；Claude Code 当前用相对的 `organizationId/userId/environmentId`；Chat 宿主又通过 `resolveWorkspacePath` 计算 ACP action cwd。提取时不能假设这些路径已由一个权威输入统一。

## 8. 调用场景与所有权

| 场景 | 实例/relay 获取 | turn/relay 释放 | 是否停止实例 |
| --- | --- | --- | --- |
| OpenAI 单轮 | `openAgentSession` 独立 spawn，连接 Core relay | route 的成功、失败、超时或 Response cancel 最终调用 `turn.dispose()` | 是，由单轮 `AgentSession` 所有 |
| Scheduler 单轮 | `agentExecutor` 调用 `openAgentSession`，来源 `scheduled` | `finally` 调用 `turn.dispose()` | 是 |
| Workflow | `ensureRunning` + lease；Core relay 可复用；每次 `startPromptTurn` 有独立 listener | execute settle 释放 relay 活动计数和 lease；engine 调用 adapter `dispose()` 只执行 `turn.release()` | 通常否；run 结束只尝试清理该 run 实际 spawn 的实例，lease 存在时跳过 |
| Chat | `ensureRunning`；`ConnectionRegistry` 合并相同三元键的 relay 创建并引用计数 | 最后 tab 释放 SessionChannel 状态、计时器、YJS listener、relay listener 和 handle | 否；实例由显式停止、死亡/机器清理或适用的回收路径处理 |

### 8.1 Chat relay 三元键与陈旧文档清单

当前权威实现 `packages/chat-channel/src/channel/connection-registry.ts#makeRelayKey` 的精确键是：

```text
instanceId + userId + rcsSessionId
```

即字符串 ``${instanceId}:${userId}:${rcsSessionId}``。同文件较早的三元键说明，以及 [`19-yjs-chat-streaming.md`](./19-yjs-chat-streaming.md) 对三元键的调用图/共享 relay 描述，与实现一致。

以下所有“只按 `instanceId + userId`”的陈述均是已知陈旧描述，不能用来改写当前行为：

1. `packages/chat-channel/src/channel/connection-types.ts` 文件头；
2. 同文件 `SharedRelay` 接口注释；
3. `packages/chat-channel/src/channel/connection-registry.ts` 文件头在列出三元键后的“同一 instance + user”句；
4. `docs/arch/19-yjs-chat-streaming.md` 第 15 节决策 9；
5. 根 `CLAUDE.md` 的 Chat/YJS 不变量 8；
6. `docs/design/issues/c6-connection-lifecycle.md` 的 connection-registry 描述。

AGT-00 不修改这些文件；后续文档收敛必须保持当前三元隔离，除非另有经过评审的行为变更。

## 9. 清理与补偿地图

| 触发 | 调用链与清理结果 | 重要边界 |
| --- | --- | --- |
| 正常/显式停止 | `stopInstanceViaController`：Controller `Instance.stop`/移除活跃表/归还 Node 引用；Core 关闭缓存 relay、调用 runtime stop、置 `stopped`；注销 supplement/计数；关闭前端客户端；回收实例 Y.Doc | 每层失败记录后继续后续层；relay 关闭本身不是进程停止 |
| 宿主 spawn 后半段失败 | Core launch、二次 LaunchSpec 或 supplement 注册失败后调用 `stopInstanceViaController`；最外层总释放 reservation | Core 可能保留 `error`/`stopped` 快照；三侧不是数据库事务 |
| 单轮 relay/session 建立失败 | `openAgentSession`：已有 session 则 `session.dispose()`，否则直接 `stopInstanceViaController` | 抛回原错误，补偿错误只记录 |
| AgentConfig/Environment 删除 | `stopInstancesForEnvironments` 从 supplement、Core 快照、Controller 三路收集并去重，按组织过滤后 stop，再由调用方删资源 | 单实例 stop 用 `allSettled`；收集阶段失败则 fail-closed，不删 DB |
| scheduled/system 空闲回收 | `runAcpIdleMonitorSweep`：activity 硬超时或 relayCount=0 的 idle 超时，先关闭前端 relay，再经 `stopInstance` 收敛 | `interactive` 明确跳过自动 activity/idle 回收 |
| 本地 relay 死亡 | `connectAgentRelay` 失败或 Workflow 收到 `relay_closed` 后触发 `terminateLocalDeadInstance`，按 instance 去重并走正常 stop funnel | 仅 `local-default` 且 Core/Controller 状态满足条件；无 relay 的死进程仍靠 idle 兜底 |
| Machine 断开/重连 | `core-bootstrap` 删除该 Machine 的 Core 快照/runtime entry 与 supplement，再由 `cleanupOrchestrationInstancesForMachine` 清 Controller/Node 引用，并异步回收 Y.Doc | Machine 不可用，刻意绕过常规 Core runtime stop；可能无法确认远端进程已停 |
| Chat 最后连接关闭 | `Gateway.releaseRelay/closeReleasedRelay` 清引用、SessionChannel、轮询/timeout/replay timer、YJS listener、relay listener 和 handle | 不停止实例，不立即删除存活实例的 Y.Doc 内容 |
| graceful shutdown | `src/index.ts#gracefulShutdown`：停 Hermes、idle monitor、relay/ACP/file ingress 与 file sweep，`stopAllInstances`，停 Scheduler，关 cache/PostgreSQL | `stopAllInstances` 先清 Controller 实例，再兜底 Core 残留，最后清 supplement |

## 10. 取消与超时地图

| 场景 | 信号/阈值 | 对等待方 | ACP cancel | 实例处理 |
| --- | --- | --- | --- | --- |
| OpenAI 流式超时 | route 固定 300 秒后 `AbortController.abort()` | `mapToSSEChunks` 停止；stream `finally` dispose | 否 | dispose 独立实例 |
| OpenAI 客户端取消 Response | `ReadableStream.cancel()` | abort 映射并调用 dispose；`start().finally` 也会 dispose | 否 | dispose 独立实例；当前可能重复 dispose |
| OpenAI 非流式超时 | 300 秒 `Promise.race` reject | 返回 504，`finally` dispose | 否 | dispose 独立实例 |
| Scheduler 超时 | `task.timeoutSeconds ?? 300` 的 race | 返回 `status: "timeout"`/`Agent execution timeout`，`finally` dispose | 否 | dispose 独立实例 |
| Workflow AbortSignal | run/node abort | adapter reject `AbortError`，释放 relay 计数和 lease；后续 adapter dispose listener | 否 | 通常保留复用实例 |
| Workflow 执行兜底 | 默认 10 分钟 | reject `NODE_TIMEOUT`，释放 relay 计数和 lease | 否 | 通常保留；run 自有实例由 run cleanup 决定 |
| Chat 用户取消 | `cancel` action | SessionChannel 先进入 `cancelling`，translator 发送 `session/cancel`；Agent 确认或超时收敛 | **是** | 不停止实例 |
| Chat 取消确认超时 | 默认 10 秒 | 当前 turn 收敛 `interrupted` | 已在前一步发送 | 不停止实例 |
| Chat prompt 静默 | 5 分钟无业务帧；有入站则顺延 | `convergeStuckPrompt` 收敛失败状态 | 否 | 不停止实例 |
| session new/load 握手 | 30 秒 | 使用合成 ACP session ID 继续 | 否 | 不停止实例；意图尚未确认 |
| remote transport 请求 | prepare 60 秒，其余默认 30 秒 | 对应 request reject 并删除 pending | 不适用 | Core 启动失败走宿主补偿；remote stop 自身吞掉断连/超时，无法证明远端已停 |
| idle/activity 回收 | 配置项 `RCS_ACP_IDLE_TIMEOUT_SECONDS` / `RCS_ACP_ACTIVITY_TIMEOUT_SECONDS` | 后台实例被停止 | 否 | scheduled/system 走 stop；interactive 跳过 |

## 11. 进程内并发机制与限制

| 机制 | 当前限制/作用域 | 不能保证的事情 |
| --- | --- | --- |
| Spawn reservation | `RCS_AGENT_MAX_CONCURRENCY`、`RCS_USER_AGENT_MAX_CONCURRENCY`；`scheduled` 另受 `RCS_SCHEDULED_AGENT_MAX_CONCURRENCY` | 只在单个服务进程内；跨进程可同时通过 |
| Controller 环境级检查 | 注册前后各检查 `EnvironmentData.maxConcurrency`；当前 PostgreSQL repo 临时固定为 `1000` | 不是持久化配额，也不代替用户/全局 reservation |
| `EnvironmentStartupLock` | 每 Environment 一个未指定编号的可复用启动 Promise | 指定实例编号不使用；跨进程不合并 |
| Core environment refresh 链 | 每 organization/user/environment 串行 `prepareEnvironment` | 只协调当前 Core 单例 |
| Workflow lease | `instanceId -> run count` | 外部强停不能被 lease 阻止；进程退出即丢失 |
| Chat relay acquisition | 每 `instanceId + userId + rcsSessionId` 一个 in-flight Promise；随后引用计数 | 不管理 Agent 进程所有权 |
| Chat 客户端配额/背压 | `YJS_MAX_CLIENTS` 默认 200；单连接发送背压阈值 64 KB | 与 Agent 并发额度是不同维度 |
| 本地 relay 重试 | opencode/ccb 最多 20 次，每次间隔 100 ms | 重试失败会将插件/Core 标为 error，不能替代实例清理 |

全部协调机制目前均为 process-local；多副本部署需要另行设计分布式配额、租约与启动锁。

## 12. 现有特征测试证据

以下是基线行为的证据索引，不把测试实现重复抄入本文。

### 12.1 启动成功与失败释放

- `packages/orchestration/agent-controller/agent-controller.test.ts`：环境校验、LaunchSpec、节点、创建、并发竞态和节点引用。
- `packages/orchestration/instance/instance.test.ts`：状态映射、停止帧、幂等 stop 和共享 Node 边界。
- `packages/core/src/__tests__/instance-orchestrator.test.ts`：`prepare -> start -> connectRelay -> stop`、状态、relay 复用和失败。
- `src/__tests__/orchestration-instance-rollback.test.ts`：Core/补充注册失败后的三侧补偿及 reservation 释放。
- `src/__tests__/agent-concurrency-toctou.test.ts`：in-flight reservation 防止并发超发。
- `src/__tests__/openai-chat-service.test.ts` 与 `agent-chat-service-boundaries.test.ts`：relay/session 建立失败回滚；AGT-00 增强成功 dispose 对准确实例的所有权断言。

### 12.2 停止与异常清理

- `src/__tests__/instances-delete-idempotent.test.ts`：重复删除/停止的 ensure-stopped 语义。
- `src/__tests__/orchestration-instance-cleanup-isolation.test.ts`：多租户三路清理隔离与失败边界。
- `packages/core/src/__tests__/instance-orchestrator.test.ts`：Core relay/runtime stop 次序与错误状态。
- Chat gateway、relay death、Machine cleanup 相关测试保护“断 relay”和“停实例”的独立路径。

### 12.3 复用与共享

- `src/__tests__/round41-instance-service.test.ts`：`ensureRunning` 复用、实例编号和 maxSessions 行为。
- `src/__tests__/environment-startup-lock.test.ts`：同 Environment 启动合并和失败后释放。
- `packages/chat-channel/src/channel/gateway-shared-relay.test.ts`：确定性 RCS ID、并发 acquisition、引用计数和共享 relay。
- Workflow lease/cleanup 测试：复用实例不被先结束的 run 误停。

### 12.4 取消与超时

- `src/__tests__/agent-chat-transport.test.ts` 及 Workflow transport round 测试：Abort/timeout、listener、relay 活动和 lease 释放。
- `packages/chat-channel/src/channel/session-channel-action.test.ts`、`packages/chat-channel/src/__tests__/session-channel-round27.test.ts`：`session/cancel` 转发与取消状态收敛。
- `packages/remote-runtime/src/__tests__/remote-transport.test.ts`、`remote-runtime.test.ts`：请求超时和 remote stop 容错。
- `src/__tests__/openai-chat-routes.test.ts`：AGT-00 以公开 streaming `Response` 保护“客户端 cancel 启动清理且迭代器完成”，故意不冻结重复 dispose 次数。
- `src/__tests__/agent-executor.test.ts`：AGT-00 以 fake timer 保护 Scheduler timeout、一次 executor 级 dispose 和竞争失败迭代器最终完成。

## 13. 已知缺口与提取风险

1. **OpenAI 流式重复 dispose**：`ReadableStream.cancel()` 和 `start().finally` 都调用 `turn.dispose()`；底层当前大体幂等，但 exact-once 不是基线契约。
2. **OpenAI 同步 prompt 缺口**：`turn.prompt(...)` 位于流式/非流式保护块之前；同步抛错时 route 尚未进入对应 `finally`，可能泄漏单轮实例。
3. **LaunchSpec 重复与 cwd 分裂**：编排构建两次，完整 runtime 配置再次取数；编排 cwd 不传插件，各插件/Chat 各自重算。
4. **Environment 读取有副作用**：Sandbox 解析会准备基础设施；重复调用依赖 `createOrReuse` 幂等，不能作为普通 repository read 搬迁。
5. **状态与协调仅进程内**：reservation、startup lock、Controller、Core、supplement、Workflow lease、Chat registry 都无法跨服务副本协调。
6. **Chat pair-key 文档陈旧**：六处已知 `instanceId + userId` 描述与实际三元键冲突，提取时容易错误合并不同 RCS session。
7. **远端孤儿风险**：Machine 断连/重连直接删除本地状态；remote stop 对断连/超时容错不抛，宿主无法确认远端 Agent 进程已结束。
8. **启动失败快照不完全收敛**：Core 会保留 error 诊断；若 runtime 创建前失败，后续 stop 可能因缺 runtime entry 再失败，依赖上层记录与后续清理。
9. **合成 ACP session 的意图不清**：30 秒超时后继续使用 synthetic `ses_*` 可能把连接失败推迟到 prompt 阶段；ARC-02 前不应把它固化为理想协议。
10. **Workflow 超时不主动终止 Agent turn**：它结束本地等待并释放租约/listener，但不发 `session/cancel`；复用实例上的远端计算可能继续。

## 14. 仅供 ARC-02 讨论：非权威、未冻结的候选签名

> **警告：以下签名只是从现状提炼出的讨论输入。ARC-02 尚未决定名称、字段、所有权、错误语义或 package 公开面；AGT-01 不得在 ARC-02 冻结前把它们当作契约。**

候选的资源边界是：AgentConfig 资源层完成授权、发布态检查、关联资源解析和密钥安全转换，产出不再需要 runtime 回读资源 repository 的输入。runtime/instance 层不接收 actor、role、授权 service、DB transaction 或资源 repository。

```ts
// 候选：资源层已校验、已解析、可直接启动的输入。
interface ResolvedAgentStartInput {
  launchSpec: AgentLaunchSpec;
  nodeId: string;
  engineType?: string; // 当前只在 local 路径由宿主决定
  source: "interactive" | "scheduled" | "system";
}

interface StartedAgentInstance {
  instanceId: string;
  nodeId: string;
}

// 候选资源端口：AgentConfig 只依赖这一最小能力。
interface AgentInstanceStarter {
  start(input: ResolvedAgentStartInput): Promise<StartedAgentInstance>;
}

// 候选 runtime 模块：形状接近当前 CoreRuntimeFacade，但并非确认的公共 API。
interface AgentRuntimeModule {
  launch(input: {
    instanceId: string;
    nodeId: string;
    engineType?: string;
    launchSpec: AgentLaunchSpec;
  }): Promise<RuntimeInstanceSnapshot>;
  refreshEnvironment(input: {
    instanceId: string;
    launchSpec: AgentLaunchSpec;
  }): Promise<RuntimeInstanceSnapshot>;
  connectRelay(input: { instanceId: string; sessionId?: string }): Promise<EngineRelayHandle>;
  stop(instanceId: string): Promise<void>;
  get(instanceId: string): RuntimeInstanceSnapshot | null;
  list(): RuntimeInstanceSnapshot[];
}
```

ARC-02 仍需明确：

- `instanceId` 由 `AgentInstanceStarter`、InstanceManager 还是 runtime 生成；
- `source` 属于实例域审计/配额输入，还是宿主策略元数据；
- `AgentLaunchSpec` 是否继续作为公共 DTO，以及 secret-safe/日志-safe 的转换边界；
- Environment、Machine、Sandbox 和 workspace 的“已解析”结果由哪个资源模块提供；
- relay 的句柄所有权、缓存层级和 session 参数是否属于 runtime 公共面；
- `refreshEnvironment` 属于 runtime、instance manager 还是更高层 session use case；
- `get/list` 快照是否属于 runtime 公共面，还是只经 InstanceManager 暴露；
- 可复用 acquisition（`ensureRunning`）、并发 reservation、Workflow lease 与 Chat 引用计数由哪个模块拥有；
- synthetic ACP session fallback 是否保留，以及取消/超时是否需要统一的结构化结果；
- 启动部分成功后的补偿协议、远程 stop 确认和跨进程协调如何表达。

在这些问题冻结前，当前实现和本文测试只用于防止无意行为漂移，不代表目标包必须复制现有状态碎片或技术债务。

## 15. AGT-00 验证结论与基线门禁

### 15.1 范围内验收

AGT-00 在基线 `ba8ab4d1737634b62042290c1735be8744d947bb` 上完成范围内验收：

- `openAgentSession` 成功释放、OpenAI 公开流取消和 Scheduler 超时三个变更测试组合运行：21 pass、0 fail；
- Orchestration Controller/Instance 生命周期测试：22 pass、0 fail；
- Core instance orchestrator 测试：12 pass、0 fail；
- Chat SessionChannel 取消测试：73 pass、0 fail；
- `bun run docs:build`、变更测试的 Biome 检查和 `git diff --check` 通过；
- 独立只读实现审查结论为 APPROVED；
- 变更范围只有本文和三个特征测试，没有修改生产代码、CE/EE 设计、workspace、SDK、schema 或 migration。

以上证据足以支持本文对当前 Agent runtime 调用链、所有权和故障边界的结论。

### 15.2 当前分支的全局 precheck 阻塞

`bun run precheck` 在同一工作树中未全绿：format、import-sort、server/web typecheck 均通过，但已有 4 条 lint warning，测试为 8207 pass、3 fail。失败项是：

1. `round46 知识库仓储真实行为 > 创建知识库返回持久化行`；
2. `round54 Web 通道路由 > Hermes 未初始化时返回断开状态`；
3. `AgentFormDialog SSR 初始展示 > 关闭时不渲染对话框内容`。

三项测试分别单独运行均通过（34/34、24/24、3/3），失败来自全量运行时的跨文件共享状态污染。4 条 warning 位于 Chat relay 错误清洗和 Skill route 类型处理，相关文件与上述失败测试文件均不在 AGT-00 diff 中。

这些问题不改变本文记录的 Runtime 事实，也不归 AGT-00 修复；为保持任务边界，本任务未修改相关生产代码或测试。但当前分支在它们修复前仍不能声明全局 merge gate 通过。后续应创建独立代码任务，分别清零 lint warning、消除 repository/Hermes/i18n mock 的跨测试污染，并以完整 `bun run precheck` 全绿作为完成条件。
