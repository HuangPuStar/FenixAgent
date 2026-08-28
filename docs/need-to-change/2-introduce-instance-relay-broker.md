# 2. 让实例级 Relay Broker 独占物理连接所有权

| 属性 | 结论 |
| --- | --- |
| 优先级 | P0 |
| 置信度 | 高，缓存、fan-out 与 close 链均已闭合 |
| 影响 | 跨会话消息、RPC 冲突、误关其他消费者、Agent 被误杀 |

## 对抗判决

Core 对同一个 instance 返回同一个原始 relay handle；Chat 为不同 RCS session 建立自己的 listener 和从 0 开始的 RPC ID，Workflow 与 external relay 也直接使用该 handle。任何一方都可以发送、订阅和关闭底层连接。系统声称复用的是“实例”，实际共享的是没有逻辑隔离的字节流。

## 已核验证据

- `packages/core/src/runtime/instance-orchestrator.ts:214-242`：已有 open relay 时原样返回同一对象。
- `src/transport/agent-relay.ts:20-27`：调用方直接获得原始 handle。
- `packages/plugin-opencode/src/relay/relay-handle.ts:98-108`：每条入站消息 fan-out 给全部 listener。
- `packages/chat-channel/src/channel/connection-registry.ts:182-235`：按 RCS session 建逻辑 SharedRelay，但底层 handle 仍相同。
- `packages/chat-channel/src/channel/gateway.ts:174-193`：每个逻辑 relay 独立从 `nextRpcId=0` 计数。
- `packages/chat-channel/src/channel/gateway.ts:397-429`：一个 RCS session 最后连接断开会关闭底层 handle。
- `packages/acp-link/src/server.ts:1265-1275`：本地 relay WS 断开会 kill Agent 子进程。

反例：同一 instance 打开 Chat A、Chat B 和 Workflow。A/B 都发 RPC 1，所有 listener 都收到 response；A 最后一个标签页关闭后，B 与 Workflow 一起断开，本地 Agent 还可能被杀死。

## 架构诊断

物理 transport 与逻辑 channel 是两个不同生命周期，却被同一个浅 interface 表达。当前 seam 放在调用方：每个消费者自行生成 ID、筛消息、绑定 session、处理 timeout 和决定 close。高 fan-out、低 locality、相互矛盾的所有权正是该设计的直接结果。

## 目标方向

建立实例级 Relay Broker，成为唯一可以：

- 打开/关闭物理 relay；
- 分配实例内全局唯一 RPC ID 并维护 response 关联；
- 创建/释放逻辑 channel；
- 按 channel/session 订阅事件并实施背压；
- 在 transport 断开时统一失败 pending 请求、重连或终止实例。

Chat、Workflow、OpenAI、external relay 只能持有逻辑 channel，不能获得原始 handle 或调用物理 `close()`。Broker 的价值由删除测试衡量：删除各调用方的 ID Map、listener 过滤和 close 条件后，功能仍应成立。

## 分阶段整改

1. 用 fan-out fake handle 写失败测试：A/B RPC ID 碰撞、A close、并发 session/update。
2. Broker 先包住一个 transport，实现请求关联和引用计数；保持业务协议不变。
3. 依次迁移 Chat、Workflow、external relay、OpenAI；每迁移一方就删除其本地关联表。
4. 收紧类型和 package export，禁止业务模块 import 原始 `EngineRelayHandle`。

## 验收与观测

- 同实例至少两个 Chat + 一个 Workflow 并发，消息和 response 只到发起 channel。
- 释放 A 不影响 B；只有 instance lifecycle 能关闭物理连接。
- RPC ID 冲突、未知 response、孤儿 listener、pending timeout 和 channel 泄漏都有指标。
- Broker 重启/重连时所有 pending 请求得到明确终态，不靠上层 30 秒后猜测失败。

## 依赖与非目标

- [12](./12-correlate-acp-sessions-and-rpc.md) 在此 seam 上实现会话语义；[11](./11-demultiplex-external-and-remote-relay.md) 迁移外部协议。
- 不建议先在每个 handler 增加更多 `if sessionId`；那会继续复制分流 implementation。
