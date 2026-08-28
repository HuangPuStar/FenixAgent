# 15. commandId 幂等生命周期不能绑定 WebSocket 引用计数

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | prompt/create/clear 等副作用在重连后重复执行，串行保证失效 |

## 对抗判决

CommandCoordinator 的 dedup/queue 只在内存；一个 RCS session 最后连接断开就 dispose。若命令已经转发，客户端收到 accepted 但 committed ACK 丢失，断线会删除幂等记录；同 commandId 重试成为第二次全新命令。旧 queue 甚至可能仍在后台执行，新 queue 同时启动。

## 已核验证据

- `packages/chat-channel/src/channel/command-coordinator.ts:57-114`：dedup、结果和串行队列只在进程内。
- `packages/chat-channel/src/channel/gateway.ts:390-409`：注释称 Agent/Y.Doc 在重连期间保留，却在最后连接断开时 dispose RCS session coordinator。
- 现有 ADR 把 commandId process Map 和单实例部署列为过渡假设，尚无跨重连 durable ownership。

## 架构诊断

客户端连接、逻辑 Chat session、ACP session 和命令执行是四个生命周期。当前 coordinator 属于最短的 WebSocket 生命周期，却承担最长的副作用幂等，Module ownership 错位。

## 目标不变量

- commandId identity 至少绑定租户、RCS/ACP session、命令类型和有效载荷 hash。
- accepted、in-flight、committed/failed outcome 在定义的 lease/TTL 内跨 WebSocket 重连和进程重启可恢复。
- 同 ID 不同 payload 拒绝；同 ID 同 payload 返回原 outcome，不再次执行。
- dispose 先取消/收敛 in-flight，再释放 queue；不会留下旧新 coordinator 并行。
- 幂等记录保存最小结果，不持久化完整 prompt/敏感内容。

## 分阶段整改

1. 建立 ACK 丢失 + 断线 + 同 commandId 重试的对抗测试。
2. 先把 coordinator 生命周期绑定 logical session lease，不随最后 tab 立即销毁。
3. 为高副作用命令持久化 TTL outcome；再处理跨实例 ownership/leaseEpoch。
4. 删除 Gateway 内按 connection refCount 清理幂等状态的隐式规则。

## 验收与观测

- 任意 ACK 丢失、重连、服务重启组合下，命令最多执行一次并可查询终态。
- 同 ID 篡改 payload 被拒且可审计。
- 指标包含 dedup hit/conflict、in-flight age、orphan recovery、lease takeover 和存储失败。

## 边界说明

“Exactly once”只对平台接受的命令与其本地副作用成立；外部工具本身仍需 idempotency key 或 [21](./21-make-cross-system-writes-recoverable.md) 的补偿语义。
