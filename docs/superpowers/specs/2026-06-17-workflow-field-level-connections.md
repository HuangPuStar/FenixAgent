# 工作流节点卡片参数流可视化

## 背景

当前 WorkflowNode 卡片渲染结构为：标题栏 → 描述+代码缩略 → 状态栏。节点的 inputs/outputs 字段虽已通过多个 Handle 暴露（`in-{param}` / `out-{field}`），DataFlowEdge 也已连接字段级端口，但卡片内容区并未展示参数链接关系——用户需要依赖配置面板或边才能看。

目标：将卡片改造成标题 + INPUT LIST + OUTPUT LIST 三段式，每行一个字段，端口圆点和字段名直接展示在卡片内。配合已有的 DataFlowEdge 连线，实现类似 Langflow 的字段级参数流可视化。

## 现有基础

以下能力**已存在**，本次只改 UI 不改逻辑：

- **字段级 Handle**：`nodes.tsx:244-309` — 每个 input 参数 / output 字段都已有独立的 `Handle` 组件，id 为 `in-{param}` 和 `out-{field}`
- **字段级数据流边**：`yaml-utils.ts:225-240` — `parseDataFlowEdges()` 解析 `inputs` 中的 `nodes.xxx.field` 表达式，`yamlToFlow` 生成带 `sourceHandle`/`targetHandle` 的 DataFlowEdge
- **output 字段注入**：`yaml-utils.ts:107-122` — `_outputFields` 已根据下游引用计算并注入到节点 `data` 中

## 改动范围

### 1. `web/src/pages/workflow/nodes.tsx` — WorkflowNode 卡片重构

**当前结构：**
```
┌─ 标题栏（类型图标 + 标签 + 状态点）──────────┐
│  描述文字 + 代码缩略                          │
│  状态栏（状态标签 + exit_code + 操作按钮）      │
└──────────────────────────────────────────────┘
```

**目标结构：**
```
┌─ 标题栏（类型图标 + 标签）───────────────────┐
├─ INPUTS ───────────────────────────────────┤
│  ● src_dir                                  │
│  ● env                                      │
├─ OUTPUTS ──────────────────────────────────┤
│  ● output                                   │
│  ● exit_code                                │
│  ● stderr                                   │
└─────────────────────────────────────────────┘
```

**具体变更：**

- **移除**：描述文字、代码缩略预览、状态栏（运行状态信息以后续方案另行处理）
- **新增 INPUT 区域**：在标题栏下方渲染 input list。每行一个字段：橙色圆点（`● #f59e0b`）+ 字段名。每行嵌入对应的 `<Handle type="target" id="in-{param}">`。无 inputs 时显示 "no inputs"
- **新增 OUTPUT 区域**：在 INPUT 区域下方渲染 output list。每行一个字段：绿色圆点（`● #22c55e`）+ 字段名。每行嵌入对应的 `<Handle type="source" id="out-{field}">`。未被下游引用的字段半透明（opacity 0.3）。start 节点的 outputs 不变
- **保留**：标题栏、颜色方案（`NODE_COLORS`）、逻辑边 Handle（execution flow target/source）
- **start 节点**：保持简洁样式不变

### 2. Handle 定位调整

当前 Handle 使用 `position={Position.Top/Bottom}` + 百分比 `left` 定位在卡片边缘外侧。新布局中 Handle 需内嵌在 INPUT/OUTPUT 行内：

- 每行包裹一个 `position: relative` 容器
- `<Handle>` 保留 `Position.Top`（inputs）或 `Position.Bottom`（outputs），但作为行内元素用 flex 布局对齐
- Handle 圆点尺寸保持 8px，但不单独显示——行首的视觉圆点作为 Handle 的可视替代或叠加

**方案选项**：将 Handle 设为透明/隐藏，用自定义 `<div>` 圆点提供视觉，Handle 仅作为 React Flow 的连接锚点。或用 Handle 自带样式覆盖。

### 3. 边的渲染（不改动）

`web/src/pages/workflow/edges.tsx` 中的 `DataFlowEdge` — 无需修改。已有字段级连线已正确工作。

### 4. 标签覆盖层移除

`nodes.tsx:272-292,325-343` — 当前入口/出口标签覆盖层（`wf-point-label-overlay`）在新布局中不再需要，因为字段名已直接显示在 INPUT/OUTPUT 区域内。

## 不改动的部分

- `yaml-utils.ts` — parseDataFlowEdges / yamlToFlow / _outputFields 注入逻辑
- `edges.tsx` — DataFlowEdge / LogicEdge 渲染
- `useWorkflowCanvas.ts` — onConnect / 节点增删改逻辑
- `NodeConfigCard.tsx` — 节点配置面板
- 后端 API、YAML 序列化格式

## 影响评估

- **功能影响**：无，纯 UI 重构
- **向后兼容**：YAML 格式不变，已有工作流可直接使用新布局
- **性能影响**：卡片面积缩小（去掉了描述/状态栏），渲染节点数不变
