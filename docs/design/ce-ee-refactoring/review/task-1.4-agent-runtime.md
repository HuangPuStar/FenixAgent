# 任务 1.4 执行计划与设计裁定：Agent Runtime、Machine 与 Sandbox

本文是阶段 2 任务 1.4 的执行计划与设计裁定记录。设计裁定已全部落定（见第九节），**W5 已交付**（第十节），**W1 已交付**（第十一节）；W2 → W3（W4 同批）→ W6 未开工。

任务目标见[阶段 2 执行计划 §1.4](../ce-ee-refactoring-stage-2-plan.md)，权威约束见[目标架构与开发规范 §2.3](../ce-ee-engineering-standards.md)（依赖矩阵）与 [§10.4](../ce-ee-engineering-standards.md)（Runtime 与基础资源验收）。

## 一、任务状态：W5、W1 已交付（2026-09-20），其余切片未开工

| 证据 | 结论 |
| --- | --- |
| `docs/design/ce-ee-refactoring/review/` 只有 `task-1.2-*`、`task-1.3-*` | 无 1.4 实施记录 |
| git 历史无任何以 1.4 为目标的提交 | 未开工 |
| `packages/agent-runtime/fenix.module.ts` 注释：「当前返回的是 Runtime 服务端公开入口的整体表面，而不是收敛后的启动/停止/状态/回收 port」 | 第 2 条自述未完成（W3 范围） |
| `scripts/architecture/exceptions.json` 中 `owner: "1.4"` 共 **14 → 11** 条（W5 削 3 条） | 剩余 11 条随 W2–W4、W6 处理 |
| 台账总数 **51 → 49**（W1 削 2 条 `owner: "1.5"` 的 `no-circular`，见 11.3） | 包对指纹随边消失而失效，非 1.4 条目减少 |

**已交付**：W5「Machine/Sandbox 方向」——第十节；W1「依赖类型与配置 seam」——第十一节。**未开工**：W2 → W3（W4 与 W3 同批）→ W6。

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
| **W2 宿主接缝收敛** | `@server/db` + `@server/db/schema` 换 owner 侧入口（含表归属裁定）；`@server/plugins/auth` 认证上下文裁定；`cache` / `openai-response-mapper` / `transport` / `config-utils` / `org-context` / `repositories` 收口；消除 `routes/acp/index.ts` 对 `@server/routes/web/environments` 的反向依赖 | 22 个非测试文件中的宿主路径依赖归零 | 删 `apps-boundary`（`@fenix/agent-runtime → @fenix/server-app`） |
| **W3 Runtime port 定型** | 落 `src/runtime.ts`；收窄 `src/server.ts`；替换 `fenix.module.ts` 工厂；消费方按 port 改调 | 9 个包/应用、31 个文件的调用面收敛 | 无 |
| **W4 启动前取数搬出** | 新建 `AgentInstanceStarter` port；`launch-spec-builder`(663) 与 `actor-context.ts`(42) 从 agent-runtime 删除；`skill` / `mcp` / `model-management` 补包根公开 Domain Service（6 张表的读取）；`agent-config` 补「组织范围读」系统入口（9.1）；agent-config Facade 组装已授权 `AgentLaunchSpec` 并调 port；两条 spec 路径按 9.2 收敛为一条 | 消除 `agent-runtime-not-to-resources` 的服务端命中 | 删 `agent-runtime-not-to-resources` 5 条（knowledge / agent-config / memory / skill / model-management；与 §1.7 同批核对 `@/src/lib/model-config-utils` 别名） |
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
