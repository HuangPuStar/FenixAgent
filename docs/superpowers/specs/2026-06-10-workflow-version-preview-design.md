# Workflow 版本预览与指示器设计

## 背景

当前 workflow 编辑器存在三个痛点：

1. 版本列表只能展开看 YAML 文本，无法在画布中预览 DAG 图
2. "恢复为草稿"会覆盖当前草稿，无法只读预览某版本
3. 编辑器内缺少版本状态信息（latest 是 v 几、当前处于什么状态）

## 设计目标

在编辑器内增加版本预览切换能力，让用户可以在画布中快速查看任意版本的 DAG 图，并在右下角按钮组展示版本状态指示器。

## 方案概述

### 右下角版本指示器

在现有右下角按钮组（运行日志 Popover、齿轮 Popover）的**最左侧**新增一个按钮，点击弹出 Popover 下拉菜单。

**按钮显示：**
- 草稿模式：显示 `draft` 文本，有 latest 版本时追加 `(latest: v3)` 小字
- 预览模式：高亮显示 `v2` badge，表示当前正在预览某版本

**Popover 下拉菜单内容：**
- 当前状态说明（"正在编辑草稿" 或 "正在预览 v2"）
- 版本列表：latest 优先 + 最近 3 个版本，每项有"预览"按钮
- 预览中的版本额外显示"恢复为草稿"和"设为最新"操作按钮
- 底部"查看全部版本"链接，点击打开现有 VersionPanel Sheet
- 草稿模式下顶部有"返回草稿"（灰掉，因为已在草稿）

### 版本预览切换机制

复用现有的 `readOnly` + 运行模式的只读体验，新增 `previewVersion` 状态（`number | null`）。

**状态定义：**
- `previewVersion === null` → 草稿模式，正常编辑
- `previewVersion !== null` → 预览模式，画布只读，nodes/edges/meta/YAML 全部来自该版本

**切换到预览：**
1. 调用 `workflowDefApi.getVersion(workflowId, version)` 获取版本 YAML
2. 用 `yamlToFlow()` 解析为 nodes、edges、meta
3. 设置画布节点/边、同步 YAML 面板内容
4. 画布进入只读模式（`effectiveReadOnly = true`）

**切回草稿：**
1. 重新加载 `wf.draftYaml`，用 `yamlToFlow()` 恢复原始 nodes/edges/meta
2. 退出只读模式
3. 调用 `fitView()` 重置视口

**预览模式下的约束：**
- 禁止拖拽、编辑、删除节点和边
- 禁止保存草稿、发布版本（工具栏对应按钮 disabled）
- YAML 面板为只读
- 自动保存（persistence hook）跳过预览状态
- SSE `workflow.draft_updated` 事件在预览模式下不触发自动刷新

### "恢复为草稿"操作

在预览某版本时，Popover 下拉菜单中提供"恢复为草稿"按钮。点击后：
1. 调用 `workflowDefApi.restoreToDraft(workflowId, version)`
2. 重新加载草稿（此时草稿已被该版本内容覆盖）
3. 自动切回草稿模式

### "设为最新"操作

在预览某版本时，Popover 下拉菜单中提供"设为最新"按钮。点击后：
1. 调用 `workflowDefApi.setLatest(workflowId, version)`
2. 刷新版本列表数据，更新 latest badge

## 涉及的文件改动

| 文件 | 类型 | 说明 |
|------|------|------|
| `web/src/pages/workflow/components/VersionIndicator.tsx` | 新建 | 右下角版本指示器组件（按钮 + Popover） |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 新增 `previewVersion` 状态、切换逻辑，引入 VersionIndicator |
| `web/src/pages/workflow/hooks/useWorkflowPersistence.ts` | 修改 | 预览模式下跳过自动保存 |
| `web/src/i18n/locales/en/workflows.json` | 修改 | 新增版本指示器英文翻译 |
| `web/src/i18n/locales/zh/workflows.json` | 修改 | 新增版本指示器中文翻译 |

后端不需要改动，现有的 `getVersion`、`setLatest`、`restoreToDraft` API 已满足需求。

## 不在范围内

- 不做新路由/新页面
- 不做版本 diff 对比功能
- 不修改 VersionPanel Sheet 的现有功能（保持向后兼容）
- 不做内嵌缩略 DAG 图（版本列表仍用 YAML 文本展开）
