# P1：IM 冷启动 turn 未登记执行租约，实例在回复前被空闲回收

**状态**：已修复，待 CI 与合并验证。
**优先级**：P1。
**类型**：错误。
**创建日期**：2026-11-04。
**来源**：GitLab issue `aos-test/aos-e2e-test#72`（VER 复测报告）。
**确认方式**：explorer 只读确认 + 主 agent 复核（基线 `b331ffc77`）。

## 确认证据

- 现象：LangBot 全部适配器（`http_bot` 注入与 `wecombot-omni` 真实入站）收到消息后，平台创建会话与 `im-<conversationId>` 实例；实例 `running`、`relay_count=0`、`session_id=null`，约 30–93 秒后变 `stopped`，无回复、无出站回调，通道仍为 `connected`。
- 入站入口：`packages/resources/channel/src/server/routes/hooks/langbot.ts:40-57` → `inbound-service.ts:399` 落库后异步投递（`:408-421`）。
- 冷启动：`im-session-bridge.ts:131-153` → `apps/server/src/services/channel-im-session-port.ts:154-198`（`openSession`）→ `:99-120`（`openTurn`）→ `runtime().session.startPromptTurn`（`packages/agent-runtime/src/services/agent-prompt-turn.ts:233-333`）。
- 实例来源：`findOrCreateNamedApiInstance` 创建 `creation_source=api`（`packages/agent-runtime/src/server/services/agent-instance-named.ts:21-29`）；启动时 `creationSource !== "workflow"` 被映射为 `spawnSource=interactive`，随后 `markAgentExecutionIdleReclaimable`（`agent-instance-service.ts:79`、`:87-88`），因此该实例可被自动回收。
- 回收判定只承认两类事实：活跃执行租约与 registry 的 relay/activity 计数（`agent-instance-runtime-projection.ts:202-207`、`:222-223`；`acp-idle-monitor.ts:238-262`）。IM 的进程内 relay 不经过 `InstanceRegistry`，turn 也没有 `acquireAgentExecution`；`relay_count` 只在外部 relay 与前端 chat 通道增减。
- 主服务日志（issue 证据）：`spawn requested` → `→ agent relay` → 83s 后 `[ACP-IDLE] Stopping idle instance … idle=83s timeout=30s` → `relay_close`；同时间段无 IM/通道错误。
- 对照：HTTP/OpenAI（`agent-chat-service.ts:76`）、Workflow、Scheduler、前端 Chat 均有执行租约或 relay 计数保护，只有 IM 冷启动端口没有。

## 根因链

1. 触发：IM 入站消息触发冷启动，`openSession` 建立进程内 relay 并完成 `session/new`，`sendWakePrompt` 发出一次唤醒 prompt。
2. 机制：该 turn 没有 `acquireAgentExecution`，也不增加 `relayCount`，registry 里 `lastActivityAt` 停在实例启动时刻；`canAutomaticallyReclaimInstance` 因无活跃执行返回 true。
3. 空闲巡检在 `idle >= RCS_ACP_IDLE_TIMEOUT_SECONDS`（默认 30s）且 `relay_count=0` 时停止 runtime（`acp-idle-monitor.ts:253-262`）。
4. 用户可见后果：turn 在途时 Agent 进程被停止，回复无法经 `im_reply` 发出；平台未消费 Agent 输出流，因此也没有失败信号，通道保持 `connected`。

观察：根因链 1-3 由代码与主服务日志确认；「turn 是否已产出回复」无法从主服务证据确认，但不影响回收判定本身是错误行为。

## 影响面

- 用户影响：全部 LangBot IM 通道的冷启动（首条消息、订阅断开后的 `wake()`、实例重启后首条消息）都可能在回复前被回收。
- 受影响模块/调用点：`apps/server/src/services/channel-im-session-port.ts`；共享实现 `packages/resources/channel/src/server/services/langbot/im-session-bridge.ts`。
- 不受影响：HTTP `/api` 单轮、Workflow、Scheduler、前端 Chat（均有执行租约或 `relayCount`）。
- 观测缺陷（非根因）：实例活动接口的 `session_id` 恒为 `null`（`agent-instance-runtime-projection.ts:142`），冷启动成功无日志。

## 修复方案

- 范围：
  1. `channel-im-session-port.ts` 在 `openSession` 取得 `acquireAgentExecution({ userId: target.ownerUserId, source: "interactive" })`，`attach` 到实例并 `confirmRuntime`；把 `onExecutionFinished: () => execution.release()` 传入 `startPromptTurn`。
  2. 释放路径必须闭合：`openSession` 任意失败立即释放；`sendWakePrompt` 同步抛错释放；`close` 在未发 prompt 时释放；turn terminal 经 `onExecutionFinished` 释放。
  3. 在 `@fenix/agent-runtime/server/testing` 暴露 `hasActiveAgentExecutions`（测试观测用），补端口回归测试。
  4. relay 建连加 30s 上限：超时关闭迟到 resolve 的 relay，并由 `openSession` 失败路径释放租约，避免建连悬挂时租约无限期阻止回收；超时按失败路径上抛，不触发 `session/new` 回退、不覆盖旧 `acp_session_id`。握手超时同样按失败路径上抛，不回退覆盖旧会话。
- 明确不做：不改实例回收算法、不新增 IM 专属 TTL、不把 IM relay 计入 `relayCount`、不消费 Agent 输出流。
- 回归测试：`apps/server/src/__tests__/channel-im-session-port.test.ts` 新增「冷启动持有租约」「terminal 释放」「未发 prompt 关闭释放」「openSession 失败释放」。

## 验收标准

1. IM 冷启动 turn 在途时，实例同时不满足 idle 与 activity 回收条件；turn 结束后恢复可回收。
2. 释放路径：`openSession` 失败、`sendWakePrompt` 同步失败、未发 prompt 的 `close`、turn terminal 均释放执行租约；prompt 已发出后 relay 直接断开且无 terminal RPC 的路径保留租约直到 runtime 停止（与 HTTP 路径既有语义一致），不属于本次释放范围。
3. `bun test apps/server/src/__tests__/channel-im-session-port.test.ts` 与 `bun run fastcheck` 通过。

## 验证记录

- `bun test apps/server/src/__tests__/channel-im-session-port.test.ts packages/agent-runtime/src/__tests__/agent-turn-cancellation.test.ts` → 24 pass / 0 fail（90 expect）。
- `bun run precheck` → 全绿（248s）：web-app 432 pass / 0 fail，server 1084 pass / 2 skip / 0 fail，package 11606 pass / 108 skip / 0 fail。
- `git diff --check` → 无输出。
