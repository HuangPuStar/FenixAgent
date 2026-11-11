# Chat 大文档分片恢复

目标：普通载荷上限为 8 MiB，超过后按最多 2 MiB（含分片头）分片，使约 13 MiB 的旧 Chat/Session Doc 能在原会话内同步完成。

采用同一已认证 WebSocket 上的二进制分片帧，不改变 ACP、命令身份或会话生命周期。普通更新继续使用现有帧；超过普通载荷上限的 update/replace 按文档、generation、传输 ID、偏移与总长度分片。WebSocket 保序与现有 64 KiB 背压控制逐片投递；完成证明排在最后一片之后，不以入队代替交付。

接收端收齐后才应用完整 Yjs update，不把普通字节片段交给 Yjs。每连接累计在途载荷不超过 64 MiB，传输最长 30 秒；断线、注销与换代清理分片。原始正文不进入诊断日志。仍超出累计预算时保留明确失败，不无界分配内存。

本次不改变历史分页、工具详情建模或发送门禁，不重放用户消息；不新增数据库字段或依赖。前后端需一同发布，回滚同时撤销分片协议与消费端。

## 实施与验证

- [x] 在 `packages/chat-channel/src/channel/fragment-recovery.test.ts` 用真实 Y.Doc 和真实客户端验证大于 8 MiB 与约 13 MiB 的快照恢复、2 MiB 分片尺寸与完整应用后完成；相邻测试覆盖背压及多连接隔离。
- [x] 扩展 `protocol/update-frame.ts`，增加有界分片帧；在 `transport/update-fragments.ts` 管理浏览器重组，在 `channel/fragment-delivery.ts` 管理服务端分片发送与释放。
- [x] 将快照、差量、广播、replace 与慢消费者追赶统一接入；`gateway-sync.ts` 等待分片真实发送完成，`gateway.ts` 在关闭时取消发送。
- [x] 补齐截断、乱序、超预算、断线、超时、换代、持续流式更新与网关包装对象身份回归；更新旧的“超过单片即失败”测试为累计预算边界。
- [x] 同步 `docs/arch/19-yjs-chat-streaming.md`，针对性测试、`bun run fastcheck`、`bun run build:web` 和 `bun run precheck` 均通过，改动审查完成。
