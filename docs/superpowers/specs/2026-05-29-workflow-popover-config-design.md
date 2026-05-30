# 工作流编辑器：侧边栏改 Popover 卡片浮窗

日期：2026-05-29

## 背景

当前工作流编辑器右侧有一个固定 280px 宽的侧边栏（`wf-prop-panel`），包含 config / run / versions / triggers 四个 tab。侧边栏始终占据屏幕空间，限制了画布可视区域。

目标：将侧边栏拆解为浮窗形态，节点配置改为点击弹出的 Popover 卡片，run / versions / triggers 改为工具栏触发的独立 Sheet，最大化画布空间。

## 设计决策

| 决策项 | 选择 |
|--------|------|
| Popover 关闭行为 | 点击空白或其他节点 → 关闭（不立即打开新 popover） |
| Popover 位置 | 节点右侧展开，溢出时自动翻转到左侧 |
| 节点配置以外的内容 | 改为工具栏按钮触发的独立 Sheet（shadcn Sheet） |
| 工作流元数据编辑 | 固定锚定在画布右下角的 Popover |
| Popover 尺寸 | 宽度 320px，高度自适应，max-height 480px（节点）/ 520px（元数据），超出滚动 |
| 实现方案 | shadcn/ui Popover（Radix Popover），通过 data-node-id DOM 定位 anchor |

## 架构变更

### 整体结构

移除 `wf-prop-panel` 侧边栏，改为三种浮窗形态：

1. **节点配置 Popover** — 点击节点弹出，复用 `NodeConfigPanel` 表单逻辑
2. **工作流元数据 Popover** — 右下角锚定，复用"未选中节点"分支逻辑
3. **Run / Versions / Triggers Sheet** — 工具栏按钮触发，从右侧滑出

### 状态管理变化

- `selectedNode` 保留，驱动 Popover 的 open/close 和内容
- `rightTab` 移除，替换为三个布尔值：`runSheetOpen`、`versionsSheetOpen`、`triggersSheetOpen`
- 新增 `popoverAnchorRef` 管理当前 Popover 的 anchor DOM 元素

## 节点配置 Popover

### 触发与定位

- `onNodeClick` 中，通过 `event.target` 向上查找 `data-node-id` 属性的 DOM 元素作为 anchor
- `side="right"`, `align="start"`（顶部对齐）
- `collisionPadding` 处理右边缘溢出，自动翻转到左侧

### 开闭行为

- 点击节点 → 打开该节点 popover（先关闭旧的再打开新的）
- 点击画布空白 → 关闭
- 点击另一个节点 → 关闭（不立即打开新的）
- Esc → 关闭
- Popover 内部点击 → 不关闭

### 尺寸

- 宽度固定 320px
- 高度自适应，`max-height: 480px`，超出后 `overflow-y: auto`

### 样式

- 白色背景、圆角 12px、轻阴影（`shadow-lg`）
- 顶部标题栏：节点类型图标 + 节点 ID，颜色和节点类型色对应

## 工作流元数据 Popover

### 触发与定位

- 画布右下角放置一个半透明齿轮图标按钮作为 anchor
- 点击按钮从上方展开（`side="top"`, `align="end"`）

### 内容

schema_version（只读）、name、description、timeout、params（JSON）、secrets

### 尺寸

- 宽度 320px
- `max-height: 520px`，超出滚动

### 互斥关系

与节点 popover 可以同时打开（位置不冲突）

## Run / Versions / Triggers Sheet

### 触发方式

- 保留工具栏现有按钮（List / Rocket / Link 图标），`onClick` 改为打开对应 Sheet
- 按钮 active 高亮反映 Sheet 是否打开

### Sheet 行为

- `side="right"`，从右侧滑出
- 同一时间只打开一个（打开新的自动关闭旧的）
- 点击遮罩或 Esc 关闭

### 尺寸

- 宽度 360px
- 高度撑满画布

### 内容迁移

`RunStatusPanel`、`VersionPanel`、`TriggerPanel` 的 props 和内部逻辑不变，外层容器从 tab 内容区变为 Sheet body。

## 组件拆分

`NodeConfigPanel.tsx` 拆为：

| 新组件 | 职责 |
|--------|------|
| `NodeConfigCard` | 纯表单（从现有逻辑提取，不含容器） |
| `NodeConfigPopover` | Popover 外壳，内部渲染 `NodeConfigCard` |
| `WorkflowMetaCard` | 工作流元数据表单（从"未选中"分支提取） |
| `WorkflowMetaPopover` | 右下角 Popover 外壳，内部渲染 `WorkflowMetaCard` |

`NodeConfigPanel` 保留但标记废弃，过渡期兼容。

## 边界情况

### 画布缩放/拖拽

Popover 通过 Portal 渲染到 `document.body`，不跟随 React Flow transform。`onMoveStart` 时自动关闭 popover。

### Readonly 模式

- Readonly badge 位置从 `right: 300px` 改为 `right: 12px`
- Popover 可打开查看，表单字段全部 disabled

### 节点删除

删除节点时（`onNodesDelete`），若该节点 popover 正在打开则自动关闭。

### YAML 面板共存

底部 YAML 滑出面板和右侧 Sheet 可同时存在。Popover 是 Portal 渲染，不受影响。

## 文件影响范围

| 文件 | 变更 |
|------|------|
| `WorkflowEditor.tsx` | 主要改造：移除侧边栏 JSX，新增 Popover / Sheet 编排 |
| `NodeConfigPanel.tsx` | 拆分为 NodeConfigCard / WorkflowMetaCard + Popover 外壳 |
| `RunStatusPanel.tsx` | 外层改用 Sheet 包裹 |
| `VersionPanel.tsx` | 外层改用 Sheet 包裹 |
| `TriggerPanel.tsx` | 外层改用 Sheet 包裹 |
| `nodes.tsx` | 节点组件添加 `data-node-id` 属性 |
| `workflow.css` | 移除 `wf-prop-panel` 样式，新增 popover 卡片样式 |
