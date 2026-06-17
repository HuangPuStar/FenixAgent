# Workflow Editor Meta Agent 左侧布局重构

## 背景

当前 WorkflowEditor 页面中，Meta Agent 聊天面板位于画布右侧，通过左侧拉手切换展开/收起。用户希望将 Meta Agent 聊天面板移至左侧（AgentSidebar 与画布之间），画面移至右侧。

## 改动范围

### 1. `web/src/pages/workflow/WorkflowEditor.tsx`

将 `<MetaAgentPanel>` 组件从当前渲染位置（外层 flex 容器的末尾，画布之后）移至画布 `<div>` 之前。

**当前结构**（约第 508-937 行）：

```tsx
<div className="flex w-full h-full bg-surface-0">
  <div className="flex-1 relative overflow-hidden">
    {/* ReactFlow 画布 */}
  </div>
  <MetaAgentPanel ... />
</div>
```

**目标结构**：

```tsx
<div className="flex w-full h-full bg-surface-0">
  <MetaAgentPanel ... />
  <div className="flex-1 relative overflow-hidden">
    {/* ReactFlow 画布 */}
  </div>
</div>
```

### 2. `web/components/MetaAgentPanel.tsx`

将 toggle 拉手按钮从聊天面板**左边缘移至右边缘**（位于聊天面板与画布之间）。

**当前**：toggle 按钮是 flex 容器的第一个子元素（在聊天面板左侧）。

**目标**：toggle 按钮是 flex 容器的最后一个子元素（在聊天面板右侧）。

图标语义反转：
- 展开态（`chatOpen`）当前显示 `<ChevronRight>` → 改为 `<ChevronLeft>`（收起聊天）
- 收起态（`!chatOpen`）当前显示 `<ChevronLeft>` → 改为 `<ChevronRight>`（展开聊天）

### 3. `web/src/index.css` — `.meta-agent-toggle-btn` 样式

| 属性 | 当前值（左边缘） | 目标值（右边缘） | 说明 |
|------|---------|----------|------|
| `border-left` | `1px solid var(--color-border-subtle)`（由 `border` 提供） | `none` | 贴面板侧无边框 |
| `border-right` | `none` | `1px solid var(--color-border-subtle)` | 面板外侧有边框 |
| `border-radius` | `6px 0 0 6px` | `0 6px 6px 0` | 外侧圆角 |

注释也需更新：从"按钮作为 flex item 渲染在最左侧，圆角朝外（左）、右侧贴面板"改为"按钮作为 flex item 渲染在面板右侧，圆角朝外（右）、左侧贴面板"。

## 不改动的部分

- ChatPanel 内部逻辑与 UI
- ReactFlow 画布、节点面板、工具栏
- MetaAgentPanel 的 400px 宽度和展开/收起状态管理
- `useWorkflowMetaAgent` hook
- WorkflowEditor 内所有状态管理

## 影响评估

- **功能影响**：无，纯布局变更
- **性能影响**：无
- **兼容性**：后端和 API 均不受影响
- **该变行数**：预计 < 20 行
