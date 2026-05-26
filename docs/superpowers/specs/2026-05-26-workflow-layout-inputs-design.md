# Workflow 画布竖直布局 + Inputs 编辑器设计

> 日期：2026-05-26
> 状态：已确认，待实现

## 背景

Workflow 编辑器的画布节点当前使用 dagre `rankdir: "LR"`（左到右水平布局），用户希望改为上到下的竖直排布。同时，后端 workflow engine 的 shell 和 python 节点已支持 `inputs: Record<string, string>` 字段，但前端 NodeConfigPanel 尚未暴露此配置入口。

## 目标

1. 画布内节点自动布局从水平（LR）改为竖直（TB）
2. 为 shell 和 python 节点新增结构化 inputs 键值对编辑器

## 设计

### 1. 画布布局 LR → TB

**改动文件：**

| 文件 | 改动 |
|------|------|
| `web/src/pages/workflow/layout.ts` | dagre `rankdir` 从 `"LR"` 改为 `"TB"`，`ranksep` 调为 80，`nodesep` 保持 60 |
| `web/src/pages/workflow/nodes.tsx` | target Handle 从 `Position.Left` → `Position.Top`；source Handle 从 `Position.Right` → `Position.Bottom` |
| `web/src/pages/workflow/yaml-utils.ts` | `yamlToFlow` 中新节点默认坐标改为纵向排布（加载后 autoLayout 会覆盖） |

**不变的部分：**
- 整体页面布局（左画布 + 右面板）不变
- ReactFlow `defaultEdgeOptions` 不变，smoothstep 在 TB 模式下同样适用
- 节点外观和样式不变

### 2. Inputs 键值对编辑器

**改动文件：`web/src/pages/workflow/components/NodeConfigPanel.tsx`**

在 shell 节点的 `env` 字段之后、python 节点的 `requirements` 字段之后，各新增 inputs 编辑区域。

**内联组件 `InputsEditor`**（定义在 NodeConfigPanel.tsx 内部）：

```
Props:
  - value: Record<string, string> | undefined
  - onChange: (val: Record<string, string> | undefined) => void
  - readOnly: boolean
  - placeholder: string
```

**渲染逻辑：**
- 将 `value`（或空对象）的 entries 渲染为行列表
- 每行：key 输入框（约 30% 宽）+ value 输入框（约 60% 宽）+ 删除按钮（24px 图标按钮）
- 底部"添加"按钮，点击追加空行
- `updateNodeData` 时过滤掉 key 为空字符串的条目
- 所有行删除后 `onChange(undefined)` 清除 inputs 字段

**数据流：**
```
sd?.inputs → InputsEditor 展示 → 用户编辑 → onChange → updateNodeData({ inputs }) → node.data → flowToYaml
```

**i18n：** `workflows` 命名空间新增 key：
- `editor.inputs_title`（"Inputs"）
- `editor.inputs_key_placeholder`（"变量名"）
- `editor.inputs_value_placeholder`（"表达式"）
- `editor.inputs_add`（"添加 Input"）

**样式：** 复用 `.wf-prop-field` 输入框样式，行间距 6px。

### 适用范围

- inputs 编辑器仅对 shell 和 python 节点类型开放（与后端类型定义对齐）
- agent、api、audit、workflow、loop 节点不显示 inputs 编辑区域
