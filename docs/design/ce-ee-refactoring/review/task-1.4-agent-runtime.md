# 任务 1.4 执行计划与设计裁定：Agent Runtime、Machine 与 Sandbox

本文是阶段 2 任务 1.4 的执行计划与设计裁定记录。设计裁定已全部落定（见第九节），**W5 已交付**（第十节），**W1 已交付**（第十一节），**W2 已交付**（第十二节，含验收口径修正与台账重测），**W3a 已交付**（第十三节，Runtime port 定型），**W3b 已交付**（第十四节，消费方改调 port）；W4 设计已定稿、四项裁定已落（2026-09-21，见第十五节，W4a / W4b 两片）→ **W4a 已交付**（第十六节，端口 + 宿主绑定 + 4 文件反转），**W4b 已交付**（第十七节，删旧路径 + 消台账）；W6 设计已定稿、四项裁定已落（2026-09-21，见第十八节，W6a / W6b 两片）→ **W6a 已交付**（第十九节，测试 seam 与泄漏面机械收敛），**W6b 已交付**（第二十节设计、第二十一节交付记录，新契约面与测试 seam 归位）。**仅剩 W7 收口**（`precheck` / `build:web` / `docs:build` / 台账核对）。

任务目标见[阶段 2 执行计划 §1.4](../ce-ee-refactoring-stage-2-plan.md)，权威约束见[目标架构与开发规范 §2.3](../ce-ee-engineering-standards.md)（依赖矩阵）与 [§10.4](../ce-ee-engineering-standards.md)（Runtime 与基础资源验收）。

## 一、任务状态：W5、W1、W2、W3a、W3b、W4a、W4b、W6a、W6b 已交付（2026-09-21），W7 收口待办

| 证据 | 结论 |
| --- | --- |
| `docs/design/ce-ee-refactoring/review/` 只有 `task-1.2-*`、`task-1.3-*` | 无 1.4 实施记录 |
| git 历史无任何以 1.4 为目标的提交 | 未开工 |
| `packages/agent-runtime/fenix.module.ts` 注释：「当前返回的是 Runtime 服务端公开入口的整体表面，而不是收敛后的启动/停止/状态/回收 port」 | 第 2 条自述未完成（W3 范围）；W3a 已替换该工厂，注释同步改写 |
| `scripts/architecture/exceptions.json` 中 `owner: "1.4"` 共 **14 → 11** 条（W5 削 3 条，W2 削 0 条） | 剩余 11 条随 W3/W4、W6 处理；W2 的 `apps-boundary` 条目按职责面重写 rationale 而非删除（见 12.4） |
| 台账总数 **51 → 49**（W1 削 2 条 `owner: "1.5"` 的 `no-circular`，见 11.3；W2 无增删） | 包对指纹随边消失而失效，非 1.4 条目减少 |
| 台账总数 **20 → 19**（W4a 削 1 条 `owner: "1.5"` 的 `no-circular`，见 16.4；由门禁强制，非 1.4 条目减少） | 跨包代表边落回包内，指纹并入包内自环条目 |
| `owner: "1.4"` 共 **11 → 7** 条（W4b：增 1 条 `no-circular`、削 4 条 `agent-runtime-not-to-resources`、转 1 条给 §1.7，见 17.4） | 剩余 7 条随 W6 与既登记的既有债务处理 |
| 台账总数 **20 → 16**（W4b：命中 20 → 16；登记条目 48 → 44） | 4 条 `agent-runtime-not-to-resources` 的见证边随组装搬出消失，由门禁强制删除 |
| `owner: "1.4"` 共 **7 → 5** 条（W6a：门禁报 stale 削 2 条，含 `agent-runtime → resource-sandbox` 的 `no-circular`，见 19.4） | 剩余 5 条经 W6b-4 按实测复核改写（0 增 0 削），全部是同一 37 处环族在 6 个包对指纹下的代表边（见 21.4） |
| 台账总数 **44 → 40**（W6a：削 4 条，0 新增 0 改写） | W6a 的机械收敛结果；W6b-4 只改写 1.4 名下 5 条的计数与 `removeWhen`，条目数不变（见 21.4） |

**已交付**：W5「Machine/Sandbox 方向」——第十节；W1「依赖类型与配置 seam」——第十一节；W2「宿主接缝收敛」——第十二节；W3a「Runtime port 定型（契约面）」——第十三节；W3b「消费方改调 port」——第十四节；W4a「端口 + 宿主绑定 + 4 文件反转」——第十六节；W4b「删旧路径 + 消台账」——第十七节；W6a「测试 seam 与泄漏面机械收敛」——第十九节；W6b「新契约面与测试 seam 归位」——第二十一节。**W4 设计已定稿**（第十五节，四项裁定：组装落点 A / 端口方向 pull / 测试按断言面改写 / 第二端口 A）。**W6 设计已定稿**（第十八节，四项裁定：拆 W6a/W6b / 跨包测试用例能走 port 就走 port / 观测取数扩 `/runtime` 只读面 / 删冗余 tsconfig 别名；W6b 三处形状由第二十节补裁）。**未开工**：W7 收口（`precheck` / `build:web` / `docs:build` / 台账核对）。

阶段 1（`fa2bbaef0`「迁移 Runtime 与 Chat 残留」等）已完成的是**物理归属**：Environment、Instance、relay、ACP session、Chat、YJS 的代码已在 `packages/agent-runtime`，Machine/Sandbox 已是独立包。1.4 要的是**接口收窄与依赖方向**，这部分未动。

## 二、冻结区（用户红线，2026-09-20）

用户裁定：**"实例起来之后怎么管"（状态机、幂等、lease、并发限流、disconnect fencing、dispose、重连）不动。**

### 2.1 冻结文件清单

以下文件在 1.4 全周期内只允许 `import` 行变更，任何逻辑改动一律拒绝：

| 文件 | 行数 | 宿主依赖 | 入边绝缘性 |
| --- | --- | --- | --- |
| `src/server/services/agent-instance-service.ts` | 262 | 0 | 走包内 `./core-runtime-port`；repo 走 `IAgentInstanceRepo` 接口 |
| `src/server/services/agent-instance-runtime-coordinator.ts` | 293 | 0 | 只 `import type { AgentInstanceRecord }` |
| `src/server/transport/relay/relay-handler.ts` | 49 | 0 | — |
| `src/server/transport/relay/lifecycle-port.ts` | 43 | 0 | — |
| `src/server/transport/relay/external-relay.ts` | 342 | 0（1 类型） | 仅 `import type { AuthContext }`、`WsConnection` |
| `src/server/transport/agent-relay.ts` | 40 | 0 | — |
| `src/transport/event-bus.ts` | 112 | 0 | — |
| `src/services/environment-startup-lock.ts` | 34 | 0 | — |
| `src/services/session.ts` | 64 | 0 | — |
| `src/services/environment.ts` | 44 | 0 | — |

### 2.2 绝缘性实测证据

冻结区不被反向穿透的三个事实：

1. **核心服务已走包内 port。** `agent-instance-service.ts:12` 是 `import { getBoundCoreRuntime as getCoreRuntime } from "./core-runtime-port"`，而 `agent-concurrency.ts:4`、`acp-idle-monitor.ts:13` 仍从 `@server/services/core-bootstrap` 取。包内 port 已被核心服务验证，两个落网文件只需换 import。
2. **repository 在接口后面。** `agent-instance-service.ts:4` 依赖 `IAgentInstanceRepo` 类型，`repositories/agent-instance.ts` 内部 `db` / 表来源怎么换，服务层感知不到。
3. **协调器与 relay 只吃类型。** 见 2.1 表。

### 2.3 回归网（冻结区验收依据，均已在门禁内）

`agent-instance-runtime-coordinator.test.ts`（generation fencing）、`agent-concurrency-toctou.test.ts`（用户/总量窗口、失败释放配额、release 幂等）、`instance-concurrency.test.ts`、`session-async-cleanup.test.ts`、`local-instance-death-cleanup.test.ts`、`instances-delete-idempotent.test.ts`、`external-relay.test.ts`。

## 三、口径裁定：允许改动的边界

### 3.1 边界定义

> **"实例起来之后怎么管"不动；"实例起来之前拿什么参数"（取 agentConfig、组装 LaunchSpec）要搬走。**

按此口径，1.4 对 `agent-runtime` 的改动只允许三类：

| 类型 | 说明 | 涉及文件 |
| --- | --- | --- |
| 类型搬家 | `import type` 改指包内或 platform-sdk 类型，零行为变化 | `instance-registry.ts`、`environment-core.ts`、`environment-acp.ts`、`agent-instance-runtime-projection.ts` |
| seam 替换 | 值依赖改经注入 port / options，算法不动 | `agent-concurrency.ts`（3 个配置值 + `getCoreRuntime`）、`acp-idle-monitor.ts`（同上）、`acp-ws-handler.ts`（`config.wsKeepaliveInterval`）、`repositories/{agent-instance,environment}.ts`（`db` + 表来源） |
| 职责搬出 | `launch-spec-builder` 迁往 AgentConfig Facade | `orchestration-instance.ts` 2 个调用点 + 宿主 1 处绑定 |

### 3.2 LaunchSpec 搬出的爆炸半径实测

`buildLaunchSpec` / `buildBasicLaunchSpec` 在生产代码中**只有一处调用点**：`orchestration-instance.ts:464`、`:489`，位于 `spawnInstanceViaController` 内部。而 `spawnInstanceViaController` 已经挂在宿主绑定的 port 上（`apps/server/src/main.ts:272-273` 的 `bindAgentInstanceRuntimeOperations`）。宿主侧 `setRuntimeCredentialResolver` 只有 `main.ts:345` 一处绑定。

**结论：搬走 LaunchSpec 组装 = 改 2 个调用点 + 1 处宿主绑定，不形成级联。**

### 3.3 台账削减的粒度警告

`scripts/architecture/exceptions.json` 的指纹是**包对级**（规则 + 来源包 + 目标包），不是文件级。因此：

- `agent-runtime → @fenix/server-app`（`apps-boundary`）必须在 **22 个非测试文件全部清理后**才能删除；
- `agent-runtime-not-to-resources` 的 5 条各自成对，需分别清干净。

**切片交付 ≠ 台账削减。** 中间切片只产出行为改善与文件级清理，台账在对应包对全清的那一批统一删除。

## 四、Runtime port 方案（已评审）

### 4.1 现状实测

`packages/agent-runtime` 内共 10 个 `bind*Port`，**全部是宿主 → Runtime 注入**（Runtime 是消费方），没有一个是 Runtime 对外的启动/停止/状态/回收 port：

| Port | 定义 | 绑定 |
| --- | --- | --- |
| `CoreRuntimePort` | `server/services/core-runtime-port.ts:14` | `main.ts:252` |
| `MachineRegistryPort` | `server/services/machine-registry-port.ts:2` | `main.ts:253` |
| `SessionEventBusPort` | `server/services/session-event-bus-port.ts:4` | `main.ts:254` |
| `LocalNodeAgentNodeServicePort` | `server/services/local-node-agent-node-service-port.ts:4` | `main.ts:258` |
| `FileWsPort` | `server/services/file-ws-port.ts:2` | `main.ts:262` |
| `AgentInstanceRuntimeOperations` | `server/services/agent-instance-service.ts:17` | `main.ts:272` |
| `EnvironmentAcpLifecyclePort` | `src/services/environment-core.ts:17` | `main.ts:280` |
| ACP 实例活跃度回调 | `src/server/transport/acp-ws-handler.ts` | `main.ts:284` |
| `RelayLifecyclePort` | `server/transport/relay/lifecycle-port.ts:2` | 包内 `chat-channel-bootstrap.ts:155` |

其中 `AgentInstanceRuntimeOperations`（`spawnInstance` / `stopInstance` / `hasActiveInstance`）是唯一的反向 seam，三动词、无 reclaim、无独立 status。

对外出口是 `src/server.ts`（61 行）的整体 re-export。消费面实测：**9 个包/应用、31 个非测试文件**（`apps/server`、`agent-config`、`channel`、`machine`、`mcp`、`observer`、`prod-view`、`task`、`workflow`；`knowledge` / `memory` / `sandbox` / `skill` 只在注释里提及，无实际导入）。

未达成的两个硬指标：
- `platform-sdk` 下**零** runtime 契约（`index.ts` / `server.ts` 零命中）；
- `src/server.ts` 无任何按能力收窄的 port 面。

### 4.2 消费方调用清单（按 port 能力归组）

| 能力组 | 当前被调用的符号 | 消费方 |
| --- | --- | --- |
| **启动** | `spawnInstanceViaController`、`createWebEnvironment`、`agentInstanceService.{resolveInstanceForOperation,ensureInstanceRuntime}`、`openAgentSession`、`createAgentSession`、`startPromptTurn`、`connectAgentRelay`、`markInstanceRelayAttached/Detached`、`refreshInstanceEnvironment`、`terminateLocalDeadInstance` | apps/server、agent-config、task、workflow、prod-view |
| **停止** | `stopInstanceViaController`、`stopInstancesForEnvironments`、`closeAcpConnectionsForEnvironments`、`closeAllAcpConnections`、`closeAllRelayConnections`、`cleanupOrchestrationInstancesForMachine`、`stopInstance` | apps/server、agent-config、workflow |
| **状态** | `getOwnedEnvironment`、`listEnvironmentsWithInstances`、`listInstanceActivitySnapshotsWithUsers`、`touchInstanceActivity`、`findRunningInstanceByEnvironment`、`getEnvironmentBySecret`、`getSession`、`resolveExistingSessionId`、`updateSessionStatus` | apps/server、channel、mcp |
| **回收** | `startAcpIdleMonitor`、`stopAcpIdleMonitor`、`bindAcpInstanceActivityPort`、`globalInstanceRegistry` | apps/server |
| **内部实现泄漏（不属于任何 port）** | `environmentRepo`、`agentInstanceRepo`、`getAllEventBuses` / `getEventBus` / `removeEventBus` / `removeAcpEventBus`、`listAcpConnections`、`listExternalRelayEntries`、`resolveWorkspacePath`、`EnvironmentRecord` | machine(7)、observer(4)、workflow(3)、apps/server |

最后一行是本任务要消除的重点：`observer` 直接吃 repository 与 relay 内部状态，`machine` 直接吃 `environmentRepo` / `getOwnedEnvironment` / `resolveWorkspacePath`，`workflow` 直接吃 `environmentRepo`。

### 4.3 建议的 port 面

落点建议 `packages/agent-runtime/src/runtime.ts`，经**独立子路径**导出（如 `@fenix/agent-runtime/runtime`），与现有宿主注入 port 分向：

```ts
/** Runtime 对外唯一公开运行入口。只接受已授权的通用启动输入，不解释 actor/role/visibility。 */
export interface AgentRuntimePort {
  // —— 启动 ——
  ensureInstance(input: EnsureInstanceInput): Promise<InstanceHandle>;
  // —— 停止 ——
  stopInstance(instanceUid: string, mode: RuntimeStopMode): Promise<void>;
  stopInstancesForEnvironments(environmentIds: string[]): Promise<string[]>;
  restartActiveInstancesForEnvironments(environmentIds: string[]): Promise<string[]>;
  // —— 状态 ——
  getInstanceStatus(instanceUid: string): InstanceStatusSnapshot | null;
  listInstances(input: ListInstancesInput): Promise<InstanceSummary[]>;
  findRunningInstanceByEnvironment(environmentId: string): Promise<InstanceRef | null>;
  // —— 回收 ——
  closeConnectionsForEnvironments(environmentIds: string[]): void;
  closeAllConnections(): void;
  cleanupInstancesForMachine(machineId: string): Promise<void>;
  shutdown(): Promise<void>;
}
```

`EnsureInstanceInput` 的**形状是第四节的核心未决项**，见 4.4。

### 4.4 启动入口的形状：设计已给定，是方案 A

权威依据 [§2.2](../ce-ee-engineering-standards.md) 的依赖图**已明文给出目标形状与 port 名字**：

```text
skill ────────┐
mcp ──────────┼──→ agent-config ──→ 已授权的启动参数
model ────────┘                         │
                                      AgentInstanceStarter port
                                             │
apps/server 注入 AgentInstanceManager ──────┘
```

即：**AgentConfig Facade 完成 `use` 授权与引用校验后产出「已授权的启动参数」，再调用 `AgentInstanceStarter` port；port 的实现（Agent instance manager）由 `apps/server` 注入。** 这与 [§1.3(3)](../ce-ee-refactoring-stage-2-plan.md) 和 [§10.4.1](../ce-ee-engineering-standards.md) 一致。

因此 4.3 的 `ensureInstance` **接受调用方传入的已授权 `launchSpec`，不接受 `environmentId` 由 Runtime 自行取数**。`AgentInstanceStarter` 目前全仓 0 命中（1.3 review 记录），需新建。

**W3a 实施时对该措辞的澄清（结论：`EnsureInstanceInput` 不带 `launchSpec` 字段）**——本节上一段的措辞容易被读成「`/runtime` 的 `ensureInstance` 要新增一个 `launchSpec` 入参」，实现时按下述事实落地：

- 图里的 `AgentInstanceStarter` 与 `/runtime` 的 `AgentRuntimePort` 是**两个不同方向的 port**：前者由 `apps/server` 实现（即 §4.1 表中 `main.ts:272` 绑定的 `AgentInstanceRuntimeOperations` 三动词），被 `agent-config` Facade 调用；后者由本包实现，被三条链路的编排层调用。用户红线也把这两件事分开了——「实例起来之后怎么管」不动，「实例起来之前拿什么参数」搬走，而搬走的目标是 W4 的 `AgentInstanceStarter`，不是 W3 的 port 入参。
- 现状的 launchSpec 传递链是：`resolveInstanceForOperation` → `ensureInstanceRuntime` → coordinator → `runtimeAdapter.start` → `AgentInstanceRuntimeOperations.spawnInstance` → `spawnInstanceViaController` → `buildLaunchSpec`。W4 的改动点在 **`spawnInstance` 这一步**（换掉 spec 的来源与组装方），与 `ensureInstance` 的入参形状无关。
- 因此 `EnsureInstanceInput` = `{ environmentId, ownerUserId, requestedInstanceUid?, automaticSelection, signal? }`，即 `resolveInstanceForOperation` 现有入参的形状；`ensureInstance` 的语义是「哪个环境的哪个属主要哪一类实例」，不是「拿什么参数起进程」。若把它改成吃 `launchSpec`，W3 就必须同时把「取 agentConfig + 组装 spec」搬进来，与用户红线相反。

**仍需裁定的残余问题**：Workflow lease、chat-channel、MCP、idle monitor 这些**内部触发方没有 actor**。现状是靠 `src/services/actor-context.ts:35` 的 `toActorContext()` **伪造 `role: "owner"`** 绕过——该文件自述是过渡副本。按 A 的形状，这些触发方必须先经 Facade，因此必须明确它们的 actor 表达（系统托管 actor / 显式传入触发方身份 / 内部路径不做资源授权），否则 `use` 授权在内部路径上仍形同虚设。

### 4.5 LaunchSpec 存在两条并行路径（W4 的真实规模）

`packages/orchestration/src/launch-spec/launch-spec-builder.ts:31` 已有 `class LaunchSpecBuilder`（107 行，**全部依赖由宿主/调用方注入**），产出编排域的扁平 `LaunchSpec`；`packages/agent-runtime/src/services/launch-spec-builder.ts` 的 `buildLaunchSpec`（663 行）产出 plugin-sdk 的 `AgentLaunchSpec`。

两者**必须保留到启动链路**，因为编排域的扁平投影「不含 model 密钥 / skills 下载地址 / MCP 详细配置」（`orchestration-instance.ts:426-429` 原文），core 需要的是增强后的 spec。当前 `spawnInstanceViaController` 的流程是：编排域 `LaunchSpecBuilder` 建扁平 spec → `buildAgentLaunchSpecForCore` 再读一次 DB 建增强 spec。

`buildLaunchSpec` 直接读了**6 张别人家的表**：

| 表 | 归属 owner |
| --- | --- |
| `model`、`provider` | `model-management` |
| `skill`、`agentConfigSkill` | `skill`（关联表归属待核） |
| `mcpServer`、`agentConfigMcp` | `mcp` |

按 [§2.2](../ce-ee-engineering-standards.md)，资源 A 不得导入资源 B 的 repository/表，必须依赖 B 包根入口公开的 Domain Service。因此 W4 不只是搬家，还需：

1. `skill` / `mcp` / `model-management` 各自把被读取的能力补成包根入口的公开 Domain Service；
2. `agent-config` Facade 依赖这些 service（§2.2 明文允许的方向），组装出已授权的 `AgentLaunchSpec`；
3. `agent-runtime` 删除 `buildLaunchSpec` / `buildBasicLaunchSpec`（663 行）与 `actor-context.ts`（42 行）；
4. 裁定编排域 `LaunchSpec` 与 core `AgentLaunchSpec` 是否收敛——若不收敛，需明确两者的长期职责边界并写入文档，避免形成第三套。

该文件自述：「当前保留现有实现作为运行时权威路径，后续可随 Chat 域重构进一步收敛。」

### 4.6 与既有 port 的关系

- 现有 10 个宿主 → Runtime port **全部保留**，它们是 Runtime 的运行基础能力，与对外 port 方向相反、职责不重叠。
- `AgentInstanceRuntimeOperations` 是包内装配 seam（宿主绑定的是本包自己的 `spawnInstanceViaController`），**不升级**为对外 port，随 4.3 的 port 面定型后由 port 实现内部持有。
- `fenix.module.ts` 的 `create: () => import("./src/server")` 在 4.3 落地时替换为 port 工厂。

## 五、依赖方向收敛（Machine / Sandbox）

权威方向：`agent-runtime → sandbox → machine` 及 `agent-runtime → machine`，反向禁止。

> 本节 5.1–5.3 是 **W5 动手前**的实测与计划（保留以对照）；**已交付状态、逐条改法与台账实际削减数见第十节**。

### 5.1 `machine → agent-runtime`（6 个非测试文件）

| 文件 | 使用符号 | 作者预留的收敛路径 |
| --- | --- | --- |
| `src/server/environment-port.ts:15-16` | `environmentRepo`、`getOwnedEnvironment`、`EnvironmentRole`(type) | 文件注释已写明：改为宿主绑定 `bindMachineEnvironmentPort`，调用方无需改动 |
| `src/server/services/machine-runtime.ts:1` | `getBoundCoreRuntimePort` | 改宿主绑定 |
| `src/server/services/registry-heartbeat.ts:108` | **动态 import** 后取 `findMachineConnectionById`、`triggerMachineCleanupByMachineId`（WS 巡检判定 machine 断连并触发 relay 清理） | 需新增 Machine 侧可注入的「连接查询 + 清理触发」句柄 |
| `src/server/services/file-machine-events.ts:20` | `getBoundCoreRuntime` | 改宿主绑定 |
| `src/server/services/workspace-fs.ts:5` | `resolveWorkspacePath` | 改宿主绑定或包内实现（纯函数，重实现成本低） |
| `src/services/event-service.ts:15` | `getEventBus`、`getAcpEventBus`、`getAllEventBuses`、`removeEventBus`、`removeAcpEventBus`、`EventBus`(type)、`SessionEvent`(type) | 事件总线目前由 agent-runtime 持有；需裁定归属或经 port |

（`src/server.ts:4` 仅注释提及，不计入。）

### 5.2 `machine → sandbox`（2 个文件）

| 文件 | 使用符号 |
| --- | --- |
| `src/server/services/remote-file-service.ts` | `findActiveSandboxInstance`、`findReadableSandboxPoolById`、`getSandboxConfig` |
| `src/server/testing.ts` | `createSandboxModuleConfig`（`/server/testing`） |

`remote-file-service.ts` 里「查询沙盒实例判定文件是否可读」就是台账登记的 `machine → sandbox` 反向边。消除方式是：把「文件是否可读」的判定改为由 sandbox 侧主动传入（sandbox 已按 `dependsOn: ["machine"]` 依赖 machine，方向天然成立），而不是 machine 反向查询。

### 5.3 消除后的 manifest 与台账

- `packages/resources/machine/package.json` 删除 `@fenix/agent-runtime`、`@fenix/resource-sandbox` 两条 workspace 依赖。
- `machine/fenix.module.ts` 中「反向边已登记为 special-dependency（owner 1.4，须消除）」的注释按新事实重写。
- 台账删除 7 条（按包对引用，索引会随台账增删漂移）：
  - `special-dependency`：`@fenix/resource-machine → @fenix/agent-runtime`、`@fenix/resource-machine → @fenix/resource-sandbox`
  - `no-circular`：`@fenix/resource-machine → @fenix/resource-machine`、`@fenix/resource-machine → @fenix/resource-sandbox`、`@fenix/resource-sandbox → @fenix/resource-machine`、`@fenix/resource-sandbox → @fenix/resource-sandbox`、`@fenix/agent-runtime → @fenix/resource-sandbox`
- `sandbox → machine` 的 `dependsOn: ["machine"]` 保持不变。

## 六、三条链路与边界测试的收尾

### 6.1 三条链路（§1.4 第 4 条）

主体已收敛（`agent-chat-service`、workflow `agent-chat-transport`、chat-channel translator 均在）。剩余碎片：

- `extractJsonRpc` 仍有 2 份私有副本：`packages/resources/workflow/src/server/services/workflow/agent-chat-transport.ts:47`、`apps/server/src/services/openai-response-mapper.ts:33`。应改指 `@fenix/chat-channel` 的统一实现。
- `agent-runtime → @fenix/chat-channel` 的 3 处值导入（`web/agent-panel/ChatPanel.tsx:6`、`web/yjs/doc-hub.ts:19`、`web/yjs/yjs-ws.ts:7`）触发 `no-cross-package-src`。§1.6 已裁决把投影层交还 `packages/chat-channel/web/lib/`，随本任务或 §1.6 同批处置（需与 1.6 确认归属，避免两边都做或都不做）。

### 6.2 边界验证（§1.4 第 5 条）

8 个边界项**已全部覆盖**，两处强度缺口待补：

| 缺口 | 现状 | 补法 |
| --- | --- | --- |
| 「不回退本地」只用 503 错误契约间接证明 | `agent-file-service.test.ts:362`、`fs-routes-converged.test.ts:397`、`remote-machine-id-three-way.test.ts:56` | 补一条直接断言：配了 machine 且 file-ws 未连时执行写/上传后，`WORKSPACE_ROOT/<org>/<user>/<env>` 下无新文件 |
| acp-ws 路由层上限无路由级测试 | 守卫函数已在 machine 包测透（`file-ws-payload.test.ts`），但 `routes/acp/index.ts:26,39,40` 的 `MAX_WS_MESSAGE_SIZE = 10MB` 调用点未覆盖 | 补路由级超限用例 |

## 七、垂直切片划分

每片保持可运行、可测试、可回滚；**冻结区（第二节）在全部切片中只允许 import 行变更**。

| 切片 | 范围 | 产出 | 台账影响 |
| --- | --- | --- | --- |
| **W1 依赖类型与配置 seam** ✅ 已交付（2026-09-20，见第十一节） | 4 个文件的类型搬家；`agent-concurrency.ts`、`acp-idle-monitor.ts` 换用包内 `getBoundCoreRuntime`；7 个运行态配置值改模块配置注入 | 非测试代码中 `@server/config`、`@server/types/*`、`@server/services/core-bootstrap` 归零（按文件收敛口径，见 11.2） | 实测削 2 条（原预测「无」）：两条 `owner: "1.5"` 的 `no-circular` 因跨包见证边消失而失效，见 11.3 |
| **W2 宿主接缝收敛** ✅ 已交付（2026-09-20，见第十二节） | `@server/db` + `@server/db/schema` 换 owner 侧入口（含表归属裁定）；`@server/plugins/auth` 认证上下文裁定；`cache` / `openai-response-mapper` / `transport` / `config-utils` / `org-context` / `repositories` 收口；消除 `routes/acp/index.ts` 对 `@server/routes/web/environments` 的反向依赖 | 非表定义宿主导入 **30 行 / 14 文件 → 11 行 / 8 文件**（消 19 行 / 6 类）；残留 5 行归 W4「启动前取数」、6 行表定义归 §1.7——「22 个文件全清」口径已按裁定修正，见 12.1 | 实测削 **0** 条：按裁定「按职责面收敛 + 表定义显式豁免」，`apps-boundary`（`@fenix/agent-runtime → @fenix/server-app`）不删、改写 rationale，见 12.4 |
| **W3a Runtime port 定型（契约面）** ✅ 已交付（2026-09-20，见第十三节） | 落 `src/runtime.ts`（`AgentRuntimePort` 管理面 33 方法 + `AgentRuntimeSessionApi` 数据面 6 方法 + `createAgentRuntimeModule`）；`package.json` 增 `./runtime` 子路径；`src/server.ts` 收窄为逐行角色标注的清单（嵌套 barrel 不再透传）；替换 `fenix.module.ts` 工厂；新增 port 契约测试 | 契约面定型，**不改符号可达性**（实测 314 → 314 名，零增零减）；消费方本片不动 | 无 |
| **W3b 消费方改调 port** ✅ 已交付（2026-09-21，见第十四节） | 非测试消费文件改调 `/runtime`；删除已迁走符号；去掉 `main.ts` 的 `bindAgentInstanceRuntimeOperations` 转发（§4.6） | 13 个生产文件改调 port；`server.ts` 导出面 314 → 233；剩余 14 个 barrel 消费方全部属「宿主注入 / 协议 / 错误映射 / 泄漏(W6)」 | 实测削 **1** 条（`no-circular` @fenix/resource-machine → @fenix/agent-config，环的见证边消失），见 14.8 |
| **W4 启动前取数搬出**（2026-09-21 裁定拆两片，设计见第十五节） | **W4a（只加不删）**：`skill` / `mcp` / `model-management` 补包根公开 Domain Service（6 张表的读取）；`agent-config` 补「组织范围读」系统入口（§9.1）；Facade 组装已授权 `AgentLaunchSpec` 并调新建的 `AgentInstanceStarter` port；宿主绑定实现。**W4b（删旧路径）**：`launch-spec-builder`(663) 与 `actor-context.ts`(42) 从 agent-runtime 删除；按 §9.2 删 `packages/orchestration/src/launch-spec/`(107)；台账收口 | 消除 `agent-runtime-not-to-resources` 的服务端命中 | W4b：删 `agent-runtime-not-to-resources` **4 条**（knowledge / agent-config / memory / skill）；`model-management` 条**不删**——见证边是 `web/components/chat/composer-toolbar.tsx` 的前端共享别名，按 §15.2-2 改写 removeWhen 并转 §1.7 |
| **W5 Machine/Sandbox 方向** ✅ 已交付（2026-09-20，见第十节） | machine 6 处 + sandbox 2 处反转换 port；package.json 与 manifest 同步 | 方向固定为 `agent-runtime → sandbox → machine` | 实测删 3 条（§5.3 预测的 7 条中有 4 条仍是真实违规，原因见 10.4） |
| **W6 链路与边界补强** | 2 份 `extractJsonRpc` 副本收口；chat-channel 值导入归属；2 处边界测试缺口 | 第 4、5 条验收 | 删 `no-cross-package-src:packages/chat-channel`（与 §1.6 同批） |
| **W7 收口** | `bun run precheck`、`bun run build:web`、`bun run docs:build`、台账核对、本文件收尾 | 全绿证据 | 复核 14 条 1.4 条目全部消除或按新事实重登记 |

**依赖关系**：W1 → W2 → W3；W3 与 W4 需同批设计（见 4.4）；W5、W6 与 W1-W4 无耦合，可并行或提前。**W5 是唯一不依赖 port 形状裁定、可独立收口的切片。**

## 八、验收与证据

- 第 1 条：`agent-runtime` 单包边界不变；`core` / `orchestration` / `chat-channel` / `remote-runtime` 未被合并（用 `git grep` 核对无新增跨包 src 导入）。
- 第 2 条：`src/server.ts` 收窄为 port 面；`agent-runtime` 非测试代码中资源包导入归零（`bun run check:dependencies` 对应条目删除）；`grep -rn "toActorContext"` 归零。
- 第 3 条：`bun run check:dependencies` 中 machine/sandbox 相关 7 条全删；`packages/resources/machine/package.json` 无 `@fenix/agent-runtime` 与 `@fenix/resource-sandbox`。
- 第 4 条：三条链路共用同一 relay/ACP 规则；`extractJsonRpc` 全仓仅 `packages/chat-channel/src/protocol/acp-channel.ts` 一处实现。
- 第 5 条：8 个边界项测试齐备 + 2 处补强。
- 冻结区：2.3 的回归网全绿，且冻结文件 diff 仅含 import 行。
- 全量：`bun run precheck`、`bun run build:web`、`bun run docs:build` 全绿。注意按既有约定用 `env -u ANTHROPIC_MODEL` 规避会话注入变量导致的 acp-link 测试失败。

## 九、设计裁定（2026-09-20 评审通过）

评审结论已全部落定，1.4 不再有待裁定项。

### 9.1 内部触发方的 actor 语义 → 维持真实用户身份，消除伪造的 `role`

**实测结论：现有语义不是「需要引入系统主体」，而是「已经是真实用户身份」，且比预设的三个候选更严。**

| 触发方 | 身份来源 | 附加校验 |
| --- | --- | --- |
| Workflow | `options.userId`（run 执行上下文） | 必须 `=== envRow.userId`，缺失 fail-closed 抛 `INSTANCE_OWNER_REQUIRED` |
| chat-channel | 连接用户 | 必须 `=== environment.userId`（`authorizeEnvironment`） |
| MCP / meta-agent | `ctx.userId` | meta env 按 `(orgId, userId, name)` 三元组隔离 |
| prod-view | `actor.userId`（观看者） | — |
| HTTP / OpenAI | 真实 `AuthContext` | — |
| `/web` environments | env 属主 `record.userId` | 已校验归属 |
| idle monitor | 不 spawn，只 stop | 不参与启动授权 |

Runtime 内部 `runtimeAdapter.start()` 传的是 `instance.ownerUserId`（`agent-instance-service.ts:59`），组织上下文取 `env.organizationId`。**没有任何一处使用 system 主体或授权豁免**，故不引入新的主体概念。

**唯一偏差**：四处 `toActorContext({ ..., role: "owner" })` 的 `role` 是硬编码假值。

- 行数据层无越权：`read` 在 `memberDefaultActions` 内，owner 与 member 读到的行一致。
- `access` 元数据虚高：`facade.getById` 经 `withAccess(actor, row)` 返回含 `access: ResourceAccess` 的对象，而 owner/admin 取全量动作、member 只取 `memberDefaultActions`（`access-control/src/policy/policy-facts.ts:76`）。当前唯一调用点只取数据字段，故为定时炸弹而非现行漏洞。

**裁定：按 `agent-config/src/server/system-entries.ts` 既定的入口分工消除伪造。** 该文件注释已把「LaunchSpec 构建」归入 `getAgentConfigById` 一类，并写明「这些路径已经持有环境/实例 ID 并校验过归属，再要求一个 actor 只会导致调用方伪造身份」。

做法：在 `system-entries.ts` 补一个「组织范围读」入口（归属组织相同、或资源对其他组织公开可读，**不接受 `ActorContext`**），四处调用点改走它；`agent-runtime/src/services/actor-context.ts` 随之删除（其「移除条件」正是宿主协议收敛后删除）。

**不采用「改走 `getAgentConfigById`」**：该入口严格要求归属组织一致，而 `createWebEnvironment:156` 的绑定校验允许跨组织公开资源，会造成「创建通过、启动 404」的不一致。

### 9.2 两条 LaunchSpec → 收敛为一条

编排域只消费 core 的 `AgentLaunchSpec`，删除 `packages/orchestration/src/launch-spec/`，消除「先建扁平 spec、再重读 DB 建增强 spec」的双路径。会改动 `packages/orchestration`，纳入 W4 同批。

### 9.3 表归属 → 1.4 只换 db 来源，表定义迁 §1.7

`environment` / `agent_instance` 的表定义迁入 `agent-runtime/db/schema.ts` 属 §1.7 的 schema 收敛批次。1.4 的 W2 只把 `repositories/*.ts` 的 `@server/db` 换成 owner 侧入口，不改 DDL、不动迁移链。

### 9.4 三条 Elysia 路由 → 工厂化留包内，contributions 留 §1.5

1.4 只把 `routes/acp/index.ts`(401)、`routes/api/instances.ts`(107)、`routes/api/openai-chat.ts`(188) 从 `src/server.ts` 的整体 re-export 改为宿主可挂载的工厂，并改吃注入的认证上下文；`contributions` 声明与挂载机制留 §1.5。与 `machine` / `sandbox` manifest 注释「当前宿主按显式调用装配，不形成第二套装配路径」保持一致。

### 9.5 配置 seam → 1.4 只注入、不接管道

宿主 `apps/server` 仍从 `apps/server/src/env.ts` 读值，在装配点按模块分组注入 `initializeApplicationInfrastructure({ moduleConfigs: { "agent-runtime": {...} } })`；包内改走 `getModuleConfig<AgentRuntimeEnv>("agent-runtime")`。

`main.ts:163` 的 `loadServerEnv([])` 汇总模块 `envDefinitions` 的管道**不在本任务接通**，留 §1.5，避免与其撞车；故 `agent-runtime` 本任务不声明 `envDefinitions`。

### 9.6 `machine → sandbox` 文件可读判定 → W5 内提案，本任务自定

按 §2.3 允许方向改为「sandbox 主动传入」形态。**已按此交付**：契约与落点见 §10.2，判定实现已迁回 sandbox 包并经 `MachineSandboxRoutePort` 注入。

### 9.7 执行顺序

W5 提前独立执行（唯一不依赖任何裁定的切片）；随后 W1 → W2 → W3，W4 与 W3 同批。

## 十、W5 交付记录（Machine / Sandbox 方向收敛，2026-09-20）

### 10.1 交付清单

**新建**

| 文件 | 内容 |
| --- | --- |
| `packages/resources/machine/src/server/host-port.ts` | `MachineHostPort` 五个原语：`resolveWorkspacePath` / `getCoreRuntimeNode` / `unregisterCoreRuntimeNode` / `findMachineConnectionById` / `triggerMachineCleanupByMachineId`；`bindMachineHostPort` 一次绑定（重复绑定抛错），`setMachineHostPort` 浅合并替换层供包内用例打桩 |
| `packages/resources/machine/src/server/sandbox-route-port.ts` | `MachineSandboxRoutePort` + `SandboxRouteInput` / `SandboxRouteResult`；一次绑定，**未装配返回 null**（无沙盒能力的 assembly profile 是正常状态） |
| `packages/resources/sandbox/src/server/services/sandbox-machine-route.ts` | 沙盒路由判定实现（读本包 `getSandboxConfig()` / `findReadableSandboxPoolById` / `findActiveSandboxInstance`），`createSandboxModule()` 装配时注入 |
| `packages/resources/machine/src/server/__tests__/host-port-stub.ts` | 包内窄打桩入口（只替换 `getCoreRuntimeNode`，其余原语继续走宿主真实绑定） |

**删除**

- `packages/resources/machine/src/services/event-service.ts`（53 行薄封装，按 9 节裁定「删除包装、宿主直取」）
- `packages/resources/machine/src/server/__tests__/core-runtime-stub.ts`（「保存 → 复位 → 绑定 → 还原」舞蹈被浅合并替换层取代）

**machine 侧 6 处反向导入改造**（§5.1 清单逐一对应）

| 文件 | 改法 |
| --- | --- |
| `src/server/services/machine-runtime.ts` | `getBoundCoreRuntimePort` → `getMachineHostPort().unregisterCoreRuntimeNode` |
| `src/server/services/file-machine-events.ts` | `getBoundCoreRuntime` → `getMachineHostPort().getCoreRuntimeNode` |
| `src/server/services/workspace-fs.ts` | `resolveWorkspacePath` → `getMachineHostPort().resolveWorkspacePath` |
| `src/server/services/registry-heartbeat.ts` | 动态 import 的 `findMachineConnectionById` / `triggerMachineCleanupByMachineId` → host port 同原语 |
| `src/server/environment-port.ts` | 原直接导入 agent-runtime 的 `environmentRepo` / `getOwnedEnvironment`，改为只声明契约（实现仍在 agent-runtime，宿主转发） |
| `src/services/event-service.ts` | 删除，宿主与包内外测试改从 `@fenix/agent-runtime/server` 直取 |

**sandbox 侧 2 处**：`src/server/services/remote-file-service.ts` 的沙盒判定改经 `getMachineSandboxRoutePort()`（`getAgentConfigById` / `resolveAgentNode` 保留，属 §2.3 允许方向）；`src/server/testing.ts` 不再 `createSandboxModuleConfig()`。

**宿主装配（生产与测试双轨）**

- `apps/server/src/main.ts`：新增 `bindMachineHostPort` / `bindMachineEnvironmentPort`，实现分别取自 `./services/core-bootstrap`（Core runtime 单例、`unregisterRemoteNode`）与 agent-runtime 的 `resolveWorkspacePath` / `findMachineConnectionById` / `triggerMachineCleanupByMachineId` / `environmentRepo` / `getOwnedEnvironment`
- `apps/server/src/test-utils/setup-mocks.ts`：同形状绑定转发到 stub 注册表；`getCoreRuntimeNode` 用可选链保留「未配置 stub 时判定查无此机」的既有宽松语义（`createStubRegistry` 是 `throwOnMissing=false`，直接取 `.getNode` 会把「未配置」变成 TypeError）
- `apps/server/src/routes/web/control.ts`、`apps/server/src/services/transport.ts`、`apps/server/src/__tests__/round21-isolated-service-coverage.test.ts`：`eventService.*` 全部改写为 agent-runtime 的模块函数

**契约与依赖面**

- `packages/resources/machine/package.json` 删 `@fenix/agent-runtime`、`@fenix/resource-sandbox`（`bun.lock` 同步）；`fenix.module.ts` 增「装配契约（1.4 起）」段；`README.md` / `config.ts` / `src/server.ts` / 包契约测试同步
- `packages/resources/sandbox`：`dependsOn: ["machine"]` 与 `@fenix/resource-machine` 依赖**不变**（§5.3 预期）
- `scripts/architecture/exceptions.json`：删 2 条 `special-dependency`（`machine → agent-runtime`、`machine → sandbox`）与 1 条 `no-circular`；`owner: "1.4"` 由 14 条降为 11 条

### 10.2 §9.6 的落地契约

判定方归 sandbox、machine 只消费结果：

```ts
interface SandboxRouteInput {
  readonly explicitSandboxPoolId: string | null; // AgentNode 显式声明的池
  readonly boundToMachine: boolean;              // 显式绑定机器时本就不走沙盒
  readonly organizationId: string;
  readonly userId: string;                       // 环境属主；空值表示无查询主体
}
interface SandboxRouteResult {
  readonly sandboxSelected: boolean;             // 选中后调用方不得回落默认机器
  readonly machineId: string | null;             // 命中且有活跃实例时为所在机器
}
```

三分语义（实现自述于 `sandbox-machine-route.ts`）：显式绑定机器 → 不选中；选中沙盒 → **不再看**是否有可用实例，池不存在 / 跨组织不可读 / 无活跃实例一律 `machineId: null` 并由调用方按「沙盒已选中但无可用机器」处理，**不回落到默认机器**——回落会让用户以为文件写在沙盒里、实际写到别的机器；未选中 → `sandboxSelected: false`。显式池优先于全局开关（节点指定池时不因 `sandboxEnabled: false` 静默失效）。

### 10.3 端口语义（与 `bindCoreRuntimePort` 同口径）

- `MachineHostPort`：宿主必提供，未绑定即失败、不隐式回退；一次绑定（重复绑定不同实现抛 `has already been bound`）。
- `MachineEnvironmentPort`：同上。
- `MachineSandboxRoutePort`：**例外**，未装配返回 null —— 不含 sandbox 模块的部署里 `getRemoteMachineId` 必须照常走默认机器或本地 FS，报错会打断合法部署。
- 包内打桩走 `setMachineHostPort` / `setMachineEnvironmentPort` 的浅合并替换层，替换面精确等于断言面（`resetMachineHostPortStub` 只清替换层，preload 的真实绑定不受影响）。

### 10.4 台账只删 3 条（§5.3 预测 7 条）的原因

反向边消失 **≠** 环消失。本包仍有 `@server/db/schema` 这一条指向宿主的边（7 个生产文件，`apps-boundary` 台账 owner §1.7），而宿主装配 agent-runtime 与 sandbox、`agent-runtime → sandbox`（`orchestration-bootstrap.ts`、`routes/api/instances.ts`）、`sandbox → machine` 都在，于是环由
`machine → apps/server → agent-runtime → sandbox → machine` 继续闭合。`no-circular` 里 machine 相关的 2 条（`machine → machine`、`sandbox → machine`）因此**仍是真实违规**，门禁要求「已登记但不再违规」必须删除，所以只剩 3 条可删。等 §1.7 把表定义迁出、`machine → apps/server` 消失后，这些条目才会连带失效。

### 10.5 验证证据

| 项 | 结果 |
| --- | --- |
| `bun install` | `bun.lock` 减 2 行（machine 的两条 workspace 依赖） |
| `bun test packages/` | 7274 pass / 2 skip / 0 fail |
| `bun test apps/server/src/__tests__/` | 734 pass，**仅** `db-pool-config.test.ts` 失败（见下） |
| `bun run architecture:check` | ✓ 2226 文件、11 规则、28 条例外 |
| `bun run check:dependencies` | ✓ 2378 模块、23 条例外、0 新增违规 |
| `env -u ANTHROPIC_MODEL bun run precheck` | 12 步中 11 步 ✓；`server-and-script-tests` ✗（870 pass / 1 fail / 1 error，失败项全部来自下面的既有失败） |
| `bun run docs:build` | ✓（本文件与前序 review 文档的链接可解析） |
| 冻结区 | `git status --porcelain` 对第二节 10 个文件命中 **0** 行（W5 未触碰冻结区） |

**既有失败（与 W5 无关，未修复）**：`apps/server/src/__tests__/db-pool-config.test.ts` 报
`SyntaxError: Export named 'attachDatabasePoolErrorLogger' not found in module '.../apps/server/src/db/index.ts'`（0 pass / 1 fail / 1 error，单文件独立运行同样失败）。属于 mock 缺口：`setup-mocks.ts` 的 `createDbMock` 只定义 `db` / `client` / `initDb`，而该测试与 `apps/server/src/db/index.ts:44` 的 `attachDatabasePoolErrorLogger` 同出自旧提交 `9f189d747`。

**无关性已实测证明**（不是「看起来像历史问题」的自述）：把工作区的 `setup-mocks.ts` 临时替换为 `git show HEAD:` 的版本后，单文件复跑得到**逐字相同**的失败（0 pass / 1 fail / 1 error），随后已还原工作区版本；`git status` 对本任务未触及 `db-pool-config.test.ts` 与 `db/index.ts`。修复方式是给 `createDbMock` 补该导出，属测试基础设施的独立缺口，不随本任务夹带。**因此本任务不能宣称 `precheck` 全绿**，只宣称「除该既有失败外全绿」。

### 10.6 遗留项

| 项 | 归属 |
| --- | --- |
| `src/server/services/registry-heartbeat.ts:2` 等 7 个文件的 `@server/db/schema` 表定义导入 | §1.7 表定义迁出（`apps-boundary` 台账已改判 owner） |
| `machine → agent_config` 的表读写（`registry.ts` 的引用检查与 `bindAgentConfigs` 写路径） | 需 agent-config 提供按 machineId 的绑定入口，W4 同批 |
| `sandbox_instance` 投影写路径（`machine-sandbox-projection.ts`） | 机器事件接收方在本包，写路径无法由 sandbox 代劳；接触面已降为表定义 |
| `scripts/root-source-owner-rules.ts:281` 的 `src/services/event-service.ts` 规则 | 该规则已无匹配文件（`check-root-source-owner-inventory.ts` 只审计实际存在的根目录源文件），属 RMD-02 历史清单 |

## 十一、W1 交付记录（依赖类型与配置 seam，2026-09-20）

### 11.1 交付清单

**类型搬家：宿主 `@server/types/*` 的使用方归零。**

| 动作 | 内容 |
| --- | --- |
| 新建 | `src/types/ws-types.ts`(29)、`src/types/acp-connection.ts`(53)、`src/types/instance.ts`(26)、`src/types/environment.ts`(32) |
| 宿主删除 | `apps/server/src/types/store.ts`（112 行，`git rm`）；`apps/server/src/types/api.ts` −26 行（环境注册请求/响应类型已随 owner 收回） |
| 公开面 | `src/server.ts` 末端 re-export 上述 4 个类型文件（含 `WsConnection`，使 `AcpConnectionEntry["ws"]` 这类派生在包外可解析） |
| import 改指 | `routes/acp/index.ts`、`server/transport/relay/external-relay.ts`、`transport/agent-node-bridge.ts`、`server/transport/acp-ws-handler.ts` + 3 个测试文件 |
| 去重 | `packages/resources/observer/src/server/services/observer/types.ts` 删除自持的 `AcpConnectionSnapshot`，改为 `import type` 自 `@fenix/agent-runtime/server`（`AcpConnectionSnapshot` / `ExternalRelayConnectionSnapshot` / `EnvironmentRecord` 三者均在该包公开面上） |

**配置 seam：7 个运行态旋钮改由模块配置注入，宿主不再被包直接读取。**

| 动作 | 内容 |
| --- | --- |
| 新建 | `src/server/config.ts`（`AgentRuntimeModuleConfig`，zod `strictObject`，7 键：3 个并发上限 + 3 个 ACP 超时 + WS 保活间隔）；`src/server/testing.ts`（`createAgentRuntimeModuleConfig` / `initializeAgentRuntimeModuleConfig` / `stubAgentRuntimeConfig`，仿 knowledge 范式） |
| 导出 | `package.json` 增 `./server/testing`；`src/server.ts` 增 `export * from "./server/config"`（配置读取入口是本包，测试装配入口不在此处） |
| 宿主注入 | `apps/server/src/main.ts` 增 `initializeApplicationInfrastructure` 的 `"agent-runtime"` 条目，值取自 `config.*`（本任务只注入，不接 `loadServerEnv` 管道，见 §9.5） |
| 读取改签名 | `agent-concurrency.ts`（3 个上限 + `getBoundCoreRuntime`）、`acp-idle-monitor.ts`（3 个超时 + `getBoundCoreRuntime`）、`acp-ws-handler.ts`（保活间隔）改为调用时读 `getAgentRuntimeConfig()` |
| 测试基线 | `apps/server/src/test-utils/setup-mocks.ts` 增 `registerModuleConfigBaseline("agent-runtime", createAgentRuntimeModuleConfig())` |
| 测试迁移 | 7 个文件从宿主 `setConfig` 迁到模块配置：`acp-idle-monitor` / `acp-machine-connection-lookup` / `agent-concurrency-toctou` / `agent-node-bridge` / `instance-concurrency` / `orchestration-instance-rollback` / `orchestration-instance-nodeid` |

三个并发上限**刻意不设基线默认**：迁移前宿主测试经 `buildConfig({} as Env)` 读到 `undefined`，照抄部署默认（10）会给宿主用例引入从未见过的用户级配额。

顺带清掉 W1 自己引入的最后一处宿主类型残留：`acp-idle-monitor.test.ts` 里 5 处 `ReturnType<typeof import("@server/services/core-bootstrap").getCoreRuntime>` 改为包内 `CoreRuntimeFacade`。**这两处保真修正的边界**：`rmd-07-migration.test.ts` 的搬迁表删掉 `apps/server/src/types/store.ts` 条目（67 → 66——宿主文件已删，表若保留该行会报「target missing」）；`platform-sdk/src/__tests__/server-infrastructure.test.ts` 的哨兵模块 ID 由 `"agent-runtime"` 改为 `"never-registered-module"`（宿主 preload 新登记了 agent-runtime 基线，原 ID 再也读不到「未初始化」状态）。两条断言语义保持不变。

### 11.2 「按文件收敛」口径的确认与结果

W1 验收口径经裁定取**按文件收敛**（而非「按符号」或「全包解锁」）：只要求 W1 触及的文件不再出现这三类宿主导入，不要求整包归零——后者是 W2 的交付。

| 断言 | 实测 |
| --- | --- |
| `grep -rn '"@server/types' packages/agent-runtime/src` | **0** |
| `grep -rn "@server/services/core-bootstrap" packages/agent-runtime/src` | **0** |
| `grep -rln '"@server/config' packages/agent-runtime/src \| grep -v __tests__` | 4 个文件：`server/repositories/environment-orchestration.ts`、`services/orchestration-instance.ts`、`services/launch-spec-builder.ts`、`services/orchestration-bootstrap.ts`——均为 W2/W4 范围（launch-spec-builder 整体在 W4 删除） |
| 非测试文件剩余 `@server/*` 值导入 | **27 行**，全部落在 W2 已声明的范围（`@server/db`、`@server/db/schema`、`@server/plugins/auth`、`@server/env`、`@server/schemas`、`@server/errors`、`@server/plugins/logger`、`@server/services/*`、`@server/repositories`） |
| 全仓 `@server/types/store` 引用 | 3 处，全部是注释（observer / machine ws-types / workflow 测试），无 import |

**W2 交付后的复核（修正 W1 当时对残余的归类）**：上表「非测试文件剩余 27 行值导入」中，W2 清掉 16 行，剩 11 行——其中 6 行是 `@server/db/schema` **表定义**（§9.3 裁定归 §1.7，不属 W2），5 行是 `@server/config`(2) / `@server/db`(1) / `@server/services/config-utils`(1) / `@server/repositories`(1)，全部集中在 `launch-spec-builder.ts`、`orchestration-instance.ts`、`orchestration-bootstrap.ts` 三个文件，属 **W4「启动前取数搬出」**。W1 表中把 `orchestration-instance.ts` / `orchestration-bootstrap.ts` 的 `@server/config` 写作「W2 范围」过于乐观：这两个调用点与 `@server/repositories` 一样，是「取 agentConfig / 组装 LaunchSpec」的一部分，随 W4 删除或改指才消失（见 12.1、12.5）。另 3 行类型导入（`import type`）W2 已全部消除。

### 11.3 台账 −2 条（原预测「无」）

门禁从「2378 模块 / **23** 条已登记例外 / 0 新增违规」变为「2383 模块 / **21** 条已登记例外 / 0 新增违规」：**两条原处于「已匹配」状态的指纹失去了违规**，随即被门禁判为陈旧并要求删除。

删除的条目（`owner: "1.5"`，与 §5.3 预计删的 machine 条目不同批）：

- `no-circular`：`@fenix/agent-runtime → @fenix/server-app`
- `no-circular`：`@fenix/server-app → @fenix/agent-runtime`

机制：这两条登记的是「环的见证边恰好落在这条跨包边上」的环。W1 删除了 `agent-concurrency.ts` / `acp-idle-monitor.ts` / `acp-ws-handler.ts` 对 `@server/config`、`@server/services/core-bootstrap` 的值导入，环上这些跨包边消失，dependency-cruiser 为剩余环重新挑出的见证边落回包内（该指纹只剩 `@fenix/agent-runtime → @fenix/agent-runtime` 那一条，仍是真实违规，见台账同组条目）。

**这不等于宿主导入已收敛**：本包非测试代码仍有 27 行指向宿主的值导入（11.2 表），其中 `@server/db/schema`（7 个文件）的 `apps-boundary` 条目 owner 已改判 §1.7。删除动作同时满足台账规则「已登记但不再违规必须删除」；台账为待清偿清单，不是永久豁免名单。

### 11.4 验证证据

| 项 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run precheck` | 12 步中 11 步 ✓；`server-and-script-tests` ✗（870 pass / 1 fail / 1 error，失败项全部来自 §10.5 的既有失败） |
| `bun test packages/`（门禁 `package-tests`） | 7275 pass / 2 skip / 0 fail（593 文件） |
| `bun test apps/web`（门禁 `web-app-tests`） | 946 pass / 0 fail |
| `bun run check:dependencies` | ✓ 2383 模块、21 条已登记例外、0 条新增违规 |
| `bun run architecture:check` | ✓ 2231 文件、11 规则、28 条例外 |
| 冻结区绝缘性 | 10 个冻结文件中 9 个 `git diff HEAD` 为空；`server/transport/relay/external-relay.ts` 仅 1 行，且是 `WsConnection` 的 import 路径（`@server/transport/ws-types` → `../../types/ws-types`） |
| 未创建 commit | 按项目规则（未经明确要求不创建 commit），W1 交付留在工作区 |

`precheck` 唯一红项仍是 `apps/server/src/__tests__/db-pool-config.test.ts`：`createDbMock`（`setup-mocks.ts:256-280`）只定义 `db` / `client` / `initDb`，而该测试与 `apps/server/src/db/index.ts:44` 的 `attachDatabasePoolErrorLogger` 同出自旧提交 `9f189d747`；两个文件在本任务中均零改动。**因此 W1 同样不宣称 `precheck` 全绿**，只宣称「除该既有失败外全绿」。无关性证明与修复归属见 §10.5。

### 11.5 遗留项

| 项 | 归属 |
| --- | --- |
| 非测试文件 27 行宿主导入（`@server/db` / `db/schema` / `plugins/auth` / `env` / `schemas` / `errors` / `plugins/logger` / `services/*` / `repositories`） | W2（含 `@server/env` 与 `@server/plugins/auth`，随认证上下文裁定一并处置） |
| `@server/config` 的 4 个消费文件 | `environment-orchestration.ts` / `orchestration-instance.ts` / `orchestration-bootstrap.ts` 归 W2；`launch-spec-builder.ts` 整体在 W4 删除 |
| 三个并发上限不在测试基线的缺省值里 | `createAgentRuntimeModuleConfig` 只给四个超时/保活旋钮填部署默认；并发上限留 `undefined`（= 不限流），需要验证限流的用例显式传值。若 W2 之后有用例依赖非 `undefined` 的并发上限，届时按用例传入而不是改基线 |

## 十二、W2 交付记录（宿主接缝收敛，2026-09-20）

W2 按用户指令「每个子任务完成先提交，再下一子任务」分四批交付：

| 批次 | 提交 | 文件数 | 范围 |
| --- | --- | --- | --- |
| W2a 宿主接缝层 | `c4b1f038c` | 17（+187 −62） | 新建 `server/db.ts`（`AgentRuntimeDatabase` + `getAgentRuntimeDatabase()`，与 machine / knowledge / agent-config 同口径）与 `types/auth.ts`（认证上下文最小投影）；`server/config.ts` 增 5 个部署值键；4 个仓储/服务共 28 处改为方法内取句柄；`/acp` 的 `validateEnv()`、`orchestration-bootstrap` 的 `workspaceRoot` 与 sandbox 开关改读模块配置 |
| W2b 宿主模块搬包 | `d4c4a302d` | 13（+62 −168） | `git mv` 三模块入包：`errors/orchestration-http.ts`、`schemas/api-instance.schema.ts`、`services/openai-response-mapper.ts`（含其独有的协议边界用例） |
| W2c 路由工厂化与认证注入 | `8d3a842d2` | 12（+532 −261） | 三条路由改工厂 + 新增 `routes/dependencies.ts` 注入契约；宿主 `main.ts` 注入 `authGuardPlugin` / `authenticateRequest` / `logError`；包内认证替身与 `/acp` 请求级认证用例 |
| W2d 宿主服务接缝收口 | `2c57097f3` | 9（+64 −75） | `RedisConnectionPort`（宿主与 preload 双绑定，未装配显式抛错）；3 个宿主被测对象的用例迁回宿主测试目录；删 13 条重复 `normalizePayload` 用例 |

### 12.1 口径修正：产出不是「22 个非测试文件的宿主路径依赖归零」

§7 给 W2 写的产出是「22 个非测试文件中的宿主路径依赖归零 → 删 `apps-boundary`」。经用户裁定，W2 的验收口径为**按职责面收敛 + 表定义显式豁免**：非表定义、非「启动前取数」的宿主导入归零；表定义按 §9.3 显式豁免给 §1.7。按此口径实测（`git grep '@server/'`，剔除纯注释行；**含 `import type` 行**，故与 §11.2 的「值导入 27 行」口径相差 3 行类型导入）：

| 目标模块 | W1 交付后（`11f46a936`） | W2 交付后（`2c57097f3`） | 处置 |
| --- | --- | --- | --- |
| `@server/plugins/auth` | 6 行 / 3 文件 | 0 | W2c 认证注入 |
| `@server/db` | 6 行 / 4 文件 | 1 行 / 1 文件 | W2a 换包内 `getAgentRuntimeDatabase()`；剩 `launch-spec-builder.ts`（W4 删文件） |
| `@server/config` | 4 行 / 4 文件 | 2 行 / 2 文件 | W2a 消 2 行；剩 `orchestration-instance.ts`、`launch-spec-builder.ts` → W4 |
| `@server/plugins/logger` | 1 行 / 1 文件 | 0 | W2c `logError` 注入 |
| `@server/env` | 1 行 / 1 文件 | 0 | W2a 模块配置（`validateEnv()` → `getAgentRuntimeConfig()`） |
| `@server/services/cache` | 1 行 / 1 文件 | 0 | W2d `RedisConnectionPort` |
| `@server/services/openai-response-mapper` | 1 行 / 1 文件 | 0 | W2b 搬包 |
| `@server/schemas/api-instance.schema` | 1 行 / 1 文件 | 0 | W2b 搬包 |
| `@server/errors/orchestration-http` | 1 行 / 1 文件 | 0 | W2b 搬包 |
| `@server/db/schema`（表定义） | 6 行 / 6 文件 | 6 行 / 6 文件 | **不动**，§9.3 裁定归 §1.7 |
| `@server/services/config-utils` | 1 行 / 1 文件 | 1 行 / 1 文件 | W4（`launch-spec-builder.ts`） |
| `@server/repositories` | 1 行 / 1 文件 | 1 行 / 1 文件 | W4（`orchestration-bootstrap.ts` 组装 `LaunchSpecBuilder`） |
| **合计** | **30 行 / 14 文件**（27 值 + 3 类型） | **11 行 / 8 文件**（全为值导入） | W2 消 19 行 / 6 类（16 值 + 3 类型） |

非表定义残留 5 行 / 3 文件全部落在 W4 的三个文件上（`launch-spec-builder.ts` 3、`orchestration-instance.ts` 1、`orchestration-bootstrap.ts` 1）；表定义 6 行 / 6 文件落在 §1.7。**「22 个文件」的来历与修正**：该数字出自 W2 表的估算，实测 W1 交付后宿主导入分布在 14 个非测试文件上，W2 后余 8 个——两个数字都不是 22；口径修正后以 12.1 表为准。

测试侧由 49 行 / 28 文件降为 30 行 / 23 文件：消除 `@server/plugins/auth`(5)、`@server/routes/web/instances`(5)、`@server/services/org-context`(3)、`@server/services/transport`(2)、`@server/services/openai-response-mapper`(1)、`@server/routes/web/environments`(1)。剩余 30 行为宿主 test-utils 替身（`@server/test-utils/stubs/module-stubs` 12）、表定义（`@server/db/schema` 11）、宿主 config（`@server/config` 6）、`@server/plugins/error-handler` 1，随 W4 删除被测模块或 §1.7 表定义迁出处理。

§7 提到的「消除 `routes/acp/index.ts` 对 `@server/routes/web/environments` 的反向依赖」——实测该文件对 `@server/routes/*` 的**非测试**反向依赖在 W2 动手前的基线已不存在（阶段 1 迁移时消除，`git grep '@server/routes' 11f46a936` 非测试零命中）；测试侧 6 行（`instances-delete-idempotent`、`round44-environments-routes`）随 W2d 把这两个用例迁回宿主测试目录而消失。

### 12.2 偏离 §7 切片定义的三处（按裁定意图调整，非范围扩张）

| 项 | §7 字面口径 | 实际处置 | 理由 |
| --- | --- | --- | --- |
| W2b 搬包前提 | 弹窗时的前提是「待搬模块消费方都只有本包」 | `openai-response-mapper`、`orchestration-http` 在宿主仍有消费方（后者被 `plugins/error-handler.ts`、`routes/web/environments.ts` 消费；前者被宿主测试消费） | 裁定意图是「前三个搬包」，仍照搬；据此定公开面：`orchestration-http` 留在 `@fenix/agent-runtime/server`（宿主两处改指包公开面，错误→HTTP 映射只有一份定义），`openai-response-mapper` / `api-instance.schema` **不进**公开面（唯一消费方在包内，进公开面与 W3「收窄 `server.ts`」相悖）；宿主 `round16` 中与搬入的 `round18` 重复的 10 例删除，`round16` 独有的 2 条流式工具调用用例补进 `round18`，覆盖不降级 |
| W2c 测试改动量 | 「改指既有测试」 | 新增 `__tests__/guard-stubs.ts`、`__tests__/acp-routes-auth.test.ts`（2 例） | 认证接缝替换后 `/acp` 路由此前**只有 `readFileSync` 源码文本断言**（`acp-ws-auth.test.ts`），没有请求级运行时覆盖；守卫必须与 `/web/*` 同一实例是本接缝的核心契约，缺覆盖等于把「装配顺序」变成不可验证项 |
| `repositories` / `@server/config` 归属 | W2 表中「`repositories` 收口」列在 W2 | 留 W4 | `agentEngineRepo` 只被 `orchestration-bootstrap.ts` 用于组装 `LaunchSpecBuilder`，与 `orchestration-instance.ts` 的 `config.defaultEngineType`、`getBaseUrl()` 同属「启动前取数」，随 W4 删文件消失；在 W2 硬拆会把 W4 的输入切成两半 |

### 12.3 非显然取舍

**Elysia WS 路由的 TS2589（W2c 唯一阻塞项）。** 三条路由改工厂后，`routes/acp/index.ts` 的接收者类型只能是 `AnyElysia`（宿主守卫跨包，any 泛型实例），而 `Elysia.ws()` 会据 hooks 实参推导 `Input` / `Schema` / `MacroContext` 三层泛型（`MergeSchema<UnwrapRoute<...>>` 等）；在 any 泛型实例 + 内联字面量实参时展开深度超限，`/ws`、`/file-ws`、`/yjs`、`/relay` 四处均报 TS2589（TS 每次只报一处，修好一处才暴露下一处）。可行修法是把 hooks 的静态类型预固定为 `Parameters<AnyElysia["ws"]>[1]`，经 `declareAcpWsRoute(app, path, hooks)` 传参——不对内联字面量做深度推导，`tsc` 干净、无需 `as any`、handler 参数仍有 Elysia 提供的上下文类型、注册期行为（`query` 的模型引用、宏解析）不变。

已实测排除的替代方案：`(app as any).ws(...)`（消 TS2589 但引入 22 处 TS7006 隐式 any——接收者为 `any` 时实参无上下文类型）、`hooks: any` 参数（同 TS7006）、段结果标注为具体 `Elysia`（TS2322 不变性错误 + `query: string` 不能赋给 `AnySchema`）。**教训**：中途曾在未被 tsconfig `include` 的 scratch 文件里验证「`hooks: any` 仍有上下文类型」，得出错误结论；探针文件必须落在程序包含范围内，否则「假绿」。

**W2a 的一次非确定性失败。** W2a 的 `bun test packages/` 首轮出现 91 条失败、复跑不复现，判定为跨文件 mock 污染导致的非确定性失败（未定位到具体污染源，后续三轮全量测试未再复现）；交付证据以复跑结果与 `precheck` 的 `package-tests` 步骤为准。

**两处部署值的双取数点（W2a 记录在 `config.ts` 注释）。** `workspace-resolver.ts` 仍直读 `process.env.WORKSPACE_ROOT`，与 W2a 新增的模块配置键是同一部署值的两个取数点；`defaultMachineId` 与 machine 模块同源但未改用 `getMachineConfig()`（agent-runtime 目前不依赖 `@fenix/resource-machine`，为一个字符串引入新跨包边不在授权范围）。两者都是**同一部署值的重复取数**，收敛需要 machine / chat-channel 的测试进程一并初始化基础设施，超出 1.4 范围，随 §1.5 的配置管道一并处理。

**（2026-09-22 后续）** 第一处已随 **1.7 C1** 收口：`workspace-resolver.ts` 改读模块配置的 `workspaceRoot`；Machine host port 的根解析**拆给宿主** `apps/server/src/bootstrap/workspace-path.ts`（那份直读 `WORKSPACE_ROOT` 是 workspace 根锁的契约要求，与「包内读启动期快照」是两种语义），agent-runtime 的公开导出与钉它的用例一并删除——machine 侧测试零改动，理由与取证见 1.7 review §7.33。第二处（`defaultMachineId` 未走 `getMachineConfig()`）仍在。

### 12.4 台账 `apps-boundary` 不删、按职责面重测改写

§7 预测 W2 删掉 `apps-boundary`（`@fenix/agent-runtime → @fenix/server-app`）。按裁定「按职责面收敛 + 表定义显式豁免」，该条**不删**（`owner` 仍 `1.4`），只按实测改写 `removeWhen` 与 `rationale`：原文「实测 105 处导入 / 54 个文件，其中 88 处非表定义」是 W2 动手前的全量口径（含测试与当时的宿主模块导入），与交付后的职责面划分已不匹配，改写为「11 处 / 8 文件 + 两类归属」。台账其余条目与总数（49）不变，`owner: "1.4"` 仍 11 条，W2 削 0 条——**切片交付 ≠ 台账削减**（§3.3），本条的删除条件要等 W4 与 §1.7 两条路径都走完。

### 12.5 验证证据

| 项 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run precheck` | 12 步中 11 步 ✓（`format` / `import-sort` / `module-registry` / `architecture` / `tsc`×3 / `dependency-boundaries` / `lint` / `package-tests` / `web-app-tests`）；`server-and-script-tests` ✗，唯一失败仍是 12.6 记录的既有红项 |
| 宿主 + 脚本测试（`server-and-script-tests`） | 903 pass / 1 fail / 1 error（失败项即既有红项） |
| `package-tests` | 7223 pass / 2 skip / 0 fail（592 文件） |
| `web-app-tests` | 946 pass / 0 fail |
| `bunx tsc -p tsconfig.json --noEmit` | 干净（门禁三步 tsc 全绿） |
| `bun run check:dependencies` | ✓ 2389 模块、21 条已登记例外、0 条新增违规 |
| `bun run architecture:check` | ✓ 2237 文件、11 规则、28 条已登记例外（无陈旧条目） |
| `bun run docs:build` | ✓ |
| 冻结区 | `git diff 11f46a936..HEAD` 对第二节 10 个文件命中 **0** 行（W2 全周期未触碰冻结区，连 import 行都没有） |

**用例数变化的完整解释**（门禁输出的 pass 计数，逐批实测）：`package-tests` 7275（W1 后）→ 7297（W2b，+22 = 搬入的 `round18`）→ 7299（W2c，+2 = 新增 `/acp` 认证用例）→ 7223（W2d，−76 = 迁回宿主的 63 例 + 删除的 13 条重复用例）；宿主与脚本 870（W1 后）→ 840（W2b，−30 = `round18` 迁出 20 例 + `round16` 删除 10 例）→ 903（W2d，+63 = 迁回的 3 个用例文件）。`web-app-tests` 全程 946 不变。

### 12.6 遗留项

| 项 | 归属 |
| --- | --- |
| `@server/config`(2) / `@server/db`(1) / `@server/services/config-utils`(1) / `@server/repositories`(1)，集中在 `launch-spec-builder.ts`、`orchestration-instance.ts`、`orchestration-bootstrap.ts` | W4「启动前取数搬出」（前两个文件删除或改指，`orchestration-bootstrap` 的组装点随 `LaunchSpecBuilder` 迁移） |
| 6 处 `@server/db/schema` 表定义（`agent-instance` / `environment` / `environment-orchestration` / `environment-web` / `agent-chat-service` / `launch-spec-builder`） | §1.7 表定义迁出（§9.3 裁定） |
| 包内测试侧 30 行宿主导入（test-utils 替身 12、表定义 11、宿主 config 6、error-handler 1） | W4（删除 `launch-spec-*` / `orchestration-*` 用例时一并消失）与 §1.7 |
| ~~`workspace-resolver.ts` 直读 `process.env.WORKSPACE_ROOT`~~ **已随 1.7 C1 收口（1.7 review §8.1 第 9 条 / §7.33）**、`defaultMachineId` 未走 `getMachineConfig()` | §1.5 配置管道（两处部署值的重复取数，见 12.3） |
| `apps/server/src/__tests__/db-pool-config.test.ts`（既有红项，非本任务引入、未修复） | 测试基础设施独立缺口：`setup-mocks.ts` 的 `createDbMock` 缺 `attachDatabasePoolErrorLogger` 导出，与 `apps/server/src/db/index.ts:44` 同出自 `9f189d747`。取证与无关性证明见 §10.5；修复方式是给 `createDbMock` 补导出，不随 1.4 夹带 |

## 十三、W3a 交付记录（Runtime port 定型，2026-09-20）

W3 按裁定拆两步（先定型面、再改调消费方）。本节是 **W3a**：新增对外运行面、收窄宿主装配面、替换模块工厂、补契约测试；**消费方一个未动**，符号可达性零变化。

### 13.1 交付清单

| 文件 | 变更 |
| --- | --- |
| `packages/agent-runtime/src/runtime.ts` | 新增。`AgentRuntimePort`（管理面 33 方法，按启动/停止/状态/回收四组）+ `AgentRuntimeSessionApi`（数据面 6 方法）+ `AgentRuntime`（=port + `session`）+ `AgentRuntimeModule` + `createAgentRuntime` / `createAgentRuntimeModule` / `bindAgentRuntime` / `getBoundAgentRuntime` / `resetAgentRuntimeForTest` |
| `packages/agent-runtime/package.json` | 新增 `exports["./runtime"]`（与 `./module`、`./server`、`./server/testing` 并列） |
| `packages/agent-runtime/src/server.ts` | 由 82 行整体 re-export 改写为「平铺 + 逐行行内角色标注」的宿主装配面清单；`./server/repositories` 与 `./server/transport/relay` 两个嵌套 barrel 由 `export *` 改为显式名字清单（不再随整目录透传） |
| `packages/agent-runtime/fenix.module.ts` | 工厂替换为 `create: () => import("./src/runtime").then((m) => m.createAgentRuntimeModule())`；删除「已知不足」注释 |
| `packages/agent-runtime/src/services/openai-response-mapper.ts` | 唯一一处包内实现经本包公开面自引用，改为相对导入 `../schemas/openai-chat.schema` |
| `packages/agent-runtime/src/__tests__/runtime-port.test.ts` | 新增 6 例：两面方法集合与清单逐一比对、两面不重名、未绑定即失败、重复绑定不同实例失败、模块工厂幂等、`runtime.ts` 不得经 `server` barrel 自引用 |

**port 面（39 方法）**：管理面 = 启动 6（`ensureInstance` / `createEnvironment` / `updateEnvironment` / `restartActiveInstancesForEnvironments` / `openAgentSession` / `setRuntimeCredentialResolver`）+ 停止 6 + 状态 16 + 回收 5；数据面 = `connectRelay` / `createAgentSession` / `createPromptTurn` / `startPromptTurn` / `sendToAgentWs` / `sendToInstanceRelay`。

**本片不改的东西**：不改任何实现（port 每个方法都是既有包内函数的显式转发）、不改消费方、不删符号、不动台账（实测削 **0** 条——契约面定型不改变依赖边）、不动冻结区 10 个文件。

### 13.2 与 §4.3 建议稿的差异

§4.3 是「按能力归组」的形状建议，落地时按现有函数名与参数形状直通，差异如下（均为**保持既有函数签名**所致，不引入新语义）：

| §4.3 建议 | 实际落地 | 原因 |
| --- | --- | --- |
| `ensureInstance(input): Promise<InstanceHandle>` | `ensureInstance(input): Promise<EnsureInstanceResult>`（`{ instanceUid }`） | `InstanceHandle` 在包内不存在；返回最小投影，实例详情走状态组查询，避免 port 自造第二套实例视图类型 |
| `stopInstance(instanceUid, mode: RuntimeStopMode): Promise<void>` | `stopInstance(instanceUid, organizationId): Promise<{ok, error?}>` | 现有投影层签名带组织归属校验（多租户红线）且返回结果对象；`RuntimeStopMode` 是 coordinator 层概念，投影层已有 `stopInstanceViaController(instanceId, mode)`，两者不可互换 |
| `getInstanceStatus` / `listInstances` / `InstanceSummary` | `getRuntimeSnapshot` / `listRuntimeInstances` / `listOwnedInstances` / `getRuntimeInstance` | 直接复用既有投影函数名，不新造同义类型；四者语义分别是「持久记录 + 运行态快照」「内存运行态」「属主视图」 |
| `findRunningInstanceByEnvironment(envId): Promise<InstanceRef \| null>` | 同名字，返回 `SpawnedInstance \| undefined` | 既有签名；`undefined` 与 `null` 的差异由既有调用方消化 |
| `closeConnectionsForEnvironments` / `closeAllConnections` | 拆成 `closeAcpConnectionsForEnvironments` / `closeAllAcpConnections` / `closeAllRelayConnections` | 包内是两套连接（ACP 与前端 relay），合成一个名字会掩盖「只关其一」的既有语义 |
| `cleanupInstancesForMachine(machineId): Promise<void>` | 同名字，返回 `number` | 既有函数同步返回清理数量，宿主拿它打日志 |
| 未包含会话/relay 数据面 | 新增 `AgentRuntimeSessionApi` | §4.3 只覆盖实例生命周期；12 个符号里 `connectAgentRelay` / `createAgentSession` / `startPromptTurn` / `createPromptTurn` / `sendToAgentWs` / `sendToInstanceRelay` 是三条链路的直接能力（裁定：两个面），另 6 个（`markInstanceRelayAttached/Detached`、`refreshInstanceEnvironment`、`terminateLocalDeadInstance`、`touchInstanceActivity` 等）归管理面的状态/回收组 |
| 未包含环境 CRUD | `createEnvironment` / `updateEnvironment` / `deleteEnvironment` / `getOwnedEnvironment` / `listEnvironments` / `getEnvironmentBySecret` 进管理面 | 环境的创建/停止与实例生命周期是同一段编排（`createWebEnvironment` 内含默认实例启动），拆开会把一次事务切成两个 port 调用 |

`EnsureInstanceInput` 的最终形状与理由见 §4.4 的澄清段。

### 13.3 非显然取舍

1. **`server.ts` 用「平铺 + 行内角色标注」而不是分块注释**。本文件由门禁的 `biome check --write --linter-enabled=false`（organizeImports）处理：它**全局按 specifier 字母序重排 export 语句**，而**独立注释留在原位、行内注释随语句移动**（本片实测：先写分块注释版本，precheck 的 import-sort 步骤把语句打散，注释全部错位）。因此分块注释在本文件里必然说谎，改为「行内标注角色 + 文件头解释角色含义」。代价是丢失视觉分组，收益是清单在门禁下稳定（复跑 `biome check --write` 输出 "No fixes applied"）。
2. **不逐名展开 314 个导出符号**。收窄的字面做法是把每个叶子文件的导出名全部列出，实测 `server.ts` 收窄前共导出 **314 个名字**（AST 实测）。这既是手工维护的副本（必然漂移），也与同类包 barrel 的既有口径冲突（`machine` / `observer` / `sandbox` 的 `src/server.ts` 均对叶子契约文件 `export *`，只对**嵌套 barrel** 显式）。本片采用同一口径：只把 `./server/repositories` 与 `./server/transport/relay` 两个嵌套 barrel 展开为显式名字，叶子文件保留 `export *` 并逐行标注职责面与去留（`运行·` / `泄漏·` / `宿主注入·` …），使 W3b / W6 的收口对象在清单上可直接识别。**这是对「消灭 `export *`」的字面偏离**，偏离理由如上；若要求逐名展开，需先统一四个包的 barrel 口径。
3. **`createAgentRuntimeModule()` 幂等，`bindAgentRuntime` 仍按 `bind*Port` 同口径抛错**。`createAgentRuntime()` 每次返回新包装对象（内部指向同一批模块级单例），若工厂直接 `bind(createAgentRuntime())`，第二次求值就会抛「已绑定不同实例」。处理方式是工厂 `boundRuntime ??= createAgentRuntime()`，重复调用返回同一入口——既符合「重复调用不产生第二份运行状态」（`createMachineModule` / `createSandboxModule` 口径），又保留「宿主必须先装配、未装配即失败」的判据。
4. **getter 命名为 `getBoundAgentRuntime`**（而非 `getAgentRuntime`）。包内 6 个 `bind*Port` 的 getter 分别是 `getBoundCoreRuntime` / `getBoundCoreRuntimePort` / `getBoundRedisConnection` / `getFileWsPort` / `getMachineRegistryPort` / `getSessionEventBusPort`，命名不统一；本片取「绑定语义明确」的多数派（`getBound*`），未动既有 6 个。
5. **返回类型暂用 `Awaited<ReturnType<typeof fn>>` 派生**（`listEnvironmentsWithInstances` 一类含 DB join 投影的函数尚无显式返回类型）。好处是零风险直通、不猜错形状；代价是公开契约会随实现漂移。**移除条件**已写在 `runtime.ts` 文件头：W6 收敛消息面时把这些派生类型替换为显式契约类型。
6. **`openai-response-mapper.ts` 的自引用修正**属本片必要项：它让 `./server` barrel 同时是「内部实现」与「外部契约」，收窄时无法判断谁是消费者。修正后全仓非测试代码对 `@fenix/agent-runtime/server` 的自引用为 0（仅测试侧保留，按既有口径）。

### 13.4 验证证据

| 验证 | 结果 |
| --- | --- |
| 导出符号可达性 | 对 `HEAD:packages/agent-runtime/src/server.ts` 与新版做 AST 导出集合比对：**314 → 314，丢失 0、新增 0** |
| `bun run architecture:check` | ✓ 2239 files / 11 rules / 28 条已登记例外 |
| `bun run check:dependencies` | ✓ 2391 modules / 21 条已登记例外 / **0 条新增违规**（台账无增删） |
| `bun test packages/agent-runtime/` | 850 pass / 0 fail（107 文件，含新增 6 例） |
| `env -u ANTHROPIC_MODEL bun run precheck` | format / import-sort / module-registry / architecture / tsc(server) / tsc(web) / tsc(skeletons) / dependency-boundaries / lint / package-tests / web-app-tests **全绿**；`server-and-script-tests` 仍为既有红项（见下） |
| 用例数 | `package-tests` pass 7223（W2d 记录）→ **7229**（+6 = 本片新增 `runtime-port.test.ts`）；宿主与脚本 903 pass 不变 |

**未达全绿的部分（既有红项，非本片引入）**：`apps/server/src/__tests__/db-pool-config.test.ts` 报 `SyntaxError: Export named 'attachDatabasePoolErrorLogger' not found`，与 W2c/W2d/W2e 记录的是同一条（出处 `9f189d747`，取证见 §10.5、登记见 §12.6）。本片未触碰 `apps/server/src`，故不宣称 precheck 全绿。

### 13.5 遗留项（W3b 及以后）

| 项 | 归属 |
| --- | --- |
| 30 个非测试消费文件仍从 `./server` 取运行能力符号（workflow 4、observer 3、apps/server 12、agent-config 2 + web 2、channel 1 + web 1、task 1、mcp 1、prod-view 1） | W3b：改调 `@fenix/agent-runtime/runtime` |
| `main.ts` 对 `bindAgentInstanceRuntimeOperations` 的转发绑定（`AgentInstanceRuntimeOperations` 是包内装配 seam，不升级为对外 port，§4.6） | W3b：port 实现内部持有后去掉该转发 |
| `server.ts` 清单中全部标 `运行·`（W3b）与 `泄漏·`（W6，含 `environmentRepo` / `agentInstanceRepo` / event bus / `listAcpConnections` / `listExternalRelayEntries` / `resolveWorkspacePath` / `EnvironmentRecord`）的行 | W3b（运行能力）/ W6（泄漏收口） |
| 测试 seam（`set*Deps` / `reset*` / `_uuid`）仍随叶子文件透出 | W6（按 §13.1 注释口径移出公开面，包内用例改相对导入；现仅 `api-instance` 的 `setApiInstanceDeps` 有 2 处包内测试经公开面导入） |
| `server.ts` 经 relay 原样透出的 `extractAcpEvent` / `extractJsonRpc`（chat-channel 实现，台账 `no-cross-package-src:packages/chat-channel`） | W6（与 §1.6 同批） |
| `runtime.ts` 的派生返回类型 | W6（替换为显式契约类型） |

## 十四、W3b 交付记录（消费方改调 port，2026-09-21）

W3 的第二步：非测试消费方全部改调 `@fenix/agent-runtime/runtime`、删除已迁走符号、去掉 `main.ts` 对 `bindAgentInstanceRuntimeOperations` 的转发（§4.6）。**不动**「实例起来之后怎么管」（状态机、幂等、lease、并发限流、disconnect fencing、dispose、重连）——本片只收敛「谁从哪个入口取运行能力」，实现与生命周期语义零变化。

### 14.1 两项裁定（用户弹窗确认）

| 问题 | 裁定 | 落地 |
| --- | --- | --- |
| 管理面要不要把 `/web/instances` 控制台的实例 CRUD（`createUserInstance` / `deleteInstance` / `restartInstanceRuntime` / `getOwnedInstance`）纳入 `/runtime` | **纳入，一个面收全** | 四项进 port 的「启动 / 停止 / 状态」组，`routes/web/instances.ts` 一并改调 `getBoundAgentRuntime()`；§4.1 的「9 个包/应用、31 个文件」因此完整收敛。代价：控制台实例 CRUD 与跨包消费方共用同一面，且控制台路由测试的 `setWebInstanceRouteDeps` 必须改成绑定假 runtime |
| port 的实例标识用什么类型 | **直通既有类型，W6 收敛** | `ensureInstance` / `findOrCreateDefaultInstance` / `createInstance` / `getOwnedInstance` / `listOwnedInstances` 一律返回既有 `AgentInstanceRecord`；W3a 自造的 `EnsureInstanceResult`（`{ instanceUid }`）删除。零行为风险（W3a 的 `listOwnedInstances` 已是这个口径）；代价是持久化记录类型出现在契约面上，与派生返回类型一并记入 W6 |

### 14.2 交付清单

| 文件 | 变更 |
| --- | --- |
| `packages/agent-runtime/src/runtime.ts` | port 管理面 **33 → 42** 方法（新增 9：`ensureInstanceRuntime` / `findOrCreateDefaultInstance` / `findOrCreateWorkflowInstanceWithStatus` / `createInstance` / `stopInstanceRuntime` / `restartInstanceRuntime` / `deleteInstance` / `getOwnedInstance` / `unregisterInstance`）；`ensureInstance` 由投影改直通 `AgentInstanceRecord`；新增 `CreateInstanceInput`；`createAgentRuntimeModule()` 首次装配时绑定包内 `AgentInstanceRuntimeOperations`（§4.6）；类型出口补 `AgentInstanceRecord` / `AutomaticInstanceSelection` / `RuntimeSnapshot` / `RuntimeStopMode`（数据面 6 方法不变） |
| `packages/agent-runtime/src/server/testing.ts` | 新增 `stubAgentRuntimePort(overrides)` / `resetAgentRuntimePort()`——替换点收敛到 port 绑定本身（真实入口 + 覆盖），见 14.6 |
| `packages/agent-runtime/src/server.ts` | 导出面 **314 → 233**；清单 52 行 → 40 行；角色前缀删除 `运行·`，新增 `测试取用·`（判据「删除即破坏用例」）与 `W4·`，判据写进文件头 |
| `apps/server/src/main.ts` | 去掉 `bindAgentInstanceRuntimeOperations({ spawnInstance, stopInstance, hasActiveInstance })` 转发（§4.6）；`agentInstanceService` / `getOwnedEnvironment` / `setRuntimeCredentialResolver` / `startAcpIdleMonitor` / `stopAcpIdleMonitor` / `closeAll*Connections` / `stopInstancesForEnvironments` / `closeAcpConnectionsForEnvironments` / `touchInstanceActivity` / `shutdown` 改经 `createAgentRuntimeModule().runtime` 取用；`bindMachineEnvironmentPort` / `bindEnvironmentAcpLifecyclePort` / `bindAcpInstanceActivityPort` 的实参改取 port |
| `apps/server/src/routes/web/instances.ts` | 删除 `_deps` 袋子与 `setWebInstanceRouteDeps` / `resetWebInstanceRouteDeps`；spawn/stop/restart/delete 与活跃度快照改调 port（`createUserInstance` → `createInstance`） |
| `apps/server/src/routes/web/environments.ts` | 删除 `EnvironmentRouteDeps` 注入（`createEnvironmentRoutes()` 恢复无参）；环境 CRUD/列表/归属校验改调 port；`EnvironmentRouteDeps["createWebEnvironment"]` 的派生返回类型改为 `AgentRuntimePort["createEnvironment"]` 派生 |
| `apps/server/src/routes/web/control.ts` | 会话状态机入口（`resolveExistingSessionId` / `getSession` / `updateSessionStatus`）与实例归属（`getOwnedInstance`）改调 port；`LightweightSession` 不外透，改从 `AgentRuntimePort["getSession"]` 派生 |
| `apps/server/src/routes/web/peri-task-details.ts`、`services/core-bootstrap.ts` | `getOwnedEnvironment` / `cleanupOrchestrationInstancesForMachine` / `globalInstanceRegistry.unregisterAndDeleteCounter` 改调 port（后者即新增的 `unregisterInstance`） |
| `packages/resources/*`（9 文件） | workflow（`agent-chat-transport.ts` 的实例解析/启动/relay attach-detach/活动打点、`index.ts` 的停止）、agent-config（`facade` / `meta-agent`）、channel（`hermes-client`）、mcp（`knowledge`）、task（`agent-executor`：默认实现走 port）、prod-view 全部改调 port |
| `apps/server/src/test-utils/setup-mocks.ts` | preload 增加 `bindAgentRuntime(createAgentRuntime())`：测试进程按生产装配路径绑定真实入口（其内部读的仍是本文件换过的替身），需要替换单个方法时用 `stubAgentRuntimePort()` |

### 14.3 port 面（42 管理面方法，按组）

| 组 | 数 | 方法 |
| --- | --- | --- |
| 启动 | 10 | `ensureInstance` / `ensureInstanceRuntime` / `findOrCreateDefaultInstance` / `findOrCreateWorkflowInstanceWithStatus` / `createInstance` / `createEnvironment` / `updateEnvironment` / `restartActiveInstancesForEnvironments` / `openAgentSession` / `setRuntimeCredentialResolver` |
| 停止 | 9 | `stopInstance` / `stopInstanceRuntime` / `restartInstanceRuntime` / `deleteInstance` / `stopInstancesForEnvironments` / `deleteEnvironment` / `closeAcpConnectionsForEnvironments` / `closeAllAcpConnections` / `closeAllRelayConnections` |
| 状态 | 17 | `getOwnedEnvironment` / `listEnvironments` / `getEnvironmentBySecret` / `findRunningInstanceByEnvironment` / `listRuntimeInstances` / `getRuntimeInstance` / `getOwnedInstance` / `listOwnedInstances` / `getRuntimeSnapshot` / `listInstanceActivity` / `touchInstanceActivity` / `markInstanceRelayAttached` / `markInstanceRelayDetached` / `refreshInstanceEnvironment` / `getSession` / `resolveExistingSessionId` / `updateSessionStatus` |
| 回收 | 6 | `cleanupInstancesForMachine` / `unregisterInstance` / `terminateLocalDeadInstance` / `startIdleMonitor` / `stopIdleMonitor` / `shutdown` |

数据面 `AgentRuntimeSessionApi` 仍是 6 方法（`connectRelay` / `createAgentSession` / `createPromptTurn` / `startPromptTurn` / `sendToAgentWs` / `sendToInstanceRelay`）。**每个方法都是既有包内函数的显式转发**（调用时属性访问，如 `agentInstanceService.ensureInstanceRuntime(...)`），本片不新增行为。

### 14.4 `server.ts` 导出面收敛（314 → 233）

同一 AST 程序对 `HEAD:packages/agent-runtime/src/server.ts` 与新版各做一次 `getExportsOfModule` 去重计数：**314 → 233**（净削 81），无新增名字。逐行构成：

**删除 12 行**（括号内为该行在 HEAD 时的名字数，含与保留行重叠者）：`server/instance/agent-instance-id`(2)、`server/services/agent-instance-runtime-coordinator`(7)、`server/services/agent-instance-runtime-projection`(15)、`server/services/environment-web`(5)、`server/transport/agent-relay`(2)、`server/transport/relay/client-close`(1)、`services/agent-concurrency`(11)、`services/environment`(30，聚合面)、`services/environment-acp`(20)、`services/environment-startup-lock`(1)、`services/orchestration-machine-cleanup`(3)、`services/session`(6)。行内名字数合计 −103，去重后净削小于此，差额来自与保留行重叠的名字。

**收窄 1 行**：`export * from "./services/environment-core"`（14 名）拆成两行显式面——`bindEnvironmentAcpLifecyclePort`（宿主注入·，`main.ts` 唯一消费方）与 `KEBAB_CASE_RE` / `sanitizeResponse` / `validateWorkspacePath`（泄漏·，W6 归位），−10。

**改标 12 行**（保留导出、改角色前缀，`运行·` 前缀随之在本文件消失）：`测试取用·` 7 行（`agent-instance-service`、`api-instance`、`acp-idle-monitor`、`agent-chat-service`、`instance-registry`、`orchestration-bootstrap`、`orchestration-instance`）、`泄漏·` 4 行（`chat-channel-bootstrap`、`acp-ws-handler`、relay 具名行、`agent-node-bridge`）、`W4·` 1 行（`launch-spec-builder`）。

删除与改标的判据（写入文件头，可复核）：**改后既无生产也无测试消费方 → 删除**；**仅测试消费、或属泄漏/下游任务的既定范围 → 改标**。改标 `测试取用·` 而非删行的原因见 14.7 第 6 条。

### 14.5 消费方台账

**改调 `/runtime` 的生产文件 13 个**：`apps/server` 6（`main.ts`、`routes/web/{peri-task-details,environments,instances,control}.ts`、`services/core-bootstrap.ts`）+ `packages` 7（agent-config `meta-agent`、channel `hermes-client`、mcp `knowledge`、prod-view、task `agent-executor`、workflow `agent-chat-transport` 与 `index`）。另有 4 个测试文件只迁移类型导入（`SpawnedInstance` / `AgentInstanceRecord`）。

**仍经 `@fenix/agent-runtime/server` 取值的生产文件 14 个，无一处取「运行域能力」**：

| 文件 | 取自 barrel 的符号 | 角色 | 归属 |
| --- | --- | --- | --- |
| `apps/server/src/main.ts` | `bind*Port` 8 个、`createAcpRoutes` / `createApiInstanceRoutes` / `createOpenaiChatRoutes`、`environmentRepo`、`getAcpEventBus` / `getAllEventBuses` / `removeEventBus`、`getAgentNodeService`、`findMachineConnectionById`、`triggerMachineCleanupByMachineId`、`resolveWorkspacePath` | 宿主注入 | 保留（`environmentRepo` / event bus / `getAgentNodeService` 属 W6 泄漏面） |
| `apps/server/src/schemas/index.ts` | 协议 schema 具名清单（environment / instance / openai-chat） | 协议 | 保留 |
| `apps/server/src/routes/web/environments.ts` | 环境 schema 11 个、`mapOrchestrationErrorToHttp`、`sanitizeResponse` | 协议 + 错误映射 | `sanitizeResponse` 归 W6 |
| `apps/server/src/routes/web/instances.ts` | 实例 schema 4 个 | 协议 | 保留 |
| `apps/server/src/plugins/error-handler.ts` | `mapOrchestrationErrorToHttp` | 错误映射 | 保留 |
| `apps/server/src/routes/web/control.ts` | `environmentRepo`、`getEventBus` | 泄漏 | W6 |
| `apps/server/src/services/resource-module-ports.ts` | `environmentRepo` | 泄漏 | W6 |
| `apps/server/src/services/transport.ts` | `getEventBus` | 泄漏 | W6 |
| `packages/resources/agent-config/src/server/services/meta-agent.ts` | `environmentRepo`（动态 import） | 泄漏 | W6 |
| `packages/resources/observer/src/server/services/observer/observer-service.ts` | `agentInstanceRepo`、`environmentRepo`、`listAcpConnections`、`listExternalRelayEntries`、`EnvironmentRecord`、`ExternalRelayConnectionSnapshot` | 泄漏 | W6 |
| `packages/resources/observer/.../observer/types.ts` | `AcpConnectionSnapshot`、`EnvironmentRecord`、`ExternalRelayConnectionSnapshot` | 泄漏 | W6 |
| `packages/resources/observer/.../observer/providers/acp-link.ts` | `ExternalRelayConnectionSnapshot` | 泄漏 | W6 |
| `packages/resources/workflow/.../agent-chat-transport.ts` | `environmentRepo` | 泄漏 | W6 |
| `packages/resources/workflow/.../workflow-events.ts` | `EventBus`、`getEventBus`、`removeEventBus` | 泄漏 | W6 |

即：**`运行·` 面已无非测试消费方**，剩余 14 个文件分属「宿主注入 / 协议 / 错误映射 / 泄漏」四类，前三类是本片刻意保留的接口，第四类整体归 W6（与 §13.5 登记的收口对象同批）。

### 14.6 §4.6 落点与测试缝收敛

- **`AgentInstanceRuntimeOperations` 在组合根绑定**：`createAgentRuntimeModule()` 首次调用时 `bindAgentInstanceRuntimeOperations({ spawnInstance: spawnInstanceViaController, stopInstance: stopInstanceViaController, hasActiveInstance: 查 getOrchestrationController().listInstances() })`，且**只在首次绑定**（重复调用不覆盖用例后置的替身）。`main.ts` 侧只剩 `const agentRuntime = createAgentRuntimeModule().runtime;`——宿主不再把包自己导出的函数转发回来绑定。§1.5 的 registry 驱动装配接管后这一行由模块 create 承担。
- **替换缝三条归一为一条**：`setWebInstanceRouteDeps` / `resetWebInstanceRouteDeps`（删除）、`EnvironmentRouteDeps` 注入参数（删除）、port 绑定（`stubAgentRuntimePort` / `resetAgentRuntimePort`，新增）。路由不再自持可替换 deps 袋子——那不是第二个能力实现，只是同一批能力的第二个替换点。
- **宿主 preload 绑真实入口**（`setup-mocks.ts`）：`bunfig.toml` 的 preload 对全部 `bun test`（含 `bun test packages/`）生效，因此消费方在测试进程里拿到的是「真实 port + 本文件换过的替身」，与「路由直接调用包内函数」行为一致。port 的直通形态（调用时属性访问）让 round44 对 `agentInstanceService.*` 的打桩继续生效，用例只需为「要断言或要绕开」的方法加覆盖。
- **端口装配泄漏的修复（本片实测发现）**：装配状态是模块级单例，`runtime-port.test.ts` 原 `afterEach` 只调 `resetAgentRuntimeForTest()`，把绑定留成「空」。`bun test packages/` 在同进程顺序跑全部文件，于是后续文件（workflow round57 ×5、round68 ×4，共 9 例）在调用点报 `AgentRuntime has not been bound`。修复是 `afterEach` 复位后重新 `bindAgentRuntime(createAgentRuntime())`，并在用例体内显式复位/绑定；判据（「留空会让同进程后续测试文件在调用点失败」）写进用例注释。**这条不是测试写法问题，而是「模块级绑定 + 同进程多文件」这一装配形态的固有约束**，W6 移出测试 seam 时须一并保留。

### 14.7 非显然取舍

1. **`ensureInstance` 直通记录、删除 `EnsureInstanceResult`**（裁定二）。投影类型是 W3a 为「实例详情走状态组查询」自造的最小视图；一旦控制台 CRUD 进面（裁定一），调用方要回显 `name` / `environmentId`、编排层要拿记录去取租约，投影只会造出第二份视图并在两侧漂移。内部路径重构直接删除，不留兼容 shim。
2. **方法逐个直通，不在 port 内做「按 uid 查记录再启动」的包装**。若 `ensureInstanceRuntime(uid)` 在 port 里先查记录，就会在调用方刚完成归属校验之后再加一次仓储查询与 TOCTOU 窗口。代价是方法签名带 `AgentInstanceRecord`，收益是语义与实现一一对应。
3. **`stubAgentRuntimePort` 用「真实入口 + 覆盖」而不是「空对象 + 覆盖」**。消费方通常只覆盖少数方法，未覆盖的方法必须保持真实语义，否则每个用例都要复述整张 42 方法清单（那正是被删除的 deps 袋子的翻版）。
4. **`unregisterInstance` 进 port 而不是让宿主继续 import `globalInstanceRegistry`**：「从 Core runtime 删实例」必须与「清并发计数」配对，配对语义属实例生命周期（漏掉会让 `hasActiveInstance` 误判存活、实例再也回收不掉），不该作为内部表访问散在宿主里。
5. **`LightweightSession` 不外透**（`control.ts`）：会话记录的读法用 `AgentRuntimePort["getSession"]` 派生类型表达，避免为一个宿主导出的派生类型往 port 加类型出口。与 §13.3 第 5 条同源：派生类型会随实现漂移，一并记入 W6。
6. **跨包测试经 barrel 取运行内部符号的行改标而非删除**（`测试取用·`）：workflow 用例取 `globalInstanceRegistry` / `markInstanceRelayAttached` / `createPromptTurn`、observer 用例取 relay/ACP 连接表——这些**跨包用例无法改相对导入**，删行会直接打断用例，而先给「测试专用入口」属于 W6「测试 seam 移出公开面」的裁量（是否给、给成什么形状需与本包测试入口的既有口径统一）。本片不预判，改为在清单上把这类行显式标出。

### 14.8 台账 −1 条（21 → 20）

`no-circular` / `@fenix/resource-machine → @fenix/agent-config`（owner 1.5，1 处环、环长 16，参与包 `agent-config ↔ agent-runtime ↔ resource-machine ↔ resource-sandbox ↔ server-app`）。W3b 把 agent-config 对 `@fenix/agent-runtime/server` 的值导入改为经 `/runtime` 取运行能力后，该环的见证边消失，门禁报「架构例外台账有 1 条已不再违规，必须删除」。已按台账纪律删除并复跑门禁确认（0 条新增违规）。

### 14.9 验证证据

| 验证 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run precheck` | **全绿（11/11 步骤，92391ms）** |
| ├ `server-and-script-tests` | 908 pass / 0 fail（66 文件） |
| ├ `package-tests` | 7229 pass / 2 skip / 0 fail（593 文件） |
| └ `web-app-tests` | 946 pass / 0 fail（54 文件） |
| `bun run check:dependencies` | ✓ 2391 modules / **20 条已登记例外** / 0 条新增违规 |
| `bun run architecture:check` | ✓（precheck 步骤） |
| 导出面 | 同一 AST 程序去重计数：`HEAD` **314** → 新 **233**（无新增名字；逐行明细见 14.4） |
| 专项用例 | `round44-environments-routes.test.ts` + `web-instance-runtime-actions.test.ts` 32 pass / 0 fail；`bun test packages/agent-runtime/` 850 pass / 0 fail（107 文件） |
| 用例数 | `package-tests` 7229（与 W3a 持平：本片不新增用例，只改写替换缝与修复装配泄漏） |

**对 §13.4「既有红项」的更正**：`apps/server/src/__tests__/db-pool-config.test.ts` 本轮实测 **5 pass / 0 fail**，`server-and-script-tests` 全绿。用 `HEAD` 版 `setup-mocks.ts` 单独复测同样通过 → 该红项在 W3b **之前**就已不出现，§10.5 / §12.6 / §13.4 登记它的表述已过期。本片据实修正记录，**不把它的消失算作 W3b 的成果**（W3b 未触碰 `db/index.ts` 与 `createDbMock`）。

### 14.10 遗留项

| 项 | 归属 |
| --- | --- |
| 测试侧经 barrel 取值共 36 个文件（`apps/server` 8、`packages/agent-runtime` 16、workflow 7、channel 2、observer 2、task 1），其中跨包用例（workflow / observer / channel / task）无法改相对导入 | W6（测试 seam 移出公开面；跨包用例需先给测试专用入口） |
| `sanitizeResponse` / `KEBAB_CASE_RE` / `validateWorkspacePath` 仍在公开面（宿主路由取响应脱敏与名称校验） | W6 |
| 泄漏面 9 个生产文件（`environmentRepo` / `getEventBus` / `getChatChannelController` / observer 三文件 / `agent-node-bridge` / `resolveWorkspacePath` / `listAcpConnections` 等） | W6 |
| `runtime.ts` 的派生返回类型 + 契约面上的 `AgentInstanceRecord`（裁定二的已知代价） | W6 |
| `launch-spec-builder`（`W4·`，663 行）与 `AgentInstanceStarter` port、`actor-context.ts` | W4 |

## 十五、W4 设计（启动前取数搬出，2026-09-21）

本节是 W4a 编码前的设计记录，经用户 2026-09-21 裁定「先写设计小节再编码」后落笔。**W4 的目标**：把「实例起来之前拿什么参数」从 `agent-runtime` 搬出，使 `agent-runtime` 不再 import 任何资源领域包（消除 `agent-runtime-not-to-resources` 的见证边），同时按 §9.1 消除伪造 `role`、按 §9.2 收敛两条 LaunchSpec。**边界**：状态机、幂等、lease、限流、disconnect fencing、dispose、重连（第十节冻结区）一行不动。

### 15.1 两片切分与验收口径

| 片 | 动作 | 验收 |
| --- | --- | --- |
| **W4a（只加不删）** | 新契约与实现先落地并绑定，旧路径仍在 | 全绿；行为零变化；`server.ts` 导出面不减名 |
| **W4b（删旧路径）** | 删 `launch-spec-builder`(663) / `actor-context.ts`(42) / `packages/orchestration/src/launch-spec/`(107)；消台账 | 全绿；台账 5 条中 4 条删除（见 15.5） |

### 15.2 勘察实测：与 §七 估算的四处偏差

1. **`agent-config` 是 6 个文件的 port 反转，不止「补组织范围读入口」。** `packages/agent-runtime/src` 非测试代码 import `@fenix/agent-config` 的命中实测 6 文件：`services/launch-spec-builder.ts:10`（type）、`:11`（`composeAgentSystemPrompt`）、`services/orchestration-instance.ts:16`、`services/orchestration-bootstrap.ts:21`（`agentConfigRepo` + `resolveAgentNode`）、`server/services/environment-web.ts:2`（`getReadableAgentConfigById` + `resolveAgentNode`）、`server/services/api-instance.ts:1`、`server/transport/acp-ws-handler.ts:709`（动态 `import`，取 machineId）。台账指纹是包对级，**6 文件全清才能删该条**，故 6 处必须同片处理，不能只改启动路径。
2. **`model-management` 的见证边不在服务端，W4b 删不掉该条。** `packages/agent-runtime` 全仓（含 `web/`）对 `@fenix/model-management` 的命中只有一处：`tsconfig.json:29` 把 `@/src/lib/model-config-utils` 别名指向 `packages/resources/model-management/web/lib/model-config-utils.ts`，唯一消费方是 `packages/agent-runtime/web/components/chat/composer-toolbar.tsx:6`（与 `apps/web` 的 `apps/web/vite.config.ts:205` 同一条前端共享别名边）。因此该条目的 removeWhen「模型网关解析改为经 platform-sdk 暴露的受限读取入口」与服务端无关，**W4 不改其归属，需按新事实改写 removeWhen 并转 §1.7/前端边界批次**（与 `apps-boundary` 条目 #27 同因：直读 `@server/db/schema` 表定义的债归 §1.7）。
3. **`mcp` 两张表的直读走的是 `apps-boundary`，不是 `agent-runtime-not-to-resources`。** `launch-spec-builder.ts:27` 的 `mcpServer` / `agentConfigMcp` 来自 `@server/db/schema`，命中规则 `apps-boundary`（台账 #27，owner 1.7，11 文件）。故 §七 表格「台账削 5 条」应为 **削 4 条**（knowledge / agent-config / memory / skill）。
4. **§9.2 的收敛代价比预估小：扁平 `LaunchSpec` 的有效载荷只有 2–3 个标量。** 实测全部消费点：`agent-node.ts:163` 取 `launchSpec.environmentId` 与 `launchSpec.agentConfig.id`；`orchestration-instance.ts:103`（`spawnInstanceViaCore`）只取 `environmentId` / `userId`（函数注释原文「仅取 environmentId/userId」）；`buildAgentLaunchSpecForCore` 自己按 `environmentId` 重读 env 行；`AgentController.spawnInstance` 在步骤 1 已经读到 `environment.agentConfigId`。`cwd` / `engine` / `agentConfig.skills` 在 builder 之外**零消费方**。故「先建扁平 spec、再重读 DB 建增强 spec」的双路径可以在 W4b 直接删除：`AgentController` 改从已读到的 env 行取 `agentConfigId`，`_spawnInstance` 改吃 `{ environmentId, agentConfigId }`，`spawnInstanceViaCore` / `refreshInstanceEnvironment` 改吃 `(environmentId, userId)`。

### 15.3 目标形状与契约

**端口方向裁定为 pull（推荐）**，理由：§3.2 的爆炸半径实测是「2 个调用点 + 1 处宿主绑定」，而 push 版（Facade 主动调 `AgentInstanceStarter.startInstance`、各启动方改走 Facade）必须改启动入口本身——`AgentInstanceRuntimeOperations` 三动词与 `AgentInstanceRuntimeAdapter.start` 的签名都在**冻结文件** `agent-instance-service.ts` 内，改它即违反红线。因此：

```text
环境行（agent-runtime 读，仅 environmentId/organizationId/agentConfigId/secret）
        │
        ├─ AgentLaunchSpecPort（agent-runtime 声明并消费，apps/server 绑定）
        │        │  实现：调 agent-config 的 Domain Service
        │        └─→ AgentConfig（skill/mcp/model-management/knowledge/memory 的包根 Domain Service）
        │
        └─ 取回 AgentLaunchSpec → 合并 platformEnv → core.launchInstance（原路径不变）
```

**新端口 `AgentLaunchSpecPort`（不是 `AgentInstanceStarter`）**：§4.4 已裁定 `AgentInstanceStarter` 一名由 `AgentInstanceRuntimeOperations`（包内反向 seam，W3b 后由 `runtime.ts` 装配时绑定）持有，冻结文件只允许 import 行变更 → **无法让名**，新端口另行命名，落点 `packages/agent-runtime/src/server/services/agent-launch-spec-port.ts`（既有 10 个「宿主注入·」port 同层同向，零新增包间边）：

```ts
/** 一次实例启动所需的已授权启动参数请求（资源解析由 agent-config 完成）。 */
export interface AgentLaunchSpecRequest {
  environmentId: string;
  organizationId: string;
  ownerUserId: string;   // 实例属主（真实身份，不是伪造 actor；§9.1）
  agentConfigId: string; // 来自 environment 行
  environmentSecret: string; // 仅用于知识库 MCP 的 Authorization header（见下「密钥边界」）
  extraEnv?: Record<string, string>;
}

/** agent-runtime 消费、apps/server 绑定：产出已授权的 AgentLaunchSpec。 */
export interface AgentLaunchSpecPort {
  buildAgentLaunchSpec(request: AgentLaunchSpecRequest): Promise<AgentLaunchSpec>;
}
```

**第二个窄端口 `AgentConfigLookupPort`（2026-09-21 裁定四）**：启动路径之外还有 4 处调用点要读 agent 配置行，它们不属于「实例起来之前拿什么参数」但同属 agent-config 的 import 面（不清就无法删台账条目，指纹是包对级），故同片反转为第二个宿主注入端口，与启动端口同层同向（`packages/agent-runtime/src/server/services/agent-config-lookup-port.ts`）：

| 调用点 | 现状 | 反转后 |
| --- | --- | --- |
| `environment-web.ts:158` / `:232` | `getReadableAgentConfigById(toActorContext({...role:"owner"}), id)` + `resolveAgentNode` | `port.findVisibleAgentConfig({agentConfigId, organizationId, userId})`，取投影里的已解析节点 |
| `api-instance.ts:87` | 同上一类（`typeof getReadableAgentConfigById` 作默认依赖） | 默认依赖改端口动词，`InstanceDeps` 里的类型改为本包结构类型 |
| `acp-ws-handler.ts:709` | 动态 `import { getAgentConfigById }` 取 `machineId` | `port.findAgentConfig(agentConfigId)`（无授权读；调用方已持有 environment 且校验过归属） |

```ts
/** 执行节点：agent-config 的 `agentNode` 与扁平 `machineId` 已在此收敛为一处判定。 */
export type AgentExecutionNode =
  | { readonly kind: "machine"; readonly machineId: string }
  | { readonly kind: "sandbox"; readonly sandboxPoolId: string };

/** 已解析的配置投影：不含资源授权模型，也不含 `access` 元数据。 */
export interface AgentConfigLookupResult {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly node: AgentExecutionNode | null; // 未绑定任何节点时为 null
}

export interface AgentConfigLookupPort {
  /** 无授权按资源 ID 读（transport 层机器解析）。 */
  findAgentConfig(agentConfigId: string): Promise<AgentConfigLookupResult | null>;
  /** 按真实用户身份的组织可见性读（环境绑定校验、实例自动创建）。 */
  findVisibleAgentConfig(input: {
    agentConfigId: string;
    organizationId: string;
    userId: string;
  }): Promise<AgentConfigLookupResult | null>;
}
```

形状取舍两点：**节点解析规则（`agentNode` 优先、回退 `machineId`、`{}` 归一为 `null`）留在 agent-config**，agent-runtime 只消费投影——否则 `resolveAgentNode` 的语义会被复制到本包（`environment-orchestration.ts:108` 已有一份对齐注释，不能变成三份）；**`machineName` 推导仍留 `environment-web`**（它读的是 agent-runtime 自己的 `machine` 表，属本包数据，不构成跨包边）。

**该端口超出 §15.4 原报的「新增 1 个端口」，已按 CLAUDE.md「公共契约明显变化须先反馈」在编码前提交用户裁定（裁定四 = A）。**

**三张表：什么留在 agent-runtime / 什么搬进 agent-config / 什么新增**

| 项 | 归属 | 说明 |
| --- | --- | --- |
| 环境行读取（`environmentRepo.getById`）、`platformEnv`（`USER_META_*` / `LANGFUSE_USER_ID`）、`extraEnv` 合并、core `launchInstance` 调用 | **留 agent-runtime**（`orchestration-instance.ts`） | 属「实例上下文」，与密钥同源；`env.userId` / `env.organizationId` / `env.secret` 都在这里取 |
| `buildLaunchSpec`(663) 主体：skill 文件系统、Hindsight env、knowledge 绑定、MCP 翻译、model/provider 解析、`composeAgentSystemPrompt`、`buildBasicLaunchSpec`、`RuntimeCredentialResolver`、`setBuildLaunchSpec` 测试缝 | **迁 agent-config**（`src/server/services/agent-launch-spec/*`，单文件需按 500 行上限拆分） | 迁入后 `composeAgentSystemPrompt` 与 `AgentConfigDetailWithAccess` 变为包内依赖，自动消解 2 处边 |
| `getAgentConfigById` / `getReadableAgentConfigById` 之外的「组织范围读」入口（§9.1） | **agent-config 新增**，落 `src/server/system-entries.ts` | 归属组织相同 → 放行；否则资源对其他组织公开可读 → 放行（对齐 `createWebEnvironment:156` 的绑定校验）；否则 `null`。**不接受 `ActorContext`，不返回 `access` 元数据**（消除 §9.1 的虚高定时炸弹） |
| skill / mcp / model-management / knowledge / memory 的读取 | **各资源包补包根公开 Domain Service**（§2.2：Domain Service 不接受 actor、不做用户授权） | 现状 `skill` / `mcp` 包根只有 `get*ServerModule()` 间接读，`model-management` 只到 repository/service 层；`knowledge` / `memory` 已有够用的包根入口 |
| `resolveAgentNode`（纯函数 `{agentNode, machineId} → AgentNode`） | **随调用点归位** | `environment-web` / `orchestration-bootstrap` 的用法在 6 文件反转中一并处理，不放公开面 |
| `buildLangfuseEnv()`（读宿主 `config.langfuse*`） | **留 agent-runtime 侧合并** | 合并顺序必须保持 `{ ...hindsight, ...langfuse, ...extraEnv }`（显式传入优先），故 agent-config 只产出 Hindsight 部分 |

**密钥边界（本节的关键取舍）**：`environmentSecret` 必须进入组装函数——`buildLaunchSpec:561` 把它写进知识库 MCP 项的 `Authorization: Bearer` header，只有组装方知道该 header 的形状。因此端口入参**含密钥**，边界约束为：仅同进程内传递，不落盘、不入日志、不进错误消息（现有实现已如此，迁移不得放宽）；`extraEnv` 合并仍在 agent-runtime 完成，密钥不经端口回流。

### 15.4 W4a 交付清单（只加不删）

1. `packages/agent-runtime/src/server/services/agent-launch-spec-port.ts`：`AgentLaunchSpecPort` + 绑定/复位（`bindAgentLaunchSpecPort` / `resetAgentLaunchSpecPort`），并在 `orchestration-instance.ts` 的 `buildAgentLaunchSpecForCore` 内改为经端口取 spec（旧 `buildLaunchSpec` 调用暂时保留为端口的默认实现，保证本片行为零变化）。
2. `packages/resources/agent-config`：迁入 spec 组装（`agent-launch-spec/`，拆到 ≤500 行/文件）+ `system-entries.ts` 补组织范围读入口 + Facade 侧补齐「谁调组装」的边界（**W4a 不新增启动路径**）。
3. 三个资源包补包根 Domain Service：`skill`（skill 行按 ID 读）、`mcp`（mcpServer 行按 ID 读）、`model-management`（model/provider 受控读——已有 `createProviderService`/`ProviderFacade`，按其口径收敛为 Domain Service）。
4. `apps/server/src/main.ts` 绑定两个端口（`AgentLaunchSpecPort` 与 `AgentConfigLookupPort`，实现均委托 agent-config），并保留既有 `setRuntimeCredentialResolver` 绑定的等价注入路径（改为构造期注入 agent-config 的组装 service）。
5. 6 文件的 agent-config 依赖反转：`orchestration-bootstrap.ts`（`agentConfigRepo` 随 15.2-4 的收敛删）、`environment-web.ts`、`api-instance.ts`、`acp-ws-handler.ts` 改走 `AgentConfigLookupPort`，`orchestration-instance.ts` 改走 `AgentLaunchSpecPort`；`actor-context.ts` 保留到 W4b 一并删除（其消费点在本片全部改造完毕，届时 `toActorContext` 的调用点为零）。

### 15.5 W4b 交付清单（删旧路径 + 台账）

1. 删 `packages/agent-runtime/src/services/launch-spec-builder.ts`(663) 与 `services/actor-context.ts`(42)；`server.ts` 的 `W4·` 行一并删除。
2. 按 §9.2 删 `packages/orchestration/src/launch-spec/`(107)：`AgentController` 去掉 `launchSpecBuilder` 依赖、改从 env 行取 `agentConfigId`；`_spawnInstance` 改吃 `{ environmentId, agentConfigId }`；`spawnInstanceViaCore` / `refreshInstanceEnvironment` 改吃 `(environmentId, userId)`；`orchestration/src/index.ts` 的导出与 `types/deps.ts` 的 `AgentConfigData` / `AgentConfigRepo` / `AgentEngineData` / `AgentEngineRepo` 一并删除，`apps/server/src/repositories/agent-engine.ts` 随之删除。
3. **台账**：削 `agent-runtime-not-to-resources` **4 条**（`resource-knowledge` / `agent-config` / `resource-memory` / `resource-skill`——见证边分别在 `launch-spec-builder.ts:16` / 6 文件 / `:17` / `:24`）；`model-management` 条按 15.2-2 改写 removeWhen 并转 §1.7，**不删**。
4. 测试迁移：12 个 agent-runtime 用例文件（`round43-launch-spec-builder`、`round44-launch-spec-builder-config`、`launch-spec-*` 5 个、`rmd01-runtime-surface`、`orchestration-instance-rollback`、`agent-concurrency-toctou`、`orchestration-instance-nodeid`）+ `apps/server/src/__tests__/round22-launch-spec-isolation.test.ts` + `apps/server/src/test-utils/stubs/module-stubs.ts` 的 `stubLaunchSpecBuilder`。其中 4–5 个文件断言的是 drizzle 查询结构，迁入 agent-config 后应改为对 Domain Service 替身断言（规模见 15.7 裁定项三）。

### 15.6 验证方式

- 每片：`env -u ANTHROPIC_MODEL bun run precheck` 全绿；`bun run check:dependencies` 台账条目数与预期一致（W4a 不变、W4b −4）。
- 行为等价证据：W4a 保留旧实现为端口默认实现，可用「同一 `environmentId` + `userId` 产出 spec 逐字段对比」的临时脚本取证（仅在 W4a 提交前跑，不进仓库）；W4b 后由迁移后的用例覆盖同一断言面。
- `packages/orchestration` 改动：`bun test packages/orchestration/` 专项。

### 15.7 四项裁定（2026-09-21 用户弹窗确认）

| 项 | 候选 | 裁定 |
| --- | --- | --- |
| **组装落点** | A = 组装迁入 `agent-config` 且三资源包补包根 Domain Service（§2.2 终态，伴随 `apps-boundary` 债减少）；B = 只搬文件、6 表读沿用 `@server/db/schema`，Domain Service 收口留 §1.7（W4a 规模最小） | **A**（按 §4.4/§4.5 原计划） |
| **端口方向** | pull（`AgentLaunchSpecPort`，agent-runtime 取数、宿主绑定）；push（Facade 主动调启动，需穿冻结文件 `agent-instance-service.ts`） | **pull**（`AgentLaunchSpecPort`） |
| **测试迁移口径** | 按断言面改写（drizzle 查询结构断言 → Domain Service 替身断言，业务结果不变）；逐行保留查询结构断言（W4a 规模显著上升，需另议切片） | **按断言面改写** |
| **第二端口（编码期新增）** | A = 加 `AgentConfigLookupPort` 承载启动路径之外的 4 处 agent-config 读取（W4a 内收口 import）；B = 只做启动端口，这 4 处另开 W4c（W4b 只能削 3 条台账）；C = 绑定校验上移 apps/server 的 use case（改 `createWebEnvironment` 参数契约） | **A**（详见 §15.3 末尾） |

由此 W4a 的规模基线确定为：新增 2 个端口（启动端口 + 配置查询端口）+ 1 个 org 范围读入口 + 3 组包根 Domain Service + 663 行组装迁入并拆文件（≤500 行/文件）+ 6 文件依赖反转 + 12 个 agent-runtime 用例与 1 个宿主用例按断言面改写。**该规模超过用户既定红线「约 300 行以上非测试逻辑需先反馈范围」**——已在本节反馈并获批，实施中若再出现职责、数据流或公共契约的明显变化，按 CLAUDE.md 要求再次反馈（裁定四即按此追加）。

## 十六、W4a 交付记录（端口 + 宿主绑定 + 4 文件反转，2026-09-21）

W4 按 §15.1 拆两片，本节是 **W4a（只加不删）**：新契约与新实现落地并绑定，旧路径仍在原处。四个提交落地——设计记录 `e75b34566`（§15.3 第二窄端口裁定）、三资源包 Domain Service `0a6d6f371`、agent-config 组织范围读入口 `4e845da89`、组装迁入并拆文件 `5d496d604`、端口与宿主绑定 `de4554877`。

**「实例起来之后怎么管」一行未动**：状态机、幂等、lease、并发限流、disconnect fencing、dispose、重连全程零 diff。冻结区 10 个文件（`agent-instance-service.ts` / `agent-instance-runtime-coordinator.ts` / `relay-handler.ts` / `lifecycle-port.ts` / `external-relay.ts` / `agent-relay.ts` / `transport/event-bus.ts` / `services/environment-startup-lock.ts` / `services/session.ts` / `services/environment.ts`）在本片四个提交中的合并 diff **实测为空**——连 §二 允许的 import 行变更都没用到。

### 16.1 交付清单（对账 §15.4）

| §15.4 条目 | 落点 | 提交 |
| --- | --- | --- |
| 1 启动端口 `AgentLaunchSpecPort` + 绑定/复位 + `buildAgentLaunchSpecForCore` 改经端口 | `packages/agent-runtime/src/server/services/agent-launch-spec-port.ts`（110 行）；组装调用点改 `getAgentLaunchSpecPort().buildAgentLaunchSpec(...)` | `de4554877` |
| 2 agent-config 迁入组装（≤500 行/文件）+ 组织范围读入口 | `packages/resources/agent-config/src/server/services/agent-launch-spec/`（8 文件 910 行，最大 `assembler.ts` 159 行）+ `system-entries.ts` 的 `getAgentConfigVisibleToUser` + Facade 只读字段方法 | `5d496d604` / `4e845da89` |
| 3 三资源包补包根 Domain Service | `mcp`（`mcp-server-service.ts` 按 ID 读）、`model-management`（`model-service.ts` 66 行，Model/Provider 受控读）、`skill`（`skill-service.ts` 按 ID 读）；三包 `server.ts` 各补一行导出、`testing.ts` 同步补替身 | `0a6d6f371` |
| 4 `main.ts` 绑定两个端口 + 保留 `setRuntimeCredentialResolver` 等价注入 | 适配集中在新文件 `apps/server/src/services/pre-launch-ports.ts`（97 行），`main.ts` 只接线 19 行；`setRuntimeCredentialResolver` 与端口注入并存（见 16.3-4） | `de4554877` |
| 5 agent-config 依赖反转 | 实际 **4 个文件**（见 16.2-3）：`orchestration-instance.ts`（启动端口）+ `environment-web.ts` / `api-instance.ts` / `acp-ws-handler.ts`（查询端口） | `de4554877` |

**导出面**：`server.ts` 新增两行（`宿主注入·Agent 配置查询投影（W4a）` / `宿主注入·启动参数组装（W4a）`），**无名字被删除**（W3b 收窄后的 233 名 → 235，满足 §15.1「导出面不减名」）。

**新增测试 10 例**（`package-tests` 7229 → 7239）：`system-entries-visible-to-user.test.ts`（组织范围读入口的可见性判定）与 `agent-launch-spec-assembler.test.ts`（组装逐字段断言，290 行）。

### 16.2 与 §15.4 的三处偏离与一处补全

| 项 | §15.4 原文 | 实际落地 | 理由 |
| --- | --- | --- | --- |
| 启动端口的动词数 | §15.3 只画了 `buildAgentLaunchSpec(request)` | 端口两个动词：`buildAgentLaunchSpec` + `buildMinimalAgentLaunchSpec`（对应迁入后的 `assembler.buildMinimalLaunchSpec`） | 无 `agentConfigId` 的环境（`buildBasicLaunchSpec` 旧路径）也必须经端口出包，否则 `orchestration-instance.ts` 仍要直接 import 旧实现，「包内零 agent-config import」不成立、台账条目删不掉。两动词共用同一份请求形状，最小路径只少 `agentConfigId` / `environmentSecret` |
| 节点解析的消费方式 | §15.3 表格只写「取投影里的已解析节点」 | `environment-web`（2 处）与 `acp-ws-handler` 统一按 `node?.kind === "machine"` 判定后再取 `machineId`；`orchestration-instance.ts` 的机器缓存预热同形 | 旧代码在 3 个调用点各自读扁平 `machineId`，而在 `agentNode` 覆盖 `machineId` 的场景下语义不同（`resolveAgentNode` 优先 `agentNode`）。统一按已解析节点后，行为收敛到 `environment-web` 既有语义（`agentNode` 优先）——这是**有意的行为收敛**，不是等价迁移；`agentNode` 与 `machineId` 不一致的存量行按新语义执行 |
| 反转的文件数 | §15.4-5 写 6 个文件 | **4 个文件**：`orchestration-bootstrap.ts` 与 `actor-context.ts` 留到 W4b | `orchestration-bootstrap.ts` 的两处 agent-config import 中，`agentConfigRepo` 的唯一用途是给 W4b 要删的扁平 `LaunchSpecBuilder` 供数、`resolveAgentNode` 所在的解析器与本片两个端口无关，两者都随 §15.2-4 的收敛自然消失，现在改一遍等于为将删的代码写适配；`actor-context.ts` 的 `toActorContext` 在本片后消费点只剩两个过渡默认实现，按 §15.4-5 原文留到 W4b 整文件删 |
| §9.1 连带（**超出 §15.4 的补全**） | §15.4 未列 | `connectAgentInstance` 的入参由 `ActorContext`（含伪造 `role`）收窄为新的 `InstanceOwner {organizationId, userId}`；`routes/api/instances.ts` 不再转发 `role` | 该调用点是查询端口 4 处消费之一，若继续接受 `role` 就等于让端口背着一个已判死刑的授权模型。收窄后 `toActorContext` 在宿主路由侧的最后一个消费点消失（余两个过渡默认实现），为 W4b 整文件删 `actor-context.ts` 铺平 |

### 16.3 非显然取舍

1. **宿主适配独立成 `apps/server/src/services/pre-launch-ports.ts`，而不是写进 `main.ts`**。理由三条：`main.ts` 已 631 行（CLAUDE.md 的 500 行硬线上属既有债务，本片不加剧）；端口请求说 `ownerUserId`（实例属主）、组装器入参说 `userId`（资源语境下的用户）——同一主体两个名字，需要**一处**显式对齐；与已有的 `resource-module-ports.ts` 同为「宿主为包的端口提供实现」的分工，放在同层才是一类东西。
2. **`ownerUserId → userId` 的翻译只做一次**。端口沿用 §15.3 的 `ownerUserId` 是刻意的（§9.1 口径下这一侧说的是「实例属主」），而迁入 agent-config 的组装器沿用 `userId`（它读的每一张资源表都用这个列名）。让任一侧改名都会把「实例语境」和「资源语境」捏成一个词，反而更难辨认授权面的边界，故在适配层显式对照。
3. **启动路径多一次已授权读**。旧实现「读一次 agent-config 行、借给两个消费方」（组装 spec + 预热 `agentMachineCache`），现在组装在 agent-config 内自己读、机器缓存另取一次投影。代价：每次实例启动多一次已授权查询（非热路径，每次实例启动一次）；收益：资源行不再跨包流动。这是本片唯一一处**新增 DB 读**，记录在此以便后续若出现性能问题可定位。
4. **端口在宿主未绑定时回退到包内旧实现**（`legacyAgentLaunchSpecPort` / `legacyAgentConfigLookupPort`）。这是「只加不删」的实现方式：包内既有用例（`orchestration-instance-*`、`launch-spec-*` 等 12 个文件）仍走旧 `buildLaunchSpec`，断言面零改动。代价是端口此刻有两个实现、且「未绑定即失败」的判据被暂时放宽——故回退明确标注为过渡：W4b 删旧实现时一并删回退，届时两个端口与既有 10 个「宿主注入·」端口同形（未装配即 fail-fast）。
5. **生产路径在 W4a 即切换到新实现**。`main.ts` 在启动序列后绑定两个端口，故「行为零变化」是对**包内用例**而言；生产路径的等价性由迁入侧的新用例（10 例逐字段断言）+ 逐字段迁移评审承担。宿主级的端到端等价断言（§15.5-4 的 `round22-launch-spec-isolation` 与 `module-stubs.ts` 的 `stubLaunchSpecBuilder`）按原计划归 W4b——它们在 W4a 期间仍断言旧路径，若现在就改写会同时锁住两套实现。
6. **查询实现放 agent-config 侧并经子路径导出**（`@fenix/agent-config/server/agent-config-lookup`，实现 `createAgentConfigLookup()` 69 行）。节点判定规则（`agentNode` 优先、回退 `machineId`、`{}` 归一为 `null`）必须与组装侧同处一份实现，故投影在 agent-config 生成、宿主只做一句绑定。两个端口的**结构类型在包间各自声明、不共享**（agent-runtime 声明 `AgentConfigLookupResult`，agent-config 产出结构相同的 `AgentConfigLookupResult`），符合包间只经稳定接口耦合、不互引类型的既有口径。
7. **`InstanceDeps` 的键改名是机械调整，不在 §15.5-4 的清单里**。`api-instance.ts` 的默认依赖键由 `getReadableAgentConfigById` 改为端口动词 `findVisibleAgentConfig`，波及 2 个包内用例（`api-instance-routes.test.ts` 5 处、`api-instance-service.test.ts` 2 处）：只改键名、去掉传入的 `role`，**断言一行未动**。这 2 个文件不在 12 文件清单中，属于为让本片编译通过所必需的最小改动。
8. **`hindsightApiToken` 经端口依赖注入而非模块配置**。`HINDSIGHT_API_TOKEN` 只声明在宿主 `apps/server/src/env.ts`，memory 模块配置只承载 Hindsight 地址，密钥不该随地址走；故经 `PreLaunchPortsDeps` 传入组装器，与 `environmentSecret` 同一边界——仅同进程传递，不落盘、不入日志、不进错误消息。

### 16.4 台账 20 → 19（本片唯一的台账变化）

删除 `no-circular` / `@fenix/agent-runtime → @fenix/agent-config`（owner 1.5，2 处环、环长 5，参与包 `agent-config ↔ agent-runtime ↔ server-app`）。

**原因不是环消失了，而是代表边换了层**：`dependency-cruiser` 的 `no-circular` 违规按「环的代表边」记指纹，本片把 `orchestration-instance.ts` / `environment-web.ts` / `api-instance.ts` / `acp-ws-handler.ts` 的跨包 import 换成包内端口文件后，这些环的代表边落到包内（`agent-runtime/src/server.ts → agent-runtime/src/server/services/agent-config-lookup-port.ts`），指纹并入已登记的包内自环条目。实测：原始报告共 73 条环违规，含 agent-config 的环 63 条、全部含 agent-runtime，代表边均落在包内；agent-runtime ↔ agent-config 的跨包代表边为 0 条。门禁按指纹比对，直接报「架构例外台账有 1 条已不再违规，必须删除」，**无法保留**。

该条的 `removeWhen` 原文是「1.4 收敛 agent-config 读取 + 1.5 下沉宿主能力」——底层的包间环（`agent-config → apps/server → agent-runtime → agent-config`）随 W4b 删旧路径与 §1.5 下沉宿主能力后才会真正消失；本片只是让它的见证边不再落在包对之间论，故按台账纪律删除并**在此显式记账**（§15.7 原计划把台账收口整体归 W4b）。

`agent-runtime-not-to-resources` / `@fenix/agent-config`（owner 1.4）**本片不删**：agent-runtime 仍有三处 agent-config import（两个过渡默认实现 + `orchestration-bootstrap.ts`），按 §15.5-3 归 W4b。

### 16.5 验证证据

| 验证 | 结果 |
| --- | --- |
| `bunx tsc --noEmit` | 0 error |
| `env -u ANTHROPIC_MODEL bun run precheck` | **全绿（11/11 步骤，96040ms）** |
| ├ `server-and-script-tests` | 908 pass / 0 fail（66 文件） |
| ├ `package-tests` | **7239 pass** / 2 skip / 0 fail（595 文件；W3b 7229 → +10 = 本片新增 2 个用例文件） |
| └ `web-app-tests` | 946 pass / 0 fail（54 文件） |
| `bun run check:dependencies` | ✓ 2406 modules / **19 条已登记例外** / 0 条新增违规（复跑确认；2391→2406 modules、20→19 条） |
| `bun run architecture:check` | ✓ 2254 files / 11 rules / 28 条已登记例外 |
| `bun test packages/agent-runtime/` | 850 pass / 0 fail（107 文件）——与 W3b 持平，本片不在本包新增用例 |
| 冻结区 | 10 个文件合并 diff 为空（`git diff --stat` 实测） |
| 提交规模 | `de4554877` 15 文件 +487/−83；`5d496d604` 13 文件 +1213；`4e845da89` 5 文件 +198；`0a6d6f371` 13 文件 +230 |

### 16.6 遗留项（W4b 及以后）

| 项 | 归属 |
| --- | --- |
| 删 `services/launch-spec-builder.ts`(663) / `services/actor-context.ts`(42) / 两个端口内的过渡默认实现（`legacyAgentLaunchSpecPort` / `legacyAgentConfigLookupPort`）/ `server.ts` 的 `W4·` 行 | W4b |
| `orchestration-bootstrap.ts` 的 `agentConfigRepo` 与 `resolveAgentNode` import（本片有意保留，见 16.2-3） | W4b（随 §15.2-4 收敛一并删） |
| 按 §9.2 删 `packages/orchestration/src/launch-spec/`(107) 与 `apps/server/src/repositories/agent-engine.ts` | W4b |
| 台账：削 `agent-runtime-not-to-resources` 4 条（`resource-knowledge` / `agent-config` / `resource-memory` / `resource-skill`）；`model-management` 条按 §15.2-2 改写 `removeWhen` 并转 §1.7 | W4b |
| 测试迁移：12 个 agent-runtime 用例文件 + `apps/server/src/__tests__/round22-launch-spec-isolation.test.ts` + `apps/server/src/test-utils/stubs/module-stubs.ts` 的 `stubLaunchSpecBuilder`，按断言面改写（裁定三） | W4b |
| 启动路径新增的一次已授权读（16.3-3）；`agentNode` 与 `machineId` 不一致存量行的行为收敛（16.2-2） | 观察项，无移除条件 |

## 十七、W4b 交付记录（删旧路径 + 消台账，2026-09-21）

W4 的第二片，按 §15.1 的切分执行「删旧路径」，两个提交落地——`9c9685aa2`（W4b-1，按 §9.2 收敛两条 LaunchSpec、编排域只吃启动身份）与 `afe16d3c3`（W4b-2，删组装旧路径 + 测试按断言面迁移 + 消台账）；合计 59 文件 +1503/−3931。

**「实例起来之后怎么管」一行未动**：冻结区 10 个文件（清单同 §16）在 `3ed23a59c..HEAD` 的合并 diff **实测为空**（`git diff --stat` 无输出），未用到 §二 允许的 import 行变更。

### 17.1 交付清单（对账 §15.5 与 §16.6）

| 条目 | 落点 | 提交 |
| --- | --- | --- |
| §15.5-2 按 §9.2 删扁平 LaunchSpec | `packages/orchestration/src/launch-spec/`（`launch-spec-builder.ts` 107 + `types.ts` 23）删除；`AgentController.spawnInstance` 只吃 `{environmentId, agentConfigId}`，两类拒绝保留为 `LaunchSpecBuildError`（错误码与 422 映射不变）；`orchestration-instance.ts` 启动身份收窄为 `LaunchTargetRef`；`orchestration-bootstrap.ts` 内联节点读取口径（§15.7 裁定 A）；`types/deps.ts` 的 `AgentConfigData` / `AgentConfigRepo` / `AgentEngineData` / `AgentEngineRepo` 与宿主死代码 `apps/server/src/repositories/agent-engine.ts`(37) 一并删除 | `9c9685aa2` |
| 节点规则等价钉桩 | 新增 `apps/server/src/__tests__/orchestration-node-resolution-parity.test.ts`（76 行 / 17 例）：用同一组输入把内联口径与 `@fenix/agent-config` 的 `resolveAgentNode` 逐字钉住 | `9c9685aa2` |
| §15.5-1 删组装旧路径 | `services/launch-spec-builder.ts`(663) / `services/actor-context.ts`(42) 删除；两个端口删过渡默认实现、未绑定即 fail-fast；`runtime.ts` 删 `setRuntimeCredentialResolver`；`server.ts` 删 `W4·` 标注行与旧导出；`main.ts` 删旧槽位调用；`module-stubs.ts` 删零消费方的 `stubLaunchSpecBuilder` | `afe16d3c3` |
| §15.5-4 测试迁移 | 见 17.2-1：删 10 个旧用例文件（1949 行 / 52 个 `test(`）、新增 4 个、改写 3 个；1 个文件判定保留不动 | `afe16d3c3` |
| §16.6 两个端口的过渡实现 | `legacyAgentLaunchSpecPort` / `legacyAgentConfigLookupPort` 删除，端口与其余 10 个「宿主注入·」端口同形 | `afe16d3c3` |
| §15.5-3 台账 | 削 4 条 + `model-management` 条转 §1.7 + `apps-boundary` 条据实重测（见 17.4） | `afe16d3c3` |

### 17.2 偏离与判定（对账 §15.5-4）

1. **测试迁移的实际范围不是「12 个文件」。** 逐文件判定后：**删除 10 个**（`launch-spec-*` 7 个 + `round43` + `round44` + workflow 的 `workflow-provider-model-access`）、**新增 4 个**（`agent-launch-spec-mcp-resolution` / `-model-resolution` / `-memory-env`、`model-management` 的 `model-service`）、**改写 3 个**（`agent-launch-spec-assembler` 补 2 例、宿主 `round22` 整文件重写为输入边界 + 反向守卫、`agent-concurrency-toctou` 与 `orchestration-instance-rollback` 的注入方式）。`rmd01-runtime-surface.test.ts` **保留不动**：它那一行 `src/services/launch-spec-builder.ts` 属「旧根路径不得存在」的守卫清单，仓库根 `src/` 整体已不存在、条目语义仍成立，改动等于顺手改无关文件。
2. **`machine 配置不改变调用方隔离标识`（`round43:168`）判为「新 API 结构上消除」而非搬运。** 新组装器只吃 `{organizationId, userId, …}`，从不读 `agentConfig.machineId` 参与身份判定，该断言在新接口下**没有对应可失败的形状**；以 assembler 新增用例「并发组装保持调用方身份隔离」（4 个组织并发、逐个断言身份保留）替代。**这是断言面的替换，不是等价迁移**，在此显式记账。
3. **`launch-spec-builder-hindsight.test.ts` 是死测试。** 它在被测文件里自造了一份 `buildCcbHindsightEnv`，从不执行生产代码；因此迁入的不是「原样搬运」而是按现实现重新钉住同一条行为契约（`agent-launch-spec-memory-env.test.ts`）。同批把 `memory-env.ts` 里夸大校验范围的注释按实现改正（实现只校验「数组 + 首项是字符串」）。
4. **`pre-launch-ports.ts`（宿主端口翻译 `ownerUserId → userId`、注入 `resolveSecretReference`）零测试覆盖。** 补测需挂载 agent-config / model-management / mcp / skill 四个模块注册表，宿主测试基建无此先例；按 CLAUDE.md「超出当前任务的改进建议只记录」列为遗留项（17.6）。
5. **包内两处用例改吃 `stubAgentLaunchSpecPort`**（本片新增于 `packages/agent-runtime/src/server/testing.ts`）：端口改 fail-fast 后，`orchestration-instance-rollback` 与 `agent-concurrency-toctou` 无法再用「真实组装 + `stubDb` 供 provider/model 行」走完启动链路。替身返回一份内容无关的 spec（`apiKey` 留空串），两文件随之删去 provider/model 行替身——断言面从「组装能跑通」变为「编排语义」，与本片把组装 owner 交还 agent-config 一致。
6. **`stubDb` 不再是本包启动链路的隐性前提。** 回滚用例的序号注入（`getById` 第 2 次抛错）仍然依赖真实 `buildAgentLaunchSpecForCore` 先读环境行，因此「环境行读取」没有被一起替换掉——替换的只有端口之后的那一段。

### 17.3 非显然取舍

1. **`@server/config` 留在了 agent-runtime。** `orchestration-instance.ts` 的 `config.defaultEngineType`（本地执行的 engine）与 `getBaseUrl()`（喂 `USER_META_BASE_URL`）是「实例跑在哪、用谁的密钥」的实例上下文（§15.3 三张表），不属于被搬走的「取数」。代价是 `apps-boundary` 条不能按原计划随 W4 完成，`removeWhen` 据实改写（17.4）。
2. **替身的复位挂 `resetAllStubs()`**，而不是让用例显式 `afterEach`：`initializeAgentRuntimeModuleConfig()` 的 `beforeEach` 已经会复位全部替身，漏挂复位会让「单跑绿、全量跑红」——即本包 `testing.ts` 文件头给 `registerStubResetter` 定的用法。
3. **端口的「未绑定即失败」判据回到严格形态。** W4a 为了让包内既有用例零改动而暂时放宽（回退到包内旧实现），W4b 删回退后未绑定即抛 `AgentLaunchSpecPort has not been bound`，宿主侧唯一绑定点是 `main.ts` 的 `bindAgentLaunchSpecPort(preLaunchPorts.launchSpec)`。
4. **两个端口的替身只在 agent-runtime 侧新增，agent-config 侧不新增。** 组装规则的断言归 agent-config 的 `agent-launch-spec-*.test.ts`（真实实现，逐字段），端口替身只服务「编排语义」用例；两侧都不需要「既存在替身又断言真实组装」的双份实现。

### 17.4 台账 20 → 16（削 4 条 + 2 条据实改写）

| 条目 | 处置 | 事实 |
| --- | --- | --- |
| `agent-runtime-not-to-resources` × 4：`resource-knowledge` / `agent-config` / `resource-memory` / `resource-skill` | **删除** | 门禁直接报「4 条已不再违规，必须删除」，与 §15.5-3 的计划逐条一致。登记条目 48 → 44、命中 19（W4a）→ 20（W4b-1）→ **16**、`owner: "1.4"` 11 → **7** |
| `agent-runtime-not-to-resources` / `@fenix/model-management` | **不删**，改写 `removeWhen` + `owner` 转 `1.7` | 唯一命中仍是 `tsconfig.json:29` 的 `@/src/lib/model-config-utils` 前端共享别名（消费方 `composer-toolbar.tsx:6`）；**服务端命中已随搬出归零**。剩余边与 §5.1 无关，按 §15.2-2 转 §1.7 与前端边界批次 |
| `apps-boundary`（`@fenix/agent-runtime → @fenix/server-app`） | **保留**，按剩余事实重测并改写 `removeWhen` / `rationale` | 11 处 / 8 文件（W2 后）→ **6 处 / 6 文件**：表定义 5（归 §1.7）+ `@server/config` 1（`orchestration-instance.ts`，17.3-1）；测试侧 30 处 / 23 文件 → **16 处 / 15 文件**。原 `removeWhen` 把 `@server/config` 记为「W4 消除」不成立 |
| `no-circular` / `@fenix/resource-machine → @fenix/agent-config` | **新增**（W4b-1） | 同族 36 处环的代表边随本次删边移位，环与根因均未变，按台账纪律必须登记（与 §16.4 的 20 → 19 同源现象） |

### 17.5 验证证据

| 验证 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run check:dependencies` | ✓ 2396 modules / 44 条登记 / **16 条命中** / 0 条新增违规 |
| `bun run architecture:check` | ✓ 2244 files / 11 rules / 28 条已登记例外 |
| `env -u ANTHROPIC_MODEL bun run precheck` | **除既有红项外全绿**：format / import-sort / module-registry / architecture / tsc(server,web,app skeletons) / dependency-boundaries / lint / package-tests / web-app-tests 通过；`server-and-script-tests` 因 `db-pool-config.test.ts` 失败 |
| ├ `package-tests` | 7231 pass / 2 skip / 0 fail（589 文件；W4a 7239 / 595 → 文件数 −6 = 删 10 增 4） |
| ├ `web-app-tests` | 946 pass / 0 fail（54 文件） |
| └ `server-and-script-tests` | 906 pass / 1 fail（67 文件）。失败项见下 |
| 新增/改写用例逐文件复跑 | `mcp-resolution` 21 pass、`model-resolution` 14 pass、`memory-env` 9 pass、`assembler` 8 pass、`model-service` 4 pass、宿主 `round22` 42 pass、`orchestration-node-resolution-parity` 17 pass |
| `bun test packages/agent-runtime/` | 800 pass / 0 fail（98 文件） |
| 冻结区 | 10 个文件在 `3ed23a59c..HEAD` 合并 diff 为空 |
| 提交规模 | `9c9685aa2` 24 文件 +344/−562；`afe16d3c3` 38 文件 +1159/−3369 |

**既有红项（非本片引入，未修复）**：`apps/server/src/__tests__/db-pool-config.test.ts` 报 `SyntaxError: Export named 'attachDatabasePoolErrorLogger' not found in module 'apps/server/src/db/index.ts'`。成因是宿主测试基建 `setup-mocks.ts:256-280` 的 `createDbMock` 只定义 `db` / `client` / `initDb` 三个导出，而该文件与 `db/index.ts:44` 同出自 `9f189d747`；属独立的基建缺口，修复方式是给 `createDbMock` 补该导出。**无关性取证**（不是自述）：把本片改动的 5 个 `apps/server/src` 文件临时还原为 HEAD 版本后单文件复跑，得到逐字相同的 `0 pass / 1 fail / 1 error`，随后已还原（逐文件 sha256 校验一致）；另在 HEAD（`9c9685aa2`）的独立 worktree 中复现同一失败。**该红项使本片不能宣称 `precheck` 全绿**，只宣称「除该既有失败外全绿」。§13.4 曾记录它在 W3b 期间不再出现——按本轮实测，它的红/绿取决于同进程测试文件组合，故该记录不作为本片免责任依据。

### 17.6 遗留项

| 项 | 归属 |
| --- | --- |
| `createDbMock` 缺 `attachDatabasePoolErrorLogger` 导出（17.5 既有红项）——**阻断 `precheck` 全绿** | 测试基建独立缺口（登记自 §10.5，本轮复现）；阶段最终提交前必须修复 |
| `apps/server/src/services/pre-launch-ports.ts` 无测试覆盖（`ownerUserId → userId` 翻译、`resolveSecretReference` 注入） | 遗留项，按 CLAUDE.md 只记录；补测需宿主侧能挂载 4 个资源模块注册表 |
| W6「测试 seam 移出公开面 / 泄漏面收口」：`server.ts` 仍标 `泄漏·` 9 处、`测试取用·` 与 `set*Deps` 一类 seam | W6 |
| `@server/config` 的 1 处（17.3-1）与表定义 5 处（§1.7） | `apps-boundary` 条的两条消除路径 |

## 十八、W6 设计（测试 seam 与泄漏面收口，2026-09-21）

本节是 W6 编码前的设计记录，四项裁定由用户 2026-09-21 弹窗确认（18.3）。**W6 的目标**：把 `server.ts` 上两类非契约导出（`泄漏·` 9 行 / `测试取用·` 7 行）与 `runtime.ts` 的派生契约收口，使 `@fenix/agent-runtime` 的公开面只剩「宿主注入 port + 路由/协议/错误映射 + 运行态类型」。**边界**：状态机、幂等、lease、限流、disconnect fencing、dispose、重连（第十节冻结区）一行不动；§14.6 第三条「端口替身复位挂 `resetAllStubs()`」的口径不变。

### 18.1 两片切分

| 片 | 范围 | 新增契约 | 台账影响 |
| --- | --- | --- | --- |
| **W6a 机械收敛** | 删零消费方符号与死 seam；`server.ts` 三行 `export *` 收窄为显式名单；包内用例改相对导入；跨包生产消费方改走**已有**窄面；两份 `extractJsonRpc` 副本收口；relay 的泄漏透出删除；§6.2 两处边界用例补强；tsconfig 冗余别名收敛 | 无 | 削 `no-cross-package-src:packages/chat-channel` 全部 3 条（见 18.2-2） |
| **W6b 新契约** | 扩 `/runtime` 只读观测面并让 observer / workflow 改调 port；跨包测试专用入口（能走 port 替身的走 port）；`runtime.ts` 11 处派生返回类型 + 2 处参数派生显式化（含 `LightweightSession` 的契约名） | 观测面方法、测试入口子路径、若干契约类型 | 无（本片不动台账） |

### 18.2 勘察实测（四处与既有记载的偏差）

1. **台账条目 `no-cross-package-src:packages/chat-channel`（owner `1.4`）的 `removeWhen` 被证伪。** 原文写「agent-runtime 全部改从 `@fenix/chat-channel/server` 导入」，但实测该 rule 下 agent-runtime 的 18 处违规里，`chat-channel-bootstrap.ts:12,20`、`acp-idle-monitor.ts:8`、`session-state-service.test.ts:9` 等**本来就是 `/server` 导入**，仍被计入。改 import 无法消除此条。
2. **命中起因是 tsconfig 别名解析，不是「直读 src 实现」。** 该 rule 同时要求 `to.path` 落在 `packages/<pkg>/src/` **且** `dependencyTypes` 含 `local`；实测全仓 `no-cross-package-src` 命中**只针对 chat-channel 一个包**（21 处 = agent-runtime 18 + model-management 2 + web-runtime 1），因为这 21 条边都经 `tsconfig.base.json` 的 4 条 `@fenix/chat-channel*` `paths` 解析（标记 `aliased-tsconfig-paths` + `local`），而其余 `@fenix/*` 子路径导入走 `package.json` 的 `exports` 解析、标记 `undetermined`，因此不命中。`moduleResolution: "bundler"` 说明 tsc 本就认 `exports`，这 4 条别名与其余 88 个 `@fenix/*` 导入口径不一致。裁定见 18.3-4。
3. **清单与文件不符两处**（18.4 顺带修正，均非范围扩张）：① `bindAcpInstanceActivityPort` 语义是「宿主注入 port」，定义在 `acp-ws-handler.ts:33`，却随 `泄漏·` 行透出——应归位到 `宿主注入·`；② §14.4 记「`environment-core` 拆成两行」，实际 `server.ts:106-111` 仍是**一行**且整块标 `宿主注入·`，`sanitizeResponse` / `KEBAB_CASE_RE` / `validateWorkspacePath` 三名各有真实消费方（宿主路由响应脱敏、宿主用例动态 import），本片按现状保留并据实改写标注。
4. **`测试取用·` 是 7 行不是 8 行**；`machine` 包已零导入本包（§13.5 遗留项表里的 machine 项已过期）。§6.2 两处边界测试缺口属实：`isOverWsLimit`（`routes/acp/index.ts:184/344/416` 三个调用点）全仓零覆盖，守卫函数本身只在 machine 的 `file-ws-payload.test.ts` 测透；「不回退本地」仍只用 503 契约间接证明。

### 18.3 四项裁定（2026-09-21 用户弹窗确认）

| # | 裁定 | 落点 |
| --- | --- | --- |
| 1 | **拆 W6a / W6b**（同 W3、W4 先例），两片各自可验证 | 18.1 |
| 2 | **跨包测试用例：能走 port 替身就走 port**，确实要驱动包内处理函数（observer 的 `handleAcpWsOpen` / `handleExternalRelayOpen`、workflow 的 `createPromptTurn`）的走 W6b 新增的测试专用入口 | W6b |
| 3 | **observer / workflow 的跨包生产取数：扩 `/runtime` 只读观测面**，消费方改调 port（与 W3b「消费方一律改调 port」同口径） | W6b |
| 4 | **chat-channel 台账条目：删冗余 paths 别名**——删掉 `tsconfig.base.json` 里 chat-channel 的 4 条 `paths`，与其余 `@fenix/*` 导入同口径走 `exports` 解析；21 处违规归零 → 台账 3 条（owner `1.4` / `未排期` / `1.6`）失效删除。**副作用显式记账**：该 rule 在本仓此后近乎休眠，它本应拦的「深路径直读」由 `check-dependency-boundaries.ts` 第 1 条职责（解析失败即硬失败）兜住；§1.6 名下的 `web-runtime → chat-channel` 条目随之消失，须在 §1.6 计划里注明「该条已由 1.4 W6a 随别名收敛删除，`structured-to-thread.ts` 的搬迁仍按 §1.6 执行」 | W6a |

### 18.4 W6a 交付清单

| # | 内容 | 判据 |
| --- | --- | --- |
| 1 | 删**零消费方符号 30 名** + **零消费 seam 7 个** | 全仓（含动态 import）无导入者 |
| 2 | `server.ts` 三行 `export *`（`acp-ws-handler` / `external-relay` / `event-bus`）收窄为显式名单 | 与 `./server/repositories`、`./server/transport/relay` 的既有口径一致 |
| 3 | 包内用例 **11 处**改相对导入（含 §13.5 点名的 `setApiInstanceDeps` 2 处） | 包内已有 6 处相对导入范本 |
| 4 | 跨包生产消费方 **5 处**改走已有面：observer / workflow / agent-config 的 `environmentRepo` → `@fenix/agent-runtime/server/environment`（`apps/server/src/plugins/auth.ts:8` 已是同做法） | 不新增任何契约 |
| 5 | 宿主侧 4 个符号（`resolveWorkspacePath` / `findMachineConnectionById` / `triggerMachineCleanupByMachineId` / `getAgentNodeService`）与 event bus 改走已有 `bind*Port` | 4 个 port 已在 `main.ts` 绑定 |
| 6 | 删 relay 泄漏透出（`server.ts:92-96`、`relay-handler.ts:9`、`relay/index.ts:4`），包内用例改从 `@fenix/chat-channel` 直取 | 全仓唯一消费方是包内 `extract-acp-event.test.ts` |
| 7 | 两份 `extractJsonRpc` 副本收口（workflow `agent-chat-transport.ts:39`、agent-runtime `services/openai-response-mapper.ts:35`），workflow `package.json` 补 `@fenix/chat-channel` 依赖 | 验收第 4 条「全仓仅 `packages/chat-channel/src/protocol/acp-channel.ts` 一处实现」 |
| 8 | §6.2 两处边界用例补强 | 见 18.2-4 |
| 9 | 删 `tsconfig.base.json` 的 4 条 `@fenix/chat-channel*` paths；删台账 3 条 | 裁定 4；须实测 tsc / bun / vite 三套解析器与门禁 |
| 10 | `bindAcpInstanceActivityPort` 归位 `宿主注入·` 行；§14.4 记的 `environment-core` 行据实改写标注 | 18.2-3 |

### 18.5 W6b 交付清单

| # | 内容 |
| --- | --- |
| 1 | `/runtime` 新增只读观测面（observer 的 ACP 连接快照 / external relay 快照 / chat channel 客户端表；workflow 的 `EventBus` 与 `environmentRepo` 取数），消费方改调 port |
| 2 | 跨包测试专用入口：能走 `stubAgentRuntimePort` 的走 port；其余（observer 的 relay/ACP 帧处理驱动、workflow 的 `createPromptTurn`、宿主用例的编排 seam）走新增子路径入口 |
| 3 | `runtime.ts` 11 处 `Awaited<ReturnType<...>>` + 2 处 `Parameters<...>` 显式化；`getSession` 的 `LightweightSession` 定名（不沿用内部「Lightweight」语义）；`listEnvironments` 的匿名 join 投影补显式契约类型 |
| 4 | 台账复核：`owner: "1.4"` 剩余 4 条（5 条 `no-circular` 归 machine 侧反向边、1 条 `apps-boundary` 归 §1.7/§1.5，均非 W6 对象）按事实复核并登记 |

### 18.6 验收与证据

W6a / W6b 各自独立验证；两片合并后由 W7 统一跑 `precheck` / `build:web` / `docs:build` / 台账核对。**`createDbMock` 缺 `attachDatabasePoolErrorLogger` 导出**这条既有红项（§17.6）在 W6 期间若仍阻断 `precheck` 全绿，按既有口径只报告证据、不夹带修复，留待 W7 阶段收口前处理。

## 十九、W6a 交付记录（测试 seam 与泄漏面机械收敛，2026-09-21）

### 19.1 交付清单（对账 §18.4）

| # | §18.4 内容 | 落地结果 |
| --- | --- | --- |
| 1 | 删零消费方符号 30 名 + 零消费 seam 7 个 | **实测 40 名**（判据与四类分解见 19.2-1）。逐名复核「导入者 + 裸提及 + 注释 + 命名空间属性」四类命中后才删；`server.ts` 公开面 **238 → 196 名** |
| 2 | 三行 `export *` 收窄为显式名单 | 三行已收窄；因删除零消费名，实际收窄 **19 行**（31 行 `export *` → 12 行，见 19.2-2） |
| 3 | 包内用例 11 处改相对导入 | 12 文件（含删除 `acp-machine-register.test.ts` 的 9 条纯存在性守卫）+ 本片新增用例 1 处 |
| 4 | 跨包生产消费方 5 处改走已有面 | 实测 **3 处**：observer `observer-service.ts`（动态 import）、agent-config `meta-agent.ts`、workflow `agent-chat-transport.ts` 的 `environmentRepo`/`EnvironmentRecord` → `@fenix/agent-runtime/server/environment`；其余跨包取数是 §18.5-1 观测面对象 |
| 5 | 宿主侧 4 个符号与 event bus 改走已有 `bind*Port` | **措辞不成立，改为据实标注**（见 19.2-3）：这些符号正是那些 port 的实现来源，全部保留并标 `宿主取用·` |
| 6 | 删 relay 泄漏透出（三处）+ 用例改从 chat-channel 取 | 已完成：`extractAcpEvent` / `extractJsonRpc` 从公开面消失，`extract-acp-event.test.ts`（8 例）改指 `@fenix/chat-channel` |
| 7 | 两份 `extractJsonRpc` 副本收口 + workflow 依赖 | 已完成：唯一实现在 `chat-channel/src/protocol/acp-channel.ts`（形参放宽为 `unknown`，消掉调用点 cast）；workflow `package.json` 与 `bun.lock` 同步加 `@fenix/chat-channel`；`fenix.module.ts` 三类边 → 四类边 |
| 8 | §6.2 两处边界用例补强 | 已完成：machine 侧「file-ws 未连接时写/上传被拒且本地 workspace 无新文件」含自证判别力；agent-runtime 侧新增 `acp-routes-ws-message-limit.test.ts`（5 例，走 `FileWsPort` 替身，覆盖三条 10MB 通道 + object 帧） |
| 9 | 删 tsconfig 4 条 chat-channel paths + 台账 3 条 | 已完成：`tsconfig.base.json` / `tsconfig.json` 各删 4 条并留原因注释；台账见 19.4 |
| 10 | `bindAcpInstanceActivityPort` 归位；`environment-core` 行据实改写 | 已完成；多角色模块改用 `｜` 复合标注（见 19.3-2） |

### 19.2 四处计数/措辞偏离（按判据实测，非范围扩张）

1. **第 1 项：30 名 + 7 seam → 40 名。** 判据是「全仓（含动态 import）无导入者」，逐名复核后删除 40 名，分四类：① 33 名零消费符号（19 个契约/协议类型 + 7 个 `OpenAIChat*` 子 schema + `OpenAgentSessionInput` + `ORCHESTRATION_MESSAGE_MAP` + 5 个 seam：`agentInstanceRuntimeCoordinator` / `getAgentMachineCache` / `resetAgentConfigLookupPort` / `resetLocalNodeAgentNodeServicePort` / `resetRedisConnectionPortForTest`）；② 3 名零命中但存在同名或注释提及（`AgentInstanceRuntimeOperations` / `ORCHESTRATION_STATUS_MAP` / `SessionEvent`，核实后均为定义文件自用）；③ 2 名仅被包内 `index.ts` 再出口（`EnvironmentCreateParams` / `closeInstanceRelay`）；④ 2 名在片内用例改相对导入后转为零消费（`FileWsPort` / `resetFileWsPort`）。**独立复核**：用脚本重新枚举新公开面（196 名）并对全仓做「命中文件数 ≤ 2」扫描，确认无残留零消费名（`InstanceSchemaActivityInfo` / `InstanceSchemaInfo` 为别名，消费点即宿主 schema barrel）。
2. **第 2 项：三行 → 19 行。** 删除某个名字必须先把它所在的 `export *` 显式化，故除 §18.4 点名的 `acp-ws-handler` / `external-relay` / `event-bus` 三行外，另有 16 行因含被删名一并收窄（`errors/orchestration-http`、`schemas/environment.schema`、`schemas/openai-chat.schema`、`agent-config-lookup-port`、`agent-instance-service`、`agent-launch-spec-port`、`api-instance`、`core-runtime-port`、`file-ws-port`、`local-node-agent-node-service-port`、`machine-registry-port`、`redis-connection-port`、`session-event-bus-port`、`orchestration-instance`、`agent-chat-service`、`agent-node-bridge`）。剩余 12 行 `export *` 无零消费名，保持原样。
3. **第 5 项措辞不成立（本片唯一的口径修正）。** 原文写「宿主侧 4 个符号与 event bus 改走已有 `bind*Port`」，但 `apps/server/src/main.ts:280-323` 正是**用这些符号给别的包绑定 port**（`bindMachineHostPort({ resolveWorkspacePath, findMachineConnectionById, triggerMachineCleanupByMachineId, … })`、`bindLocalNodeAgentNodeServicePort({ getAgentNodeService })`、`bindSessionEventBusPort({ getAllBuses: getAllEventBuses, removeBus: removeEventBus })`），它们是 port 的**实现来源**而非消费方，没有「改走」的余地。落地方式：全部保留，新增与 `测试取用·` 对称的 `宿主取用·` 标注（语义写进 `server.ts` 文件头），并在行内按名归属。`workspace-resolver-runtime-export.test.ts` 的旧注释（「Machine 只能经 runtime 的公开 server 边界」）同时订正为「消费方是宿主组合根」。
4. **第 4 项：5 处 → 3 处**（见 19.1 表格）。

### 19.3 非显然取舍

1. **契约类型随判据一并删除。** 40 名里有 12 个是 port / 路由契约类型（`MachineRegistryPort`、`RedisConnectionPort`、`SessionEventBusPort`、`RelayLifecyclePort`、`LocalNodeAgentNodeServicePort`、`RemoteNodeTransportSlot`、`AgentLaunchSpecRequest`、`MinimalAgentLaunchSpecRequest`、`AgentExecutionNode`、`AgentInstanceConnectOptions/Result`、`RequestErrorLogger`）。按「零导入者」判据它们该删，但删掉后宿主仍可绑定同名 port——因为 TS 结构化类型让 `bind*Port({ … })` 的对象字面量自行推断，不需要具名。取舍：**判据优先，按需回归**（文件头已注明「将来出现需要命名它的消费方再按需回归」）。这与 §18.1「公开面只剩宿主注入 port + 路由/协议/错误映射 + 运行态类型」不冲突：删的是名字，不是 port 面。
2. **biome organizeImports 会合并同一 specifier 的同类型性语句**（只保留第一条注释）。本片原打算用「拆语句」给 `acp-ws-handler`（宿主注入 / 宿主取用 / 泄漏三类角色）和 `environment-core`（宿主注入 / 宿主取用两类）分行标注，被 `biome check --write` 合并回一条并只留了第一类标注——这会让标注说谎。改为**复合标注**（`｜` 分区 + 逐名归属），并把该约束写进 `server.ts` 文件头。`export type` 与 `export` 两族不会被合并，是唯一可拆的维度（`./server/repositories`、`./schemas/instance.schema` 的既有两段式正因如此）。
3. **`FileWsPort` / `resetFileWsPort` 的归属。** 片内新增用例原本经 barrel 取这两个名字，按裁定 2「能走 port 替身就走 port」改走相对导入后，它们在 barrel 上转为零消费，于是随判据删除（`bindFileWsPort` / `getFileWsPort` 因有宿主/包内消费保留）。
4. **`db-pool-config.test.ts` 红项：本片修复，偏离 §18.6「只报告证据、不夹带修复」。** 新增事实：§17.6 记的修法（给 `createDbMock` 补一个转发属性，约 3 行）**不足以修复**——用例断言的是 `buildDatabasePoolOptions` 的映射结果与 `attachDatabasePoolErrorLogger` 的监听行为，需要**真实实现**，而替身整体顶掉了 `../db`，从任何路径都取不到；CLAUDE.md 又禁止测试文件直接 `mock.module()`。故按最小改法：把这两个无副作用函数移进新叶子模块 `apps/server/src/db/pool-config.ts`（`db/index.ts` 改为从它导入，不再 re-export），用例改从实现方取，日志类别仍为 `db`。理由：该红项由阶段 2 的 PHY-01 迁移（`9f189d747`）引入（文件搬迁后 preload 替身未同步），属阶段 2 回归而非无关历史状态；用户红线要求 `precheck` 报错必须处理后才能宣称完成。**修完 `precheck` 全绿**（19.5）。
5. **冻结区变更仅一处，且计划已授权。** `relay-handler.ts` 的 diff 只是删掉 `export { extractAcpEvent, extractJsonRpc } from "@fenix/chat-channel";` 一行与随之失效的注释（4 增 6 删），文件内的 relay 逻辑、`import` 行、函数体一行未动——这正是 §18.4 第 6 项点名的三处之一（`server.ts:92-96`、`relay-handler.ts:9`、`relay/index.ts:4`）。其余 9 个冻结文件在本片 diff 为空。

### 19.4 台账 44 → 40（削 4 条，0 新增 0 改写）

| 删除条目 | owner | 依据 |
| --- | --- | --- |
| `no-cross-package-src:packages/chat-channel`（`@fenix/agent-runtime` ← `@fenix/chat-channel`） | `1.4` | 裁 $18.3-4：删冗余 paths 别名后该 rule 无命中 |
| 同上（`@fenix/web-runtime`）、同上（`@fenix/model-management`） | `1.6` / `未排期` | 同因；§1.6 名下该条消失须在该片计划里注明，`structured-to-thread.ts` 搬迁仍按 §1.6 执行 |
| `no-circular @fenix/agent-runtime → @fenix/resource-sandbox` | `1.4` | 门禁报 stale（已不再违规） |

**`no-circular` 的 stale 现象须记账**：删掉这条后门禁转绿，但实测**同一个环家族仍有 31 条命中**（`agent-runtime ↔ agent-config ↔ machine ↔ sandbox`，环长 11–17），覆盖来自 `agent-runtime → agent-runtime`(1.5)、`machine → machine`(1.4)、`sandbox → sandbox`(1.4)、`machine → agent-config`(1.4)。即门禁在这条上报的只是「代表边」，删它**不等于**环被消解。这与 §10.4（W5 预测删 7 条实删 3 条）、§16.4（20 → 19）同因，属既有现象而非本片引入的退化。

### 19.5 验证证据

| 验证 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run precheck` | **全绿 `All passed`（113.7s）**：format / import-sort / module-registry / architecture / tsc(server) / tsc(web) / tsc(app skeletons) / dependency-boundaries / lint / server-and-script-tests / package-tests / web-app-tests 全部 ✓ |
| ├ `server-and-script-tests` | 911 pass / 0 fail（67 文件，8.1s）——§17.5 红项消除 |
| ├ `package-tests` | 7228 pass / 2 skip / 0 fail（589 文件） |
| └ `web-app-tests` | 946 pass / 0 fail（54 文件） |
| `env -u ANTHROPIC_MODEL bun run check:dependencies` | ✓ 2397 modules / 12 条已登记例外命中 / 0 条新增违规 / 0 条 stale |
| `env -u ANTHROPIC_MODEL bun run architecture:check` | ✓ 2245 files / 11 rules / 28 条已登记例外 |
| `bun run typecheck`（全仓 tsc --noEmit） | ✓ 0 错误 |
| `bun test packages/agent-runtime/` | 796 pass / 0 fail（98 文件） |
| 公开面机械复核 | 238 → 196 名；脚本枚举 + 全仓「命中文件 ≤ 2」扫描无残留零消费名 |
| 冻结区 | 10 文件中仅 `relay-handler.ts` 有 diff（19.3-5），其余为 0 |
| 提交规模 | 34 文件 +527 / −270（含 2 个新文件：`acp-routes-ws-message-limit.test.ts`、`apps/server/src/db/pool-config.ts`） |

### 19.6 遗留项

| 项 | 归属 |
| --- | --- |
| `SpawnedInstance` 带 `apiKey: string`（`server/services/agent-instance-runtime-projection.ts:30`）并已在公开面外透 | 安全面待裁定项，本片未动；须与用户确认后再定归属 |
| `package.json` 的 `./server/orchestration-environment`、`./web/api/environments` 两处 exports 全仓零导入者（悬空入口） | W6b 或 W7 裁量 |
| `bun.lock` 有一行与本片无关的既有漂移（`packages/resources/agent-config` 缺 `@fenix/plugin-sdk`） | 已从本片 diff 剔除；不在本任务内修 |
| `extract-acp-event.test.ts` 位于 agent-runtime 但只测 chat-channel 的实现（导出归属建议） | 只记录不建议实施（迁移会把本包测试计数搬给 chat-channel） |
| `runtime.ts` 11 处派生返回类型 + 2 处 `Parameters<…>` 显式化、`/runtime` 只读观测面、跨包测试专用入口、`owner:"1.4"` 剩余 4 条复核 | W6b（§18.5） |

## 二十、W6b 设计（新契约面与测试 seam 归位，2026-09-21）

本节是 W6b 编码前的设计记录。方向由 W6 四项裁定（§18.3-2 / §18.3-3）给定，**三处形状问题**由用户 2026-09-21 弹窗确认（20.2）。**边界**：状态机、幂等、lease、限流、disconnect fencing、dispose、重连（第十节冻结区）一行不动。

### 20.1 勘察实测（四处与 §18.5 记载不符）

1. **§18.5 第 3 项：`Parameters<…>` 是 4 处不是 2 处**。实测 `runtime.ts:147`（`Parameters<typeof createWebEnvironment>[0]`）、`:152`（`updateWebEnvironment` 第 3 参）、`:158`（`openAgentSession` 第 1 参）、`:261`（`createAgentSession` 第 1 参）。`Awaited<ReturnType<…>>` 是 11 处（与记载一致）：`:85`–`:93` 九个别名 + `:159`（`openAgentSession`）+ `:224`（`getSession`）。**三个实现没有显式返回类型**，正是要补契约类型的那三个：`createWebEnvironment`、`updateWebEnvironment`、`listEnvironmentsWithInstances`（`environment-web.ts:143 / :223 / :267`）。其余实现已有显式返回类型，只是契约面用派生写法绕开了它。
2. **§18.5 第 4 项：`owner:"1.4"` 实测 5 条不是 4 条**。原文「剩余 4 条（5 条 `no-circular` …、1 条 `apps-boundary`）」自相矛盾；实测为 4 条 `no-circular`（`machine→agent-config`、`machine→machine`、`sandbox→machine`、`sandbox→sandbox`）+ 1 条 `apps-boundary`（`@fenix/agent-runtime → @fenix/server-app`）= **5 条**。
3. **§18.5 第 1 项漏了两个 observer 的真实取数**。① `agentInstanceRepo.getById(uid)?.name`（`observer-service.ts:15,92` 的 `getInstanceName`，解析观察输出的实例展示名）；② `environmentRepo.getById(id)`（`:22,86` 的 `getEnvironment`，权威回查 env 归属）。两者与已列的三张快照表同属 observer 默认 deps 的取数面，只搬其中三项会让观察链路一半走 port、一半走 `./server`。本片一并纳入（20.3）。
4. **跨包消费方清点结果分三类，第 3 类是「取错入口」而非「需要新入口」**。① 真观测：observer 的三张表 + 两个记录回读；② 真功能依赖：workflow `workflow-events.ts:8` 的 `getEventBus` / `removeEventBus` / `EventBus` 类型（每个 workflow 一条 SSE 总线，**有创建与释放副作用**）；③ 取错入口：workflow 测试从 `./server` 取 `AgentSession` / `PromptTurn`，而生产代码从 `/runtime` 取同名符号（`agent-chat-transport.ts:12`）；task 测试从 `./server` 取 `OpenAgentSessionResult`，该类型是 `openAgentSession` 的返回类型、归属运行面。第 3 类不需要新入口，改 import 源即可。

### 20.2 三项裁定（2026-09-21 用户弹窗确认）

| # | 裁定 | 落点 |
| --- | --- | --- |
| 1 | **新增第三平面 `observe`（只读，全部无副作用）；workflow 的 session bus 归 `session` 数据面** | 20.3 |
| 2 | **chat 客户端快照用 agent-runtime 自声明的窄投影类型 `ChatClientConnectionSnapshot`**，不 re-export `@fenix/chat-channel` 的 `ClientConnection` | 20.3 |
| 3 | **复用既有 `./server/testing` 作为跨包测试专用入口**，不新开子路径 | 20.4 |

裁定 1 的理由：§18.5 原文把 workflow 的 `EventBus` 归入「只读观测面」，但 `getEventBus` 会建总线、`removeEventBus` 会释放总线，放进去会让平面命名说谎；而事件总线本就是会话级数据面原语，与 `session` 的 `connectRelay` / `createPromptTurn` 同层。裁定后两个平面的文档注释都成立。

### 20.3 W6b-1 / W6b-2：`/runtime` 新平面与生产消费方改调 port

**`AgentRuntime.observe`（`AgentRuntimeObservability`，全部无副作用）**

| 方法 | 转发到 | 消费方 |
| --- | --- | --- |
| `listAcpConnections()` | `acp-ws-handler.listAcpConnections` | observer |
| `listExternalRelayConnections()` | `external-relay.listExternalRelayEntries` | observer |
| `listChatClients()` | 包内新造：`getChatChannelController().registry.forEachClientEntry` → `ChatClientConnectionSnapshot[]` | observer |
| `getInstanceName(instanceUid)` | `agentInstanceRepo.getById(uid)?.name` | observer |
| `getEnvironmentRecord(environmentId)` | `environmentRepo.getById` | observer |
| `listEnvironmentRecordsByOrganization(organizationId)` | `environmentRepo.listByOrganizationId` | workflow、meta-agent |

**`AgentRuntime.session` 增补（有副作用，故不属 observe）**：`getEventBus(sessionId)`、`removeEventBus(sessionId)` → 转发 `transport/event-bus`。

**`/runtime` 的类型面增补**：`AcpConnectionSnapshot`、`ExternalRelayConnectionSnapshot`、`ChatClientConnectionSnapshot`、`EnvironmentRecord`、`EventBus`（值类型，供 `session.getEventBus` 的返回类型）、`OpenAgentSessionResult`。

**关键取舍**：
- **`observe` 返回的是窄投影而不是包内实体**。`getInstanceName` 只回字符串而不是 `AgentInstanceRecord`：observer 的单一真实用途就是展示名（CLAUDE.md「不做推测性抽象」），回实体等于把「观测方拿到完整记录」变成契约。`listChatClients` 同理——不把 `ChatChannelController` 本体或 `ConnectionRegistry` 透出，按裁定 2 现造窄投影。
- **`ChatClientConnectionSnapshot` 的字段取 observer 实际读的那几个**。写进文件头说明它是**投影**、字段随消费面收敛；若 chat 侧字段变化，投影的收窄处会编译失败而不是静默丢字段。
- **`EnvironmentRecord` 由 `/runtime` 导出**，`./server/environment` 窄入口保留给宿主的 3 处取用（`plugins/auth.ts` 的 `getBySecret`、`routes/web/control.ts` 的 `getById`、`services/resource-module-ports.ts` 的窄查询）。**不扩大本片范围**把宿主侧也改调 port：`plugins/auth.ts` 走的是 Environment Secret 认证路径，`environmentRepo.getBySecret` 与 port 的 `getEnvironmentBySecret`（`services/environment-acp.ts`）**不是同一个实现**，改它属于认证路径变更，须单独评估，记入 20.6。

### 20.4 W6b-3：测试 seam 移入 `./server/testing`

`server.ts` 上 7 行 `测试取用·` 全部移出生产面，`./server/testing` 成为唯一的跨包测试入口。移出后按消费性质三分：

1. **改走 port 替身**（W6 裁定 2）：能经 `stubAgentRuntimePort({ … })` 覆盖的一律改走 port。已知落点：`apps/server/src/__tests__/round44-environments-routes.test.ts` 的 `agentInstanceService` monkey-patch（`resolveInstanceForOperation` → `ensureInstance`、`ensureInstanceRuntime`、`getRuntimeSnapshot`、`listInstances` → `listOwnedInstances`）；workflow 三个测试文件的 `markInstanceRelayAttached`（port 已有同名方法）。
2. **改从 `/runtime` 取**（取错入口的那一类）：`AgentSession`、`PromptTurn`、`PromptTurnStartOptions`、`OpenAgentSessionResult`、`EventBus`（类型）、`AgentInstanceRecord`、`AutomaticInstanceSelection`。
3. **移入 `./server/testing`**：驱动包内处理函数的 seam 与内部登记表——`handleAcpWsOpen` / `handleAcpWsClose` / `handleExternalRelayOpen` / `handleExternalRelayClose` / `setExternalRelayDeps`、`globalInstanceRegistry`、`setOrchestrationInstanceDeps` / `resetOrchestrationInstanceDeps` / `resetOrchestrationBootstrap`、`shouldCountInstanceActivity`、`createExecutionNodeResolver`、`createPromptTurn`、`KEBAB_CASE_RE` / `validateWorkspacePath`、`EventBus`（值）、`getAllEventBuses`（workflow-sse 测试的清理用途）。

**`host 取用·` 的地方不动**：`main.ts` 的 12 个 `bind*Port` 与 4 个 host port 实现来源（`resolveWorkspacePath` / `findMachineConnectionById` / `triggerMachineCleanupByMachineId` / `getAgentNodeService`）、`sanitizeResponse`、`getAllEventBuses` / `removeEventBus` / `getAcpEventBus`（它们正是 `bindSessionEventBusPort` 的实现来源）、路由工厂与协议 schema 族。W6a 已用 `宿主取用·` 标注（§19.2-3）。

### 20.5 分片与验证

| 片 | 范围 | 可独立验证 |
| --- | --- | --- |
| W6b-1 | `runtime.ts` 显式契约类型（§18.5 第 3 项）：11 处派生 + 4 处 `Parameters<…>` + 三个无显式返回类型的实现补契约类型；`LightweightSession` 定名（不沿用内部语义） | `bun run typecheck` + 包内 `bun test packages/agent-runtime/` |
| W6b-2 | `observe` 平面 + `session` 补 bus + `/runtime` 类型面；observer / workflow / meta-agent 生产消费方改调 port（§20.3） | 三包测试 + `check:dependencies` + `architecture:check` |
| W6b-3 | 测试 seam 移入 `./server/testing`，跨包测试按 20.4 三分改口 | 全仓 `bun run precheck` |
| W6b-4 | 台账复核（`owner:"1.4"` 5 条按事实登记）+ §二十一 交付记录 | `architecture:check` |

每片各自跑通 `precheck` 后提交；三片合并后由 W7 统一跑 `precheck` / `build:web` / `docs:build` / 台账核对。

### 20.6 遗留项（本片不动，只记录）

| 项 | 归属 |
| --- | --- |
| 宿主 `plugins/auth.ts:8` 的 `environmentRepo.getBySecret` 与 port 的 `getEnvironmentBySecret`（`services/environment-acp.ts`）**不是同一实现**，合并属认证路径变更 | 须单独评估，不在 W6b |
| `plugins/auth.ts` / `routes/web/control.ts` / `services/resource-module-ports.ts` 仍从 `./server/environment` 取环境（宿主取用面） | 若要彻底删除 `environmentRepo` 的公开导出，须先裁定上一条 |
| `packages/resources/{task,observer}/fenix.module.ts` 注释与代码不一致（task 称生产从 `./server` 取 `openAgentSession`，实为从 `/runtime` 取 `AgentRuntimePort`；observer 称值导入两个仓储，实为只 import `ModuleManifest`） | W6b-3 顺手订正注释 |

## 二十一、W6b 交付记录（新契约面与测试 seam 归位，2026-09-21）

### 21.1 交付清单（对账 §20.5）

| 片 | §20.5 内容 | 落地结果 | 提交 |
| --- | --- | --- | --- |
| W6b-1 | `runtime.ts` 显式契约类型 | 11 处 `Awaited<ReturnType<…>>` + 4 处 `Parameters<…>` 收敛为具名契约类型（`LightweightSession` 定名）；三个无显式返回类型的实现补契约类型 | `cd4d19947`（3 文件 +136 / −42） |
| W6b-2 | `observe` 平面 + `session` 补 bus + 生产消费方改调 port | 三面定型（管理面 41 / 数据面 8 / 观测面 6 方法）；observer 5 处取数、workflow 事件总线、workflow + meta-agent 的环境候选读视图全部改走 port | `384fecc68`（10 文件 +206 / −82） |
| W6b-3 | 测试 seam 移入 `./server/testing` | `测试取用·` 清零；跨包测试按 §20.4 三分改口（apps/server 5 文件 + 包 11 文件） | `abd24f9b0`（24 文件 +160 / −196） |
| W6b-4 | 台账复核 + §二十一 | 本节；`owner:"1.4"` 5 条按实测改写（21.4） | 本次提交 |

**公开面收敛实测**（同一脚本、同一口径，递归展开 `export *` 后去重）：W6a 后 196 名 → W6b-1 后 196 → W6b-2 后 196 → **W6b-3 后 103 名**。前两片只增不改装配面，收敛全部发生在 W6b-3（删 seam 行与随 `export *` 整行消失的名字）。

**冻结区**：§二 的 10 个文件在 W6b 三片合并 diff（`cd4d19947~1..abd24f9b0`）中 **diff 全部为空**。

### 21.2 据实改写与偏离（非范围扩张）

1. **§20.6「顺手订正注释」的范围从 2 个包扩到 6 个。** 实测 `mcp`（称值导入 `getEnvironmentBySecret`）、`channel`（称取 `findRunningInstanceByEnvironment` / `sendToAgentWs` / `sendToInstanceRelay`）、`workflow`（称 `index.ts:14` 导入 `stopInstance`、`workflow-events.ts:8` 导入总线）、`prod-view`（称 `createWebEnvironment` + `agentInstanceService.findOrCreateDefaultInstance`）四处与 task / observer 同因失实——六处的实际代码都是 `import { getBoundAgentRuntime } from "@fenix/agent-runtime/runtime"`。全部按实测改写并保留各自的「这条边为何不进 `dependsOn`」论证。
2. **§20.4 第 2 类的清单里，只有一部分是「取错入口」的实例。** `AgentInstanceRecord` / `AutomaticInstanceSelection` 实测全仓零导入者；`EventBus`（类型）在 workflow 侧的实际需要是 `session.getEventBus` 的返回类型，随第 1 类一并走 port。真正落进第 2 类的改口是 `AgentSession` / `PromptTurn` / `PromptTurnStartOptions` / `OpenAgentSessionResult` 四名。
3. **§20.4 第 3 类里 observer 的两个连接表读函数留在 `./server/testing` 而未走 `observe` 面。** `listAcpConnections` / `listExternalRelayEntries` 在**生产**里由 `observe` 平面承接（§20.3），但集成用例断言的是「真注册表 + 真处理函数」的配对（先 `handleAcpWsOpen` 再读表），走 port 投影会让断言语义变成「port 转发正确」，与用例意图不符。按第 3 类的判据（内部登记表）落位。
4. **round44 的「进入远程环境映射 Agent node 不可用错误」改为整体覆盖 `ensureInstance`。** port 边界上 `ensureInstance` 已把「解析实例 + 确保 runtime」合成一个动作（这是 §4.4 方案 A 的定义），覆盖 `ensureInstanceRuntime`（只被原 `ensureInstance` 内部调用）拦不到抛错点。用例内写明该合成关系，断言语义（路由错误映射 + 不泄漏）不变。

### 21.3 非显然取舍

1. **`getAllEventBuses` / `removeEventBus` 双出口。** §20.4-4 已裁定它们在**生产**面不动（它们是 `bindSessionEventBusPort` 的实现来源）；同时又从 `./server/testing` 再出口一次，让 workflow 的 SSE 用例不必从生产面取测试用途的名字。代价是同一符号两个入口，收益是「生产面只留生产名」这条判据不必为测试破例。
2. **`getBoundCoreRuntimePort` / `resetCoreRuntimePortForTest` 是 §20.4 未列举、按同一判据应移的名字。** `bindCoreRuntimePort` 与 `CoreRuntimePort` 类型留生产面（宿主注入），读句柄与测试复位移入 `./server/testing`；workflow 的 `core-runtime-stub.ts` 因此拆成两条 import。
3. **`ChatClientConnectionSnapshot` 是包内自声明的窄投影，不是 `@fenix/chat-channel` 类型的 re-export**（§20.2 裁定 2）。字段只取 observer 实读的那几个，chat 侧字段变化会在投影的收窄处编译失败，而不是静默丢字段；同时避免为了一个快照类型把 ioredis / yjs 拖进 `/runtime` 的类型图。
4. **`observe` 全部返回窄投影而非包内实体。** `getInstanceName` 回字符串而非 `AgentInstanceRecord`、`listChatClients` 回快照数组而非 `ChatChannelController` 本体——「观测方拿到的是看得到什么，不是能操作什么」（§20.3）。

### 21.4 台账复核（`owner:"1.4"` 5 条按事实登记）

复核方法：按门禁参数（`--config .dependency-cruiser.cjs apps packages`）重跑 dependency-cruiser，解析 `cycle` 数组聚类；非环条目用全仓 grep 逐名核对。

| 条目 | 上次记载 | W6b-3 后实测 | 处置 |
| --- | --- | --- | --- |
| `no-circular` `machine → agent-config` | 1 处环（环长 13） | 1 处环（环长 13） | 计数一致；`removeWhen` 据实改写（共同闭合边是 `machine → agent-config`） |
| `no-circular` `machine → machine` | 37 处环（环长 11–17） | **10 处环（环长 11–16）** | 据实改写 |
| `no-circular` `sandbox → machine` | 3 处环（环长 14） | **3 处环（环长 12–15）** | 处数一致、环长改写 |
| `no-circular` `sandbox → sandbox` | 8 处环（环长 6–16） | **7 处环（环长 12–15）** | 据实改写 |
| `apps-boundary` `agent-runtime → server-app` | 6 处导入 / 6 文件（非测试）；测试侧 16 处 / 15 文件 | 不变 | 追加复核记录，`removeWhen` 两条路径均未变化 |

**环族的结构结论（本次复核的主要发现）**：这 4 条与 `agent-config → agent-config`（1.5）、`agent-runtime → agent-runtime`（1.5）6 条指纹合起来覆盖**同一个 37 处环族**，族内总数 37 与环长范围 11–17 **与上次记载完全一致**；变化的是 dependency-cruiser 挑出的**代表边**在 6 个包对间的分布（例如 `machine → machine` 指纹下 37 → 10 处，`sandbox → sandbox` 8 → 7 处）。W6b 收窄 agent-runtime 的装配面导出后环上跨包边已同质化为固定的 4 条：`machine → agent-config`、`agent-config → agent-runtime`、`agent-runtime → sandbox`、`sandbox → machine`，每条环各含一次。这印证 §19.4 记的既有现象：**删掉某条指纹下的条目不等于环被消解**，唯一的共同闭合边是 `machine → agent-config`（4 条 `removeWhen` 已按此据实改写）。

**未纳入本片的偏差（只记录）**：台账 6 条 `no-circular` 条目共用一段尾注「实测 223 条 `circular` 边只有 161 条被上报」，该数字是更早口径，W6b-3 实测为 **79 条 `circular` 边 / 47 条上报**。本片只更新 `owner:"1.4"` 的 4 条，其余条目（含 1.5 名下 2 条）留待各自 owner 或最终收口统一改写。

### 21.5 验证证据

| 验证 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run precheck`（W6b-3 后） | **全绿 `All passed`（87.0s）**：format / import-sort / module-registry / architecture / tsc(server) / tsc(web) / tsc(app skeletons) / dependency-boundaries / lint / server-and-script-tests / package-tests / web-app-tests 全部 ✓ |
| ├ `server-and-script-tests` | 911 pass / 0 fail（67 文件） |
| ├ `package-tests` | 7228 pass / 2 skip / 0 fail（589 文件） |
| └ `web-app-tests` | 946 pass / 0 fail（54 文件） |
| `env -u ANTHROPIC_MODEL bun run check:dependencies`（W6b-4 后） | ✓ 2397 modules / 12 条已登记例外 / 0 条新增违规 / 0 条 stale |
| `env -u ANTHROPIC_MODEL bun run architecture:check`（W6b-4 后） | ✓ 2245 files / 11 rules / 28 条已登记例外 |
| `bun run typecheck` | ✓ 0 错误（W6b-1 / W6b-2 / W6b-3 各跑一次） |
| W6b-2 三包专项 | observer 83 pass / workflow 721 pass / agent-config 403 pass，0 fail |
| 冻结区 | 10 文件在 W6b 三片合并 diff 中全部为空（21.1） |
| 台账条目合法性 | 改写后 `check-dependencies` 与 `architecture:check` 均无 stale / 无未登记违规 |

### 21.6 遗留项

| 项 | 归属 |
| --- | --- |
| 宿主 `plugins/auth.ts` 的 `environmentRepo.getBySecret` 与 port 的 `getEnvironmentBySecret` **不是同一实现**，合并属认证路径变更 | 须单独评估（§20.6-1，本片未动） |
| `plugins/auth.ts` / `routes/web/control.ts` / `services/resource-module-ports.ts` 仍从 `./server/environment` 取环境（宿主取用面） | 若要删 `environmentRepo` 的公开导出须先裁定上一条 |
| `SpawnedInstance` 带 `apiKey: string` 且已在公开面外透（`server/services/agent-instance-runtime-projection.ts:30`） | 安全面待裁定项，须与用户确认后定归属（§19.6 顺延） |
| `packages/agent-runtime` 的 `./server/orchestration-environment` 导出条目全仓零导入者（悬空入口）；同批检查的 `./web/api/environments` **有 3 处 web 消费方，§19.6 的「零导入者」记载对它不成立** | W7 收口（§19.6 顺延；W6b-4 范围只含台账与本节） |
| 台账其余条目共用尾注里的 223 / 161 是更早口径，实测 79 / 47 | 各 owner 或最终收口统一（21.4 末段） |
| `extract-acp-event.test.ts` 位于 agent-runtime 但只测 chat-channel 的实现 | 只记录不建议实施（§19.6 顺延） |
| `bun.lock` 有一行与本任务无关的既有漂移（`packages/resources/agent-config` 缺 `@fenix/plugin-sdk`） | 不在本任务内修（§19.6 顺延） |

**本片收到的用户补充裁定（2026-09-21，针对任务 1.5）**：「`/api/*` 目前还没有外部使用，接口是可以调整的（如有必要）」。记此以备 §1.5 引用——该任务若需要调整 `/api/*` 的契约形状（例如宿主能力下沉或迁包时的路由归属变更），不必按对外兼容契约处理。

## 二十二、W7 收口（任务 1.4 结项，2026-09-21）

### 22.1 收口验证（§七 W7 定义的四项 + §八 全量项）

| 项 | 结果 |
| --- | --- |
| `env -u ANTHROPIC_MODEL bun run precheck` | **全绿 `All passed`（86.4s）**，12 个子项全部 ✓（server 911 / packages 7228 / web 946，0 fail） |
| `bun run build:web` | ✓ built in 1.58s（含 `apps/web/dist/` 产物，后端静态挂载依赖此项） |
| `bun run docs:build` | ✓ build complete in 10.25s |
| 台账核对 | `owner:"1.4"` 共 **5 条**（4 条 `no-circular` + 1 条 `apps-boundary`），全部经 21.4 按实测复核改写；`check:dependencies`（2397 modules / 12 条例外 / 0 新增 / 0 stale）与 `architecture:check`（2245 files / 11 rules / 28 条例外）均 ✓ |
| 本文件收尾 | §一 状态与顶部导航已更新（W6a / W6b 已交付，仅剩 W7）；本节即收尾记录 |

### 22.2 §八 五条验收的对照结论

| 验收条 | 结论 |
| --- | --- |
| 1. `agent-runtime` 单包边界不变；`core` / `orchestration` / `chat-channel` / `remote-runtime` 未合并 | ✓ 全程无新增跨包 `src` 导入（`check:dependencies` 的 12 条例外无新增） |
| 2. `src/server.ts` 收窄为 port 面；非测试代码资源包导入归零；`toActorContext` 归零 | ✓ `/runtime` 三面定型（41 / 8 / 6），`server.ts` 展开后公开面 196 → 103 名；W4b 已删 `agent-runtime-not-to-resources` 相关命中与 `toActorContext` |
| 3. machine / sandbox 相关台账全删；`machine/package.json` 无 `@fenix/agent-runtime` 与 `@fenix/resource-sandbox` | ⚠ **部分达成**（§10.4 已记录）：W5 实测删 3 条，剩余 4 条仍是真实违规——machine 侧仍存在指向 agent-runtime / agent-config 的反向边（21.4 的四包环族），`machine/package.json` 相应声明仍在。本任务未消除该族，`removeWhen` 已按实测改写 |
| 4. 三条链路共用同一 relay/ACP 规则；`extractJsonRpc` 全仓一处实现 | ✓ W6a 已收口（唯一实现在 `chat-channel/src/protocol/acp-channel.ts`），W6b 未回退 |
| 5. 8 个边界项测试齐备 + 2 处补强 | ✓ W6a 补齐（`acp-routes-ws-message-limit.test.ts` 等），W6b 的改口未削弱断言面（21.2-4 记录了唯一一处语义等价改写） |
| 冻结区（第二节红线） | ✓ 10 个文件在 **W6b 三片**合并 diff 中全部为空；全周期仅 `relay-handler.ts` 有一处计划内删行（§19.3-5） |

### 22.3 结项状态与未结项

**结项**：1.4 的接口收窄与依赖方向目标已交付——`agent-runtime` 有显式的三面运行契约、跨包消费方（observer / workflow / agent-config / task / channel / mcp / prod-view）一律经 `/runtime` 取数、测试 seam 收进 `./server/testing` 唯一入口、装配面只留宿主注入与协议交付。

**未结项（已登记，不阻塞 1.4 结项）**：

| 项 | 归属 |
| --- | --- |
| `machine → agent-config` / `machine → agent-runtime` 反向边构成的 37 处环族（4 条 1.4 台账 + 2 条 1.5 台账） | machine 包的方向收敛，须在 §1.5 或 machine 包的独立任务中处理；W5 已把能独立做的 3 条做完（§10.4） |
| §1.7 表定义迁出（消除 5 处 `@server/db/schema`）与 §1.5 模块配置携带 baseUrl（消除 `orchestration-instance.ts` 的 `@server/config`） | 1.7 / 1.5；两条都完成后按剩余事实重测 `apps-boundary` 条目 |
| §21.6 的六项遗留（`getBySecret` 双实现、`SpawnedInstance.apiKey`、悬空 exports 条目、台账尾注旧口径等） | 见 21.6 表 |

**下一步**：任务 1.4 至此收口，转入任务 1.5（`apps/server` 宿主与协议聚合）。

