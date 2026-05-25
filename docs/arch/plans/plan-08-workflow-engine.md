# Plan 08：@mothership/workflow-engine 独立包实现

## Context

Workflow 是 RCS 的核心功能模块，负责 DAG 编排的多步执行流程。`17-workflow.md` 定义了完整的引擎架构（Event Sourcing、6 种节点类型、Snapshot 恢复）。当前代码中仅有 `workflow-proxy.ts` 反向代理到外部 acpx-g 引擎，原生引擎尚未实现。

## 与 plan-07 的关系

- **plan-08 完全替代 plan-07 的执行引擎和 API 设计**
- plan-07 的 `workflow`/`workflowRun` 表已存在于 `src/db/schema.ts`，保留用于 YAML 定义元数据和运行摘要的 UI 展示
- plan-08 新增 Event Sourcing 表（workflowEvent/workflowSnapshot/workflowNodeOutput）用于引擎执行层，与旧表共存
- plan-07 提到的 `src/repositories/workflow.ts` 和 `src/services/workflow.ts` 未实施，plan-08 重新定义

## 设计决策

| 决策 | 结论 |
|------|------|
| 包名 | `@mothership/workflow-engine` |
| 存储层 | 包内只定义 `StorageAdapter` 接口 + `InMemoryStorage`（测试/dry-run），不提供 SQLite/PG 默认实现 |
| ACP 通信 | 通过 `Transport` 接口抽象，包外注入。接口设计为 `connect(agentId) → AgentSession` 有状态模型，对齐 ACP 的 session 流式交互 |
| YAML 格式 | 遵循 `17-workflow.md` 的 `${{ }}` 格式（与 acpx-g 的 `{{ }}` 不兼容），不提供自动迁移 |
| 运行时 | Bun（Bun.test、Bun.spawn） |
| 外部依赖 | 仅 `yaml` npm 包（YAML 解析），不引入 drizzle/pg/acp-link |
| API 路由风格 | 遵循 RCS 现有 POST + action 分发模式：`POST /web/workflows` + `{ action }` |
| SUSPENDED 机制 | Snapshot + ���出（crash-safe），`approve()` 内部等价于 `recover()` + 跳过已完成节点 |
| 审批命名 | 统一为 `audit`（对齐 17-workflow.md §5.4.2 node_type 枚举和事件名 `audit.requested/approved`） |
| CLI 工具 | MVP 范围外，plan 末尾标注为后续扩展 |
| 可视化编辑器 | MVP 范围外，属于前端独立规划 |
| 与 @mothership/core 关系 | workflow-engine 独立运作，不依赖 core。AgentNode 通过 Transport 接口与已有 Agent 通信，不负责启动新实例 |

## YAML 格式过渡策略

现有 `workflow/*.yaml` 使用 acpx-g 格式，与 17-workflow.md 格式不兼容。过渡方案：

1. **新引擎只解析新格式**，acpx-g 格式 YAML 解析时报错
2. 保留 `workflow/` 目录下现有文件供 acpx-g 引擎使用（共存期间）
3. 新格式 YAML 存放在新目录（如 `workflows/`，复数形式区分）
4. 后续提供独立迁移脚本（不在本包范围内）

### 格式对照表

| 维度 | acpx-g 格式 | 新格式（17-workflow.md） |
|------|-------------|------------------------|
| 变量语法 | `{{ inputs.xxx }}` | `${{ params.xxx }}` |
| 节点输出引用 | `{{ needs.nodeId.outputs.xxx }}` | `${{ nodes.nodeId.output.xxx }}` |
| 子流程类型 | `type: reference` + `ref` | `type: workflow` + `ref` |
| 输出机制 | `$ACPX_OUTPUT` 文件（key=value） | 统一 `NodeOutput { stdout, json, exit_code }` |
| 依赖声明 | `depends: [node_id]` | `depends_on: [node_id]` |
| 参数声明 | `inputs: { key: { type, required } }` | `params: { key: { type, default } }` |
| 条件执行 | `if: "{{ expr }}"` | `condition: "${{ expr }}"` |
| 重试配置 | `retry: 2`（数字） | `retry: { count: 2, delay?: 1, backoff?: 'exponential' }` |

## 目录结构

```
packages/workflow-engine/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                      # 受控公开导出面
    ├── types/                        # 类型定义（纯类型，无运行时代码）
    │   ├── dag.ts                    # DAG 定义、节点类型、YAML schema 类型、参数定义
    │   ├── execution.ts              # 执行状态、15 种事件类型 + metadata schema、快照类型、RunSummary
    │   ├── expression.ts             # 表达式 AST 类型
    │   └── errors.ts                 # 错误码 + WorkflowError 类
    ├── parser/                       # YAML 解析 + 校验
    │   ├── yaml-parser.ts            # YAML → DAG 定义（含隐式开始节点处理、schema_version 校验）
    │   ├── dag-validator.ts          # 环检测、依赖校验、变量引用合法性、自动补充 depends_on
    │   └── expression-parser.ts      # ${{ }} 表达式解析器 + 求值器（命名空间白名单、深度限制）
    ├── scheduler/                    # DAG 调度器
    │   ├── dag-scheduler.ts          # 核心调度循环
    │   ├── topological-sort.ts       # 拓扑排序 + 并行分支识别 + 反向邻接表
    │   └── cancellation.ts           # 取消管理器（AbortSignal + grace period + SIGKILL 兜底）
    ├── executor/                     # 节点执行器（三种执行原语）
    │   ├── node-executor.ts          # 统一执行入口 + NodeExecutor 接口 + NodeExecutorRegistry
    │   ├── process-executor.ts       # ProcessExecutable（ShellNode）
    │   ├── remote-executor.ts        # RemoteExecutable 基类（共享 cancel 逻辑）
    │   ├── agent-executor.ts         # AgentNode（Transport 接口）
    │   ├── api-executor.ts           # APINode（HTTP）
    │   ├── awaitable-executor.ts     # AwaitableExecutable（AuditNode）
    │   ├── sub-workflow-executor.ts  # SubWorkflowNode
    │   └── loop-executor.ts          # LoopNode（内部复用 DAGScheduler）
    ├── storage/                      # 存储抽象
    │   ├── storage-adapter.ts        # StorageAdapter 接口定义
    │   └── in-memory-storage.ts      # 内存实现（测试 + dry-run）
    ├── transport/                    # 通信抽象
    │   └── transport.ts              # Transport + AgentSession 接口定义
    ├── secrets/                      # Secrets 管理
    │   └── secrets-resolver.ts       # 环境变量 / .env 文件解析 + 自动脱敏
    ├── recovery/                     # 恢复机制
    │   └── snapshot-recovery.ts      # 快照加载 + 事件重放 + 孤儿节点处理（区分 Process/Remote 终止方式）
    ├── engine/                       # 引擎门面
    │   └── workflow-engine.ts        # createWorkflowEngine() 唯一入口
    └── __tests__/
        ├── fixtures/                 # 测试 YAML 文件 + fixture 工厂（FakeTransport、FakeStorage）
        ├── parser/
        ├── scheduler/
        ├── executor/
        ├── storage/
        ├── secrets/
        ├── recovery/
        └── integration/
```

## 类型系统

### 节点类型

```typescript
// 对齐 17-workflow.md §5.4.2 node_type 枚举
type NodeType = 'shell' | 'agent' | 'api' | 'audit' | 'workflow' | 'loop';
```

### 参数定义

```typescript
interface ParamDef {
  type?: 'string' | 'number' | 'boolean' | 'object';
  default?: unknown;
  required?: boolean;
}
```

### 统一输出格式

```typescript
// 所有节点共享，对齐 17-workflow.md §4.1
interface NodeOutput {
  stdout: string;
  json?: unknown;          // stdout 尝试 JSON.parse 成功时填充
  exit_code: number;
  size?: number;           // stdout 字节数，用于小/大输出分流判断
  ref?: string;            // 大输出时的外部存储引用路径（>1MB）
}
```

### 状态枚举

```typescript
// 对齐 17-workflow.md §5.2
type DAGStatus = 'PENDING' | 'RUNNING' | 'SUSPENDED' | 'FAILED' | 'CANCELLED' | 'ERROR' | 'SUCCESS';

// 对齐 17-workflow.md §5.3
type NodeStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
```

### YAML 根结构（WorkflowDef）

对齐 17-workflow.md §6.1：

```typescript
interface WorkflowDef {
  schema_version: string;              // 初始为 '1'，永远向后兼容
  name: string;
  description?: string;
  params?: Record<string, ParamDef>;   // 根参数声明
  secrets?: string[];                  // 密钥声明列表
  timeout?: number;                    // DAG 级超时（秒）
  nodes: NodeDef[];                    // 节点列表
  // 内部字段（解析阶段填充）
  _startNodeId?: string;               // 隐式开始节点 ID（虚拟）
  _baseDir?: string;                   // YAML 文件所在目录（工作目录）
}
```

### 事件类型（完整枚举）

对齐 17-workflow.md §5.4.3，全部 15 种：

```typescript
type EventType =
  // DAG 级（3 种）
  | 'dag.started'          // metadata: { params }
  | 'dag.completed'        // metadata: { status: DAGStatus, duration_ms: number }
  | 'dag.cancelled'        // metadata: { reason: string }
  // 节点级（6 种）
  | 'node.started'         // metadata: { inputs, pid?: number }
  | 'node.completed'       // metadata: { exit_code, output_size, output_ref?, tokens?: { input, output }, model?, latency_ms? }
  | 'node.failed'          // metadata: { error: string, exit_code?: number }
  | 'node.cancelled'       // metadata: { reason: string }
  | 'node.retrying'        // metadata: { attempt: number, next_delay_ms: number }
  | 'node.skipped'         // metadata: { reason: 'upstream_failed' | 'condition_false' }
  // 子流程（2 种）
  | 'sub_workflow.started'  // metadata: { sub_run_id: string }
  | 'sub_workflow.completed'// metadata: { sub_run_id: string, outputs?: unknown }
  // 循环（2 种）
  | 'loop.iteration_started'  // metadata: { iteration: number, max_iterations: number }
  | 'loop.iteration_completed'// metadata: { iteration: number, will_continue: boolean }
  // 审批（2 种）
  | 'audit.requested'      // metadata: { approval_token: string, expires_at: string, display_data?: unknown }
  | 'audit.approved';       // metadata: { approval_token: string }

interface DAGEvent {
  event_id: string;
  run_id: string;
  project_id?: string;
  node_id?: string;
  timestamp: string;        // ISO 8601
  type: EventType;
  node_type?: NodeType;
  metadata?: Record<string, unknown>;
}
```

### 快照

对齐 17-workflow.md §5.7.3：

```typescript
interface DAGSnapshot {
  snapshot_id: string;
  run_id: string;
  last_event_id: string;
  timestamp: string;
  node_states: Record<string, { status: NodeStatus; exit_code?: number }>;
  dag_status: DAGStatus;
}
```

### RunSummary

```typescript
interface RunSummary {
  run_id: string;
  project_id?: string;
  workflow_name: string;
  status: DAGStatus;
  started_at: string;
  completed_at?: string;
  node_summary: { total: number; completed: number; failed: number; running: number };
}
```

### StorageAdapter 接口

```typescript
interface StorageAdapter {
  // 事件
  appendEvent(event: DAGEvent): Promise<void>;
  getEvents(runId: string, opts?: {
    afterEventId?: string;
    nodeId?: string;
    types?: EventType[];
  }): Promise<DAGEvent[]>;

  // 快照
  getLatestSnapshot(runId: string): Promise<DAGSnapshot | null>;
  createSnapshot(snapshot: DAGSnapshot): Promise<void>;

  // 节点输出
  getOutput(runId: string, nodeId: string): Promise<NodeOutput | null>;
  setOutput(runId: string, nodeId: string, output: NodeOutput): Promise<void>;

  // 运行查询
  listRuns(projectId?: string): Promise<RunSummary[]>;
  getRunStatus(runId: string): Promise<DAGStatus | null>;

  // 原子操作：output + snapshot + event 在同一事务中写入
  // 保证节点完成时三者的一致性（对齐 17-workflow.md §5.7.2）
  atomicNodeComplete(opts: {
    output: NodeOutput;
    snapshot: DAGSnapshot;
    event: DAGEvent;
  }): Promise<void>;

  // 清理
  deleteRun(runId: string): Promise<void>;
}
```

### Transport 接口（重新设计）

采用有状态 session 模型，对齐 ACP 协议的 prompt → session_update 流 → prompt_complete 交互：

```typescript
// Agent 执行请求
interface AgentRequest {
  prompt: string;           // 支持 ${{ }} 替换后的最终 prompt
  agent?: string;           // Agent 名称（对应 AgentNodeDef.agent）
  skill?: string;           // 默认加载的 skill（对应 AgentNodeDef.skill）
  cwd?: string;             // 工作目录
  signal?: AbortSignal;     // 取消信号，abort 时 Transport 发送 cancel 消息
}

// Agent 执行响应
interface AgentResponse {
  stdout: string;           // Agent 响应文本
  exit_code: number;        // 固定 0（连接失败时 1）
  tokens?: { input: number; output: number };
  model?: string;
  latency_ms?: number;
}

// Agent Session（有状态，对应一次 AgentNode 执行）
interface AgentSession {
  // 发送 prompt 并等待完成，返回最终响应
  execute(request: AgentRequest): Promise<AgentResponse>;
}

// Transport（无状态工厂，管理连接生命周期）
interface Transport {
  // 连接到指定 Agent，返回 session
  connect(agentId: string, options?: { cwd?: string }): Promise<AgentSession>;

  // 可选：生命周期管理
  disconnect?(): Promise<void>;
  isReady?(): boolean;
}
```

**设计说明**：
- `Transport` 是连接工厂，`AgentSession` 是单次执行的有状态上下文
- RCS 的 ACP Transport 实现内部维护 `ACPClient`，`connect()` 创建/加载 session，`session.execute()` 发送 prompt 并收集完整响应
- `AbortSignal` 传入 `execute()`，实现监听 abort → 调用 `ACPClient.cancel()`
- MVP 阶段 `execute()` 返回完整响应（缓存后返回），流式响应通过后续扩展 `executeStream()` 支持

### 节点定义（discriminated union）

```typescript
interface RetryConfig {
  count: number;
  delay?: number;                          // 默认 1 秒
  backoff?: 'fixed' | 'exponential';       // 默认 fixed
}

interface BaseNodeDef {
  id: string;
  type: NodeType;
  depends_on?: string[];                   // 空数组或缺失 = 绑定到隐式开始节点
  condition?: string;                      // ${{ }} 表达式，false → SKIPPED(reason: condition_false)
  timeout?: number;                        // 秒
  retry?: RetryConfig;
  env?: Record<string, string>;
}

interface ShellNodeDef extends BaseNodeDef {
  type: 'shell';
  command: string | string[];
  cwd?: string;                            // 默认为 YAML 文件所在目录
}

interface AgentNodeDef extends BaseNodeDef {
  type: 'agent';
  prompt: string;
  agent?: string;
  skill?: string;
  // 默认重试 2 次指数退避（覆盖 BaseNodeDef.retry 默认值）
  retry?: RetryConfig;
}

interface ApiNodeDef extends BaseNodeDef {
  type: 'api';
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
}

interface AuditNodeDef extends BaseNodeDef {
  type: 'audit';
  display_data?: unknown;
  expires_in?: number;                     // 默认 24h（秒）
}

interface SubWorkflowNodeDef extends BaseNodeDef {
  type: 'workflow';
  ref: string;                             // 相对路径（基于 YAML 文件所在目录）
  params?: Record<string, unknown>;        // ${{ }} 替换后按原始类型传递
  ignore_errors?: boolean;
}

interface LoopBody {
  nodes: NodeDef[];                        // 子 DAG，独立命名空间
}

interface LoopNodeDef extends BaseNodeDef {
  type: 'loop';
  condition: string;                       // do-while 条件（${{ }} 表达式）
  max_iterations: number;
  body: LoopBody;
}

type NodeDef =
  | ShellNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef;
```

## 分步任务

### Task 1：包脚手架 + 类型系统

**目标**：建立包骨架，定义所有核心类型（本 plan §类型系统 全部内容）。

**产出**：
- `packages/workflow-engine/package.json`
- `packages/workflow-engine/tsconfig.json`
- `packages/workflow-engine/src/index.ts`（空导出占位）
- `packages/workflow-engine/src/types/dag.ts`：NodeDef union、WorkflowDef、ParamDef、RetryConfig、LoopBody
- `packages/workflow-engine/src/types/execution.ts`：DAGStatus、NodeStatus、全部 15 种 EventType + DAGEvent + DAGSnapshot + RunSummary
- `packages/workflow-engine/src/types/expression.ts`：AST 节点类型
- `packages/workflow-engine/src/types/errors.ts`：WorkflowErrorCode 枚举 + WorkflowError 类
- `tsconfig.base.json` 新增路径映射

**验证**：
- `bun run typecheck` 通过（包内 + 根目录）
- 从根目录 `import type { WorkflowDef, DAGEvent, NodeDef, DAGSnapshot, RunSummary } from "@mothership/workflow-engine"` 可解析

---

### Task 2：YAML 解析器 + DAG 校验器 + 表达式求值器

**目标**：实现 `workflow.yaml` → `WorkflowDef` 的完整解析链路。

**产出**：
- `src/parser/yaml-parser.ts`：`parseWorkflowYaml(source: string, baseDir?: string): WorkflowDef`
  - 使用 `yaml` npm 包（v2+，`JSON_SCHEMA` 禁用自定义类型）
  - 校验 `schema_version`（必须为 `'1'`）、必填字段（name、nodes）
  - **隐式开始节点**：无 `depends_on` 或 `depends_on` 为空的节点视为绑定到虚拟开始节点
  - 设置 `_baseDir` 为 YAML 文件所在目录（工作目录策略：§6.8）
  - SubWorkflowNode 的 `ref` 路径基于 `baseDir` 解析
- `src/parser/dag-validator.ts`：`validateDAG(def: WorkflowDef): ValidationResult`
  - 节点 id 唯一性检查
  - 环检测（Kahn 算法）
  - 依赖存在性检查（depends_on 引用的节点必须存在）
  - **自动扫描 `${{ }}` 中引用的 `nodes.<id>`，未声明的依赖自动补充到 depends_on**（§4.3.1）
  - 变量引用合法性（引用的节点必须在 depends_on 中）
  - 校验结果带具体行号和字段位置
- `src/parser/expression-parser.ts`：
  - `parseExpression(expr: string): AST`
  - `evaluateExpression(ast: AST, context: EvalContext): unknown`
  - `resolveTemplate(template: string, context: EvalContext): string`
  - 支持的命名空间（§6.2.1）：`nodes.<id>.output.xxx`、`nodes.<id>.status`、`params.xxx`、`secrets.KEY`
  - 支持的运算：属性访问（a.b.c、数组索引 a[0]）、比较、逻辑、三元、字符串拼接
  - null 语义：缺失 → null，null==null=true，null 其他比较 → false（自定义比较运算符）
  - **安全约束**：
    - 属性访问只允许 `nodes/params/secrets` 三个命名空间，其他路径报 `UNDEFINED_VARIABLE`
    - 属性访问深度限制 10 层
    - 表达式长度限制 1024 字符
    - Tokenization 使用手写字符扫描器（char-by-char），不依赖正则
    - 不支持 `__proto__`、`constructor` 等原型链访问
  - **不用 `eval()`**，递归下降解析器
  - 不支持 `prev` 隐式变量（§4.4.2）
  - 不支持 map/filter/reduce、函数调用、复杂运算

**验证**：
- 解析 17-workflow.md 格式的 YAML 得到正确 `WorkflowDef`
- acpx-g 格式 YAML 应报 `INVALID_YAML`（缺少 schema_version 或使用旧字段名）
- 环检测：环形依赖 DAG 报 `CYCLE_DETECTED`
- 自动补充 depends_on：`${{ nodes.step1.output.stdout }}` 在未声明依赖时自动补充
- 表达式边界测试（null 语义、数组索引、原型链访问拒绝、超长表达式拒绝）

---

### Task 3：StorageAdapter 接口 + 内存实现

**目标**：定义存储抽象，提供测试用内存实现。

**产出**：
- `src/storage/storage-adapter.ts`：完整接口定义（含 `atomicNodeComplete`、`getRunStatus`、`deleteRun`、`getEvents` opts 参数）
- `src/storage/in-memory-storage.ts`：`createInMemoryStorage(): StorageAdapter`
  - Map 存储，支持所有接口方法
  - `atomicNodeComplete` 在内存中顺序写入（天然原子）
  - `getEvents` opts 支持 nodeId 和 types 过滤
  - 用于测试和 dry-run
- 对应测试

**验证**：
- 所有接口方法往返一致
- `atomicNodeComplete` 后 `getLatestSnapshot` 返回最新 + `getOutput` 返回输出
- `getEvents` 按 nodeId/types 过滤正确
- `deleteRun` 清理所有关联数据

---

### Task 4：DAG 调度器

**目标**：实现核心调度循环、拓扑排序、并行扇出、错误传播、SUSPENDED 处理。

**产出**：
- `src/scheduler/topological-sort.ts`：
  - `topologicalSort(nodes: NodeDef[]): string[]` — 执行层级
  - `identifyParallelGroups(nodes: NodeDef[]): string[][]` — 可并行的节点组
  - `buildReverseAdjacency(nodes: NodeDef[]): Map<string, string[]>` — 反向邻接表（用于错误传播，O(affected_nodes) 而非 O(N+M)）
- `src/scheduler/dag-scheduler.ts`：`DAGScheduler` 类
  - 调度循环：completed/failed/skipped → 检查 ready → `Promise.allSettled` 扇出执行
  - 错误传播：failed → BFS 沿反向邻接表标记所有可达下游为 SKIPPED(reason: upstream_failed)
  - DAG 级 timeout：`AbortSignal.timeout(dagTimeout)`，组合到每个节点的 signal
  - 每个节点完成后通过 `storage.atomicNodeComplete()` 写入 output + snapshot + event
  - **SUSPENDED 处理**：AuditNode 触发 SUSPENDED → 写入 SUSPENDED snapshot + dag.suspended 事件 → `run()` 返回 `SuspendedHandle` → 宿��调用 `approve()` → 内部等价于 `recover(runId)` + 跳过已完成节点
  - DAG 最终状态判定：全部 COMPLETED → SUCCESS，有任何 FAILED → FAILED
- `src/scheduler/cancellation.ts`：`CancellationManager`
  - 停止调度新节点
  - 向所有 RUNNING 节点发送 abort signal
  - 等待 grace period（默认 10s）
  - grace period 后对 ProcessExecutable 发 SIGKILL
  - 记录 `dag.cancelled` 事件

**验证**：
- 线性 DAG（A → B → C）按序执行
- 扇出 DAG（A → [B, C] → D）B 和 C 并行
- 独立分支：A 失败不阻塞不依赖 A 的分支
- 取消：中途取消 → 所有 RUNNING 节点收到 abort → grace period → SIGKILL → dag.cancelled 事件
- DAG timeout 超时后进入 CANCELLED

---

### Task 5：ShellNode（ProcessExecutable）— 第一个可运行节点

**目标**：端到端跑通最简 DAG。

**产出**：
- `src/executor/node-executor.ts`：
  - `NodeExecutor` 接口：`execute(node, ctx): Promise<NodeOutput>`
  - `NodeExecutorRegistry`：按 nodeType 分发
- `src/executor/process-executor.ts`：
  - `Bun.spawn(command, { cwd, env, stdout: 'pipe', stderr: 'pipe' })`
  - **stderr 处理**：spawn 后异步消费 stderr（设置 10MB 上限，超出 kill 子进程并标记 FAILED）
  - 变量替换：command 和 env 中的 `${{ }}` 通过 `resolveTemplate()` 解析
  - condition 求值：false → 标记 SKIPPED(reason: condition_false) + node.skipped 事件
  - timeout：`AbortSignal.timeout(ms)` + kill
  - retry：指数退避 + jitter（§4.4.4.4），每次 retry 发射 `node.retrying` 事件
  - 输出格式：收集 stdout → 尝试 JSON.parse → `{ stdout, json?, exit_code, size? }`
  - **node.started 事件 metadata 附加 `pid`**（§5.4.3.4）
  - **node.completed 事件 metadata 包含 `output_size` 和 `output_ref`**（§5.4.3.5）
  - 小输出（<1MB）stdout 直接存储，大输出写入临时文件（`ref` 为文件路径）
  - 默认不重试（retry count 默认 0）
- 测试用 YAML fixtures + 对应测试

**验证**：
- `echo "hello"` → `{ stdout: "hello\n", exit_code: 0 }`
- `exit 1` → `{ stdout: "", exit_code: 1 }` + node.failed 事件
- `${{ params.input }}` 替换正确
- condition 为 false 时节点 SKIPPED + node.skipped(reason: condition_false)
- timeout 超时后节点 FAILED
- retry：第一次失败、第二次成功 → COMPLETED + 1 个 node.retrying 事件

---

### Task 6：APINode（RemoteExecutable — HTTP）

**目标**：实现 HTTP 请求节点。

**产出**：
- `src/executor/remote-executor.ts`：共享 cancel 逻辑（监听 AbortSignal）
- `src/executor/api-executor.ts`：
  - 支持 GET/POST/PUT/DELETE
  - headers 和 body 中的 `${{ }}` 变量替换
  - exit_code：2xx → 0，其余为 HTTP 状态码
  - stdout：response body 文本，尝试 JSON.parse 填充 json 字段
  - timeout + retry
  - 大响应体（>1MB）写入临时文件，`ref` 为文件路径
- 测试用 mock fetch

**验证**：
- GET 请求 → 正确输出
- POST with body template → 变量替换后发送
- 404 响应 → `exit_code: 404` + FAILED
- 请求超时 → FAILED

---

### Task 7：AgentNode（Transport 接口）

**目标**：通过 Transport 接口与 Agent 通信。

**产出**：
- `src/transport/transport.ts`：`Transport`、`AgentSession`、`AgentRequest`、`AgentResponse` 接口定义（§类型系统）
- `src/executor/agent-executor.ts`：
  - 通过 `Transport.connect(agentId)` 获取 `AgentSession`
  - `session.execute({ prompt, signal })` 发送 prompt 并等待完整响应
  - prompt 中的 `${{ }}` 替换
  - exit_code 固定 0（连接失败 1）
  - node.completed metadata 附加 `{ tokens, model, latency_ms }`（§4.5.4.2）
  - AbortSignal 传入 execute()，abort 时 Transport 发送 cancel 消息
  - 默认重试 2 次指数退避（§4.4.4.3）
- 测试用 `FakeTransport` fixture（实现 `Transport` 接口，返回预设响应）

**验证**：
- FakeTransport 返回 "Hello from agent" → `stdout: "Hello from agent"`, `exit_code: 0`
- Token 统计出现在 node.completed 事件 metadata
- Transport 抛错 → FAILED + retry（2 次后最终失败）
- AbortSignal 取消 → FakeTransport 收到 abort signal

---

### Task 8：AuditNode（AwaitableExecutable）

**目标**：实现审批节点，支持 SUSPENDED 状态和外部恢复。

**产出**：
- `src/executor/awaitable-executor.ts`：
  - HMAC 签名 approval_token（密钥通过 `createWorkflowEngine` options 传入：`hmacSecret: string`）
  - token payload：`{ runId, nodeId, expiresAt }`
  - 默认过期时间 24h，可通过 `AuditNodeDef.expires_in` 覆盖
  - 触发 DAG 进入 SUSPENDED 状态
  - 发射 `audit.requested` 事件（metadata: approval_token, expires_at, display_data）
  - 暴露 `PendingApproval` 接口：`{ runId, nodeId, approvalToken, expiresAt, displayData }`
  - `approve(token, data)` 验证 HMAC + 过期时间 → 发射 `audit.approved` 事件 → 恢复 DAG
  - 错误 token 或过期 → 拒绝并报错
  - 超时 → FAILED + node.failed 事件
- 测试

**验证**：
- 审批节点执行 → DAG SUSPENDED + audit.requested 事件
- 正确 token → audit.approved + DAG 恢复 RUNNING
- 错误 token → 拒绝
- 过期 → FAILED
- HMAC 密钥通过 engine options 传入

---

### Task 9：SubWorkflowNode

**目标**：实现子流程引用和嵌套执行。

**产出**：
- `src/executor/sub-workflow-executor.ts`：
  - 解析 ref 路径 → 加载 + 解析 + 校验子 YAML（复用 Task 2 的 parser）
  - 参数映射：`params` 中 `${{ }}` 替换后按原始类型传递（`Record<string, unknown>`）
  - 子流程作为独立 DAG 运行（独立 run_id）
  - 发射 `sub_workflow.started` 事件（metadata: sub_run_id）
  - 发射 `sub_workflow.completed` 事件（metadata: sub_run_id, outputs）
  - `ignore_errors: true` → 子流程失败时父节点仍 COMPLETED，output 包含 `{ status: 'failed', error: '...' }`
  - 默认行为：子流程失败 → 父节点 FAILED + 标准错误传播
  - 嵌套深度建议不超过 3 层（§4.8.8），不做硬限制
- 测试 fixture YAML

**验证**：
- 基本子流程执行 → 正确输出
- 子流程失败 → 父节点 FAILED + 错误传播
- `ignore_errors: true` → 父节点 COMPLETED
- 嵌套 2 层

---

### Task 10：LoopNode

**目标**：实现循环节点（do-while 语义）。

**产出**：
- `src/executor/loop-executor.ts`：
  - 内部子 DAG（`LoopBody.nodes`），**复用 DAGScheduler** 实例
  - **独立命名空间**：子 DAG 节点 id 加前缀 `${loopNodeId}.iter${i}.${childNodeId}`，避免 snapshot 中 ID 冲突
  - do-while：先执行一次子 DAG → 求 condition → true 则继续迭代
  - condition 可引用子 DAG 内任意节点的输出（`${{ nodes.step1.output.stdout }}`）
  - `max_iterations` 限制（达到后强制退出 + node.failed）
  - 每次迭代发射 `loop.iteration_started`（metadata: iteration, max_iterations）和 `loop.iteration_completed`（metadata: iteration, will_continue）
  - 共享工作目录（§4.9.8）
  - output 为最后一次迭代的最终节点输出
- 测试

**验证**：
- 基本循环：3 次迭代后 condition 为 false → 退出
- `max_iterations` 达到 → 强制退出 + FAILED
- 迭代中节点失败 → 循环节点 FAILED
- 条件引用子 DAG 内节点输出
- loop 事件正确发射

---

### Task 11：恢复机制（Snapshot + Replay）

**目标**：崩溃后从快照恢复执行。

**难度分析**：

恢复机制的 70% 工作量已在基础设施层解决——Task 4 调度器的 `atomicNodeComplete()` 保证 output + snapshot + event 原子写入，崩溃不会丢一致性。Task 11 本质是"读状态 → 清理 → 喂回调度器"，核心逻辑 ~250 行，属于 14 个 Task 中相对独立且风险最低的。

| 基础设施 | 来源 | 对恢复的作用 |
|----------|------|-------------|
| `atomicNodeComplete()` | Task 4 (StorageAdapter) | output + snapshot + event 三者原子写入，崩溃不丢一致性 |
| PID 记录 | `node.started` metadata | 恢复时定位残留进程 |
| DAGSnapshot | 每节点完成后写入 | 恢复起点，存 `node_states: Record<id, {status, exit_code}>` |
| Event Sourcing | 全量事件流 | snapshot 后事件重放，补全最新状态 |

**实现分 4 步**：

1. **加载 + 重放（~80 行，简单）**：`getLatestSnapshot(runId)` → 重放 `last_event_id` 之后的事件 → 重建完整 nodeStates。纯数据操作，无副作用。
2. **孤儿检测（~40 行，简单）**：扫描事件流，`node.started` 存在 && `node.completed/failed/cancelled` 不存在 → 孤儿。
3. **孤儿清理（~120 行，中等）**：唯一的"难"点。
   - ProcessExecutable：`process.kill(pid, 0)` → 存活? → SIGTERM → 5s grace period → SIGKILL。需处理 `ESRCH`(已死)、`EPERM`(跨用户，保守视为存活)。
   - RemoteExecutable：`transport.cancel(sessionId)`，依赖 Task 7 的 Transport 实现。
4. **重新调度（~60 行，简单）**：跳过 COMPLETED/SKIPPED/CANCELLED，将 PENDING 和已清理孤儿节点喂给 DAGScheduler。调度器本身不需要改。

**边界场景难度**：

| 场景 | 难度 | MVP 策略 |
|------|------|---------|
| 线性 DAG（Shell + Agent + API） | ⭐ | 完整支持 |
| SUSPENDED 恢复（审批节点等待中崩溃） | ⭐⭐ | 恢复后重新进入 SUSPENDED，`approve()` 内部走 `recover()` 路径 |
| LoopNode 恢复（迭代中途崩溃） | ⭐⭐⭐ | MVP 标记 ERROR 需人工介入，后续迭代加入迭代级恢复 |
| SubWorkflowNode 恢复（嵌套子流程崩溃） | ⭐⭐⭐ | MVP 标记 ERROR 需人工介入，后续迭代加入递归恢复 |
| PID 复用（进程死后 PID 被系统回收） | ⭐ | 极端边界，保守检测 + grace period 已覆盖 |

**产出**：
- `src/recovery/snapshot-recovery.ts`：
  - 加载最新 snapshot → 重放后续事件 → 重建 `nodeStates`
  - 孤儿节点检测：`node.started` 但无 `node.completed/failed/cancelled`
  - **孤儿处理（区分执行原语）**：
    - ProcessExecutable（ShellNode）：`process.kill(pid, 0)` 检测存活 → 存活则 SIGTERM → 等待 5s grace period → 再次检测 → 仍存活则 SIGKILL
    - RemoteExecutable（AgentNode）：通过 Transport 发送 cancel 消息
    - 存活检测注意：`ESRCH` = 已死，`EPERM` = 视为存活（保守策略）
  - 记录 `node.cancelled` 事件
  - **根据重试策略决定**是否重新执行（§5.8.3）
  - 将未完成的节点重新调度执行
  - **MVP 限制**：LoopNode / SubWorkflowNode 崩溃恢复标记为 ERROR，不尝试迭代级或递归恢复
- 测试：模拟崩溃场景

**验证**：
- 正常完成后恢复 → 直接返回 SUCCESS
- 执行中崩溃 → 识别孤儿节点 → 终止残留进程 → 重新调度
- SUSPENDED 状态恢复 → 识别待审批节点 → 等待 approve
- LoopNode 崩溃恢复 → 标记 ERROR + node.failed 事件（MVP 行为）
- SubWorkflowNode 崩溃恢复 → 标记 ERROR + node.failed 事件（MVP 行为）

---

### Task 12：Secrets 解析器

**目标**：实现密钥声明、解析和脱敏。

**产出**：
- `src/secrets/secrets-resolver.ts`：
  - 优先级：系统环境变量 → .env 文件（简易解析，不引入 dotenv）→ CLI --env-file
  - `.env` 文件格式：`KEY=VALUE`，`#` 注释，空行忽略
  - 运行时作为环境变量注入到节点进程（§7.4），不落盘到 YAML 或事件流
  - **自动脱敏**：事件写入时 `redactSecrets(metadata, secretValues)` 将已知 secret 值替换为 `***`
  - 调度器维护 `secretValues` 集合（§5.9.2）
- 测试

**验证**：
- 环境变量中存在 → 解析成功
- `.env` 文件中存在 → 解析成功
- 两者都不存在 → `SECRET_NOT_FOUND` 错误
- 脱敏：metadata 中包含 secret 值 → 替换为 `***`

---

### Task 13：引擎门面（createWorkflowEngine）

**目标**：实现唯一公开 API 入口。

**产出**：
- `src/engine/workflow-engine.ts`：`createWorkflowEngine(options): WorkflowEngine`

```typescript
interface WorkflowEngineOptions {
  storage: StorageAdapter;
  transport?: Transport;          // AgentNode 需要，可选（无 AgentNode 的 workflow 不需要）
  hmacSecret: string;             // AuditNode 签名密钥
  envFile?: string;               // .env 文件路径
  defaultCwd?: string;            // 默认工作目录
}

interface WorkflowEngine {
  parse(yaml: string, baseDir?: string): WorkflowDef;
  validate(def: WorkflowDef): ValidationResult;
  run(yaml: string, params?: Record<string, unknown>): Promise<DAGRunResult>;
  dryRun(yaml: string): DryRunResult;
  cancel(runId: string): Promise<void>;
  approveNode(runId: string, nodeId: string, token: string, data?: unknown): Promise<void>;
  getRunStatus(runId: string): Promise<DAGSnapshot | null>;
  getOutput(runId: string, nodeId: string): Promise<NodeOutput | null>;
  getEvents(runId: string, opts?: { nodeId?: string }): Promise<DAGEvent[]>;
  getPendingApprovals(runId: string): Promise<PendingApproval[]>;
  recover(runId: string): Promise<DAGRunResult>;
}
```

- `src/index.ts`：受控导出所有公开类型和 `createWorkflowEngine`

**验证**：
- 完整 API 表面测试
- dryRun 返回正确执行计划（拓扑排序 + 并行分支信息）
- 生命周期：parse → validate → run → cancel

---

### Task 14：RCS 宿主集成

**目标**：在 RCS 中集成 workflow-engine。

> 此 Task 在 workflow-engine 包完成后执行，涉及 RCS 侧修改。

**产出**：

1. **PostgreSQL StorageAdapter**（`src/services/workflow/workflow-storage.ts`）：
   - 实现 `StorageAdapter` 接口
   - 新增数据库表（扩展 `src/db/schema.ts`）：
     - `workflowEvent`：事件流表（event_id, run_id, project_id, node_id, timestamp, type, node_type, metadata, team_id）
     - `workflowSnapshot`：快照表（snapshot_id, run_id, last_event_id, timestamp, node_states, dag_status, team_id）
     - `workflowNodeOutput`：节点输出表（run_id, node_id, stdout, json, exit_code, size, ref, team_id）
   - 所有新表包含 `team_id` 列（RCS 多租户要求）
   - `atomicNodeComplete` 使用 Drizzle 事务保证三者原子性
   - 与现有 `workflow`/`workflowRun` 表共存（旧表用于 YAML 元数据和运行列表 UI）

2. **ACP Transport 实现**（`src/services/workflow/acp-transport.ts`）：
   - 实现 `Transport` 接口
   - `connect(agentId)` → 查找在线 Environment → 通过 relay WebSocket 获取 ACP session → 返回 `AgentSession`
   - `AgentSession.execute()` → `ACPClient.sendPrompt()` → 收集 `session_update` 流 → `prompt_complete` 时组装 `AgentResponse`
   - AbortSignal → `ACPClient.cancel()`

3. **API 路由**（`src/routes/web/workflows.ts`，遵循 RCS POST + action 模式）：
   ```
   POST /web/workflows
   body: { action: "run", yaml: string, params?: Record<string, unknown> }
   body: { action: "listRuns", projectId?: string }
   body: { action: "getRunStatus", runId: string }
   body: { action: "getEvents", runId: string, nodeId?: string }
   body: { action: "getOutput", runId: string, nodeId: string }
   body: { action: "cancel", runId: string }
   body: { action: "approve", runId: string, nodeId: string, token: string, data?: unknown }
   body: { action: "getPendingApprovals", runId: string }
   ```

4. **前端集成**（独立规划，本 Task 仅标注范围）：
   - 新增前端 API client 方法（`web/src/api/client.ts`）
   - WorkflowPage 从 iframe 容器过渡到原生 UI（或保持 iframe + 新增原生 Tab）
   - 审批节点 UI 交互设计
   - 运行状态 SSE 推送（可选）
   - DAG 可视化组件（独立规划）

5. **workflow-proxy.ts 共存**：
   - 新路由 `/web/workflows` 与旧 proxy `/workflow-ui/*`、`/api/v1/*` 不冲突
   - 过渡期间两套路由共存，用户可选择使用 acpx-g 或新引擎

## 任务依赖图

```
Task 1 (脚手架+类型)
  ├─→ Task 2 (解析器+校验器)      ─┐
  └─→ Task 3 (StorageAdapter)     ├→ 可并行
                                    │
       Task 4 (调度器) ←───────────┘
        ├─→ Task 5 (ShellNode) ← 第一个端到端可运行
        │    ├─→ Task 6 (APINode)         ─┐
        │    ├─→ Task 7 (AgentNode)        │
        │    ├─→ Task 8 (AuditNode)        ├→ 可并行
        │    ├─→ Task 9 (SubWorkflowNode)  │
        │    ├─→ Task 10 (LoopNode)        │
        │    └─→ Task 11 (恢复机制)        ─┘
        └─→ Task 12 (Secrets) ← 可与 Task 5+ 并行
       └─→ Task 13 (引擎门面) ← 依赖 Task 4-12 全部
            └─→ Task 14 (RCS 集成) ← 最后执行
```

**并行机会**：
- Task 2 和 Task 3 可并行
- Task 5 完成后，Task 6/7/8/9/10/11/12 可并行
- Task 13 在所有 executor 完成后整合

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| YAML 解析库体积 | 使用 `yaml` v2（~200KB），`JSON_SCHEMA` 禁用危险类型；备选手写子集解析器 |
| 表达式求值器安全 | 递归下降解析器；命名空间白名单（nodes/params/secrets）；深度限制 10 层；长度限制 1024 字符；禁止 __proto__/constructor |
| Bun.spawn stderr OOM | 异步消费 stderr + 10MB 上限，超出 kill 子进程 |
| Bun.spawn 跨平台 | 明确仅支持 macOS/Linux |
| 事件量爆炸 | stdout 不写入事件流，仅存储在 output 表；小输出（<1MB）内联，大输出走引用 |
| 循环节点复杂度 | 限制 max_iterations；子 DAG id 加命名空间前缀隔离 |
| Transport 与 ACPClient 适配 | 有状态 session 模型对齐 ACP 协议；RCS 侧实现封装 ACPClient 完整生命周期 |
| SUSPENDED crash 安全 | 统一为 Snapshot + 退出模式；approve() 内部走 recover() 路径 |
| 审批 HMAC 密钥管理 | 通过 engine options 传入，由宿主（RCS）持久化管理 |

## 后续扩展（MVP 范围外）

### CLI 工具（对齐 17-workflow.md §11）

| 命令 | 说明 | 依赖 |
|------|------|------|
| `acp run <workflow.yaml> --params '{}'` | 执行 workflow | Task 13 |
| `acp dry-run <workflow.yaml>` | 校验 + 展示执行计划 | Task 13 |
| `acp run-node <yaml> <node_id> --mock-input '{}'` | 单节点调试 | Task 13 |
| `acp ls` | 查看运行历史 | Task 13 |
| `acp trace <run_id>` | 查看事件流时间线 | Task 13 |
| `acp output <run_id> <node_id>` | 查看节点输出 | Task 13 |
| `acp approve <run_id> <node_id> --token <token>` | CLI 审批 | Task 8 |
| `acp migrate <workflow.yaml>` | schema 迁移（acpx-g → 新格式） | 独立脚本 |

### 可观测性（对齐 17-workflow.md §9）

- 结构化日志：JSON 格式输出 stderr，含 run_id/node_id/timestamp/level/message
- 事件流即 Trace：Event Sourcing 提供完整执行历史
- 不引入 OpenTelemetry

### 可视化编辑器（对齐 17-workflow.md §10）

- 借鉴 Dify/n8n 画布体验
- 直接读写 YAML 文件（拖拽 → 修改 .yaml）
- 精确 YAML 位置追踪为理想目标，MVP 降级为规范化输出
