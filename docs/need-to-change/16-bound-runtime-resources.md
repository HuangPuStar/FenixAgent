# 16. 给 Y.Doc、channel、buffer 和租户 runtime 设置租约与硬上限

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 认证用户可制造无界内存、Redis 连接、timer、pending request 和 engine cache |

## 对抗判决

任意 sessionId query 会参与生成 RCS key；解析/绑定失败只记录后继续。DocManager 的 maps 没有 TTL/LRU，断开不销毁 docs，每份 Redis doc 又创建持久化和 subscriber。200 连接上限只限制同时连接，无法限制顺序创建大量随机 session 后遗留的长期资源。

## 已核验证据

- `src/routes/acp/index.ts:259-265`：query sessionId 先进入确定性 RCS ID。
- `packages/chat-channel/src/channel/gateway.ts:116-129`：解析失败后继续。
- `packages/chat-channel/src/state/doc-manager.ts:49-58,93-153`：doc maps 无租约/TTL/LRU。
- `packages/chat-channel/src/persist/redis.ts:129-150,296-323`：每 doc 建 persistence/subscriber。
- `packages/chat-channel/src/channel/gateway.ts:390-395`：正常断开保留 docs。
- `src/services/workflow/index.ts:31,76-100`：每组织 engine runtime 缓存，只有显式 remove/clear；未见常态逐出租。
- `packages/chat-channel/src/channel/connection-registry.ts:12-16,37-45` 和 `src/transport/relay/external-relay.ts:60-66`：握手缓冲没有字节/条数上限。

## 目标不变量

- sessionId 在分配资源前验证与 environment/instance/user 的绑定。
- Doc、logical channel、pending RPC、engine runtime 和握手 buffer 都有 owner、lease、TTL、租户配额和全局硬上限。
- 空闲回收先停止新命令、flush、释放 subscriber/listener/timer，再删除 map；回收幂等。
- 容量不足返回稳定的 overload 错误，不通过 OOM 或随机丢帧实现背压。
- 配额配置进入 `src/env.ts`，拒绝负数/NaN；不再在 bootstrap 直接 `parseInt(...) || 200`。

## 验收

- 顺序创建十万随机 session 的测试不会线性留下 doc/subscriber/timer。
- 租户达到配额只影响本租户；一个慢 channel 不拖垮同实例其他 channel。
- 指标覆盖 active/idle/evicted 资源、每租户高水位、buffer bytes、pending age 和 eviction latency。
- shutdown 后资源计数归零，无悬挂 listener/interval/subscriber。

## 回滚

先采用较高保守上限并只告警，观察真实分布后启用拒绝；一旦硬上限启用，不回滚到无界，只调整经审计的预算。
