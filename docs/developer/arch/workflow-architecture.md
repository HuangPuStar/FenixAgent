# Workflow 引擎架构设计

## 概述

Workflow 引擎是 FenixAgent 平台的 DAG（有向无环图）工作流编排系统，支持可视化编辑、多节点类型并行执行、事件溯源持久化和崩溃恢复。

整个系统采用**分层架构**：UI 层 → API 网关 → 服务层 → 引擎内核 → 数据层，通过多种通信协议串联。

编辑器内嵌 Chat 面板，通过 `scenePrompt` 和 `Context Queue` 两种机制实现上下文感知交互。详见[§1.1.1 Chat 与工作流编辑器的交互](#111-chat-与工作流编辑器的交互)。

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
        TRANSPORT["Agent 通信通道<br/>与 Agent 进程的 JSON-RPC 连接"]
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

    subgraph AGENT["🤖 Agent 运行时"]
        INSTANCE["Environment Instance<br/>(acp-link 进程)"]
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

    %% Engine → Agent (agent 节点执行路径)
    EXECUTORS -->|"需调用 Agent 时"| TRANSPORT
    TRANSPORT -->|"启动实例 + 建立连接"| INSTANCE

    %% YAML 持久化：编辑器通过 API 写入存储层
    DAG_EDITOR --> API_REST --> FS
```

**核心设计原则**：

1. **"文件夹即项目"** — 用户产出物（YAML）是纯文件，可通过 git 版本控制；存储层通过文件系统或 S3 适配，运行时数据通过数据库持久化
2. **事件溯源（Event Sourcing）** — 状态从事件流重建，支持崩溃恢复和审计追溯
3. **调度与存储分离** — DAGScheduler 纯内存执行，通过 StorageAdapter 接口与数据库交互

**关键设计决策**：

| 决策 | 理由 | 影响 |
|------|------|------|
| **"文件夹即项目"** | YAML 产物是纯文件，可通过 git 版本控制 | 工作流定义天然可审计和回滚 |
| **事件溯源** | 状态从事件流 + 快照重建 | 支持崩溃恢复、断线重连、审计追溯 |
| **纯内存调度** | DAGScheduler 状态在内存，通过接口写 DB | 调度性能不受 DB 延迟影响 |
| **Transport 接口抽象** | 引擎不感知具体通信协议 | 可替换通信层（如 gRPC、本地调用） |
| **StorageAdapter 接口抽象** | 引擎不依赖具体数据库 | 测试用内存实现，生产用 PG |
| **per-org Engine 缓存** | 按 orgId 缓存 `{engine, transport}` | 避免跨组织数据泄露，减少重复创建开销 |
| **Secrets 脱敏** | 事件 metadata 中脱敏 secrets | 避免密钥在事件流中泄露 |

---

## 1. 分层架构

### 1.1 UI 层

前端提供三个核心页面组成工作流的交互闭环：

| 页面 | 功能 |
|------|------|
| **工作流列表** | 浏览、创建、删除工作流，支持搜索和批量恢复 |
| **DAG 编辑器**（核心） | 可视化拖拽编排节点和连线、YAML 编辑、版本发布、触发器管理 |
| **版本历史** | 浏览所有发布版本、查看 YAML 内容、恢复历史版本到草稿 |

**编辑器布局**：

```
┌──────────────────────────────────────────────────────────────────┐
│  工具栏: [新建] [自动布局] [保存] [YAML] [校验] [运行] [版本]    │
├───────────┬────────────────────────────────┬────────────────────┤
│ 节点面板   │         DAG 画布               │ 运行状态面板         │
│┌─────────┐│   ┌───┐  ────  ┌───┐           │ ┌────────────────┐ │
││ shell   ││   │ A ├───────►│ B │           │ │ DAG 状态: 3/5  │ │
││ python  ││   └───┘        └─┬─┘           │ │ 进度: ██████░░ │ │
││ agent   ││                  │             │ │ 事件流         │ │
││ api     ││         - - - -  ▼             │ │ node_1 ✓       │ │
││ audit   ││   ┌───┐       ┌───┐            │ │ node_2 ✓       │ │
││ workflow││   │ D │- - - -│ C │            │ │ node_3 ⏳      │ │
││ loop    ││   └───┘       └───┘            │ └────────────────┘ │
││ transform││   逻辑边: ────                  │                    │
││ custom  ││   数据流边: - - -               │                    │
│└─────────┘│                               │                    │
│ 变换预设   │                               │                    │
│ extract   │                               │                    │
│ filter    │                               │                    │
│ merge     │                               │                    │
│ sort      │                               │                    │
├───────────┴────────────────────────────────┴────────────────────┤
│ 属性编辑浮层: 节点配置 / 版本管理 / 触发器 / YAML 源码            │
├──────────────────────────────────────────────────────────────────┤
│ 弹窗层: 运行参数分组输入 / 元数据(名称/描述/超时/密钥)             │
└──────────────────────────────────────────────────────────────────┘
│ Meta Agent Chat 面板 (左侧可折叠)                                 │
└──────────────────────────────────────────────────────────────────┘
```

**编辑器核心能力**：

- **画布交互** — 拖拽添加节点、连线添加依赖（自动补全 inputs）、删除、ID 变更
- **持久化** — YAML 双向序列化/反序列化、3s 防抖自动保存草稿、导入/导出 YAML 文件
- **运行控制** — dryRun 校验、run 执行、2s 轮询快照、取消/审批/从节点重跑
- **数据流感知** — 自动扫描 `${{ nodes.X.output.Y }}` 表达式，在画布上生成绿色数据流边

#### 1.1.1 Chat 与工作流编辑器的交互

编辑器将 Chat 面板**直接内嵌**在左侧。用户可在编辑工作流的同时与 Agent 对话，Agent 能感知编辑器中的实时上下文（选中节点、运行状态、错误信息）。

**嵌入架构**

Chat 和 Workflow 之间通过两条路径双向通信：

```mermaid
graph LR
    subgraph WF["编辑器侧"]

        subgraph Props["组件 Props（静态上下文）"]
            SCENE["scenePrompt<br/>workflow ID + 名称 + 描述"]
            CTX_KEY["contextKey (workflowId)<br/>切换时自动新会话"]
            ON_COMPLETE["onPromptComplete<br/>Chat 回复完成 → 刷新草稿"]
        end

        subgraph Queue["Context Queue（动态上下文）"]
            QC_EDIT["编辑器选中状态<br/>当前选中节点 ID + 类型"]
            QC_EVENT["运行时事件<br/>运行摘要 + 错误信息"]
        end
    end

    subgraph CHAT["Chat 侧"]
        SEND["发送消息前<br/>合并上下文到消息块"]
        FLUSH["清空队列<br/>确保每次事件只注入一次"]
    end

    Props -->|"Props 传递"| CHAT
    Queue -->|"push → flush"| CHAT
    CHAT -->|"封装在 &lt;system-reminder&gt; 中"| SEND
    SEND -->|"发送消息"| ACP
    ON_COMPLETE -->|"回复完成 → 刷新草稿"| WF
```

**上下文注入机制**

Chat 在每次发送用户消息前，会将工作流上下文注入到消息体的最前端。注入内容对用户不可见，封装在 `<system-reminder>` 标签中。

**场景提示词（scenePrompt）— 仅首次**

在第一条消息时注入，包含工作流的基本元信息：

```
[Workflow Context]
- Workflow ID: wf_abc123
- Workflow Name: 数据分析流水线
- Workflow Description: 从数据库提取数据，进行清洗和聚合分析
You can describe a workflow in natural language and I will help you create and modify the DAG diagram.
```

**上下文队列（Context Queue）— 每次发送前**

全局队列存储工作流上下文片段，编辑器运行时推入，Chat 在发送前一次性取出并清空。

**推送来源**：

| 推送时机 | 内容 |
|---------|------|
| 用户选中/切换节点 | `[Workflow Editor Context]`：工作流名称 + 选中节点 ID/类型 |
| 运行状态变化 | `[Workflow Event]`：运行摘要（如 "Run Failed (3/5, 2 failed: node_1, node_2)"） |
| dryRun 校验失败 | `[Workflow Event]`：validation error 消息 |
| 保存草稿失败 | `[Workflow Event]`：save error 消息 |
| 发布版本失败 | `[Workflow Event]`：publish error 消息 |

Chat 侧消费时的合并格式：

```
<system-reminder>
[Workflow Editor Context]
- Workflow Name: 数据分析流水线
- Selected Node: node_2 (type: agent)

[Workflow Event]
Run Status: Run Failed (3/5 completed, 2 failed: node_1, node_2)
Error (validation): Node 'node_3' depends_on references unknown node 'node_x'
</system-reminder>
```

**Chat 回复完成回调**

Chat 每结束一轮 prompt 回复，通知编辑器刷新草稿，确保 Agent 在对话中生成或修改的 YAML 已被后端持久化后，编辑器能从存储层重新加载最新内容。

**Meta Agent 辅助创建**

```mermaid
sequenceDiagram
    participant User as 用户
    participant Editor as 编辑器
    participant MetaAgent as Meta Agent
    participant API as Meta Agent API
    participant FS as 存储层

    User->>Editor: 打开工作流编辑器
    Editor->>MetaAgent: 启用 Chat 面板
    User->>MetaAgent: 输入需求描述
    MetaAgent->>MetaAgent: 生成场景上下文
    MetaAgent->>API: 请求生成工作流
    API-->>MetaAgent: 生成的 YAML
    MetaAgent->>Editor: 注入 YAML 到画布
    Editor->>Editor: 刷新 DAG 画布
    User->>Editor: 手动调整节点/连线
    Editor->>API: 保存草稿
    API->>FS: 持久化 YAML
    API-->>Editor: 保存成功
```

**Meta Agent 核心机制**：

- `scenePrompt` 包含 `workflowId`、`name`、`description` 等上下文
- Meta Agent 本身是一个 Agent Environment，具备生成 YAML 的能力
- 生成的 YAML 直接注入编辑器，用户可后续手动调整

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

### 2.4 Agent 节点

`agent` 类型节点是工作流执行 LLM 推理任务的核心方式：

```yaml
nodes:
  - id: analyze_data
    type: agent
    agent: "data-analyst"       # Agent Environment 名称 (非 AgentConfig)
    prompt: |
      分析以下数据并生成报告:
      ${{ nodes.fetch_data.output.json }}
    depends_on: [fetch_data]
    timeout: 600
    retry:
      count: 2
      delay: 1000
      backoff: exponential
    outputs:
      report:
        pattern: "${{ nodes.analyze_data.output.messages[-1].content }}"
        type: "string"
```

**关键设计**：
- `agent` 字段指向 **Environment 名称**（通过组织 ID + 名称查找），而非 AgentConfig ID
- prompt 支持 `${{ }}` 表达式，可引用上游节点输出和工作流参数
- 通过 ACP 协议与 Agent 进程通信
- 支持重试机制（指数退避），节点超时和 DAG 取消不重试

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

## 5. 后续演进方向

1. **分布式调度**：当前 DAGScheduler 是单进程调度，无法跨节点水平扩展。后续可引入消息队列（如 Redis Streams）实现分布式节点调度
2. **更丰富的条件控制**：表达式引擎当前仅支持基础运算符，可扩展为完整 DSL
3. **动态并行与 reduce**：支持动态基于上游输出的并行分支和聚合操作
4. **循环迭代增强**：loop 节点当前 break 条件较简单，可增强为完整的 for/while/do-while 三态
5. **快照压缩**：频繁快照积累大量数据，需要定期压缩策略
6. **工作流模板市场**：支持组织间分享工作流模板
