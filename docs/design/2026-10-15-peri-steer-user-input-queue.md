# Peri 待发送队列（steer）适配设计

> 日期：2026-10-15
> 状态：已实施，待真机验证
> 范围：acp-link 转发白名单 + chat-channel 控制面/投影 + 前端待发送区
> 上游契约：perihelion（`peri-acp` / `peri-tui`），本文档第 2 节是 RCS 侧冻结的契约快照

## 1. 目标与范围

用户在 Agent 执行中继续输入时不打断、先排队；需要时再投递（打断当前执行并把排队内容注入新一轮），或把排队项取回输入框。对齐 peri TUI 的 steer 语义（`peri-tui/src/acp_client/client/steer.rs`）。

RCS 只做校验、翻译、转发与投影——**队列真相在 peri 进程内**，不跨进程持久，RCS 不缓存队列状态、不本地排队。

## 2. peri 侧冻结契约

### 2.1 能力协商

能力键 `peri.userInputQueue`（`initialize` / `session/new` 的 capabilities）。未协商时四个方法一律回 `-32601` 且不发事件——RCS 侧必须在协商成功后才展示队列 UI。

### 2.2 方法（`params` camelCase，peri 侧 `deny_unknown_fields`：多一个字段整条请求被拒）

| 方法 | params | 语义 |
| ---- | ------ | ---- |
| `session/input/snapshot` | `sessionId`、`generation?` | 读权威快照；`generation` 可选，用于校验 |
| `session/input/enqueue` | `sessionId`、`generation`、`commandId`、`inputId`、`content`、`originalDraft` | 入队（不打断执行） |
| `session/input/dispatch` | `sessionId`、`generation`、`commandId`、`inputIds[]` | 投递：打断当前执行并注入 |
| `session/input/takeback` | `sessionId`、`generation`、`commandId`、`inputId` | 取回（仅 `queued` 可取回） |

`content` 是 peri 内部 `MessageContent`：纯文本为**裸字符串**，含图片时为 `{ type: "image", source: { type: "base64", media_type, data } }`。这与 ACP prompt 的 `{ type: "image", mimeType, data }` 不同，漏转换会静默丢图。

### 2.3 事件（transport 通知）

队列事件走 `peri/agent_event`（`event_json` 为 `AcpEvent` 的 JSON 字符串，外层 `{ type, value }`、内层字段 snake_case）：

| 事件 | `value` 载荷 | RCS 用途 |
| ---- | ---- | ------ |
| `user_input_queue_changed` | `{ snapshot: {...} }`（快照字段为 camelCase） | 全量投影 + 换代判定 |
| `user_input_run_started` | `{ generation, request_id }` | 建立 steer run 身份 |
| `user_input_delivered` | `{ generation, input_id, content }` | 摘除待发送项 + **canonical transcript 唯一写入信号** |

turn 终态走另一个通知：`peri/agent_event_done`，params 平铺 `{ sessionId, stopReason, requestId? }`（不是 `event_json` 包裹）。协商 `userInputQueue` 即必发。`stopReason` 映射 `cancelled` → turn_cancelled、`error` → turn_failed、其余 → turn_completed。

### 2.4 响应与错误语义（已对照 `peri-acp/src/host/requests/user_input.rs` 核实）

- `session/input/snapshot` 成功时**直接回快照**（`{ sessionId, generation, revision, activeRequestId?, items[] }`，camelCase）。
- 三个变更方法成功时回 `UserInputQueueReceipt`：`{ snapshot, results[], takenBack? }`。`results` 是命令首次裁决的逐项状态；`takenBack` 只在真的撤出了 `queued` 项时出现，且幂等重放会保留原值——**缺省即本次取回未生效**（项已 dispatching/claimed/delivered 时 peri 不报错，回执仍成功）。
- 四类队列侧失败（换代、容量满 32、身份冲突、会话关闭）共用同一形状：`-32602` + `data = { rejected: true, snapshot }`（`AcpError::with_data`，上游 `message` 只是文案）。因此**"是否换代"必须由快照代号与本地投影代号比对来证明**，不能见到 `rejected` 就断言过期。
- 只读 observer（`!state.lease.is_writer`）发三个变更方法 → `-32602` 且**不带** `rejected` 标记；未协商能力或未知方法 → `-32601`。两者都归 `INVALID_STATE`（不可重试）。
- 入队侧本地校验：空 `inputId` / 空 `inputIds` / 空内容在 RCS 侧直接拒绝，不占用 peri 的 32 容量，也不产生空气泡。

### 2.5 项状态机

`queued → dispatching → claimed → delivered`，或中途 `withdrawn`（取回）、`unknown`（身份不在本会话队列记录中）。终态项不再出现在快照里。

## 3. RCS 侧实现映射

| 层 | 位置 | 职责 |
| -- | ---- | ---- |
| 转发白名单 | `packages/acp-link/src/peri-task-capability.ts` | `session/input/*` 请求与 `peri/agent_event` / `peri/agent_event_done` 通知放行（三条转发路径共用：`server.ts`、`client/acp-spawn-helper.ts`、`client/session-manager.ts`） |
| 翻译 | `packages/chat-channel/src/protocol/translator.ts` | Action → JSON-RPC（权威字段注入）、`content` 双向形状转换、快照请求构造 |
| 控制面 | `channel/user-input-queue-action.ts` | 校验 → 解析代号 → 出站 → 等待回执 → 收敛；能力协商后的快照补拉 |
| 在途登记 | `channel/user-input-pending.ts` | 按 rpcId 登记四类在途请求，超时/断连统一收敛 |
| 响应收敛 | `channel/user-input-queue-wire.ts` | 错误分类、权威快照写回投影 |
| 投影 | `state/user-input-queue.ts` | Session Doc root `userInputQueue`（换代清空、revision 单调、上限截断），浏览器安全 |
| 聚合 | `state/aggregator.ts` | `user_input_*` 事件入投影；delivered 写用户消息（entryId = `inputId`）；终态按 `requestId` 判定归属 |
| 前端 | `ui-components/.../panels/user-input-queue-panel.tsx`、`shell/internal/use-user-input-queue-actions.ts`、`agent-runtime/web/hooks/use-user-input-queue.ts` | 待发送区、入队交互、取回回填草稿 |

Action 契约与错误收敛详见 `docs/arch/19-yjs-chat-streaming.md` §7.1.1，投影结构见同文 §5.3，终态归属见 §8.1。

## 4. 关键决策

1. **`generation` / `commandId` / `sessionId` 一律服务端权威注入**：前两者来自投影与 Action 信封，后者来自连接绑定的 `acpSessionId`；浏览器传值一律被显式覆盖。代号缺失时先补拉快照，拿不到即失败，绝不猜值（猜错只会换来一次 `-32602`）。
2. **不写 Chat Doc**：用户气泡只由 `user_input_delivered` 写入，入队路径不写，避免重复气泡。
3. **队列未协商即回退旧路径**：投影 `enabled=false`，前端按原 `send_prompt` 直发，不出现队列 UI。
4. **断连即作废**：relay 断连后 peri 队列不跨进程持久，清投影并 `enabled=false`，避免幽灵待发送项。

## 5. 前端交互

- 执行中提交（不打断）：走 `enqueue_user_input`，草稿原文随 `originalDraft` 一起入队。
- 待发送区：单条「发送」/ 全量「全部发送」→ `dispatch_user_inputs`（打断 + 注入）；单条「取回」→ `takeback_user_input` 成功后把草稿追加到输入框（已有内容时换行分隔，保留原草稿）。
- 失败提示按公开错误类型区分可重试（`AGENT_UNAVAILABLE`）与不可重试（`INVALID_STATE` / `RATE_LIMITED` / `VERSION_CONFLICT`）。
- **已知边界**：前端按"动作已写进 socket"回填草稿（不等 ack，与入队路径同一模式），不等待服务端裁决。若该项在点击瞬间已被投递（另一标签页点了发送），服务端按 §2.4 判定取回未生效并回 `INVALID_STATE`，但草稿已在输入框里——用户会看到该消息已进入对话、输入框也留着同一份文本。要彻底消除需把草稿回填改为 ack 驱动（`sendAction` 目前只报"是否写入 socket"），留待后续按需改造。

## 6. 验证状态与未验证项

**已对照 peri 源码核实**（`peri-acp-types/src/session/user_input.rs`、`peri-acp/src/host/requests/user_input.rs`、`peri-agent/src/session/user_input_mailbox.rs`、`peri-acp/src/event/mod.rs`、`peri-acp-types/src/peri_caps.rs`）：四个方法的 params 字段名与 camelCase 口径（三个变更方法是 `deny_unknown_fields`）、三个事件的外层 `{type,value}` / 内层 snake_case 形状、`agentCapabilities._meta` 的能力回显路径、拒绝错误的真实形状与四类失败共用标记、取回对非 `queued` 项"成功但未生效"的语义、幂等重放保留 `takenBack`。

已用构造帧覆盖：入队/投递/取回三类 Action 的权威字段注入与 payload 覆盖、图片出站形状、换代校正与"代号相同即非换代"的分类、取回未生效不提交、delivered 幂等与唯一写入、跨会话隔离、非属主拒绝、旧 schema 快照读回 `enabled=false`、steer run 终态归属（无 `requestId` / `requestId` 不匹配被拒）。

**未验证（本机无真实 peri 二进制）**：

1. 端到端往返：真实 peri 对出站帧的接受与回执（含 `deny_unknown_fields` 是否报错）。
2. 只读 observer 的真实 `-32602` 行为（源码已确认判定条件，未跑双连接实测）。
3. `stopReason=cancelled` 是否始终携带 `requestId`（影响被打断旧 turn 的终态归属判定）。
4. 浏览器端到端：真实会话的 UI 流程（含图片入队、取回回填、容量满时的提示文案）。

真机联调时按此清单逐项确认；`requestId` 缺省导致 turn 停在 `loading` 的边界已在 `docs/arch/19-yjs-chat-streaming.md` §8.1 记录（用户取消可收敛）。
