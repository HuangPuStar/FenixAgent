# Workflow 版本预览与指示器 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Workflow 编辑器右下角新增版本指示器按钮，支持在画布中预览已发布版本的 DAG 图，并提供"恢复为草稿"和"设为最新"操作。

**Architecture:** 新增 `VersionIndicator` 组件作为右下角 Popover，复用现有 `readOnly` 机制实现版本预览的只读画布。`WorkflowEditor` 新增 `previewVersion` 状态控制预览切换，`useWorkflowPersistence` 在预览模式下跳过自动保存。

**Tech Stack:** React 19, TanStack Router, Radix Popover (shadcn/ui), i18next, Lucide icons

---

## File Structure

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/src/pages/workflow/components/VersionIndicator.tsx` | 新建 | 版本指示器组件：按钮 badge + Popover 下拉菜单（版本列表 + 操作） |
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 新增 `previewVersion` 状态、`handlePreviewVersion`/`handleBackToDraft` 回调，引入 VersionIndicator，预览模式下禁用保存/发布 |
| `web/src/pages/workflow/hooks/useWorkflowPersistence.ts` | 修改 | 接收 `previewVersion` 参数，预览模式下跳过自动保存和 Ctrl+S |
| `web/src/pages/workflow/workflow.css` | 修改 | 重构右下角按钮组为 flex 布局，新增 `wf-version-indicator-anchor` 样式 |
| `web/src/i18n/locales/en/workflows.json` | 修改 | 新增 `version_indicator` 命名空间的翻译 key |
| `web/src/i18n/locales/zh/workflows.json` | 修改 | 新增 `version_indicator` 命名空间的翻译 key |

---

### Task 1: i18n 翻译 key

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: 在英文翻译文件中新增 `version_indicator` 命名空间**

在 `web/src/i18n/locales/en/workflows.json` 的 `editor` 命名空间内（`"history_untitled": "New conversation"` 之后）添加以下 key：

```json
"tooltip_version_indicator": "Version status & preview",
"vi_status_draft": "Editing draft",
"vi_status_preview": "Previewing v{{version}}",
"vi_badge_draft": "draft",
"vi_back_to_draft": "Back to draft",
"vi_preview": "Preview",
"vi_set_latest": "Set as latest",
"vi_restore_to_draft": "Restore to draft",
"vi_restore_confirm": "Restore v{{version}} content to draft? Current draft will be overwritten.",
"vi_view_all": "View all versions",
"vi_no_versions": "No published versions",
"vi_no_versions_hint": "Publish to create the first version",
"vi_latest_badge": "latest: v{{version}}",
"vi_preview_mode": "Previewing"
```

- [ ] **Step 2: 在中文翻译文件中新增对应 key**

在 `web/src/i18n/locales/zh/workflows.json` 的 `editor` 命名空间内（`"history_untitled": "新对话"` 之后）添加：

```json
"tooltip_version_indicator": "版本状态与预览",
"vi_status_draft": "正在编辑草稿",
"vi_status_preview": "正在预览 v{{version}}",
"vi_badge_draft": "草稿",
"vi_back_to_draft": "返回草稿",
"vi_preview": "预览",
"vi_set_latest": "设为最新",
"vi_restore_to_draft": "恢复为草稿",
"vi_restore_confirm": "将 v{{version}} 的内容恢复到草稿？当前草稿将被覆盖。",
"vi_view_all": "查看全部版本",
"vi_no_versions": "暂无发布版本",
"vi_no_versions_hint": "发布后创建第一个版本",
"vi_latest_badge": "latest: v{{version}}",
"vi_preview_mode": "预览中"
```

- [ ] **Step 3: 提交**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "feat(workflow): add version indicator i18n keys"
```

---

### Task 2: CSS — 右下角按钮组 flex 布局

**Files:**
- Modify: `web/src/pages/workflow/workflow.css`

- [ ] **Step 1: 重构右下角按钮组定位方式**

将现有的 `wf-meta-popover-anchor` 和 `wf-run-popover-anchor` 的绝对定位改为一个统一的 flex 容器。找到 CSS 中以下两个类：

```css
.wf-meta-popover-anchor {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 5;
}

.wf-run-popover-anchor {
  position: absolute;
  bottom: 12px;
  right: 52px;
  z-index: 5;
}
```

替换为：

```css
.wf-bottom-actions {
  position: absolute;
  bottom: 12px;
  right: 12px;
  z-index: 5;
  display: flex;
  flex-direction: row-reverse;
  gap: 8px;
}
```

同时将 `.wf-run-popover-anchor` 和 `.wf-meta-popover-anchor` 中的 `position`/`bottom`/`right`/`z-index` 属性删除（保留其他样式不变），因为定位改由父容器 `.wf-bottom-actions` 统一管理。

注意：`.wf-meta-trigger-btn` 和 `.wf-run-popover-anchor` 本身不需要改，只是把 `position: absolute` 等定位属性移除。

- [ ] **Step 2: 提交**

```bash
git add web/src/pages/workflow/workflow.css
git commit -m "refactor(workflow): use flex layout for bottom-right action buttons"
```

---

### Task 3: WorkflowEditor — 包裹底部按钮组容器

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 用 flex 容器包裹右下角按钮组**

在 `WorkflowEditorInner` 的 JSX 中，找到 `WorkflowMetaPopover` 和运行日志 Popover 这两个兄弟元素（大约在第 716-784 行）。用一个 `<div className="wf-bottom-actions">` 包裹它们：

**修改前（大致结构）：**

```tsx
{/* 工作流元数据 Popover（右下角齿轮） */}
<WorkflowMetaPopover ... />

{/* 运行日志 Popover（右下角，齿轮左侧） */}
<div className="wf-run-popover-anchor">
  ...
</div>
```

**修改后：**

```tsx
{/* 右下角按钮组 */}
<div className="wf-bottom-actions">
  {/* 版本指示器（最左侧）——占位，Task 5 填入实际组件 */}

  {/* 运行日志 Popover */}
  <Popover open={runSheetOpen} onOpenChange={setRunSheetOpen}>
    ...
  </Popover>

  {/* 工作流元数据 Popover（齿轮） */}
  <WorkflowMetaPopover ... />
</div>
```

具体改动：
1. 删除 `<div className="wf-run-popover-anchor">` 包裹层，因为 `wf-bottom-actions` 容器已经统一管理定位
2. `WorkflowMetaPopover` 内部的 `<div className="wf-meta-popover-anchor">` 包裹层也删除定位属性（已在 Task 2 中处理 CSS）
3. 注意保持 `Popover` 结构不变，只改外层包裹

- [ ] **Step 2: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor(workflow): wrap bottom-right buttons in flex container"
```

---

### Task 4: VersionIndicator 组件

**Files:**
- Create: `web/src/pages/workflow/components/VersionIndicator.tsx`

- [ ] **Step 1: 创建 VersionIndicator 组件**

创建 `web/src/pages/workflow/components/VersionIndicator.tsx`：

```tsx
import { GitBranch, Loader, RotateCcw, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { type WorkflowVersionItem, workflowDefApi } from "../../../api/workflow-defs";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";

export interface VersionIndicatorProps {
  workflowId?: string;
  latestVersion: number | null;
  previewVersion: number | null;
  onPreview: (version: number) => void;
  onBackToDraft: () => void;
  onViewAll: () => void;
}

/** 最多在下拉菜单中显示的版本数（不含 latest 重复项） */
const MAX_VISIBLE_VERSIONS = 3;

export function VersionIndicator({
  workflowId,
  latestVersion,
  previewVersion,
  onPreview,
  onBackToDraft,
  onViewAll,
}: VersionIndicatorProps) {
  const { t } = useTranslation("workflows");
  const [open, setOpen] = useState(false);
  const [versions, setVersions] = useState<WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{
    type: "setLatest" | "restore";
    version: number;
  } | null>(null);

  // 打开 Popover 时加载版本列表
  const loadVersions = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const list = await workflowDefApi.getVersions(workflowId);
      setVersions(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    if (open) loadVersions();
  }, [open, loadVersions]);

  // 去重并截取前 N 个（版本列表按 version 降序，latest 可能已在列表头部）
  const visibleVersions = versions.slice(0, MAX_VISIBLE_VERSIONS);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      setConfirmAction(null);
      try {
        await workflowDefApi.setLatest(workflowId, version);
        toast.success(t("versions.set_latest"));
        loadVersions();
      } catch (err) {
        console.error(err);
        toast.error(t("versions.operation_failed"), { description: (err as Error).message });
      }
    },
    [workflowId, loadVersions, t],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      setConfirmAction(null);
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        toast.success(t("versions.restore_success"));
        // 恢复成功后自动切回草稿
        onBackToDraft();
        setOpen(false);
      } catch (err) {
        console.error(err);
        toast.error(t("versions.restore_failed"), { description: (err as Error).message });
      }
    },
    [workflowId, onBackToDraft, t],
  );

  const isPreviewing = previewVersion !== null;

  // 按钮 badge 文本
  const badgeText = isPreviewing ? `v${previewVersion}` : t("editor.vi_badge_draft");
  // 按钮 title
  const titleText = isPreviewing
    ? t("editor.vi_status_preview", { version: previewVersion })
    : t("editor.vi_status_draft");

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={`wf-meta-trigger-btn ${isPreviewing ? "active" : ""}`}
            title={t("editor.tooltip_version_indicator")}
            style={isPreviewing ? { borderColor: "#3b82f6", color: "#3b82f6" } : undefined}
          >
            <GitBranch size={14} />
            <span style={{ fontSize: 10, fontWeight: 600, marginLeft: 2 }}>{badgeText}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={16}
          className="wf-meta-popover"
          style={{ width: 280 }}
        >
          {/* 当前状态 */}
          <div className="wf-popover-header">
            <span className="wf-popover-title">{titleText}</span>
          </div>

          {/* 返回草稿按钮（预览模式时可用） */}
          {isPreviewing && (
            <div style={{ padding: "0 12px 8px" }}>
              <button
                type="button"
                onClick={() => {
                  onBackToDraft();
                  setOpen(false);
                }}
                style={{
                  width: "100%",
                  padding: "6px 0",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  background: "#fff",
                  color: "#374151",
                  fontSize: 11,
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                {t("editor.vi_back_to_draft")}
              </button>
            </div>
          )}

          {/* 版本列表 */}
          <div style={{ maxHeight: 240, overflowY: "auto" }}>
            {loading ? (
              <div style={{ textAlign: "center", padding: 16, color: "#9ca3af", fontSize: 11 }}>
                <Loader size={14} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
              </div>
            ) : visibleVersions.length === 0 ? (
              <div style={{ textAlign: "center", padding: 16, color: "#d1d5db", fontSize: 11 }}>
                <p>{t("editor.vi_no_versions")}</p>
                <p style={{ fontSize: 9, marginTop: 2 }}>{t("editor.vi_no_versions_hint")}</p>
              </div>
            ) : (
              visibleVersions.map((v) => {
                const isLatest = latestVersion === v.version;
                const isCurrentPreview = previewVersion === v.version;
                return (
                  <div
                    key={v.id}
                    style={{
                      padding: "6px 12px",
                      borderBottom: "1px solid #f3f4f6",
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      background: isCurrentPreview ? "#eff6ff" : undefined,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: "ui-monospace, monospace",
                        fontWeight: 600,
                        color: "#111827",
                        fontSize: 11,
                        minWidth: 28,
                      }}
                    >
                      v{v.version}
                    </span>
                    {isLatest && (
                      <span
                        style={{
                          fontSize: 9,
                          fontWeight: 500,
                          color: "#22c55e",
                          background: "#f0fdf4",
                          padding: "1px 4px",
                          borderRadius: 99,
                        }}
                      >
                        latest
                      </span>
                    )}
                    <div style={{ marginLeft: "auto", display: "flex", gap: 3 }}>
                      <button
                        type="button"
                        onClick={() => {
                          onPreview(v.version);
                          setOpen(false);
                        }}
                        style={{
                          padding: "2px 6px",
                          border: "1px solid #e5e7eb",
                          borderRadius: 3,
                          background: isCurrentPreview ? "#3b82f6" : "#fff",
                          color: isCurrentPreview ? "#fff" : "#6b7280",
                          fontSize: 9,
                          cursor: "pointer",
                        }}
                      >
                        {t("editor.vi_preview")}
                      </button>
                      {isCurrentPreview && (
                        <>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ type: "setLatest", version: v.version })}
                            style={{
                              padding: "2px 6px",
                              border: "1px solid #e5e7eb",
                              borderRadius: 3,
                              background: "#fff",
                              color: "#6b7280",
                              fontSize: 9,
                              cursor: "pointer",
                            }}
                            title={t("editor.vi_set_latest")}
                          >
                            <Star size={9} style={{ verticalAlign: "middle" }} />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmAction({ type: "restore", version: v.version })}
                            style={{
                              padding: "2px 6px",
                              border: "1px solid #e5e7eb",
                              borderRadius: 3,
                              background: "#fff",
                              color: "#6b7280",
                              fontSize: 9,
                              cursor: "pointer",
                            }}
                            title={t("editor.vi_restore_to_draft")}
                          >
                            <RotateCcw size={9} style={{ verticalAlign: "middle" }} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* 查看全部链接 */}
          {versions.length > 0 && (
            <div style={{ padding: "6px 12px", borderTop: "1px solid #f3f4f6" }}>
              <button
                type="button"
                onClick={() => {
                  onViewAll();
                  setOpen(false);
                }}
                style={{
                  background: "none",
                  border: "none",
                  color: "#3b82f6",
                  fontSize: 10,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                {t("editor.vi_view_all")}
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {/* 确认对话框 */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={(o) => {
          if (!o) setConfirmAction(null);
        }}
        title={
          confirmAction?.type === "setLatest" ? t("editor.vi_set_latest") : t("editor.vi_restore_to_draft")
        }
        description={
          confirmAction?.type === "restore"
            ? t("editor.vi_restore_confirm", { version: confirmAction?.version ?? 0 })
            : t("versions.set_latest_confirm", { version: confirmAction?.version ?? 0 })
        }
        variant={confirmAction?.type === "restore" ? "destructive" : "default"}
        onConfirm={() => {
          if (!confirmAction) return;
          if (confirmAction.type === "setLatest") handleSetLatest(confirmAction.version);
          else if (confirmAction.type === "restore") handleRestoreToDraft(confirmAction.version);
        }}
      />
    </>
  );
}
```

- [ ] **Step 2: 提交**

```bash
git add web/src/pages/workflow/components/VersionIndicator.tsx
git commit -m "feat(workflow): add VersionIndicator component"
```

---

### Task 5: WorkflowEditor — previewVersion 状态与切换逻辑

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 新增 previewVersion 状态和相关回调**

在 `WorkflowEditorInner` 函数中：

**1a. 新增状态声明（在 `const [readOnly, setReadOnly] = useState(false);` 之后）：**

```tsx
// ── 版本预览状态 ──
const [previewVersion, setPreviewVersion] = useState<number | null>(null);
```

**1b. 新增版本预览切换回调（在 `onParamsSubmit` 回调之后）：**

```tsx
// ── 版本预览：切换到指定版本 ──
const handlePreviewVersion = useCallback(
  async (version: number) => {
    if (!workflowId) return;
    try {
      const result = await workflowDefApi.getVersion(workflowId, version);
      const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(result.yaml);
      const laid = autoLayout(newNodes, newEdges);
      setNodes(laid);
      setEdges(newEdges);
      setMeta(newMeta);
      setYamlText(result.yaml);
      setYamlBaseText(result.yaml);
      setPreviewVersion(version);
      setSelectedNode(null);
      setPopoverOpen(false);
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
    } catch (err) {
      console.error("Failed to preview version:", err);
      toast.error(t("editor.load_failed"));
    }
  },
  [workflowId, setNodes, setEdges, setMeta, setYamlText, fitView, t],
);

// ── 版本预览：切回草稿 ──
const handleBackToDraft = useCallback(async () => {
  if (!workflowId) return;
  try {
    const wf = await workflowDefApi.get(workflowId);
    if (wf.draftYaml) {
      const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
      const laid = autoLayout(newNodes, newEdges);
      setNodes(laid);
      setEdges(newEdges);
      setMeta(newMeta);
      setLastSavedYaml(wf.draftYaml);
    }
    setPreviewVersion(null);
    setSelectedNode(null);
    setPopoverOpen(false);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  } catch (err) {
    console.error("Failed to load draft:", err);
    toast.error(t("editor.load_failed"));
  }
}, [workflowId, setNodes, setEdges, setMeta, setLastSavedYaml, fitView, t]);
```

**1c. 修改 effectiveReadOnly 计算（在 `const effectiveReadOnly = readOnly || isRunMode;` 处）：**

```tsx
const effectiveReadOnly = readOnly || isRunMode || previewVersion !== null;
```

**1d. 修改草稿加载 useEffect（约第 326-358 行），在 `workflowId` 切换时清理 previewVersion：**

在清理逻辑中添加 `setPreviewVersion(null);`：

```tsx
// workflowId 切换时清理所有旧状态
setPreviewVersion(null);
setActiveRunId(null);
// ... 其余不变
```

**1e. 修改 SSE 事件处理 useEffect，预览模式下不触发自动刷新：**

在 `workflow.draft_updated` 分支中增加 `previewVersion` 守卫：

```tsx
case "workflow.draft_updated":
  if (!hasUnsavedChanges && previewVersion === null) {
    handleRefreshDraft();
  }
  break;
```

需要在 useEffect 的依赖数组中添加 `previewVersion`。

**1f. 修改 persistence hook 调用，传入 previewVersion：**

```tsx
} = useWorkflowPersistence({
  // ... 现有参数不变
  readOnly: readOnly || activeRunId !== null || previewVersion !== null,
});
```

注意：这里不需要改 `useWorkflowPersistence` 的接口签名。`readOnly` 已经控制自动保存跳过（`workflow.ts:126` 行 `if (!workflowId || readOnly || ...) return;`），所以传入 `readOnly: true` 就够了。

**1g. 修改保存/发布按钮，预览模式下 disabled：**

在工具栏的"保存草稿"按钮（约第 588-599 行）上添加 `previewVersion !== null` 条件：

```tsx
<button
  type="button"
  className={`wf-toolbar-btn ${saveStatus === "unsaved" ? "text-amber-500" : ""}`}
  onClick={handleSaveDraft}
  disabled={saveStatus === "saving" || previewVersion !== null}
  // ... 其余不变
>
```

在"发布"按钮（VersionPanel 的 `onPublish` 传入处）不需要改，因为 VersionPanel 在 Sheet 中，预览模式下 Sheet 仍可打开查看版本列表（但不建议发布）。如果想更安全，可以在 VersionPanel 的发布按钮上也加 disabled，但这属于增强而非核心。

- [ ] **Step 2: 在右下角按钮组中引入 VersionIndicator**

在 Task 3 创建的 `wf-bottom-actions` 容器内，在"运行日志 Popover"之前（即 flex 容器的最左侧位置）插入：

```tsx
{/* 版本指示器（最左侧） */}
<VersionIndicator
  workflowId={workflowId}
  latestVersion={wf?.latestVersion ?? null}
  previewVersion={previewVersion}
  onPreview={handlePreviewVersion}
  onBackToDraft={handleBackToDraft}
  onViewAll={() => {
    setVersionsSheetOpen(true);
    setRunSheetOpen(false);
    setTriggersSheetOpen(false);
  }}
/>
```

注意：`wf` 变量当前在 useEffect 局部作用域中，需要提升为组件级状态。具体改动：

**新增状态（在 `previewVersion` 状态旁边）：**

```tsx
const [wfData, setWfData] = useState<import("../../../api/workflow-defs").WorkflowDefItem | null>(null);
```

**在草稿加载 useEffect 中，加载完成后保存到状态：**

```tsx
// 在 useEffect 内加载完 wf 后：
setWfData(wf);
```

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat(workflow): add previewVersion state and version switching logic"
```

---

### Task 6: 预览模式下画布只读视觉反馈

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx`

- [ ] **Step 1: 在预览模式下显示预览 badge**

在 `effectiveReadOnly` 判断的 readonly badge 区域（约第 441-445 行），增加预览模式的 badge 显示：

找到：
```tsx
{effectiveReadOnly && (
  <div className="wf-readonly-badge" style={{ right: 12 }}>
    <Lock size={12} /> {t("editor.readonly_mode")}
  </div>
)}
```

替换为：
```tsx
{previewVersion !== null && (
  <div className="wf-readonly-badge" style={{ right: 12, borderColor: "#3b82f6", color: "#3b82f6", background: "rgba(239,246,255,0.9)" }}>
    {t("editor.vi_preview_mode")} v{previewVersion}
  </div>
)}
{effectiveReadOnly && previewVersion === null && (
  <div className="wf-readonly-badge" style={{ right: 12 }}>
    <Lock size={12} /> {t("editor.readonly_mode")}
  </div>
)}
```

- [ ] **Step 2: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "feat(workflow): show preview badge on canvas during version preview"
```

---

### Task 7: precheck 验证

- [ ] **Step 1: 运行 precheck 确保代码质量通过**

```bash
bun run precheck
```

Expected: 全部通过，无报错

- [ ] **Step 2: 如有格式/lint 问题，修复后重新 precheck**

```bash
# precheck 会自动修复格式和 import 排序
bun run precheck
```

- [ ] **Step 3: 最终提交（如有自动修复的变更）**

```bash
git add -A
git commit -m "style(workflow): fix lint and format issues"
```
