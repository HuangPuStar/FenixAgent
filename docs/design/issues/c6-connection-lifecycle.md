# C6 · 连接生命周期与断链语义

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q13）
> 性质：连接层切片（语义原样迁移，不重写时序）

## What to build

把 `src/transport/relay/yjs-frontend/` 的连接层逻辑迁入 `packages/chat-channel` 的 `channel/` 目录，**语义原样迁移、结构重组**：YJS sync 握手时序、断线重连、64 KB 背压、`YJS_MAX_CLIENTS` 200 连接配额、rpcId 管理等硬约束（CLAUDE.md 不变量）一律保留，不重写时序；与文档 10 节的差异记为二期优化项。

### 实现内容

1. **结构重组**（按职责拆入 `channel/`）：
   - `gateway`：WebSocket 连接接入（认证、连接限流、心跳）、YJS sync 握手时序、连接配额（200，`YJS_MAX_CLIENTS`）——来自 `ws-lifecycle.ts`；
   - `broadcaster`（或保留 `yjs-broadcaster` 语义）：同 `rcsSessionId` 客户端 fan-out、64 KB 背压阈值、慢消费者处理——来自 `yjs-broadcaster.ts`；
   - `connection-registry` 语义迁入 gateway 或独立保留：按 `rcsSessionId` 分组的连接注册表、引用计数（同一 `instanceId + userId` 多标签页共享 relay handle，引用计数归零才释放）。
2. **两类断链语义**（文档 8.2）：
   - 前端 WebSocket / relay 断开：仅释放连接级资源；Agent 会话存活时重连后同步当前实时 Y.Doc（从 `chatMeta` 语义恢复 `entry.acpSessionId`，同一 ACP session 的 `load_session` 跳过 Agent 全量回放——在新 schema 下对应字段承载）；
   - Instance ACP session 断链或实例回收：删除该 `rcsSessionId` 的 Chat Doc、Session Doc、relay handle、广播订阅与热缓存；新实例创建全新实时投影，**绝不加载已删除的旧 Y.Doc**。
3. **可见性恢复**：页面隐藏导致的超时链接不在后台自动重连，回到可见时触发一次连接。
4. **广播隔离**：广播按 `rcsSessionId` 隔离，禁止全局广播会话数据；WebSocket open 时在 `relayReady = true` 前发送 Chat Doc 与 Session Doc 初始快照（新 schema 下对应实现，时序不变）。
5. **测试迁移**：既有 `yjs-frontend-lifecycle` / `broadcaster` / `connection-registry` 测试迁入包内，更新以匹配新 schema；新增断链语义测试（两类断链、慢消费者背压、连接配额拒绝）。

## Acceptance criteria

- [ ] 既有生命周期测试迁移到包内并全绿（sync 时序、重连、背压阈值 64 KB、配额 200）
- [ ] 两类断链测试全绿：前端断线仅释放连接级资源且重连同步；实例断链/回收删除全部实时资源且不加载旧 Y.Doc
- [ ] 多标签页共享 relay handle 语义保留（引用计数测试）
- [ ] 广播按 `rcsSessionId` 隔离，无全局广播（代码审查 + 测试）
- [ ] 页面隐藏超时链接不自动重连，可见时触发一次连接
- [ ] `bun run precheck` 全绿；`bun run build:web` 通过

## Blocked by

- C1（包与引用迁移完成）
- C2（新 schema 下投影与恢复语义）
