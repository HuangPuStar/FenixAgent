# AskUserQuestion（interactive_question）前端弹窗适配设计

> 日期：2026-08-17
> 状态：待实施
> 范围：FenixAgent 侧（relay 入站 + 聚合层 + 出站回传 + 前端面板）
> 前置：acp-link 侧 **零改动**（标准 ACP 能力已完整实现）

## 1. 现状盘点

| 层 | 现状 | 结论 |
|----|------|------|
| acp-link 出站 | `claude-acp-adapter.ts:475` 拦截 AskUserQuestion 工具 → `send({ type: "interactive_question", payload })`，60s 超时后 resolve 空答案 | ✅ 已有 |
| acp-link 入站 | `acp-dispatcher.ts:194-206` 处理 `control_response` 传输帧 → `handleControlResponse(requestId, approved, extra)`（claude-acp-adapter.ts:684）→ 查 `interactiveAnswers` 解析答案 → 注入回 agent | ✅ 已有 |
| relay 入站 | `interactive_question` 帧在 `acp-channel.ts:79-93` 映射表无键 → `acp-channel.ts:255` 返回 null → relay-event-handler.ts:183 **静默丢弃** | ❌ 缺口 |
| 聚合层 | 无 question 事件类型 / 无投影 | ❌ 缺口 |
| 出站回传 | 仅 `respond_permission`（JSON-RPC response 形态，translator.ts:64-78）；无 question 通道 | ❌ 缺口 |
| 前端 | 无弹窗；权限面板链路（PermissionPanel / ToolPermissionButtons / permissionOptions 投影）可仿 | ❌ 缺口 |

## 2. 目标数据流

```
agent (AskUserQuestion 工具)
  → acp-link claude-adapter 拦截 → { type: "interactive_question", payload } 帧
  → relay-event-handler normalizeAcpMessage → PRIVATE_FRAME_TO_NORMALIZED 新键
  → question_requested 事件
  → aggregator applyQuestionRequested → Session Doc root.pendingQuestions（CAS + 60s expiresAt）
  → 前端 QuestionPanel 弹窗（多选项按钮）
  → 用户点选 → sendAction({ action: "respond_question", questionId, optionId })
  → session-channel respond_question 处理 → translator 构造 control_response 帧
  → acp-link dispatcher:194 handleControlResponse → resolve answerPromise
  → claude-adapter 注入 user 消息 + tool_use_result → agent 继续执行
```

## 3. 修改清单

### 3.1 relay 入站（packages/chat-channel）

**`src/protocol/acp-channel.ts`**
- `PRIVATE_FRAME_TO_NORMALIZED`（:79-93）加键：
  `interactive_question` → `question_requested`（normalize 函数：透传 `sessionId/questionId/toolId/toolName/questions[]/description`）。

**`src/schema.ts`**
- `NormalizedEventType`（:164-183）加 `question_requested`、`question_resolved`。
- 新增 `QuestionProjection`（仿 `PermissionProjection` :133）：
  `{ questionId, status: "pending" | "resolved", questions: [...], description, expiresAt }`。

### 3.2 聚合层（packages/chat-channel/src/state/）

**`src/state/chat-writer.ts`**
- `upsertPendingQuestion`（仿 `upsertPendingPermission` :517-531）：Session Doc 根 map `pendingQuestions`，按 questionId 幂等写入（已存在则跳过）。

**`src/state/aggregator.ts`**
- `applyQuestionRequested` case（仿 `applyPermissionRequested` :222-282）：投影 `pendingQuestions`；turn 状态更新（`SessionInfoProjection` 新增 `waiting_question` 或复用 `waiting_user` —— 前端 `SessionStateSnapshot.status` 已有 `waiting-user` 枚举，建议复用并兼容）。
- 超时清理：60s `expiresAt`（与 acp-link 的 60s 自动空答案对齐，避免前端挂死面板）。

**`src/state/question.ts`**（新文件，仿 `src/state/permission.ts`）
- `respondQuestion` CAS 迁移：仅 `pending → resolved` 一次，成功后返回构造 control_response 所需数据；重复 respond 幂等丢弃。

### 3.3 出站回传（packages/chat-channel）

**`src/protocol/translator.ts`**
- 新增 `respond_question` case：构造 **`control_response` 传输帧**（非 JSON-RPC！）：
  ```ts
  { type: "control_response", request_id: parsed.questionId, approved: true,
    extra: { outcome: { optionId: parsed.optionId } } }
  ```
  与 acp-link `handleControlResponse` 期望对齐（`extra.outcome.optionId` 即用户选择的选项 label）。

**`src/channel/session-channel.ts`**
- `respond_question` action 处理（仿 `respond_permission`）：校验 pending → CAS 迁移 → 构造 control_response 帧回传。

**`src/channel/types.ts`**
- `KNOWN_ACTION_TYPES` 白名单加 `respond_question`。

### 3.4 前端（web/）

**`web/src/hooks/use-session-state.ts`**
- `computeMetaSnapshot` 增加 `pendingQuestions` 投影（仿 `permissionOptions` :171-216）：`Map<questionId, QuestionProjection>`，60s 过期自动剔除。

**`web/components/chat/QuestionPanel.tsx`**（新组件，仿 `PermissionPanel`）
- Dialog 弹窗：`question` 标题 + `header` + 选项按钮列表（复用 `ToolPermissionButtons` 多按钮样式；单选/多选支持）。
- 挂载：ChatInterface（仿 permissionOptions 合并逻辑）或独立弹窗层（Dialog Portal 到 body，跨会话悬浮）。

**`web/components/ChatInterface.tsx`**
- 消费 `pendingQuestions` → 渲染 QuestionPanel；回调 `onQuestionRespond(questionId, optionId)` → `sendAction({ action: "respond_question", questionId, optionId })`。

**`web/src/i18n/`**
- `components.json` 新增 `askUser.*` 文案（仿 `permissionPanel.*`）。

### 3.5 测试

| 位置 | 用例 |
|------|------|
| `packages/chat-channel/src/__tests__/` | relay 映射：interactive_question → question_requested；aggregator 投影：pendingQuestions 写入/幂等/60s 过期；respond CAS：重复 respond 只生效一次 |
| `src/__tests__/` | 端到端：前端 action → translator → control_response 帧形态 |
| `web/src/__tests__/` | QuestionPanel 渲染（多选项/多选/空状态）与回传调用 |

## 4. 关键设计决策

1. **60s 超时对齐**：acp-link 侧 60s 后自动 resolve 空答案（claude-adapter.ts:469），后端 `expiresAt` 必须 ≤ 60s 并主动清理投影，否则前端面板悬挂。
2. **control_response 帧形态**：question 回传与 permission 不同 —— permission 走 JSON-RPC response（translator.ts:64-78），question 必须走 `control_response` 传输帧（acp-dispatcher.ts:194 消费）。
3. **答案映射**：`extra.outcome.optionId` = 用户点击的选项 label，acp-link 直接作为答案注入（claude-adapter.ts:690-693）；多选场景以 `extra.answers` 对象承载（`{ q_id: label[] }`），handleControlResponse 已支持（:695）。
4. **幂等**：questionId 由 acp-link 生成（`iqa_*`）天然唯一；CAS 迁移保证重复 respond 只生效一次（与 permission-cas 同模式）。
5. **turn 状态**：复用 `waiting_user` 展示态（前端已有枚举），不新增状态位；`awaiting_permission` 语义不动。

## 5. 实施顺序（垂直切片）

1. **切片 1（透传 + 投影）**：acp-channel 映射 + schema 事件类型 + chat-writer/aggregator 投影 + 后端测试 → 验证 Y.Doc 出现 pendingQuestions。
2. **切片 2（回传）**：translator + session-channel + 白名单 + CAS + 测试 → 验证 respond 后 agent 收到答案。
3. **切片 3（前端面板）**：投影 → QuestionPanel → ChatInterface 挂载 → i18n → 前端测试 + build:web。
4. 全量 `bun run precheck`。
