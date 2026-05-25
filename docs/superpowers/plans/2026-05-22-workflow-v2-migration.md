# Workflow 面板迁移到 v2 Agent Panel 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 workflow 面板从 v1 的 `WorkflowPage` 内部路由模式迁移为 v2 Agent Panel 的独立 TanStack Router 路由。

**Architecture:** 拆分为 3 个扁平路由文件（list/runs tab、editor、versions），复用现有子组件（`WorkflowList`/`WorkflowRuns`/`WorkflowEditor`/`WorkflowVersions`）不变，通过 props 回调传入 `useNavigate()` 替代 v1 的 `window.history.pushState`。新增 `WorkflowBreadcrumb` 共享组件用于 editor 和 versions 页面的轻量导航。删除旧的 `AgentWorkflowsPage` 包装组件。

**Tech Stack:** React + TanStack Router (file-based routing) + Tailwind CSS + react-i18next

---

## File Structure

### 新建文件
- `web/src/pages/workflow/WorkflowBreadcrumb.tsx` — 轻量 breadcrumb 组件，editor 和 versions 复用
- `web/src/routes/agent/_panel/workflow_.$id.edit.tsx` — editor 路由
- `web/src/routes/agent/_panel/workflow_.$id.versions.tsx` — versions 路由

### 重写文件
- `web/src/routes/agent/_panel/workflow.tsx` — 从引用 `AgentWorkflowsPage` 改为 list/runs tab 容器

### 修改文件
- `web/src/i18n/locales/en/workflows.json` — 新增 breadcrumb 相关 i18n key
- `web/src/i18n/locales/zh/workflows.json` — 新增 breadcrumb 相关 i18n key

### 删除文件
- `web/src/pages/agent-panel/pages/AgentWorkflowsPage.tsx` — 被 v2 独立路由取代

### 不动文件（v1 共享组件）
- `web/src/pages/workflow/WorkflowList.tsx`
- `web/src/pages/workflow/WorkflowRuns.tsx`
- `web/src/pages/workflow/WorkflowVersions.tsx`
- `web/src/pages/workflow/WorkflowEditor.tsx`
- `web/src/pages/workflow/nodes.tsx`
- `web/src/pages/workflow/layout.ts`
- `web/src/pages/workflow/yaml-utils.ts`
- `web/src/pages/workflow/workflow.css`
- `web/src/pages/WorkflowPage.tsx`（v1 继续使用）
- `web/src/routes/_app/workflow.tsx`（v1 路由不动）
- `web/src/routes/_app/workflow_.$.tsx`（v1 路由不动）

---

### Task 1: 添加 breadcrumb i18n keys

**Files:**
- Modify: `web/src/i18n/locales/en/workflows.json`
- Modify: `web/src/i18n/locales/zh/workflows.json`

- [ ] **Step 1: 在 en/workflows.json 的 `page` 对象中新增 breadcrumb key**

在 `"page"` 对象中添加 3 个新 key：

```json
{
  "page": {
    "back_to_list": "Back to list",
    "editor": "Editor",
    "tab_workflows": "Workflows",
    "tab_runs": "Run History",
    "breadcrumb_back": "Workflows",
    "breadcrumb_edit": "Edit",
    "breadcrumb_versions": "Versions"
  }
}
```

- [ ] **Step 2: 在 zh/workflows.json 的 `page` 对象中新增对应中文 key**

```json
{
  "page": {
    "back_to_list": "返回列表",
    "editor": "编辑器",
    "tab_workflows": "工作流",
    "tab_runs": "运行记录",
    "breadcrumb_back": "工作流",
    "breadcrumb_edit": "编辑",
    "breadcrumb_versions": "版本"
  }
}
```

- [ ] **Step 3: 验证 JSON 无语法错误**

Run: `node -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/en/workflows.json','utf8')); console.log('en OK')" && node -e "JSON.parse(require('fs').readFileSync('web/src/i18n/locales/zh/workflows.json','utf8')); console.log('zh OK')"`

Expected: `en OK` / `zh OK`

- [ ] **Step 4: Commit**

```bash
git add web/src/i18n/locales/en/workflows.json web/src/i18n/locales/zh/workflows.json
git commit -m "feat(workflow): 添加 v2 breadcrumb i18n keys"
```

---

### Task 2: 创建 WorkflowBreadcrumb 组件

**Files:**
- Create: `web/src/pages/workflow/WorkflowBreadcrumb.tsx`

- [ ] **Step 1: 创建 WorkflowBreadcrumb 组件**

该组件接收 `workflowId`、`workflowName`（可选）、`children`（右侧额外链接如"编辑"）。使用 Tailwind + CSS 变量，与 v2 风格统一。使用 `<Link>` 导航回 `/agent/workflow`，而非 `window.history.pushState`。

```tsx
import { ArrowLeft, type LucideIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

interface WorkflowBreadcrumbProps {
  workflowId: string;
  workflowName?: string;
  children?: React.ReactNode;
}

export function WorkflowBreadcrumb({ workflowId, workflowName, children }: WorkflowBreadcrumbProps) {
  const { t } = useTranslation("workflows");

  return (
    <div className="flex items-center gap-2 px-4 h-9 border-b border-border-subtle bg-surface-base flex-shrink-0">
      <Link
        to="/agent/workflow"
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <ArrowLeft size={13} />
        <span>{t("page.breadcrumb_back")}</span>
      </Link>
      {workflowName && (
        <>
          <span className="text-text-dim text-xs">/</span>
          <span className="text-xs font-medium text-text-primary truncate max-w-[200px]">
            {workflowName}
          </span>
        </>
      )}
      {children && (
        <>
          <span className="text-text-dim text-xs">/</span>
          <div className="flex items-center gap-1.5">{children}</div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: 验证 TypeScript 无报错**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`

Expected: 无 WorkflowBreadcrumb 相关错误（可能有其他无关错误）

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/workflow/WorkflowBreadcrumb.tsx
git commit -m "feat(workflow): 创建 WorkflowBreadcrumb 轻量导航组件"
```

---

### Task 3: 重写 workflow list/runs 路由

**Files:**
- Rewrite: `web/src/routes/agent/_panel/workflow.tsx`

- [ ] **Step 1: 重写 `_panel/workflow.tsx`**

这个路由负责渲染 list/runs tab 页面。不再引用 `AgentWorkflowsPage`，而是直接 lazy import `WorkflowList` 和 `WorkflowRuns`。Tab bar 使用 Tailwind + CSS 变量。导航回调使用 `useNavigate()`。

搜索参数 `?tab=runs` 用于标识当前 tab，默认为 list。

```tsx
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import { History, Pencil, Loader } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";

const WorkflowList = lazy(() =>
  import("../../../pages/workflow/WorkflowList").then((m) => ({ default: m.WorkflowList })),
);
const WorkflowRuns = lazy(() =>
  import("../../../pages/workflow/WorkflowRuns").then((m) => ({ default: m.WorkflowRuns })),
);

function WorkflowTabPage() {
  const { t } = useTranslation("workflows");
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { tab?: string };
  const activeTab = search.tab === "runs" ? "runs" : "list";

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
    { id: "list" as const, label: t("page.tab_workflows"), icon: Pencil },
    { id: "runs" as const, label: t("page.tab_runs"), icon: History },
  ];

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex items-center px-6 h-9 border-b border-border-subtle bg-surface-base flex-shrink-0">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <Link
              key={tab.id}
              to="/agent/workflow"
              search={tab.id === "runs" ? { tab: "runs" } : {}}
              className={`flex items-center gap-1.5 px-3.5 h-full text-xs font-medium border-b-2 transition-colors ${
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
      <div className="flex-1 min-h-0 overflow-hidden">
        {activeTab === "list" ? (
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

- [ ] **Step 2: 验证 TypeScript 无报错**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`

Expected: 无 workflow 相关错误

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/agent/_panel/workflow.tsx
git commit -m "feat(workflow): 重写 v2 workflow list/runs tab 路由"
```

---

### Task 4: 创建 workflow editor 路由

**Files:**
- Create: `web/src/routes/agent/_panel/workflow_.$id.edit.tsx`

- [ ] **Step 1: 创建 editor 路由文件**

使用 TanStack Router 的 flat route 语法（`_` 后缀表示 flat，`$id` 是动态参数）。路由 path 为 `/agent/workflow/:id/edit`。`runId` 从 search params 获取。顶部用 `WorkflowBreadcrumb` 包裹。

```tsx
import { createFileRoute, useSearch } from "@tanstack/react-router";
import { Loader } from "lucide-react";
import { lazy, Suspense } from "react";
import { WorkflowBreadcrumb } from "../../../pages/workflow/WorkflowBreadcrumb";

const WorkflowEditor = lazy(() =>
  import("../../../pages/workflow/WorkflowEditor").then((m) => ({ default: m.WorkflowEditor })),
);

function WorkflowEditPage() {
  const { id } = Route.useParams();
  const search = useSearch({ strict: false }) as { runId?: string };

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <WorkflowBreadcrumb workflowId={id} />
      <div className="flex-1 min-h-0 overflow-hidden">
        <WorkflowEditor workflowId={id} runId={search.runId} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow/$id/edit")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <Loader className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowEditPage />
    </Suspense>
  ),
});
```

- [ ] **Step 2: 验证 TypeScript 无报错**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`

Expected: 无 workflow 相关错误

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/agent/_panel/workflow_.$id.edit.tsx
git commit -m "feat(workflow): 创建 v2 workflow editor 路由"
```

---

### Task 5: 创建 workflow versions 路由

**Files:**
- Create: `web/src/routes/agent/_panel/workflow_.$id.versions.tsx`

- [ ] **Step 1: 创建 versions 路由文件**

与 editor 路由类似。`WorkflowVersions` 的 `onEditWorkflow` prop 传入 `useNavigate` 回调（即使组件内部当前不调用它，保持 interface 兼容）。Breadcrumb 右侧加 "编辑" 链接。

```tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Pencil } from "lucide-react";
import { lazy, Suspense, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { WorkflowBreadcrumb } from "../../../pages/workflow/WorkflowBreadcrumb";

const WorkflowVersions = lazy(() =>
  import("../../../pages/workflow/WorkflowVersions").then((m) => ({ default: m.WorkflowVersions })),
);

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
    <div className="flex flex-col flex-1 min-h-0">
      <WorkflowBreadcrumb workflowId={id}>
        <Link
          to="/agent/workflow/$id/edit"
          params={{ id }}
          className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
        >
          <Pencil size={12} />
          <span>{t("page.breadcrumb_edit")}</span>
        </Link>
      </WorkflowBreadcrumb>
      <div className="flex-1 min-h-0 overflow-hidden">
        <WorkflowVersions workflowId={id} onEditWorkflow={onEditWorkflow} />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/agent/_panel/workflow/$id/versions")({
  component: () => (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <WorkflowVersionsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 2: 验证 TypeScript 无报错**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`

Expected: 无 workflow 相关错误

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/agent/_panel/workflow_.$id.versions.tsx
git commit -m "feat(workflow): 创建 v2 workflow versions 路由"
```

---

### Task 6: 删除旧的 AgentWorkflowsPage

**Files:**
- Delete: `web/src/pages/agent-panel/pages/AgentWorkflowsPage.tsx`

- [ ] **Step 1: 确认没有任何其他文件引用 `AgentWorkflowsPage`**

Run: `grep -r "AgentWorkflowsPage" web/src/ --include="*.tsx" --include="*.ts"`

Expected: 只有 `web/src/pages/agent-panel/pages/AgentWorkflowsPage.tsx` 自身（`_panel/workflow.tsx` 已在 Task 3 中重写，不再引用它）

- [ ] **Step 2: 删除文件**

```bash
rm web/src/pages/agent-panel/pages/AgentWorkflowsPage.tsx
```

- [ ] **Step 3: 验证构建无报错**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && npx tsc --noEmit --project web/tsconfig.json 2>&1 | head -20`

Expected: 无 AgentWorkflowsPage 相关错误

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(workflow): 删除旧的 AgentWorkflowsPage 包装组件"
```

---

### Task 7: 验证 TanStack Router 路由树生成

**Files:**
- Verify: `web/src/routeTree.gen.ts`（自动生成）

- [ ] **Step 1: 触发路由树重新生成**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx @tanstack/router-plugin generate`

如果上述命令不可用，通过 Vite dev server 启动触发自动生成：

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && timeout 15 bun run dev:web 2>&1 | head -30 || true`

- [ ] **Step 2: 验证 routeTree.gen.ts 包含新路由**

Run: `grep -c "workflow" web/src/routeTree.gen.ts`

Expected: 输出数字 >= 3（至少包含 workflow、workflow/$id/edit、workflow/$id/versions）

- [ ] **Step 3: 验证构建**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -20`

Expected: 构建成功，无错误

- [ ] **Step 4: Commit（如有 routeTree.gen.ts 变更）**

```bash
git add web/src/routeTree.gen.ts
git diff --cached --stat
# 如有变更则 commit
git commit -m "chore(workflow): 更新 routeTree.gen.ts 包含新 workflow 路由"
```

---

### Task 8: 运行 precheck

- [ ] **Step 1: 运行 precheck 确保代码质量**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run precheck 2>&1 | tail -30`

Expected: 全部通过（format + import sort + tsc + biome check）

- [ ] **Step 2: 修复 precheck 发现的问题（如有）**

如果 biome 报错，按提示修复。如果 tsc 报错，检查路由文件中的类型是否正确。

- [ ] **Step 3: 最终 commit（如有修复）**

```bash
git add -A
git commit -m "fix(workflow): 修复 precheck 发现的问题"
```
