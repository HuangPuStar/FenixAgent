# 13. Y.Doc 未完成持久化恢复前不得对外 ready

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 冷启动空快照、旧消息复活、错误 session 恢复、关停丢数据 |

## 对抗判决

RedisProvider 异步加载 snapshot，但 factory 立即返回空 Y.Doc；Gateway 随即发送快照、读取 activeSessionId 并设置 relayReady。进程重启后，客户端可能先看到空文档、执行 clear/create 等命令，随后旧 snapshot 才 apply，造成被清除内容复活和会话绑定错误。

## 已核验证据

- `packages/chat-channel/src/types.ts:90-94`：RedisProvider 只有 destroy，没有 ready/flush 契约。
- `packages/chat-channel/src/state/factory.ts:43-89`：创建后立即返回 doc。
- `packages/chat-channel/src/persist/redis.ts:266-283,339-344`：snapshot 在后台加载。
- `packages/chat-channel/src/state/doc-manager.ts:93-135`：openChat/openSession 不等待恢复。
- `packages/chat-channel/src/channel/gateway.ts:293-316`：立即发送两份快照并设置 relayReady。
- `packages/chat-channel/src/persist/redis.ts:171-213,359-365`：CAS 写入异步，destroy 不等待 in-flight persist。
- `src/index.ts:261-276`：graceful shutdown 未 flush/close Chat doc store。

## 架构诊断

DocManager 的 `open()` interface 把“对象已分配”误表达为“状态可用”。ready、generation、flush 与 close implementation 不可观察，所有调用者只能乐观假设。Chat Doc 与 Session Doc 又分别恢复，缺少同一会话 epoch。

## 目标不变量

- `open` 只有在初始 snapshot/update 应用完成后才成功；失败显式返回，不降级空文档。
- Chat+Session 两份 doc 使用同一 logical session generation/epoch，不能一新一旧。
- ready 前不接受命令、不发送初始快照、不连接 relay。
- clear/create/load 与异步恢复互斥；旧 generation update 不能写入新状态。
- shutdown 顺序包含停止接入、停止投影、flush batch、等待 CAS、关闭 subscriber/provider。

## 分阶段整改

1. 用可控延迟 Redis provider 写冷启动竞态测试。
2. 深化 DocStore interface，增加 ready/generation/flushAndClose 语义。
3. Gateway 改为显式 boot state machine：loading → synced → relay-ready → draining。
4. 删除“恢复失败仍发送 load_session”及 fire-and-forget shutdown 路径。

## 验收与观测

- snapshot 延迟到达期间客户端收不到空权威状态，也不能执行命令。
- clear 后旧 snapshot/update 永不复活；两份 doc epoch 始终一致。
- SIGTERM 在预算内完成 flush；超时会留下明确 dirty-shutdown 指标并拒绝宣称安全退出。
- 观测包含 load latency/failure、generation mismatch、persist queue、CAS conflict、drain latency。

## 回滚

可先仅对冷启动连接启用 ready barrier；回滚时宁可返回 503/稍后重试，不可恢复“先发空状态”。
