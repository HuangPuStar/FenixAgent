# 11. 外部与远程 relay 必须按逻辑 channel 分流

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | 同组织用户互收 Agent 内容、RPC 碰撞、remote session last-writer-wins |

## 对抗判决

external relay 只要组织匹配就可连接一个 running instance，随后把底层 handle 的每一帧发送给该 WebSocket；客户端 JSON-RPC ID 又原样进入共享连接。远程协议的 `session_id` 则是实例级可变字段，最后一个入站发送者覆盖后续所有出站 envelope，RCS 侧还忽略该字段。两条路径都没有真正的 logical channel。

## 已核验证据

- `src/transport/relay/external-relay.ts:108-139`：按组织授权连接已有 instance。
- `src/transport/relay/external-relay.ts:177-199`：底层每帧直接发给当前 external WS，无 request/session 过滤。
- `src/transport/relay/external-relay.ts:245-292`：外部 JSON-RPC ID 原样转发。
- `src/routes/acp/index.ts:317-377`：未限制单实例只能有一个 external consumer。
- `packages/acp-link/src/server.ts:548-557,630-637`：实例级 sessionId 被每个入站帧覆盖，并用于出站。
- `packages/remote-runtime/src/remote-relay-handle.ts:17-45`：按 instance 过滤但忽略 envelope session。

## 故障链

同组织用户 A/B 连接同一 instance；A 的 prompt、工具结果、session/update 同时到 B，二者还可选择相同 RPC ID。远程场景下，A/B 最后一个发送帧的人决定实例级 session_id，后续消息按时序被错误标记。

## 架构诊断

instanceId 只标识物理 Agent，不足以标识消费者、ACP session 或请求。把它当路由键，等价于把所有会话接在同一广播总线上。session_id 作为可变 metadata 也不能补救没有关联表的 byte stream。

## 目标方向

- external relay 和 remote transport 都迁到 [2](./2-introduce-instance-relay-broker.md) 的逻辑 channel。
- 协议 envelope 使用不可变 channel identity；RPC response 由 Broker 的请求表分发，事件按显式 ACP session subscription 投影。
- 如果某类外部客户端暂不支持复用，强制“一连接一独立实例”并拒绝第二消费者，不宣称共享安全。
- 只有 Broker 可以重写 transport RPC ID；外部 ID 只在该 channel 内有意义。
- 出站需要 backpressure、缓冲上限和 slow-consumer 断开策略。

## 验收

- 同一实例两个 external client + Chat + Workflow 并发，任何消息都不出现在非订阅方。
- 制造相同客户端 RPC ID、乱序 response、断线重连和 remote envelope 交错，关联仍正确。
- 指标包含每实例 channel 数、未知 channel/session、跨路由拒绝、slow consumer、pending request。

## 回滚

迁移期可按 transport 类型逐步切换；回滚策略是退回独占实例，不允许退回共享广播。
