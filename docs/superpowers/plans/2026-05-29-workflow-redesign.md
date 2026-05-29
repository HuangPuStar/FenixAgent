# Workflow 前端重新设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 workflow 模块的前端样式从硬编码 inline style 统一迁移到 Tailwind + 设计 token 系统，替换浏览器原生 confirm/alert，优化交互状态和视觉品质。

**Architecture:** 逐文件迁移，每个任务聚焦一个组件文件。迁移顺序：先处理独立页面（List/Runs/Versions），再处理编辑器组件（Nodes/RunStatusPanel），最后处理 CSS 瘦身。每个任务完成后可独立验证（`bun run build:web`）。

**Tech Stack:** React 19 + Tailwind v4 + 设计 token（`--color-brand`, `--color-surface-*`, `--color-text-*`, `--color-border-*`）+ shadcn/ui（AlertDialog/Dialog/Button）+ sonner（toast）+ lucide-react（图标）

**Design Token 速查（来自 `web/src/index.css`）：**

| Token | 用途 |
|-------|------|
| `text-brand` / `bg-brand` | 主色（indigo #6366f1）|
| `text-text-primary` | 主文字（#334155）|
| `text-text-secondary` | 次要文字（#64748b）|
| `text-text-muted` / `text-text-dim` | 弱化文字（#94a3b8）|
| `bg-surface-0` | 页面底色 |
| `bg-surface-1` | 卡片/面板底色 |
| `bg-surface-2` | hover/斑马纹 |
| `bg-surface-hover` | 交互 hover |
| `bg-surface-elevated` | 浮层底色 |
| `border-border-subtle` | 轻边框 |
| `border-border` | 常规边框 |
| `shadow-card` / `shadow-elevated` | 阴影 |
| `text-status-running` / `text-status-error` | 状态语义色 |

**已有的可复用组件：**

| 组件 | 路径 | 用途 |
|------|------|------|
| `ConfirmDialog` | `web/components/config/ConfirmDialog.tsx` | 封装 AlertDialog，用于确认操作 |
| `AlertDialog` | `web/components/ui/alert-dialog.tsx` | 底层 AlertDialog |
| `Dialog` | `web/components/ui/dialog.tsx` | 模态对话框 |
| `Button` | `web/components/ui/button.tsx` | 按钮组件 |
| `toast` | `sonner` | 消息提示 |

---

## File Structure

| 操作 | 文件 | 职责 |
|------|------|------|
| Modify | `web/src/pages/workflow/WorkflowList.tsx` | 工作流列表 — inline → Tailwind + ConfirmDialog + Dialog |
| Modify | `web/src/pages/workflow/WorkflowRuns.tsx` | 运行记录列表 — inline → Tailwind |
| Modify | `web/src/pages/workflow/WorkflowVersions.tsx` | 版本历史 — inline → Tailwind + ConfirmDialog |
| Modify | `web/src/pages/workflow/nodes.tsx` | 画布节点 — inline → Tailwind，优化配色 |
| Modify | `web/src/pages/workflow/components/RunStatusPanel.tsx` | 运行状态面板 — inline → Tailwind |
| Modify | `web/src/pages/workflow/workflow.css` | 编辑器 CSS — 删除已被 Tailwind 替代的规则 |
| Modify | `web/src/pages/workflow/WorkflowEditor.tsx` | 编辑器 — 保存/DryRun 状态改用 toast |
| No change | `web/src/pages/workflow/WorkflowKanban.tsx` | 已使用 Tailwind + token ✅ |
| No change | `web/src/pages/workflow/WorkflowStats.tsx` | 已使用 Tailwind + token ✅ |
| No change | `web/src/pages/workflow/WorkflowBreadcrumb.tsx` | 已使用 Tailwind ✅ |
| No change | `web/src/pages/workflow/components/KanbanCard.tsx` | 已使用 Tailwind ✅ |
| No change | `web/src/pages/workflow/components/KanbanColumn.tsx` | 已使用 Tailwind ✅ |

---

### Task 1: WorkflowList — 替换 confirm/alert + 自制 modal

**Files:**
- Modify: `web/src/pages/workflow/WorkflowList.tsx`

**目标：** 将 `confirm()` 替换为 `ConfirmDialog`，`alert()` 替换为 `toast`，自制 modal 替换为 shadcn `Dialog`。

- [ ] **Step 1: 添加 import 和状态**

在文件顶部添加：
```tsx
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
```

新增状态变量（替换 `showCreateDialog` 相关逻辑）：
```tsx
const [deleteTarget, setDeleteTarget] = useState<WorkflowDefItem | null>(null);
```

- [ ] **Step 2: 替换 handleDelete 中的 confirm()**

将：
```tsx
const handleDelete = useCallback(
  async (wf: WorkflowDefItem) => {
    if (!confirm(t("list.delete_confirm", { name: wf.name }))) return;
    try {
      await workflowDefApi.delete(wf.id);
      loadList();
    } catch (err) {
      console.error(err);
      alert(`${t("list.delete_failed")}: ${(err as Error).message}`);
    }
  },
  [loadList, t],
);
```

替换为：
```tsx
const handleDelete = useCallback(async () => {
  if (!deleteTarget) return;
  try {
    await workflowDefApi.delete(deleteTarget.id);
    loadList();
  } catch (err) {
    console.error(err);
    toast.error(t("list.delete_failed"), { description: (err as Error).message });
  } finally {
    setDeleteTarget(null);
  }
}, [deleteTarget, loadList, t]);
```

- [ ] **Step 3: 替换 handleScanRecover 和 handleRecoverApply 中的 alert()**

将 `alert(...)` 调用替换为 `toast.error(...)`：
```tsx
// handleScanRecover
toast.error(t("list.scan_failed"), { description: (err as Error).message });

// handleRecoverApply
toast.error(t("list.recover_failed"), { description: (err as Error).message });
```

- [ ] **Step 4: 替换 handleCreate 中的 alert()**

```tsx
toast.error(t("list.create_error"), { description: (err as Error).message });
```

- [ ] **Step 5: 替换自制 create modal**

将 `showCreateDialog` 条件渲染块（约 L296-397）替换为 shadcn Dialog：
```tsx
<Dialog open={showCreateDialog} onOpenChange={(open) => { setShowCreateDialog(open); if (!open) { setCreateName(""); setCreateDesc(""); } }}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>{t("list.create_title")}</DialogTitle>
    </DialogHeader>
    <div className="space-y-3">
      <div>
        <label className="block text-xs text-text-secondary mb-1">{t("list.name_label")}</label>
        <input
          value={createName}
          onChange={(e) => setCreateName(e.target.value)}
          placeholder="my-workflow"
          className="w-full rounded-md border border-border px-2.5 py-1.5 text-sm outline-none focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>
      <div>
        <label className="block text-xs text-text-secondary mb-1">{t("list.desc_label")}</label>
        <textarea
          value={createDesc}
          onChange={(e) => setCreateDesc(e.target.value)}
          placeholder={t("list.desc_placeholder")}
          rows={2}
          className="w-full rounded-md border border-border px-2.5 py-1.5 text-sm outline-none resize-y focus:border-brand focus:ring-1 focus:ring-brand"
        />
      </div>
    </div>
    <DialogFooter>
      <Button variant="outline" size="sm" onClick={() => { setShowCreateDialog(false); setCreateName(""); setCreateDesc(""); }}>
        {t("list.cancel")}
      </Button>
      <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()}>
        {creating ? t("list.creating") : t("list.create_and_edit")}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```

- [ ] **Step 6: 添加 ConfirmDialog 组件**

在 return 末尾（`</div>` 之前）添加删除确认对话框：
```tsx
<ConfirmDialog
  open={deleteTarget !== null}
  onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
  title={t("list.delete")}
  description={t("list.delete_confirm", { name: deleteTarget?.name ?? "" })}
  variant="destructive"
  onConfirm={handleDelete}
/>
```

- [ ] **Step 7: 更新删除按钮点击行为**

将表格行中删除按钮的 `onClick` 从直接调用 `handleDelete(wf)` 改为：
```tsx
onClick={() => setDeleteTarget(wf)}
```

- [ ] **Step 8: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功，无类型错误

- [ ] **Step 9: 提交**

```bash
git add web/src/pages/workflow/WorkflowList.tsx
git commit -m "refactor(workflow): 替换 WorkflowList 中的 confirm/alert 为 ConfirmDialog/toast/Dialog"
```

---

### Task 2: WorkflowList — inline style → Tailwind

**Files:**
- Modify: `web/src/pages/workflow/WorkflowList.tsx`

**目标：** 将所有 `style={{ ... }}` inline 样式替换为 Tailwind 类名 + 设计 token。

- [ ] **Step 1: 替换根容器**

将 `style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}` 替换为：
```tsx
className="h-full overflow-y-auto p-6"
```

- [ ] **Step 2: 替换标题栏**

将标题栏 div 的 inline style 替换为：
```tsx
className="flex items-center justify-between mb-5"
```

h1 标签：
```tsx
className="text-base font-semibold text-text-primary m-0"
```

工具栏按钮（"扫描恢复"和"刷新"）统一为：
```tsx
className="flex items-center gap-1.5 px-2.5 py-1 border border-border-subtle rounded-md bg-surface-1 text-xs text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
```

- [ ] **Step 3: 替换搜索栏**

外层 div：
```tsx
className="flex gap-2.5 mb-4 items-center"
```

搜索框容器：
```tsx
className="flex items-center gap-1.5 flex-1 max-w-[260px] border border-border-subtle rounded-md px-2.5 py-1.5 bg-surface-1"
```

Search 图标：`className="text-text-muted shrink-0"`
内部 input：`className="border-none outline-none text-xs w-full bg-transparent text-text-primary"`

新建按钮：
```tsx
className="flex items-center gap-1.5 px-3 py-1.5 border-none rounded-md bg-brand text-white text-xs font-medium cursor-pointer hover:bg-brand-light transition-colors"
```

- [ ] **Step 4: 替换恢复面板**

外层 div：
```tsx
className="mb-4 p-3 border border-warning-border rounded-lg bg-warning-bg text-xs"
```

标题：`className="font-semibold mb-2 text-warning-text"`
子项 label：`className="flex items-center gap-1.5 mb-1 cursor-pointer"`
ID span：`className="font-mono text-[11px]"`
恢复按钮：
```tsx
className="mt-2 px-2.5 py-1 border-none rounded bg-warning-border text-white text-[11px] cursor-pointer disabled:opacity-50"
```
关闭按钮：`className="mt-1 bg-transparent border-none text-warning-text cursor-pointer text-[11px]"`

- [ ] **Step 5: 替换表格区域**

表格容器：
```tsx
className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1"
```

表头行：
```tsx
className="grid grid-cols-[2fr_100px_120px_80px] gap-2 px-4 py-2 bg-surface-2 border-b border-border-subtle text-[11px] font-semibold text-text-muted uppercase tracking-wide"
```

数据行：
```tsx
className="grid grid-cols-[2fr_100px_120px_80px] gap-2 px-4 py-2.5 border-b border-border-subtle cursor-pointer transition-colors text-xs items-center hover:bg-surface-hover"
```
（删除 `onMouseEnter` / `onMouseLeave` 事件处理器）

工作流名称：`className="font-medium text-text-primary"`
描述：`className="text-[10px] text-text-muted mt-0.5"`
版本号：`className={wf.latestVersion ? "text-status-running font-mono" : "text-text-muted font-mono"}`
时间：`className="text-text-secondary"`

操作按钮容器：`className="flex gap-1"` （保留 `onClick stopPropagation`）
操作按钮：
```tsx
className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded hover:bg-surface-hover text-text-muted cursor-pointer transition-colors"
```
删除按钮额外加 `hover:text-status-error`

- [ ] **Step 6: 替换 loading/error/empty 状态**

Loading：
```tsx
<div className="text-center py-10 text-text-muted text-[13px]">
  <Loader size={20} className="animate-spin inline-block" />
  <p className="mt-2">{t("list.loading")}</p>
</div>
```

Error：
```tsx
<div className="text-center py-10">
  <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
  <p className="text-[13px] text-text-secondary">{t("list.load_failed", { error })}</p>
</div>
```

Empty：
```tsx
<div className="text-center py-10">
  <Inbox size={32} className="text-text-muted mx-auto mb-2" />
  <p className="text-[13px] text-text-muted font-medium">{searchQuery ? t("list.no_match") : t("list.no_workflows")}</p>
  <p className="text-[11px] text-text-dim mt-1">{t("list.no_workflows_hint")}</p>
</div>
```

底部计数：`className="mt-3 text-[11px] text-text-muted text-center"`

- [ ] **Step 7: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 8: 提交**

```bash
git add web/src/pages/workflow/WorkflowList.tsx
git commit -m "refactor(workflow): WorkflowList inline style 迁移到 Tailwind + 设计 token"
```

---

### Task 3: WorkflowVersions — 替换 confirm/alert + inline → Tailwind

**Files:**
- Modify: `web/src/pages/workflow/WorkflowVersions.tsx`

**目标：** 替换 `confirm()`/`alert()`，将所有 inline style 迁移到 Tailwind。

- [ ] **Step 1: 添加 import**

```tsx
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
```

添加状态：
```tsx
const [confirmAction, setConfirmAction] = useState<{ type: "setLatest" | "restore"; version: number } | null>(null);
```

- [ ] **Step 2: 替换 handleSetLatest**

```tsx
const handleSetLatest = useCallback(
  async (version: number) => {
    setConfirmAction(null);
    try {
      await workflowDefApi.setLatest(workflowId, version);
      loadData();
    } catch (err) {
      console.error(err);
      toast.error(t("versions.operation_failed"), { description: (err as Error).message });
    }
  },
  [workflowId, loadData, t],
);
```

原来调用 `confirm()` 的地方改为：
```tsx
onClick={() => setConfirmAction({ type: "setLatest", version: v.version })}
```

- [ ] **Step 3: 替换 handleRestoreToDraft**

```tsx
const handleRestoreToDraft = useCallback(
  async (version: number) => {
    setConfirmAction(null);
    try {
      await workflowDefApi.restoreToDraft(workflowId, version);
      toast.success(t("versions.restore_success"));
    } catch (err) {
      console.error(err);
      toast.error(t("versions.restore_failed"), { description: (err as Error).message });
    }
  },
  [workflowId, t],
);
```

原来调用 `confirm()` 的地方改为：
```tsx
onClick={() => setConfirmAction({ type: "restore", version: v.version })}
```

- [ ] **Step 4: 替换 handleViewYaml 中的 alert()**

```tsx
toast.error(t("versions.yaml_load_failed"), { description: (err as Error).message });
```

- [ ] **Step 5: 添加 ConfirmDialog**

在 return 末尾添加：
```tsx
<ConfirmDialog
  open={confirmAction !== null}
  onOpenChange={(open) => { if (!open) setConfirmAction(null); }}
  title={confirmAction?.type === "setLatest" ? t("versions.set_latest") : t("versions.restore_to_draft")}
  description={
    confirmAction?.type === "setLatest"
      ? t("versions.set_latest_confirm", { version: confirmAction.version })
      : t("versions.restore_confirm", { version: confirmAction.version })
  }
  variant={confirmAction?.type === "restore" ? "destructive" : "default"}
  onConfirm={() => {
    if (confirmAction?.type === "setLatest") handleSetLatest(confirmAction.version);
    else if (confirmAction?.type === "restore") handleRestoreToDraft(confirmAction.version);
  }}
/>
```

- [ ] **Step 6: 迁移全部 inline style 到 Tailwind**

应用与 Task 2 相同的 token 映射规则：

- 根容器：`className="h-full overflow-y-auto p-6"`
- 标题栏：`className="flex items-center justify-between mb-5"`
- h1：`className="text-base font-semibold text-text-primary m-0"`
- 刷新按钮：同 Task 2 按钮样式
- 状态卡片：`className="p-2.5 bg-surface-2 rounded-lg border border-border-subtle mb-4 text-xs text-text-secondary flex gap-4"`
- 表格容器：`className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1"`
- 版本行：`className="border-b border-border-subtle"`，内部 flex 行加 `hover:bg-surface-hover transition-colors cursor-pointer`
- 版本号：`className="font-mono font-semibold text-text-primary min-w-[40px]"`
- latest badge：`className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-running bg-surface-2 px-1.5 py-px rounded-full"`
- 时间：`className="text-text-muted text-[11px]"`
- 操作按钮：`className="flex items-center gap-1 px-2 py-0.5 border border-border-subtle rounded text-[10px] text-text-secondary bg-surface-1 cursor-pointer hover:bg-surface-hover transition-colors"`
- YAML 预览 pre：`className="bg-surface-2 border border-border-subtle rounded-md p-2.5 text-[11px] font-mono text-text-secondary max-h-[300px] overflow-auto m-0 whitespace-pre-wrap"`
- loading/error/empty 状态：同 Task 2 的样式模式

- [ ] **Step 7: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 8: 提交**

```bash
git add web/src/pages/workflow/WorkflowVersions.tsx
git commit -m "refactor(workflow): WorkflowVersions 替换 confirm/alert，迁移到 Tailwind"
```

---

### Task 4: WorkflowRuns — inline → Tailwind

**Files:**
- Modify: `web/src/pages/workflow/WorkflowRuns.tsx`

**目标：** 将所有 inline style 迁移到 Tailwind + 设计 token。

- [ ] **Step 1: 替换 handleCancel 中的 alert()**

```tsx
import { toast } from "sonner";
```

将 `alert((err as Error).message)` 替换为：
```tsx
toast.error(t("runs.cancel"), { description: (err as Error).message });
```

- [ ] **Step 2: 迁移全部 inline style**

应用与 Task 2 相同的 token 映射规则：

- 根容器：`className="h-full overflow-y-auto p-6"`
- 标题栏：`className="flex items-center justify-between mb-5"`
- h1：`className="text-base font-semibold text-text-primary m-0"`
- 刷新按钮：同 Task 2 按钮样式
- 搜索 + 筛选栏：`className="flex gap-2.5 mb-4 items-center"`
- 搜索框：同 Task 2 搜索框样式
- 筛选按钮：
```tsx
className={`px-2.5 py-1 border rounded-md text-[11px] font-medium cursor-pointer transition-colors ${
  statusFilter === s
    ? "border-brand bg-brand-subtle text-brand"
    : "border-border-subtle bg-surface-1 text-text-secondary hover:bg-surface-hover"
}`}
```
- StatusBadge 组件：保持独立函数，但用 Tailwind 类名：
```tsx
function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("workflows");
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.PENDING;
  const isRunning = status === "RUNNING";
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ color: cfg.color, background: cfg.bg }}>
      {isRunning && <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: cfg.color }} />}
      {t(STATUS_LABEL_KEYS[status] ?? status)}
    </span>
  );
}
```
注意：StatusBadge 的颜色来自 `STATUS_CONFIG` 映射表（语义色），此处保留 style 属性传递动态色值是合理的。

- 表格容器/表头/数据行：同 Task 2 表格模式
- 表头：`className="grid grid-cols-[2fr_1fr_80px_120px_80px_80px] gap-2 px-4 py-2 bg-surface-2 border-b border-border-subtle text-[11px] font-semibold text-text-muted uppercase tracking-wide"`
- 数据行：`className="grid grid-cols-[2fr_1fr_80px_120px_80px_80px] gap-2 px-4 py-2.5 border-b border-border-subtle cursor-pointer transition-colors text-xs items-center hover:bg-surface-hover"`
- 删除 `onMouseEnter`/`onMouseLeave` 事件
- 节点进度：`className="font-mono text-text-secondary"` 内部 `<span className="text-status-running">`
- runId：`className="text-[10px] text-text-secondary font-mono mt-0.5"`
- 耗时：`className="font-mono text-text-secondary"`
- 取消按钮：`className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded text-status-error cursor-pointer hover:bg-surface-hover transition-colors"`
- 详情按钮：`className="flex items-center justify-center w-6 h-6 border-none bg-transparent rounded text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"`
- loading/error/empty：同 Task 2 模式
- 底部计数：`className="mt-3 text-[11px] text-text-muted text-center"`

- [ ] **Step 3: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/WorkflowRuns.tsx
git commit -m "refactor(workflow): WorkflowRuns inline style 迁移到 Tailwind + 设计 token"
```

---

### Task 5: nodes.tsx — inline → Tailwind + 优化节点配色

**Files:**
- Modify: `web/src/pages/workflow/nodes.tsx`

**目标：** 将画布节点组件的 inline style 迁移到 Tailwind，将节点配色从 7 色系精简为 3 组色系（主色/中性/警告）。

- [ ] **Step 1: 精简 NODE_COLORS 配色**

将 7 种节点颜色精简为 3 组色系（用 brand indigo 代替蓝/紫/粉，用 accent-green 代替绿色，保留 warning amber）：

```tsx
const NODE_COLORS: Record<string, { main: string; light: string; headerText: string }> = {
  start:   { main: "#6366f1", light: "rgba(99,102,241,0.08)", headerText: "#fff" },   // brand indigo
  shell:   { main: "#6366f1", light: "rgba(99,102,241,0.08)", headerText: "#fff" },   // brand indigo
  python:  { main: "#818cf8", light: "rgba(129,140,248,0.08)", headerText: "#fff" },  // brand-light
  agent:   { main: "#10b981", light: "rgba(16,185,129,0.08)", headerText: "#fff" },   // accent-green
  api:     { main: "#818cf8", light: "rgba(129,140,248,0.08)", headerText: "#fff" },  // brand-light
  audit:   { main: "#f59e0b", light: "rgba(245,158,11,0.08)", headerText: "#fff" },   // warning
  workflow:{ main: "#6366f1", light: "rgba(99,102,241,0.08)", headerText: "#fff" },   // brand indigo
  loop:    { main: "#818cf8", light: "rgba(129,140,248,0.08)", headerText: "#fff" },  // brand-light
};
```

这样节点只有 3 种视觉色系：indigo（主色）、green（Agent）、amber（审批），视觉上更有层次且不杂乱。

- [ ] **Step 2: 迁移 WorkflowNode 组件 inline style**

节点的 inline style 无法完全用 Tailwind 替代（因为颜色来自动态 `NODE_COLORS` 映射），但可以精简：

外层 div — 保留动态 `border` 和 `boxShadow`（因为来自运行状态），但基础样式用 className：
```tsx
<div
  data-node-id={id}
  className="bg-surface-1 overflow-hidden transition-[border-color,box-shadow] duration-150"
  style={{
    borderRadius: 8,
    minWidth: isStart ? 120 : 180,
    maxWidth: isStart ? 140 : 240,
    fontSize: 12,
    border: `2px solid ${borderColor}`,
    boxShadow,
  }}
>
```

Header div — 保留动态背景色：
```tsx
<div
  className="flex items-center gap-1.5 font-semibold"
  style={{ background: colors.main, color: colors.headerText, padding: "5px 10px", letterSpacing: 0.3, justifyContent: isStart ? "center" : undefined }}
>
```

内容区域 — 保留动态背景：
```tsx
<div style={{ background: statusColors?.bg ?? colors.light, padding: "6px 10px" }}>
  {d.description ? (
    <div className="text-text-secondary whitespace-nowrap overflow-hidden text-ellipsis text-[11px] mb-0.5">
      {String(d.description)}
    </div>
  ) : null}
  {preview ? (
    <div className="text-text-primary whitespace-nowrap overflow-hidden text-ellipsis text-[11px] font-mono">
      {preview.substring(0, 40)}
    </div>
  ) : !d.description ? (
    <div className="text-text-muted text-[11px] italic">{t("nodes.not_configured")}</div>
  ) : null}
</div>
```

状态栏 — 保留动态色但精简：
```tsx
<div
  className="flex items-center gap-1 text-[10px] font-medium"
  style={{ padding: "3px 10px", background: statusColors.bg, borderTop: `1px solid ${statusColors.color}20`, color: statusColors.color }}
>
```

操作按钮 — 用 className 替代大部分 inline：
```tsx
<button
  type="button"
  onClick={(e) => { e.stopPropagation(); onViewOutput(id); }}
  title={t("nodes.view_output")}
  className="flex items-center justify-center w-[18px] h-[18px] rounded-sm bg-surface-1 cursor-pointer p-0"
  style={{ border: `1px solid ${statusColors.color}40`, color: statusColors.color }}
>
  <Eye size={10} />
</button>
```

Handle — 保留动态颜色但加 transition class：
```tsx
<Handle
  type="source"
  position={Position.Bottom}
  className="transition-transform duration-150 hover:scale-140"
  style={{ background: colors.main, width: 8, height: 8, border: "2px solid #fff" }}
/>
```

注意：React Flow 的 Handle 组件需要 `style` 属性传递位置和颜色，这部分 inline style 是合理的。

- [ ] **Step 3: 迁移 StatusDot 组件**

```tsx
function StatusDot({ status }: { status: string }) {
  if (status === "RUNNING")
    return <Loader size={11} className="text-white animate-spin" />;
  if (status === "COMPLETED") return <CheckCircle size={11} className="text-white" />;
  if (status === "FAILED") return <XCircle size={11} className="text-white" />;
  return (
    <span
      className="w-[7px] h-[7px] rounded-full inline-block"
      style={{ background: status === "PENDING" ? "rgba(255,255,255,0.5)" : "rgba(255,255,255,0.3)" }}
    />
  );
}
```

- [ ] **Step 4: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/workflow/nodes.tsx
git commit -m "refactor(workflow): 画布节点迁移到 Tailwind，精简节点配色为 3 组色系"
```

---

### Task 6: RunStatusPanel — inline → Tailwind

**Files:**
- Modify: `web/src/pages/workflow/components/RunStatusPanel.tsx`

**目标：** 将运行状态面板的所有 inline style 迁移到 Tailwind。

- [ ] **Step 1: 迁移运行状态头**

将状态头部 div 替换为：
```tsx
<div className="px-3 py-2 border-b border-border-subtle flex items-center gap-1.5">
```

返回按钮：
```tsx
className="flex items-center justify-center w-[22px] h-[22px] border-none bg-surface-2 rounded text-text-secondary cursor-pointer shrink-0 hover:bg-surface-hover transition-colors"
```

标题：`className="text-xs font-semibold text-text-primary"`
状态 badge — 保留动态色但精简：
```tsx
<span
  className="inline-flex items-center gap-1 px-1.5 py-px rounded-full text-[10px] font-medium"
  style={{ color: DAG_STATUS_CFG[dagStatus!]?.color ?? "var(--color-text-secondary)", background: DAG_STATUS_CFG[dagStatus!]?.bg ?? "var(--color-surface-2)" }}
>
```

取消/编辑按钮：
```tsx
// 取消
className="flex items-center justify-center w-6 h-6 border-none bg-red-50 rounded text-status-error cursor-pointer hover:bg-surface-hover transition-colors"

// 编辑
className="flex items-center justify-center w-6 h-6 border-none bg-surface-2 rounded text-text-secondary cursor-pointer hover:bg-surface-hover transition-colors"
```

- [ ] **Step 2: 迁移审批卡片**

外层：`className="p-2.5 border-b border-warning-border bg-warning-bg"`
标题：`className="text-[11px] font-semibold text-warning-text mb-1.5 flex items-center gap-1"`
节点信息：`className="text-[10px] text-amber-800 mb-1.5"`
审批消息：`className="text-warning-text mb-1"`
审批按钮：
```tsx
className="px-2 py-0.5 border border-warning-border rounded bg-warning-border text-white text-[10px] font-medium cursor-pointer hover:opacity-90 transition-opacity"
```

- [ ] **Step 3: 迁移进度条**

```tsx
<div className="px-3 py-1 border-b border-border-subtle text-[10px] text-text-secondary flex justify-between">
```
runId：`className="font-mono text-[9px]"`

- [ ] **Step 4: 迁移子 Tab 切换**

```tsx
<button
  type="button"
  onClick={() => setRunRightTab("events")}
  className={`flex-1 py-[7px] border-none bg-transparent text-[11px] cursor-pointer ${
    runRightTab === "events"
      ? "font-semibold text-text-primary border-b-2 border-brand"
      : "font-normal text-text-secondary border-b-2 border-transparent"
  }`}
>
```

- [ ] **Step 5: 迁移事件列表**

事件行：
```tsx
<div
  className="px-3 py-[5px] border-b border-border-subtle flex gap-1.5 items-start"
  style={{ cursor: evt.node_id ? "pointer" : "default" }}
  onClick={() => { if (evt.node_id) setSelectedRunNodeId(evt.node_id); }}
>
```

事件名：`className="font-medium text-text-secondary"`
时间：`className="text-text-muted text-[9px] shrink-0"`
节点 ID：`className="text-text-secondary font-mono text-[9px]"`
元数据：`className="text-text-secondary text-[9px] mt-px font-mono"`

空状态：`className="py-5 text-center text-text-secondary"`

- [ ] **Step 6: 迁移节点输出区域**

节点 ID 行：
```tsx
<div className="px-3 py-1.5 border-b border-border-subtle flex items-center justify-between gap-1.5">
```
ID：`className="text-[10px] text-text-muted font-mono"`
重跑按钮：
```tsx
className="flex items-center gap-1 px-2 py-0.5 border border-brand rounded bg-brand-subtle text-brand text-[10px] font-medium cursor-pointer disabled:opacity-50 hover:bg-surface-hover transition-colors"
```

- [ ] **Step 7: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 8: 提交**

```bash
git add web/src/pages/workflow/components/RunStatusPanel.tsx
git commit -m "refactor(workflow): RunStatusPanel inline style 迁移到 Tailwind + 设计 token"
```

---

### Task 7: WorkflowEditor — 保存/DryRun 状态改用 toast

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

**目标：** 将绝对定位的保存状态和 DryRun 结果 div 改为 toast 通知，减少画布上的视觉干扰。

- [ ] **Step 1: 添加 toast import**

```tsx
import { toast } from "sonner";
```

- [ ] **Step 2: 添加 saveStatus 变化时的 useEffect toast**

在 `useWorkflowPersistence` hook 调用之后添加：
```tsx
useEffect(() => {
  if (saveStatus === "saved") {
    toast.success(t("editor.saved"), { duration: 1500 });
  }
}, [saveStatus, t]);
```

- [ ] **Step 3: 删除保存状态绝对定位 div**

删除 L603-621 的 `{saveStatus === "saving" && (...)}`  和 `{saveStatus === "saved" && (...)}` 两个 div。saving 状态可以在 toolbar 保存按钮上用 spinner 指示即可（按钮已有 disabled）。

- [ ] **Step 4: DryRun 完成时改用 toast**

DryRun 成功时：
```tsx
// 在 useWorkflowRun hook 内部或 WorkflowEditor 中添加 useEffect
useEffect(() => {
  if (!dryRunResult) return;
  if (dryRunResult.valid) {
    toast.success(t("editor.validate_pass"), { duration: 2000 });
  } else {
    toast.error(t("editor.validate_fail", { count: dryRunResult.issues.length }), {
      description: dryRunResult.issues.map((i) => `${i.type === "error" ? "❌" : "⚠️"} ${i.message}`).join("\n"),
      duration: 5000,
    });
  }
}, [dryRunResult, t]);
```

- [ ] **Step 5: 删除 DryRun 结果绝对定位 div**

删除 L643-699 的 `{dryRunResult && (...)}` div。

- [ ] **Step 6: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 7: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor(workflow): 保存和 DryRun 状态通知改用 toast，移除画布绝对定位 div"
```

---

### Task 8: 瘦身 workflow.css

**Files:**
- Modify: `web/src/pages/workflow/workflow.css`

**目标：** 删除已被 Tailwind 替代的 CSS 规则，保留 React Flow 特有样式和无法用 Tailwind 替代的规则。

- [ ] **Step 1: 识别可删除的规则**

以下规则在 Task 2-6 完成后不再被引用，可以删除：

- `.wf-editor-container` → 可用 `flex w-full h-full bg-surface-0` 替代
- `.wf-canvas-wrapper` → 可用 `flex-1 relative overflow-hidden` 替代
- `.wf-prop-panel` → 如有引用，改用 Tailwind
- `.wf-prop-header` / `.wf-prop-title` / `.wf-prop-body` / `.wf-prop-section` / `.wf-prop-section-title` / `.wf-prop-field` / `.wf-prop-hint` → NodeConfigCard 仍在使用，暂保留
- `.wf-panel-palette` / `.wf-palette` / `.wf-palette-title` / `.wf-palette-btn` / `.wf-palette-icon` → 编辑器调色板，暂保留
- `.wf-panel-toolbar` / `.wf-toolbar` / `.wf-toolbar-btn` / `.wf-toolbar-divider` → 编辑器工具栏，暂保留
- `.wf-yaml-slide` 及相关 → 暂保留
- `.wf-readonly-badge` / `.wf-canvas-readonly` / `.wf-prop-readonly-tag` → 暂保留
- `.wf-run-panel` → 暂保留
- `.wf-node-popover` / `.wf-meta-popover` 及相关 → 暂保留
- `.wf-sheet-body` → 暂保留

**本轮瘦身策略：** 只删除 `.wf-editor-container` 和 `.wf-canvas-wrapper`，因为它们是最简单的、可以直接在 WorkflowEditor.tsx 中用 className 替代的规则。

- [ ] **Step 2: 删除 .wf-editor-container 和 .wf-canvas-wrapper**

从 `workflow.css` 中删除：
```css
.wf-editor-container {
  display: flex;
  width: 100%;
  height: 100%;
  background: #f9fafb;
}

.wf-canvas-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
}
```

- [ ] **Step 3: 更新 WorkflowEditor.tsx 中的 className 引用**

将 `className="wf-editor-container"` 改为：
```tsx
className="flex w-full h-full bg-surface-0"
```

将 `className="wf-canvas-wrapper"` 改为：
```tsx
className="flex-1 relative overflow-hidden"
```

- [ ] **Step 4: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/workflow/workflow.css web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor(workflow): 瘦身 workflow.css，删除已被 Tailwind 替代的容器规则"
```

---

### Task 9: 添加 skeleton loading 状态

**Files:**
- Modify: `web/src/pages/workflow/WorkflowList.tsx`
- Modify: `web/src/pages/workflow/WorkflowRuns.tsx`
- Modify: `web/src/pages/workflow/WorkflowVersions.tsx`

**目标：** 用骨架屏替代 Loader spinner，提供更现代的加载体验。

- [ ] **Step 1: 创建共享 skeleton 组件**

在 `web/src/pages/workflow/components/SkeletonRows.tsx` 中创建：
```tsx
export function SkeletonRow({ cols }: { cols: string }) {
  return (
    <div className="grid gap-2 px-4 py-3 border-b border-border-subtle" style={{ gridTemplateColumns: cols }}>
      {Array.from({ length: cols.split(" ").length }).map((_, i) => (
        <div key={i} className="h-3 bg-surface-2 rounded animate-pulse" />
      ))}
    </div>
  );
}

export function SkeletonTable({ cols, rows = 5 }: { cols: string; rows?: number }) {
  return (
    <div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonRow key={i} cols={cols} />
      ))}
    </div>
  );
}
```

- [ ] **Step 2: 在 WorkflowList 中使用 SkeletonTable**

替换 loading 分支：
```tsx
import { SkeletonTable } from "./components/SkeletonRows";

// loading 状态
<SkeletonTable cols="2fr 100px 120px 80px" rows={4} />
```

- [ ] **Step 3: 在 WorkflowRuns 中使用 SkeletonTable**

替换 loading 分支：
```tsx
<SkeletonTable cols="2fr 1fr 80px 120px 80px 80px" rows={6} />
```

- [ ] **Step 4: 在 WorkflowVersions 中使用 skeleton**

版本列表的 loading 状态：
```tsx
<div className="border border-border-subtle rounded-lg overflow-hidden bg-surface-1">
  {Array.from({ length: 3 }).map((_, i) => (
    <div key={i} className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle">
      <div className="h-4 w-10 bg-surface-2 rounded animate-pulse" />
      <div className="h-3 w-20 bg-surface-2 rounded animate-pulse" />
      <div className="ml-auto h-3 w-16 bg-surface-2 rounded animate-pulse" />
    </div>
  ))}
</div>
```

- [ ] **Step 5: 构建 & 验证**

Run: `bun run build:web`
Expected: 编译成功

- [ ] **Step 6: 提交**

```bash
git add web/src/pages/workflow/components/SkeletonRows.tsx web/src/pages/workflow/WorkflowList.tsx web/src/pages/workflow/WorkflowRuns.tsx web/src/pages/workflow/WorkflowVersions.tsx
git commit -m "feat(workflow): 添加 skeleton loading 状态替代 Loader spinner"
```

---

### Task 10: 最终验证 + precheck

**Files:**
- All modified files

**目标：** 运行完整的代码质量检查，确保所有变更符合项目规范。

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`
Expected: 格式化、import 排序、tsc、biome check 全部通过

- [ ] **Step 2: 如有 precheck 错误，修复并重跑**

常见问题：
- import 顺序不对 → `bun run precheck` 会自动修复（前两步是 `--write`）
- biome lint 警告 → 根据提示修复
- TypeScript 类型错误 → 检查组件 props 类型是否匹配

- [ ] **Step 3: 运行前端测试**

Run: `bun test web/src/__tests__/`
Expected: 所有测试通过

- [ ] **Step 4: 最终提交**

```bash
git add -A
git commit -m "chore(workflow): 重新设计收尾，通过 precheck 和测试"
```

---

## Self-Review

### 1. Spec coverage

| 诊断项 | 对应 Task |
|--------|-----------|
| P0: 统一到 Tailwind + 设计 token | Task 2, 3, 4, 5, 6 |
| P0: 替换 confirm()/alert() | Task 1, 3 |
| P1: 替换自制 modal | Task 1 |
| P1: 精简 workflow.css | Task 8 |
| P1: 改善 hover/active 状态 | Task 2-6（迁移时一并用 CSS hover 替代 JS 事件） |
| P2: 节点配色优化 | Task 5 |
| P2: skeleton loading | Task 9 |
| P2: 保存/DryRun 改 toast | Task 7 |
| P3: Typography 一致性 | Task 2-6（迁移时统一使用设计 token 的 text-* 类） |

### 2. Placeholder scan

无 TBD/TODO/placeholder。所有步骤包含具体代码。

### 3. Type consistency

- `ConfirmDialog` 的 props（`open`, `onOpenChange`, `title`, `description`, `variant`, `onConfirm`）在各 Task 中使用一致
- `toast.error` / `toast.success` 的调用签名一致
- 所有 i18n 键引用自已有的 `workflows.json`，无新增键
