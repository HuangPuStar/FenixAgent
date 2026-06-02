# Code Review: Workflow 前端变更

**Commit**: b6487f70 (Feature/remote agent and workflow #17)
**审查范围**: `web/src/pages/workflow/` 下 4 个文件
**审查日期**: 2026-06-02

---

## 摘要

本次变更给 Workflow 编辑器新增了自动保存、未保存状态指示、YAML 面板关闭确认、运行模式画布只读等功能。引入了多个实际 bug，其中一个已导致页面崩溃（已修复），其余需要处理。

发现问题：2 critical / 3 major / 4 minor / 2 suggestion

---

## 🔴 [critical] 问题

### C1. 只读模式 badge 定位错误，飘到视口右侧

**文件**: `WorkflowEditor.tsx:431` + `workflow.css:345`

badge 渲染在外层 `<div className="flex w-full h-full bg-surface-0">` 内，但该容器没有 `position: relative`。CSS 设置了 `position: absolute`，导致 badge 相对于更上层的定位上下文（通常是 viewport）定位，inline style `right: 12` 让它贴到了视口最右边，而不是画布区域内。

**修复**: 将 badge 移到 `<div className="flex-1 relative overflow-hidden">` 内部（ReactFlow 的兄弟元素），这样 `position: absolute` 就相对于有 `relative` 的容器定位。

### C2. `setDryRunResult: () => {}` 是永久空操作

**文件**: `WorkflowEditor.tsx:149`, `WorkflowEditor.tsx:182`

Persistence hook 和 Canvas hook 都传入了 `setDryRunResult: () => {}` 作为 placeholder，注释说 "will be overridden by run hook"——但实际上**没有任何机制会 override 它**。这两个 hook 里调用 `setDryRunResult(null)` 的效果被静默吞掉：

- `useWorkflowPersistence.handleImportYaml` 第 149 行调用 `setDryRunResult(null)` → 空操作，导入 YAML 后 dryRun 结果不会被清除
- `useWorkflowCanvas` 内部如果调用了 `setDryRunResult` → 同样空操作

这不是"placeholder"，这是永久性的 bug。应该传入真实的 `setDryRunResult`（从 `useWorkflowRun` 返回），或者重新设计状态归属。

---

## 🟡 [major] 问题

### M1. 自动保存和 `handleSaveDraft` 可能产生竞争

**文件**: `useWorkflowPersistence.ts:93-114`, `118-127`

`handleSaveDraft` 使用 `isSavingRef` 防重入。但：
- 自动保存（3s debounce）和用户手动保存（Ctrl+S / 点击按钮）可能同时触发
- 如果自动保存的 setTimeout 在用户手动保存的 `await` 期间触发，`isSavingRef.current` 已经被手动保存设为 true，自动保存会被跳过——这个行为是对的
- 但如果自动保存先触发 `await`，然后用户快速点保存，用户操作会被 `isSavingRef` 拒绝，**用户感知是保存按钮不响应**

更根本的问题：`handleSaveDraft` 的 deps 包含 `syncYaml`，而自动保存 effect 的 deps 同时包含 `nodes, edges, meta` **和** `handleSaveDraft`。`syncYaml` 变化导致 `handleSaveDraft` 变化，这会让 effect 重新执行（清旧 timer 设新 timer），效果是每次 nodes/edges/meta 变化都重置 3s 倒计时。这虽然正确（debounce 语义），但 `handleSaveDraft` 在 deps 中是冗余的，纯粹因为 `syncYaml` 闭包捕获了最新 nodes/edges/meta。

### M2. SSE effect 依赖 `hasUnsavedChanges`，导致频繁重连

**文件**: `WorkflowEditor.tsx:285`

```typescript
}, [workflowId, handleRefreshDraft, handleWorkflowEvent, hasUnsavedChanges]);
```

`hasUnsavedChanges` 是一个频繁变化的布尔值（用户每次编辑 nodes/edges 都会变 true，每次保存变 false）。每次变化都会 disconnect + reconnect SSE，可能丢失正在传输的事件。

应改为在 SSE callback 内部读取 `hasUnsavedChanges` 的最新值（用 ref），而不是把它放在 effect deps 里。

### M3. `handleBackToEdit` / `handleBackToList` 逻辑完全重复

**文件**: `useWorkflowRun.ts:345-376`, `378-409`

这两个 callback 函数体几乎一字不差（清除所有运行状态、重置 nodes），只有名字不同。违反 DRY，未来改一个忘改另一个就是 bug。

应提取为 `clearRunState()` 共享函数，两个 callback 调用它再加上各自的附加逻辑（当前看没有附加逻辑）。

---

## 🟢 [minor] 问题

### m1. `currentYaml` 用 `useMemo` 计算但 `syncYaml` 也做同样的 `flowToYaml` 调用

**文件**: `useWorkflowPersistence.ts:76-82`

`syncYaml` 和 `currentYaml` 都调用 `flowToYaml(nodes, edges, meta)`，每次 nodes/edges/meta 变化会重复计算两次。`syncYaml` 应该直接使用 `currentYaml`（即 `useMemo` 的结果），只额外调用 `setYamlText`。

### m2. 自动保存 effect 的 `nodes, edges, meta` 是冗余依赖

**文件**: `useWorkflowPersistence.ts:127`

deps 同时包含 `nodes, edges, meta` 和 `handleSaveDraft`（后者已依赖 `syncYaml`，而 `syncYaml` 依赖 `nodes, edges, meta`）。三者是冗余的，biome-ignore 注释解释了它们是"故意作为触发器"，但实际上 `handleSaveDraft` 变化已经能覆盖这个场景。保留的话也无害，只是理解成本高。

### m3. `yamlBaseText` 状态只用于 `hasEdits` 计算，命名不直观

**文件**: `WorkflowEditor.tsx:95`, `663`

```typescript
const [yamlBaseText, setYamlBaseText] = useState("");
// ...
hasEdits={yamlOpen && yamlText !== yamlBaseText}
```

`yamlBaseText` 只在 YAML 面板打开时设置为当前 YAML，用于检测用户是否手动编辑了 YAML 文本。命名暗示"基础文本"但实际是"打开时的快照"，建议改名为 `yamlSnapshotOnOpen` 或加注释说明用途。

### m4. `YamlSlidePanel` 接收 `syncYaml` 但完全不用

**文件**: `YamlSlidePanel.tsx:11`

```typescript
syncYaml: _syncYaml,
```

参数被重命名为 `_syncYaml` 表示未使用，但接口定义仍然要求传入。应该从 props 类型中移除 `syncYaml`，因为组件内根本不需要它。

---

## 💡 [suggestion] 建议

### S1. 考虑将 `effectiveReadOnly` 和运行模式状态统一管理

当前 `readOnly` 有三个来源：
- 用户手动切换的 `readOnly` state
- `effectiveReadOnly = readOnly || isRunMode`（在 WorkflowEditor 计算）
- `readOnly: readOnly || activeRunId !== null`（传给 persistence hook）

第二和第三个计算方式不同（`isRunMode` vs `activeRunId !== null`），虽然语义相同但增加了认知负担。建议统一为一个 `effectiveReadOnly` 变量，所有消费方都使用它。

### S2. `handleSaveDraft` 返回 `Promise<boolean>` 但调用方多数忽略返回值

`handleSaveDraft` 改为返回 `boolean` 表示保存是否成功（commit message 说是为了 "运行前保存失败时中止运行"），但：
- Ctrl+S handler 忽略返回值
- 自动保存忽略返回值
- 只有 `handleRun`（在 `useWorkflowRun` 中）自己做了独立的 save 逻辑，没用 persistence 的 `handleSaveDraft`

如果目的是让调用方感知保存失败，应该统一通过 `handleRun` 调用 `handleSaveDraft` 并检查返回值，而不是在 `useWorkflowRun` 里重新实现保存逻辑。
