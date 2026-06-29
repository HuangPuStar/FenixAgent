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
