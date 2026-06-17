# Workflow Editor 工具栏精简 & 右下角重组

**日期**：2026-06-17
**状态**：已实现
**类型**：UX 重构

## 动机

Workflow Editor 顶部 toolbar 有 13 个按钮 7 组，功能混杂（编辑、运行、配置、辅助），且部分按钮在右下角有重复入口（Versions 右下角已有 VersionIndicator，Run History 已有 Popover）。用户反馈工具栏"东西太多"。

## 设计目标

1. Toolbar 只保留编辑工作流时的**核心操作**，其余收拢到右下角
2. 右下角按钮组统一收纳配置/辅助类功能
3. 移除已无用的手动 Read-Only 切换（运行完成后自动解除只读）

## 方案对比

### 方案 A：激进精简（✅ 已选用）

**Toolbar 保留 6 个按钮，3 组**：

```
📄 New  │  🗂️ Auto Layout  │  💾 Save  │  ⟨/⟩ YAML  │  ✓ Validate  │  ▶ Run
```

| 组 | 按钮 | 说明 |
|---|---|---|
| 编辑 | New、Auto Layout | 清空画布 + Dagre 自动排列 |
| 持久化 | Save、YAML | 保存草稿 + 代码/可视化切换 |
| 运行 | Validate、Run | 结构校验 + 执行工作流 |

**右下角新增 3 个按钮（共 6 个）**：

```
📁 File  │  ⚙️ Settings  │  📋 History  │  🔀 Version  │  🔗 Triggers  │  💬 Chat
```

| 按钮 | 组件 | 行为 |
|---|---|---|
| 📁 File | Popover | Import YAML / Export YAML / Refresh（仅 workflowId 存在时） |
| ⚙️ Settings | WorkflowMetaPopover | 工作流元数据编辑（名称、描述、参数、密钥） |
| 📋 History | Popover + RunStatusPanel | 运行事件流和节点输出查看 |
| 🔀 Version | VersionIndicator | 版本状态 + 预览切换 + 快速操作 |
| 🔗 Triggers | Sheet 触发器 | Webhook 触发器管理（仅 workflowId 存在时） |
| 💬 Chat | 切换开关 | Meta Agent Chat 助手面板 |

**移除**：
- 手动 Read-Only 切换按钮（`Eye`/`Edit3`）—— 因上次修复已使运行完成后自动退出只读，手动切换无存在必要
- `readOnly` state 变量—— 无入口后恒为 `false`，从 `effectiveReadOnly` 中移除

**优点**：toolbar 极简，一眼定位核心操作；配置/辅助功能统一收拢到右下角
**缺点**：Import/Export 需要多一次点击（→ File popover）

### 方案 B：温和重组

Toolbar 保留 9 个按钮，只把 Versions/Triggers/Chat/ReadOnly 移到右下角。

**优点**：Import/Export 仍可直接操作
**缺点**：toolbar 还是偏长，与方案 A 比不够彻底

### 方案 C：上下文驱动

编辑模式和运行模式显示不同 toolbar。

| 编辑模式 | 运行模式 |
|---|---|
| New、Auto Layout、YAML、Save、Validate、Run | Cancel Run、Back to Edit、Refresh |

**优点**：场景完全分离，无干扰
**缺点**：实现量大，需状态机驱动 toolbar 切换

## 实现细节

### 涉及文件

| 文件 | 变更 |
|---|---|
| `web/src/pages/workflow/WorkflowEditor.tsx` | 工具栏 JSX 精简、右下角新增 File/Triggers/Chat 按钮、移除 `readOnly` state、清理 imports |
| `web/src/pages/workflow/workflow.css` | 新增 `.wf-dropdown-item` 样式 |
| `web/src/i18n/locales/en/workflows.json` | 新增 `tooltip_file_menu`、`file_menu_title`、`import_yaml`、`export_yaml` |
| `web/src/i18n/locales/zh/workflows.json` | 同上中文翻译 |

### 关键逻辑变更

**`effectiveReadOnly` 计算简化**：

```ts
// 改前
const effectiveReadOnly = readOnly || isRunMode || previewVersion !== null;

// 改后（readOnly 移除，isRunMode 在完成后自动释放）
const effectiveReadOnly = (isRunMode && !isRunDone) || previewVersion !== null;
```

**Persistence/Canvas hook 的 `readOnly` 参数**：

```ts
// 改前
readOnly: readOnly || activeRunId !== null || previewVersion !== null

// 改后
readOnly: forceReadOnly || previewVersion !== null  // forceReadOnly = activeRunId !== null && !isRunDone
```

### CSS 新增

```css
.wf-dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: #374151;
  cursor: pointer;
  border: none;
  background: transparent;
}
.wf-dropdown-item:hover { background: #f3f4f6; }
.wf-dropdown-item:disabled { opacity: 0.4; cursor: not-allowed; }
```

## 验证

- `bun run precheck` — 全部通过（format / import-sort / tsc / lint / 1719 tests）
- `bun run build:web` — 构建成功
- 手动验证待执行
