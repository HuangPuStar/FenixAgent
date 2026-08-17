# 17. Workflow 取消必须到达 Agent，所有出口必须共用 finalizer

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 超时后继续调用工具/消耗算力、实例租约提前释放、recover/rerun 泄漏实例 |

## 对抗判决

Workflow timeout/Abort 只 detach listener、释放 lease 并 reject，没有向 Agent 发送 cancel 或等待回执。Engine 已跟踪 spawned instance，但 recover/rerun route 没有走 run/approve 的 cleanup。一个 DAG 的逻辑终态和实际 Agent/instance 生命周期可以永久分叉。

## 已核验证据

- `src/services/workflow/agent-chat-transport.ts:97-149`：timeout/Abort 仅本地清理并 reject。
- `packages/workflow-engine/src/executor/agent-executor.ts:234-244`：finally 只释放 turn listener。
- `packages/workflow-engine/src/engine/workflow-engine.ts:609-624,748-766`：recovery context 维护 spawned IDs。
- `src/routes/web/workflow-runs.ts:537-617`：recover/rerun 返回后未调用与 run/approve 相同的 spawned cleanup。
- `src/routes/web/workflow-engine.ts:194-233`：旧 action 路径同样遗漏。
- `packages/workflow-engine/src/transport/transport.ts:48-60` 暴露 cwd，但 `agent-executor.ts:161-167` connect 未传，形成死 interface。

## 架构诊断

取消和 finalization 是 Workflow Run Module 的核心复杂度，却散落在 executor、transport、route 的 success handler 中。新增一个出口就容易漏掉 cleanup；lease release 也被误当作远端取消。

## 目标不变量

- PromptTurn 支持显式 cancel：发 cancel → 等有界 ACK/grace → 必要时按实例策略强停。
- run 在所有 success/error/timeout/cancel/recover/rerun/approve 出口进入同一个幂等 finalizer。
- finalizer 收敛 Agent turn、spawned instances、leases、temporary files、event terminal 和 storage status。
- lease 只有在远端取消所有权明确后释放；晚到事件被归入已终止 generation。
- 对 cwd 做明确产品决定：若只允许 Binding workspace 就删除 per-run cwd interface；若允许就验证并贯穿传递。

## 验收

- DAG cancel/timeout 后 Agent 不再输出或调用工具，实例与租约在预算内收敛。
- 对每个出口注入清理失败，finalizer 可重试且不会二次副作用。
- spawned instance、orphan turn、cancel ACK latency、forced stop 和 finalizer retry 可观测。
- route 删除重复 cleanup 后行为测试保持一致，体现 Module depth 增加。

## 依赖

需要 [2](./2-introduce-instance-relay-broker.md) 的 channel ownership 和 [20](./20-make-workflow-runs-idempotent-and-durable.md) 的 run operation identity。
