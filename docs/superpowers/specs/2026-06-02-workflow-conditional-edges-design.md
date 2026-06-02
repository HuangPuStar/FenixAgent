# Workflow 条件边与参数指引边设计

**日期**: 2026-06-02
**范围**: `web/src/pages/workflow/` 前端可视化层
**不改后端数据模型**

---

## 背景

当前 Workflow 编辑器只有一种边（smoothstep 折线），连接节点顶部 target Handle 和底部 source Handle，表达执行依赖关系。无法可视化：
- 条件执行（`condition` 字段）
- 参数传递（`inputs` 字段引用上游节点输出）

需要引入两种视觉上可区分的边类型。

---

## 设计

### 1. 逻辑关系边（上下方向）

**连接点**：节点顶部 target Handle（入）→ 底部 source Handle（出），和现有一致。

**语义**：执行依赖，A 完成后执行 B。

**视觉规则**：
- 无 `condition` → **实线贝塞尔曲线**，灰色/节点主色
- 有 `condition` → **虚线贝塞尔曲线**（dashed），灰色/节点主色
- 曲线类型从 `smoothstep`（直角折线）改为 `bezier`（贝塞尔曲线）

**数据来源**：`depends_on` 数组 → 边列表。目标节点有 `condition` 字段时画虚线。

### 2. 参数指引边（左右方向）

**连接点**：节点两侧的出入口 point，不使用 @xyflow/react 的标准 Handle。

**语义**：数据流，A 的某个输出字段 → B 的某个输入变量。

**视觉规则**：
- **点线贝塞尔曲线**（dotted）
- **更细**：线宽 1px（逻辑边默认 2px）
- **颜色区分**：绿色（#10b981），和逻辑边（灰色）形成对比
- **纯解析驱动**：从 `inputs` 表达式自动生成，用户不能手动拖拽创建

**数据来源**：解析节点的 `inputs: Record<string, string>` 字段。

### 3. 出入口 Point 布局

**入口 point**（节点左侧）：
- 从当前节点的 `inputs` 字段解析
- 每个 key 一个 point，标签显示变量名（如 `greeting`、`count`）
- 纵向排列在节点左侧中部

**出口 point**（节点右侧）：
- 从**所有下游节点**的 `inputs` 表达式中，引用了当前节点的字段生成
- 解析 `nodes.<nodeId>.<field>` 表达式，每个被引用的 field 一个 point
- 标签显示被引用的字段名（如 `stdout`、`exit_code`）
- 纵向排列在节点右侧中部
- 同一字段被多个下游引用时只显示一个出口 point

**point 样式**：
- 圆形，6px 直径
- 入口：橙色（#f59e0b），带变量名标签
- 出口：绿色（#10b981），带字段名标签
- 标签 9px 字号，紧贴 point

### 4. 边型切换

所有边从 `smoothstep`（直角折线）改为自定义贝塞尔曲线 edge type。@xyflow/react 支持自定义 edge renderer，通过 `path` 元素绘制三次贝塞尔曲线。

---

## 解析逻辑

### 参数指引边生成

输入：所有节点的 `inputs` 字段。

```typescript
interface DataFlowEdge {
  id: string;
  sourceNodeId: string;  // 上游节点
  sourceField: string;   // 输出字段名 (如 "stdout")
  targetNodeId: string;  // 下游节点
  targetParam: string;   // 输入变量名 (如 "greeting")
}
```

解析步骤：
1. 遍历所有节点，读取 `inputs` 字段
2. 对每个 input 值，解析 `nodes.<nodeId>.<field>` 模式
3. 收集所有 DataFlowEdge
4. 去重：同一 sourceNodeId + sourceField 只生成一个出口 point

### 示例

```yaml
nodes:
  - id: shell_1
    type: shell
    command: echo "hello"
  - id: python_1
    type: python
    depends_on: [shell_1]
    inputs:
      greeting: nodes.shell_1.stdout
      count: nodes.shell_1.exit_code
    code: print(greeting)
```

生成结果：
- shell_1 右侧：出口 point `stdout`（被 greeting 引用）、出口 point `exit_code`（被 count 引用）
- python_1 左侧：入口 point `greeting`、入口 point `count`
- 参数指引边：shell_1.stdout → python_1.greeting，shell_1.exit_code → python_1.count

---

## 实现范围

### 新增文件

- `web/src/pages/workflow/edges.tsx` — 自定义贝塞尔曲线 edge 组件（逻辑边 + 参数边）

### 修改文件

- `web/src/pages/workflow/nodes.tsx` — WorkflowNode 组件增加出入口 point 渲染
- `web/src/pages/workflow/yaml-utils.ts` — `yamlToFlow` 解析 inputs 生成参数指引边数据；`flowToYaml` 还原
- `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` — 连线逻辑适配新 edge type
- `web/src/pages/workflow/WorkflowEditor.tsx` — 注册自定义 edge type
- `web/src/pages/workflow/workflow.css` — point 样式

### 不改

- 后端数据模型（dag.ts / yaml-parser.ts）
- workflow-engine 包
- YAML schema

---

## 边数据结构

扩展 @xyflow/react 的 Edge 类型：

```typescript
// 逻辑关系边
interface LogicEdge extends Edge {
  type: "logic";
  data: {
    hasCondition: boolean;
  };
}

// 参数指引边
interface DataFlowEdge extends Edge {
  type: "dataFlow";
  data: {
    sourceField: string;   // 出口字段名
    targetParam: string;   // 入口变量名
  };
}
```

Edge ID 命名：
- 逻辑边：`logic-<sourceId>-<targetId>`（同现有）
- 参数边：`data-<sourceId>.<field>-<targetId>.<param>`
