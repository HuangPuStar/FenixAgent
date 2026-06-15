# Transform 节点设计

> 状态：设计中 | 日期：2026-06-09

## 1. 动机

当前 workflow 的数据转换需求只能通过 shell/python 节点实现——为了一次 JSON 字段提取或格式调整必须启动子进程。transform 节点提供一个**零子进程、纯内存**的数据处理节点，在 DAG 数据流中充当"管道处理器"。

## 2. 节点定义

### 2.1 TypeScript 类型

```typescript
/** Transform 节点 — 纯内存 JSON 变换 */
export interface TransformNodeDef extends BaseNodeDef {
  type: "transform";
  /** 从上游拉取的数据，key 为变量名，value 为表达式（如 nodes.X.output） */
  inputs?: Record<string, string>;
  /** 输出结构，key 为字段名，value 为 JavaScript 表达式 */
  output: Record<string, string>;
}
```

`NodeType` 联合类型新增 `"transform"`，`NodeDef` 判别联合纳入 `TransformNodeDef`。

### 2.2 YAML 示例

```yaml
nodes:
  # 基本：提取 + 重塑上游 JSON
  - id: reshape
    type: transform
    depends_on: [api_1]
    inputs:
      data: nodes.api_1.output
    output:
      names: "data.items.map(i => i.name)"
      avg_score: "data.items.reduce((s, i) => s + i.score, 0) / data.items.length"
      top_student: "data.items.find(i => i.score >= 95)?.name ?? 'none'"

  # 聚合多个上游节点
  - id: merge
    type: transform
    depends_on: [users_api, orders_api]
    inputs:
      users: nodes.users_api.output
      orders: nodes.orders_api.output
    output:
      user_count: "users.total"
      order_count: "orders.total"
      ratio: "(orders.total / users.total).toFixed(2)"

  # 使用 params 和 secrets
  - id: enrich
    type: transform
    depends_on: [fetch]
    inputs:
      data: nodes.fetch.output
    output:
      result: "data.items.filter(i => i.level >= params.minLevel)"
```

### 2.3 DAG 编辑器配置面板

新增配置区域（按 nodeType `"transform"` 渲染）：

| 字段 | 控件 | 说明 |
|------|------|------|
| inputs | `InputsEditor`（已有组件） | key-value，value 为 `nodes.X.output` 表达式 |
| output | 新增 `OutputsEditor` | key-value，key 为输出字段名，value 为 JS 表达式 |
| description | input | 节点描述 |
| timeout | number input | 超时（秒），默认不限制 |
| retry | number input | 重试次数 |

## 3. 执行模型

### 3.1 输入解析阶段

同 shell/python 节点，通过 `resolveInputs()` 解析 `inputs` 表达式：

```
inputs: { data: "nodes.api_1.output.items", count: "nodes.api_1.output.total" }
→ resolved: { data: [...], count: 2 }
```

### 3.2 表达式求值阶段

对 `output` 中的每个表达式，按序求值：

1. 构建作用域对象：`{ ...resolvedInputs, params, secrets }`
2. 对每个 key-value，将 value 字符串通过 `new Function()` 编译为函数并执行
3. 将返回值组装为结果对象

```typescript
function evaluateTransform(output: Record<string, string>, scope: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, expr] of Object.entries(output)) {
    try {
      const fn = new Function(
        ...Object.keys(scope),
        `"use strict"; return (${expr})`
      );
      result[key] = fn(...Object.values(scope));
    } catch (err) {
      // 任一表达式失败 → 整节点失败
      throw new WorkflowError(
        `Transform expression '${key}' failed: ${(err as Error).message}`,
        WorkflowErrorCode.NODE_FAILED
      );
    }
  }
  return result;
}
```

### 3.3 输出

```
NodeOutput {
  stdout: JSON.stringify(result),
  json: result,
  exit_code: 0
}
```

下游节点可通过 `nodes.transform_1.output.names`、`nodes.transform_1.output.avg_score` 等访问具体字段。

### 3.4 安全约束

| 约束 | 实现方式 |
|------|---------|
| 表达式超时 | `setTimeout` 超时后杀死（TBD：具体机制） |
| 禁止访问全局 | `new Function()` 作用域仅注入 inputs/params/secrets |
| 返回值检查 | 必须可 JSON 序列化，否则抛错 |
| 表达式长度 | 暂不做硬限制，依赖 workflow YAML 整体校验 |

## 4. 改动清单

### 4.1 后端 — workflow-engine 包

| 文件 | 改动 |
|------|------|
| `types/dag.ts` | 新增 `TransformNodeDef`，`NodeType` 加 `"transform"`，`NodeDef` 加成员 |
| `parser/yaml-parser.ts` | `VALID_NODE_TYPES` 加 `"transform"`；`parseNode()` 增加 transform 分支校验（要求 `output` 字段存在且非空） |
| `parser/dag-validator.ts` | 扫描 transform 节点 `inputs` 中的 `nodes.<id>` 引用，校验 depends_on 声明（复用现有逻辑） |
| `executor/transform-executor.ts` | **新文件**：`TransformExecutor` 实现 `NodeExecutor` 接口 |
| `engine/workflow-engine.ts` | `buildRegistry()` 注册 `"transform"` |
| `index.ts` | 导出 `TransformNodeDef` |
| `scheduler/dag-scheduler.ts` | `resolveNodeInputs()` 的 switch 增加 `"transform"` case（解析 inputs） |

### 4.2 前端

| 文件 | 改动 |
|------|------|
| `web/src/api/workflow-engine.ts` | `NodeType` 加 `"transform"` |
| `web/src/pages/workflow/nodes.tsx` | `NODE_COLORS`、`NODE_ICONS`、`NODE_LABEL_KEYS`、`getPreview()`、`nodeTypes` 加 transform |
| `web/src/pages/workflow/WorkflowEditor.tsx` | `PALETTE_ITEMS` 加 transform |
| `web/src/pages/workflow/yaml-utils.ts` | `TYPE_PREFIXES` 加 transform |
| `web/src/pages/workflow/components/NodeConfigCard.tsx` | 新增 `{nodeType === "transform" && (...)}` 配置表单（inputs + output 编辑器） |
| `web/src/pages/workflow/components/NodeConfigPanel.tsx` | 同上 |
| `web/src/i18n/locales/en/workflows.json` | 新增 `nodes.transform`、`editor.transform_output`、`editor.transform_output_add`、`editor.transform_output_key_placeholder`、`editor.transform_output_value_placeholder` 等 |
| `web/src/i18n/locales/zh/workflows.json` | 同上中文 |

### 4.3 不涉及的改动

- **DB schema**：无需变更。节点定义在 YAML 中，`workflowEvent.nodeType` 是 varchar 天然兼容。
- **SSE / 事件系统**：复用现有事件类型 `node.started`/`node.completed`/`node.failed`。
- **快照恢复**：复用现有流程，snapshot 的 `nodeStates` 无类型约束。
- **condition 条件边**：`BaseNodeDef.condition` 继承，按需使用。

## 5. 待定项

| 事项 | 决定 |
|------|------|
| 表达式超时机制 | MVP 暂不做硬限制，后续考虑 |
| `requirements` 字段（npm 包） | MVP 不做，仅使用 JS 内置 API |
| 表达式沙箱深度安全 | `new Function()` + strict mode，不引入完整沙箱 |
