# ADR: Chat 域独立包设计（chat-channel）

- **日期**：2026-08-04
- **状态**：✅ 已确认（grill-with-docs 评审输出，16 项决策逐项确认）

## 背景

`docs/arch/19-yjs-chat-streaming.md` 定义了浏览器 → 主服务 → Machine 的流式对话目标架构，但现有实现与目标存在系统性差距：Y.Doc schema 与文档契约不符且 Doc 职责错位、聚合层直接消费文档明令禁止的 `agent_message_chunk` 私有帧、无 Action/Ack 协议与 commandId 幂等、无 Turn 状态机、权限无 CAS 保护、域边界缺失（Chat 域逻辑横跨 `packages/acp-server/src/state/` 与 `src/transport/relay/yjs-frontend/`，后者直接耦合 `environmentRepo` / `resolveWorkspacePath` / `acp-idle-monitor` / `cache` 等宿主服务）。

编排域已完成独立包重构（`packages/orchestration`，见 2026-08-03 ADR），Chat 域需走相同路径：抽包 → 重构 → 文档升级为"实现基线"。

## 决策

### 1. 包结构与合并策略

- 新建 `packages/chat-channel` 大包（与 `packages/orchestration` 同级），**合并原 `acp-server` 包全部能力**（protocol / state / persist / types），新增控制面子目录 `channel/`（gateway、session-channel、command-coordinator、lease-manager 占位）。
- 原 `acp-server` 包**删除**，全部引用（约 15-20 处）一次性迁移到 `@fenix/chat-channel`，不留兼容壳；`web/src/acp/` 目录整体删除（client.ts / index.ts 为死代码），11 个组件 import 直接指向 `@fenix/chat-channel`（不做 re-export 层）。
- 保留 `protocol/` `state/` `persist/` 子目录名（内容自洽，降低迁移认知成本），新增 `channel/`。
- 宿主依赖注入复制编排域模式：包内定义 `ChatChannelDependencies` 接口，`src/services/chat-channel-bootstrap.ts` 装配单例（`getChatChannelController()` + `resetChatChannelBootstrap()` 供测试）；yjs-frontend 对宿主的直接 import 全部收敛到桥接层。

### 2. 并发控制务实化（不实现事件日志与租约）

- **不实现**文档 7.2 的领域事件日志体系（`eventSeq` 不显式建模）与文档 8.2 的 `SessionLeaseManager` 租约。
- 理由：YJS 底层 CRDT 已保证文档并发写收敛与顺序；单实例部署下进程内天然单写；"防重复副作用"由 `commandId` 去重表承担（每 `rcsSessionId` 进程内 Map，覆盖客户端最大重试窗口，重复 Action 返回原 Ack 不重复调用 Agent）。
- `leaseEpoch` 字段在协议类型中**占位**（运行时恒为固定值），为将来多节点部署预留；跨节点 Redis 租约/事件日志持久化不在本次范围。

### 3. Action / Ack 协议修订（前端最小配合）

- 前端 WS 消息只新增 `commandId` 字段（UUID），其余信封字段（`protocolVersion` / `expectedProjectionVersion` / `client`）由服务端按会话绑定补充与校验；`expectedProjectionVersion` 前端乐观并发增强（冲突重试 UI）留二期。
- `accepted → committed → duplicate` 两阶段 Ack 语义与 `ActionError` 稳定错误码按文档 7.1 落地。

### 4. ACP 聚合边界：主服务侧规范化

- 在 `extractAcpEvent` 基础上扩展为 `ACPChannel`：把 acp-link 私有帧（`agent_message_chunk` / `agent_thought_chunk` / `prompt_complete`）翻译为规范化事件（`session/update` 语义），聚合层只消费规范化事件，删除旧类型消费路径。
- acp-link 与 Agent 部署**零改动**；文档 6.2 相应修订。

### 5. Y.Doc schema 一次性切换

- 一次性切换至文档 5.2/5.3 结构化 schema（`schemaVersion` / `projectionVersion` / `entryOrder` / `entries` / `blocks` / `session` / `agent` / `pendingPermissions`），**无兼容窗口、不做双读双写**（Y.Doc 是实时镜像非持久资产，前后端同仓库同步发版）。
- 同时纠正 Doc 职责错位：Chat Doc `chat:{rcsSessionId}` = 消息时间线（高频），Session Doc `session:{rcsSessionId}` = 会话元信息 / Agent 状态（低频）。

### 6. Turn 状态机与权限 CAS

- Turn 状态机（`accepting → running → awaiting_permission → cancelling → cancelled/interrupted/failed/completed`）为权威，终态不可逆；删除会话级扁平 `status` 枚举，前端由 `activeTurn.turnStatus` 派生展示状态。
- `pendingPermissions` 迁入 Session Doc，解析走 CAS（仅 `pending → resolved` 原子迁移一次，成功后才向 Agent 发 `permission.resolve`）。

### 7. 连接生命周期与测试

- `ws-lifecycle` 语义原样迁移、结构重组（YJS sync 时序、64 KB 背压、`YJS_MAX_CLIENTS` 200 配额不重写），与文档 10 节差异记二期。
- 测试 seam：SessionChannel 协议层，包内集成测试 + 假连接对象（无真实 WS / Agent 进程），测试文件与源码同目录（`packages/chat-channel/src/**/*.test.ts`）。

## 影响

- 所有原 `acp-server` 引用点同批迁移（src、web、packages、tests、文档），禁止部分迁移造成双包并存。
- 前端消费点（2 个 hook + `structured-to-thread.ts` + 11 个类型引用组件）与后端投影同批切换；发布顺序：后端先行、前端同批构建。
- `agent-chat-service.ts`（HTTP 单轮）与 workflow 路径仅迁移 import，对外行为不变。
- 文档 `docs/arch/19-yjs-chat-streaming.md` 重构完成后升级为"实现基线"，修订 6.2（规范化事件）、7.1（前端信封）、5.4（删除双读窗口）、10 节（差异标注二期）。
