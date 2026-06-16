# 智能体编排面板布局统一设计

**日期**：2026-06-16
**作者**：KonghaYao（brainstorming session）
**状态**：待实现

## 背景与动机

Agent 面板下的所有标准页面（Tasks / Skills / MCP / Knowledge / Dashboard 等）都遵循统一布局：

- 容器：`min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]`
- 标题：通过 `<AgentPageHeader>` 渲染（22px 深色标题 + 12px 灰副标题 + 分隔线 + 操作按钮区）
- 内容：标准卡片样式（`rounded-lg border border-border-light bg-surface-1 px-4 py-3`）+ shadcn 组件（`<Button>`、`<Input>`、`<FormDialog>` 等）+ `AgentCardList` 卡片列表

唯独 `/agent/workflow`（智能体编排）面板是另一套样式：

- 容器：`flex flex-col flex-1 min-h-0` + `h-9 border-b bg-surface-base` 全宽 tab 栏占顶部
- 子组件外壳：`h-full overflow-y-auto p-6` + 内部 `text-base font-semibold` 小标题
- 组件实现：大量原生 `<input>` / `<button>` / `<textarea>`，自定义 grid 表格，自定义 `Dialog`

这种不一致导致：

1. 用户在不同 Agent 页面之间切换时视觉断层明显
2. 维护者需要记忆两套样式心智模型
3. 暗色模式、design tokens 的应用不一致

## 目标

让 `/agent/workflow` 编排面板的视觉与交互对齐其他标准 Agent 页面，同时保留 Workflow 多模式切换（列表 / 看板 / 运行 / 统计）的核心交互。

## 非目标

- 不重构 workflow-defs / workflow-run API
- 不改动 DAG 画布的 ReactFlow 实现
- 不调整路由结构（`workflow.tsx` / `workflow_.$id.edit.tsx` / `workflow_.$id.versions.tsx` 路径不变）
- 不重写状态管理逻辑（保留 useState / useEffect 模式）
- 不新增单元测试（改造是纯视觉对齐，无业务逻辑变更）

## 设计原则

| 原则 | 说明 |
|---|---|
| **功能优先** | DAG 画布、看板等多空间需求的子页面保留特化布局 |
| **复用优先** | 列表、版本等同构页面直接复用 `AgentCardList`、`AgentPageHeader` |
| **下划线 tab 保留** | 子 tab 视觉沿用当前下划线式，仅改变位置（从顶部全宽 → 页面内部嵌入） |
| **shadcn 统一** | 原生 `<input>` / `<button>` / `<textarea>` 一律迁移到 shadcn |
| **design tokens** | 配色全部用 tokens（`bg-surface-1`、`border-border-light` 等），暗色模式自动适配 |

## 改造范围总览

| 子页面 / 组件 | 当前结构 | 目标结构 |
|---|---|---|
| `/agent/workflow`（WorkflowTabPage） | 全宽 `h-9` tab 栏占顶部 + tab 内容 | `bg-[#f4f7fb] px-8 py-7` + `AgentPageHeader` + 内嵌下划线子 tab + 内容 |
| WorkflowList | 自定义 grid 表格 + 原生 input/button | `AgentCardList` 卡片列表 + shadcn 组件 |
| WorkflowRuns | 内部 `p-6` + 小标题 + 原生 input | 移除内部容器/标题，卡片样式对齐 |
| WorkflowStats | 内部 `p-6` + 小标题 + MetricCard | 移除内部容器/标题，MetricCard 与图表卡片样式对齐 |
| WorkflowKanban | 看板布局 + 顶部工具栏 | **保留特化布局**，仅组件迁移到 shadcn + 卡片配色对齐 |
| `/agent/workflow/$id/edit`（WorkflowEditor） | breadcrumb + 全屏 DAG 画布 | **保留特化布局**，仅 breadcrumb 配色美化 |
| `/agent/workflow/$id/versions`（WorkflowVersions） | 内部 `p-6` + 小标题 + breadcrumb | `AgentPageHeader`（标题=工作流名称）+ 卡片列表 |

## 详细设计

### § 1. 主页面 `/agent/workflow`（WorkflowTabPage）

**当前结构**：

```tsx
<div className="flex flex-col flex-1 min-h-0">
  <div className="flex items-center px-6 h-9 border-b border-border-subtle bg-surface-base flex-shrink-0">
    {/* 全宽 tab 栏占顶部 */}
    {tabs.map(tab => <Link>...</Link>)}
  </div>
  <div className="flex-1 min-h-0 overflow-hidden">
    {activeTab === "kanban" ? <WorkflowKanban /> : ...}
  </div>
</div>
```

**新结构**：

```tsx
<div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
  <AgentPageHeader
    title={t("page.workflow_title")}
    subtitle={t("page.workflow_subtitle")}
    actions={
      <>
        <Button variant="outline" size="sm" onClick={handleScanRecover}>
          <RotateCcw size={13} /> {t("list.scan_recover")}
        </Button>
        <Button variant="outline" size="sm" onClick={handleRefresh}>
          <RefreshCw size={13} /> {t("list.refresh")}
        </Button>
        <Button size="sm" onClick={handleCreate}>
          <Plus size={14} /> {t("list.create")}
        </Button>
      </>
    }
  />

  {/* 子 tab 栏：下划线式，嵌入页面内部 */}
  <div className="flex items-center gap-1 border-b border-border-subtle mb-4 -mt-1">
    {tabs.map(tab => {
      const isActive = activeTab === tab.id;
      const Icon = tab.icon;
      return (
        <Link
          key={tab.id}
          to="/agent/workflow"
          search={tab.id === "list" ? {} : { tab: tab.id }}
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
  <div className="flex-1 min-h-0">
    {activeTab === "kanban" ? (
      <WorkflowKanban />
    ) : activeTab === "stats" ? (
      <WorkflowStats />
    ) : activeTab === "list" ? (
      <WorkflowList
        onEditWorkflow={onEditWorkflow}
        onViewVersions={onViewVersions}
        refreshKey={refreshKey}
      />
    ) : (
      <WorkflowRuns onSelectRun={onSelectRun} />
    )}
  </div>

  {/* 创建对话框、扫描恢复面板由 WorkflowTabPage 持有，提交成功后 setRefreshKey 触发 WorkflowList 刷新 */}
  <FormDialog open={createDialogOpen} ... />
  {recoverPanelOpen && <RecoverPanel ... />}
</div>
```

**关键变化**：

- 顶部全宽 `h-9` tab 栏 → 嵌入页面内部的子 tab（位于 AgentPageHeader 下方）
- 子 tab 保留**下划线式视觉**（`border-b-2 border-brand` 激活态），只是位置改变
- "扫描恢复 / 刷新 / 新建"按钮上提到 AgentPageHeader 的 actions 区
- 整体背景改为 `bg-[#f4f7fb]`，内边距 `px-8 py-7`
- WorkflowList 不再自己渲染标题和操作按钮（这些上提到 AgentPageHeader）

**数据加载与 actions 按钮的归属（refreshKey 模式）**：

actions 按钮（刷新 / 新建 / 扫描恢复）位于 AgentPageHeader（WorkflowTabPage 持有），操作的实际对象主要是 WorkflowList 内部数据。采用「refreshKey 触发重新加载」模式：

- WorkflowTabPage 持有 `refreshKey` state（number）
- `refreshKey` 作为 prop 传给 WorkflowList，WorkflowList 在 `useEffect` 中监听 `refreshKey` 变化触发自身刷新
- "新建"和"扫描恢复"对话框的 state（`createDialogOpen` / `recoverPanelOpen`）由 WorkflowTabPage 持有——按钮在 AgentPageHeader，对话框 state 与按钮就近。对话框提交成功后调用 workflowDefApi，再 `setRefreshKey(k => k + 1)` 触发 WorkflowList 刷新
- WorkflowList 内部仍保留：列表数据加载、搜索过滤、卡片渲染、删除确认（删除是卡片级别的操作，留在 WorkflowList 合理）
- runs / stats / kanban 等其他 tab 保持自治（自己加载数据），actions 中的"刷新"只触发当前激活 tab 的 refreshKey（通过判断 activeTab 决定传给哪个子组件，list 传 refreshKey 给 WorkflowList，其他 tab 各自内部监听同名 prop 或不用）

**为什么不用受控组件模式**：runs / stats / kanban 的数据结构与 list 差异大，全部上提到 WorkflowTabPage 会让页面组件臃肿；refreshKey 是最小侵入式方案，每个子组件保持自治。

### § 2. WorkflowList 改用 AgentCardList

**当前结构**：自定义 grid 表格（`grid-cols-[2fr_100px_120px_80px]`），原生 `<input>` / `<button>`，`p-6` 内边距，自带标题栏 + 搜索栏 + 扫描恢复面板 + 创建对话框 + 删除确认。

**新结构**：复用 `AgentCardList` 容器（与 Tasks / Skills 完全一致）。

```tsx
return (
  <>
    <AgentCardList
      items={filtered}
      cardKey={(wf) => wf.id}
      searchPlaceholder={t("list.search_placeholder")}
      searchFn={(wf, q) => wf.name.toLowerCase().includes(q.toLowerCase())}
      emptyMessage={t("list.no_workflows")}
      renderCard={(wf) => (
        <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-text-bright">{wf.name}</span>
                <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                  wf.latestVersion
                    ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                    : "bg-surface-2 text-text-muted"
                }`}>
                  {wf.latestVersion ? `v${wf.latestVersion}` : t("list.not_published")}
                </span>
              </div>
              {wf.description && (
                <div className="text-xs text-text-muted mt-1 truncate">{wf.description}</div>
              )}
              <div className="flex items-center gap-3 mt-1.5 text-xs text-text-dim">
                <span>{t("list.table_modified")}: {relativeTime(wf.updatedAt)}</span>
              </div>
            </div>
            <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
              <Button size="xs" variant="outline" onClick={() => onEditWorkflow(wf.id)}>
                {t("list.edit")}
              </Button>
              <Button size="xs" variant="outline" onClick={() => onViewVersions(wf.id)}>
                {t("list.version_history")}
              </Button>
              <Button size="xs" variant="destructive" onClick={() => setDeleteTarget(wf)}>
                {t("list.delete")}
              </Button>
            </div>
          </div>
        </div>
      )}
    />

    {/* 扫描恢复面板保留为 warning 样式卡片（功能性强） */}
    {showRecoverPanel && (<div className="...">...</div>)}

    {/* 创建对话框：Dialog → FormDialog */}
    <FormDialog open={showCreateDialog} onOpenChange={...} title={...} onSubmit={handleCreate} loading={creating}>
      <div className="grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor="wf-name">{t("list.name_label")}</Label>
          <Input id="wf-name" value={createName} onChange={(e) => setCreateName(e.target.value)} placeholder="my-workflow" />
        </div>
        <div className="grid gap-2">
          <Label htmlFor="wf-desc">{t("list.desc_label")}</Label>
          <Textarea id="wf-desc" value={createDesc} onChange={(e) => setCreateDesc(e.target.value)} rows={2} placeholder={t("list.desc_placeholder")} />
        </div>
      </div>
    </FormDialog>

    {/* 删除确认：已用 ConfirmDialog，保持不变 */}
    <ConfirmDialog open={deleteTarget !== null} ... />
  </>
);
```

**关键变化**：

- 自定义 grid 表格 → `AgentCardList` 卡片列表（与 Tasks 完全一致的容器）
- 原生 `<input>` / `<button>` / `<textarea>` → shadcn `<Input>` / `<Button>` / `<Textarea>`
- 每张卡片：左侧名称 + 版本徽章 + 描述 + 修改时间，右侧 hover 显示的操作按钮组
- 卡片样式与 Tasks 卡片**完全一致**：`rounded-lg border border-border-light bg-surface-1 px-4 py-3` + `hover:border-border-active hover:shadow-sm` + `opacity-0 group-hover:opacity-100` 操作按钮组
- 创建对话框 `Dialog` → `FormDialog`（统一表单弹窗组件）
- 删除确认已用 `ConfirmDialog`，保持不变
- 扫描恢复面板保留为 `warning` 样式卡片（功能性强，单独保留）

**信息密度损失说明**：表格能横向塞 4 列，卡片每张占一整行——但工作流数量通常很少（几十个级别），卡片可读性更好。

### § 3. WorkflowRuns / WorkflowStats / WorkflowKanban

三个组件目前都是 `p-6` + 内部小标题 + 原生组件。改造原则：**移除内部容器和标题（已上提到 AgentPageHeader），卡片样式对齐，组件迁移到 shadcn。**

#### WorkflowRuns（运行历史）

- 移除 `<div className="h-full overflow-y-auto p-6">` 外壳
- 移除内部 `<h1>{t("runs.title")}</h1>` 和刷新按钮（已上提）
- 状态筛选 chips + 搜索框改用 shadcn：`<Input>` 替代原生 `<input>`，chips 保留自定义（语义化状态色是其核心价值）
- 运行记录行 → 卡片样式（`rounded-lg border border-border-light bg-surface-1 px-4 py-3`），与 WorkflowList 卡片视觉一致
- StatusBadge 保留（状态色是其核心语义）
- 操作按钮 → shadcn `<Button size="xs">`

#### WorkflowStats（统计）

- 移除 `<div className="flex flex-col gap-6 p-6 overflow-y-auto flex-1">` 外壳
- 移除内部 `<h2>{t("page.tab_stats")}</h2>` 标题（已上提）
- 范围切换器（7d / 30d / all）**保留在内容区右上**（作为图表卡片的一部分），不放进 AgentPageHeader actions，因为范围只影响 Stats 内容
- MetricCard 样式对齐：从 `border-border-subtle bg-surface-base` 统一到 `border-border-light bg-surface-1 px-4 py-3`（与 Tasks / WorkflowList 卡片一致）
- 图表卡片（recharts）容器对齐：`rounded-lg border border-border-light bg-surface-1 p-4`
- 失败运行列表 → 卡片列表（与 WorkflowRuns 一致）

#### WorkflowKanban（看板）

这个比较特殊：横向滚动看板，**不能完全套用标准卡片列表**。

- 保留 `flex flex-col h-full` 全高布局（看板需要垂直空间）
- 移除内部 `p-6`，但顶部工具栏（看板选择器 + 新建任务按钮）保留为独立 `border-b` 横条（这是看板的功能性控件，不是页面标题）
- 看板列（KanbanColumn）样式对齐：列宽、间距、卡片样式统一
- KanbanCard 样式对齐：`rounded-lg border border-border-light bg-surface-1 px-3 py-2`
- 看板内组件迁移到 shadcn

**关键差异说明**：Kanban 因为是横向多列布局，**不套用 AgentCardList**，只对齐配色和组件。这是功能性例外，与 WorkflowEditor 全屏 DAG 同理。

### § 4. 子页面差异化处理

#### WorkflowEditor（`/agent/workflow/$id/edit`）— 保持全屏 breadcrumb

**理由**：DAG 画布（ReactFlow）需要最大化垂直空间，加 `AgentPageHeader` 会损失约 60px 高度，对节点编辑体验影响明显。

**改造范围**（仅美化，不动结构）：

- 保留 `<div className="flex flex-col flex-1 min-h-0">` 全屏布局
- `WorkflowBreadcrumb`：保留 `h-9 border-b` 横条形式，仅做配色对齐
  - 当前：`bg-surface-base`
  - 改为：与 `agent-panel-body` 背景统一，文字色调对齐 `text-text-secondary`
  - breadcrumb 链接保留返回箭头 + "返回编排"
- DAG 画布区域不动（`flex-1 min-h-0 overflow-hidden`）

**不做的事**：

- 不加 `AgentPageHeader`（避免损失垂直空间）
- 不强制 `px-8 py-7` 内边距（DAG 需要贴边铺满）

#### WorkflowVersions（`/agent/workflow/$id/versions`）— 完全对齐标准页面

**理由**：版本页本质是版本列表，与 Tasks / Skills 同构，没有特殊空间需求。

**改造**：

- 移除 `<div className="h-full overflow-y-auto p-6">` 外壳
- 移除内部 `<h1>` 小标题和刷新按钮（上提到 AgentPageHeader）
- 改用标准页面布局：`bg-[#f4f7fb] px-8 py-7`
- `AgentPageHeader`：
  - `title` = 工作流名称（`wf?.name`）
  - `subtitle` = 工作流描述（`wf?.description`）
  - `actions` = 刷新按钮 + 编辑入口链接（`<Link to="/agent/workflow/$id/edit">`）
- breadcrumb 返回链接作为 `AgentPageHeader` 的左侧元素或 actions 区，不再独立横条
- 版本列表 → 卡片列表（与 WorkflowList 卡片视觉一致）
- YAML 查看 / 设为最新 / 恢复 等操作 → shadcn `<Button>` + `ConfirmDialog`

**路由文件改动**（`workflow_.$id.versions.tsx`）：

```tsx
function WorkflowVersionsPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();

  const onEditWorkflow = useCallback(
    (workflowId: string) => {
      void navigate({ to: "/agent/workflow/$id/edit", params: { id: workflowId } });
    },
    [navigate],
  );

  return (
    <div className="min-h-full overflow-auto bg-[#f4f7fb] px-8 py-7 text-[#14213d]">
      <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
    </div>
  );
}
```

（外层容器从路由文件提供，`WorkflowVersions` 组件内部直接渲染 `AgentPageHeader` + 内容）

### § 5. i18n 处理

沿用 `workflows` 命名空间（已存在 `page.tab_workflows` 等 keys），新增：

```json
// web/src/i18n/locales/zh/workflows.json
{
  "page": {
    "workflow_title": "智能体编排",
    "workflow_subtitle": "管理 DAG 工作流、看板、运行历史与统计"
  },
  "list": {
    "edit": "编辑"
  }
}

// web/src/i18n/locales/en/workflows.json
{
  "page": {
    "workflow_title": "Workflow Orchestration",
    "workflow_subtitle": "Manage DAG workflows, kanban, run history and stats"
  },
  "list": {
    "edit": "Edit"
  }
}
```

**改造时**：大部分 keys（`list.title`、`list.refresh`、`list.create`、`runs.title` 等）已存在，只是从「子组件内部使用」改为「AgentPageHeader 层使用」或反过来，**改造期间不主动删除原 keys**（避免破坏中途的引用）。

**改造完成后**：grep 一遍所有 workflows.json 中的 key，对确认无引用的悬空 key 显式删除（详见边界条件 7）。

### § 6. shadcn 组件迁移清单

| 当前 | 迁移到 | 涉及文件 |
|---|---|---|
| 原生 `<input>` | `<Input>` | WorkflowList、WorkflowRuns |
| 原生 `<button>` | `<Button>` | WorkflowList、WorkflowRuns、WorkflowKanban |
| 原生 `<textarea>` | `<Textarea>` | WorkflowList 创建对话框 |
| 自定义 `Dialog` 创建 | `<FormDialog>` | WorkflowList |
| 自定义 `Dialog` 删除 | `<ConfirmDialog>`（已用） | WorkflowList |
| 自定义 grid 表格 | `AgentCardList` | WorkflowList |

**例外**（保留自定义）：

- `StatusBadge`（WorkflowRuns）— 状态色是核心语义
- WorkflowStats 范围切换器（segmented control）— shadcn 没有直接对应
- Kanban 顶部工具栏 — 看板特化控件

### § 7. 测试与验证

按 CLAUDE.md 前端测试规则（只测关键流程，不写类型/UI 断言），**不新增单元测试**——本次改造是纯视觉对齐，无业务逻辑变更。

**手动验证清单**（实现完成后逐项检查）：

1. `/agent/workflow` 显示 `AgentPageHeader` + 子 tab + 卡片列表
2. tab 切换正常（list / kanban / runs / stats）
3. 子 tab 视觉是下划线式（`border-b-2 border-brand` 激活态）
4. WorkflowList 卡片样式与 `/agent/tasks` 视觉一致
5. `/agent/workflow/$id/edit` DAG 编辑器仍占满全屏（无 AgentPageHeader）
6. `/agent/workflow/$id/versions` 显示 AgentPageHeader + 卡片列表
7. i18n 中英文切换正常（新增的 `workflow_title` / `workflow_subtitle` / `list.edit`）
8. 暗色模式下样式不破（`bg-[#f4f7fb]` 在暗色下需有兜底，参考 Tasks 页面）
9. `bun run build:web` 通过
10. `bun run precheck` 通过

## 边界情况与风险

1. **WorkflowKanban 的 `border-b` 工具栏 vs 主页面的子 tab 栏**：两个都是横条，要避免视觉冲突。Kanban 工具栏在 tab 内容区**下方**，是子级控件，**保留 border-b**；主 tab 栏在 AgentPageHeader 下方，也保留 border-b。两者垂直方向不冲突（中间有页面内边距和 tab 内容区隔开）。

2. **WorkflowStats 的范围切换器归属**：原本在右上 h2 旁边。改造后 h2 移除，范围切换器需要找新位置——**放在内容区右上**（作为图表卡片的一部分），不放进 AgentPageHeader actions，因为范围只影响 Stats 内容，与页面级 actions 无关。

3. **数据加载与 actions 按钮的归属**：详见 § 1 的「refreshKey 模式」说明。简言之：WorkflowTabPage 持有 `refreshKey` state 和创建/扫描恢复对话框 state，按钮和对话框都就近放在 WorkflowTabPage；WorkflowList 通过 `refreshKey` prop 触发自身刷新，删除确认仍由 WorkflowList 持有（卡片级操作）。

4. **创建对话框字段**：保持原有（name + description），只是改用 shadcn 组件包裹。

5. **响应式**：当前 WorkflowList 表格在窄屏下 grid 列会挤压。改成卡片后，窄屏体验**更好**（卡片自适应）。

6. **暗色模式下的 `bg-[#f4f7fb]`**：硬编码色值不随暗色模式切换。需检查 Tasks / Skills 等已有页面在暗色下如何处理——若它们已通过 CSS variable 或 dark: 变体覆盖，则沿用相同模式；若无兜底，本次改造需补 `dark:bg-[#1a1d23]` 之类的覆盖（与 `agent-panel.css` 中的 `--color-canvas` 一致）。

7. **悬空 i18n keys**：移除子组件内部标题后，`runs.title`、`stats.tab_stats` 等 key 可能变成悬空。改造完成后需 grep 一遍确认所有引用点已迁移或显式删除。

## 实施步骤（粗略，详细 plan 由后续 writing-plans 产出）

1. 新增 i18n keys（`workflow_title` / `workflow_subtitle` / `list.edit`）
2. 改造 `workflow.tsx`：移除全宽 tab 栏，套用标准页面布局 + AgentPageHeader + 内嵌子 tab
3. 改造 `WorkflowList.tsx`：grid 表格 → AgentCardList，原生组件 → shadcn
4. 改造 `WorkflowRuns.tsx`：移除内部容器/标题，卡片样式对齐
5. 改造 `WorkflowStats.tsx`：移除内部容器/标题，MetricCard 配色对齐
6. 改造 `WorkflowKanban.tsx`：保留特化布局，组件迁移到 shadcn + 卡片配色对齐
7. 改造 `WorkflowBreadcrumb.tsx`：仅配色美化
8. 改造 `workflow_.$id.versions.tsx` + `WorkflowVersions.tsx`：套用标准页面布局 + AgentPageHeader + 卡片列表
9. 清理悬空 i18n keys
10. 手动验证清单逐项检查
11. `bun run build:web` + `bun run precheck`

## 影响范围

**修改文件**（预计）：

- `web/src/routes/agent/_panel/workflow.tsx`
- `web/src/routes/agent/_panel/workflow_.$id.versions.tsx`
- `web/src/pages/workflow/WorkflowList.tsx`
- `web/src/pages/workflow/WorkflowRuns.tsx`
- `web/src/pages/workflow/WorkflowStats.tsx`
- `web/src/pages/workflow/WorkflowKanban.tsx`
- `web/src/pages/workflow/WorkflowBreadcrumb.tsx`
- `web/src/pages/workflow/WorkflowVersions.tsx`
- `web/src/pages/workflow/components/KanbanCard.tsx`（配色对齐）
- `web/src/pages/workflow/components/KanbanColumn.tsx`（配色对齐）
- `web/src/i18n/locales/zh/workflows.json`
- `web/src/i18n/locales/en/workflows.json`

**不动文件**：

- `web/src/routes/agent/_panel/workflow_.$id.edit.tsx`（路由结构不变，内部组件不动）
- `web/src/pages/workflow/WorkflowEditor.tsx`（DAG 画布不动）
- `web/src/pages/workflow/nodes.tsx` / `edges.tsx`（ReactFlow 节点定义不动）
- `web/src/api/workflow-*.ts`（API 不动）
