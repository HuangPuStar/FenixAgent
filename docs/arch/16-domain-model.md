# 领域模型关联图

> 本文描述 RCS 上层领域概念之间的关联关系（设计态），与 `src/db/schema.ts` 保持一致。Organization（组织）是所有资源的所有权单位——本文档早期使用 "Team" 术语，现已统一为 "Organization"，对应 better-auth organization 插件的 `organization`/`member`/`invitation` 三表体系。

---

## 全局关系图

```text
                          ┌─────────────────────────────────────────────┐
                          │                   User                       │
                          │  系统的用户，通过 email/password 注册          │
                          └──────┬──────────────────────┬───────────────┘
                                 │                      │
                    通过 Organization │                     │ 登录后获得
                    访问资源         │                      │
                                 ▼                      ▼
┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐│┌──────────┐
│Provider  │  │AgentConfig│  │Skill     │  │API Key    │▼│ Session  │
│AI 服务商 │  │Agent 配置 │  │技能(独立)│  │Org 级别   │ │(Cookie)  │
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
│ 子进程       │     │ 子进程         │     │ 1:N (一个通道  │
└──────┬───────┘     └───────┬────────┘     │ 多个路由)      │
       │                     │              └───────┬────────┘
       │                     │ 消息双向转发         │ IM 消息路由
       │                     │                      │
       │                     ▼                      ▼
       │              ┌────────────────┐     ┌────────────────┐
       │              │  acp-link 进程 │◄────│   Hermes      │
       │              │  (AI Agent 本体)│     │  IM 网关      │
       │              └────────────────┘     └────────────────┘
       │
       │ 关联
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

### Organization（组织）资源所有权

```text
┌───────────────────────────────────────────────────────────────┐
│                     Organization（资源所有者）                    │
│                                                               │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │  Env    │ │ Agent   │ │Provider │ │  Skill  │            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │  MCP    │ │  KB     │ │  Task   │ │IMChannel│            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐            │
│  │ API Key │ │Workflow │ │ Machine │ │SiteApp  │            │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘            │
│  ┌─────────┐                                                  │
│  │userConfig│ (per-org 单行偏好)                               │
│  └─────────┘                                                  │
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

用户通过 better-auth 注册，登录后获得 cookie session。用户通过 Organization 成员身份访问资源，`activeOrganizationId` 存储在 session 中。用户注册后自动创建个人组织。

### Organization（组织 — 资源所有权单位）

Organization 是 RCS 中**所有资源的所有权单位**。Environment、AgentConfig、Provider、Skill、McpServer、KnowledgeBase、IMChannel、ScheduledTask、API Key、Workflow、Machine 都归 Organization 所有。

API Key 是 Organization 级别的资源，不是 User 个人持有的。团队成员通过 Cookie Session 登录后切换到 Organization，即可使用该 Organization 的所有资源；外部系统通过 API Key 访问时，也是绑定到 Organization。

每个 Organization 有三种角色：owner（管理组织）、admin（读写全部资源）、member（读全部，只写自己创建的）。

Organization 体系通过 better-auth organization 插件的三张表实现：
- `organization`：组织元数据（id、name、slug、logo）
- `member`：成员关系（organizationId、userId、role），唯一约束 (org, user)
- `invitation`：邀请记录（organizationId、email、role、status、expiresAt）

### Environment（环境 — 资源管理层）

Environment 是 RCS 最核心的概念，负责调度 Agent Instance 的生命周期（spawn / stop / autoStart）。

**核心职责**：

1. **调度 Instance 生命周期**：根据策略决定是否 spawn 新的 Instance，统一管理 spawn 决策
2. **根据 AgentConfig 拉取 Skill**：spawn 时将 AgentConfig 关联的 Skill 同步到 workspace
3. **同步 MCP 服务器配置**：将 AgentConfig 中配置的 MCP 服务器写入 workspace
4. **同步 KnowledgeBase 绑定**：通过 MCP knowledge 端点将知识库注入 Agent 运行环境

关键属性：

- **agentConfigId**（UUID FK）：强绑定 AgentConfig
- **workspacePath**：**已废弃**，不再被读取。实际路径由 `resolveWorkspacePath(orgId, userId, envId)` 实时计算。旧数据保存历史值，新数据写空字符串
- **status**：`idle`（未运行）、`active`（在线）、`disconnected`（已断连）。无数据库枚举约束，业务层约定
- **secret**：认证令牌，acp-link 和 instance 用它连接 RCS
- **autoStart**：服务器启动时是否自动 spawn 实例
- **maxSessions**：并发实例上限
- **machineName**：绑定的机器名称
- **branch** / **gitRepoUrl**：git 仓库分支和地址
- **workerType**：运行池类型（默认 `acp`）
- **capabilities**（JSONB）：扩展能力声明

**两种生命周期**：

1. **持久环境**：用户在控制面板创建，存在数据库里。断连后保留，可重新 spawn
2. **临时环境**：acp-link 通过 `/acp/ws` 直接注册，只存在于连接期间。WebSocket 断开即删除

**和 AgentConfig 的关系**：Environment 通过 `agentConfigId`（UUID）强绑定 AgentConfig。spawn Instance 时，Environment 将 AgentConfig 的完整配置注入 workspace。

**和 Instance 的关系**：Environment 调度 Instance，不是 Instance 的容器。一个 Environment 可以有多个 Instance（受 maxSessions 限制）。

### Instance（运行实例）

Instance 是一个 **acp-link 子进程**，由 Environment 按需 spawn 和管理。只存在于内存，服务器重启后消失。

**和 Environment 的关系**：Instance 由 Environment 调度 spawn。spawn 时 Environment 将 AgentConfig 配置注入 Instance 的 workspace。

### Session（会话）

Session 是用户和 Agent 之间的一次对话记录。ACP 侧的 session 由 acp-link 进程管理（`ses_xxx` 格式），**同时 RCS 在 `agent_session` 表中持久化存储 key 元数据**：

- **id**：RCS session ID（`session_xxx` / `cse_xxx`）
- **environmentId**：关联的 Environment
- **title**：会话标题
- **status**：`idle` / `active` / `completed` 等
- **source**：创建来源（默认 `acp`）
- **userId**：创建用户

**ID 格式**：`ses_xxx`（ACP Agent 返回）、`session_xxx`（RCS 内部会话）、`cse_xxx`（Code Session）

### AgentConfig（Agent 配置）

AgentConfig 定义了一个 Agent 的**行为参数**，是配置的汇聚点。AgentConfig 不拥有任何资源，只是引用它们：

- **modelId**（UUID FK → model 表）：运行时使用的 AI 模型（取代旧版 `model` 字符串字段）
- **model**（varchar）：**已废弃**，不再被读取，后面使用 modelId
- **prompt**：系统提示词
- **description**：配置描述
- **engineType**：引擎类型（默认 `opencode`）
- **machineId**：绑定的机器（FK → machine 表）
- **extra**（JSONB）：预留扩展字段
- 引用 Skill（通过 `agentConfigSkill` 多对多表）
- 引用 McpServer（通过 `agentConfigMcp` 多对多表）
- 引用 KnowledgeBase（通过 `agentKnowledgeBinding` 多对多表）
- 引用 AgentSiteApp（通过 `agentConfigSiteApp` 多对多表）

**权限控制**：Permission（三态 ask/allow/deny）不存储在 agentConfig 自身，而在 `userConfig.permission`（JSONB 字段），按用户-组织维度独立配置。

**内置 Agent**：`build`、`plan`、`general`、`explore`、`title`、`summary`、`compaction`——不可删除，但可修改配置。

**和 Environment 的关系**：Environment 通过 `agentConfigId`（UUID）强绑定 AgentConfig。

### Provider（服务商，包含 Model）

Provider 是 AI 服务商（OpenAI、Anthropic 等），包含该服务商下的多个 Model。Model 不作为独立领域概念，管理入口在 Provider 详情页内。

- AgentConfig 的 `modelId` 字段引用 Model 表的主键
- Provider 的 `apiKey` 不存明文，响应只返回 keyHint
- 支持 `{env:RCS_SECRET_<name>}` 占位符引用环境变量中的密钥

### KnowledgeBase（知识库）

知识库是用户上传的文档集合，由外部 Provider 做向量索引。**独立资源**，按 `organizationId` 隔离，不隶属于 AgentConfig。

字段包括：`name` / `slug`、`provider`、`remoteId`、`remoteAccountId` / `remoteUserId`（RagFlow 账户绑定）、`description`、`status`、`lastError`。

**和 AgentConfig 的关系**：通过 `agent_knowledge_binding` 表做**多对多**绑定（按 agentConfigId UUID 关联）。Agent 运行时通过 MCP 端点查询知识库。

### Skill（技能）— 独立资源

Skill 是 Markdown 格式的指令文件（SKILL.md），给 Agent 补充特定领域的知识和操作指南。**独立资源**，被 AgentConfig 引用。

- 元数据存在数据库，内容存在文件系统 `{SKILL_DIR}/{organizationId}/{name}/SKILL.md`
- 支持全局（不绑定环境）和 workspace（绑定到特定 Environment）两种 scope
- 必须通过 `setSkill`/`importSkillDirectories` 创建，确保 DB + 文件系统双同步

### McpServer（MCP 服务器）— 独立资源

MCP 服务器是给 Agent 提供外部工具的**独立资源**，被 AgentConfig 引用。支持 local（命令行启动）和 remote（URL 连接）两种类型。

### IMChannel（IM 通道）— 用户一等资源

IMChannel 是用户界面的一等资源，用于对接外部聊天平台（飞书、Telegram、Discord 等）。用户创建 IMChannel 时选择连接方式、填写凭证、配置路由规则。

路由规则存储在 `imChannelRoute` 表中：哪个聊天群 → 哪个 Environment。**一个 IMChannel 可以有多个路由规则（1:N）**。

消息到达时，IMChannel 通过 Environment 确保 Instance 运行，然后路由消息。

### channel_binding 表（遗留）

`channel_binding` 是 Hermes 通道绑定的旧表，**已废弃**，保留兼容。当前 IM 功能通过 `imChannel` + `imChannelRoute` 两张表实现。旧表包含字段：`platform`、`chatId`、`agentId`、`enabled`。

### userConfig（用户偏好）

用户级的常见偏好，**以 (organizationId, userId) 为键存储单行**：

- **organizationId**（PK）：组织 ID
- **userId**：用户 ID
- **defaultAgent**：默认 Agent
- **currentModel** / **smallModel**：当前/小型模型
- **permission**（JSONB）：Agent 工具的权限配置（三态 ask/allow/deny）

### ScheduledTask（HTTP Cron 触发器）

ScheduledTask 是**纯粹的 HTTP cron 触发器**——定时调一个 URL。**不绑定 Environment、不绑定 AgentConfig、不包含任务描述**。

最常见的场景是定时触发一个 Workflow URL，由 Workflow 编排后续的 Agent 执行流程。也可以直接调任意 HTTP 端点。每次执行产生一条 ExecutionLog。

### Workflow（编排引擎）

Workflow 是 RCS 的独立领域模块，负责编排 Agent 的多步执行流程。通过 Environment 操作 Agent（不直接接触 Instance 或 acp-link），封装了"选择 Environment → 选择 AgentConfig → 执行步骤 → 收集结果"的完整流程。

Workflow 提供 URL 入口，ScheduledTask 通过 HTTP 调用 Workflow URL 实现定时触发。

### Machine / Registry（机器注册表）

Machine 是远端运行 acp-link 的计算节点。`machine` 表存储机器注册信息：

- **id**：机器唯一标识
- **agentName**：Agent 名称
- **status**：`online` / `offline`
- **machineInfo**（JSONB）：主机详情（CPU、内存、OS 等）
- **labels**（JSONB）：标签（用于过滤匹配）
- **maxSessions** / **heartbeatIntervalMs**：会话上限和心跳间隔

`registryEvent` 表记录机器事件历史（注册、断连、状态变更等），按 `machineId` + `type` 索引。

### Agent Site App（Agent 站点应用）

`agentSiteApp` 是一个独立实体，代表可嵌入 Agent 聊天界面的第三方应用。绑定通过 `agentConfigSiteApp` 多对多关联表挂载到 AgentConfig 上。

- **remoteAppId**：远程应用 ID
- **name** / **description**：应用名称和描述
- **platformToken** / **platformTokenId**：平台集成凭证
- **visibility**：`public` / `private`

### Resource Permission（资源权限）

`resourcePermission` 表控制"谁可以读哪些资源"，支持四种资源类型（provider、skill、mcp_server、agent_config），两种权限主体（`all` 全局、`organization` 指定组织），目前仅支持 `read` 动作。

---

## 关键关联总结

```text
Environment（环境 / 资源管理层）
  ├── 职责：调度 Instance 生命周期 + 传递 AgentConfig 配置
  ├── 1:N ── Instance（由 Environment 调度 spawn，内存态）
  ├── N:1 ── AgentConfig（通过 agentConfigId UUID 强绑定）
  └── 1:N ── IMChannelRoute（environmentId 路由）

AgentConfig（Agent 配置）
  ├── N:1 ── Model（通过 modelId UUID FK，Model 为 Provider 子属性）
  ├── N:1 ── Machine（通过 machineId FK）
  ├── M:N ── KnowledgeBase（通过 agent_knowledge_binding 表，按 agentConfigId）
  ├── M:N ── Skill（通过 agentConfigSkill 表）
  ├── M:N ── McpServer（通过 agentConfigMcp 表）
  ├── M:N ── AgentSiteApp（通过 agentConfigSiteApp 表）
  ├── 已废弃 model 字段（varchar），改用 modelId FK
  └── permission 在 userConfig 表，不在 agentConfig

Provider（服务商，包含 Model）
  └── 1:N ── Model（数据层面独立表，领域层面为 Provider 子属性）

Skill（技能）— 独立资源
  ├── 归 Organization 所有
  ├── 文件系统存储：{SKILL_DIR}/{organizationId}/{name}/SKILL.md
  └── DB + 文件系统双同步（通过 setSkill/importSkillDirectories）

McpServer（MCP 服务器）— 独立资源
  └── 归 Organization 所有

KnowledgeBase（知识库）
  ├── 按 organizationId 隔离
  ├── 字段：remoteAccountId、remoteUserId、description、lastError
  └── M:N ── AgentConfig（通过 agent_knowledge_binding 表）

ScheduledTask（HTTP Cron 触发器）
  ├── 不绑定 Environment
  └── 1:N ── ExecutionLog（执行日志）

IMChannel（IM 通道）
  ├── 1:N ── IMChannelRoute（路由规则 → Environment）
  ├── channel_binding 表为旧版遗留，保留兼容
  └── 归 Organization 所有

Organization（组织）
  ├── organization / member / invitation 三表体系
  └── 1:N ── 所有上述资源（所有权单位）

Machine（机器注册表）
  ├── machine + registryEvent 两张表
  └── 归 Organization 所有

AgentSiteApp（站点应用）
  └── M:N ── AgentConfig（通过 agentConfigSiteApp 表）

userConfig（用户偏好）
  └── (organizationId, userId) 唯一单行，含 permission JSONB
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
