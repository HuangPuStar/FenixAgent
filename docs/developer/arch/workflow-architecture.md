# Workflow 引擎架构设计

## 概述

Workflow 引擎是 FenixAgent 平台的 DAG（有向无环图）工作流编排系统，支持可视化编辑、多节点类型并行执行、事件溯源持久化和崩溃恢复。

整个系统采用**分层架构**：UI 层 → API 网关 → 服务层 → 引擎内核 → 数据层，通过多种通信协议串联。

编辑器内嵌 Chat 面板，通过事件机制和消息队列实现上下文感知交互。详见[§1.1.1 Chat 与 Workflow 交互](#111-chat-与-workflow-交互)。

```mermaid
graph TB
    subgraph UI["🖥 UI 层 — 用户交互入口"]
        direction LR

        subgraph UI_DAG["工作流编辑器"]
            DAG_EDITOR["DAG 画布<br/>拖拽节点 + 连线编排<br/>YAML 编辑 / 版本管理 / 触发器配置"]
        end

        subgraph UI_CHAT["Agent Chat"]
            CHAT["对话式交互<br/>用自然语言描述需求<br/>AI 自动生成工作流 YAML"]
        end

        subgraph UI_MONITOR["运行监控"]
            MONITOR["实时状态面板<br/>DAG 执行进度 / 节点输出<br/>人工审批 / 重跑与恢复"]
        end

        CHAT -->|"注入 YAML"| DAG_EDITOR
        DAG_EDITOR -->|"触发运行"| MONITOR
    end

    subgraph API["📡 应用层 — API 网关"]
        API_REST["Workflow REST API<br/>定义管理 + 版本控制<br/>运行 / 审批 / 恢复"]
        API_SSE["SSE（Server-Sent Events）实时通道<br/>执行事件推送<br/>断线重连"]
    end

    subgraph SVC["⚙ 服务层 — 业务编排"]
        direction LR
        FACTORY["Engine 实例管理<br/>per-org 缓存 + Agent 实例生命周期"]
        EVENTBUS["事件总线<br/>per-workflow 运行时事件发布"]
        STORAGE["持久化适配<br/>事件溯源 + 快照 + 节点输出"]
    end

    subgraph ENGINE["🧠 引擎内核"]
        direction LR
        PARSE["解析 & 校验<br/>YAML → 拓扑排序 → 表达式求值"]
        SCHEDULER["DAG 调度器<br/>状态机驱动的并行调度"]
        EXECUTORS["9 种执行器<br/>shell / python / agent / api<br/>audit / workflow / loop<br/>transform / custom"]
        RECOV["崩溃恢复<br/>快照重放 → 孤儿清理 → 重新调度"]
    end

    subgraph DATA["💾 数据层"]
        direction LR
        PG[("PostgreSQL<br/>运行时数据<br/>(事件 · 快照 · 输出 · 运行记录)")]
        FS[("对象存储<br/>工作流定义<br/>(文件系统 / S3)<br/>(draft.yaml · v1.yaml · v2.yaml)")]
    end

    %% UI → API
    DAG_EDITOR -->|"管理 / 运行"| API_REST
    MONITOR -.->|"实时订阅"| API_SSE
    MONITOR -->|"审批 / 重跑"| API_REST

    %% API → SVC
    API_REST --> FACTORY
    API_SSE --> EVENTBUS

    %% SVC ↔ Engine
    FACTORY -->|"创建 & 注入依赖"| ENGINE
    SCHEDULER -.->|"发布事件"| EVENTBUS
    EVENTBUS -.->|"推送"| API_SSE

    %% Engine → Data
    SCHEDULER -->|"事件 / 快照 / 输出"| STORAGE
    STORAGE --> PG
    PARSE -.->|"加载 YAML 定义"| FS

    %% YAML 持久化：编辑器通过 API 写入存储层
    DAG_EDITOR --> API_REST --> FS
```

---

## 1. 分层架构

### 1.1 UI 层

前端提供三个核心页面组成工作流的交互闭环：

| 页面 | 功能 |
|------|------|
| **工作流列表** | 浏览、创建、删除工作流，支持搜索和批量恢复 |
| **DAG 编辑器**（核心） | 可视化拖拽编排节点和连线、YAML 编辑、版本发布、触发器管理 |
| **版本历史** | 浏览所有发布版本、查看 YAML 内容、恢复历史版本到草稿 |

**编辑器核心能力**：

- **画布交互** — 拖拽添加节点、连线添加依赖（自动补全 inputs）、删除、ID 变更
- **持久化** — YAML 双向序列化/反序列化、3s 防抖自动保存草稿、导入/导出 YAML 文件
- **运行控制** — dryRun 校验、run 执行、2s 轮询快照、取消/审批/从节点重跑
- **数据流感知** — 自动扫描 `${{ nodes.X.output.Y }}` 表达式，在画布上生成绿色数据流边

#### 1.1.1 Chat 与 Workflow 交互

Chat 和 Workflow 编辑器之间**仅存在前端层面的数据传递，后端无任何耦合**。两者的交互完全发生在浏览器端，后端 API 各自独立运行。

```mermaid
graph LR
    subgraph WF["Workflow 编辑器"]
        PROPS["scenePrompt + contextKey + Chat 通信回调"]
        QUEUE["Context Queue"]
    end

    subgraph CHAT["Chat 面板"]
        SEND["发送前合并上下文"]
    end

    PROPS -->|"Props 传递"| CHAT
    QUEUE -->|"push → flush"| CHAT
    ON_COMPLETE["Chat 通信回调<br/>回复完成 → 刷新草稿"] -->|"刷新草稿"| WF
```

**交互机制**：

Workflow 编辑器通过事件机制将上下文变化推送到 Chat 端（选中节点、运行事件、校验/保存错误等），Chat 组件内部维护一个消息队列，在用户每次发送消息前将队列中的上下文一次性取出并合并到消息体中，确保 Agent 能感知编辑器的实时状态。

**后端独立性**：

- Chat 面板使用通用的 Agent Chat 后端 API（`/acp/relay`），不依赖任何 Workflow 专用接口
- Workflow 编辑器使用 Workflow REST API，不依赖任何 Chat 专用接口
- 两者可以独立部署、独立开发、独立替换，互不影响

---

### 1.2 应用层 (API)

#### 1.2.1 REST API

所有 API 通过统一的**认证插件**进行多租户隔离，从请求上下文提取 `{ userId, organizationId }`。

```mermaid
graph TB
    subgraph AUTH["认证 & 上下文"]
        AT["认证: Cookie / API Key / Environment Secret"]
        CTX["提取: { userId, organizationId }"]
    end

    subgraph REST["REST API"]
        WDEF["工作流定义<br/>列表 / 创建 / 详情 / 保存草稿<br/>发布版本 / 删除 / 恢复<br/>版本管理 / 触发器配置"]
        WRUN["运行控制<br/>run 执行 / dryRun 校验<br/>取消 / 审批节点<br/>事件列表 / 节点输出<br/>恢复 / 从节点重跑"]
    end

    subgraph STREAM["实时通道"]
        WSSE["SSE 事件流<br/>实时推送执行事件<br/>支持断线重连"]
    end

    AT --> WDEF
    AT --> WRUN
    AT --> WSSE
    CTX --> WDEF
    CTX --> WRUN
```

#### 1.2.2 实时事件推送 (SSE)

应用层通过 SSE 实现 Workflow 执行事件的实时推送：

```mermaid
sequenceDiagram
    participant Editor as 前端编辑器
    participant SSE as SSE 端点
    participant Bus as EventBus
    participant Engine as 工作流引擎
    participant Storage as 持久化存储

    Note over Editor,Storage: 建立连接
    Editor->>SSE: 订阅工作流事件流
    SSE->>Bus: 注册监听
    Bus-->>SSE: 连接建立
    SSE-->>Editor: 连接就绪

    Note over Editor,Storage: 运行工作流
    Editor->>Engine: 发起运行
    Engine->>Engine: 调度执行
    Engine->>Bus: 发布 run_started
    Bus->>SSE: 推送事件
    SSE-->>Editor: 运行已启动

    loop 节点执行
        Engine->>Bus: 发布节点事件
        Bus->>SSE: 推送事件
        SSE-->>Editor: 节点状态更新
    end

    Engine->>Bus: 发布 run_completed
    Bus->>SSE: 推送事件
    SSE-->>Editor: 运行已完成

    Note over Editor,Storage: 断线重连
    Editor->>SSE: 重新订阅 (含上次序号)
    SSE->>Bus: 从指定序号重放
    Bus-->>SSE: 补发事件
    SSE-->>Editor: 回放完成

    Note over Editor,Storage: 心跳保活
    loop 每 15 秒
        SSE-->>Editor: 心跳
    end
```

---

### 1.3 引擎内核层

引擎内核是一个独立的模块，通过接口与外部系统解耦，内部形成一个**解析 → 调度 → 执行 → 持久化**的清晰流水线：

```mermaid
graph TB
    ENTRY["run(yaml, params)"] --> PARSE

    subgraph PARSE["① 解析"]
        direction TB
        YAML["YAML 解析"] --> VALID["DAG 校验<br/>环检测 + 依赖补全"]
        VALID --> EXPR["表达式求值<br/>${{ nodes.X.output }}"]
        EXPR --> INPUT["输入解析 + 环境变量注入"]
    end

    PARSE --> SCHEDULER

    subgraph SCHEDULER["② 调度"]
        direction TB
        TOPO["拓扑排序 + 并行分组"] --> LOOP["状态机循环: findReady → 并行执行 → 保存快照"]
        LOOP --> RESULT["{ dagStatus, nodeOutputs }"]
    end

    SCHEDULER --> EXEC

    subgraph EXEC["③ 执行器"]
        direction LR
        LOCAL["本地执行<br/>shell · python · transform"]
        REMOTE["远程执行<br/>agent · api"]
        WAIT["等待型<br/>audit (审批挂起)"]
        NESTED["嵌套型<br/>workflow · loop"]
        PLUGIN["插件型<br/>custom"]
    end

    SCHEDULER --> STORE
    LOCAL --> STORE
    REMOTE --> STORE
    WAIT --> STORE
    NESTED --> STORE
    PLUGIN --> STORE

    subgraph STORE["④ 持久化"]
        direction LR
        EVENT["事件流<br/>dag.* / node.*"]
        SNAP["快照<br/>nodeStates JSONB"]
        OUTPUT["节点输出<br/>stdout + json + exitCode"]
    end

    REMOTE -->|"Agent 节点"| COMM
    subgraph COMM["⑤ 通信接口"]
        TRANSPORT["Transport<br/>连接 Agent 会话"]
        SESSION["AgentSession<br/>执行提示词 / 取消"]
    end

    SNAP -.->|"恢复入口"| RECOV
    subgraph RECOV["⑥ 崩溃恢复"]
        direction LR
        REPLAY["快照加载 + 事件重放"] --> ORPHAN["孤儿节点检测"]
        ORPHAN --> RESUME["注入初始状态 → 重新调度"]
    end
    RESUME -.-> SCHEDULER

    COMM -.-> AGENT_RT["Agent 运行时<br/>(acp-link 进程)"]
```

---

## 2. DAG 执行模型

### 2.1 调度循环

DAGScheduler 是整个引擎的核心，采用**纯内存状态机**模型：

```mermaid
stateDiagram-v2
    [*] --> 初始化: 解析 YAML → 初始化节点状态(全部 PENDING)
    初始化 --> 发布dag.started: 记录 params 用于恢复
    发布dag.started --> 创建初始快照
    创建初始快照 --> 主循环

    state 主循环 {
        [*] --> 检查取消
        检查取消 --> findReadyNodes: 未取消
        检查取消 --> 发布dag.cancelled: 已取消
        findReadyNodes --> 检查运行中
        检查运行中 --> 等待完成: 无 READY 且有 RUNNING
        检查运行中 --> 并行执行: 有 READY 节点
        并行执行 --> 处理结果: 等待所有节点完成
        处理结果 --> 发布事件: 每个节点的 started/completed/failed
        发布事件 --> 快照保存: 每次节点完成后
        快照保存 --> 检查取消: 循环继续
        检查运行中 --> 发布dag.completed: 无 READY 且无 RUNNING
    }

    发布dag.completed --> 创建最终快照
    创建最终快照 --> [*]
    发布dag.cancelled --> [*]
```

**关键调度特性**：

- **并行扇出**：同层级无依赖的节点同时执行
- **错误传播**：节点失败时 BFS（广度优先搜索）遍历下游 → 标记所有下游节点为 `SKIPPED` → 其他分支继续执行
- **条件执行**：`condition: "${{ params.go }}"` 通过表达式求值判断是否跳过
- **输出注入**：节点声明 `outputs.pattern` 在执行成功后求值，合并到 `output.json`

### 2.2 节点生命周期

```mermaid
stateDiagram-v2
    [*] --> PENDING: DAG 初始化
    PENDING --> RUNNING: 依赖全部 COMPLETED + condition 为 true
    PENDING --> SKIPPED: condition 为 false
    RUNNING --> COMPLETED: 执行成功 (exit_code=0)
    RUNNING --> FAILED: 执行失败 (exit_code≠0)
    RUNNING --> RETRYING: 失败且有 retry 配置
    RETRYING --> RUNNING: 指数退避后重试
    RUNNING --> CANCELLED: 取消管理器触发取消
    FAILED --> PENDING: 恢复模式下有 retry 配置
    COMPLETED --> [*]
    FAILED --> [*]
    SKIPPED --> [*]
    CANCELLED --> [*]
```

### 2.3 表达式引擎

手写递归下降解析器，支持以下语法：

```javascript
// 命名空间
nodes.<id>.output.xxx     // 上游节点输出
nodes.<id>.status         // 节点执行状态
params.xxx                // 工作流参数
secrets.KEY               // 声明的密钥 (运行时从环境变量解析)

// 数据结构
nodes.step1.output.stdout           // 标量
nodes.step1.output.messages[0]      // 数组索引

// 运算符
==  !=  >  <  >=  <=  &&  ||  +  !

// 三元
condition ? value1 : value2

// 模板拼接
"${{ params.outdir }}/${{ params.filename }}.txt"
```

**安全限制**：
- 表达式最大长度 1024 字符
- 访问深度限制 10 层
- 禁止 `__proto__`、`constructor`、`prototype` 访问
- 仅允许 `nodes`、`params`、`secrets` 根命名空间

---

## 3. 事件溯源与崩溃恢复

### 3.1 事件模型

系统通过**事件 → 快照 → 节点输出**三层存储实现完整的审计追溯和状态重建：

```mermaid
graph LR
    subgraph "事件流 (workflow_event)"
        EVT1["dag.started<br/>+ params"]
        EVT2["node.started<br/>+ nodeId + metadata"]
        EVT3["node.completed<br/>+ output summary"]
        EVT4["dag.completed<br/>+ final status"]
        EVT5["dag.cancelled<br/>+ cancel reason"]
    end

    subgraph "快照 (workflow_snapshot)"
        SNAP1["eventId=1<br/>nodeStates: {step1:PENDING}"]
        SNAP2["eventId=2<br/>nodeStates: {step1:RUNNING}"]
        SNAP3["eventId=3<br/>nodeStates: {step1:COMPLETED}"]
    end

    subgraph "节点输出 (workflow_node_output)"
        OUT["runId + nodeId<br/>stdout + json + exitCode + size"]
    end

    EVT1 --> SNAP1
    EVT2 --> SNAP2
    EVT3 --> SNAP3
    EVT3 --> OUT
    EVT4 -->|"最终快照"| SNAP3
```

### 3.2 崩溃恢复流程

```mermaid
sequenceDiagram
    participant Client as 前端/API
    participant Engine as 工作流引擎
    participant Storage as 持久化存储
    participant Recovery as 快照恢复器
    participant Scheduler as DAG 调度器

    Client->>Engine: recover(runId, yaml)
    Engine->>Storage: 获取最新快照
    Storage-->>Engine: snapshot (含 lastEventId + nodeStates)
    Engine->>Storage: 获取后续事件
    Storage-->>Engine: 事件列表
    Engine->>Recovery: 执行恢复(快照, 事件, yaml, params)
    Recovery->>Recovery: 重放事件 → 更新节点状态
    Recovery->>Recovery: 检测孤儿节点 (有 started 无完成事件)
    alt 孤儿节点: shell
        Recovery->>Recovery: 终止进程 (SIGTERM)
    else 孤儿节点: agent
        Recovery->>Recovery: 标记 CANCELLED
    else 孤儿节点: 有 retry 配置
        Recovery->>Recovery: 标记 PENDING (重试)
    end
    Recovery->>Scheduler: 从断点继续调度
```

**rerunFrom**（从指定节点重跑）：
1. 从原 run 的 dag.started 事件获取原始 params
2. BFS（广度优先搜索）查找 `fromNodeId` 的下游节点
3. 保留上游 COMPLETED 节点的 output
4. 生成新 `runId`，仅重跑下游子图

---

## 4. 数据模型

### 4.1 核心实体关系

```mermaid
erDiagram
    Organization ||--o{ Workflow : "拥有"
    Workflow ||--o{ WorkflowVersion : "版本"
    Workflow ||--o{ WorkflowRun : "执行记录"
    WorkflowRun ||--o{ WorkflowEvent : "事件溯源"
    WorkflowRun ||--o{ WorkflowSnapshot : "状态快照"
    WorkflowRun ||--o{ WorkflowNodeOutput : "节点输出"
    Workflow ||--o{ WorkflowTrigger : "触发器"
    WorkflowTrigger ||--o{ WorkflowRun : "触发产生"
    Organization ||--o{ WorkflowBoard : "拥有"
    WorkflowBoard ||--o{ WorkflowJob : "包含"
    WorkflowJob }o--|| WorkflowVersion : "绑定"
```

### 4.2 存储架构

工作流定义（YAML）存储在可替换的对象存储后端（默认为文件系统，可通过 S3 适配器扩展），运行时数据存储在 PostgreSQL。其中 `JSONB` 是 PostgreSQL 的二进制 JSON 数据类型，允许在字段上建索引和高效查询。

```
对象存储 (文件系统 / S3):
  .agents/workflows/<organizationId>/<workflowId>/
  ├── draft.yaml             # 当前编辑草稿
  ├── v1.yaml                # 已发布版本 1 (不可变)
  ├── v2.yaml                # 已发布版本 2
  └── ...

PostgreSQL:
├── workflow               # 元数据 + latestVersion + storagePath
├── workflow_version       # 版本记录 (status: draft | published)
├── workflow_run           # 运行摘要 (status, input, output JSONB)
├── workflow_event         # 事件溯源 (eventId, runId, type, metadata JSONB)
├── workflow_snapshot      # 状态快照 (nodeStates JSONB, dagStatus)
├── workflow_node_output   # 节点输出 (stdout TEXT, json JSONB, exitCode)
├── workflow_board         # 看板面板
├── workflow_job           # 看板 Job (stage, status)
└── workflow_trigger       # Webhook 触发器 (publicHash UNIQUE, secret)
```

---

## 5. 独立部署方案

Workflow 引擎的核心模块本身解耦，可以直接作为独立服务运行。独立部署时，Workflow 引擎作为**纯编排引擎**，通过 API 与外部系统交互。

### 5.1 架构总览

```
┌──────────────────────────────────────────────────────┐
│                   Workflow 独立服务                    │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ REST API │  │   SSE    │  │ EventBus │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │             │             │                  │
│  ┌────▼─────────────▼─────────────▼─────┐            │
│  │          DAGScheduler                │            │
│  │  shell / python / agent / api        │            │
│  │  audit / workflow / loop / custom    │            │
│  └────────────────┬─────────────────────┘            │
│                   │                                  │
│  ┌────────────────▼─────────────────────┐            │
│  │  存储适配器 (PG / 内存)               │            │
│  │  事件溯源 + 快照 + 节点输出           │            │
│  └──────────────────────────────────────┘            │
└──────────────────────────────────────────────────────┘
         │【前端交互：scenePrompt + Context Queue + Chat 通信回调】
         ▼
┌──────────────────────────────────────────────────────┐
│                   外部 Chat 系统                      │
└──────────────────────────────────────────────────────┘
```

### 5.2 与外部 Chat 通信

独立部署后，外部 Chat 系统通过前端和后端两层与 Workflow 独立服务通信：

```mermaid
graph TB
    subgraph EXT["外部 Chat 系统"]
        subgraph EXT_FE["Chat 面板"]
            CHAT["Chat 组件"]
            SKILL["Workflow Skill"]
        end
    end

    subgraph WF["Workflow 独立服务"]
        subgraph WF_BE["后端"]
            WF_API["REST API + SSE"]
        end
        subgraph WF_FE["前端"]
            DAG["DAG 编辑器 + 运行监控"]
        end
        WF_BE --- WF_FE
    end

    CHAT --- SKILL

    %% 前端通信
    DAG -->|"scenePrompt + Context Queue"| CHAT
    CHAT -->|"Chat 通信回调"| DAG

    %% 后端通信
    SKILL -->|"Workflow REST API + SSE"| WF_API
```

**前端通信**：外部 Chat 面板以 `<iframe>` 嵌入 Workflow 编辑器，通过 Props（`scenePrompt`、`contextKey`、Chat 通信回调）和 Context Queue 双向通信，与 [1.1.1](#111-chat-与-workflow-交互) 模式一致。

**后端通信**：外部 Chat 基于 Workflow API Skill（`/.agents/skills/agent-platform-api/references/workflow.md`）调用 Workflow 独立服务的 REST API 和 SSE，进行工作流创建/编辑/运行/监控等操作。

### 5.3 工作流即 API 调用

独立部署后，外部系统可通过 `POST /api/workflows/:workflowId/execute` 像调用函数一样触发工作流。定义见 `src/schemas/api-workflow.schema.ts`。

**请求体**：

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `inputs` | object | 否 | 对应 YAML 中 `params` 定义的字段值 |
| `mode` | `"sync"` / `"async"` | 否 | 默认 `sync` |
| `version` | number | 否 | 指定工作流版本号，不传使用 `latestVersion` |
| `timeout` | number | 否 | sync 模式最大等待秒数，默认 300，上限 3600 |

**响应输出**：

| mode | 字段 | 说明 |
|------|------|------|
| **sync** | `runId`、`status`、`version`、`duration`、`output?`、`error?` | 阻塞等待完成。`status` 为 `SUCCESS` / `FAILED` / `TIMEOUT` |
| **async** | `runId`、`version` | 立即返回，后续通过 `/web/workflow-engine` 异步查询结果 |

### 5.4 YAML 工作流定义

Workflow 引擎通过 YAML 声明式定义 DAG 编排逻辑。完整的 API 参考、YAML Schema、节点类型定义及故障排查，参见 Workflow API Skill（`/.agents/skills/agent-platform-api/references/workflow.md`）。
