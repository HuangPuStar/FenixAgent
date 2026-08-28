# 12. 用请求关联表路由 ACP session，而不是从 payload 猜归属

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高 |
| 影响 | Chat 串话、错误绑定 session、prompt 终态丢失、远程并发会话覆盖 |

## 对抗判决

Chat handler 在当前 RCS 尚无 active session 时会接收任意 `session/update`；任意带 `result.sessionId` 的 response 又会绑定到当前 SharedRelay，而不验证 response ID 是否由它发起。远程 AcpDispatcher 还丢弃 prompt 里显式 sessionId，改用实例级 active session。系统现在通过“消息长得像什么”猜归属，没有以请求来源建立权威关联。

## 已核验证据

- `packages/chat-channel/src/channel/relay-event-handler.ts:110-117`：active 为空时不拦截不匹配 update。
- `packages/chat-channel/src/channel/relay-event-handler.ts:269-324`：看到 `result.sessionId` 就更新当前绑定。
- `packages/chat-channel/src/channel/gateway.ts:171-193`：同一底层 handle 上多个 RCS 各挂 handler。
- `packages/chat-channel/src/channel/session-channel.ts:107-112`：部分回执只以本地 rpcId 为 key。
- `packages/acp-link/src/acp-dispatcher.ts:218-245,273-313`：prompt 丢弃显式 sessionId，使用全局 state.sessionId。
- `packages/acp-link/src/acp-dispatcher.ts:399-486`：list/load/resume 固定 workspace/cwd。
- `packages/acp-link/src/server.ts:1230-1255`：旧本地路径反而读取 `params.sessionId`，证明两套协议语义漂移。

## 额外终态缺口

`relay-event-handler.ts:120-139` 对无 sessionId 的 JSON-RPC response 提前 return，使后续 prompt/cancel/session-list normalizer 不可达。Claude adapter 不发私有 `prompt_complete`，终态只在 prompt RPC result；因此 turn 可能永久 active/cancelling。

## 目标不变量

- 每个出站 request 在 Broker 中记录 logicalChannel、method、目标 session、deadline 和 caller request ID。
- response 只按 transport ID 查关联；payload 中的 sessionId 是被验证的数据，不是路由依据。
- 未绑定 channel 默认拒绝 session/update；订阅建立后只接收明确 session。
- prompt、cancel、session list、model/mode 等 response 先按原 request method 解析，再投影领域事件。
- 本地/远程只保留一个 canonical ACP dispatcher；所有 session 方法显式携带目标 session/cwd，删除实例级 active session 隐式状态。

## 分阶段整改

1. 构造一个真实 fan-out fake handle，同时挂 A/B，复现空 active 串话和 session/new 错绑。
2. 在 Broker 建 request correlation，先迁移 session/new 与 prompt。
3. 修复 response normalizer 顺序，补 Claude prompt 终态和 session list 测试。
4. 合并/删除重复 Dispatcher 与散落的 `extractJsonRpc` implementation。

## 验收

- B 未绑定时不接受 A 的任何 update；A 的 session/new response 不能改变 B。
- A/B 同 RPC ID、同 sessionId 字符串、乱序 response、未知 response 均有确定行为。
- 每个 turn 恰好一个终态；cancel 和 transport 断开不能留下永久 active。
- 未关联/晚到/重复 response 有匿名指标并可追踪到 channel/request。
