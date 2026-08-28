# C2 · 聚合层重构：规范化事件 + 新 schema 投影

> 来源：`docs/design/2026-08-04-yjs-chat-streaming-prd.md`（Q4/Q6/Q8 结构部分）
> 性质：核心切片（后端投影 + 前端消费**必须同批完成**，Q4 无兼容窗口）

## What to build

把聚合层重构为"只消费规范化事件、投影到文档 5.2/5.3 新 schema"的形态，并同步纠正两份 Doc 的职责错位。**这是无兼容窗口的一次性切换**——后端投影与前端消费点必须同批完成、同批构建发布。

### 后端

1. **规范化事件流（Q6）**：在包内 `protocol/`（基于原 `extractAcpEvent` / `extractJsonRpc` 迁移）实现 ACPChannel 的入站规范化：把 acp-link 私有帧（`agent_message_chunk` / `agent_thought_chunk` / `prompt_complete` 等）翻译为统一的规范化事件（`session/update` 语义：增量、内容块、终态），文本内容位于同一 `update.content`。保留"原始 JSON-RPC + 包裹 `{type, payload}`"双格式兼容。
2. **聚合层重写（Q4）**：`state/aggregator.ts` 重构为只消费规范化事件，**删除**对 `agent_message_chunk` / `agent_thought_chunk` 等旧事件类型的直接消费路径；`state/doc-manager.ts` / `chat-writer.ts` / `factory.ts` 投影到新 schema。
3. **新 schema（文档 5.2/5.3）**：
   - **纠正 Doc 职责错位**：Chat Doc `chat:{rcsSessionId}` = 消息时间线（高频）；Session Doc `session:{rcsSessionId}` = 会话元信息 / Agent 状态（低频）。
   - Chat Doc：根对象 `schemaVersion` / `projectionVersion` / `entryOrder: Y.Array<string>` / `entries: Y.Map<ChatEntry>`；Entry 含 `entryId`、`turnId`、`kind`（message/tool/system）、`role`、`status`（pending/streaming/completed/cancelled/error）、`blockOrder`、`blocks`；ContentBlock 为 text/reasoning/tool_call/resource 联合类型；流式文本用 `Y.Text`。
   - Session Doc：`schemaVersion` / `projectionVersion` / `session`（sessionId/title/status/environmentId/agentConfigId/activeTurnId）、`agent`（instanceId/acpSessionId/status/capabilities/lastActivityAt/publicError）、`pendingPermissions`（结构先落地，CAS 语义 C5 实现）。
   - 删除旧字段：`agentInfo` / `sessions` / `chatMeta` / `connection` / `permissions` / `capabilities` / `modelState` / `modeState` / `availableCommands` / `tokenUsage` / `messages` / `streaming` / `tools` / `artifacts` / `structuredMessages`。
4. **映射幂等**：以 `turnId` / `entryId` / `toolCallId` / `permissionId` 与终态状态机确定写入目标，重放同一帧不重复创建 Entry/工具调用/权限请求；每 `rcsSessionId` 独立有界缓冲区，控制类更新先 flush 内容批次再写入。
5. **绑定规则**：`acpSessionId` 只能从服务端维护的 Instance ACP session binding 反查 `rcsSessionId`；binding 不存在/已解绑时丢弃事件，不重建旧 Doc。

### 前端（同批）

6. 删除 `web/src/acp/` 目录（`client.ts` / `index.ts` 死代码、`types.ts` re-export 一并移除）；11 个组件 import 直接改为 `@fenix/chat-channel` 的类型导出（包 `index.ts` 需导出前端所需类型：Entry/Block/AgentInfo/SessionMeta/Action 相关等）。
7. `use-chat-state.ts` / `use-session-state.ts` / `structured-to-thread.ts` 改为消费新 schema（entries/blocks、session/agent/pendingPermissions），派生逻辑按新结构重写（展示层语义保持不变：消息列表、思考块、工具调用、token 等）。

## Acceptance criteria

- [ ] 聚合层只消费规范化事件，grep 不到 `agent_message_chunk` / `agent_thought_chunk` 消费路径（`extractAcpEvent` 兼容层内部翻译除外）
- [ ] 新 schema 测试 `doc-schema.test.ts` 全绿：结构、`projectionVersion` 演进、tombstone 删除、Doc 职责（Chat Doc 无状态字段、Session Doc 无时间线字段）
- [ ] `acp-aggregator-mapping.test.ts` 全绿：规范化事件映射幂等、重放不重复创建、旧事件类型被拒绝
- [ ] 前端构建通过（`bun run build:web`），11 个组件 import 已迁移，`web/src/acp/` 已删除
- [ ] 既有行为无回归：消息流、工具调用、权限请求（pending 状态展示）、token 用量在前端可见且顺序正确（人工冒烟 + 既有前端测试适配后全绿）
- [ ] `bun run precheck` 全绿

## Blocked by

- C1（包与引用迁移完成）
