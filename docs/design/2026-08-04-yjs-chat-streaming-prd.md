# PRD: Chat 流式链路（YJS Chat Streaming）目标架构落地重构

> 来源：`docs/arch/19-yjs-chat-streaming.md` 目标架构落地 + grill-with-docs 评审 | 日期：2026-08-04 | 状态：draft（待禅道发布）
> 前置：`docs/arch/20-orchestration-management.md`（编排域）已完成，本 PRD 承接其 `ensureRunning` 等能力。

## Problem Statement

`docs/arch/19-yjs-chat-streaming.md` 定义了浏览器 → 主服务 → Machine 的流式对话目标架构，但现有实现与目标架构存在系统性差距，核心协议语义尚未落地：

- **Y.Doc schema 与文档契约不符**：现有 `packages/acp-server/src/state/factory.ts` 使用扁平结构（`agentInfo` / `sessions` / `chatMeta` / `connection` / `permissions` / `capabilities` 等），文档 5.2/5.3 要求 `schemaVersion` / `projectionVersion` / `entryOrder` / `entries` / `blocks` 的结构化 schema；且现有 Doc 职责与目标错位——`chat:{rcsSessionId}` 装的是状态类数据，`session:{rcsSessionId}` 反而装着时间线类数据（`messages` / `streaming` / `tools`）。
- **ACP 事件消费违反文档禁令**：现有 `aggregator.ts` 直接消费 `agent_message_chunk` / `agent_thought_chunk` 等 acp-link 私有帧，文档 6.2 明确禁止读取这些字段，只允许消费 `session/update`（`params.update.sessionUpdate`）。
- **无 Action / Ack 协议**：文档 7.1 要求 `commandId` 幂等、`accepted → committed` 两阶段 Ack、`expectedProjectionVersion` 冲突校验；现有 `forwardYjsAction` 仅做动作透传（前端发 `{action, content}` 简单对象，服务端补数字 rpcId），无去重、无版本校验、无重试语义。
- **无 CommandCoordinator 与 Turn 状态机**：文档要求 Action 校验、幂等、串行化集中在 `CommandCoordinator`，Turn 状态机（`accepting → running → awaiting_permission → cancelling → …`）显式建模；现有逻辑散落在 `src/transport/relay/yjs-frontend/` 五个文件中，无显式 Turn 状态机（仅有会话级扁平 `status: idle/thinking/responding/…` 的 10 态枚举）。
- **权限无 CAS 保护**：现有 `resolvePermission` 直接改 `permissions[]` 的 status，无"仅 pending 可迁移一次"的原子保证，重复解析可能向 Agent 发两次授权。
- **域边界缺失**：Chat 域逻辑横跨 `packages/acp-server/src/state/`（聚合层）与 `src/transport/relay/yjs-frontend/`（控制面 + 宿主耦合），`yjs-frontend/index.ts` 直接 import `environmentRepo` / `resolveWorkspacePath` / `acp-idle-monitor` / `cache` 等宿主服务，无法独立测试与演进。
- **测试缺口**：无协议层测试（Action → Ack → Y.Doc 投影），现有测试仅覆盖模块内部行为，无法验证幂等、权限 CAS 与状态机等核心不变量。

开发者每次改动都要跨层跳转，且文档与代码冲突（如 `agent_message_chunk`）导致维护者无法判断以谁为准。Chat 链路是产品核心体验，上述差距直接影响流式稳定性、多标签页一致性与并发安全。

## Solution

按 `docs/arch/19-yjs-chat-streaming.md` 的目标架构完成 Chat 流式链路的大重构，将文档从"目标设计基线"升级为"实现基线"（与 20 号文档相同路径）：

1. **建立 Chat 域独立包 `packages/chat-channel`**：合并原 `acp-server` 包全部能力（protocol / state / persist），新增控制面（Gateway / SessionChannel / CommandCoordinator / LeaseManager 占位），`src/` 只留桥接（复制编排域模式）。
2. **落地 Action / Ack 协议**：`commandId` 幂等去重、`accepted / committed / duplicate` 语义、`expectedProjectionVersion` 冲突校验（服务端）、`ActionError` 稳定错误码；前端只新增 `commandId` 字段。
3. **重构 ACP 聚合边界**：主服务侧把 acp-link 私有帧（`agent_message_chunk` / `agent_thought_chunk` / `prompt_complete`）翻译为规范化事件，聚合层只消费规范化事件，删除旧类型消费路径。
4. **重构 Y.Doc schema**：一次性切换至文档 5.2/5.3 结构化 schema，同时纠正 Doc 职责错位（Chat Doc = 时间线高频，Session Doc = 状态低频）；无兼容窗口。
5. **显式 Turn 状态机**：按文档 8.1 建模，终态不可逆，取消/断链/权限超时进入清晰终态；删除扁平 `status` 枚举，前端由 `activeTurn.turnStatus` 派生。
6. **权限 CAS**：`pendingPermissions` 迁入 Session Doc，解析走 CAS（仅 `pending → resolved` 一次）。
7. **并发控制务实化**：不实现事件日志体系与租约（评审决策，见下文），保留 `commandId` 去重表；`leaseEpoch` 类型占位。
8. **协议层测试 seam**：包内集成测试 + 假连接对象（Action → Ack → Y.Doc 投影），覆盖幂等、权限 CAS、状态机、两类断链。

## 评审决策摘要（grill-with-docs 输出，2026-08-04）

以下决策已与需求方逐项确认，作为实现契约：

| # | 决策 | 结论 |
|---|---|---|
| Q1 | 重构形态 | 抽大包 `packages/chat-channel`，与 `packages/orchestration` 同级 |
| Q1b | 包内形态 | 单包 + 子目录（`src/channel/` 等），不建嵌套 workspace 包 |
| Q2 | 聚合层归属 | 原 `acp-server` 包全部能力合并入 `@fenix/chat-channel`，两者合并为一个包 |
| Q2b | 包名 | `@fenix/chat-channel`（原 acp-server 导出全量迁入，引用一次性迁移） |
| Q3 | 前端范围 | 后端为主、前端最小配合（改动集中在 `sendViaWs` + 2 个 hook + 类型 import） |
| Q4 | schema 迁移 | 一次性切换，无兼容窗口；同时纠正 Doc 职责错位 |
| Q5 | 事件日志/租约 | **不实现**：不做事件日志体系、不做租约；保留 `commandId` 去重表；`leaseEpoch` 类型占位（YJS CRDT 已保证文档一致性，单实例天然单写；防重复副作用由 commandId 去重承担） |
| Q6 | 入站事件规范化 | 主服务侧翻译（ACPChannel/extractAcpEvent 边界）：私有帧 → 规范化事件；acp-link 与 Agent 部署零改动 |
| Q7 | Turn 状态机 | 引入为权威，删除扁平 `status`，前端由 `activeTurn.turnStatus` 派生展示状态 |
| Q8 | 权限模型 | 按文档落地：`pendingPermissions` 入 Session Doc + CAS 解析 |
| Q9 | 前端 Action 形态 | 前端只加 `commandId`（UUID）；`protocolVersion`/`expectedProjectionVersion` 服务端校验（乐观并发增强留二期） |
| Q10 | 宿主依赖 | 复制编排域桥接模式：包内 `ChatChannelDependencies` 接口 + `src/services/chat-channel-bootstrap.ts` 装配单例 |
| Q11 | 目录结构 | 保留 `protocol/` `state/` `persist/` 子目录名 + 新增 `channel/` |
| Q12 | 测试 seam | 包内集成测试 + 假连接对象（无真实 WS/Agent） |
| Q13 | 连接生命周期 | ws-lifecycle 语义原样迁移、结构重组（时序/背压/配额不重写；与文档 10 节差异记二期） |
| Q14 | 原 acp-server 包 | 删除包，全量迁移引用（约 15-20 处），不留兼容壳 |
| Q15 | 前端类型 | `@fenix/chat-channel` 导出前端类型；`web/src/acp/` 目录整体删除，11 个组件 import 直接改到包 |

## User Stories

1. As a 用户，当我首次进入会话时，我希望先看到 loading，认证、授权和两份 Doc 同步完成后进入 ready，Agent 尚未启动不影响浏览历史，失败时显示可重试错误且不清空已有消息（场景 A）
2. As a 用户，当我发送消息时，我希望用户消息只出现一次，Agent 文本稳定增量更新同一个文本块，工具调用和权限请求以结构化内容呈现，完成后 turn 和 entry 同时进入终态，刷新页面得到相同顺序和内容（场景 B）
3. As a 用户，当我在多个标签页打开同一会话时，我希望各标签页共享同一份会话状态，用户消息不会因前端乐观写入与后端回显双写，awareness 和发送队列互不影响（场景 C）
4. As a 用户，当生成期间连接中断或服务切换节点时，我希望客户端自动重连并恢复仍存活的 Agent 会话；若无法恢复，turn 明确标记为 `interrupted`，且不会自动重发我的消息（场景 D）
5. As a 用户，当 Agent 请求权限时，我希望看到结构化的权限请求（选项、状态、过期时间），有权限的用户只能解决一次，允许后继续原 turn，拒绝或超时进入清晰终态，敏感策略与工具参数不进入公开视图（场景 E）
6. As a 组织管理员，我希望组织 A 与组织 B 的会话、Environment、Agent config 和实例完全隔离，用户即使提交他组织的资源 ID 也不能跨组织访问（场景 F）
7. As a 用户，我希望不同智能体（不同 Agent config / Environment）的会话互不串流，会话创建时持久化的绑定不可被浏览器改写（场景 G）
8. As a 用户，我希望同一智能体在不同用户、不同会话、并发打开或故障恢复时对应各自独立的前端实例状态，互不干扰（场景 H）
9. As a 用户，当一个 Agent 运行实例承载多个前端实例时，我希望每个前端实例仍以 `rcsSessionId` 完全隔离（两份 Y.Doc、事件序列、缓存、广播通道），且会话切换只发生在非 loading 状态（场景 I）
10. As a 用户，当同一会话被多个标签页打开时，我希望共享已确认的会话投影，但连接级状态（心跳、awareness、背压）互不影响（场景 J）
11. As a 用户，当并发受限时，我希望进入会话先复用可用的运行实例，只有创建新实例才检查并发配额；YJS 连接数受独立限制，被拒绝时收到明确错误且不影响已有连接（场景 K）
12. As a 用户，当实例被回收后重新进入会话，我希望服务端为新的实例会话创建全新的实时投影，绝不加载已删除的旧 Y.Doc；页面隐藏导致的超时链接不在后台自动重连，而是回到可见时触发一次连接（场景 L）
13. As a 用户，当我取消生成时，我希望 turn 进入 `cancelled` 或 `interrupted` 终态，任何晚到的增量都被丢弃，不出现"已取消但还在输出"的中间态（4.4）
14. As a 用户，当网络短暂断线时，我希望仅释放连接级资源，只要 Agent 会话存活，重连后自动同步当前实时状态（4.5）
15. As a 用户，当我的连接是慢消费者时，我希望服务端合并更新或让我重新同步，而不是无限缓存拖慢 Agent 和其他用户（§11）
16. As a 用户，当我因超时重发同一 Action 时，我希望服务端通过 `commandId` 去重返回原结果，业务效果恰好一次（§7.1）
17. As a 开发者，我希望聚合层只消费规范化事件（`session/update` 语义），不再维护文档明令禁止的 `agent_message_chunk` 解析路径（§6.2）
18. As a 开发者，我希望 Turn 状态机显式建模且终态不可逆，恢复执行必须创建新 turn，不能把已终止 turn 改回 running（§8.1）
19. As a 开发者，我希望 `commandId` 去重表覆盖客户端最大重试窗口，重复 Action 返回原 Ack 而不重复调用 Agent（§7.1）
20. As a 开发者，我希望权限解析是 CAS 原子操作，重复 `permission_response` 只有第一次生效（§7.1）
21. As a 运维人员，当 Instance ACP session 断链或实例回收时，我希望服务端删除该 `rcsSessionId` 的 Chat Doc、Session Doc、relay handle、广播订阅与热缓存，丢弃所有晚到 ACP 消息（§6.5）
22. As a 运维人员，当服务节点崩溃时，我希望客户端重连后能重新连接仍存活的 Agent 会话并同步其当前 Doc；无法连接时清理实时状态，不伪造完成（失败矩阵）
23. As a 运维人员，我希望日志与 trace 统一携带 `traceId` / `organizationId` / `sessionId` / `rcsSessionId` / `turnId` / `commandId` / `instanceId` / `acpSessionId` / `connectionId`，正文与敏感参数不进入 span attribute（§12）
24. As a 安全管理员，我希望 WebSocket upgrade 和每个 Action 都绑定认证会话，授权条件至少包含 `organizationId + userId + sessionId`，长连接期间权限撤销可生效，错误响应只含脱敏 `PublicError`（§10）
25. As a 测试维护者，我希望协议层测试用假连接对象即可验证 Action → Ack → Y.Doc 投影的完整链路，不需要真实 WS 服务器或 Agent 进程（Testing Decisions）

## Implementation Decisions

### 包结构（Q1/Q1b/Q2/Q2b/Q11/Q14）

`packages/chat-channel`（新大包，合并原 `acp-server` 包）：

```
packages/chat-channel/src/
├── channel/      # 控制面（新写）：gateway、session-channel、command-coordinator、lease-manager（占位）
├── protocol/     # 原样迁入 + 扩展：translator、extractJsonRpc、私有帧规范化（含原 relay-handler 兼容层）
├── state/        # 原样迁入 + 重构：aggregator、doc-manager、chat-writer、factory、yjs-store
├── persist/      # 原样迁入：redis provider
├── types/        # ACPEvent、Doc schema、Action/Ack 协议类型（原 types.ts + 新增）
└── index.ts      # 稳定导出：原 acp-server 导出面 + 新增控制面导出 + 前端所需类型
```

- 原 `acp-server` 包**删除**，全部引用（`src/`、`web/`、`packages/`、`src/__tests__/`、文档，约 15-20 处）一次性迁移到 `@fenix/chat-channel`，不留兼容壳。
- `web/src/acp/` 目录整体删除（`client.ts` / `index.ts` 为死代码、`types.ts` 由包导出替代），11 个组件 import 直接改为 `@fenix/chat-channel`。
- 宿主依赖注入复制编排域模式：包内定义 `ChatChannelDependencies` 接口（环境解析、workspace 注入、实例生命周期、relay 发送、Redis 存储、日志），`src/services/chat-channel-bootstrap.ts` 装配单例（`getChatChannelController()` + `resetChatChannelBootstrap()` 供测试）；`yjs-frontend` 对 `environmentRepo` / `resolveWorkspacePath` / `acp-idle-monitor` / `cache` 的直接 import 全部收敛到桥接层。
- 测试放包内：`packages/chat-channel/src/**/*.test.ts`（与编排域同款，`package.json` 配 `"test": "bun test"`）。

### 模块边界（ChatChannelController 域）

| 模块 | 职责（文档 2.3） | 现有对应物 | 处理 |
|---|---|---|---|
| `Yjs Gateway` | 认证、连接限流、协议解码、心跳与背压 | `src/transport/relay/yjs-frontend/ws-lifecycle.ts` + `connection-registry.ts` | 语义原样迁入 `channel/`，结构重组 |
| `SessionChannel` | 连接绑定至安全上下文与会话频道，路由 Action/Update | `yjs-frontend/index.ts`（松散） | **新建收敛点**，协议层测试 seam |
| `CommandCoordinator` | Action 校验、`commandId` 幂等、会话状态机、命令串行化 | `session-transition.ts` / `relay-event-handler.ts`（散落） | **新建**，聚合现有 action 处理 |
| `ACPChannel` | ACP command/event 适配、超时、取消、私有帧规范化 | `forwardYjsAction` + relay 直连 + `extractAcpEvent` | **新建**，含 `extractJsonRpc()` 双格式兼容 |
| `EventAggregator` | ACP 增量聚合为稳定领域事件，节流 token | `packages/acp-server/src/state/aggregator.ts` | **重构**，只消费规范化事件 |
| `DocManager` | Instance ACP session 实时 Y.Doc 镜像、生成 update | `packages/acp-server/src/state/doc-manager.ts` | **重构**，schema 对齐文档 5.2/5.3 |
| `YjsBroadcaster` | 本节点 fan-out、慢消费者隔离 | `yjs-frontend/yjs-broadcaster.ts` | 保留并强化背压语义 |
| `SessionLeaseManager` | 租约获取、续期、释放与 fencing token | 无 | **仅类型占位**（Q5：不实现，`leaseEpoch` 字段保留在协议类型中，运行时恒为固定值） |

### Action / Ack 协议契约（文档 7.1 修订，Q5/Q9）

```ts
interface ClientAction<TType extends string, TPayload> {
  commandId: string;              // 幂等键，同会话唯一（前端生成 UUID，Q9）
  type: TType;
  sessionId: string;
  payload: TPayload;
}
// protocolVersion / expectedProjectionVersion / client 信封字段由服务端按会话绑定补充与校验，
// 前端不感知（乐观并发增强留二期）；协议类型中保留这些字段定义。
```

```ts
interface ActionAck {
  type: "action_ack";
  commandId: string;
  status: "accepted" | "committed" | "duplicate";
  turnId?: string;
  committedProjectionVersion?: number;
}

interface ActionError {
  type: "action_error";
  commandId: string;
  code: "UNAUTHENTICATED" | "FORBIDDEN" | "SESSION_NOT_FOUND" | "VERSION_CONFLICT"
      | "INVALID_STATE" | "RATE_LIMITED" | "AGENT_UNAVAILABLE" | "PAYLOAD_TOO_LARGE";
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}
```

- `accepted` 仅表示进入有界队列，`committed` 表示业务事实已提交；客户端超时后可用相同 `commandId` 重发，不得换 ID 猜测结果。
- `commandId` 去重表（Q5 保留项）覆盖客户端最大重试窗口，已提交命令返回原 Ack，不重复调用 Agent。

### Y.Doc schema（文档 5.2/5.3，Q4 一次性切换）

- **纠正 Doc 职责错位**：Chat Doc `chat:{rcsSessionId}` = 消息时间线（高频），Session Doc `session:{rcsSessionId}` = 会话元信息 / Agent 状态（低频）。
- Chat Doc：根对象 `schemaVersion` / `projectionVersion` / `entryOrder: Y.Array<string>` / `entries: Y.Map<ChatEntry>`；Entry 含 `kind`（message/tool/system）、`role`、`status`（pending/streaming/completed/cancelled/error）、`turnId`、`blockOrder`、`blocks`；ContentBlock 为 text/reasoning/tool_call/resource 联合类型。
- Session Doc：`schemaVersion` / `projectionVersion` / `session`（sessionId/title/status/environmentId/agentConfigId/activeTurnId）、`agent`（instanceId/acpSessionId/status/capabilities/lastActivityAt/publicError）、`pendingPermissions`（Q8）。
- 物理映射：根对象、entries、blocks 用 `Y.Map`；顺序索引用 `Y.Array<string>`；流式文本用 `Y.Text`（避免逐 token 替换）；大二进制/超大工具结果只保存受授权资源引用。
- 删除采用领域 tombstone，不由客户端物理删除权威记录。
- `organizationId`、完整授权规则、密钥、内部错误、原始凭证、机器连接信息不得进入 Y.Doc。
- **无兼容窗口**：前后端同仓库同步发版，旧 Y.Doc 结构不迁移（实时镜像，非持久资产）；旧 `agentInfo` / `sessions` / `chatMeta` / `connection` / `permissions` / `capabilities` / `modelState` / `modeState` / `availableCommands` / `tokenUsage` / `messages` / `streaming` / `tools` / `artifacts` / `structuredMessages` 字段全部删除。

### ACP 聚合边界（文档 6.2/6.3 修订，Q6）

- **主服务侧翻译**：`ACPChannel`（基于 `extractAcpEvent` 扩展）把 acp-link 私有帧（`agent_message_chunk` / `agent_thought_chunk` / `prompt_complete` 等）翻译为规范化事件（`session/update` 语义：增量、内容块、终态）；聚合层只消费规范化事件。
- 事件类型从规范化事件的 `sessionUpdate` 字段读取，文本内容位于同一 `update.content`；**删除** `agent_message_chunk` / `agent_thought_chunk` 等旧事件消费路径。
- `acpSessionId` 只能在服务端维护的、当前 Instance ACP session 的 binding 中反查 `rcsSessionId`；浏览器提供的字段不能覆盖 binding。
- 映射幂等：以 `turnId` / `entryId` / `toolCallId` / `permissionId` 与终态状态机确定写入目标，重放同一 ACP 帧不重复创建 Entry/工具调用/权限请求。
- 每 `rcsSessionId` 独立有界缓冲区，绝不混批；控制类更新（工具状态、权限、status、错误、turn 终态、断链）先 flush 内容批次再立即写入。

### 并发控制（Q5 决策）

- **不实现**事件日志体系（`eventSeq` 不显式建模）与租约（`SessionLeaseManager` 仅类型占位）：YJS CRDT 已保证文档并发写收敛，单实例部署进程内天然单写；防重复副作用由 `commandId` 去重表承担。
- 保留 `commandId` 去重表（每 `rcsSessionId` 进程内 Map，随实例生命周期释放）；`leaseEpoch` 字段在协议类型中占位，运行时恒为固定值。

### Turn 状态机（文档 8.1，Q7）

```
accepting → running → awaiting_permission → running | cancelled
running → cancelling → cancelled | interrupted
running → completed | failed | interrupted
```

- 终态不可逆；恢复执行必须创建显式的新 turn，不能把已终止 turn 改回 running。
- Session Doc 的 `session.activeTurn`（`turnId` + `turnStatus` + 时间戳）为权威；**删除**现有会话级扁平 `status` 枚举，前端由 `activeTurn.turnStatus` 派生展示状态（accepting→思考中、awaiting_permission→等待授权、running→回复中/工具执行中…）。
- `interrupted` 迁移边由"连接丢失 / 取消超时"触发（不依赖租约，Q5）。
- 默认每会话仅一个活动 turn；并行 turn 需先引入独立 branch/thread 聚合，本次不放开约束。

### 权限 CAS（文档 7.1，Q8）

- `pendingPermissions` 迁入 Session Doc（与 `activeTurn` 关联），现有 Chat Doc `permissions[]` 删除。
- 解析走 CAS：仅 `pending → resolved` 原子迁移一次，迁移成功后才向 Agent 发 `permission.resolve`；重复 `permission_response` 只有第一次生效。
- 权限请求附带超时 / 会话切换 / 断链时的终态迁移规则。

### 两类断链语义（文档 8.2）

| 断链对象 | 处理 |
|---|---|
| 前端 WebSocket / relay 断开 | 仅释放连接级资源；Agent 会话存活时重连后同步当前实时 Y.Doc |
| Instance ACP session 断链或实例回收 | 删除该 `rcsSessionId` 的 Chat Doc、Session Doc、relay handle、广播订阅与热缓存；新实例创建新的实时投影，不加载旧 Y.Doc |

### 连接生命周期（Q13）

- `ws-lifecycle`（487 行）语义**原样迁移**、结构重组：YJS sync 握手时序、断线重连、64 KB 背压、`YJS_MAX_CLIENTS` 200 配额、rpcId 管理按职责拆入 `channel/`（gateway / command-coordinator / broadcaster），**不重写时序**。
- 与 19 号文档 10 节的差异记录为二期优化项，不阻塞本次重构。

### 与编排域的衔接

- `ensureRunning(environmentId, agentConfigId)` 由已完成的 `packages/orchestration` 提供；CommandCoordinator 在 `load_session` / 首次需要 Agent 的 Action 时调用，先复用可复用实例，仅创建新实例时检查并发配额（场景 K）。
- 实例生命周期遵循 20 号文档：`spawnInstanceViaController` 创建独立实例并负责销毁；`acpSessionId` 由服务端 translator 注入 `cwd`，浏览器不可覆盖。

### 旧代码迁移映射

| 新归属 | 来源代码 |
|---|---|
| `packages/chat-channel/`（整体） | `packages/acp-server/`（protocol / state / persist / types / index 全量迁入） |
| `channel/gateway` + `channel/session-channel` + `channel/command-coordinator` | `src/transport/relay/yjs-frontend/`（index、ws-lifecycle、session-transition、relay-event-handler、connection-registry） |
| `channel/command-coordinator`（commandId 去重） | `src/transport/relay/yjs-frontend/`（action 处理）+ 新写去重表 |
| `protocol/`（私有帧规范化） | `src/transport/relay/relay-handler.ts` 的 `extractAcpEvent` / `extractJsonRpc` 迁入 |
| `src/services/chat-channel-bootstrap.ts`（新写） | 编排域 `orchestration-bootstrap.ts` 模式 |
| 删除 | `src/transport/relay/yjs-frontend/`、`src/transport/relay/yjs-frontend.ts` facade、`packages/acp-server/`、`web/src/acp/` |
| 引用迁移（import 包名） | `src/routes/acp/index.ts`、`src/services/agent-chat-service.ts`、`src/services/workflow/agent-chat-transport.ts`、`src/services/orchestration-instance.ts`、`src/__tests__/`、`web/` 组件 |

### 兼容与演进

- 与 `agent-chat-service.ts`（HTTP 单轮）保持既有边界：本次重构不改变 HTTP 路径的对外契约，仅迁移 import 并复用 `ensureRunning` 与既有实例策略。
- `YJS_MAX_CLIENTS` 连接上限与 64 KB 背压阈值保留（CLAUDE.md 不变量）。
- 前端仅新增 `commandId` 字段（Q9）；`expectedProjectionVersion` 乐观并发增强、19 号文档 10 节连接时序对齐为二期迭代。

## Testing Decisions

### 测试 seam：SessionChannel 协议层（Q12，用户已确认）

以 **SessionChannel 协议层**为最高 seam：包内集成测试直接实例化 `ChatChannelController`（注入 fake 依赖：假 relay、假环境解析、内存 Redis 桩），"WebSocket 客户端"实现为测试内构造的假连接对象（实现 Gateway 的连接接口），发送 Action，断言 `action_ack` / `action_error` 与 `yjs:update` 投影结果。**无真实网络、无真实 Agent 进程**（与编排域测试同款模式）。

### 优秀测试的标准

- 只测试外部可观察行为：Action 的 Ack/Error、Y.Doc 投影内容、状态迁移结果；不测试内部调用顺序与实现细节。
- 每个核心不变量至少一个正向 + 一个反向用例：`commandId` 幂等重放、版本冲突、权限 CAS、Turn 状态机迁移、两类断链、背压。
- 每个 `test()` 上方添加一行中文注释说明行为和业务意图（项目规范）。

### 测试模块与先例

| 测试文件（包内） | 覆盖范围 | 已有先例 |
|---|---|---|
| `session-channel-action.test.ts`（协议层） | Action → Ack → 投影全链路、`commandId` 去重、版本冲突、错误码 | `src/__tests__/yjs-frontend-forward-action.test.ts`（提升到协议层） |
| `command-coordinator-state.test.ts` | Turn 状态机全转换、终态不可逆、单活动 turn | `src/__tests__/yjs-frontend-session-transition.test.ts` |
| `command-id-dedup.test.ts` | 去重表覆盖重试窗口、重复 Action 返回原 Ack、不重复调 Agent | 新写 |
| `permission-cas.test.ts` | 权限 CAS 原子迁移、重复响应仅第一次生效、超时/切换终态 | `src/__tests__/extract-acp-event.test.ts`（参照） |
| `acp-aggregator-mapping.test.ts` | 规范化事件映射幂等、重放不重复、禁止旧事件类型 | `src/__tests__/extract-acp-event.test.ts` |
| `doc-schema.test.ts` | Chat/Session Doc 新 schema 结构、`projectionVersion` 演进、tombstone 删除 | `packages/acp-server/src/__tests__/`（如有） |
| 既有回归 | `yjs-frontend-lifecycle` / `broadcaster` / `connection-registry` 测试迁移到包内并更新以匹配新 schema | 现有 `src/__tests__/yjs-frontend-*.test.ts` |

## Out of Scope

以下**明确不在**本次重构范围内：

- ❌ 事件日志体系与租约实现（Q5：`leaseEpoch` 仅类型占位；防重复副作用由 `commandId` 去重承担）
- ❌ 跨节点 Redis 租约 / 事件日志持久化（现有降级路径保留，多节点部署二期）
- ❌ 并行 turn / branch-thread 模型（文档 8.2 明确不放开）
- ❌ 前端 UI 改动（ChatView / EntryRenderer 视觉与交互；前端仅适配协议、schema 与类型 import）
- ❌ `expectedProjectionVersion` 前端乐观并发增强（服务端校验本次落地，前端冲突重试 UI 二期）
- ❌ 19 号文档 10 节连接时序对齐（Q13：语义原样迁移，差异记二期）
- ❌ HTTP / Workflow 路径的对外契约变更（`agent-chat-service.ts` 行为保持不变，仅迁移 import）
- ❌ ACP 协议规范本身与 acp-link 侧改造（Q6：acp-link 与 Agent 部署零改动）
- ❌ 编排域重构（已完成，见 20 号文档）
- ❌ 权限策略引擎 / 工具执行语义

## Further Notes

### 验收标准

1. `packages/chat-channel` 建成，原 `packages/acp-server` 删除；全部引用迁移到新包名，`bun run check:deps` 无残留
2. 包内协议层测试（SessionChannel seam）全绿，覆盖 `commandId` 去重、版本冲突、权限 CAS、Turn 状态机、两类断链
3. 现有 `src/__tests__/yjs-frontend-*.test.ts` 等测试迁移到包内并全绿
4. `bun run precheck` 全绿（含后端测试）
5. `bun run build:web` 通过（前端新 schema + 类型 import 迁移后）
6. `docs/arch/19-yjs-chat-streaming.md` 升级为"实现基线"：删除与代码冲突的表述（`agent_message_chunk` 禁令落实、6.2 修订为规范化事件、7.1 修订前端信封、5.4 双读窗口删除、10 节差异标注二期）
7. `agent-chat-service` 对外行为无回归（现有 `agent-chat-service-concurrency.test.ts` 等保持全绿）

### 与现有文档的联动

- `docs/arch/19-yjs-chat-streaming.md` 是本次重构的目标架构基线，重构完成后升级为"实现基线"
- `docs/arch/20-orchestration-management.md` 提供 `ensureRunning` / 实例生命周期依赖
- `docs/arch/changes.md` 需同步新增本次改动记录
- `spec/global/adr/2026-08-04-chat-channel-package-design.md` 记录包设计与评审决策（grill-with-docs 输出）
- `spec/global/CONTEXT.md` 领域词汇需更新 Chat 域术语（Turn、SessionChannel、Action/Ack、commandId、pendingPermissions）

### 风险提示

- `src/transport/relay/yjs-frontend/` 与 `relay-handler.ts` 是 YJS 与实例连接的耦合点，迁移时需确保实例生命周期（20 号文档已完成）不受影响；`extractAcpEvent` / `extractJsonRpc` 迁入包内时保持双格式兼容
- 包合并是一次性破坏性变更：所有原 `acp-server` 引用（含测试、文档、web 组件）必须同批迁移，禁止部分迁移造成双包并存
- 前端 schema 消费点（2 个 hook + `structured-to-thread.ts`）与后端投影必须同批切换（Q4 无兼容窗口），发布顺序：后端先行、前端同批构建
- `agent-chat-service` 与 workflow 路径复用 `ensureRunning` / translator，包改名迁移时不得误改其行为
