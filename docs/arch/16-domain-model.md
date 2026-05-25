# 领域模型关联图

> 本文描述 RCS 上层领域概念之间的关联关系（设计态），与 `domain-model.html` 保持一致。Team 是所有资源的所有权单位。

---

## 全局关系图

```text
                          ┌─────────────────────────────────────────────┐
                          │                   User                       │
                          │  系统的用户，通过 email/password 注册          │
                          └──────┬──────────────────────┬───────────────┘
                                 │                      │
                    通过 Team 访问资源 │                      │ 登录后获得
                                 ▼                      ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐│┌──────────┐
│Provider  │  │AgentConfig│  │Skill     │  │API Key    │▼│ Session  │
│AI 服务商 │  │Agent 配置 │  │技能(独立)│  │Team 级别  │ │(Cookie)  │
│(含Model) │  └────┬─────┘  └──────────┘  └───────────┘ └──────────┘
└──────────┘       │
     │             │ 引用 Provider 下的 Model
     │             │        引用 Skill
     │             │        引用 McpServer
     │             │        引用 KnowledgeBase（MCP 协议）
                   │
                   │ agentConfigId（UUID 强绑定）
                   │
                   ▼
┌──────────────────────────────────────────────────────────────────────┐
│                        Environment（环境）                            │
│                                                                      │
│  资源管理层 — 调度 Agent Instance 生命周期，传递 AgentConfig 配置     │
│  职责：                                                              │
│  ① 调度 Instance 的生命周期（spawn / stop / autoStart）              │
│  ② 根据 AgentConfig 拉取 Skill，同步到 workspace                     │
│  ③ 同步 MCP 服务器配置到 workspace                                   │
│  ④ 同步 KnowledgeBase 绑定到 workspace（注入 MCP knowledge 端点）    │
│                                                                      │
│  两种来源：                                                           │
│  ① 用户在控制面板创建（持久，可 autoStart）                            │
│  ② acp-link 通过 /acp/ws 注册（临时，断连即删）                       │
└───────┬──────────────────────┬─────────────────────┬─────────────────┘
        │                      │                     │
   1:N 可以 spawn         1:N 可以 spawn         被路由到
        │                      │                     │
        ▼                      ▼                     ▼
┌──────────────┐     ┌────────────────┐     ┌────────────────┐
│   Instance   │     │   Instance     │     │IMChannelRoute  │
│   运行实例 1 │     │   运行实例 2   │     │ IM 路由规则    │
│              │     │                │     │                │
│ 一个 acp-link│     │ 一个 acp-link  │     │ 聊天群 → Env   │
│ 子进程       │     │ 子进程         │     │                │
└──────┬───────┘     └───────┬────────┘     └───────┬────────┘
       │                     │                      │
       │                     │ 消息双向转发          │ IM 消息路由
       │                     │                      │
       │                     ▼                      ▼
       │              ┌────────────────┐     ┌────────────────┐
       │              │  acp-link 进程 │◄────│   Hermes      │
       │              │  (AI Agent 本体)│     │  IM 网关      │
       │              └────────────────┘     └────────────────┘
       │
       │ 关联（已下沉到 acp-link，RCS 不持久化）
       ▼
┌──────────────┐     ┌────────────────┐
│ ScheduledTask│     │ KnowledgeBase  │
│ HTTP Cron    │     │ 知识库         │
│ 触发器       │     │                │
│              │     │ AgentConfig    │
│ 不绑定 Env   │     │ 通过 binding   │
│ 定时调 URL   │     │ 多对多关联     │
└──────┬───────┘     └────────────────┘
       │
  1:N 执行记录
       │
       ▼
┌──────────────┐
│ExecutionLog  │
│ 执行日志     │
└──────────────┘
```

### Team（团队）资源所有权

```text
┌───────────────────────────────────────────────────────────────┐
│                        Team（资源所有者）                        │
│                                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │  Env    │ │ Agent   │ │Provider │ │  Skill  │            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │  MCP    │ │  KB     │ │  Task   │ │IMChannel│            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  ┌─────────┐ ┌─────────┐                                      │
│  │ API Key │ │Workflow │                                      │
│  └─────────┘ └─────────┘                                      │
│                                                               │
│  成员角色：                                                    │
│  owner  — 读写全部 + 管理成员                                  │
│  admin  — 读写全部资源                                        │
│  member — 读全部 / 写自己创建的                                │
└───────────────────────────────────────────────────────────────┘
```

---

## 核心概念详解

### User（用户）

用户通过 better-auth 注册，登录后获得 cookie session。用户通过 Team 成员身份访问资源，`activeTeamId` 存储在 session 中。用户注册后自动创建个人团队。

### Team（团队 — 资源所有权单位）

Team 是 RCS 中**所有资源的所有权单位**。Environment、AgentConfig、Provider、Skill、McpServer、KnowledgeBase、IMChannel、ScheduledTask、API Key、Workflow 都归 Team 所有。

API Key 是 Team 级别的资源，不是 User 个人持有的。团队成员通过 Cookie Session 登录后切换到 Team，即可使用该 Team 的所有资源；外部系统通过 API Key 访问时，也是绑定到 Team。

每个 Team 有三种角色：owner（管理团队）、admin（读写全部资源）、member（读全部，只写自己创建的）。

### Environment（环境 — 资源管理层）

Environment 是 RCS 最核心的概念，负责调度 Agent Instance 的生命周期（spawn / stop / autoStart）。

**核心职责**：

1. **调度 Instance 生命周期**：根据策略决定是否 spawn 新的 Instance，统一管理 spawn 决策
2. **根据 AgentConfig 拉取 Skill**：spawn 时将 AgentConfig 关联的 Skill 同步到 workspace
3. **同步 MCP 服务器配置**：将 AgentConfig 中配置的 MCP 服务器写入 workspace
4. **同步 KnowledgeBase 绑定**：通过 MCP knowledge 端点将知识库注入 Agent 运行环境

关键属性：

- **workspacePath**：Agent 的工作目录
- **agentConfigId**（UUID FK）：强绑定 AgentConfig，优先于旧版 agentName
- **status**：`idle`（未运行）、`active`（在线）、`disconnected`（已断连）
- **secret**：认证令牌，acp-link 和 instance 用它连接 RCS
- **autoStart**：服务器启动时是否自动 spawn 实例
- **maxSessions**：并发实例上限

**两种生命周期**：

1. **持久环境**：用户在控制面板创建，存在数据库里。断连后保留，可重新 spawn
2. **临时环境**：acp-link 通过 `/acp/ws` 直接注册，只存在于连接期间。WebSocket 断开即删除

**和 AgentConfig 的关系**：Environment 通过 `agentConfigId`（UUID）强绑定 AgentConfig。spawn Instance 时，Environment 将 AgentConfig 的完整配置注入 workspace。

**和 Instance 的关系**：Environment 调度 Instance，不是 Instance 的容器。一个 Environment 可以有多个 Instance（受 maxSessions 限制）。

### Instance（运行实例）

Instance 是一个 **acp-link 子进程**，由 Environment 按需 spawn 和管理。只存在于内存，服务器重启后消失。

**和 Environment 的关系**：Instance 由 Environment 调度 spawn。spawn 时 Environment 将 AgentConfig 配置注入 Instance 的 workspace。

### Session（会话 — 已下沉到 acp-link）

Session 是用户和 Agent 之间的一次对话记录，**完全由 acp-link 进程管理**。RCS 不存储 Session 元数据、不管理生命周期。前端通过 ACP 通道（session/list、session/load）直接与 Agent 交互，RCS 只做消息透传。

**ID 格式**：`ses_xxx`（ACP Agent 返回）、`session_xxx`（RCS 内部）、`cse_xxx`（Code Session）

### AgentConfig（Agent 配置）

AgentConfig 定义了一个 Agent 的**行为参数**，是配置的汇聚点。AgentConfig 不拥有任何资源，只是引用它们：

- 用哪个 Model（引用 Provider 下的 Model）
- 系统提示词（prompt）
- 权限规则（permission：三态 ask/allow/deny）
- 引用 Skill（独立资源）
- 通过 MCP 协议关联 KnowledgeBase
- 引用 McpServer

**内置 Agent**：`build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`——不可删除，但可修改配置。

**和 Environment 的关系**：Environment 通过 `agentConfigId`（UUID）强绑定 AgentConfig。

### Provider（服务商，包含 Model）

Provider 是 AI 服务商（OpenAI、Anthropic 等），包含该服务商下的多个 Model。Model 不作为独立领域概念，管理入口在 Provider 详情页内。

- AgentConfig 的 `model` 字段引用 Provider 下的某个 Model ID
- Provider 的 `apiKey` 不存明文，响应只返回 keyHint

### KnowledgeBase（知识库）

知识库是用户上传的文档集合，由外部 Provider 做向量索引。**独立资源**，不隶属于 AgentConfig。

**和 AgentConfig 的关系**：通过 `agent_knowledge_binding` 表做**多对多**绑定（按 agentConfigId UUID 关联）。Agent 运行时通过 MCP 端点查询知识库。

### Skill（技能）— 独立资源

Skill 是 Markdown 格式的指令文件（SKILL.md），给 Agent 补充特定领域的知识和操作指南。**独立资源**，被 AgentConfig 引用。

- 元数据存在数据库，内容存在文件系统 `~/.agents/skills/<name>/SKILL.md`
- 支持全局（不绑定环境）和 workspace（绑定到特定 Environment）两种 scope

### McpServer（MCP 服务器）— 独立资源

MCP 服务器是给 Agent 提供外部工具的**独立资源**，被 AgentConfig 引用。支持 local（命令行启动）和 remote（URL 连接）两种类型。

### IMChannel（IM 通道）— 用户一等资源

IMChannel 是用户界面的一等资源，用于对接外部聊天平台（飞书、Telegram、Discord 等）。用户创建 IMChannel 时选择连接方式、填写凭证、配置路由规则。

路由规则存储在 `imChannelRoute` 表中：哪个聊天群 → 哪个 Environment。

消息到达时，IMChannel 通过 Environment 确保 Instance 运行，然后路由消息。

### ScheduledTask（HTTP Cron 触发器）

ScheduledTask 是**纯粹的 HTTP cron 触发器**——定时调一个 URL。**不绑定 Environment、不绑定 AgentConfig、不包含任务描述**。

最常见的场景是定时触发一个 Workflow URL，由 Workflow 编排后续的 Agent 执行流程。也可以直接调任意 HTTP 端点。每次执行产生一条 ExecutionLog。

### Workflow（编排引擎）

Workflow 是 RCS 的独立领域模块，负责编排 Agent 的多步执行流程。通过 Environment 操作 Agent（不直接接触 Instance 或 acp-link），封装了"选择 Environment → 选择 AgentConfig → 执行步骤 → 收集结果"的完整流程。

Workflow 提供 URL 入口，ScheduledTask 通过 HTTP 调用 Workflow URL 实现定时触发。

---

## 关键关联总结

```text
Environment（环境 / 资源管理层）
  ├── 职责：调度 Instance 生命周期 + 传递 AgentConfig 配置
  ├── 1:N ── Instance（由 Environment 调度 spawn，内存态）
  ├── N:1 ── AgentConfig（通过 agentConfigId UUID 强绑定）
  └── 1:1 ── IMChannelRoute（environmentId 路由）

AgentConfig（Agent 配置）
  ├── N:1 ── Model（通过 model 字符串匹配，Model 为 Provider 子属性）
  ├── M:N ── KnowledgeBase（通过 agent_knowledge_binding 表，按 agentConfigId）
  ├── 引用 Skill（独立资源）
  └── 引用 McpServer（独立资源）

Provider（服务商，包含 Model）
  └── 1:N ── Model（数据层面独立表，领域层面为 Provider 子属性）

Skill（技能）— 独立资源
  └── 归 Team 所有

McpServer（MCP 服务器）— 独立资源
  └── 归 Team 所有

KnowledgeBase（知识库）
  ├── 1:N ── KnowledgeResource（知识资源/文件）
  └── M:N ── AgentConfig（通过 agent_knowledge_binding 表）

ScheduledTask（HTTP Cron 触发器）
  ├── 不绑定 Environment
  └── 1:N ── ExecutionLog（执行日志）

IMChannel（IM 通道）
  ├── 1:N ── IMChannelRoute（路由规则 → Environment）
  └── 归 Team 所有

Team（团队）
  └── 1:N ── 所有上述资源（所有权单位）
```

---

## 消息怎么流转

### 前端发消息给 Agent

```text
前端 → WS /acp/relay/:agentId
          │
          ▼
     有 running Instance？
       │         │
      YES        NO
       │         │
       ▼         ▼
    core relay  → acp-link 进程 → opencode Agent
```

### 聊天平台发消息给 Agent

```text
飞书/Telegram → Hermes 网关
                    │
                    ▼
              HermesClient（RCS 内）
                    │
                    ▼
           IMChannelRoute 匹配
           （channelId + chatId → environmentId）
                    │
                    ▼
           找到 Environment 的 Instance
                    │
                    ▼
           core relay → acp-link → Agent

           Agent 回复 → EventBus inbound
                    │
                    ▼
           HermesClient 订阅到 prompt_complete
                    │
                    ▼
           Hermes.send() → 聊天平台
```

### 定时任务执行

```text
cron 触发 → ScheduledTask
              │
              ▼
         HTTP 请求 task.url
              │
              ├─→ Workflow URL → 通过 Environment 操作 Agent
              │
              └─→ 任意 HTTP 端点
              │
              ▼
         记录 ExecutionLog
```
