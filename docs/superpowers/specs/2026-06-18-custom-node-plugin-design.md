# 自定义节点插件系统

> Design 1/2 — 通用扩展框架。Slurm 具体实现在 [Design 2](./2026-06-18-slurm-node-design.md) 中定义。
>
> 2026-06-18 · `packages/workflow-engine/`

---

## 1. 概述

### 1.1 做什么

让用户通过 TypeScript 文件定义自定义节点类型，无需修改引擎核心代码。用户只需在 `tools/` 目录放置 TS 文件，服务启动时自动扫描注册，前端自动展示可用工具。

### 1.2 设计目标

| 目标 | 说明 |
|------|------|
| **零引擎侵入** | `NodeType` 只增加一个 `"custom"`，不改现有 8 种类型的逻辑 |
| **工具即代码** | 文件系统是唯一真相源，不做 DB 存储 |
| **声明式定义** | 工具的 inputs/produces/校验规则均声明式，前端可自动渲染 |
| **引擎负责编排** | foreach 展开、并发控制、进度聚合、失败隔离都是引擎层职责 |

### 1.3 与 Design 2 的边界

| | Design 1（本文档） | Design 2（后续） |
|---|---|---|
| 核心 | `CustomNode` 接口 + Registry + YAML 集成 | `SlurmNode` abstract class + 具体实现 |
| 用户接触 | tools/ 里的 TS 文件 | tools/ 里继承 SlurmNode 的具体工具 |
| 不包含 | SSH/sbatch/sacct 封装 | CustomNode 接口定义 |

---

## 2. 架构概览

```
tools/trim_galore.ts                    YAML workflow
     │                                       │
     │ implements CustomNode                  │ type: "custom", tool: "trim_galore"
     ▼                                       ▼
CustomNodeRegistry.discover()          parseNode() → CustomNodeDef
     │                                       │
     └─────── 查找 tool="trim_galore" ───────┘
                       │
                       ▼
              CustomNodeExecutor.execute(node, ctx)
                       │
                  ┌────┴────┐
                  │ Zod 校验 │  → inputs 值校验
                  ├─────────┤
                  │ execute │  → 调 tool.execute(ctx)
                  ├─────────┤
                  │onCleanup│  → 调 tool.onCleanup(ctx)（可选）
                  └─────────┘
```

### 2.1 核心角色

| 角色 | 类型 | 职责 |
|------|------|------|
| `CustomNode` | interface | 工具定义合约：name / description / inputs / produces / execute / onCleanup |
| `ExecuteContext` | interface | 引擎→工具的运行时上下文：求值后的 inputs / params / workDir / signal / foreach / runId |
| `CustomNodeDef` | interface | YAML 节点定义：type="custom" + tool + foreach + inputs（表达式字符串） |
| `CustomNodeRegistry` | class | 工具注册表：扫描 tools/ → 实例化 → 按 name 索引 |
| `CustomNodeExecutor` | class | 桥接器：implements `NodeExecutor`，查 registry → 校验 → execute → cleanup |

---

## 3. 核心类型定义

### 3.1 `InputDef` — 输入字段声明

```typescript
import type { z } from "zod/v4";

interface InputDef {
  /** 字段类型，前端据此渲染 input handle */
  type: "string" | "number" | "boolean" | "file" | "file-list";
  /** 是否必填，默认 true */
  required?: boolean;
  /** 字段描述，前端 tooltip */
  description: string;
  /** Zod 校验 schema。引擎在 inputs 表达式求值后、execute() 调用前执行校验 */
  validate?: z.ZodType;
}
```

### 3.2 `CustomNode` — 工具定义接口

```typescript
interface CustomNode {
  /** 工具唯一名称，YAML 中通过 tool 字段引用 */
  name: string;

  /** 工具描述，前端卡片展示 + tooltip */
  description: string;

  /** 输入字段声明 */
  inputs: Record<string, InputDef>;

  /** 输出字段名列表。具体的文件路径 pattern 在 YAML 的 CustomNodeDef.outputs 中声明 */
  produces: string[];

  /** 核心执行方法。引擎可能在 foreach 场景下调多次，每次处理一个迭代单元 */
  execute(ctx: ExecuteContext): Promise<NodeOutput>;

  /**
   * 清理钩子（可选）。execute() 之后必定调用，无论成功失败。
   * 用于清理临时文件、释放远程连接等。
   * 结果和错误可能同时为 null（execute 抛非预期异常时）。
   */
  onCleanup?(ctx: ExecuteContext, result: NodeOutput | null, error: Error | null): Promise<void>;
}
```

### 3.3 `ExecuteContext` — 运行时上下文

```typescript
interface ExecuteContext {
  /** 已求值的输入值，key 对应 CustomNode.inputs 的 key */
  inputs: Record<string, unknown>;

  /** 工作流级 params */
  params: Record<string, unknown>;

  /** 工作流级 secrets */
  secrets: Record<string, string>;

  /** 工作目录根路径 */
  workDir: string;

  /** 取消信号，引擎 cancel 时 AbortController.abort() */
  signal: AbortSignal;

  /** 存储适配器（写事件/输出） */
  storage: StorageAdapter;

  /** 运行 ID */
  runId: string;

  /** 节点 ID */
  nodeId: string;

  /**
   * foreach 迭代上下文。
   * 非 Map 节点为 null。Map 节点引擎自动展开，每次 execute() 注入当前迭代元素。
   */
  foreach?: {
    item: Record<string, unknown>;
    index: number;
  };
}
```

### 3.4 `CustomNodeDef` — YAML 节点定义

```typescript
interface CustomNodeDef extends BaseNodeDef {
  type: "custom";
  /** 对应 CustomNode.name，解析时从 CustomNodeRegistry 查找 */
  tool: string;

  /**
   * 输入绑定。key 对应 CustomNode.inputs 的 key，value 为表达式字符串。
   * 引擎在运行时通过 resolveInputs() 求值。
   */
  inputs?: Record<string, string>;

  /**
   * 输出声明。key 对应 CustomNode.produces 的元素，
   * value 为 { pattern: 路径模板（支持 ${{ }}）, type: "file" | "file-list" | "dir" }。
   */
  outputs: Record<string, {
    pattern: string;
    type: "file" | "file-list" | "dir";
  }>;

  /** 迭代数据源表达式，引擎自动展开为 N 个子任务 */
  foreach?: string;

  /** 最大并发子任务数 */
  maxConcurrent?: number;

  /** 子任务失败是否继续，默认 false → 任一失败则整节点 FAILED */
  continueOnError?: boolean;
}
```

### 3.5 `NodeDef` 联合体扩展

```typescript
// types/dag.ts 改动
export type NodeType = "shell" | "python" | "agent" | "api" | "audit"
                     | "workflow" | "loop" | "transform" | "custom";

export type NodeDef =
  | ShellNodeDef
  | PythonNodeDef
  | AgentNodeDef
  | ApiNodeDef
  | AuditNodeDef
  | SubWorkflowNodeDef
  | LoopNodeDef
  | TransformNodeDef
  | CustomNodeDef;  // ← 新增
```

---

## 4. 执行流程

### 4.1 单次 execute 调用流程

```
CustomNodeExecutor.execute(nodeDef, ctx)
  │
  ├─ 1. 从 CustomNodeRegistry 查找 tool
  │     const tool = registry.get(nodeDef.tool);
  │     if (!tool) → 抛 WorkflowError: 工具未注册
  │
  ├─ 2. 表达式求值
  │     const resolvedInputs = resolveInputs(nodeDef.inputs, evalCtx);
  │
  ├─ 3. Zod 校验
  │     for (const [key, def] of tool.inputs) {
  │       if (def.validate) def.validate.parse(resolvedInputs[key]);
  │     }
  │     校验失败 → 抛 WorkflowError: inputs 不合法
  │
  ├─ 4. 构建 ExecuteContext
  │     ctx = { inputs: resolvedInputs, params, workDir, signal, storage, foreach, ... }
  │
  ├─ 5. 调用 tool.execute(ctx)
  │     result = await tool.execute(ctx);
  │     抛异常 → 记录错误，进入 cleanup
  │
  ├─ 6. 调用 tool.onCleanup(ctx, result, error)（如果定义了）
  │
  └─ 7. 返回 NodeOutput 或 重抛异常
        if (result) return result;
        if (error) throw error;
```

### 4.2 foreach 展开流程

引擎在调度层处理 foreach，`CustomNodeExecutor` 不感知：

```
调度器检测到 nodeDef.foreach
  │
  ├─ 1. 求值 foreach 表达式 → 获数组 items
  │
  ├─ 2. 按 maxConcurrent 分批
  │
  ├─ 3. 每个子任务:
  │     subCtx = { ...ctx, foreach: { item: items[i], index: i } }
  │     发射 "node.subjob_started" 事件
  │     └→ CustomNodeExecutor.execute(nodeDef, subCtx)
  │         结果 → 发射 "node.subjob_completed" / "node.subjob_failed"
  │
  ├─ 4. 全部子任务完成:
  │     全成功 → 聚合子任务输出 → 节点 COMPLETED
  │     continueOnError → 部分失败 → 聚合成功部分 → COMPLETED_WITH_FAILURES
  │     !continueOnError + 有失败 → 节点 FAILED
  │
  └─ 5. 发射 "node.map_progress" 事件
        { nodeId, completed, total, failed, subJobs }
```

---

## 5. CustomNodeRegistry

### 5.1 接口

```typescript
class CustomNodeRegistry {
  private tools: Map<string, CustomNode> = new Map();

  /** 启动时扫描 tools/ 目录，实例化所有工具 */
  static async discover(toolsDir: string): Promise<CustomNodeRegistry>;

  /** 按名称查找工具 */
  get(name: string): CustomNode | undefined;

  /** 列出所有已注册工具（供前端 API） */
  list(): Array<{ name: string; description: string; inputs: Record<string, InputDef>; produces: string[] }>;

  /** 手动注册一个工具（测试用） */
  register(tool: CustomNode): void;
}
```

### 5.2 扫描流程

```
CustomNodeRegistry.discover(toolsDir)
  │
  ├─ fs.readdir(toolsDir) → 过滤 *.ts 文件
  │
  ├─ 对每个文件:
  │     const module = await import(path);
  │     const ToolClass = module.default;
  │     const instance = new ToolClass();
  │
  ├─ 校验:
  │     if (!instance.name || typeof instance.execute !== "function")
  │       → 跳过 + console.warn
  │     if (this.tools.has(instance.name))
  │       → 抛 Error: 工具名重复
  │
  └─ this.tools.set(instance.name, instance);
```

### 5.3 生命周期

- **全局单例**：服务启动时调用 `discover()` 一次，per-run 复用
- **不热加载**：文件变更需重启服务生效
- **不存 DB**：工具定义即代码

---

## 6. YAML 集成

### 6.1 YAML 解析扩展

**`parseWorkflowYaml` 签名变更**:

```typescript
interface ParseOptions {
  /** CustomNodeRegistry 实例，用于校验 tool 存在性 + produces 匹配 */
  customRegistry?: CustomNodeRegistry;
}

// 原签名: parseWorkflowYaml(source: string, baseDir?: string): WorkflowDef
// 新签名:
function parseWorkflowYaml(source: string, baseDir?: string, opts?: ParseOptions): WorkflowDef;
```

**`parseNode()` 新增 `case "custom"`**:

```typescript
// yaml-parser.ts 中 parseNode() 新增 case:

case "custom": {
  if (!("tool" in n) || typeof n.tool !== "string" || !n.tool.trim()) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): custom node requires 'tool'`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }
  // 校验 tool 在 CustomNodeRegistry 中存在（需要依赖注入）
  const registry = parseOptions?.customRegistry;
  const toolDef = registry?.get(n.tool);
  if (registry && !toolDef) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): custom tool '${n.tool}' not registered`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  // 校验 outputs: 必须声明，且 key 都在 toolDef.produces 中
  if (toolDef && (!n.outputs || !isRecord(n.outputs))) {
    throw new WorkflowError(
      `nodes[${index}] (${n.id}): custom node requires 'outputs' mapping`,
      WorkflowErrorCode.INVALID_YAML,
    );
  }

  return {
    ...base,
    type: "custom",
    tool: n.tool as string,
    inputs: isRecord(n.inputs) ? (n.inputs as Record<string, string>) : undefined,
    outputs: parseOutputs(n.outputs),
    foreach: typeof n.foreach === "string" ? n.foreach : undefined,
    maxConcurrent: typeof n.maxConcurrent === "number" ? n.maxConcurrent : undefined,
    continueOnError: typeof n.continueOnError === "boolean" ? n.continueOnError : undefined,
  };
}
```

### 6.2 DAG 校验扩展

`validateDAG()` 中针对 custom 节点新增校验规则：

```
1. outputs 的 key 必须在 CustomNode.produces 中存在
   否则 → ERROR: "output 'xxx' not declared in tool's produces list"
2. produces 中声明的字段必须在 outputs 中绑定
   否则 → WARNING: "produces 'xxx' is not bound in outputs, downstream cannot reference"
3. foreach 表达式引用的变量必须在 params 或上游 outputs 中存在
   否则 → ERROR: "foreach references undefined variable"
```

### 6.3 使用示例

```yaml
nodes:
  - id: trim
    type: custom
    tool: trim_galore
    foreach: "${{ params.samples }}"
    maxConcurrent: 5
    inputs:
      r1: "${{ foreach.item.r1 }}"
      r2: "${{ foreach.item.r2 }}"
    outputs:
      trimmed_r1:
        pattern: "${{ params.work_dir }}/step_trim/${{ foreach.item.id }}_1_val_1.fq.gz"
        type: file
      trimmed_r2:
        pattern: "${{ params.work_dir }}/step_trim/${{ foreach.item.id }}_2_val_2.fq.gz"
        type: file
```

---

## 7. 引擎集成

### 7.1 改动文件清单

| 文件 | 改动类型 | 描述 |
|------|---------|------|
| `types/dag.ts` | 修改 | `NodeType` 加 `"custom"`; `NodeDef` 加 `CustomNodeDef`; 新增 `CustomNodeDef` 接口 |
| `parser/yaml-parser.ts` | 修改 | `VALID_NODE_TYPES` 加 `"custom"`; `parseNode` 加 `case "custom"`; `parseWorkflowYaml` 接受 `ParseOptions` |
| `plugins/types.ts` | **新建** | `CustomNode`, `InputDef`, `ExecuteContext` 接口 |
| `plugins/registry.ts` | **新建** | `CustomNodeRegistry` 类 |
| `plugins/custom-executor.ts` | **新建** | `CustomNodeExecutor`（implements `NodeExecutor`） |
| `engine/workflow-engine.ts` | 修改 | `buildRegistry()` 注册 `"custom"` → `CustomNodeExecutor`; `WorkflowEngineOptions` 加 `customRegistry`; `parse()`/`run()` 传递 `ParseOptions` |
| `index.ts` | 修改 | 导出新增类型和类 |
| `executor/node-executor.ts` | 无需修改 | `NodeExecutorRegistry` 已支持 string key，直接 `register("custom", ...)` 即可 |

### 7.2 `WorkflowEngineOptions` 扩展

```typescript
interface WorkflowEngineOptions {
  // ... 现有字段 ...
  /** 自定义工具注册表（由服务启动时创建并注入） */
  customRegistry?: CustomNodeRegistry;
}
```

### 7.3 `buildRegistry()` 改动

```typescript
function buildRegistry(runId: string, baseDir: string): NodeExecutorRegistry {
  const registry = new NodeExecutorRegistry();
  // ... 现有注册 ...
  if (customRegistry) {
    registry.register("custom", new CustomNodeExecutor(customRegistry));
  }
  return registry;
}
```

---

## 8. 错误处理约定

### 8.1 工具层错误

| 场景 | 行为 |
|------|------|
| `execute()` 正常返回 `NodeOutput` | 节点 COMPLETED |
| `execute()` 抛出 `WorkflowError` | 节点 FAILED，错误信息记录到 events |
| `execute()` 抛出其他 `Error` | 节点 FAILED，包装为 `WorkflowError` |
| `onCleanup()` 抛异常 | `console.error` 记录，不改变 execute 的结果状态 |

### 8.2 校验错误

| 阶段 | 校验内容 | 失败处理 |
|------|---------|---------|
| YAML 解析 | `tool` 是否存在、`outputs` key 是否匹配 `produces` | 抛 `WorkflowError`，工作流无法启动 |
| 运行时 | inputs Zod 校验 | 抛 `WorkflowError`，节点 FAILED |

---

## 9. 前端

### 9.1 发现 API

```
GET /api/workflow/custom-nodes

Response:
{
  "items": [
    {
      "name": "trim_galore",
      "description": "Adapter trimming + quality filtering",
      "inputs": {
        "r1": { "type": "file", "required": true, "description": "Read 1 FASTQ" },
        "r2": { "type": "file", "required": true, "description": "Read 2 FASTQ" }
      },
      "produces": ["trimmed_r1", "trimmed_r2"]
    }
  ]
}
```

### 9.2 节点卡片

```
┌──────────────────────────────┐
│ 🔧 Trim Galore               │  ← CustomNode.name
│ custom · 4 inputs            │  ← type + inputs 数量
│──────────────────────────────│
│ 📥 r1 (file, required)        │  ← 从 inputs 声明生成
│ 📥 r2 (file, required)        │
│──────────────────────────────│
│ 📤 trimmed_r1                 │  ← 从 produces 声明生成
│ 📤 trimmed_r2                 │
└──────────────────────────────┘
```

### 9.3 前端改动点

| 文件 | 改动 |
|------|------|
| `nodes.tsx` | `NODE_COLORS/ICONS` 注册 `custom` 类型 |
| `NodeConfigCard.tsx` | 新增 `CustomNodeConfig` 表单（tool 下拉选择 + inputs/outputs 绑定） |
| `api/sdk.ts` | 新增 `listCustomNodes()` API |

---

## 10. 测试策略

### 10.1 单元测试

| 测试对象 | 覆盖点 |
|---------|--------|
| `CustomNodeRegistry` | discover 扫描、name 重复检测、get/list |
| `CustomNodeExecutor` | 正常执行 + cleanup 调用 + Zod 校验失败 + execute 抛异常后仍调 cleanup |
| `yaml-parser` | custom 节点解析、tool 不存在报错、outputs 校验 |

### 10.2 集成测试

| 场景 | 验证点 |
|------|--------|
| 最小 custom 工具（echo） | 完整 run 链路：解析 → 校验 → 执行 → 输出 |
| foreach custom 工具 | N 子任务各自独立 + all() 收集 |
| cleanup 调用顺序 | execute 失败后 onCleanup 仍执行 |

---

## 11. 后续

| 优先级 | 能力 | 设计归属 |
|--------|------|---------|
| 🔴 P0 | `SlurmNode` 基类 + SSH/sbatch/sacct 封装 | Design 2 |
| 🟡 P1 | `ShellNodeBase`（非 Slurm custom node） | Design 3 |
| 🟡 P1 | 工具热加载（chokidar 监听） | 本文档扩展 |
| 🟡 P1 | `InputDef` 支持 `default` / `enum` | 本文档扩展 |
| 🟢 P2 | 工具市场（Git repo 拉取） | 本文档扩展 |

---

## 附录 A. 设计决策

| # | 决策 | 选择 | 原因 |
|---|------|------|------|
| D1 | 类型系统 | 统一 `CustomNodeDef`，`tool` 字段区分 | 不改 NodeType 枚举，静态类型安全 |
| D2 | Registry 生命周期 | 全局单例，启动扫描一次 | 简单，工具即代码不需热加载 |
| D3 | Outputs 声明 | 工具声明 `produces: string[]`，pattern 在 YAML 层 | 路径决策权归工作流编写者 |
| D4 | 失败模型 | 抛异常 = FAILED | 与现有引擎行为一致 |
| D5 | Inputs 校验 | Zod schema，运行时在求值后校验 | 可序列化，前端可展示规则 |
| D6 | 生命周期 | `execute()` + 可选 `onCleanup()` | 覆盖清理场景，不给简单工具增加负担 |
| D7 | foreach | 引擎统一展开，工具只处理单次调用 | 并发/聚合/失败隔离是引擎职责 |
| D8 | Inputs 解析 | 复用现有 `resolveInputs()` | 不重复造轮子 |
| D9 | 文档位置 | `docs/superpowers/specs/` | 与曙光场景分离 |
