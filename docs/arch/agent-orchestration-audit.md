# Agent 编排审计验收索引

本索引对应 `FenixAgent-Agent-Orchestration-Audit-6784795 (1).md` 的全部 16 项问题。报告基线为 `6784795`，修复基于 `f99dcf9`；不修改数据库结构或持久实例选择协议。

## 权威边界

1. 生命周期由 `AgentInstanceRuntimeCoordinator` 仲裁。操作编号与运行代次分别表示意图和实体；启动补偿、死亡、自动回收、机器 clean-slate 均回到该边界。
2. Core 拥有物理 relay，调用方只拥有消费租约。持久 Instance、ACP session、turn 和执行额度的释放条件各自独立。
3. Chat 命令保留原始连接身份；prompt 的客户端目标必须与共享的已确认会话绑定一致，不能在排队后自动改投。持久投影不能证明 Agent 已加载会话。
4. 输入在第一次暂存前按数量与字节准入。scheduled 限额按执行计数，实例复用不会复用任务额度。

详细契约见 [编排管理](20-orchestration-management.md)、[Chat 同步](19-yjs-chat-streaming.md)、[Turn 生命周期](agent-turn-lifecycle.md) 与 [执行准入](agent-execution-admission.md)。

## 问题与回归映射

测试路径相对各 owner 包的 `src/`。

| 编号 | 修复行为 | 主要回归测试 |
|---|---|---|
| ORCH-01 | 同时校验组织、用户、持久实例归属；拒绝发生在底层建连前 | agent-runtime `__tests__/external-relay.test.ts` |
| ORCH-02 | stop/delete 等旧启动与补偿完成；每个异步启动边界检查取消和运行身份 | agent-runtime `__tests__/orchestration-start-cancellation.test.ts`、`server/__tests__/agent-instance-lifecycle-audit.test.ts` |
| ORCH-03 | 停止失败释放删除门禁；数据库删除失败仅恢复同一次操作 | agent-runtime `server/__tests__/agent-instance-lifecycle-audit.test.ts` |
| ORCH-04 | 死亡、空闲和孤儿清理同步 Coordinator；手动停止意图独立保留 | agent-runtime `__tests__/local-instance-death-cleanup.test.ts`、`__tests__/acp-idle-monitor.test.ts`、`server/__tests__/agent-instance-lifecycle-audit.test.ts` |
| ORCH-05 | 首次建连 single-flight；消费方释放自身监听；实例停止回收物理连接和迟到句柄 | core `__tests__/relay-ownership-fencing.test.ts`；agent-runtime `__tests__/agent-turn-cancellation.test.ts` |
| ORCH-06 | 刷新提交前核对对象、运行代次、epoch 和 running 状态 | core `__tests__/relay-ownership-fencing.test.ts` |
| ORCH-07 | 队列条目固定发起者，切换换代后拒绝过期 prompt | chat-channel `__tests__/orchestration-command-regressions.test.ts` |
| ORCH-08 | load/resume 成功回执后才提交绑定；发送失败、超时和迟到回复不能伪造成功 | chat-channel `__tests__/orchestration-command-regressions.test.ts`、`__tests__/session-channel-binding.test.ts` |
| ORCH-09 | dispose 取消等待并排空旧执行器；断线保留有界去重和明确的不确定结果 | chat-channel `__tests__/orchestration-command-regressions.test.ts` |
| ORCH-10 | 断连按实际运行代次关联，clean-slate 可在在途操作结束后收敛 unknown | agent-runtime `server/__tests__/agent-instance-machine-recovery.test.ts`、`server/__tests__/agent-instance-lifecycle-audit.test.ts` |
| ORCH-11 | Workflow 取消贯穿连接、握手、prompt 与迭代；同一 ACP session 排他准入，未确认终止前保留所有权 | workflow `__tests__/agent-chat-transport-cancellation.test.ts`；agent-runtime `__tests__/agent-session-admission.test.ts` |
| ORCH-12 | 原始/包装消息共用严格终态分类；失败、取消、断连、未知终态和无确认 EOF 不成功 | task `__tests__/agent-executor.test.ts` |
| ORCH-13 | deadline 可唤醒静默 next；SSE 失败不补成功终态且只释放自身消费资源 | agent-runtime `__tests__/agent-turn-cancellation.test.ts`、`__tests__/round18-openai-response-protocol-boundaries.test.ts` |
| ORCH-14 | 缺监听、超时、错误和缺 ID 回执均拒绝；不生成随机 ACP session ID | agent-runtime `__tests__/agent-turn-cancellation.test.ts` |
| ORCH-15 | 握手前、gateway、命令及去重缓存均有数量/字节上限；取消有独立保留容量 | agent-runtime `__tests__/inbound-message-queue.test.ts`、`__tests__/external-relay.test.ts`；chat-channel `__tests__/orchestration-command-regressions.test.ts` |
| ORCH-16 | scheduled 执行同步准入；API/Workflow 共享实例按活跃执行保护回收，取消等待者不遗失晚到实例的回收资格 | agent-runtime `__tests__/agent-execution-admission.test.ts`、`__tests__/instance-concurrency.test.ts`、`__tests__/acp-idle-monitor.test.ts`、`server/__tests__/agent-instance-background-start.test.ts` |

## PR #326 跨模块补充审计

`FenixAgent-PR326-P0-P1-Static-Audit.md` 以 `620d10e` 为基线，补充了六项 P1。以下回归覆盖此前局部测试未贯通的调用边界。

| 编号 | 修复行为 | 主要回归测试 |
|---|---|---|
| PR326-01 | 执行前比较客户端目标与已确认会话；外层队列延迟和其他标签页切换均不能改投旧输入；被拒草稿保留并由用户确认当前目标 | agent-runtime `__tests__/acp-yjs-recovery.test.ts`、`web/__tests__/create-session-receipt.test.tsx`；chat-channel `__tests__/prompt-target-contract.test.ts` |
| PR326-02 | 认证后启动有界入站队列，使 state-vector 可在 open 握手中处理；同连接同代的迟到差量补齐后显式完成同步，实时广播不能解除历史门禁 | agent-runtime `__tests__/acp-yjs-recovery.test.ts`；chat-channel `channel/gateway-sync.test.ts` |
| PR326-03 | 物理 relay 持有持续递增的请求命名空间；消费租约隔离响应与会话通知，释放后迟到结果不能命中新消费方的本地 ID | core `__tests__/relay-rpc-isolation.test.ts`；agent-runtime `__tests__/relay-reconnect-turn-boundary.test.ts` |
| PR326-04 | Workflow 自动回收使用公共 reclaim 接口并校验运行代次、租约和执行准入；不写入手动停止意图，同一持久实例可再次运行 | workflow `__tests__/workflow-primary-reclaim.test.ts` |
| PR326-05 | PromptTurn 使用独立 ID 请求真实 cancel；Dispatcher 支持通知与请求并调用 SDK，重复取消只投递一次，取消确认不充当 prompt 终态 | agent-runtime `__tests__/prompt-turn-dispatcher-boundary.test.ts` |
| PR326-06 | 历史与活动准入解耦；回收前轮换命令 epoch，旧 ID 不重放，在途仍受保护；取消在活动准入与队列均有预留容量 | chat-channel `channel/command-dedup-retention.test.ts` |

## CodeRabbit 审查回归

| 审查项 | 行为与主要回归 |
|---|---|
| 活动硬超时与执行准入 | 超期 scheduled 可确认停止并释放配额；交互、等待启动、换代和停止失败均受保护：agent-runtime `__tests__/scheduled-activity-timeout.test.ts` |
| 已提交记录独立过期 | 每条完成记录最多保留 10 分钟，其他命令不续期；容量回收前轮换 epoch：chat-channel `channel/command-dedup-retention.test.ts` |
| 重试退避取消分类 | 退避中保持 NODE_TIMEOUT / DAG_CANCELLED 与节点标识：workflow-engine `__tests__/executor/agent-retry-cancellation.test.ts` |
| 放弃未知结果草稿 | 显式放弃释放命令身份；再次手动输入使用新 ID：agent-runtime `web/__tests__/create-session-receipt.test.tsx` |
| 未知记录有界保留 | 退场记录进入独立有界历史，回收前轮换 epoch；仍在执行的记录受保护，历史不占活动准入：chat-channel `channel/command-dedup-retention.test.ts` |
| 重连会话订阅 | 从服务端可信会话绑定恢复通知订阅，无需伪造请求：agent-runtime `__tests__/gateway-restored-relay-session.test.ts`；core `__tests__/relay-rpc-isolation.test.ts` |

## 第二轮复审

`FenixAgent-PR326-8e920131-Reaudit.md` 的两个 P1 分别补齐 UI 恢复结算和命令历史回收契约。

| 编号 | 修复行为 | 主要回归测试 |
|---|---|---|
| PR326-R2-01 | 同连接失败后可由完整同代证明恢复发送和草稿重发；慢重试、普通更新、错误/缺失 generation、换代拼接和旧连接均验证 | agent-runtime `web/__tests__/chat-panel-history-recovery.test.tsx` |
| PR326-R2-02 | 退场历史不占活动频道配额；epoch 在历史回收前失效，跨频道 churn、历史容量、过期、长执行与旧 ID 重连均不重放；验证中的重复请求保留身份 | chat-channel `channel/command-dedup-retention.test.ts`、`channel/command-active-retirement.test.ts`、`channel/command-client-ingress.test.ts`；agent-runtime `web/__tests__/create-session-receipt.test.tsx` |

## 验证与运行边界

专项回归使用可控异步边界，覆盖并发、迟到回复、断连、取消、隔离与失败恢复。统一门禁为 `bun run fastcheck`、`bun run precheck`、`bun run build:web` 和 `bun run docs:build`；最终执行结果记录在修复 PR。

这些测试不构成真实远程机器、Peri 或生产数据库的端到端运行证明。上线后可从 Coordinator 的运行代次/操作状态、入站队列快照及明确错误码定位问题。回滚以整体修复提交为单位，不需要数据库补偿；不得只回滚租约或执行额度的一侧调用契约。
