# Workflow 引擎

> 对应文件：`packages/workflow-engine/`（引擎核心）、`src/services/workflow/`（RCS 集成适配器）、`src/routes/web/workflow-*.ts`（Web API）

## 1. 借鉴来源

1. Argo Workflows（K8s 原生 DAG、YAML 声明式、CRD 持久化）
2. Temporal（Event Sourcing 持久执行、事件溯源恢复）
3. Dagger（内容寻址缓存、多语言 SDK、OpenTelemetry）
4. Dify（AI 工作流、Agent Function Calling/ReAct、可视化画布）
5. n8n（可视化 + TypeScript、400+ 集成、AI-native）
6. Apache Airflow（Python DAG、XCom 数据传递、Jinja 模板）

## 2. 核心理念

1. 文件夹即项目——用户产出物（YAML、脚本、配置）全部是纯文件，可 git 版本控制
2. 运行时数据（事件流、状态、节点输出）通过 PostgreSQL 持久化（`pg-storage-adapter.ts`）
3. 永远向后兼容：新功能只加可选字段，不修改已有字段语义
4. **组织隔离**：所有 Workflow 数据（事件、快照、输出）通过 `organizationId` 参数化隔离，`createPgStorageAdapter(organizationId)` 在创建时注入

## 3. 执行原语抽象

三种执行原语，所有节点类型基于这三种实现：

1. **ProcessExecutable（本地进程）**
   - 适用节点：ShellNode、PythonNode
   - 生命周期：spawn → stdout/stderr → exit(code)
   - 终止方式：SIGTERM → grace period → SIGKILL
   - PID 记录在 node.started 事件的 metadata 中，用于恢复时检测残留进程

2. **RemoteExecutable（远程调用）**
   - 适用节点：AgentNode、API Node
   - 生命周期：connect → request → stream response → close
   - 终止方式：发送 cancel 消息（ACP 协议）
   - 传输层通过 Transport 接口抽象，默认实现为 ACP 协议 stdio/WS 桥接
   - 上层抽象使得可以自定义与 Agent 的交互方式，报错统一处理

3. **AwaitableExecutable（等待外部事件）**
   - 适用节点：审批节点
   - 生命周期：register → wait → callback/timeout
   - 终止方式：标记过期（token 失效）

## 4. 节点定义（9 种类型）

### 4.1 统一输出格式

所有节点共享统一输出：
```
{ stdout: string, json?: any, exit_code: number, size?: number, ref?: string }
```
- AgentNode：exit_code 固定为 0（连接失败时为 1），stdout 为 Agent 响应文本
- 审批节点：stdout 为审批数据 JSON，exit_code 为 0
- SubWorkflowNode：stdout 为子流程最终节点输出，exit_code 反映子流程成功/失败
- LoopNode：output 为最后一次迭代的最终节点输出
- API Node：exit_code 为 HTTP 状态码（2xx 为 0，其余为实际状态码）
- **size**：输出数据大小（字节），用于小输出内联/大输出引用的判断
- **ref**：大输出的引用 key，指向外部存储

### 4.2 开始节点

- 开始节点只有一个，为虚拟节点，可以绑定多个次级节点
- 在 yaml 中，如果没有 depends_on 直接就是绑定在开始节点上
- 实际上开始节点的参数就是根 yaml 的参数

### 4.3 依赖关系

通过 depends_on 数组进行构建：
1. 结构解析阶段自动扫描 `${{ }}` 中引用的 node_id，未声明的依赖自动补充到 depends_on
2. 解析阶段严格校验：环检测（拓扑排序）、依赖存在性检查、变量引用合法性（引用的节点必须在 depends_on 列表中）
3. 校验失败立即报错，输出具体行号和字段，不进入执行阶段

### 4.4 节点类型枚举

| 类型 | 执行原语 | 说明 |
|------|----------|------|
| `shell` | ProcessExecutable | 执行 Shell 命令 |
| `python` | ProcessExecutable | 执行 Python 脚本 |
| `agent` | RemoteExecutable | 复用在线 Agent Environment |
| `api` | RemoteExecutable | HTTP/HTTPS 请求 |
| `audit` | AwaitableExecutable | 人工审批等待 |
| `workflow` | SubWorkflow | 引用外部 YAML 子流程 |
| `loop` | Loop | 循环迭代子 DAG |
| `transform` | In-memory | 纯内存 JSON 变换（无外进程） |
| `custom` | 任意（插件化） | 用户自定义工具（通过 tools/ 目录注册） |

### 4.5 ShellNode（基于 ProcessExecutable）

1. **环境变量注入**：通过 inputs 字段显式声明需要注入的环境变量
2. **前后节点数据获取**：
   - 显式引用 `${{ nodes.<node_id>.output.stdout }}`，不存在 prev 隐式变量
   - 后置输出使用统一格式
3. **进入条件判断**：通过 condition 字段声明表达式，如 `condition: "${{ nodes.step1.status }} == 'success'"`
4. **超时与重试**：
   - timeout: 节点级超时（秒），超时后标记 FAILED 触发重试或跳过
   - retry: `{ count: 重试次数, delay?: 间隔秒数(默认1), backoff?: 'fixed'|'exponential'(默认fixed) }`
   - 默认值策略：Shell/Python 节点默认不重试，Agent 节点默认重试 2 次指数退避
   - backoff 实现内部加随机 jitter 防止雪崩，用户无需配置

### 4.6 PythonNode（基于 ProcessExecutable）

与 ShellNode 类似，但执行 Python 脚本：
1. `code`：Python 源代码
2. `requirements`：pip 依赖列表
3. `inputs`：注入为 Python 变量的上游数据
4. 输出使用统一输出格式

### 4.7 AgentNode（基于 RemoteExecutable）

1. 通用 ACP 协议封装为指令
2. 所有 Agent 默认不在同一个机器上，通过 Transport 接口桥接
3. **输入**：支持输入提示词中写入 `${{ }}` 来注入变量
4. **输出**：
   - 使用统一输出格式
   - node.completed 事件的 metadata 中附加 token 统计：`{ tokens: { input, output }, model, latency_ms }`
5. **参数**：
   - agent: 定义触发的 Environment 名称
   - skill：默认加载的 skill
   - output_messages：回传给下游的最后 N 条原始消息（默认 0）
6. **生命周期**：
   - AgentNode 区别于 ShellNode：Agent 有服务端状态，需要 abort() 优雅终止（发送 cancel 消息）
   - 执行接口统一使用 AbortSignal，适配器自行决定 SIGKILL（Shell）还是 cancel（Agent）

### 4.8 API Node（基于 RemoteExecutable）

1. 主动发送 HTTP/HTTPS 请求，支持 GET/POST/PUT/DELETE
2. 支持 headers 和 body 模板，通过 `${{ }}` 注入变量
3. 使用统一输出格式

### 4.9 审批节点（基于 AwaitableExecutable）

1. 图进入 SUSPENDED 模式
2. 审批时生成 approval_token（HMAC 签名，非裸 UUID），绑定过期时间（默认 24h，可配）
3. 审批恢复双模式：CLI 命令 `acp approve` 或 HTTP API
4. HTTP 模式：通过统一 `POST /web/workflow-engine` + action `"approve"` 操作
5. CLI 模式：`acp approve <run_id> <node_id> --token <token>`（acp-link 开发者工具）

### 4.10 SubWorkflowNode（子流程引用）

1. type: workflow，引用外部 yaml 文件作为子流程
2. 独立运行模型：子流程作为独立 DAG 运行，拥有自己的 run_id 和事件流
3. 父节点通过 `${{ nodes.<node_id>.output.json.xxx }}` 引用子流程输出
4. 参数传递：SubWorkflowNode 的 params 字段映射到子流程的 params
5. 默认行为：子流程失败 → 父节点标记 failed → 触发标准错误传播
6. 可选 `ignore_errors: true`：子流程失败 → 父节点仍然 completed
7. 事件流中记录 `sub_workflow.started` / `sub_workflow.completed`，支持 drill-down 查看
8. 嵌套深度无硬限制，但建议不超过 3 层

### 4.11 LoopNode（循环节点）

1. 内部包含一个子 DAG，每次迭代执行子 DAG
2. 子 DAG 的节点 id 与父 DAG 隔离（独立命名空间），表达式按执行上下文解析
3. condition 在每次迭代完成后求值（do-while 语义）
4. max_iterations 限制最大迭代次数，防止无限循环
5. 事件流中记录 `loop.iteration_started` / `loop.iteration_completed`
6. DAG 本身保持无环，LoopNode 内部的循环语义封装在节点内部
7. output 为最后一次迭代的最终节点输出
8. 多次迭代共享同一工作目录，需要注意写文件冲突

### 4.12 TransformNode（纯内存变换）

1. type: transform，无需外部进程，直接在调度器内存中执行
2. `inputs`：从上游拉取的数据（key 为变量名，value 为 `${{ }}` 表达式）
3. `output`：输出结构，key 为字段名，value 为 JavaScript 表达式，表达式作用域包含 inputs 变量 + params + secrets
4. 用于轻量级数据结构重塑、字段提取、条件分支数据预处理
5. 不支持副作用操作（不能写文件、发请求），仅纯数据变换

### 4.13 CustomNode（自定义工具）

1. type: custom，通过 `tools/` 目录下的 TypeScript 文件注册
2. `tool`：对应注册工具的名称（从 CustomNodeRegistry 查找）
3. `inputs`：输入绑定（key 对应工具定义的输入参数，value 为表达式字符串）
4. 插件化架构：支持 SlurmNode 子类（集群作业提交）、自定义脚本等扩展
5. CustomNodeRegistry 在服务启动时扫描 `WORKFLOW_TOOLS_DIR` 目录，失败 fallback 到空 registry
6. 通过 `POST /web/workflow-custom-tools` API 查询可用工具列表

## 5. 状态存储（Event Sourcing + PostgreSQL）

### 5.1 存储层设计

RCS 使用 **PostgreSQL + Drizzle ORM** 作为存储后端（非 SQLite）：

- **StorageAdapter 接口**：`appendEvent / getEvents / getLatestSnapshot / createSnapshot / listRuns / getOutput / setOutput / atomicNodeComplete / deleteRun / getRunStatus`
- **实现**：`src/services/workflow/pg-storage-adapter.ts` 的 `createPgStorageAdapter(organizationId)`
- **组织隔离**：所有查询自动注入 `organizationId` 条件，确保数据隔离
- 事件流表 `workflow_event`、快照表 `workflow_snapshot`、节点输出表 `workflow_node_output` 均带 `organizationId` 列
- 事务保证：`atomicNodeComplete` 在一次 DB 事务中原子写入 output + snapshot + event

### 5.2 DAG 运行状态

1. PENDING（已解析等待执行）
2. RUNNING（执行中）
3. SUSPENDED（暂停，审批节点等待时进入）
4. FAILED（节点执行失败导致）
5. CANCELLED（用户主动取消）
6. ERROR（调度器系统异常，需人工介入）
7. SUCCESS（全部完成）

### 5.3 节点级状态

1. PENDING（等待执行）
2. RUNNING（执行中）
3. COMPLETED（执行完成）
4. FAILED（执行失败）
5. CANCELLED（被取消）
6. SKIPPED（被跳过，依赖链中断或条件不满足）

### 5.4 事件 Schema

统一事件类型 + 节点类型标签：
- DAGEvent 结构：`{ event_id, run_id, project_id, node_id, timestamp, type, node_type?, metadata? }`
- node_type 枚举：`shell | python | agent | api | audit | workflow | loop | transform | custom`
- 通用事件类型：
  - dag.started / dag.completed / dag.cancelled
  - node.started / node.completed / node.failed / node.cancelled / node.retrying / node.skipped
  - sub_workflow.started / sub_workflow.completed
  - loop.iteration_started / loop.iteration_completed
  - audit.requested / audit.approved

### 5.5 节点输出存储

- 节点的 stdout/stderr 不写入事件流，写入独立输出表 `workflow_node_output`
- 字段：`stdout`、`json`、`exit_code`、`size`、`ref`
- `size`：输出大小（字节），用于判断是否可内联到事件 metadata
- `ref`：大输出的外部存储引用 key
- node.completed 事件只记录 `{ output_size, output_ref }`（引用）
- 小输出（<1MB）可内联到事件 metadata 中方便查询，大输出走引用

### 5.6 Snapshot 策略

1. 每个节点完成时生成快照（不在中间做快照）
2. Snapshot 写入与事件追加在同一个数据库事务中（通过 `atomicNodeComplete`）
3. 快照内容：`{ snapshot_id, run_id, last_event_id, timestamp, node_states, dag_status }`
4. 只存节点级状态摘要，不存输出内容
5. 已完成 DAG 的快照永久保留作为最终状态记录

### 5.7 恢复机制

1. 崩溃后从数据库加载最近的 Snapshot
2. 从 Snapshot 对应的 event_id 之后重放所有事件
3. 发现 node.started 但无 node.completed/failed/cancelled 的节点 → 检查 PID 是否存活 → 存活则 SIGTERM/cancel
4. 将未完成的节点重新调度执行

### 5.8 Secrets 脱敏

1. 事件写入时自动替换已知 secret 值为 `***`
2. 调度器维护 secretValues 集合，事件 metadata 中的字符串做 replace

## 6. YAML 结构定义

1. 根结构为扁平式：`name / description / schema_version / params / secrets / timeout / nodes`
2. 变量语法采用 `${{ }}` 表达式（严格子集）
3. 命名空间通过前缀区分：
   - `nodes.<id>.output.xxx` — 节点输出引用
   - `nodes.<id>.status` — 节点状态引用
   - `params.xxx` — 根参数引用
   - `secrets.KEY` — 密钥引用
4. 支持：属性访问（a.b.c）、比较运算、逻辑运算、三元表达式、字符串拼接
5. 不支持：map/filter/reduce、函数调用、复杂运算
6. 节点通过显式 id 字段标识
7. 支持多文件 import，通过 SubWorkflowNode 引用外部 workflow
8. schema_version 字段标记版本（初始为 1），永远向后兼容
9. 工作目录：共用全局目录（YAML 文件所在目录），不创建额外隔离目录

## 7. Secrets 管理

1. DAG 级声明 secrets 列表（只是声明需要哪些密钥）
2. 节点中通过 `${{ secrets.KEY }}` 引用
3. 实际值来源优先级：
   1. 系统环境变量
   2. 项目目录下的 .env 文件
   3. --env-file CLI 参数指定的文件
4. 运行时作为环境变量注入到节点进程中，不落盘到 YAML 或事件流

## 8. 执行调度

1. 中心调度器模式，维护 DAG 状态并分发任务
2. 扇出场景默认并行执行
3. DAG 级 timeout 控制整体超时
4. 错误传播策略：
   - 节点失败时终止所有直接或间接依赖它的下游节点（标记为 SKIPPED）
   - 不依赖失败节点的其他分支继续执行
   - DAG 最终状态：全部成功 → SUCCESS，有任何节点失败 → FAILED
5. 取消机制：
   - 调度器停止调度新节点
   - 向所有运行中节点发送 abort 信号
   - 等待 grace period（如 10s），超时则 SIGKILL
   - 记录 dag.cancelled 事件
   - 不加 on_error 回调，补偿逻辑 drop 到外部脚本

## 9. Web API 架构

RCS 的 Workflow 操作**不通过独立 RESTful 路径**，而是通过**统一 action 分发端点**：

- **`POST /web/workflow-engine`** — 核心引擎操作（action: run / dryRun / cancel / approve / getRunStatus / getEvents / getOutput / getPendingApprovals / recover / rerunFrom）
- **`POST /web/workflow-defs`** — Workflow 定义 CRUD（action: list / get / create / delete / publish / listVersions / getYaml / updateYaml / restoreDraft）
- **`POST /web/workflow-runs`** — 运行记录管理（action: listRuns / deleteRun）
- **`GET /web/workflow-sse`** — SSE 实时事件推送（?workflowId=xxx）
- **`POST /web/workflow-custom-tools`** — 查询可用自定义工具列表
- **`/workflow-ui/*` + `/api/v1/*`** — 转发到 acpx-g 服务（Workflow UI 代理，含可视化编辑器）

### CLI 工具说明

CLI 工具（`acp dry-run`、`acp run`、`acp approve`、`acp trace`、`acp ls` 等）属于 **acp-link 开发者工具**，运行在开发者本地环境。RCS 当前通过上述 Web API + action dispatch 模式操作 Workflow Engine。CLI 和 Web API 共享同一个 WorkflowEngine 实例，只是接入层不同。

## 10. Workflow 配套组件

### 10.1 Workflow Board（看板面板）

`workflow_board` + `workflow_job` 两张表实现看板式作业管理：

- **Board**：看板容器（name、isDefault），按 organizationId 隔离
- **Job**：看板中的卡片实体，绑定 workflow 定义 + 版本 + 参数
- Job 状态流转：`ready` → `running` → `suspended` → `completed`，支持拖拽变更阶段
- 每个 Job 记录执行次数、最近 run ID 和 DAG 状态
- 通过 `POST /web/workflow-boards` + action dispatch 操作

### 10.2 Workflow Trigger（外部触发器）

`workflow_trigger` 表实现 Webhook 外部触发：

- 每个 trigger 生成唯一的 `publicHash`，用于构建 webhook URL
- 支持配置 secret 用于签名验证
- 外部系统通过 `POST /hooks/:publicHash`（无认证）触发工作流执行
- 通过 `POST /web/workflow-triggers` + action dispatch 管理触发器

### 10.3 Custom Tools 注册表

`CustomNodeRegistry`（`packages/workflow-engine/src/plugins/registry.ts`）管理自定义节点类型：

- 服务启动时调用 `initCustomToolsRegistry()` 扫描 `WORKFLOW_TOOLS_DIR` 目录
- 支持 `SlurmNode` 子类（集群作业提交）和通用 `CustomNode` 子类
- 失败不阻塞服务启动，fallback 到空 registry
- 通过 `getCustomToolsRegistry()` 同步获取已初始化的 registry，注入到每个 team 的 WorkflowEngine 实例

### 10.4 Workflow UI 代理

`src/routes/web/workflow-proxy.ts` 将前端请求透传到 `acpx-g` 服务：

- `/workflow-ui/*` → `acpx-g/`（静态资源）
- `/api/v1/*` → `acpx-g/api/v1/*`（API 代理）
- 客户端 abort 信号透传，避免资源浪费
- acpx-g 不可达时返回 502

### 10.5 ACP Transport 适配器

`src/services/workflow/acp-transport.ts` 实现 Workflow Engine 到 ACP 协议的桥接：

- 将 Workflow 的 Transport 接口映射到 ACP 消息协议
- 支持 Environment 的 Agent 节点连接管理
- `sendToAgentWs` 通过 machine WS 发送消息

### 10.6 SSE 实时事件

`src/services/workflow/workflow-events.ts` 提供 per-workflow EventBus：

- 事件类型：`workflow.created / deleted / draft_updated / run_started / run_status_changed / run_cancelled / dry_run_completed / version_published`
- `GET /web/workflow-sse?workflowId=xxx` 端点订阅推送
- EventBus 按 `wf:{workflowId}` key 隔离，workflow 删除时调用 `removeWorkflowEventBus()` 清理

## 11. 可观测性

1. 结构化日志：JSON 格式输出到 stderr，包含 run_id / node_id / timestamp / level / message
2. 事件流即 Trace：Event Sourcing 本身提供完整的执行历史
3. CLI 查询命令：`acp trace <run_id>` 格式化输出时间线和关键指标
4. 不引入 OpenTelemetry 等外部可观测性框架

## 12. 可视化编辑器

1. 借鉴 Dify/n8n 的画布体验，但坚持"文件夹即项目"理念
2. 编辑器直接读写 YAML 文件：拖拽节点 → 实时修改 .yaml；修改 .yaml → 画布自动更新
3. 用户的所有操作都可以用 git 版本控制
4. 精确的 YAML 位置追踪（保留注释、格式）为理想目标
5. 编辑器 UI 通过 `/workflow-ui` 代理到 acpx-g 服务

## 13. Schema 迁移

当确实需要破坏性变更时，提供 `acp migrate <workflow.yaml>` 自动升级工具。
