# 14. YJS 初始同步和增量广播不能静默丢帧

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | Session Doc 缺失、客户端与服务端永久分叉、错误 ready |

## 对抗判决

Broadcaster 在 `bufferedAmount` 超过 64KB 时直接 return。Gateway 先发送 Chat snapshot，再发送 Session snapshot，随后无条件 `relayReady=true`。大 Chat 快照使缓冲越过阈值时，第二份快照被静默丢弃；相同顺序重连可能稳定重现。

## 已核验证据

- `packages/chat-channel/src/channel/broadcaster.ts:24-37`：超过阈值不排队、不报错、不关闭，直接丢弃。
- `packages/chat-channel/src/channel/gateway.ts:293-316`：两份 snapshot 顺序发送后无 ACK 即 ready。
- `packages/chat-channel/src/channel/broadcaster.ts:113-134`：按 RCS session 广播本身正确，问题在发送失败语义。

## 架构诊断

`send()` 的 interface 看似成功但实际可能无动作，是典型假成功。初始状态同步、增量事件和非关键通知共享同一“尽力而为”实现，调用者无法根据重要性选择重试、断线重同步或丢弃。

## 目标不变量

- 初始同步使用 state vector/diff 或有序 chunk，并要求每份 doc/generation 的 ACK。
- Chat 与 Session snapshot 都确认前不能 relayReady。
- 关键增量永不静默丢弃；无法在预算内发送时关闭连接，让客户端执行确定性重同步。
- 每连接队列有字节/条数/时间上限；慢消费者不能拖累同会话其他连接。
- 重连从已确认 state vector 恢复，而不是重复发送不可确认的大快照。

## 分阶段整改

1. 构造 >64KB Chat Doc 测试，证明当前 Session snapshot 丢失。
2. 让发送返回明确 outcome；先对关键帧采用 close-and-resync。
3. 实现分块/ACK/state-vector，完成前保留保守断线策略。
4. 为 external relay 等其他 WS 发送面复用同一背压词汇，但保持各协议独立队列。

## 验收

- 1MB 文档、慢客户端、网络暂停、ACK 丢失和重连最终都与服务端 hash 一致。
- 不存在“ready 但只收到一份 doc”的状态。
- 指标包含队列高水位、关键帧拒绝、resync 次数/字节、慢消费者断开和同步时延。

## 非目标

简单提高 64KB 阈值只会推迟失败并增加内存风险；目标是让 delivery semantics 可观察、可恢复。
