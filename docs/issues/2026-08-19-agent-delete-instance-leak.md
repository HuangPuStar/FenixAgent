# Agent 删除后运行实例未清理：删除 agent/environment 只删 DB，不停止编排实例

## 时间

2026-08-19

## 现象

删除一个 agent（`agent_config`）后，它背后正在运行的 instance 未被清理。删除只移除了 DB 记录，运行态的 Agent 进程与编排实例仍然存活，并发额度未释放。属资源泄漏缺陷，可能持续占用用户/环境并发配额，导致后续 spawn 被 429 拒绝。

## 影响面

删除 agent 或绑定 environment 后残留的运行实例：

- **Agent 进程泄漏**：`getCoreRuntime()` 快照中实例仍 `running`，进程不退出。
- **编排域活跃表残留**：`controller.#instances` 仍持有条目，环境 `maxConcurrency` 额度被永久占用（`maxConcurrency=1` 时该环境/agent 永远无法再 spawn）。
- **节点 workload 未释放**：`AgentNodeService.#refCounts` 计数不归还，节点空闲回收（agent-node-service.ts:160-166）永不触发。
- **registry supplement / byEnvironment 并发计数残留**：`globalInstanceRegistry` 的 supplement、`envCounters`、`byEnvironment` 索引不清空，`getActiveAgentCount` / `getActiveUserAgentCount`（agent-concurrency.ts）仍把泄漏实例计入并发额度，其他用户 spawn 被 429 拒绝。
- **Y.Doc 内存不回收**：`stopInstanceViaController` 末尾的 `reclaimYjsDocs` 不执行。

兜底机制不覆盖：idle monitor 对 `spawnSource === "interactive"` 直接 `continue`（acp-idle-monitor.ts:198），**永不回收**；scheduled/system 要等 idle/activity 硬超时（且 environment 已删，回收无业务意义）。

## 根因清单

| ID | 位置 | 问题 |
|----|------|------|
| R1 | `src/services/config/agent-config.ts:215-230`（`deleteAgentConfig`） | 事务内只 `delete(environment)` + `delete(agentConfig)`，纯 DB，无任何停止实例逻辑 |
| R2 | `src/services/environment-core.ts:108-110`（`deleteEnvironment`）| 只 `environmentRepo.delete(envId)`，纯 DB，不停止实例 |
| R3 | `src/repositories/environment.ts:197-200`（`environmentRepo.delete`）| 纯 `db.delete`，确认纯 DB 删除 |
| R4 | 删除入口调用方 | `api/agents.ts:399`、`web/config/agents.ts:436`、`web/environments.ts:275`、`environment-acp.ts:166,246` —— 均无附加停止逻辑；无其他绕过入口的直接删除路径 |

正确停止实例的唯一权威出口为 `stopInstanceViaController`（`src/services/orchestration-instance.ts:202-236`），幂等组合：controller.stopInstance（释放 env 额度 + 节点 refCount）→ core facade.stopInstance（杀进程）→ globalInstanceRegistry.unregister + deleteCounter（释放并发计数）→ reclaimYjsDocs。删除路径完全没有调用它。

## 修复计划（Plan）

### 落点

新增共享 helper，放在 `src/services/orchestration-instance.ts`（实例生命周期唯一归宿，紧邻 `stopInstanceViaController`）：

```
stopInstancesForEnvironments(environmentIds: string[], opts?: { organizationId?: string })
```

实现要点：

1. 用 `globalInstanceRegistry.getByEnvironment(envId)` 收集每个 env 的 instanceId（primary）；并 union `getCoreRuntime().listInstances()`（补 supplement 丢失的边际）+ `getOrchestrationController().listInstances()`（补 controller 幽灵）按 `environmentId` 过滤。
2. 若 `opts.organizationId` 提供，仅停止 `supplement.organizationId` 匹配的实例（保留现有 stopInstance 的多租户隔离语义，instances-delete-idempotent 有 403 用例保护）。
3. 对每个 instanceId `await stopInstanceViaController(id)`，用 `Promise.allSettled`，单个失败只记日志，不中断整体、不向上抛。
4. 只对 `spawnSource !== undefined` 的真实注册实例操作；幂等（stopInstanceViaController 自带）。

### 接入点（三处调用方统一复用）

- `deleteAgentConfig`（agent-config.ts）：事务前先查出绑定 envIds，调 helper，再走原事务删除 DB。stop 成功后 service 返回前即完成资源释放。
- `deleteEnvironment`（environment-core.ts:108）：调 helper 传 `[envId]`，再 `environmentRepo.delete`。这样 web DELETE 与 ACP（environment-acp:166、246）全部自动继承——**两处 ACP 路径不必单独改**。
- 无需改 `environment-acp.ts`。

### 顺序 / 事务 / 失败边界

- **先查 envIds → 并行 stop（allSettled，失败不中断）→ DB 删行**。`stopInstanceViaController` 不读 DB，stop 放事务外避免把慢速 kill 关进 DB 长事务；且"先停后删"即使 DB 删除失败也只是实例已停、DB 行仍在（可重新 spawn 恢复），比"先删后停、stop 失败 → 对已删 env 的实例彻底孤儿"更安全。
- **单个实例 stop 失败不中断删除**：`Promise.allSettled` + 逐条 `logError`（复用 orchestration-instance.ts:207-218 幂等吞错风格）。删除始终返回原 `boolean`。
- **并发**：同一 agent/env 的多个实例并行 stop；helper 幂等，重复删除 / 并发删除安全。
- **失败重试兜底**：即使 stop 全部失败，删除仍成功（DB 允许删除），但实例由 idle monitor 对 scheduled/system 兜底；interactive 泄漏仍存在——因此建议在 helper 记录聚合失败日志（含 envIds、instanceIds、失败原因），可观测。

### 变更文件清单

- `src/services/orchestration-instance.ts`：新增 `stopInstancesForEnvironments` + deps seam（复用 `_deps` / `setOrchestrationInstanceDeps`）。
- `src/services/config/agent-config.ts`：`deleteAgentConfig` 接入 helper。
- `src/services/environment-core.ts`：`deleteEnvironment` 接入 helper。
- （可选加固）`environment-acp.ts`、web/api 路由无需改动。

## 测试计划

复用 `instances-delete-idempotent.test.ts` / `local-instance-death-cleanup.test.ts` / `workflow-cleanup.test.ts` 的 fake 注入模式（stubCoreBootstrap + setOrchestrationInstanceDeps + 真实 registry + stubDb）。

新增用例：

1. **agent-config-delete-stops-instances.test.ts**（核心场景）
   - 删除 agent 时：预先注册 2 个 running instance（绑定该 agent 的 env），断言 `stopInstanceViaController`（fake controller + fake facade）对两个实例都被调用、`controller.listInstances` 清空、`globalInstanceRegistry.getByEnvironment` 清空。
   - 单实例 stop 失败（fake controller 对某 id 抛错）不中断删除：DB 删除仍发生、其他实例仍被 stop、函数仍返回 true。
   - 无运行实例时删除照常成功（回归原行为）。
   - 跨组织实例不被误停（传 org、用另一 org supplement）。
2. **environment-delete-stops-instances.test.ts**
   - `deleteEnvironment` 停止该 env 的 running 实例后再删 DB。
   - 通过 web DELETE /environments/:id 路由（`handle(Request)` + setTestAuth）端到端验证 stop 发生且 200。
3. **更新 agent-config-delete.test.ts**：原用例 stub 需补注入 core-bootstrap/controller fake，否则 `deleteAgentConfig` 调 helper 时 `getCoreRuntime()` 未 stub 会抛 TypeError（同 workflow-cleanup.test.ts:59 的教训）。

## 验收标准

- [ ] 删除任一 agent 后，其绑定 environment 下的全部 running 实例：core 快照消失、controller 活跃表清空、registry supplement/byEnvironment/counter 清空、环境与代理并发额度立即释放（spawn 不再 429）。
- [ ] 删除单个 environment（web DELETE 与 ACP 路径）同样停止其运行实例。
- [ ] 单个实例 stop 失败不阻断删除，DB 行仍删除，返回语义不变。
- [ ] 无需等待 idle/activity 超时即回收 interactive / scheduled / system 实例。
- [ ] 新增用例覆盖「agent 删除 → 实例被 stop」核心场景，既有 agent-config-delete 用例随注入 seam 更新后仍绿。
- [ ] 既有 `instance-concurrency` / `instances-delete-idempotent` / `workflow-cleanup` / `local-instance-death-cleanup` / `orchestration-instance-*` / `api-instance*` 全部通过（无回归）。
- [ ] `bun run precheck` 全绿。

## 回滚与可观测

- **回滚**：还原 agent-config.ts / environment-core.ts 中 helper 调用即可；helper 本身增量为纯新增导出，回滚零副作用（幂等停止已有停止逻辑即 no-op）。
- **可观测**：helper 与 stopInstanceViaController 均已有结构化日志（`[orchestration-instance]`、`[Instance]`）；建议在 helper 记录聚合行：`[agent-delete][cleanup] envs=X instances=Y stopped=Z failed=W`。可结合 `ACP-IDLE` 的 `openedDocCount` 与 `getActiveAgentCount` 观察删除后额度/进程是否回落。

## 后续审计发现：机器断连 / Sandbox 销毁 registry 残留（2026-08-19）

### 现象与影响

远程 machine 断连或 Sandbox provider resource 销毁时，
`unregisterRemoteNode(machineId)` 会删除 Core runtime 实例，并通过
`cleanupOrchestrationInstancesForMachine` 清理 AgentController 活跃表、节点引用和
Y.Doc；但没有同步清理 `globalInstanceRegistry` 的 supplement、`byEnvironment`
索引与空 environment 的 `envCounters`。因此 core/controller 已不再有实例时，
`getActiveAgentCount` / `getActiveUserAgentCount` 仍可能统计残留 supplement，造成
并发额度泄漏、后续 spawn 429。

### 调用链

- machine WS 断连 / sweep：`unregisterRemoteNode(machineId)`。
- Sandbox 销毁：`SandboxManager.destroyProviderResource` →
  `unregisterRemoteNode(machineId)`。
- machine 快速重连：`registerRemoteNode` 的 existing-node 分支同样直接删除旧 core
  instance，存在相同的 registry/counter 清理缺口。

### 修复决策

在 `core-bootstrap` 的 machine 实例删除循环中，按 `instanceId` 定向执行：

1. 删除 core runtime instance；
2. `globalInstanceRegistry.unregisterAndDeleteCounter(instanceId)`：原子注销 supplement /
   `byEnvironment`，并仅在该 environment 已无 instance 时删除计数器。

不用全局 `reconcile()`：machine 断连仅应影响该 machine 的实例；全局对账可能在其他
machine 短暂状态不一致时清理无关实例。此路径与既有 controller/Y.Doc machine cleanup
共同组成完整卸载，不改变其他资源删除或 environment 改绑行为。

### 验收标准

- [x] machine 断连、快速重连及 Sandbox 销毁后：该 machine 的 core instance、controller
  活跃表、registry supplement/byEnvironment 与空 environment counter 均被清理。
- [x] 其他 machine 的 registry 条目不受影响（按已删除的本机 instanceId 定向回收）。
- [x] 机器清理幂等，缺少 supplement 时不抛错。
- [x] registry 原子回收与既有机器清理回归测试通过；`bun run precheck` 的格式、
  import-sort、server/web typecheck、lint 均绿，但全量测试稳定失败于与本次改动无关的
  `packages/opensandbox-cluster/src/__tests__/routes.test.ts`，该文件单独运行通过。

## 实施状态

Agent / environment 删除修复已提交（`01b8837c`）。机器断连 / Sandbox 销毁 registry
残留修复已完成，待与其他工作区并行改动隔离后提交。
