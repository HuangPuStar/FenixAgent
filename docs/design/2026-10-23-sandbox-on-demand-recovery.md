# 沙盒失联后的按需恢复设计

- 日期：2026-10-23
- 状态：用户已确认设计并授权实施；采用「进入时按需恢复」。
- 代码核对基准：`52a2da07b`，编写时工作区无未提交改动。
- 目标：沙盒因 OOM、退出等原因失联后，用户再次进入环境或点击重试，即可由主服务恢复连接或重建沙盒，继续启动原 Agent Instance。

## 1. 范围与方案选择

| 方案 | 收益 | 局限 | 本次选择 |
| --- | --- | --- | --- |
| 进入时按需恢复 | 请求触发，复用现有恢复链路，行为集中 | 无人访问时不主动修复，管理页可能暂时显示旧状态 | 采用 |
| 断连时同步降级 | 更及时地展示沙盒非健康 | 单独使用仍会被 runtime 的 `unknown` 门禁拦住 | 本次不做 |
| 后台周期对账 | 无人访问也能发现和修复故障 | 增加调度、退避与任务生命周期 | 本次不做 |

本次只增加进入流程的恢复前置步骤。不新增数据库结构、环境变量、后台定时器、外部 API 或通用恢复框架，不修改 OpenSandbox、沙盒内 acp-runtime、acp-link 协议及前端重连策略。

成功标准是「再次进入或主动重试可以恢复」。已经打开的页面在收到 `4500` 后自动恢复、管理页实时健康展示、自动重放中断的任务均不在本次范围。重建保留现有持久 Instance 身份、配置快照和挂载配置；容器内未持久化的数据不能保证保留。

## 2. 根因与已有能力

1. ACP Machine 断连后，`AgentInstanceRuntimeCoordinator.handleRuntimeDisconnect()` 将关联 runtime 置为 `unknown`，并记录断连的 `machineId`。
2. `ensureRuntime()` 对 `unknown` 提前报错。下游 `SandboxExecutionHandler.prepare()` 无法被调用，已有的 Provider 查询、恢复和重建机制因此失效。
3. 沙盒层已经检查 Machine 状态，但默认 `isMachineOnline()` 只读取数据库的 `online`，不能证明 ACP 已完成 clean-slate 和 transport 激活。
4. `SandboxRemoteReconciler.recreateRemote()` 销毁旧资源后没有调用显式删除路径使用的运行态释放入口，需要补齐这一恢复闭环。

`unknown` 本身是必要的安全保护：失联不代表远端进程已终止。只允许 clean-slate 确认、旧 Provider 资源确认不存在或销毁成功等确定事实解除它。

## 3. 职责与改动位置

| 位置 | 职责与拟修改内容 |
| --- | --- |
| `agent-instance-runtime-coordinator.ts` | 提供只读的断连恢复上下文，保留现有生命周期仲裁和 `unknown` 门禁 |
| `agent-instance-service.ts` | 在 `ensureInstanceRuntime()` 中执行沙盒恢复前置步骤，完成后重新调用 coordinator |
| `sandbox-execution-handler.ts` | 增加按已绑定 Machine 恢复现有沙盒的公开运行入口，与普通 `prepare()` 共用连接等待和恢复逻辑 |
| `sandbox-manager.ts` / `sandbox-remote-reconciler.ts` | 复用 Provider 操作与行锁，补齐确定终止后的清理，增加超时恢复时的资源身份复查 |
| Machine 公开运行入口、`MachineHostPort`、`host-wiring.ts` / `acp-ws-handler.ts` | 提供并装配严格的 ACP 就绪判定，替换沙盒流程对数据库 `online` 的单独依赖 |

固定依赖方向仍为 `agent-runtime → sandbox → machine`。Coordinator 不依赖沙盒领域；Runtime 只消费 Sandbox 的公开 service/DTO，不导入其 repository 或数据库模型。Sandbox 内部读取自己的实例记录并检查归属，不反向导入 Runtime。

Manager 当前 468 行、coordinator 455 行，修改后仍须不超过 500 行。优先把连接等待和请求合并留在已有的 execution handler，不为行数进行无关拆分。

## 4. 恢复入口与流程

正常请求仍走原路径；只有下列条件全部成立才增加恢复步骤：

1. Runtime 为 `unknown`，且保存了由断连事件写入的 `machineId`。停止失败、启动补偿失败等其他来源的 `unknown` 不参与。
2. 当前没有手动停止、删除或服务关闭意图。在飞操作先按现有仲裁规则结束，再重新判断，不能绕过原操作。
3. Sandbox 公开入口确认该 Machine 对应现有沙盒，且沙盒属主与持久 Instance 属主一致。不根据 Machine ID 前缀猜测，也不在找不到记录时重新创建已删除的业务沙盒。

数据流：

```text
已完成权限校验的进入 / 重试请求
  → ensureInstanceRuntime
  → 读取 coordinator 的断连恢复上下文
  → Sandbox 按 machineId 定位现有沙盒并校验属主
  → 复用恢复链路，等待严格 ACP 就绪
  → 由确定终止 / clean-slate 事实解除 unknown
  → 重新交给 coordinator 校验最新意图并 ensure
  → 启动原 instanceUid 的 Agent
```

恢复前置步骤在原 `ensure` 操作占槽之前完成，避免 clean-slate 等待该操作结束、该操作又等待 clean-slate 的循环。它不主动把 runtime 写成 `stopped`，不复用旧快照强行放行；恢复结束后仍通过 coordinator 的最新状态决定是否启动。

聊天、API、Workflow 都复用 `ensureInstanceRuntime()`，保持各自原有的持久 Instance 选择规则，不新增按入口划分的恢复实现。正常首次启动和主服务重启后没有断连上下文的请求，继续通过原 `prepare()`；其 ACP 等待同样使用严格就绪判定。

## 5. 沙盒恢复决策

| 观测结果 | 动作 |
| --- | --- |
| 当前 ACP 已完成 clean-slate、transport / 节点激活且连接有效 | 直接复用，不调用破坏性 Provider 操作 |
| Provider 明确返回 `stopped` | 尝试 `resume`，有界等待 ACP 就绪 |
| Provider 明确返回资源不存在 | 确认旧 runtime 不再存在并清理，再按原快照创建 |
| Provider 明确返回 `error` | 确认销毁旧资源后清理，再按原快照重建 |
| Provider 返回 `ready` / `creating`，但 ACP 不可用 | 有界等待；仍失败时复查连接和资源身份，再销毁重建一次 |
| Provider 请求超时、网络异常、认证失败或服务端错误 | 保留外部资源引用和原始错误，不把「查不到结果」当成「资源不存在」 |
| 重建后 ACP 仍未就绪 | 记录恢复失败并返回；本次请求结束，不循环重建 |

每轮最多一次原资源恢复和一次重建；若前面的协调步骤已执行过对应动作，后续等待失败不得重复执行。使用现有 Provider 请求超时和 `sandboxRuntimeConnectTimeoutMs`，不引入新的重试配置；完整调用有界，不承诺固定总秒数。

严格就绪判定由主服务现有连接 owner 提供，通过 Machine 的窄运行入口供 Sandbox 消费：有效 ACP socket、当前连接的 clean-slate 确认、transport 与节点激活均满足，且未被现有心跳机制判定失联。数据库 `ready` / `online` 和 Provider `ready` 都不能单独证明可用。不改变其他消费者对 `isMachineOnline()` 的既有含义。

## 6. 确定终止与状态收敛

1. 销毁成功或 Provider 明确证明旧资源不存在后，复用 `releaseMachineRuntime()` 的确定终止语义，收敛该机器的 Core、编排登记与关联 runtime。
2. 在创建新资源之前完成上述收敛；新资源创建失败也不能留下旧 runtime 永久 `unknown`，同时不得提前声称新资源可用。
3. 原资源恢复成功时，沿用 ACP 的 clean-slate 确认解除 `unknown`；仅收到注册或数据库 `online` 不放行。
4. 确定终止处理须释放旧执行与 session 配额，保留手动停止意图，并隔离旧 generation 的迟到通知。

同一沙盒可承载该用户的多个环境和 Agent Instance。沙盒重建会终止其上全部旧 runtime；只按当前请求启动目标 Instance，其他 Instance 在各自后续请求中启动，不批量重放任务。

## 7. 并发、取消与故障

1. **请求合并：** 按业务沙盒 ID 合并同一主服务进程内的整轮恢复 Promise，覆盖 Provider 操作和 ACP 等待；成功或失败后在 `finally` 删除，避免永久缓存失败。
2. **持久化协调：** Provider 变更沿用现有沙盒行锁。锁内重新读取当前状态、外部资源 ID 与有效连接；来自旧资源的等待超时不得销毁另一个请求已经创建的新资源。等待 ACP 必须在事务外，否则注册回写可能被行锁阻塞。
3. **操作优先级：** 恢复期间发生停止、删除、重启或关闭时，旧恢复结果不能覆盖新意图。每次破坏性操作前复查资源和恢复意图；恢复完成后的 Agent 启动仍由 coordinator 仲裁。
4. **取消：** 单个请求取消只取消自己的等待，不取消其他调用者共用的恢复。共用操作受已有 Provider / 连接超时约束；未取消的等待者继续获得同一结果。
5. **错误：** 保留原始原因和关联上下文；只有明确的连接超时或资源终态才进入重建分支，不能沿用现有宽泛 `catch` 把所有异常变成销毁重建。
6. **失败落库：** 不能在事务内写 `error` 后直接抛出、导致该状态随事务一起回滚。需要持久化失败状态时先提交失败结果，再在事务外传播原始异常；失败回写也须核对资源身份，不覆盖后来成功的状态。

多实例部署仍以既有数据库行锁协调 Provider 副作用；进程内 Promise 不被视为跨进程锁。跨进程请求等待后进入锁内，必须再次检查 ACP 就绪和资源是否已变化，而不是排队重复重建。跨主服务连接路由继续遵循现有部署模型，本次不引入分布式连接目录或租约系统。

## 8. 可观测性与兼容

复用 `@fenix/logger`，记录恢复开始、复用 / resume / 重建决策、确定终止、成功或失败及耗时。关联已有 `requestId`、`instanceUid`、业务沙盒 ID 和 Machine ID；不记录凭据、完整 Provider 响应或配置环境变量。

不新增 HTTP 接口、错误响应结构或 WebSocket 关闭码。本版允许恢复失败后用户再次进入或点击重试，不承诺已打开页面自动重连；因此不调整 `4500`、`1011`、`1012` 的策略。

## 9. 验收与实施顺序

1. **先固化故障：** 覆盖「启动成功 → Machine 断连 → runtime unknown → 同一 Instance 再次进入」，证明原实现无法调用恢复入口。
2. **打通最小闭环：** 增加受限恢复上下文、Sandbox 现有资源恢复入口、严格就绪读取和确定终止清理，使原故障通过。
3. **补齐边界：** 扩充以下回归，不扩展为后台调度或前端重连项目。

| 必测行为 | 预期 |
| --- | --- |
| 沙盒停止后重新进入 | 恢复原资源，Agent 可用，Instance 身份不变 |
| Provider 假健康但 ACP 永久断连 | 有界等待后重建一次，连接就绪后可进入 |
| 短暂断网，在等待期内重连 | 不销毁资源、不重复启动 runtime |
| 数据库 online，但尚无 clean-slate 或 transport | 继续等待，不能误报就绪 |
| Provider 超时 / 认证失败 / 5xx，或销毁失败 | 不误判资源不存在、不放行未知旧 runtime，错误可定位 |
| 旧资源已销毁，但新资源创建失败 | 旧 runtime 与配额已收敛，后续请求仍可重试 |
| 多标签页 / 多环境并发进入同一沙盒 | 共用恢复；晚到超时不销毁新资源 |
| 恢复期间手动停止、删除、重启或服务关闭 | 最新意图生效，旧结果不复活实例 |
| 某个等待者取消 | 其他等待者不受影响，失败不残留 Promise |
| 普通 Machine、非断连来源 unknown、其他用户沙盒 | 不触发沙盒自动恢复 |
| 旧 generation 的 disconnect / death 迟到 | 不覆盖已经恢复的运行态 |
| 聊天、API、Workflow 的 ensure 调用 | 共享修复，不改变各入口 Instance 选择和所有权 |

验证先运行相关 coordinator、instance service、sandbox execution / manager、Machine 就绪与宿主接线测试，再运行 `bun run fastcheck`、`bun run precheck` 和 `bun run docs:build`。本次不修改前端，前端生产构建不作为新增要求。

实施后把仍有效的按需恢复契约同步到 `docs/arch/19-sandbox.md` 和 `docs/arch/22-agent-instance-management.md`。回滚使用上一版本主服务，无数据库迁移；已发生的容器重建不因代码回滚而撤销。

## 10. 设计检查清单

- [x] 核对当前代码、相邻模块、工程规范与最近提交。
- [x] 确认需求、方案取舍与成功标准；用户选择只做进入时按需恢复。
- [x] 主题不涉及视觉交互，无需视觉伴侣。
- [x] 编写书面设计，保留单一恢复入口和已有依赖方向。
- [x] 自检范围、占位符、状态事实、并发、失败与验证要求。
- [x] 用户审查书面设计。
- [x] 设计通过后调用 writing-plans，形成逐项实现计划。

本文档按仓库约定保存在 `docs/design/`。当前未获创建 Git commit 的明确指令，因此仅写入文件，不提交。
