# Workflow 条件边与参数指引边 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Workflow 编辑器中引入逻辑关系边（实线/虚线曲线）和参数指引边（点线曲线），可视化条件执行和 inputs 数据流。

**Architecture:** 纯前端变更。自定义 @xyflow/react edge 组件替代 smoothstep，解析节点 inputs 表达式生成参数指引边，出入口 point 以绝对定位 div 渲染在节点两侧。不改后端数据模型。

**Tech Stack:** React 19, @xyflow/react, Tailwind CSS

---

## File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `web/src/pages/workflow/edges.tsx` | 自定义贝塞尔曲线 edge 组件（LogicEdge + DataFlowEdge） |
| Modify | `web/src/pages/workflow/nodes.tsx` | WorkflowNode 增加出入口 point 渲染 |
| Modify | `web/src/pages/workflow/yaml-utils.ts` | yamlToFlow 解析 inputs 生成参数指引边；flowToYaml 还原 |
| Modify | `web/src/pages/workflow/hooks/useWorkflowCanvas.ts` | onConnect/onConnectEnd 使用新 edge type |
| Modify | `web/src/pages/workflow/WorkflowEditor.tsx` | 注册自定义 edgeTypes，defaultEdgeOptions 改为 bezier |
| Modify | `web/src/pages/workflow/workflow.css` | 出入口 point 样式 |

---

### Task 1: 自定义贝塞尔曲线 Edge 组件

**Files:**
- Create: `web/src/pages/workflow/edges.tsx`

- [ ] **Step 1: 创建 edges.tsx，实现 LogicEdge 组件**

```tsx
// web/src/pages/workflow/edges.tsx
import { BaseEdge, type EdgeProps, getBezierPath } from "@xyflow/react";

/** 逻辑关系边 — 实线或虚线贝塞尔曲线 */
export function LogicEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  style,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const hasCondition = (data as Record<string, unknown>)?.hasCondition === true;

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        ...style,
        stroke: style?.stroke ?? "#94a3b8",
        strokeWidth: style?.strokeWidth ?? 1.5,
        strokeDasharray: hasCondition ? "6 3" : undefined,
      }}
    />
  );
}

/** 参数指引边 — 更细的点线曲线 */
export function DataFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: "#10b981",
        strokeWidth: 1,
        strokeDasharray: "2 3",
      }}
    />
  );
}

export const edgeTypes = {
  logic: LogicEdge,
  dataFlow: DataFlowEdge,
};
```

- [ ] **Step 2: 验证文件无类型错误**

Run: `cd web && npx tsc --noEmit --pretty 2>&1 | grep edges.tsx`
Expected: 无输出（无错误）

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/edges.tsx
git commit -m "feat(workflow): 添加自定义贝塞尔曲线 edge 组件 (LogicEdge + DataFlowEdge)"
```

---

### Task 2: yaml-utils 解析 inputs 生成参数指引边

**Files:**
- Modify: `web/src/pages/workflow/yaml-utils.ts`

- [ ] **Step 1: 添加参数指引边解析函数和导出类型**

在 `yaml-utils.ts` 末尾（`resetNodeCounter` 函数之后）添加：

```typescript
/** 参数指引边数据 */
export interface DataFlowEdgeInfo {
  sourceNodeId: string;
  sourceField: string;
  targetNodeId: string;
  targetParam: string;
}

/** 从节点列表的 inputs 中解析出参数指引边 */
export function parseDataFlowEdges(
  nodes: Array<{ id: string; data: Record<string, unknown> }>,
): DataFlowEdgeInfo[] {
  const edges: DataFlowEdgeInfo[] = [];
  for (const node of nodes) {
    if (node.id === START_NODE_ID) continue;
    const inputs = node.data.inputs;
    if (!inputs || typeof inputs !== "object") continue;
    for (const [paramName, expr] of Object.entries(inputs as Record<string, string>)) {
      if (typeof expr !== "string") continue;
      const match = expr.match(/^nodes\.([a-zA-Z0-9_-]+)\.(.+)$/);
      if (!match) continue;
      edges.push({
        sourceNodeId: match[1],
        sourceField: match[2],
        targetNodeId: node.id,
        targetParam: paramName,
      });
    }
  }
  return edges;
}
```

- [ ] **Step 2: 修改 yamlToFlow，在生成边时设置 logic edge type 并生成参数指引边**

在 `yamlToFlow` 函数中，修改边的生成逻辑。将第 86-103 行替换为：

```typescript
    // 根节点（无 depends_on）连到 start
    if (depends.length === 0) {
      edges.push({
        id: `logic-${START_NODE_ID}-${raw.id}`,
        source: START_NODE_ID,
        target: raw.id,
        type: "logic",
        data: { hasCondition: false },
      });
    }

    for (const dep of depends) {
      // 检查目标节点是否有 condition
      const condition = data.condition;
      edges.push({
        id: `logic-${dep}-${raw.id}`,
        source: dep,
        target: raw.id,
        type: "logic",
        data: { hasCondition: typeof condition === "string" && condition.length > 0 },
      });
    }
```

然后在 `yamlToFlow` 函数末尾，`return` 语句之前，添加参数指引边的生成：

```typescript
  // 解析参数指引边
  const dataFlowEdges = parseDataFlowEdges(nodes);
  for (const df of dataFlowEdges) {
    edges.push({
      id: `data-${df.sourceNodeId}.${df.sourceField}-${df.targetNodeId}.${df.targetParam}`,
      source: df.sourceNodeId,
      target: df.targetNodeId,
      type: "dataFlow",
      data: {
        sourceField: df.sourceField,
        targetParam: df.targetParam,
      },
    });
  }

  return { nodes, edges, meta };
```

- [ ] **Step 3: 修改 flowToYaml，过滤参数指引边，不写入 depends_on**

在 `flowToYaml` 函数中，修改第 110-116 行的 dependsMap 构建逻辑，只处理逻辑边：

```typescript
  const dependsMap = new Map<string, string[]>();
  for (const edge of edges) {
    // 只处理逻辑边，跳过参数指引边
    if (edge.type === "dataFlow") continue;
    if (edge.source === START_NODE_ID) continue;
    const deps = dependsMap.get(edge.target) || [];
    if (!deps.includes(edge.source)) deps.push(edge.source);
    dependsMap.set(edge.target, deps);
  }
```

- [ ] **Step 4: 验证类型正确**

Run: `cd web && npx tsc --noEmit --pretty 2>&1 | grep yaml-utils`
Expected: 无输出（无错误）

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/yaml-utils.ts
git commit -m "feat(workflow): yaml-utils 解析 inputs 生成参数指引边和条件边"
```

---

### Task 3: WorkflowEditor 注册 edgeTypes 和更新 defaultEdgeOptions

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 添加 edgeTypes import**

在 `WorkflowEditor.tsx` 顶部的 import 区域，找到 `import { nodeTypes } from "./nodes";`（约第 65 行），在其后添加：

```typescript
import { edgeTypes } from "./edges";
```

- [ ] **Step 2: 在 ReactFlow 组件上注册 edgeTypes**

找到 `<ReactFlow` 组件（约第 433 行），在 `nodeTypes={nodeTypes}` 行之后添加：

```typescript
          edgeTypes={edgeTypes}
```

- [ ] **Step 3: 修改 defaultEdgeOptions**

找到 `defaultEdgeOptions={{ type: "smoothstep", animated: true }}`（约第 473 行），替换为：

```typescript
          defaultEdgeOptions={{ type: "logic" }}
```

- [ ] **Step 4: 验证编译**

Run: `bun run precheck 2>&1 | tail -5`
Expected: 0 errors (7 warnings 是已有的 noExplicitAny)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat(workflow): 注册自定义 edgeTypes，defaultEdgeOptions 改为 logic"
```

---

### Task 4: useWorkflowCanvas 使用新 edge type

**Files:**
- Modify: `web/src/pages/workflow/hooks/useWorkflowCanvas.ts`

- [ ] **Step 1: 修改 onConnect 回调**

找到 `onConnect` 回调（约第 87-101 行），将 `addEdge` 调用中的 `type: "smoothstep"` 改为 `type: "logic"`，去掉 `animated`：

```typescript
  const onConnect = useCallback(
    (connection: Connection) => {
      didConnect.current = true;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "logic",
            data: { hasCondition: false },
            id: `logic-${connection.source}-${connection.target}`,
          },
          eds,
        ),
      );
    },
    [setEdges, didConnect],
  );
```

- [ ] **Step 2: 修改 onConnectEnd 回调**

找到 `onConnectEnd` 回调中创建新边的部分（约第 132-141 行），替换边数据：

```typescript
      setEdges((eds) => [
        ...eds,
        {
          id: `logic-${sourceId}-${newId}`,
          source: sourceId,
          target: newId,
          type: "logic",
          data: { hasCondition: false },
        },
      ]);
```

- [ ] **Step 3: 验证编译**

Run: `bun run precheck 2>&1 | tail -5`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/hooks/useWorkflowCanvas.ts
git commit -m "feat(workflow): useWorkflowCanvas 使用 logic edge type"
```

---

### Task 5: 出入口 Point 样式

**Files:**
- Modify: `web/src/pages/workflow/workflow.css`

- [ ] **Step 1: 在 workflow.css 末尾添加出入口 point 样式**

```css
/* ── Data flow points (input/output) ── */
.wf-point {
  position: absolute;
  display: flex;
  align-items: center;
  gap: 4px;
  pointer-events: none;
}

.wf-point-out {
  right: -48px;
  flex-direction: row;
}

.wf-point-in {
  left: -48px;
  flex-direction: row-reverse;
}

.wf-point-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: 2px solid #fff;
  flex-shrink: 0;
  box-shadow: 0 0 0 1px rgba(0,0,0,0.08);
}

.wf-point-dot-out {
  background: #10b981;
}

.wf-point-dot-in {
  background: #f59e0b;
}

.wf-point-label {
  font-size: 9px;
  font-weight: 600;
  padding: 1px 5px;
  border-radius: 3px;
  white-space: nowrap;
  line-height: 1.4;
}

.wf-point-label-out {
  color: #10b981;
  background: rgba(16,185,129,0.1);
}

.wf-point-label-in {
  color: #f59e0b;
  background: rgba(245,158,11,0.1);
}

.wf-points-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  pointer-events: none;
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/workflow/workflow.css
git commit -m "feat(workflow): 添加出入口 point 样式"
```

---

### Task 6: WorkflowNode 渲染出入口 Point

**Files:**
- Modify: `web/src/pages/workflow/nodes.tsx`

- [ ] **Step 1: 添加 import**

在 `nodes.tsx` 顶部添加 `useMemo`：

```typescript
import { useMemo } from "react";
```

找到 `import { Handle, type NodeProps, Position } from "@xyflow/react";`，确认已导入。

- [ ] **Step 2: 在 WorkflowNode 组件内，return 之前，添加出入口计算逻辑**

在 `WorkflowNode` 函数内，`return (` 之前添加：

```typescript
  // 计算出入口 point
  // 入口：从当前节点的 inputs 字段解析
  const inputPoints = useMemo(() => {
    const inputs = d.inputs;
    if (!inputs || typeof inputs !== "object") return [];
    return Object.keys(inputs as Record<string, string>).map((key) => key);
  }, [d.inputs]);

  // 出口：从内部注入的 _outputFields 解析（由外部计算注入）
  const outputPoints = useMemo(() => {
    const fields = d._outputFields as string[] | undefined;
    return fields ?? [];
  }, [d._outputFields]);
```

- [ ] **Step 3: 在节点 div 内渲染出入口 point**

在 `<Handle type="source"` 之前，`{!isStart && (...)}` 内容区域之后，添加出入口 point 渲染。找到节点最后的 `</div>` 闭合标签前（`<Handle type="source"` 之前），插入：

```tsx
      {/* 出入口 points — 仅非 start 节点 */}
      {!isStart && (inputPoints.length > 0 || outputPoints.length > 0) && (
        <div className="wf-points-container">
          {inputPoints.map((param, i) => (
            <div
              key={`in-${param}`}
              className="wf-point wf-point-in"
              style={{ top: `${36 + i * 18}px` }}
            >
              <div className="wf-point-dot wf-point-dot-in" />
              <span className="wf-point-label wf-point-label-in">{param}</span>
            </div>
          ))}
          {outputPoints.map((field, i) => (
            <div
              key={`out-${field}`}
              className="wf-point wf-point-out"
              style={{ top: `${36 + i * 18}px` }}
            >
              <span className="wf-point-label wf-point-label-out">{field}</span>
              <div className="wf-point-dot wf-point-dot-out" />
            </div>
          ))}
        </div>
      )}
```

- [ ] **Step 4: 验证编译**

Run: `bun run precheck 2>&1 | tail -5`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/nodes.tsx
git commit -m "feat(workflow): WorkflowNode 渲染出入口 point"
```

---

### Task 7: 注入 outputFields 到节点 data

**Files:**
- Modify: `web/src/pages/workflow/yaml-utils.ts`

- [ ] **Step 1: 在 yamlToFlow 中，解析完所有节点后，注入 _outputFields**

在 `yamlToFlow` 函数中，`parseDataFlowEdges` 调用之前，添加注入逻辑：

```typescript
  // 注入 _outputFields 到被引用的节点
  const dataFlowEdges = parseDataFlowEdges(nodes);
  const outputFieldsMap = new Map<string, Set<string>>();
  for (const df of dataFlowEdges) {
    let set = outputFieldsMap.get(df.sourceNodeId);
    if (!set) {
      set = new Set();
      outputFieldsMap.set(df.sourceNodeId, set);
    }
    set.add(df.sourceField);
  }
  for (const node of nodes) {
    const fields = outputFieldsMap.get(node.id);
    if (fields) {
      node.data = { ...node.data, _outputFields: [...fields] };
    }
  }
```

- [ ] **Step 2: 确保 flowToYaml 的 _ 前缀过滤已覆盖 _outputFields**

确认 `flowToYaml` 中已有的 `if (k.startsWith("_")) continue;`（约第 143 行）会自动跳过 `_outputFields`，无需额外修改。

- [ ] **Step 3: 验证编译和 round-trip**

Run: `bun run precheck 2>&1 | tail -5`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/yaml-utils.ts
git commit -m "feat(workflow): 注入 _outputFields 到被引用节点的 data"
```

---

### Task 8: 前端构建验证和最终提交

**Files:** 无新增

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck 2>&1 | tail -10`
Expected: 0 errors, 7 warnings

- [ ] **Step 2: 构建前端**

Run: `bun run build:web 2>&1 | tail -5`
Expected: `✓ built in XXXms`

- [ ] **Step 3: 最终确认**

在浏览器中打开 Workflow 编辑器页面，确认：
- 逻辑边显示为贝塞尔曲线
- 有 `condition` 字段的节点所连的边显示为虚线
- 有 `inputs` 的节点左侧显示入口 point
- 被引用的节点右侧显示出口 point
- 参数指引边显示为细点线（绿色）
- YAML round-trip（编辑→保存→刷新）不丢失数据
