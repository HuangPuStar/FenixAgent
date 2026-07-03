# Workflow 引擎架构设计

## 概述

Workflow 引擎是 FenixAgent 平台的 DAG（有向无环图）工作流编排系统，支持可视化编辑、多节点类型并行执行、事件溯源持久化和崩溃恢复。

整个系统采用**四层一体的架构**：UI 层、应用层、服务层、引擎内核层，通过多种通信协议串联。

其中 UI 层的 **Chat 面板**与**工作流编辑器**深度集成，通过 `scenePrompt`（场景提示词）和 `Context Queue`（运行时上下文队列）两种机制，将工作流元信息、编辑器选中状态、运行结果实时注入 Chat 消息，使 Agent 能感知当前工作流的完整上下文。详见[第 4 章 Agent 创建工作流](#4-ui-层-chat-与工作流编辑器的交互)。

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
        API_SSE["SSE 实时通道<br/>执行事件推送<br/>断线重连"]
    end

    subgraph SVC["⚙ 服务层 — 业务编排"]
        direction LR
        FACTORY["Engine 工厂<br/>per-org 缓存 + 实例生命周期"]
        TRANSPORT["ACP Transport<br/>与 Agent 进程的 JSON-RPC 通道"]
        EVENTBUS["EventBus<br/>per-workflow 事件总线"]
        STORAGE["PG 持久化适配<br/>事件溯源 + 快照 + 节点输出"]
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
    TRANSPORT -->|"启动实例 + WS relay"| INSTANCE

    %% YAML 持久化
    DAG_EDITOR -->|"保存 / 发布"| FS
```

**核心设计原则**：

1. **"文件夹即项目"** — 用户产出物（YAML）是纯文件，可通过 git 版本控制；存储层通过文件系统或 S3 适配，运行时数据通过数据库持久化
2. **事件溯源（Event Sourcing）** — 状态从事件流重建，支持崩溃恢复和审计追溯
3. **调度与存储分离** — DAGScheduler 纯内存执行，通过 StorageAdapter 接口与数据库交互

---

## 1. 分层架构

### 1.1 UI 层

前端提供三个核心页面组成工作流的交互闭环：

| 页面 | 功能 |
|------|------|
| **工作流列表** | 浏览、创建、删除工作流，支持搜索和批量恢复 |
| **DAG 编辑器**（核心） | 可视化拖拽编排节点和连线、YAML 编辑、版本发布、触发器管理 |
| **版本历史** | 浏览所有发布版本、查看 YAML 内容、恢复历史版本到草稿 |

```mermaid
graph TB
    subgraph Editor["编辑器布局"]
        direction TB

        subgraph Canvas["画布区"]
            NODE["节点卡片<br/>(含运行状态条 + 输入/输出端口)"]
            EDGE["连线<br/>(逻辑边: 实线 / 数据流边: 虚线)"]
            LAYOUT["自动布局<br/>(自左向右 DAG 排列)"]
        end

        subgraph Panels["面板区"]
            direction LR
            PALETTE["节点面板<br/>基础节点 + 自定义工具 + 变换预设"]
            TOOLBAR["工具栏<br/>新建/布局/保存/YAML/校验/运行"]
            STATUS["运行状态面板<br/>DAG 执行进度 + 事件流 + 节点输出"]
        end

        subgraph Sheets["属性编辑浮层"]
            direction LR
            NC["节点配置<br/>类型特定参数编辑"]
            VP["版本管理<br/>发布/恢复/查看历史"]
            TP["触发器<br/>Webhook 配置"]
            YP["YAML 编辑<br/>源码编辑 & 双向同步"]
        end

        subgraph Dialogs["弹窗"]
            RP["运行参数<br/>分组输入 + 校验"]
            WM["元数据设置<br/>名称/描述/超时/密钥"]
        end
    end

    Canvas --> Panels
    Panels --> Sheets
    Panels --> Dialogs
```

**编辑器核心能力**：

- **画布交互** — 拖拽添加节点、连线添加依赖（自动补全 inputs）、删除、ID 变更
- **持久化** — YAML 双向序列化/反序列化、3s 防抖自动保存草稿、导入/导出 YAML 文件
- **运行控制** — dryRun 校验、run 执行、2s 轮询快照、取消/审批/从节点重跑
- **数据流感知** — 自动扫描 `${{ nodes.X.output.Y }}` 表达式，在画布上生成绿色数据流边

---

### 1.2 应用层 (API)

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

---

### 1.3 引擎内核层

引擎内核是一个独立的包，通过接口（`Transport`、`StorageAdapter`）与外部系统解耦，内部由四个核心模块组成：

```mermaid
graph TB
    subgraph FACADE["引擎门面"]
        EN["createWorkflowEngine()<br/>parse / validate / run / dryRun<br/>cancel / approveNode / recover"]
    end

    subgraph SCHEDULER["调度器"]
        DAGS["DAG 调度器<br/>拓扑排序 → 并行分组 → 状态机执行"]
        CANCEL["取消管理器<br/>AbortController 封装"]
    end

    subgraph EXEC["执行器 (9 种)"]
        SHELL["shell — 本地子进程执行"]
        PYTHON["python — Python 脚本<br/>(含 pip 依赖)"]
        AGENT["agent — Transport 接口<br/>→ ACP JSON-RPC"]
        API["api — HTTP 请求"]
        AUDIT["audit — HMAC token<br/>→ 挂起等待审批"]
        SUB["workflow — 子 DAG"]
        LOOP["loop — do-while 迭代"]
        TRANS["transform — 纯 JSON 变换"]
        CUSTOM["custom — 插件注册表"]
    end

    subgraph PARSE["解析器"]
        YAML["YAML 解析<br/>YAML → WorkflowDef"]
        VALID["DAG 校验<br/>环检测 + 依赖补全"]
        EXPR["表达式引擎<br/>${{ }} 递归下降解析"]
        INPUT["输入解析<br/>表达式求值 + 环境变量注入"]
    end

    subgraph STORE["存储接口"]
        SA["StorageAdapter (接口)<br/>事件 / 快照 / 节点输出<br/>原子提交 / 运行列表"]
        MEM["内存适配器 (测试)"]
    end

    subgraph COMM["通信接口"]
        TA["Transport (接口)<br/>连接 / 断开 Agent 会话"]
        ASE["AgentSession (接口)<br/>执行提示词 / 取消"]
    end

    subgraph RECOV2["恢复"]
        SR["快照恢复<br/>加载 → 重放 → 清理孤儿 → 重新调度"]
    end

    EN --> DAGS
    DAGS --> EXEC
    EN --> PARSE
    EN --> RECOV2
    EXEC --> COMM
    DAGS --> STORE
```

---

## 2. DAG 执行模型

### 2.1 调度循环

DAGScheduler 是整个引擎的核心，采用**纯内存状态机**模型：

```mermaid
stateDiagram-v2
    [*] --> 初始化: 解析 YAML → 初始化节点状态(全部 PENDING)
    初始化 --> 发射dag_started: 记录 params 用于恢复
    发射dag_started --> 创建初始快照
    创建初始快照 --> 主循环

    state 主循环 {
        [*] --> 检查取消
        检查取消 --> findReadyNodes: 未取消
        检查取消 --> 发射dag_cancelled: 已取消
        findReadyNodes --> 检查运行中
        检查运行中 --> 等待完成: 无 READY 且有 RUNNING
        检查运行中 --> 并行执行: 有 READY 节点
        并行执行 --> 处理结果: 等待所有节点完成
        处理结果 --> 发射事件: 每个节点的 started/completed/failed
        发射事件 --> 快照保存: 每次节点完成后
        快照保存 --> 检查取消: 循环继续
        检查运行中 --> 发射dag_completed: 无 READY 且无 RUNNING
    }

    发射dag_completed --> 创建最终快照
    创建最终快照 --> [*]
    发射dag_cancelled --> [*]
```

**关键调度特性**：

- **并行扇出**：同层级无依赖的节点同时执行
- **错误传播**：节点失败时 BFS 遍历下游 → 标记所有下游节点为 `SKIPPED` → 其他分支继续执行
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
    participant Engine as WorkflowEngine
    participant Storage as StorageAdapter
    participant Recovery as snapshot-recovery
    participant Scheduler as DAGScheduler

    Client->>Engine: recover(runId, yaml)
    Engine->>Storage: getLatestSnapshot(runId)
    Storage-->>Engine: snapshot (含 lastEventId + nodeStates)
    Engine->>Storage: getEvents(runId, { afterEventId, nodeId })
    Storage-->>Engine: 后续事件列表
    Engine->>Recovery: recoverRun(snapshot, events, yaml, params)
    Recovery->>Recovery: 重放事件 → 更新节点状态
    Recovery->>Recovery: 检测孤儿节点 (有 started 无完成事件)
    alt 孤儿节点: shell
        Recovery->>Recovery: process.kill(pid, SIGTERM)
    else 孤儿节点: agent
        Recovery->>Recovery: 标记 CANCELLED
    else 孤儿节点: 有 retry 配置
        Recovery->>Recovery: 标记 PENDING (重试)
    end
    Recovery->>Scheduler: new DAGScheduler(initialNodeStates + initialNodeOutputs)
    Scheduler-->>Engine: 从断点继续执行
    Engine-->>Client: 新的 runId
```

**rerunFrom**（从指定节点重跑）：
1. 从原 run 的 dag.started 事件获取原始 params
2. BFS 查找 `fromNodeId` 的下游节点
3. 保留上游 COMPLETED 节点的 output
4. 生成新 `runId`，仅重跑下游子图

---

## 4. UI 层 Chat 与工作流编辑器的交互

WorkflowEditor 将 Chat 面板**直接内嵌**在编辑器左侧。用户可在编辑工作流的同时与 Agent 对话，Agent 能感知编辑器中的实时上下文（选中节点、运行状态、错误信息）。

### 4.1 嵌入架构

Chat 和 Workflow 之间通过两条路径双向通信：

```mermaid
graph LR
    subgraph WF["WorkflowEditor 编辑器侧"]

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

    subgraph CHAT["ChatInterface（Chat 侧）"]
        SEND["handleSend()<br/>发送消息前<br/>合并上下文到 contentBlocks"]
        FLUSH["flushContext()<br/>消费后清空队列<br/>确保每次事件只注入一次"]
    end

    Props -->|"组件 Props 传递"| CHAT
    Queue -->|"pushContext() → flushContext()"| CHAT
    CHAT -->|"隐藏封装在 &lt;system-reminder&gt; 中"| SEND
    SEND -->|"client.sendPrompt()"| ACP
    ON_COMPLETE -->|"Chat 回复完成"| WF
```

### 4.2 上下文注入机制

Chat 在每次发送用户消息前（`ChatInterface.handleSend()`），会将工作流上下文注入到消息的 `contentBlocks` 最前端。注入内容对用户不可见，封装在 `<system-reminder>` 标签中。

#### 场景提示词（scenePrompt）— 仅首次

由 `useWorkflowMetaAgent` 生成，在第一条消息时注入，包含工作流的基本元信息：

```
[Workflow Context]
- Workflow ID: wf_abc123
- Workflow Name: 数据分析流水线
- Workflow Description: 从数据库提取数据，进行清洗和聚合分析
You can describe a workflow in natural language and I will help you create and modify the DAG diagram.
```

#### 上下文队列（Context Queue）— 每次发送前

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

#### Chat 回复完成回调

Chat 每结束一轮 prompt 回复，通知编辑器刷新草稿，确保 Agent 在对话中生成或修改的 YAML 已被后端持久化后，编辑器能从存储层重新加载最新内容。

### 4.3 Meta Agent 辅助创建

```mermaid
sequenceDiagram
    participant User as 用户
    participant Editor as WorkflowEditor
    participant MetaAgent as Meta Agent Chat
    participant API as /web/meta-agent
    participant Engine as WorkflowEngine
    participant FS as 文件系统

    User->>Editor: 打开 "/agent/workflow/$id/edit"
    Editor->>MetaAgent: 启用 Meta Agent 侧栏
    User->>MetaAgent: 输入需求描述
    MetaAgent->>MetaAgent: 生成 scenePrompt(workflowId + name + desc)
    MetaAgent->>API: POST /web/meta-agent (generateWorkflow)
    API-->>MetaAgent: 生成的工作流 YAML
    MetaAgent->>Editor: 注入 YAML 到编辑器
    Editor->>Editor: yamlToFlow() → 更新 DAG 画布
    User->>Editor: 手动调整节点/连线
    Editor->>API: PUT /web/workflow-defs/:id/draft (保存草稿)
    API->>FS: writeYamlFile(draft.yaml)
    API-->>Editor: { success: true }
```

**Meta Agent 核心机制** (`useWorkflowMetaAgent`)：

- `scenePrompt` 包含 `workflowId`、`name`、`description` 等上下文
- Meta Agent 本身是一个 Agent Environment，具备生成 YAML 的能力
- 生成的 YAML 直接注入编辑器，用户可后续手动调整
- Meta Agent 的 Environment 实例通过 `meta-agent.ts` API 管理

### 4.4 Agent 节点在工作流中的角色

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
- `agent` 字段指向 **Environment 名称**（通过 `orgId + name` 查找），而非 AgentConfig ID
- prompt 支持 `${{ }}` 表达式，可引用上游节点输出和工作流参数
- 通过 ACP JSON-RPC 协议与 Agent 进程通信（见第 5 节）
- 默认 2 次指数退避重试，节点超时和 DAG 取消不重试

---

## 5. Workflow 建立沟通的设计

### 5.1 三层通信架构

```mermaid
graph TB
    subgraph "前端通信"
        UI_REST["REST API<br/>工作流 CRUD + 运行控制"]
        UI_SSE["SSE 事件流<br/>/web/workflow/:id/events"]
        UI_POLL["轮询<br/>2s 间隔获取快照"]
    end

    subgraph "引擎通信"
        ENG_RPC["JSON-RPC 2.0<br/>Engine ↔ Agent 进程"]
        ENG_ACP["ACP 协议 WS<br/>session/new + session/prompt"]
        ENG_EVENT["EventBus<br/>per-workflow 事件发布"]
    end

    subgraph "外部集成"
        EXT_WEBHOOK["Webhook<br/>POST /hooks/:publicHash"]
        EXT_TRIGGER["Scheduled Tasks<br/>cron 触发工作流"]
    end

    UI_REST -->|"fetch()"| API
    UI_SSE -->|"EventSource"| API
    UI_POLL -->|"GET /workflow-runs/:runId"| API
    ENG_RPC -->|"ACPProtocol"| ACP
    ENG_ACP -->|"WebSocket relay"| ACP
    ENG_EVENT -->|"subscribe + publish"| BUS
```

### 5.2 实时事件推送架构

```mermaid
sequenceDiagram
    participant Editor as 前端 WorkflowEditor
    participant SSE_API as SSE 端点
    participant EventBus as Per-workflow EventBus
    participant Engine as WorkflowEngine
    participant Storage as PgStorageAdapter

    Note over Editor,Storage: 建立连接
    Editor->>SSE_API: GET /web/workflow/:id/events (EventSource)
    SSE_API->>EventBus: subscribe(workflowId)
    EventBus-->>SSE_API: 连接建立
    SSE_API-->>Editor: event: connected

    Note over Editor,Storage: 运行工作流
    Editor->>Engine: POST /web/workflow-runs → run(yaml)
    Engine->>Engine: DAGScheduler.run()
    Engine->>EventBus: publish(workflowId, "run_started")
    EventBus->>SSE_API: push event
    SSE_API-->>Editor: data: { type: "run_started", runId, ... }

    loop 节点执行
        Engine->>EventBus: publish(workflowId, "node_events")
        EventBus->>SSE_API: push event
        SSE_API-->>Editor: data: { type: "node_completed", nodeId, ... }
    end

    Engine->>EventBus: publish(workflowId, "run_completed")
    EventBus->>SSE_API: push event
    SSE_API-->>Editor: data: { type: "run_completed", status, ... }

    Note over Editor,Storage: 断线重连
    Editor->>SSE_API: GET /web/workflow/:id/events?fromSeqNum=42
    SSE_API->>EventBus: getEventsSince(42)
    EventBus-->>SSE_API: 重放事件
    SSE_API-->>Editor: 补发丢失的事件

    Note over Editor,Storage: 心跳保活
    loop 每 15 秒
        SSE_API-->>Editor: :keepalive
    end
```

---

## 6. 数据模型

### 6.1 核心实体关系

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

### 6.2 存储架构

工作流定义（YAML）存储在可替换的对象存储后端（默认为文件系统，可通过 S3 适配器扩展），运行时数据存储在 PostgreSQL。

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

## 7. 关键设计决策

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

## 8. 后续演进方向

1. **分布式调度**：当前 DAGScheduler 是单进程调度，无法跨节点水平扩展。后续可引入消息队列（如 Redis Streams）实现分布式节点调度
2. **更丰富的条件控制**：表达式引擎当前仅支持基础运算符，可扩展为完整 DSL
3. **动态并行与 reduce**：支持动态基于上游输出的并行分支和聚合操作
4. **循环迭代增强**：loop 节点当前 break 条件较简单，可增强为完整的 for/while/do-while 三态
5. **快照压缩**：频繁快照积累大量数据，需要定期压缩策略
6. **工作流模板市场**：支持组织间分享工作流模板
