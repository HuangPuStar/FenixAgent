# 领域模型改动清单

> 记录领域模型设计改进项，每项标注状态和影响范围

## 改动 1：Environment 定位重新定义

**状态**：✅ 已确认，待实施

**现状**：Environment 被描述为"Agent 工作空间"，定位模糊，实际承担了过多隐含职责。

**目标**：Environment 是一个**资源管理层**，职责包括：
- 调度 Agent Instance 的生命周期（spawn / stop / autoStart）
- 根据 AgentConfig 拉取 Skill
- 同步 MCP 服务器配置到 workspace
- 同步 Knowledge 绑定到 workspace（注入 MCP knowledge 端点）

**影响**：
- 领域文档更新（已完成）
- 无代码改动（代码行为已经是这样，只是文档描述不准确）

---

## 改动 2：Environment 引用 AgentConfig 改为 ID 强绑定

**状态**：✅ 已确认，待实施

**现状**：Environment 通过字符串名称匹配 AgentConfig。AgentConfig 改名会导致 Environment 找不到配置，属于脆弱的松耦合。

**目标**：Environment 通过 AgentConfig 的 UUID 强绑定，而非字符串名称。

**影响**：
- 数据库：environment 表新增 agentConfigId 列（UUID 外键），agentName 列保留过渡期后移除
- Instance 服务：spawn 时根据 agentConfigId 获取 AgentConfig，不再靠名称匹配
- Environment 路由：创建/更新时接受 agentConfigId 而非 agentName
- 配置服务：AgentConfig 改名不再影响 Environment
- 前端：Environment 表单中的 AgentConfig 选择器改为 ID 选择器
- 领域图：实线强关联替代虚线松耦合

---

## 改动 3：Session 下沉到 Agent 进程，RCS 完全透传

**状态**：✅ 已确认，待实施

**现状**：Session 是 RCS 的一等公民，有独立的 DB 表、仓储、路由、Service 层。RCS 存储 Session 元数据并管理其生命周期。

**目标**：Session 由 Agent 进程（acp-link）管理，RCS 不存储、不管理。前端通过 ACP 通道直接与 Agent 进程交互获取 Session 信息，RCS 只做消息透传。

**影响**（已完成）：
- 数据库：agent_session 表已废弃
- 仓储层：Session 仓储已移除
- Session 服务：已移除大部分逻辑
- Session 路由：改为 ACP 透传代理
- Instance 服务：不再创建/查找 Session
- 传输层：relay 的 sessionId 参数为前端与 Agent 协商的标识
- 前端：Session 列表从 ACP 协议获取，不再调 RCS API
- 领域图：Session 从 RCS 领域模型中移除，标记为"acp-link 内部概念"

**文件系统**：当前按 Session 组织的文件系统需改为按 Environment 维度组织。

---

## 改动 4：Instance spawn 决策权统一到 Environment

**状态**：✅ 已实施

**现状**：Instance spawn 由三种触发者各自直接调用——用户手动、autoStart、IMChannel。触发者分散在不同模块，缺乏统一的 spawn 决策入口。

**目标**：Environment 作为资源管理层，统一管理 Instance 的 spawn 决策。所有触发者不直接 spawn，而是向 Environment 发出"需要运行"的请求，Environment 根据策略决定（是否已有运行中实例、autoStart 配置、并发上限、端口资源）。

**影响**：
- Instance 服务：spawn 决策逻辑统一到 Environment 层，提供 ensureRunning 接口
- IM 通道客户端：消息路由时不再自己找 Instance，改为请求 Environment 确保实例运行
- Environment 路由：统一的"启动并连接"入口
- 领域图：触发者 → Environment → Instance 的层次关系更清晰

---

## 改动 5：KnowledgeBase 和 Skill 的关联路径明确化

**状态**：✅ 已确认，待实施

**现状**：
- KnowledgeBase 通过 agent_knowledge_binding 表绑定到 AgentConfig，Environment 在 spawn 时注入 MCP knowledge 端点到 workspace 配置
- Skill 元数据存在 DB，内容存在文件系统，Environment spawn 时不做特殊处理

**目标**：两条关联路径明确：
- **KnowledgeBase → MCP → AgentConfig**：KB 通过 MCP 协议与 AgentConfig 关联，Agent 运行时通过 MCP 端点查询知识库。Environment 不负责装配，只在 spawn 时把 AgentConfig 中配置的 MCP 服务器（包括 KB 的 MCP 端点）写入 workspace
- **Skill → AgentConfig**：Skill 直接绑定到 AgentConfig（不是 Environment），Agent 进程根据 AgentConfig 自己读取 Skill 内容

**影响**：
- 领域图：KB 和 Skill 都直接连线到 AgentConfig，不再经过 Environment 中转
- Instance 服务：spawn 逻辑简化，只需把 AgentConfig 的完整配置（包括 MCP 和 Skill 引用）写入 workspace
- Environment 的职责进一步聚焦：调度 Instance 生命周期 + 传递 AgentConfig ID

---

## 改动 6：ScheduledTask 简化为 HTTP Cron 触发器

**状态**：✅ 已确认，待实施

**现状**：ScheduledTask 是一个复杂的领域概念，绑定 Environment，包含任务描述文本，执行时需要找 Instance 或 spawn 临时进程。内部有 AgentTaskRunner 负责构造 prompt 并发送给 Agent。

**目标**：ScheduledTask 简化为纯粹的 **HTTP cron 触发器**——定时调一个 URL。Task 不绑定 Environment、不包含任务描述、不知道 AgentConfig。URL 里封装了执行逻辑（后续由 Workflow 系统提供便捷的 URL 生成方式，预置 Environment 和 AgentConfig）。

**影响**：
- 数据库：scheduled_task 表简化，移除 environmentId、任务描述、超时等字段，改为 url、method、headers、body
- 任务服务：大幅简化，执行逻辑变为 HTTP 请求调用
- AgentTaskRunner：移除（不再需要）
- 调度引擎：简化为触发 HTTP 请求
- 任务路由：CRUD 接口简化
- 领域图：Task 大幅简化，不再关联 Environment 或 AgentConfig
- **后续**：Workflow 系统提供 URL 编排能力，Task 作为 Workflow 的触发入口

---

## 改动 12：acp-link 概念收缩，@fenix/core 是真正的 runtime 调度层

**状态**：📝 设计已确认

**现状**：`acp-link` 概念被严重放大——
- `packages/acp-link` 从"ACP stdio↔WebSocket 桥接器"膨胀为包含 `InstanceManager`、`SessionManager`、`AcpDispatcher`、三种 `EngineHandler` 的运行时框架
- `@fenix/core` 的 `CoreRuntime` 和 `acp-link` 的 `InstanceManager` 功能重叠，都在做 engine plugin 调度
- `AcpLinkProcessManager` 命名误导：代码注释自己承认"直接启动 WS 服务器，不再 spawn 子进程"，不管进程却叫 ProcessManager
- 文档/注释中 `acp-link` 被当作通用 Agent 进程代名词
- `acp-link` 版本碎片化：workspace 内 v2.0.0，`@fenix/ccb`/`@fenix/opencode` 引用 npm 版 v1.1.0，Dockerfile 又全局安装 npm 版

**目标**：

```
@fenix/core (概念上的"link")
    ← 负责连接 ACP Agent 引擎与 RCS 平台
    ← 注册 engine plugin、管理 instance 生命周期、管理 relay 通道
    ← 命名已正确，职责需从 acp-link 包收回

packages/acp-link (纯传输层)
    ← createAcpServer() — stdio↔WS 桥接器
    ← ACPClient / ACPProtocol — 协议解析、类型定义
    ← 不应包含 InstanceManager / SessionManager / EngineHandler
```

**影响**：
- `packages/acp-link`：`InstanceManager`、`SessionManager`、`AcpDispatcher`、三种 `EngineHandler` 迁移到 `@fenix/core`
- `AcpLinkProcessManager` → 重命名（如 `EngineLifecycleManager` 或直接合并到 `@fenix/core`）
- 统一 `acp-link` 版本引用为 `workspace:*`
- 文档全局：`acp-link 注册` → `machine 注册`，`Agent (acp-link)` → `Agent 进程`
- `@fenix/core` 的 `core-bootstrap.ts`：废除 `createOpencodePlugin` 等直接依赖 `acp-link` 的旧路径

---

## 改动 7：Workflow 独立领域模块

**状态**：✅ 已确认，待实施

**定位**：Workflow 是 RCS 的独立领域模块，负责编排 Agent 的多步执行流程。

**关键关系**：
- Workflow 是独立模块，归 Team 所有
- Workflow 通过 Environment 操作 Agent（不直接接触 Instance 或 acp-link）
- Workflow 提供 URL 入口，ScheduledTask 通过 HTTP 调用 Workflow URL 来定时触发
- Workflow 封装了 Environment 和 AgentConfig 的便捷调用方式，ScheduledTask 不需要知道 Agent 的存在

**当前状态**：已有反向代理到外部 Workflow 引擎的机制，核心 Workflow 领域模型待设计实现。

---

## 改动 8：IMChannel 升级为用户资源

**状态**：✅ 已确认，待实施

**现状**：
- ChannelBinding 是一个独立的路由规则表（platform + chatId → agentId）
- Hermes 是外部网关，HermesClient 是 RCS 内部的 WS 客户端
- 两者在代码里分离，用户需要理解"路由规则"和"网关连接"两个概念

**目标**：IMChannel 升级为用户界面上的一等资源。用户创建一个 IMChannel，选择连接方式（飞书/Telegram/Discord 等），配置连接凭证和路由规则（哪个群 → 哪个 Agent），查看连接状态。用户不需要感知 Hermes 的存在。

IMChannel 包含：
- **连接方式**：选择平台 + 填写凭证（如飞书 App ID/Secret）
- **路由规则**：聊天群 → Agent（Environment）的映射
- **运行时状态**：已连接 / 未连接 / 错误

**影响**：
- 数据库：可能需要新建 im_channel 表，或重构 channel_binding 表
- 前端路由：升级为 IMChannel 的完整 CRUD + 连接管理
- 通道绑定服务：逻辑融入 IMChannel 服务
- Hermes 客户端：成为 IMChannel 的底层传输实现，用户不直接接触
- 领域图：IMChannel 是一等资源，连线到 Environment（路由目标）
- 前端：IMChannel 管理界面（选择平台、配置凭证、设置路由规则）

---

## 改动 9：RCS 是配置的单一权威来源，运行时注入

**状态**：✅ 已确认，待实施

**现状**：Provider、Model、AgentConfig、Skill、McpServer 等配置由 RCS 管理在 PostgreSQL 中，Instance spawn 时部分配置会写入 workspace 的运行时配置文件，但注入不完整（只有 default_agent 和 KB MCP 端点）。

**目标**：RCS 是所有配置资源的**单一权威来源**。Agent 进程不持有配置，每次由 Environment 在 Instance spawn 时完整注入：Provider/Model、Skill、MCP 服务器、KnowledgeBase 绑定、Permission 规则等。Agent workspace 里的配置文件是注入产物，不是用户直接编辑的对象。

**影响**：
- Instance 服务：spawn 时的注入逻辑需要扩展，覆盖所有配置维度
- 配置服务：可能需要新增批量读取接口（一次性获取 AgentConfig + 关联的 Skill + MCP + KB）
- workspace 配置文件变为 RCS 自动生成的只读文件
- 用户直接编辑 workspace 配置文件的行为被 RCS 注入覆盖

---

## 改动 10：Model 合并进 Provider，Skill/McpServer/Provider 定位为独立资源

**状态**：✅ 已确认，待实施

**现状**：Model 作为独立领域概念存在（有独立的 DB 表，独立的节点在领域图中）。Skill、McpServer、Provider 虽然是独立资源，但在领域图中被画在 AgentConfig 的子图内，视觉上像是 AgentConfig 的"组成部分"。

**目标**：
- **Model 合并到 Provider 内部**：Model 不再作为独立领域概念出现，而是 Provider 的子属性（Provider 包含多个 Model）。AgentConfig 的 model 字段引用的是 Provider 下的某个 Model ID
- **Skill、McpServer、Provider 是独立资源**：它们和 AgentConfig 只有引用关系，不是聚合/包含关系。在领域图中应与 AgentConfig 处于同一层级，用"引用"箭头连线

**影响**：
- 数据库：model 表保留（数据层面不变），但上层领域概念中 Model 不再独立
- 领域图：移除 Model 独立节点，Provider 节点内标注"包含 Model"
- 领域图：Skill、McpServer、Provider 与 AgentConfig 的连线改为"引用"（虚线或标注）
- 概念卡片：Provider/Model 合并为一张卡片，说明 Provider 包含 Model
- 配置服务：Model 的 CRUD 逻辑保持不变（Provider 的子资源管理）
- 前端：Model 管理入口放在 Provider 详情页内，不再有独立的 Model 列表页

---

## 改动 11：Team 取代 User 成为资源所有者

**状态**：✅ 已确认，待实施

**现状**：User 是所有资源的所有者，每条记录带 userId，查询按用户隔离。

**目标**：Team 成为资源的所有权单位，User 通过 Team 成员身份获得资源访问权。领域模型中 User 退化为"Team 的成员"，不再是资源的直接所有者。

- 所有资源（Environment、AgentConfig、Provider、Skill、McpServer、KnowledgeBase、IMChannel、ScheduledTask、API Key）归 Team 所有
- User 通过 Team 成员身份（owner / admin / member）使用资源
- 团队内资源共享可见，角色决定写权限（member 只能改自己的，admin 都能改）
- 新用户注册后创建"个人团队"，或加入已有团队

**影响**：
- 领域图：User 节点退化为 Team 的子概念，资源所有权从 User → Team
- 数据库：所有资源表 userId 列改为 teamId（或新增 teamId，过渡期兼容）
- 配置服务：查询条件从按用户隔离改为按团队隔离
- 认证层：session 存 activeTeamId，支持切换团队
- 路由层：handler 使用 teamId 替代 userId
- 前端：团队管理 UI、团队切换、资源列表按团队过滤

---

## 改动 13：前端 WS 通道从 Relay+YJS 双通道收拢为单 /acp/yjs 通道

**状态**：✅ 已实施

**现状**：

设计文档（`docs/design/acp-workflow-tech-stack.md`）和部分架构文档（`docs/arch/05-chat.md`、`docs/arch/tech-stack-frontend.md`）仍然描述前端使用两条并行 WS 通道：

| 通道 | 端点 | 职责 |
|---|---|---|
| Relay 路径 | `/acp/relay/:agentId` | ACPClient 通过 WebSocket 传输 ACP JSON-RPC 协议 |
| YJS 路径 | `/acp/yjs/:agentId` | 轻量 WS → Yjs CRDT 增量同步 |

**实际上，架构已演进为单条 `/acp/yjs/{agentId}` WS 统一通道**：

- 前端唯一 WS 连接在 `ChatPanel` 中通过 `buildYjsUrl()` + `createYjsWs()` 创建（`web/src/pages/agent-panel/ChatPanel.tsx:120`），连接 `/acp/yjs/{agentId}`
- `createRelayClient()` 和 `buildRelayUrl()`（`web/src/acp/relay-client.ts`）已无前端调用点，属于死代码
- `/acp/relay/:agentId` 路由定义仍在 `src/routes/acp/index.ts:175`，但前端不再连接
- `yjs:update` 消息由 `YjsBroadcaster`（`src/transport/relay/yjs-frontend/yjs-broadcaster.ts:83`）通过 `/acp/yjs/` 连接池广播
- relay WS 的 `shouldForwardToFrontend` 明确过滤 `yjs:update`（`src/transport/relay/relay-handler.ts:41`）

**目标**：文档和代码保持一致。删除过时的双通道描述，清理死代码。

**影响**：

#### 前端 🗑️ 死代码

| 文件 | 内容 |
|---|---|
| `web/src/acp/relay-client.ts` | `buildRelayUrl`、`createRelayClient`（无调用点） |
| `web/src/acp/index.ts` | `relay-client` 的 re-export |

#### 后端 🗑️ 死代码（可安全删除）

| 文件/位置 | 内容 |
|---|---|
| `routes/acp/index.ts:176-257` | `/acp/relay/:agentId` 路由定义 |
| `schemas/acp.schema.ts:26-30` | `AcpRelayQuerySchema` |
| `transport/relay/connection-manager.ts` | **整个文件** (`RelayConnectionManager` + `sendToRelayWs`) |
| `transport/relay/message-router.ts` | **整个文件** (5 个函数，生产代码零调用) |
| `relay-handler.ts:39-46` | `shouldForwardToFrontend` |
| `relay-handler.ts:49` | `pendingRelayMessages` Map |
| `relay-handler.ts:127-180` | `translateSimpleAction` 副本（`@fenix/chat-channel` 已有替代实现） |
| `relay-handler.ts:186-242` | `trySyncSessionsToYjs` |
| `relay-handler.ts:249-490` | `handleRelayOpen` + `openLocalRelay` |
| `relay-handler.ts:493-591` | `handleRelayMessage` |
| `relay-handler.ts:594-634` | `handleRelayClose` |
| `types/store.ts:47-78` | `RelayConnectionEntry` + `ManagedConnection` 类型定义 |
| `__tests__/relay-connection-manager.test.ts` | 关联测试文件 |
| `__tests__/relay-message-router.test.ts` | 关联测试文件 |
| `__tests__/relay-handler-machine.test.ts` | 关联测试文件 |
| `transport/relay/index.ts` | 清理死代码导出 |

#### 后端 ⚠️ 冗余（仍有调用但实际无消费者，运行期空操作）

| 调用点 | 原因 |
|---|---|
| `relay-handler.ts:806-827` `docManager.setBroadcastHandler` | 向空的 `RelayConnectionManager` 广播 yjs:update，每次 Y.Doc update 产生无意义的 base64 序列化开销 |
| `closeRelayConnectionsForIdleReclaim` | `acp-idle-monitor.ts` 调用 → 遍历空 `RelayConnectionManager` |
| `closeAllRelayConnections` | graceful shutdown 调用 → 同上 |
| `handleMachineDisconnected` | `acp-ws-handler.ts` 调用 → 同上 |
| `handleMachineReconnect` | 同上 |

> 💡 冗余函数需迁移到 yjs-frontend 的 `ConnectionRegistry` 实现等效功能。

#### 后端 ✅ 需保留（yjs-frontend 复用或机器侧 relay）

| 函数 | 复用方 |
|---|---|
| `extractJsonRpc` | `yjs-frontend/relay-event-handler.ts` |
| `extractAcpEvent` | `yjs-frontend/relay-event-handler.ts` |
| `AcpRelayParamsSchema` | `/acp/yjs/:agentId` 路由 |
| `sendToAgentWs`、`sendToInstanceRelay`、`closeInstanceRelay` 等 | `hermes-client.ts`（机器侧） |

#### 文档更新

- `docs/design/acp-workflow-tech-stack.md` — ✅ 已更新为单 `/acp/yjs` 通道描述
- `docs/arch/05-chat.md` — 第 117-163 行更新 relay-client 相关描述
- `docs/arch/tech-stack-frontend.md` — 第 102-106 行更新前端连接描述
- `docs/arch/tech-stack-overview.md` — 移除 `/acp/relay` 相关连线
- `docs/developer/arch/*` — 同步更新 `/acp/relay` 引用

---

## 改动 14：Chat 域独立包 chat-channel（合并 acp-server）

**状态**：✅ 已实施（C1 切片，prefactor）

**现状**：Chat 域逻辑横跨 `packages/acp-server`（protocol / state / persist / transport / util）与 `src/transport/relay/yjs-frontend/`，包名与目标架构（`docs/arch/19-yjs-chat-streaming.md`）不一致。

**目标**：建立 `packages/chat-channel` 大包（与 `packages/orchestration` 同级），原 `acp-server` 包全部能力原样迁入（逻辑零改动），删除原包，全部引用同批迁移到 `@fenix/chat-channel`；新增 `src/channel/` 控制面占位目录（后续 C3/C6 填充）。`web/src/acp/` 与 `yjs-frontend/` 的迁移分别在 C2、C3/C6 处理。

**影响**：
- 包：`packages/chat-channel`（`@fenix/chat-channel`），`test`/`typecheck` 脚本与原包一致；`packages/acp-server` 删除，不留兼容壳
- 配置：`tsconfig.base.json`、`web/tsconfig.json`、`web/vite.config.ts` 的路径别名同步更新
- 引用迁移：`src/`、`web/`、`src/__tests__/`、`web/src/__tests__/` 约 20 处 import 及当前状态文档（CLAUDE.md、19-yjs-chat-streaming、changes.md、协议/技术栈文档）全部改为 `@fenix/chat-channel`
- 历史过渡文档（C1 issue 与 2026-07-24 acp-server 设计文档）保留「原 @fenix/acp-server」表述，作为合并前历史记录
- `bun.lock` 同步；CI 的 Package tests（`bun test packages/`）自动覆盖新包

---

## 改动 15：Chat 域实现基线落地（协议、schema、状态机、权限 CAS、断链语义）

**状态**：✅ 已实施（C2–C8 切片，`refactor/yjs` 分支）

**现状（重构前）**：`docs/arch/19-yjs-chat-streaming.md` 是目标设计基线，与代码存在系统性差距——Y.Doc schema 与文档契约不符且 Doc 职责错位（`chat:` 装状态、`session:` 装时间线）、聚合层直接消费文档明令禁止的 `agent_message_chunk` 私有帧、无 Action/Ack 协议与 `commandId` 幂等、无显式 Turn 状态机、权限解析无 CAS 保护、Chat 域逻辑横跨包与宿主且 `yjs-frontend/` 直接耦合 `environmentRepo` / `resolveWorkspacePath` / `acp-idle-monitor` / `cache`。

**目标**：按 PRD（`docs/design/2026-08-04-yjs-chat-streaming-prd.md`）与 ADR（`spec/global/adr/2026-08-04-chat-channel-package-design.md`）的 16 项评审决策完成 Chat 流式链路重构，把 19 号文档升级为"实现基线"（与 20 号文档相同路径）。

**实施内容**：

1. **包合并（C1，改动 14 完成）**：`packages/acp-server` 全量能力迁入 `packages/chat-channel`（`@fenix/chat-channel`），不留兼容壳；`web/src/acp/` 删除，11 个组件 import 直接指向包导出。
2. **Y.Doc schema 一次性切换（C2，Q4）**：Chat Doc `chat:{rcsSessionId}` = 消息时间线（`schemaVersion` / `projectionVersion` / `entryOrder` / `entries` / `toolCalls`），Session Doc `session:{rcsSessionId}` = 会话元信息 / Agent 状态（`session` / `agent` / `pendingPermissions`）；纠正 Doc 职责错位；旧字段全部删除，**无兼容窗口、不做双读双写**；加载路径幂等补齐新结构骨架。
3. **ACP 聚合边界（C2，Q6）**：`protocol/acp-channel.ts` 是唯一协议边界——acp-link 私有帧（`agent_message_chunk` / `agent_thought_chunk` / `prompt_complete` 等）与 JSON-RPC `session/update` 帧在此规范化为统一事件（保留原始 + 包裹双格式兼容）；聚合层只消费规范化事件，删除旧类型消费路径；acp-link 与 Agent 部署零改动。
4. **Action / Ack 协议（C3，Q5/Q9）**：`channel/` 新增控制面——Gateway / SessionChannel / CommandCoordinator；`commandId` 幂等去重（每 `rcsSessionId` 进程内 Map，随实例生命周期释放）、`accepted → committed → duplicate` 两阶段 Ack、`ActionError` 稳定错误码、`expectedProjectionVersion` 服务端校验（VERSION_CONFLICT）；前端只新增 `commandId` 字段（UUID，重试复用），`protocolVersion` / `client` / `sessionId` 由服务端按会话绑定补充。
5. **Turn 状态机（C4，Q7）**：`accepting → running → awaiting_permission → cancelling → cancelled/interrupted/failed/completed` 为权威，终态不可逆；`interrupted` 由实例失联（`relay_closed`）或取消超时（10s 兜底）触发；删除会话级扁平 `status` 枚举，前端由 `session.activeTurn.turnStatus` 派生展示状态。
6. **权限 CAS（C5，Q8）**：`pendingPermissions` 迁入 Session Doc；解析走 CAS（`state/permission.ts`，仅 `pending → resolved` 原子迁移一次，迁移成功才向 Agent 发 `permission.resolve`）；权限请求/会话切换/断链附带过期终态迁移（默认 5min）。
7. **连接生命周期与两类断链（C6，Q13）**：`ws-lifecycle` 语义原样迁移、结构重组（YJS 快照时序、64 KB 背压、`YJS_MAX_CLIENTS` 200 配额、rpcId 管理不重写）；前端断开仅释放连接级资源与 relay 引用计数，Instance ACP session 存活时重连同步当前实时 Y.Doc；`relay_closed` 删除该 `rcsSessionId` 的 Chat Doc / Session Doc / 广播订阅（先注销监听再销毁 Doc，杜绝僵尸监听器）并触发实例级回收；与 19 号文档 §4.1 的 YJS sync 握手差异记为二期优化项。
8. **宿主桥接（C7，Q10）**：包内 `ChatChannelDependencies` 接口 + `src/services/chat-channel-bootstrap.ts` 装配单例（`getChatChannelController()` / `resetChatChannelBootstrap()` 供测试）；`src/transport/relay/yjs-frontend/` 与 facade 删除，`src/routes/acp/index.ts` 改调桥接；包内无对 `src/` 宿主的直接 import。
9. **不实现项（Q5 评审决策）**：事件日志体系（`eventId` / `eventSeq` 不建模）与 `SessionLeaseManager` 租约不实现——YJS CRDT 已保证文档一致性，防重复副作用由 `commandId` 去重承担；`leaseEpoch` 类型占位，为多节点部署预留。

**影响**：
- 文档：`docs/arch/19-yjs-chat-streaming.md` 升级为"实现基线"（状态头、§2.3 模块表、§4 流程、§5.4、§6.2、§7.1/7.2、§8.2、§11、§15 修订）；`docs/arch/changes.md` 本次记录；`packages/chat-channel/README.md` 就位（原 acp-server README 内容并入并更新新语义）
- 测试：包内测试（`packages/chat-channel/src/**/*.test.ts`，协议层 seam + 假连接对象，无真实 WS/Agent）覆盖 `commandId` 去重、版本冲突、权限 CAS、Turn 状态机、两类断链、背压、广播隔离；既有 `src/__tests__/yjs-frontend-*.test.ts` 迁移/清理
- 行为不变：`agent-chat-service.ts`（HTTP 单轮）与 workflow 路径仅迁移 import，对外契约不变
- 遗留（二期）：YJS sync 增量握手对齐（Q13）、`expectedProjectionVersion` 前端乐观并发增强与冲突重试 UI、跨节点 Redis 租约 / 事件日志持久化

---

## 改动 16：19/20 号文档二次对齐（实现基线与代码一致化）

**状态**：✅ 已实施（2026-08-05，`refactor/yjs` 分支）

**现状（修订前）**：c95e1f0a 把 20 号文档升级为实现基线后，19 号文档仍残留旧架构概念与编号错乱：§1 架构图沿用 `InstanceManager` / `ACP Gateway` 旧模型、`ensureRunning(environmentId, agentConfigId)` 签名过时、`### 7.1` 位于 `## 8` 之下等多处章节编号错乱、Session Doc schema 缺 `activeTurn` / `sessions` / `decision` 字段；20 号文档头部与正文引用了两份已不存在/从未存在的文档（`agent-controller-consumers-audit.md` 已被 c95e1f0a 删除、`pending-design-decisions.md` 从未创建），且引用已删除的 `ws-lifecycle.handleOpen`。

**目标**：19 号文档全面对齐 `refactor/yjs` 分支当前实现（`packages/chat-channel` + 宿主桥接 + 编排域），20 号文档清除失效引用并把必要内容内联。

**实施内容**（19 号文档）：

1. **§1 架构图重构**：`AgentController / InstanceManager / ACP Gateway` 旧子图替换为 ChatChannelController（控制面）+ state + protocol（ACPChannel 入站 / Translator 出站）+ 宿主桥接（chat-channel-bootstrap / ensureRunning / connectAgentRelay）+ 编排域（AgentController / AgentNode）双层结构，与 20 号文档一致。
2. **§2.3 模块表**：新增 `ChatChannelController`（`channel/controller.ts` 装配点）、`Translator`（出站 action → ACP JSON-RPC，cwd/rpcId 注入）行；`InstanceManager` 行改为编排域 AgentController + AgentNode/AgentNodeService + 宿主 ensureRunning；RelayEventHandler 行补充 `relay_closed` 实例级回收（`terminateLocalDeadInstance`）。
3. **§4.1 连接建立**：时序改写为实际实现（配额 → 授权 → `ensureRunning(userId, agentId, "interactive", instanceNumber?)` → 共享 relay → 快照 → connect 握手 → flush 缓冲）；新增终态关闭码表（4500 机器离线 / 4502 配置失败 / 4501 keepalive 超时 / 1011、1013）与共享 relay 引用计数语义。
4. **§4.2/4.3/4.4 流程**：ensureRunning 签名修正；load/resume 补充回放窗口（`REPLAY_WINDOW_MS` 10s，无头历史回放投影）与会话切换清理（CAS 快照 + `clearSessionDocContent` + `syncSessionId`）；命令出站路径改经 Translator → 共享 relay。
5. **§5.2/5.3 schema**：补充 `CHAT_DOC_SCHEMA_VERSION = 2` / `SESSION_DOC_SCHEMA_VERSION = 3`；Session Doc 增加 `activeTurn`、`sessions` 投影位与 `decision` 字段；§5.4 澄清旧 `sessions` 字段与新投影位同名不同义。
6. **§6.2/6.3/6.5**：补充 Translator 出站边界、`session/list` 轮询投影（10s 全量同步）、`relay_closed` 双清理语义。
7. **章节编号修正**：`7.1/7.2 → 8.1/8.2`、`8.1/8.2/8.3 → 9.1/9.2/9.3`、`11.1/11.2 → 12.1/12.2`；删除 §10 尾部与 §4.1 重复的过时差异注。
8. **§11/§13/§14/§15**：补充回放窗口、keep_alive 心跳与关闭码、失败矩阵终态码语义、场景 A/K 的 ensureRunning 触发时机与签名；决策摘要新增共享 relay 引用计数、回放窗口、实例生命周期归编排域三条。

**实施内容**（20 号文档）：

1. 头部"配套文档"删除两份失效引用（审计报告与待决决策内容已并入正文 §5/§2.2，注明不再单独成文）。
2. §7 表格 B 行与 §9 场景 B 的 `ws-lifecycle.handleOpen` 修正为 `/acp/yjs/:agentId`（`src/routes/acp/index.ts`）→ `gateway.handleOpen`。
3. §11 教训清单与 §12 T9 的审计报告/验收点引用改为内联描述。

**影响**：纯文档修订，无代码/行为变化；docs 站点构建不受影响。

---

## 改动 17：文件系统操作传递权威文档与 file-ws v2 协议设计（12-files.md 重写）

**状态**：📝 设计已确认，待实施（2026-08-05）

**现状（修订前）**：文件系统操作传递的生命线（file-ws 信道）未在任何权威文档中定义——19 号文档只覆盖 YJS Chat 流式，20 号文档只覆盖 acp-ws（AgentNode）编排域；`12-files.md` 停留在旧模块风格且描述已过时（路由写的是 `/user`、`/user-file`，实际代码已迁移到 `/web/environments/:id/fs/*`）。代码调研确认现有 file-ws 传递存在 9 个设计缺陷（D1–D9）：register 身份仅自报不与 acp-ws 注册表对账、keep_alive 无超时巡检（僵尸连接永久占索引）、无领域幂等键（断连重试重复执行写操作）、pending 无界、远程分支 path 零校验、机器健康状态无聚合、读文件静默 fallback 掩盖错误语义等。

**目标**：12-files.md 重写为文件系统操作传递的权威实现基线（对齐 19/20 号文档风格），补出两条生命线（file-ws 信道生命周期、文件操作请求-响应），并基于缺陷清单完成 file-ws v2 协议设计（评审待办，暂不实施）。

**实施内容**（纯文档）：

1. **§1 总体架构**：重写为**理想态架构图**（AgentFileService 统一执行面 + 防缓存双机制），附现状→理想态差异表；范围限定为服务端契约（主服务 + 远端 Machine），不覆盖前端消费方式。
2. **§2 AgentFileService（统一文件服务层）**：内部结构细化——入口（认证上下文）/ 路由决策 / 路径校验 / 后端适配执行 / 指纹派生 / 错误映射 / 变更事件发布七个子模块（职责表 + 子模块图）；统一接口（10 操作）+ LocalBackend/RemoteBackend 映射表 + 统一契约（路径校验、错误码 `file_service_unavailable`、响应结构、变更事件），路由层消灭 `if (machineId)` 双分支（D10）。
3. **§3 路由契约**：`/web/environments/:id/fs/*` 十个端点表（含远程支持矩阵）+ machineId 回退链与拒绝静默回退；旧 `/user`、`/user-file` 前缀标记废弃。
4. **§4 防缓存与一致性机制**（D11）：ETag 条件请求（read 文件指纹 / list 条目指纹 / tree 弱校验，`Cache-Control: no-cache`）+ `file_changed` 变更事件（机器端写操作后经 file-ws 推送 → EventBus 按 environmentId 路由广播，本地写由 AgentFileService 直发）+ 并发写 If-Match（v2 可选）。
5. **§5 file-ws 信道生命周期生命线**：机器侧连接时序图（register → 同机器替换 → keep_alive → 断连清理）。
6. **§6 文件操作请求-响应生命线**：路由 → AgentFileService → service → file-ws 往返时序图（request_id、60s/120s 超时、断连 reject pending），标注理想态差异。
7. **§7 file-ws v2 协议设计**：连接身份绑定（D1）、op_id 幂等（D3）、重连请求迁移、心跳僵尸回收（D2）、file_changed 事件帧（§7.5）、背压（D4）、路径前置校验（D5/D7）、读 mode 显式（D9）、远程 zip（§7.9）。
8. **§8 安全边界 + §9 缺陷对照（D1–D11，新增 D10 双路径、D11 无缓存）+ §10 实施计划**（P0 止血 / P1 统一执行面+缓存 / P2 一致性增强 / 二期分块）。
9. **附录 A**：废弃路由表与替代关系。
10. 20 号文档头部定位行补充交叉引用（文件操作信道 → 12-files.md）。

**对抗审查修订（2026-08-05，plan subagent 对抗审查 + 用户决策）**：

- **阻断项**：新增 §4.3 file-events 独立 WS 订阅端点契约（订阅/事件/失效/降级帧、鉴权、限频、异步发布——修复 D13）；§7.1 身份绑定对账查询面定为 **core runtime node**（registerRemoteNode 产物）、删除 node_id、4004 语义与机器侧重连时序契约（跨仓库）。
- **严重项**：§5 现状描述修正（register 替换先删登记再 close → pending 悬挂至超时，与代码对齐，新增 D3 前置修复）；§7.6 载荷治理（WS 32MB maxPayload + 解析前检查，修复 Elysia 自动 parse 绕过 10MB 限制；upload 降为 20MB；zip 分块回传——D12）；§7.3 断连窗口兜底（重连注册成功广播 `invalidate_all`，修复 S3/D14）。
- **联动核心**：§1 机器能力矩阵（acp 可达 × file 可达 2×2，降级由本文档表达不扩展 20 号状态机）；§7.4 巡检独立遍历 machineFileWsIndex（不复用 startMachineSweep 的 online 集合——C5）；§4.4 澄清环境级回退链排他、"本地+远程混合"不成立（C14）；§4.2 tree 指纹加路径排序 hash 修复 rename 304 误判（C8）；§4.1 目标修订（本地外部变更 ≤ 30s 明确接受边界）。
- **19/20 号文档联动**：20 号 §5 补"先 acp-ws 后 file-ws"重连顺序跨仓库契约 + §6 补 performMachineCleanup 不触碰 file-ws 的状态分裂说明；19 号 §2.3 补传输层边界（file_changed 不经 YJS/relay 通道）+ §5.2 资源引用语义（路径字符串引用、上传与消息引用无事务）。

**影响**：纯文档修订，无代码/行为变化；docs 站点构建通过。理想态设计（§2/§4/§7）为评审待办，实施时按 §10 拆分提交并同步更新文档状态。修订记录：统一层命名从 FileService 改为 AgentFileService，删除前端消费相关章节（文档范围限定服务端契约）。
