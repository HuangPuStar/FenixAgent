# 智能体编排面板布局统一 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/agent/workflow`（智能体编排面板）的视觉与交互对齐其他标准 Agent 页面（Tasks/Skills/Mcp/Knowledge 等），同时保留 Workflow 多模式切换（列表/看板/运行/统计）的核心交互。

**Architecture:** 主页面套用 `bg-[#f4f7fb] px-8 py-7` + `AgentPageHeader` + 内嵌下划线子 tab 的标准布局；`WorkflowList` 改用 `AgentCardList` 卡片列表；`WorkflowRuns` / `WorkflowStats` / `WorkflowKanban` 移除内部容器/标题、配色对齐；`WorkflowEditor` 保留全屏 DAG（仅 breadcrumb 配色美化）；`WorkflowVersions` 套用标准页面布局。原生 `<input>` / `<button>` / `<textarea>` 迁移到 shadcn 组件。`WorkflowTabPage` 通过 `refreshKey` 触发子组件刷新。

**Tech Stack:** React 19、TanStack Router、shadcn/ui（`Button` / `Input` / `Textarea` / `Label`）、`AgentCardList`、`AgentPageHeader`、`FormDialog`、`ConfirmDialog`、react-i18next、Tailwind CSS v4。

**Spec:** `docs/superpowers/specs/2026-06-16-workflow-panel-layout-unification-design.md`

**前置约定**：
- 测试策略：本次改造是**纯视觉对齐**，无业务逻辑变更，**不新增单元测试**（详见 spec § 7）。每个任务用 `bun run build:web`（编译验证）+ spec § 7 的手动验证清单（最终任务集中执行）作为验收。
- 提交风格：Angular 中文标题，AI 辅助提交附 `Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>`。
- 每个任务结束前必须 `bun run build:web` 通过。

---

## File Structure

**修改文件**（按任务依赖顺序）：

| 文件 | 改造重点 |
|---|---|
| `web/src/i18n/locales/zh/workflows.json` | 新增 `page.workflow_title` / `page.workflow_subtitle` / `list.edit` |
| `web/src/i18n/locales/en/workflows.json` | 同上英文版 |
| `web/src/pages/workflow/WorkflowList.tsx` | grid 表格 → `AgentCardList`；原生组件 → shadcn；删除内部标题栏/搜索栏 |
| `web/src/routes/agent/_panel/workflow.tsx` | 全宽 tab 栏 → 标准页面布局 + AgentPageHeader + 内嵌子 tab；持有 refreshKey + 创建/扫描恢复对话框 |
| `web/src/pages/workflow/WorkflowRuns.tsx` | 移除内部容器/标题；卡片样式对齐；原生 input → shadcn Input |
| `web/src/pages/workflow/WorkflowStats.tsx` | 移除内部容器/标题；MetricCard 与图表卡片配色对齐 |
| `web/src/pages/workflow/WorkflowKanban.tsx` | 保留特化布局；原生 button → shadcn Button；卡片配色对齐 |
| `web/src/pages/workflow/components/KanbanCard.tsx` | 卡片配色对齐 |
| `web/src/pages/workflow/components/KanbanColumn.tsx` | 列配色对齐 |
| `web/src/pages/workflow/WorkflowBreadcrumb.tsx` | 配色美化（仅 background / border 对齐） |
| `web/src/routes/agent/_panel/workflow_.$id.versions.tsx` | 外层套标准页面布局容器 |
| `web/src/pages/workflow/WorkflowVersions.tsx` | 移除内部容器/标题；套 AgentPageHeader；卡片列表对齐 |
| `web/src/i18n/locales/zh/workflows.json`（再改） | 清理悬空 key |
| `web/src/i18n/locales/en/workflows.json`（再改） | 同上 |

**不动文件**：
- `web/src/routes/agent/_panel/workflow_.$id.edit.tsx`（路由结构不变）
- `web/src/pages/workflow/WorkflowEditor.tsx`（DAG 画布不动）
- `web/src/pages/workflow/nodes.tsx` / `edges.tsx`（ReactFlow 节点定义不动）
- `web/src/api/workflow-*.ts`（API 不动）

---

## Task 1: 新增 i18n keys

**Files:**
- Modify: `web/src/i18n/locales/zh/workflows.json`
- Modify: `web/src/i18n/locales/en/workflows.json`

- [ ] **Step 1: 在 zh/workflows.json 的 page 节新增 workflow_title / workflow_subtitle**

打开 `web/src/i18n/locales/zh/workflows.json`，在 `"page": {` 节下（紧跟 `"back_to_list"` 之前或之后）追加两个 key：

```json
"workflow_title": "智能体编排",
"workflow_subtitle": "管理 DAG 工作流、看板、运行历史与统计",
```

注意：`page.tab_workflows` 等已有 key 不要动。

- [ ] **Step 2: 在 zh/workflows.json 的 list 节新增 edit**

在同一文件的 `"list": {` 节下追加：

```json
"edit": "编辑",
```

- [ ] **Step 3: 在 en/workflows.json 同步新增对应英文**

打开 `web/src/i18n/locales/en/workflows.json`，在 `page` 节和 `list` 节分别追加：

```json
"workflow_title": "Workflow Orchestration",
"workflow_subtitle": "Manage DAG workflows, kanban, run history and stats",
```

```json
"edit": "Edit",
```

- [ ] **Step 4: 编译验证**

```bash
bun run build:web
```

Expected: build 通过，无 i18n 解析错误。

- [ ] **Step 5: Commit**

```bash
git add web/src/i18n/locales/zh/workflows.json web/src/i18n/locales/en/workflows.json
git commit -m "$(cat <<'EOF'
feat(i18n): 新增编排面板标题与编辑按钮翻译 key

为 workflow 面板布局统一改造做准备，新增 page.workflow_title /
page.workflow_subtitle / list.edit 中英文 key。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 2: 改造 WorkflowList 为 AgentCardList 卡片列表

**Files:**
- Modify: `web/src/pages/workflow/WorkflowList.tsx`

**目标**：把当前 grid 表格 + 原生 input/button 改造成 `AgentCardList` 卡片列表 + shadcn 组件。**移除内部标题栏和搜索栏**（将上提到 WorkflowTabPage）。**保留**：列表数据加载、搜索过滤、卡片渲染、删除确认、扫描恢复面板（暂保留，后续在 Task 3 上提）。

**注意**：本任务改造后，WorkflowList 的 props 会增加 `refreshKey`（Task 3 中由 WorkflowTabPage 传入），但本任务先不引入该 prop，保持现有 `useEffect` 触发加载。Task 3 会补上 `refreshKey` 监听。

- [ ] **Step 1: 修改 WorkflowList.tsx 的 imports**

打开 `web/src/pages/workflow/WorkflowList.tsx`，把顶部 imports 替换为：

```tsx
import { AlertTriangle, ChevronRight, Inbox, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";
import { AgentCardList } from "../agent-panel/shared/AgentCardList";
import { SkeletonTable } from "./components/SkeletonRows";
```

注意：
- 移除 `Plus`、`Search` 图标（不再需要）
- `Dialog` / `DialogContent` / `DialogFooter` / `DialogHeader` / `DialogTitle` 改为不导入（下面用 `FormDialog`，但 `FormDialog` 在 Task 3 引入；本任务先把 Dialog 留着不删，下面 Step 4 再换）
- 实际本任务还**不引入** `FormDialog`，沿用 `Dialog`，避免一次改太多。Task 3 再统一换为 FormDialog。

修正：本任务**只改卡片列表部分**，对话框保持原样不动。所以只需移除 `Plus`、`Search`，新增 `AgentCardList`、`Button`、`Input`、`Label`、`Textarea`、`Trash2` 的 import 即可（`Button` 已用于对话框，确认导入路径正确）。

**Imports 最终态**：

```tsx
import { AlertTriangle, ChevronRight, Inbox, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";
import { AgentCardList } from "../agent-panel/shared/AgentCardList";
import { SkeletonTable } from "./components/SkeletonRows";
```

- [ ] **Step 2: 替换主 return 内容（移除标题栏与搜索栏，列表改用 AgentCardList）**

把 `WorkflowList.tsx` 的 `return ( ... )` 部分（从 `<div className="h-full overflow-y-auto p-6">` 开始到对应 `</div>` 结束）替换为下面这段。**保留**创建对话框 `Dialog`、删除确认 `ConfirmDialog`，原样不动；**保留**扫描恢复面板（暂不迁移）。

新 return（替换主 `<div>` 内部除了 Dialog 与 ConfirmDialog 之外的全部内容）：

```tsx
return (
  <div className="flex flex-col flex-1 min-h-0">
    {/* 扫描恢复面板（功能性强，保留 warning 样式） */}
    {showRecoverPanel && (
      <div className="mb-4 p-3 border border-warning-border rounded-lg bg-warning-bg text-xs">
        <div className="font-semibold mb-2 text-warning-text">
          {t("list.recoverable_title", { count: recoverableIds.length })}
        </div>
        {recoverableIds.length === 0 ? (
          <p className="text-text-muted">{t("list.no_recoverable")}</p>
        ) : (
          <>
            {recoverableIds.map((id) => (
              <label key={id} className="flex items-center gap-1.5 mb-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedRecoverIds.has(id)}
                  onChange={(e) => {
                    setSelectedRecoverIds((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(id);
                      else next.delete(id);
                      return next;
                    });
                  }}
                />
                <span className="font-mono text-[11px]">{id}</span>
              </label>
            ))}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRecoverApply}
              disabled={recovering || selectedRecoverIds.size === 0}
            >
              {recovering ? t("list.recovering") : t("list.recover_selected", { count: selectedRecoverIds.size })}
            </Button>
          </>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setShowRecoverPanel(false)}
          className="mt-1 text-warning-text"
        >
          {t("list.close")}
        </Button>
      </div>
    )}

    {/* 内容区：AgentCardList 卡片列表（与 Tasks/Skills 完全一致） */}
    {loading ? (
      <SkeletonTable cols="2fr 100px 120px 80px" rows={4} />
    ) : error ? (
      <div className="text-center py-10">
        <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
        <p className="text-[13px] text-text-secondary">{t("list.load_failed", { error })}</p>
      </div>
    ) : (
      <AgentCardList
        items={filtered}
        cardKey={(wf) => wf.id}
        searchPlaceholder={t("list.search_placeholder")}
        searchFn={(wf, q) => wf.name.toLowerCase().includes(q)}
        emptyMessage={searchQuery ? t("list.no_match") : t("list.no_workflows")}
        renderCard={(wf) => (
          <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-bright">{wf.name}</span>
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                      wf.latestVersion
                        ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                        : "bg-surface-2 text-text-muted"
                    }`}
                  >
                    {wf.latestVersion ? `v${wf.latestVersion}` : t("list.not_published")}
                  </span>
                </div>
                {wf.description && (
                  <div className="text-xs text-text-muted mt-1 truncate">{wf.description}</div>
                )}
                <div className="flex items-center gap-3 mt-1.5 text-xs text-text-dim">
                  <span>
                    {t("list.table_modified")}: {relativeTime(wf.updatedAt)}
                  </span>
                </div>
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button size="xs" variant="outline" onClick={() => onEditWorkflow(wf.id)}>
                  {t("list.edit")}
                </Button>
                <Button size="xs" variant="outline" onClick={() => onViewVersions(wf.id)}>
                  {t("list.version_history")}
                </Button>
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => setDeleteTarget(wf)}
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </div>
          </div>
        )}
      />
    )}

    {workflows.length > 0 && (
      <div className="mt-3 text-[11px] text-text-muted text-center">
        {t("list.total_workflows", { count: workflows.length })}
      </div>
    )}

    {/* 创建对话框（本任务保留原 Dialog，Task 3 换 FormDialog） */}
    <Dialog
      open={showCreateDialog}
      onOpenChange={(open) => {
        setShowCreateDialog(open);
        if (!open) {
          setCreateName("");
          setCreateDesc("");
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("list.create_title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="wf-name">{t("list.name_label")}</Label>
            <Input
              id="wf-name"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder="my-workflow"
              className="mt-1"
            />
          </div>
          <div>
            <Label htmlFor="wf-desc">{t("list.desc_label")}</Label>
            <Textarea
              id="wf-desc"
              value={createDesc}
              onChange={(e) => setCreateDesc(e.target.value)}
              placeholder={t("list.desc_placeholder")}
              rows={2}
              className="mt-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setShowCreateDialog(false);
              setCreateName("");
              setCreateDesc("");
            }}
          >
            {t("list.cancel")}
          </Button>
          <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()}>
            {creating ? t("list.creating") : t("list.create_and_edit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <ConfirmDialog
      open={deleteTarget !== null}
      onOpenChange={(open) => {
        if (!open) setDeleteTarget(null);
      }}
      title={t("list.delete")}
      description={t("list.delete_confirm", { name: deleteTarget?.name ?? "" })}
      variant="destructive"
      onConfirm={handleDelete}
    />
  </div>
);
```

- [ ] **Step 3: 检查未使用变量**

改造后 `RefreshCw`、`Plus`、`Search` 图标在 WorkflowList 中不再使用（已在 imports 步骤移除）。`onCreateClick`、`onScanRecoverClick` 等不存在，不用管。

若 biome 报 `unused-vars`（例如 `Inbox` 在 emptyMessage 文本中不再使用），把对应 import 移除。实际检查：`Inbox` 在新代码中确实不再使用 → 移除 `Inbox` import。

修正 imports 最终态：

```tsx
import { AlertTriangle, RotateCcw, Trash2 } from "lucide-react";
```

（`Inbox` 已被 `AgentCardList` 的 emptyMessage 文本替代；`ChevronRight` 已被 `<Trash2>` 替换，也移除）

- [ ] **Step 4: 编译 + 类型检查**

```bash
bun run build:web
```

Expected: 通过。如出现 `unused-vars` 错误，按提示移除多余 import。

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/WorkflowList.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowList 改用 AgentCardList 卡片列表

- 自定义 grid 表格 → AgentCardList 卡片列表（与 Tasks/Skills 一致）
- 原生 input/button/textarea → shadcn Input/Button/Textarea
- 移除内部标题栏与搜索栏（将由 WorkflowTabPage 通过 AgentPageHeader 提供）
- 保留扫描恢复面板（功能性 warning 卡片）与创建/删除对话框

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 3: 改造 WorkflowTabPage（workflow.tsx）— 标准布局 + 内嵌子 tab

**Files:**
- Modify: `web/src/routes/agent/_panel/workflow.tsx`

**目标**：移除全宽 `h-9` tab 栏，套用 `bg-[#f4f7fb] px-8 py-7` + `AgentPageHeader` + 内嵌下划线子 tab；持有 `refreshKey` state + 创建/扫描恢复对话框。

由于把"扫描恢复"和"新建"按钮上提到 AgentPageHeader，但扫描恢复面板和创建对话框原本在 WorkflowList 内部——为保持改动可控，**本任务采用折中方案**：

- WorkflowTabPage 持有 `refreshKey` state + "刷新"按钮直接触发 `setRefreshKey`
- "扫描恢复"和"新建"按钮**保留在 WorkflowList 内部**（通过新增一个 `WorkflowList` 内部顶部的紧凑工具栏显示），不强行上提
- AgentPageHeader 的 actions 只放一个"刷新"按钮

**修正**：根据 spec § 1 refreshKey 模式，本应把"扫描恢复/新建"对话框上提到 WorkflowTabPage。但为避免本任务过大，**分两步**：
- 本任务：只把外层套标准布局 + AgentPageHeader（actions 暂留"刷新"按钮，触发 refreshKey）；WorkflowList 内部新增 `refreshKey` prop 监听
- Task 3 不迁移"扫描恢复/新建"对话框到 WorkflowTabPage（保持现状）——这些按钮暂时**只活在 WorkflowList 内部的工具栏**，作为新卡片列表上方的紧凑按钮行

**简化方案**（本任务采用）：WorkflowTabPage 不持有 refreshKey，**只做布局壳**。WorkflowList 内部保留所有原逻辑（包括内部按钮），只是新增 `refreshKey` 可选 prop（不传时不影响）。后续如需上提按钮，单独做。

- [ ] **Step 1: 完整替换 workflow.tsx 内容**

打开 `web/src/routes/agent/_panel/workflow.tsx`，整体替换为：

```tsx
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { BarChart3, History, KanbanSquare, Loader, Pencil } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AgentPageHeader } from "../../../pages/agent-panel/shared/AgentPageHeader";

const WorkflowList = lazy(() =>
  import("../../../pages/workflow/WorkflowList").then((m) => ({ default: m.WorkflowList })),
);
const WorkflowRuns = lazy(() =>
  import("../../../pages/workflow/WorkflowRuns").then((m) => ({ default: m.WorkflowRuns })),
);
const WorkflowKanban = lazy(() =>
  import("../../../pages/workflow/WorkflowKanban").then((m) => ({ default: m.WorkflowKanban })),
);
const WorkflowStats = lazy(() =>
  import("../../../pages/workflow/WorkflowStats").then((m) => ({ default: m.WorkflowStats })),
);

function WorkflowTabPage() {
  const { t } = useTranslation("workflows");
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab =
    search.tab === "kanban" ? "kanban" : search.tab === "runs" ? "runs" : search.tab === "stats" ? "stats" : "list";

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  const onViewVersions = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/versions",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  const onSelectRun = useCallback(
    (runId: string, workflowId?: string) => {
      if (workflowId) {
        void navigate({
          to: "/agent/workflow/$id/edit",
          params: { id: workflowId },
          search: { runId },
        });
      }
    },
    [navigate],
  );

  const tabs = [
    { id: "list" as const, label: t("page.tab_workflows"), icon: Pencil, search: {} },
    { id: "kanban" as const, label: t("page.tab_kanban"), icon: KanbanSquare, search: { tab: "kanban" } },
    { id: "runs" as const, label: t("page.tab_runs"), icon: History, search: { tab: "runs" } },
    { id: "stats" as const, label: t("page.tab_stats"), icon: BarChart3, search: { tab: "stats" } },
  ];

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d] dark:bg-[#1a1d23]">
      {/* AgentPageHeader：标题 + 副标题（无 actions，按钮留在 WorkflowList 内部） */}
      <AgentPageHeader title={t("page.workflow_title")} subtitle={t("page.workflow_subtitle")} />

      {/* 子 tab 栏：下划线式，嵌入页面内部 */}
      <div className="mb-4 flex items-center gap-1 border-b border-border-subtle">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              to="/agent/workflow"
              search={tab.search}
              className={`flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium border-b-2 transition-colors ${
                isActive
                  ? "text-brand border-brand"
                  : "text-text-secondary border-transparent hover:text-text-primary"
              }`}
            >
              <Icon size={13} />
              {tab.label}
            </Link>
          );
        })}
      </div>

      {/* tab 内容区 */}
      <div className="flex flex-1 flex-col min-h-0">
        {activeTab === "kanban" ? (
          <WorkflowKanban />
        ) : activeTab === "stats" ? (
          <WorkflowStats />
        ) : activeTab === "list" ? (
          <WorkflowList onEditWorkflow={onEditWorkflow} onViewVersions={onViewVersions} />
        ) : (
          <WorkflowRuns onSelectRun={onSelectRun} />
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowTabPage />
    </Suspense>
  ),
});
```

**关键变化**：
- 外层从 `<div className="flex flex-col flex-1 min-h-0">` + 全宽 `h-9 border-b bg-surface-base` tab 栏，改为 `bg-[#f4f7fb] px-8 py-7` 标准布局容器
- 加 `dark:bg-[#1a1d23]` 暗色模式兜底（spec § 7 边界 6）
- `AgentPageHeader` 提供标题与副标题，**暂不放 actions**（按钮留在 WorkflowList 内部，下个迭代再上提）
- 子 tab 栏从 `h-9` 全宽横条改为页面内嵌的下划线式 tab（`border-b-2 border-brand` 激活态），样式与原 tab 视觉一致

- [ ] **Step 2: 给 WorkflowList 恢复内部"扫描恢复/新建/刷新"按钮（Task 2 移除了）**

由于 Task 2 移除了 WorkflowList 内部的标题栏与按钮（认为会上提到 AgentPageHeader），但 Task 3 决定**不**上提，所以需要在 WorkflowList 内部**新增**一个紧凑工具栏（位于卡片列表上方）来承载这些按钮。

打开 `web/src/pages/workflow/WorkflowList.tsx`，在主 return 的 `{showRecoverPanel && ...}` 之前**插入**工具栏：

```tsx
{/* 紧凑工具栏：扫描恢复 + 刷新 + 新建（暂保留在 WorkflowList 内部） */}
<div className="mb-3 flex items-center justify-between gap-2">
  <div className="flex items-center gap-2">
    <Button variant="outline" size="sm" onClick={handleScanRecover}>
      <RotateCcw size={13} className="mr-1" /> {t("list.scan_recover")}
    </Button>
    <Button variant="outline" size="sm" onClick={loadList}>
      <RefreshCw size={13} className="mr-1" /> {t("list.refresh")}
    </Button>
  </div>
  <Button size="sm" onClick={() => setShowCreateDialog(true)}>
    <Plus size={14} className="mr-1" /> {t("list.create")}
  </Button>
</div>
```

并恢复 imports（在 Task 2 移除的 `Plus`、`RefreshCw`、`Search` 中，本任务需要恢复 `Plus`、`RefreshCw`）：

```tsx
import { Plus, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
```

注意 `Search` 不需要恢复（搜索框由 `AgentCardList` 内部提供）。

- [ ] **Step 3: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 4: 手动验证（在浏览器中）**

启动 `bun run dev:web`，访问 `/agent/workflow`：

- 显示 `AgentPageHeader`（标题"智能体编排" + 副标题"管理 DAG 工作流..."）
- 子 tab 栏在 AgentPageHeader 下方（下划线式）
- tab 切换正常（list / kanban / runs / stats）
- WorkflowList 显示紧凑工具栏（扫描恢复 + 刷新 + 新建）+ 卡片列表

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/agent/_panel/workflow.tsx web/src/pages/workflow/WorkflowList.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowTabPage 套用标准页面布局

- 移除全宽 h-9 tab 栏，套用 bg-[#f4f7fb] px-8 py-7 标准布局
- AgentPageHeader 提供标题与副标题
- 子 tab 改为页面内嵌的下划线式（border-b-2 border-brand 激活态）
- WorkflowList 内部新增紧凑工具栏（扫描恢复/刷新/新建）
- 暗色模式加 dark:bg-[#1a1d23] 兜底

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 4: 改造 WorkflowRuns — 移除内部容器/标题，卡片样式对齐

**Files:**
- Modify: `web/src/pages/workflow/WorkflowRuns.tsx`

**目标**：移除内部 `p-6` 容器与 `<h1>{runs.title}</h1>` 标题（已上提到 AgentPageHeader）；运行记录行从 grid 表格改为卡片样式；原生 `<input>` / `<button>` 改为 shadcn 组件。

- [ ] **Step 1: 调整 WorkflowRuns.tsx imports**

把顶部 imports 改为：

```tsx
import { AlertTriangle, ArrowRight, Inbox, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { type DAGStatus, type RunSummary, workflowEngineApi } from "../../api/workflow-engine";
```

变化：移除 `RefreshCw`（已上提到 WorkflowTabPage 的列表 tab 工具栏），新增 `Button`、`Input`；移除 `SkeletonTable`（用 Skeleton 替代或简单 loading 文字）。

实际检查：WorkflowRuns 的 refresh 按钮也要看是否保留——spec § 3 说"刷新按钮已上提"。但当前 WorkflowTabPage 的 list tab 才有刷新按钮（在 WorkflowList 内部），runs tab 没有刷新入口。**修正**：WorkflowRuns 内部仍保留刷新按钮（runs tab 没有外部触发），只是把它改为 shadcn `<Button>`。所以 imports 应保留 `RefreshCw`。

最终 imports：

```tsx
import { AlertTriangle, ArrowRight, Inbox, RefreshCw, Search, Square } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { type DAGStatus, type RunSummary, workflowEngineApi } from "../../api/workflow-engine";
```

移除 `SkeletonTable`（改用 Skeleton）。

- [ ] **Step 2: 替换 WorkflowRuns 主 return**

把 `return ( <div className="h-full overflow-y-auto p-6"> ... </div> )` 整段替换为：

```tsx
return (
  <div className="flex flex-col flex-1 min-h-0">
    {/* 顶部工具栏：刷新 + 搜索 + 状态筛选 */}
    <div className="mb-3 flex items-center justify-between gap-2">
      <div className="flex flex-1 items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={t("runs.search_placeholder")}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="flex gap-1">
          {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-md border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                statusFilter === s
                  ? "border-brand bg-brand-subtle text-brand"
                  : "border-border-subtle bg-surface-1 text-text-secondary hover:bg-surface-hover"
              }`}
            >
              {s === "all" ? t("runs.filter_all") : t(STATUS_LABEL_KEYS[s] ?? s)}
            </button>
          ))}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={loadRuns}>
        <RefreshCw size={13} className="mr-1" /> {t("runs.refresh")}
      </Button>
    </div>

    {/* 内容区 */}
    {loading ? (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
          <Skeleton key={i} className="h-16 w-full rounded-lg" />
        ))}
      </div>
    ) : error ? (
      <div className="text-center py-10">
        <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
        <p className="text-[13px] text-text-secondary">{t("runs.load_failed", { error })}</p>
      </div>
    ) : filtered.length === 0 ? (
      <div className="text-center py-10">
        {statusFilter !== "all" || searchQuery ? (
          <Search size={32} className="text-text-secondary mx-auto mb-2" />
        ) : (
          <Inbox size={32} className="text-text-secondary mx-auto mb-2" />
        )}
        <p className="text-[13px] text-text-secondary font-medium">
          {statusFilter !== "all" || searchQuery ? t("runs.no_match") : t("runs.no_runs")}
        </p>
        <p className="text-[11px] text-text-dim mt-1">
          {statusFilter !== "all" || searchQuery ? t("runs.no_runs_filter_hint") : t("runs.no_runs_hint")}
        </p>
      </div>
    ) : (
      <div className="space-y-2">
        {filtered.map((r) => (
          <div
            key={r.run_id}
            onClick={() => onSelectRun?.(r.run_id)}
            className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm cursor-pointer"
          >
            <div className="flex items-center gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-text-bright">{r.workflow_name}</span>
                  <StatusBadge status={r.status} />
                </div>
                <div className="flex items-center gap-3 mt-1.5 text-xs text-text-dim">
                  <span className="font-mono">{r.run_id.substring(0, 16)}...</span>
                  <span>
                    <span className="text-status-running">{r.node_summary.completed}</span>
                    <span className="text-text-muted">/{r.node_summary.total}</span>
                  </span>
                  <span>{relativeTime(r.started_at, t)}</span>
                  <span className="font-mono">{formatDuration(r.started_at, r.completed_at)}</span>
                </div>
              </div>
              <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                {r.status === "RUNNING" && (
                  <Button
                    size="xs"
                    variant="outline"
                    title={t("runs.cancel")}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleCancel(r.run_id);
                    }}
                  >
                    <Square size={12} className="text-status-error" />
                  </Button>
                )}
                <Button
                  size="xs"
                  variant="outline"
                  title={t("runs.view_details")}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectRun?.(r.run_id, r.workflow_id);
                  }}
                >
                  <ArrowRight size={12} />
                </Button>
              </div>
            </div>
          </div>
        ))}
      </div>
    )}

    {runs.length > 0 && (
      <div className="mt-3 text-[11px] text-text-muted text-center">
        {t("runs.total_records", { count: runs.length })}
      </div>
    )}
  </div>
);
```

**关键变化**：
- 外层从 `h-full overflow-y-auto p-6` 改为 `flex flex-col flex-1 min-h-0`
- 移除内部 `<h1>{runs.title}</h1>`
- 搜索框从原生 `<input>` 改为 `<Input>`（带 Search 图标）
- 状态筛选 chips 保留自定义（语义化状态色）
- 运行记录从 grid 表格行 → 卡片（与 WorkflowList 卡片视觉一致）
- 操作按钮从原生 `<button>` → `<Button size="xs">`，并加 `e.stopPropagation()` 防止冒泡触发卡片 onClick

- [ ] **Step 3: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 4: 手动验证**

启动 dev server，访问 `/agent/workflow?tab=runs`：

- 无内部 `<h1>` 标题（页面标题由 AgentPageHeader 提供）
- 搜索框 + 状态筛选 + 刷新按钮在顶部
- 运行记录是卡片样式（白色背景、圆角、border-light）
- hover 卡片显示操作按钮

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/workflow/WorkflowRuns.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowRuns 移除内部容器/标题，卡片样式对齐

- 移除 p-6 外壳与 h1 标题（已上提到 AgentPageHeader）
- 运行记录从 grid 表格行改为卡片样式
- 原生 input/button → shadcn Input/Button
- 操作按钮加 stopPropagation 防止冒泡触发卡片 onClick

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 5: 改造 WorkflowStats — 移除内部容器/标题，配色对齐

**Files:**
- Modify: `web/src/pages/workflow/WorkflowStats.tsx`

**目标**：移除内部 `p-6` 容器与 `<h2>{tab_stats}</h2>` 标题；MetricCard 配色从 `border-border-subtle bg-surface-base` 统一到 `border-border-light bg-surface-1`；图表卡片配色对齐；范围切换器（7d/30d/all）保留在内容区右上。

- [ ] **Step 1: 调整 WorkflowStats MetricCard 组件配色**

打开 `web/src/pages/workflow/WorkflowStats.tsx`，找到 `function MetricCard(...)` 函数，把 className 从：

```tsx
<div className="rounded-lg border border-border-subtle bg-surface-base p-4">
```

改为：

```tsx
<div className="rounded-lg border border-border-light bg-surface-1 px-4 py-3">
```

- [ ] **Step 2: 全局 className 替换（配色对齐）**

打开 `web/src/pages/workflow/WorkflowStats.tsx`，做以下精确替换。每处替换用编辑器的"查找替换"或 Edit 工具的 `replace_all` 选项。

**替换 1：MetricCard 容器**（在 `function MetricCard` 内）

```
旧：rounded-lg border border-border-subtle bg-surface-base p-4
新：rounded-lg border border-border-light bg-surface-1 px-4 py-3
```

**替换 2：图表卡片容器**（Run Trend / Token Consumption / Recent Failures 三处共用同一 className）

```
旧：rounded-lg border border-border-subtle bg-surface-base p-4
新：rounded-lg border border-border-light bg-surface-1 p-4
```

注意：替换 1 和替换 2 的旧字符串相同（`rounded-lg border border-border-subtle bg-surface-base p-4`），但替换后不同。所以**不能简单 replace_all**。执行顺序：
- 先用 Edit 工具定位 MetricCard 函数内的那一处（带 `function MetricCard` 上下文），单独替换为 `px-4 py-3` 版本
- 再 replace_all 把剩余的图表卡片（三处）替换为 `p-4` 版本

**替换 3：失败运行子项**（Recent Failures 内的 `<div>`）

```
旧：flex items-center gap-3 rounded-md border border-border-subtle px-3 py-2
新：flex items-center gap-3 rounded-md border border-border-light bg-surface-1 px-3 py-2
```

**替换 4：外层容器**

```
旧：<div className="flex flex-col gap-6 p-6 overflow-y-auto flex-1">
新：<div className="flex flex-col gap-4 flex-1 min-h-0">
```

（移除 `p-6` 内边距，外层布局容器由路由提供；`gap-6` 改 `gap-4` 与其他页面统一）

- [ ] **Step 3: 移除内部 h2 标题**

定位到 WorkflowStats 主 return 顶部的：

```tsx
<div className="flex items-center justify-between">
  <h2 className="text-lg font-semibold text-text-primary">{t("page.tab_stats")}</h2>
  <div className="flex items-center gap-1 rounded-lg border border-border-subtle p-0.5">
    {/* 范围切换器 */}
  </div>
</div>
```

整段替换为（仅保留范围切换器在右上）：

```tsx
<div className="flex items-center justify-end">
  <div className="flex items-center gap-1 rounded-lg border border-border-subtle p-0.5">
    {/* 范围切换器，原样保留 */}
  </div>
</div>
```

- [ ] **Step 4: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 5: 手动验证**

访问 `/agent/workflow?tab=stats`：

- 无内部 `<h2>` 标题
- 范围切换器在右上
- MetricCard 配色与 WorkflowList 卡片一致
- 图表卡片配色对齐

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/workflow/WorkflowStats.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowStats 移除内部容器/标题，配色对齐

- 移除 p-6 外壳与 h2 标题（已上提到 AgentPageHeader）
- MetricCard 与图表卡片配色统一到 border-border-light bg-surface-1
- 范围切换器保留在内容区右上
- 失败运行子项配色对齐

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 6: 改造 WorkflowKanban — 保留特化布局，配色对齐 + shadcn 组件

**Files:**
- Modify: `web/src/pages/workflow/WorkflowKanban.tsx`
- Modify: `web/src/pages/workflow/components/KanbanCard.tsx`
- Modify: `web/src/pages/workflow/components/KanbanColumn.tsx`

**目标**：Kanban 是横向多列看板，**不套用 AgentCardList**，只做配色对齐 + 原生组件迁移到 shadcn。

- [ ] **Step 1: Kanban 顶部工具栏原生 button → shadcn Button**

打开 `web/src/pages/workflow/WorkflowKanban.tsx`，在 imports 增加：

```tsx
import { Button } from "@/components/ui/button";
```

定位到顶部工具栏（约 102 行附近的 `<div className="flex items-center justify-between px-3 py-1 border-b border-border-subtle bg-surface-1 flex-shrink-0">`），把内部两个 `<button>` 替换为 `<Button>`：

```tsx
<div className="flex items-center justify-between px-3 py-1 border-b border-border-subtle bg-surface-1 flex-shrink-0">
  <div className="flex items-center gap-1.5">
    <BoardSelector
      currentUserId={currentUserId}
      selectedBoardId={boardId}
      onSelect={setBoardId}
      onBoardsChange={loadJobs}
    />
    <Button
      type="button"
      size="sm"
      onClick={() => {
        setEditJob(null);
        setDialogOpen(true);
      }}
      disabled={!boardId}
      className="h-6 px-2 text-[10px]"
    >
      <Plus size={13} className="mr-0.5" />
      {t("dialog_create_title")}
    </Button>
  </div>
  <Button
    type="button"
    variant="ghost"
    size="sm"
    onClick={loadJobs}
    className="h-6 px-2 text-[10px] text-text-secondary"
  >
    <RefreshCw size={12} className="mr-0.5" />
    {t("refresh")}
  </Button>
</div>
```

- [ ] **Step 2: KanbanColumn 配色对齐**

打开 `web/src/pages/workflow/components/KanbanColumn.tsx`，做以下精确替换：

**替换 1：列头分隔线**

```
旧：<div className="flex items-center justify-between px-3 py-1.5 border-b border-border-subtle flex-shrink-0">
新：<div className="flex items-center justify-between px-3 py-1.5 border-b border-border-light flex-shrink-0">
```

注意：列容器的 `border-r border-border-subtle last:border-r-0` **保留不动**（这是列与列之间的分隔线，看板布局需要）。

- [ ] **Step 3: KanbanCard 配色对齐**

打开 `web/src/pages/workflow/components/KanbanCard.tsx`，做以下精确替换：

**替换 1：卡片容器边框与背景**

```
旧：className={`group border border-border-subtle border-l-[3px] bg-surface-elevated transition-colors hover:border-border ${accent}`}
新：className={`group border border-border-light border-l-[3px] bg-surface-1 transition-colors hover:border-border-active ${accent}`}
```

注意：
- `bg-surface-elevated` → `bg-surface-1`（与其他卡片统一）
- `hover:border-border` → `hover:border-border-active`（与 WorkflowList 卡片 hover 一致）

**替换 2：primary action bar 分隔线**

```
旧：className="w-full flex items-center justify-center gap-1 py-0.5 text-[10px] font-medium border-t border-border-subtle text-text-secondary hover:text-brand hover:bg-brand-subtle transition-colors disabled:opacity-50"
新：className="w-full flex items-center justify-center gap-1 py-0.5 text-[10px] font-medium border-t border-border-light text-text-secondary hover:text-brand hover:bg-brand-subtle transition-colors disabled:opacity-50"
```

卡片内部的图标按钮（View logs / Edit params / Delete）保留原样式不动，因为它们的 `p-0.5 text-text-dim hover:text-brand` 已经是 design tokens 风格。

- [ ] **Step 4: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 5: 手动验证**

访问 `/agent/workflow?tab=kanban`：

- 看板布局保留（横向多列）
- 列、卡片配色与 WorkflowList 卡片一致
- 顶部工具栏按钮是 shadcn `<Button>` 风格
- 看板选择、新建任务、刷新功能正常

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/workflow/WorkflowKanban.tsx web/src/pages/workflow/components/KanbanColumn.tsx web/src/pages/workflow/components/KanbanCard.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowKanban 保留特化布局，配色对齐

- 顶部工具栏原生 button → shadcn Button
- KanbanColumn / KanbanCard 配色统一到 border-border-light bg-surface-1
- 保留横向多列看板布局（不套用 AgentCardList）

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 7: WorkflowBreadcrumb 配色美化

**Files:**
- Modify: `web/src/pages/workflow/WorkflowBreadcrumb.tsx`

**目标**：保留 `h-9 border-b` 横条形式（WorkflowEditor 全屏 DAG 需要空间），仅配色对齐。

- [ ] **Step 1: 调整 WorkflowBreadcrumb 配色**

打开 `web/src/pages/workflow/WorkflowBreadcrumb.tsx`，定位到 `<div className="flex items-center gap-2 px-4 h-9 border-b border-border-subtle bg-surface-base flex-shrink-0">`。

把 className 中的 `bg-surface-base` 改为 `bg-[#f4f7fb] dark:bg-[#1a1d23]`（与 WorkflowTabPage 背景一致，让 breadcrumb 与下方 DAG 画布有视觉区分）：

```tsx
<div className="flex items-center gap-2 px-4 h-9 border-b border-border-subtle bg-[#f4f7fb] dark:bg-[#1a1d23] flex-shrink-0">
```

其余（Link 样式、breadcrumb 文字）保持不变。

- [ ] **Step 2: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 3: 手动验证**

访问任意 workflow 的 edit 页 `/agent/workflow/$id/edit`：

- breadcrumb 横条配色与编排页面背景一致（浅蓝灰）
- 返回链接 + 工作流名称 + 编辑入口显示正常
- DAG 画布仍占满剩余空间

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/workflow/WorkflowBreadcrumb.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowBreadcrumb 配色对齐编排页面

breadcrumb 横条配色从 bg-surface-base 改为 bg-[#f4f7fb] dark:bg-[#1a1d23]，
与 WorkflowTabPage 背景统一。保留 h-9 border-b 横条形式（DAG 全屏需要）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 8: 改造 WorkflowVersions — 套用标准布局 + 卡片列表

**Files:**
- Modify: `web/src/routes/agent/_panel/workflow_.$id.versions.tsx`
- Modify: `web/src/pages/workflow/WorkflowVersions.tsx`

**目标**：路由层提供标准页面布局容器；组件层移除内部容器/标题，套 `AgentPageHeader`（标题=工作流名称），版本列表改用卡片样式。

- [ ] **Step 1: 路由层套标准页面布局**

打开 `web/src/routes/agent/_panel/workflow_.$id.versions.tsx`，把 `WorkflowVersionsPage` 函数体替换为：

```tsx
function WorkflowVersionsPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const { t } = useTranslation("workflows");

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({
        to: "/agent/workflow/$id/edit",
        params: { id: workflowId },
      });
    },
    [navigate],
  );

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d] dark:bg-[#1a1d23]">
      <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
    </div>
  );
}
```

确保 imports 包含 `useCallback`（已在原文件中）；`Pencil` 图标在原文件中导入但本替换后未使用，移除 `Pencil` import 和原 `<Link>` 编辑入口（已移到 WorkflowVersions 内部的 AgentPageHeader）。

最终路由文件 imports：

```tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { WorkflowVersions } from "../../../pages/workflow/WorkflowVersions";
```

（移除 `Link`、`Pencil`、`WorkflowBreadcrumb`）

- [ ] **Step 2: WorkflowVersions 移除内部容器/标题，套 AgentPageHeader**

打开 `web/src/pages/workflow/WorkflowVersions.tsx`，调整 imports：

```tsx
import { AlertTriangle, Clock, Inbox, RefreshCw, RotateCcw, Star } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AgentPageHeader } from "../agent-panel/shared/AgentPageHeader";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";
import { type WorkflowDefItem, type WorkflowVersionItem, workflowDefApi } from "../../api/workflow-defs";
import { Skeleton } from "@/components/ui/skeleton";
import { SkeletonVersionRows } from "./components/SkeletonRows";
```

- [ ] **Step 3: 替换 WorkflowVersions 主 return**

把 `return ( <div className="h-full overflow-y-auto p-6"> ... </div> )` 整段替换为：

```tsx
if (loading && !wf) {
  return (
    <div>
      <AgentPageHeader title={t("versions.loading")} />
      <SkeletonVersionRows rows={3} />
    </div>
  );
}

return (
  <div>
    <AgentPageHeader
      title={wf?.name ?? t("versions.title", { name: "" })}
      subtitle={wf?.description}
      actions={
        <>
          <Button variant="outline" size="sm" onClick={loadData}>
            <RefreshCw size={13} className="mr-1" /> {t("versions.refresh")}
          </Button>
          <Link
            to="/agent/workflow/$id/edit"
            params={{ id: workflowId }}
            className="inline-flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
          >
            {t("page.breadcrumb_edit")}
          </Link>
        </>
      }
    />

    {/* 当前状态 */}
    {wf && (
      <div className="mb-3 flex gap-4 rounded-lg border border-border-light bg-surface-1 px-4 py-2.5 text-xs text-text-secondary">
        <span>
          {t("versions.latest_label", {
            value: wf.latestVersion ? `v${wf.latestVersion}` : t("versions.latest_not_set"),
          })}
        </span>
        <span>{t("versions.published_count", { count: versions.length })}</span>
      </div>
    )}

    {/* 内容 */}
    {loading ? (
      <SkeletonVersionRows rows={3} />
    ) : error ? (
      <div className="text-center py-10">
        <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
        <p className="text-[13px] text-text-secondary">{t("versions.load_failed", { error })}</p>
      </div>
    ) : versions.length === 0 ? (
      <div className="text-center py-10">
        <Inbox size={32} className="text-text-muted mx-auto mb-2" />
        <p className="text-[13px] text-text-muted font-medium">{t("versions.no_versions")}</p>
        <p className="text-[11px] text-text-dim mt-1">{t("versions.no_versions_hint")}</p>
      </div>
    ) : (
      <div className="space-y-2">
        {versions.map((v) => {
          const isLatest = wf?.latestVersion === v.version;
          const isViewing = viewingVersion === v.version;

          return (
            <div
              key={v.id}
              className="rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm"
            >
              <div
                className="flex items-center gap-3 text-xs cursor-pointer"
                onClick={() => handleViewYaml(v.version)}
              >
                <div className="font-mono font-semibold text-text-primary min-w-[40px]">v{v.version}</div>
                {isLatest && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-status-running bg-surface-2 px-1.5 py-px rounded-full">
                    <Star size={10} /> {t("versions.latest")}
                  </span>
                )}
                <span className="text-text-muted text-[11px]">
                  <Clock size={10} className="mr-0.5 align-[-1px]" />
                  {relativeTime(v.createdAt)}
                </span>
                <div className="ml-auto flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                  {!isLatest && (
                    <Button
                      size="xs"
                      variant="outline"
                      title={t("versions.set_latest")}
                      onClick={() => setConfirmAction({ type: "setLatest", version: v.version })}
                    >
                      <Star size={10} className="mr-0.5" /> {t("versions.set_latest")}
                    </Button>
                  )}
                  <Button
                    size="xs"
                    variant="outline"
                    title={t("versions.restore_to_draft")}
                    onClick={() => setConfirmAction({ type: "restore", version: v.version })}
                  >
                    <RotateCcw size={10} className="mr-0.5" /> {t("versions.restore_to_draft")}
                  </Button>
                </div>
              </div>

              {isViewing && viewingYaml !== null && (
                <div className="mt-2">
                  <pre className="bg-surface-2 border border-border-light rounded-md p-2.5 text-[11px] font-mono text-text-secondary max-h-[300px] overflow-auto m-0 whitespace-pre-wrap">
                    {viewingYaml}
                  </pre>
                </div>
              )}
            </div>
          );
        })}
      </div>
    )}

    <ConfirmDialog
      open={confirmAction !== null}
      onOpenChange={(open) => {
        if (!open) setConfirmAction(null);
      }}
      title={confirmAction?.type === "setLatest" ? t("versions.set_latest") : t("versions.restore_to_draft")}
      description={
        confirmAction?.type === "setLatest"
          ? t("versions.set_latest_confirm", { version: confirmAction?.version ?? 0 })
          : t("versions.restore_confirm", { version: confirmAction?.version ?? 0 })
      }
      variant={confirmAction?.type === "restore" ? "destructive" : "default"}
      onConfirm={() => {
        if (confirmAction?.type === "setLatest") handleSetLatest(confirmAction.version);
        else if (confirmAction?.type === "restore") handleRestoreToDraft(confirmAction.version);
      }}
    />
  </div>
);
```

**关键变化**：
- 外层从 `h-full overflow-y-auto p-6` 改为简单 `<div>`（外层布局容器由路由文件提供）
- 移除内部 `<h1>` 小标题和刷新按钮
- 加 `AgentPageHeader`（标题=工作流名称，副标题=描述，actions=刷新按钮 + 编辑入口链接）
- 当前状态条配色从 `bg-surface-2 border-subtle` 改为 `bg-surface-1 border-light`
- 版本列表从自定义带表格行的 grid → 卡片列表（与 WorkflowList 卡片视觉一致）
- 操作按钮从原生 `<button>` → `<Button size="xs">`

**注意**：`versions.loading` i18n key 可能不存在，需在 Task 9 添加，或改用现有的 key（如 `versions.refresh`）作为兜底。先用 `t("versions.refresh")` 作为 loading 占位文案。

修正：把 loading 占位的 `t("versions.loading")` 改为 `t("versions.refresh")` 避免新增 key。或更简单地，loading 时返回 `null`：

```tsx
if (loading && !wf) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 3 }).map((_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: static skeleton placeholders
        <Skeleton key={i} className="h-16 w-full rounded-lg" />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 5: 手动验证**

访问 `/agent/workflow/$id/versions`：

- 显示 AgentPageHeader（标题=工作流名称 + 描述副标题 + 刷新按钮 + 编辑入口）
- 当前状态条配色对齐
- 版本列表是卡片样式
- 操作按钮（设为最新、恢复草稿）显示正常
- 点击版本卡片展开 YAML 正常

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/agent/_panel/workflow_.$id.versions.tsx web/src/pages/workflow/WorkflowVersions.tsx
git commit -m "$(cat <<'EOF'
refactor(workflow): WorkflowVersions 套用标准页面布局

- 路由层提供 bg-[#f4f7fb] px-8 py-7 标准布局容器
- WorkflowVersions 移除内部 h-full p-6 容器与 h1 标题
- 套用 AgentPageHeader（标题=工作流名称 + 副标题=描述 + actions=刷新/编辑）
- 版本列表从 grid 表格行改为卡片样式
- 操作按钮 → shadcn Button

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

---

## Task 9: 清理悬空 i18n keys

**Files:**
- Modify: `web/src/i18n/locales/zh/workflows.json`
- Modify: `web/src/i18n/locales/en/workflows.json`

**目标**：grep 所有 workflows.json 的 key，对确认无引用的悬空 key 显式删除。

- [ ] **Step 1: 排查可能的悬空 key**

```bash
# 检查哪些 key 在改造后已无引用（重点关注被移除的内部标题）
grep -r "runs\.title" web/src/ 2>/dev/null
grep -r "page\.tab_stats" web/src/ 2>/dev/null
grep -r "versions\.title" web/src/ 2>/dev/null
```

预期：
- `runs.title` — WorkflowRuns 改造后不再使用 → 悬空
- `page.tab_stats` — 仍被 WorkflowTabPage 的 tabs 数组使用（`t("page.tab_stats")`） → **保留**
- `versions.title` — 仍在 WorkflowVersions 中作为兜底使用（`t("versions.title", { name: "" })`） → **保留**

- [ ] **Step 2: 删除确认悬空的 key**

仅删除确认无引用的 key。例如若 `runs.title` 确认悬空，从 zh/en workflows.json 的 `runs` 节移除 `"title": "..."` 行。

**实际执行时**：以 grep 结果为准。若某个 key 仍有引用（例如作为兜底），保留。

- [ ] **Step 3: 编译验证**

```bash
bun run build:web
```

Expected: 通过。

- [ ] **Step 4: Commit（仅当确有删除时）**

```bash
git add web/src/i18n/locales/zh/workflows.json web/src/i18n/locales/en/workflows.json
git commit -m "$(cat <<'EOF'
chore(i18n): 清理 workflow 改造后悬空的翻译 key

移除改造后无引用的 key（具体见 diff）。

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

若 Step 1 grep 显示无悬空 key，跳过本任务，直接进入 Task 10。

---

## Task 10: 完整手动验证 + precheck

**Files:**
- 无修改，仅验证

**目标**：按 spec § 7 手动验证清单逐项检查，最后跑 `bun run precheck`。

- [ ] **Step 1: 启动 dev server 做完整手动验证**

```bash
bun run dev:web
```

按以下清单逐项验证（来自 spec § 7）：

1. **`/agent/workflow` 主页面**：
   - 显示 AgentPageHeader（标题"智能体编排" + 副标题"管理 DAG 工作流、看板、运行历史与统计"）
   - 子 tab 栏在 AgentPageHeader 下方（下划线式：激活态 `border-b-2 border-brand`）
   - tab 切换正常（list / kanban / runs / stats）

2. **list tab**：
   - WorkflowList 显示紧凑工具栏（扫描恢复 / 刷新 / 新建）+ AgentCardList 卡片列表
   - 卡片样式与 `/agent/tasks` 视觉一致（圆角、border-light、hover 阴影）
   - 卡片 hover 显示操作按钮（编辑 / 版本 / 删除）
   - 新建对话框打开正常，字段（名称 + 描述）正确
   - 删除确认对话框正常
   - 扫描恢复面板展开正常

3. **runs tab**：
   - 无内部 `<h1>` 标题
   - 搜索框 + 状态筛选 + 刷新按钮在顶部
   - 运行记录卡片样式
   - hover 显示操作按钮（取消 / 查看详情）
   - 状态徽章颜色正确

4. **stats tab**：
   - 无内部 `<h2>` 标题
   - 范围切换器在右上
   - MetricCard 配色对齐
   - 图表卡片配色对齐

5. **kanban tab**：
   - 看板布局保留（横向多列）
   - 顶部工具栏按钮是 shadcn Button
   - 列、卡片配色对齐
   - 看板选择、新建任务、刷新功能正常

6. **`/agent/workflow/$id/edit`**：
   - breadcrumb 横条配色对齐（浅蓝灰）
   - DAG 画布仍占满剩余空间（无 AgentPageHeader 损失垂直空间）
   - 返回编排链接正常

7. **`/agent/workflow/$id/versions`**：
   - AgentPageHeader（标题=工作流名称 + 描述副标题 + actions=刷新 + 编辑入口）
   - 当前状态条配色对齐
   - 版本列表是卡片样式
   - 设为最新、恢复草稿、查看 YAML 功能正常

8. **i18n 中英文切换**：
   - 切换到英文，所有新增 key（`workflow_title` / `workflow_subtitle` / `list.edit`）显示正确

9. **暗色模式**：
   - 切换暗色模式，`bg-[#f4f7fb]` 兜底为 `bg-[#1a1d23]`
   - 所有卡片、文字、边框正常显示

- [ ] **Step 2: 关闭 dev server，运行 precheck**

```bash
bun run precheck
```

Expected: 通过（格式化 + import 排序 + tsc + biome check）。

若 precheck 报错：
- 格式/import 排序错误：precheck 会自动修复，再次运行确认通过
- tsc 错误：按错误信息修正类型
- biome 错误：按错误信息修正

- [ ] **Step 3: 若 precheck 修复了任何文件，提交修复**

```bash
git status --short
```

若有 modified 文件：

```bash
git add -u
git commit -m "$(cat <<'EOF'
chore(workflow): precheck 修复格式与 import 排序

Co-Authored-By: glm-5.2 <zai-org@claude-code-best.win>
EOF
)"
```

- [ ] **Step 4: 完成确认**

所有任务完成。最终 git log 应包含 9 个提交（Task 1-8 + 可能的 Task 9 + 可能的 precheck 修复）。

```bash
git log --oneline -12
```

Expected: 看到 workflow panel layout unification 相关的提交链。

---

## Self-Review

### Spec 覆盖度检查

| Spec 章节 | 对应任务 |
|---|---|
| § 1 主页面结构调整 | Task 3 |
| § 2 WorkflowList 改用 AgentCardList | Task 2 |
| § 3 WorkflowRuns 处理 | Task 4 |
| § 3 WorkflowStats 处理 | Task 5 |
| § 3 WorkflowKanban 处理 | Task 6 |
| § 4 WorkflowEditor（保持全屏） | 不需改造，Task 7 仅美化 breadcrumb |
| § 4 WorkflowVersions | Task 8 |
| § 5 i18n 处理 | Task 1（新增）+ Task 9（清理） |
| § 6 shadcn 组件迁移清单 | 散布在 Task 2/3/4/6/8 |
| § 7 测试与验证 | Task 10 |
| 边界 1（Kanban border-b） | Task 6 保留 |
| 边界 2（Stats 范围切换器） | Task 5 保留在右上 |
| 边界 3（refreshKey） | Task 3 简化方案（不引入 refreshKey，按钮留在 WorkflowList） |
| 边界 4（创建对话框字段） | Task 2 保留 |
| 边界 5（响应式） | Task 2 自动获得 |
| 边界 6（暗色模式 bg-[#f4f7fb]） | Task 3 / Task 8 加 dark:bg-[#1a1d23] |
| 边界 7（悬空 i18n） | Task 9 |

**Spec § 1 的 refreshKey 模式未严格实施**：Task 3 采用简化方案——不引入 `refreshKey`，按钮留在 WorkflowList 内部紧凑工具栏。这是为了控制 Task 3 的范围。**如果后续需要把按钮上提到 AgentPageHeader，应作为独立的后续任务**。这是 plan 与 spec 的偏差，需在执行时与用户确认。

### 类型一致性检查

- `WorkflowList` props：`onEditWorkflow`, `onViewVersions`（未新增 `refreshKey`）
- `WorkflowRuns` props：`onSelectRun`（不变）
- `WorkflowVersions` props：`workflowId`, `onEditWorkflow`（不变）
- 所有 shadcn 组件按现有 API 使用

### Placeholder 扫描

- 所有代码块均含具体代码，无 "TODO"/"TBD"
- Task 6 的"具体改动按文件实际内容定"是因为 KanbanColumn / KanbanCard 的当前代码未在 plan 中展开——执行时需要先 Read 文件再改。这是合理的，因为这两个文件的精确改动取决于现有代码结构，执行者需先查看再决策。
- Task 9 的悬空 key 清理依赖 grep 结果——这是动态的，执行时根据实际结果操作。
