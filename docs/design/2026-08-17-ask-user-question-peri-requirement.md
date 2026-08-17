# 需求：AskUserQuestion（elicitation/create）stdio 转发支持

> 提出方：FenixAgent 平台
> 目标仓库：perihelion（Peri Code）
> 日期：2026-08-17
> 状态：待 peri 侧评估

## 1. 背景

FenixAgent 平台通过 acp-link 以 **stdio 子进程**方式运行 peri（`spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] })`，stdin/stdout 为 NDJSON ACP 管道）。

peri 已完整实现 `AskUserQuestion` 工具（`peri-middlewares/src/tools/ask_user_tool.rs`），但当前**只有 mpsc/TUI 路径**经 `AcpTransportBroker` 发出标准 ACP `elicitation/create`；**stdio 生产路径**下提问被内部吞掉，客户端（FenixAgent）收不到任何事件，前端无法弹窗。

FenixAgent 前端已具备适配条件（可复用权限确认面板链路，`SessionStateSnapshot.status` 已预留 `waiting-user` 状态位），**前置条件是 peri 将提问转发到 ACP 传输层**。

## 2. 现状证据（代码位置）

| 位置 | 现状 |
|------|------|
| `peri-acp/src/host/stdio/session/prompt_exec.rs:63-64` | 无条件装配 `Arc::new(StdioBroker::new())`，无配置开关 |
| `peri-acp/src/host/stdio/context.rs:31-52` | `StdioBroker::request`：`Approval` 自动 approve；`Questions` **直接返回空答案**（`selected: vec![]`），不发出任何事件 |
| `peri-acp/src/broker/transport_broker.rs:105` | mpsc/TUI 路径的 `elicitation/create` 请求构造（参照实现） |
| `peri-acp-types/src/interaction.rs` | `UserInteractionBroker` 契约（`InteractionContext::Approval` / `Questions`） |

## 3. 需求

### 3.1 stdio 会话装配可转发提问的 broker

- 替换 `prompt_exec.rs:63-64` 的装配：stdio 会话的 broker 在 `Questions` 分支通过**当前 ACP transport 的 server→client request 通道**向客户端发送 `elicitation/create`，并等待同 id 的响应（accept / cancel / decline）。
- `Approval` 分支行为**保持不变**（现有自动 approve 语义不得回归）。

### 3.2 事件协议（与客户端约定）

- 采用**标准 ACP `elicitation/create`**（method），params 结构复用 `transport_broker.rs:105` 现有构造（`mode: "form"` + `requestedSchema` JSON Schema，含 title/description/options、单选/多选）。
- 响应复用现有 action 语义：
  - `{ "action": "accept", "content": { "<q_id>": "<选项 label>" } }`
  - `{ "action": "cancel" }` / `{ "action": "decline" }`
- **无需新增私有协议帧**；交互协议层不做任何扩展。

### 3.3 生命周期与容错

- **transport 关闭**：挂起的提问必须安全中断（以 cancel 语义返回或报错），不得挂死会话、不得阻塞后续 prompt。
- **客户端不响应**：需 peri 侧提供可配置兜底（如超时后返回空答案）或显式文档化「不响应则永久挂起」的风险与原因。**推荐：可配置超时**（默认值由 peri 侧定，建议与 HITL 审批 300s 对齐或更长），并支持 0 = 不超时。
- `session/cancel`：当前语义不解除挂起的提问，可保持，但请在新行为文档中注明该限制。

### 3.4 边界（维持现状，不新增能力）

- **subagent**：`AskUserQuestion` 是 middleware 工具，subagent 不继承 —— 维持现状，**无需**转发/透传机制。
- **workflow 路径**（broker 为 None）：维持现状（不装配提问通道）。
- **兼容性**：其它 stdio 客户端（非 FenixAgent、不响应 `elicitation/create`）依赖 3.3 的超时兜底保障不挂死。

## 4. 验收标准

1. stdio 模式调用 `AskUserQuestion` → 客户端收到 `elicitation/create`，`message` / `requestedSchema` / 选项字段完整（含多选形态）。
2. 客户端 `accept` → LLM 收到 `[问: header]\n回答: ...` 格式的 tool result。
3. 客户端 `decline` → LLM 收到 `ToolRejected` 错误；`cancel` → 空答案。
4. 客户端断连 → 挂起提问安全中断，会话不挂死、可继续。
5. 权限审批（`Approval`）路径行为与当前完全一致（需回归测试）。
6. TUI / mpsc 路径的既有 `elicitation/create` 行为不回归。

## 5. 建议实现方向

- 新增 `StdioQuestionBroker`（或改造 `StdioBroker`）：`Questions` 分支经 stdio transport 的 server→client request 通道发送 `elicitation/create` 并等待同 id 响应；发送方向与 mpsc 路径一致，可复用 `transport_broker.rs` 的请求构造与响应解析逻辑，差异仅在**传输通道注入**。
- `Approval` 分支保持 `StdioBroker` 现有行为（或独立保留），避免影响当前自动审批语义。

## 6. 交付物

- peri 侧：上述改造 + 对应单测/集成测试（覆盖 4.1–4.6）。
- FenixAgent 侧（并行，无需 peri 等待）：协议映射、Y.Doc 投影、前端弹窗面板、回传通道 —— 由 FenixAgent 自行完成。
