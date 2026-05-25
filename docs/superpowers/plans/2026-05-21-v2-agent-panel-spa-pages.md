# V2 Agent Panel SPA Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert v2 Agent Panel from v1-redirect navigation to fully independent SPA pages with card-list UI, all under `/agent/` sub-routes with a shared AgentSidebar layout.

**Architecture:** TanStack Router pathless layout route (`_panel.tsx`) wraps all v2 pages with AgentSidebar. Chat routes get `agentId` in URL; config pages (models, skills, etc.) are organization-level with no `agentId`. Each config page is a new v2-specific component using card-list layout (not DataTable), sharing the same API client and i18n namespaces as v1. Old routes (`/agent/:agentId`) redirect to new chat routes for backward compatibility.

**Tech Stack:** React 19, TanStack Router (file-based), Tailwind CSS v4, shadcn/ui, Eden Treaty API client, react-i18next

---

## Design Decisions (from grilling session)

1. All v2 pages are **new components** (not reusing v1 page components)
2. **Layout:** AgentSidebar (always visible) + full-width main content area
3. **URL sub-route driven** SPA navigation (not state-driven)
4. **Route structure:** `/agent/chat/:agentId` (chat), `/agent/models` (org-level config pages)
5. **11 config pages** all get independent implementations
6. **Functionality identical** to v1, **style different** (card list, same theme)
7. **Card list** (vertical card layout, not grid)
8. **Modal dialogs** for form editing
9. **Pure highlight** on sidebar nav, no highlight in chat view
10. **Dropdown menu** kept, navigation targets changed to internal sub-routes
11. **Agent tree visible** but no selection on config pages
12. **v1 preserved**, v2 is primary

## File Structure

### Route files to create
```
web/src/routes/agent/
├── _panel.tsx                              → pathless layout (AgentSidebar + Outlet)
├── _panel/
│   ├── index.tsx                           → /agent/ redirect to first agent
│   ├── chat.$agentId.tsx                   → /agent/chat/:agentId
│   ├── chat.$agentId_.$sessionId.tsx       → /agent/chat/:agentId/:sessionId
│   ├── models.tsx                          → /agent/models
│   ├── skills.tsx                          → /agent/skills
│   ├── mcp.tsx                             → /agent/mcp
│   ├── organizations.tsx                   → /agent/organizations
│   ├── dashboard.tsx                       → /agent/dashboard
│   ├── workflow.tsx                        → /agent/workflow
│   ├── sessions.tsx                        → /agent/sessions
│   ├── knowledge-bases.tsx                 → /agent/knowledge-bases
│   ├── tasks.tsx                           → /agent/tasks
│   ├── channels.tsx                        → /agent/channels
│   ├── apikeys.tsx                         → /agent/apikeys
├── $agentId.tsx                            → redirect to /agent/chat/:agentId (backward compat)
├── $agentId_.$sessionId.tsx                → redirect to /agent/chat/:agentId/:sessionId
├── index.tsx                               → redirect to /agent/chat (keep for compat)
```

### Page components to create
```
web/src/pages/agent-panel/
├── AgentPanelLayout.tsx                    → replaces AgentAppShell (layout shell)
├── AgentSidebar.tsx                        → modified (active state + v2 nav)
├── AgentSidebarConfig.tsx                  → modified (v2 internal nav)
├── AgentSidebarTree.tsx                    → unchanged
├── AgentCreateDialog.tsx                   → unchanged
├── ChatPanel.tsx                           → unchanged
├── ArtifactsPanel.tsx                      → unchanged
├── agent-panel.css                         → unchanged
├── shared/
│   ├── AgentPageHeader.tsx                 → shared page header (title + actions)
│   └── AgentCardList.tsx                   → shared card list component
├── pages/
│   ├── AgentModelsPage.tsx
│   ├── AgentSkillsPage.tsx
│   ├── AgentMcpPage.tsx
│   ├── AgentOrganizationsPage.tsx
│   ├── AgentDashboardPage.tsx
│   ├── AgentWorkflowsPage.tsx
│   ├── AgentSessionsPage.tsx
│   ├── AgentKnowledgeBasesPage.tsx
│   ├── AgentTasksPage.tsx
│   ├── AgentChannelsPage.tsx
│   └── AgentApiKeysPage.tsx
```

### Files to modify
```
web/src/pages/agent-panel/AgentAppShell.tsx  → delete (replaced by AgentPanelLayout)
web/src/pages/agent-panel/AgentSidebar.tsx    → add active state + v2 navigation
web/src/pages/agent-panel/AgentSidebarConfig.tsx → change nav targets to internal
web/src/routes/agent/$agentId.tsx             → convert to redirect
web/src/routes/agent/$agentId_.$sessionId.tsx → convert to redirect
web/src/routes/agent/index.tsx                → convert to redirect
```

---

## Phase 1: Route Infrastructure

### Task 1: Create AgentPanelLayout (replace AgentAppShell)

**Files:**
- Create: `web/src/pages/agent-panel/AgentPanelLayout.tsx`
- Modify: `web/src/pages/agent-panel/AgentAppShell.tsx` (delete after migration)

- [ ] **Step 1: Create AgentPanelLayout component**

This replaces AgentAppShell. It renders AgentSidebar + Outlet (no chat-specific state). AgentSidebar gets its navigation from `useNavigate` and active state from `useRouterState`.

```tsx
// web/src/pages/agent-panel/AgentPanelLayout.tsx
import { Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { AgentCreateDialog } from "./AgentCreateDialog";
import { AgentSidebar } from "./AgentSidebar";
import "./agent-panel.css";

export function AgentPanelLayout() {
  const navigate = useNavigate();
  const routerState = useRouterState();
  const pathname = routerState.location.pathname;

  const [createDialogOpen, setCreateDialogOpen] = useState(false);

  // Derive active nav from pathname
  // /agent/models → "models", /agent/chat/xxx → null (chat view)
  const activeNav = (() => {
    const segment = pathname.replace("/ctrl/agent/", "").split("/")[0];
    if (segment === "chat" || segment === "" || pathname === "/ctrl/agent") return null;
    return segment;
  })();

  const handleNavigate = useCallback(
    (pageId: string) => {
      void navigate({ to: `/agent/${pageId}` });
    },
    [navigate],
  );

  const handleSelectInstance = useCallback(
    (instanceId: string, envId: string, sessionId: string | null) => {
      if (sessionId) {
        void navigate({ to: "/agent/chat/$agentId/$sessionId", params: { agentId: envId, sessionId } });
      } else {
        void navigate({ to: "/agent/chat/$agentId", params: { agentId: envId } });
      }
    },
    [navigate],
  );

  return (
    <div className="agent-panel-layout">
      <AgentSidebar
        activeNav={activeNav}
        onSelectInstance={handleSelectInstance}
        onNavigate={handleNavigate}
        onCreateAgent={() => setCreateDialogOpen(true)}
      />
      <div className="agent-panel-body">
        <Outlet />
      </div>
      <AgentCreateDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/agent-panel/AgentPanelLayout.tsx
git commit -m "feat: create AgentPanelLayout component for v2 SPA routing"
```

---

### Task 2: Update AgentSidebar with active state and v2 navigation

**Files:**
- Modify: `web/src/pages/agent-panel/AgentSidebar.tsx`
- Modify: `web/src/pages/agent-panel/AgentSidebarConfig.tsx`

- [ ] **Step 1: Update AgentSidebar props and interface**

Modify `AgentSidebar.tsx` to accept `activeNav` prop instead of `selectedInstanceId`, and pass it down for highlight rendering.

Change the interface:
```tsx
interface AgentSidebarProps {
  activeNav: string | null;
  onSelectInstance: (instanceId: string, envId: string, sessionId: string | null) => void;
  onNavigate: (pageId: string) => void;
  onCreateAgent?: () => void;
}
```

Remove `selectedInstanceId` from props (agent tree selection state is now URL-driven).

- [ ] **Step 2: Update AgentSidebarConfig to pass activeNav for highlight**

In `AgentSidebarQuickNav`, add active highlight to the current nav button:

```tsx
export function AgentSidebarQuickNav({ onNavigate, activeNav }: AgentSidebarConfigProps & { activeNav: string | null }) {
  const { t } = useTranslation();

  return (
    <div className="px-2 py-1.5">
      {QUICK_NAV.map((item) => {
        const Icon = item.icon;
        const isActive = activeNav === item.id;
        return (
          <button
            key={item.id}
            type="button"
            onClick={() => onNavigate(item.id)}
            className={`flex items-center gap-2.5 w-full px-3 py-2 rounded-[var(--radius)] text-[13px] font-medium transition-all duration-150 cursor-pointer ${
              isActive
                ? "bg-brand-subtle text-brand-light border-l-2 border-brand"
                : "text-text-secondary hover:bg-surface-hover hover:text-text-primary"
            }`}
          >
            <Icon className="w-[18px] h-[18px] flex-shrink-0" />
            <span>{t(item.labelKey)}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Update AgentSidebar component to pass activeNav**

```tsx
export function AgentSidebar({
  activeNav,
  onSelectInstance,
  onNavigate,
  onCreateAgent,
}: AgentSidebarProps) {
  // ... existing code ...

  return (
    <aside className="agent-sidebar">
      {/* 品牌区 — same as before */}

      {/* 快捷导航 */}
      <AgentSidebarQuickNav onNavigate={onNavigate} activeNav={activeNav} />

      {/* 智能体树 */}
      <div className="border-t border-border-subtle">
        <AgentSidebarTree
          selectedInstanceId={null}
          onSelectInstance={onSelectInstance}
          onCreateAgent={onCreateAgent}
        />
      </div>

      {/* 更多导航 */}
      <div className="border-t border-border-subtle">
        <AgentSidebarConfig onNavigate={onNavigate} />
      </div>

      {/* 底部 — same as before */}
    </aside>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/agent-panel/AgentSidebar.tsx web/src/pages/agent-panel/AgentSidebarConfig.tsx
git commit -m "feat: add active state highlight to AgentSidebar nav items"
```

---

### Task 3: Create layout route and chat route files

**Files:**
- Create: `web/src/routes/agent/_panel.tsx`
- Create: `web/src/routes/agent/_panel/index.tsx`
- Create: `web/src/routes/agent/_panel/chat.$agentId.tsx`
- Create: `web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx`

- [ ] **Step 1: Create `_panel.tsx` layout route**

```tsx
// web/src/routes/agent/_panel.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";

const AgentPanelLayout = lazy(() =>
  import("../../pages/agent-panel/AgentPanelLayout").then((m) => ({ default: m.AgentPanelLayout })),
);

export const Route = createFileRoute("/agent/_panel")({
  component: () => {
    const { t } = useTranslation("agentPanel");
    return (
      <Suspense
        fallback={
          <div className="flex h-screen flex-col items-center justify-center gap-3">
            <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
            <p className="text-sm text-text-muted">{t("loading_agent_panel")}</p>
          </div>
        }
      >
        <AgentPanelLayout />
      </Suspense>
    );
  },
});
```

- [ ] **Step 2: Create `_panel/index.tsx` (redirect)**

```tsx
// web/src/routes/agent/_panel/index.tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/_panel/")({
  beforeLoad: () => {
    throw redirect({ to: "/agent/chat/$agentId", params: { agentId: "" } });
  },
});
```

Note: `agentId: ""` will show the empty/chat-welcome state in ChatPanel. The user can then select an agent from the sidebar tree.

- [ ] **Step 3: Create `_panel/chat.$agentId.tsx`**

This route renders the chat view (ChatPanel + ArtifactsPanel). It replaces what AgentAppShell used to render directly.

```tsx
// web/src/routes/agent/_panel/chat.$agentId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusHeader } from "../../../components/agent-panel/StatusHeader";
import type { ThreadEntry } from "../../../../src/lib/types";

const ChatPanel = lazy(() =>
  import("../../../pages/agent-panel/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);
const ArtifactsPanel = lazy(() =>
  import("../../../pages/agent-panel/ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })),
);

export const Route = createFileRoute("/agent/_panel/chat/$agentId")({
  component: ChatRoute,
});

function ChatRoute() {
  const { agentId } = Route.useParams();
  const { t } = useTranslation("agentPanel");

  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-collapsed");
    return saved === "true";
  });

  const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
    entries: [],
  });

  useEffect(() => {
    const handler = (e: Event) => {
      setStats((e as CustomEvent).detail);
    };
    window.addEventListener("chat:stats", handler);
    return () => window.removeEventListener("chat:stats", handler);
  }, []);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) setArtifactsCollapsed(true);
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-collapsed", String(artifactsCollapsed));
  }, [artifactsCollapsed]);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <StatusHeader agentName={stats.agentName} modelName={stats.modelName} entries={stats.entries} />
      <div className="agent-panel-content">
        <div className="agent-chat-area">
          <ChatPanel agentId={agentId || null} />
        </div>
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
        />
        {artifactsCollapsed && (
          <button
            type="button"
            className="agent-artifacts-expand-btn"
            onClick={() => setArtifactsCollapsed(false)}
            title={t("showArtifacts")}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </Suspense>
  );
}
```

- [ ] **Step 4: Create `_panel/chat.$agentId_.$sessionId.tsx`**

Same as above but with sessionId param:

```tsx
// web/src/routes/agent/_panel/chat.$agentId_.$sessionId.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense, useEffect, useState } from "react";
import { PanelRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { StatusHeader } from "../../../components/agent-panel/StatusHeader";
import type { ThreadEntry } from "../../../../src/lib/types";

const ChatPanel = lazy(() =>
  import("../../../pages/agent-panel/ChatPanel").then((m) => ({ default: m.ChatPanel })),
);
const ArtifactsPanel = lazy(() =>
  import("../../../pages/agent-panel/ArtifactsPanel").then((m) => ({ default: m.ArtifactsPanel })),
);

export const Route = createFileRoute("/agent/_panel/chat/$agentId/$sessionId")({
  component: ChatWithSessionRoute,
});

function ChatWithSessionRoute() {
  const { agentId, sessionId } = Route.useParams();
  const { t } = useTranslation("agentPanel");

  const [artifactsCollapsed, setArtifactsCollapsed] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-collapsed");
    return saved === "true";
  });

  const [stats, setStats] = useState<{ agentName?: string; modelName?: string; entries: ThreadEntry[] }>({
    entries: [],
  });

  useEffect(() => {
    const handler = (e: Event) => setStats((e as CustomEvent).detail);
    window.addEventListener("chat:stats", handler);
    return () => window.removeEventListener("chat:stats", handler);
  }, []);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-collapsed", String(artifactsCollapsed));
  }, [artifactsCollapsed]);

  return (
    <Suspense
      fallback={
        <div className="flex flex-1 items-center justify-center">
          <div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" />
        </div>
      }
    >
      <StatusHeader agentName={stats.agentName} modelName={stats.modelName} entries={stats.entries} />
      <div className="agent-panel-content">
        <div className="agent-chat-area">
          <ChatPanel agentId={agentId} sessionId={sessionId} />
        </div>
        <ArtifactsPanel
          collapsed={artifactsCollapsed}
          onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
          envId={agentId}
        />
        {artifactsCollapsed && (
          <button
            type="button"
            className="agent-artifacts-expand-btn"
            onClick={() => setArtifactsCollapsed(false)}
            title={t("showArtifacts")}
          >
            <PanelRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </Suspense>
  );
}
```

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/agent/_panel.tsx web/src/routes/agent/_panel/
git commit -m "feat: create v2 layout route and chat sub-routes under /agent/"
```

---

### Task 4: Convert old agent routes to backward-compat redirects

**Files:**
- Modify: `web/src/routes/agent/$agentId.tsx`
- Modify: `web/src/routes/agent/$agentId_.$sessionId.tsx`
- Modify: `web/src/routes/agent/index.tsx`

- [ ] **Step 1: Convert `$agentId.tsx` to redirect**

Replace entire file:

```tsx
// web/src/routes/agent/$agentId.tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/$agentId")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/agent/chat/$agentId", params: { agentId: params.agentId } });
  },
});
```

- [ ] **Step 2: Convert `$agentId_.$sessionId.tsx` to redirect**

Replace entire file:

```tsx
// web/src/routes/agent/$agentId_.$sessionId.tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/$agentId/$sessionId")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/agent/chat/$agentId/$sessionId",
      params: { agentId: params.agentId, sessionId: params.sessionId },
    });
  },
});
```

- [ ] **Step 3: Convert `index.tsx` to redirect**

Replace entire file:

```tsx
// web/src/routes/agent/index.tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/agent/")({
  beforeLoad: () => {
    throw redirect({ to: "/agent/chat/$agentId", params: { agentId: "" } });
  },
});
```

- [ ] **Step 4: Verify TanStack Router plugin regenerates `routeTree.gen.ts`**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | head -30`
Expected: Build should succeed. The `routeTree.gen.ts` should include the new `_panel` layout route and its children.

If there are route tree conflicts, check that `routeTree.gen.ts` has been auto-regenerated by the TanStack Router Vite plugin. If not, manually trigger a build.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/agent/$agentId.tsx web/src/routes/agent/$agentId_.$sessionId.tsx web/src/routes/agent/index.tsx
git commit -m "refactor: convert old agent routes to redirects for backward compatibility"
```

---

### Task 5: Delete AgentAppShell (replaced by AgentPanelLayout)

**Files:**
- Delete: `web/src/pages/agent-panel/AgentAppShell.tsx`

- [ ] **Step 1: Verify no remaining imports of AgentAppShell**

Run: `grep -r "AgentAppShell" web/src/ --include="*.tsx" --include="*.ts"`
Expected: Only the old route files that were already converted in Task 4 should reference it. Those files no longer import it (they just redirect). The `_panel.tsx` layout imports `AgentPanelLayout` instead.

If any file still imports `AgentAppShell`, update it to import `AgentPanelLayout` instead.

- [ ] **Step 2: Delete AgentAppShell.tsx**

```bash
rm web/src/pages/agent-panel/AgentAppShell.tsx
```

- [ ] **Step 3: Verify build**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add -A web/src/pages/agent-panel/AgentAppShell.tsx
git commit -m "refactor: remove AgentAppShell (replaced by AgentPanelLayout)"
```

---

## Phase 2: Shared Components

### Task 6: Create AgentPageHeader component

**Files:**
- Create: `web/src/pages/agent-panel/shared/AgentPageHeader.tsx`

- [ ] **Step 1: Create shared page header**

This provides consistent layout for all v2 config pages: title, subtitle, and action buttons area.

```tsx
// web/src/pages/agent-panel/shared/AgentPageHeader.tsx
interface AgentPageHeaderProps {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}

export function AgentPageHeader({ title, subtitle, actions }: AgentPageHeaderProps) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border-subtle">
      <div>
        <h2 className="text-lg font-semibold text-text-bright">{title}</h2>
        {subtitle && <p className="text-sm text-text-muted mt-0.5">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/agent-panel/shared/AgentPageHeader.tsx
git commit -m "feat: create AgentPageHeader shared component for v2 config pages"
```

---

### Task 7: Create AgentCardList component

**Files:**
- Create: `web/src/pages/agent-panel/shared/AgentCardList.tsx`

- [ ] **Step 1: Create generic card list**

This replaces DataTable for v2 config pages. It renders a vertical list of cards with optional search, selection, and batch actions.

```tsx
// web/src/pages/agent-panel/shared/AgentCardList.tsx
import { useState } from "react";
import { Input } from "../../../components/ui/input";

interface AgentCardListProps<T> {
  items: T[];
  cardKey: (item: T) => string;
  renderCard: (item: T, isSelected: boolean, toggleSelect: () => void) => React.ReactNode;
  searchPlaceholder?: string;
  searchFn?: (item: T, query: string) => boolean;
  emptyMessage?: string;
  selectable?: boolean;
  selectedItems?: T[];
  onSelectionChange?: (items: T[]) => void;
  batchActions?: React.ReactNode;
}

export function AgentCardList<T>({
  items,
  cardKey,
  renderCard,
  searchPlaceholder,
  searchFn,
  emptyMessage = "No items",
  selectable = false,
  selectedItems = [],
  onSelectionChange,
  batchActions,
}: AgentCardListProps<T>) {
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = searchQuery.trim() && searchFn
    ? items.filter((item) => searchFn(item, searchQuery.toLowerCase()))
    : items;

  const selectedSet = new Set(selectedItems.map(cardKey));

  const toggleSelect = (item: T) => {
    if (!onSelectionChange) return;
    const key = cardKey(item);
    if (selectedSet.has(key)) {
      onSelectionChange(selectedItems.filter((s) => cardKey(s) !== key));
    } else {
      onSelectionChange([...selectedItems, item]);
    }
  };

  const toggleSelectAll = () => {
    if (!onSelectionChange) return;
    if (selectedItems.length === filtered.length) {
      onSelectionChange([]);
    } else {
      onSelectionChange([...filtered]);
    }
  };

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
      {/* Search + Batch Actions */}
      {(searchPlaceholder || (selectable && selectedItems.length > 0)) && (
        <div className="flex items-center gap-3 px-6 py-3 border-b border-border-subtle">
          {searchPlaceholder && (
            <div className="relative flex-1 max-w-sm">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-text-muted"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z"
                />
              </svg>
              <Input
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={searchPlaceholder}
                className="pl-9 h-8 text-sm"
              />
            </div>
          )}
          {selectable && selectedItems.length > 0 && (
            <div className="flex items-center gap-2 ml-auto">
              <span className="text-xs text-text-muted">
                {selectedItems.length} selected
              </span>
              <button
                type="button"
                onClick={() => onSelectionChange?.([])}
                className="text-xs text-text-muted hover:text-text-primary"
              >
                Clear
              </button>
              {batchActions}
            </div>
          )}
        </div>
      )}

      {/* Select All */}
      {selectable && filtered.length > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 border-b border-border-subtle bg-surface-1">
          <input
            type="checkbox"
            checked={selectedItems.length === filtered.length && filtered.length > 0}
            onChange={toggleSelectAll}
            className="rounded border-border"
          />
          <span className="text-xs text-text-muted">Select all ({filtered.length})</span>
        </div>
      )}

      {/* Card List */}
      <div className="flex-1 overflow-y-auto px-6 py-4">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-text-muted">
            <p className="text-sm">{emptyMessage}</p>
          </div>
        ) : (
          <div className="grid gap-3">
            {filtered.map((item) =>
              renderCard(item, selectedSet.has(cardKey(item)), () => toggleSelect(item)),
            )}
          </div>
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/agent-panel/shared/AgentCardList.tsx
git commit -m "feat: create AgentCardList shared component for v2 card layout"
```

---

## Phase 3: Config Page Implementations

Each page follows the same pattern:
1. Create page component in `web/src/pages/agent-panel/pages/`
2. Create route file in `web/src/routes/agent/_panel/`
3. Verify build

All pages reuse:
- `AgentPageHeader` for header
- `AgentCardList` for card list layout
- Same API client (`client.web.config.<module>.post(...)`) as v1
- Same i18n namespace as v1 (e.g., `"models"`, `"skills"`)
- Same shared UI components (`FormDialog`, `ConfirmDialog`, `Button`, `Input`, etc.)

### Task 8: AgentModelsPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentModelsPage.tsx`
- Create: `web/src/routes/agent/_panel/models.tsx`

- [ ] **Step 1: Create AgentModelsPage component**

This page replicates ModelsPage functionality with card-list UI. Each provider is a card showing: provider name/ID, protocol badge, API key hint, status badge, model count. Expandable to show model sub-cards. Actions: test, edit, delete. Header has "Create Provider" + "Model Config" buttons.

The component logic (state management, API calls, form handling) is identical to v1 `ModelsPage`. The only difference is the rendering: cards instead of DataTable rows.

Key imports from v1 ModelsPage that can be reused:
- `getModelUsageStatus`, `validateProviderForm`, `buildProviderPayload`, `buildProviderModelRequest` — export from v1 ModelsPage, import in v2
- `FormDialog`, `ConfirmDialog`, `StatusBadge`, `ModelConfigDialog` — shared components
- `client`, `unwrapConfigData`, `dispatchConfigChange` — shared API utilities

The page component wraps content in a flex column that fills the available space:
```tsx
return (
  <div className="flex flex-col flex-1 min-h-0">
    <AgentPageHeader title={t("title")} subtitle={t("subtitle")} actions={...} />
    <AgentCardList
      items={providers}
      cardKey={(p) => p.id}
      searchPlaceholder={t("searchPlaceholder")}
      searchFn={(p, q) => p.id.toLowerCase().includes(q) || (p.name?.toLowerCase().includes(q) ?? false)}
      emptyMessage={t("emptyMessage")}
      selectable
      selectedItems={selected}
      onSelectionChange={setSelected}
      batchActions={<Button size="xs" variant="destructive" onClick={handleBatchDelete}>{t("batchDelete")}</Button>}
      renderCard={(provider, isSelected, toggleSelect) => (
        <ProviderCard
          key={provider.id}
          provider={provider}
          isSelected={isSelected}
          toggleSelect={toggleSelect}
          models={providerModels[provider.id] ?? []}
          onTest={() => handleTest(provider.id)}
          onEdit={() => handleOpenEdit(provider)}
          onDelete={() => handleDelete(provider.id)}
          testing={testing === provider.id}
          onModelChange={(action, pid, mid) => { /* same as v1 */ }}
        />
      )}
    />
    {/* Dialogs — same as v1 */}
  </div>
);
```

Each `ProviderCard` is a styled div:
```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  {/* Checkbox + Provider Info Row */}
  <div className="flex items-center gap-3">
    {selectable && <input type="checkbox" checked={isSelected} onChange={toggleSelect} />}
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium text-text-bright">{provider.id}</span>
        {provider.name && provider.name !== provider.id && (
          <span className="text-xs text-text-secondary">{provider.name}</span>
        )}
        {/* Protocol badge */}
        {/* API key hint */}
        <StatusBadge status={provider.configured ? "configured" : "unconfigured"} />
        {/* Model count badge */}
      </div>
    </div>
    {/* Action buttons (test, edit, delete) — visible on hover */}
  </div>
  {/* Expandable model list */}
  <Collapsible>
    <CollapsibleTrigger>Models ({modelCount})</CollapsibleTrigger>
    <CollapsibleContent>
      {/* Model sub-cards — same card style as ModelSubrow in v1 */}
    </CollapsibleContent>
  </Collapsible>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/models.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentModelsPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentModelsPage").then((m) => ({ default: m.AgentModelsPage })),
);

export const Route = createFileRoute("/agent/_panel/models")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentModelsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentModelsPage.tsx web/src/routes/agent/_panel/models.tsx
git commit -m "feat: create v2 AgentModelsPage with card-list UI"
```

---

### Task 9: AgentSkillsPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx`
- Create: `web/src/routes/agent/_panel/skills.tsx`

- [ ] **Step 1: Create AgentSkillsPage component**

Identical functionality to v1 SkillsPage with card-list UI. Each skill is a card showing: name (monospace), description. Actions: edit, delete. Header has "Upload Skill" + "Create Skill" buttons.

Reuses from v1 SkillsPage:
- `validateSkillForm`, `getUploadResultMessage`, `normalizeSkillUploadResult`, `getUploadConflictData`, `getUploadItemSummaries`, `getInvalidUploadSkillNames`
- All upload logic (file selection, conflict handling, overwrite)
- Same form dialogs (create text / upload tabs)

Card rendering:
```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-center gap-3">
    {selectable && <input type="checkbox" checked={isSelected} onChange={toggleSelect} />}
    <div className="flex-1 min-w-0">
      <span className="font-mono text-sm font-medium text-text-bright">{skill.name}</span>
      <p className="text-sm text-text-secondary line-clamp-1 mt-0.5">{skill.description || "—"}</p>
    </div>
    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button size="xs" variant="outline" onClick={() => handleOpenEdit(skill)}>{t("btn.edit")}</Button>
      <Button size="xs" variant="destructive" onClick={() => handleDeleteClick(skill)}>{t("btn.delete")}</Button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/skills.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentSkillsPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentSkillsPage").then((m) => ({ default: m.AgentSkillsPage })),
);

export const Route = createFileRoute("/agent/_panel/skills")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentSkillsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentSkillsPage.tsx web/src/routes/agent/_panel/skills.tsx
git commit -m "feat: create v2 AgentSkillsPage with card-list UI"
```

---

### Task 10: AgentMcpPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentMcpPage.tsx`
- Create: `web/src/routes/agent/_panel/mcp.tsx`

- [ ] **Step 1: Create AgentMcpPage component**

Identical functionality to v1 McpPage with card-list UI. Each MCP server is a card showing: name (monospace), type badge (Local/Remote), status badge, command/URL, tools count. Expandable to show tools. Actions: inspect, enable/disable, edit, delete.

Reuses from v1 McpPage:
- `validateMcpForm`, `parseCommandString`, `commandToString`, `buildMcpSummary`, `buildMcpPayload`

Card rendering:
```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-center gap-3">
    {selectable && <input type="checkbox" checked={isSelected} onChange={toggleSelect} />}
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium text-text-bright">{server.name}</span>
        {/* Type badge: Local (amber) / Remote (cyan) */}
        <StatusBadge status={server.enabled ? "enabled" : "disabled"} />
        {/* Tools count badge */}
      </div>
      <p className="text-xs font-mono text-text-secondary mt-1 truncate">{server.summary || "—"}</p>
    </div>
    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button size="xs" variant="outline" disabled={inspecting} onClick={() => handleInspect(server)}>
        {inspecting ? t("btn.inspecting") : t("btn.inspect")}
      </Button>
      <Button size="xs" variant="outline" onClick={() => handleToggle(server)}>
        {server.enabled ? t("btn.disable") : t("btn.enable")}
      </Button>
      <Button size="xs" variant="outline" onClick={() => handleOpenEdit(server)}>{t("btn.edit")}</Button>
      <Button size="xs" variant="destructive" onClick={() => { setDeleteTarget(server.name); setConfirmOpen(true); }}>
        {t("btn.delete")}
      </Button>
    </div>
  </div>
  {/* Expandable tools section */}
  <Collapsible className="mt-2">
    <CollapsibleTrigger className="text-xs text-text-muted hover:text-text-primary">
      {t("column.tools")} ({server.toolsCount ?? 0})
    </CollapsibleTrigger>
    <CollapsibleContent>
      {/* Tool sub-cards — same as v1 */}
    </CollapsibleContent>
  </Collapsible>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/mcp.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentMcpPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentMcpPage").then((m) => ({ default: m.AgentMcpPage })),
);

export const Route = createFileRoute("/agent/_panel/mcp")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentMcpPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentMcpPage.tsx web/src/routes/agent/_panel/mcp.tsx
git commit -m "feat: create v2 AgentMcpPage with card-list UI"
```

---

### Task 11: AgentOrganizationsPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx`
- Create: `web/src/routes/agent/_panel/organizations.tsx`

- [ ] **Step 1: Create AgentOrganizationsPage component**

The v1 OrgsPage has a two-panel layout (org list left + detail right). For v2, adapt to card-list: left panel shows org cards, clicking one shows detail in the main area. Same API calls and member management functionality.

The org list uses card style:
```tsx
<button
  onClick={() => setSelectedOrgId(o.id)}
  className={`rounded-lg border px-4 py-3 text-left transition-colors ${
    o.id === selectedOrgId
      ? "border-brand bg-brand-subtle"
      : "border-border-light bg-surface-1 hover:border-border"
  }`}
>
  <div className="flex items-center gap-2">
    <RoleIcon role={o.role} />
    <span className="text-sm font-medium text-text-bright truncate">{o.name}</span>
  </div>
  <span className="text-[11px] text-text-dim">{t(`roles.${o.role}`, o.role)}</span>
</button>
```

The right detail panel shows org name (editable), member list with role management, and danger zone — same as v1.

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/organizations.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentOrganizationsPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentOrganizationsPage").then((m) => ({ default: m.AgentOrganizationsPage })),
);

export const Route = createFileRoute("/agent/_panel/organizations")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentOrganizationsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentOrganizationsPage.tsx web/src/routes/agent/_panel/organizations.tsx
git commit -m "feat: create v2 AgentOrganizationsPage with card-list UI"
```

---

### Task 12: AgentDashboardPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentDashboardPage.tsx`
- Create: `web/src/routes/agent/_panel/dashboard.tsx`

- [ ] **Step 1: Create AgentDashboardPage component**

The v1 Dashboard (in `web/src/routes/_app/index.tsx`) shows system overview. For v2, create a card-based dashboard with summary cards:
- Online agents count
- Active sessions count
- Recent activity
- Quick action links to other pages

This is a lighter page — grid of summary cards rather than a CRUD list.

```tsx
export function AgentDashboardPage() {
  const { t } = useTranslation("dashboard");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex-1 overflow-y-auto p-6">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {/* Summary cards */}
          <DashboardCard title={t("agents")} icon={Bot} count={agentCount} />
          <DashboardCard title={t("sessions")} icon={MessageSquare} count={sessionCount} />
          {/* ... more cards */}
        </div>
      </div>
    </div>
  );
}
```

Each `DashboardCard`:
```tsx
<div className="rounded-lg border border-border-light bg-surface-1 p-4 transition-colors hover:border-border hover:shadow-sm">
  <div className="flex items-center gap-3">
    <div className="w-10 h-10 rounded-lg bg-brand-subtle flex items-center justify-center">
      <Icon className="w-5 h-5 text-brand" />
    </div>
    <div>
      <p className="text-2xl font-bold text-text-bright">{count}</p>
      <p className="text-xs text-text-muted">{title}</p>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/dashboard.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentDashboardPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentDashboardPage").then((m) => ({ default: m.AgentDashboardPage })),
);

export const Route = createFileRoute("/agent/_panel/dashboard")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentDashboardPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentDashboardPage.tsx web/src/routes/agent/_panel/dashboard.tsx
git commit -m "feat: create v2 AgentDashboardPage with summary cards"
```

---

### Task 13: AgentWorkflowsPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentWorkflowsPage.tsx`
- Create: `web/src/routes/agent/_panel/workflow.tsx`

- [ ] **Step 1: Create AgentWorkflowsPage component**

The v1 WorkflowPage uses React Flow for visual editing. For v2, the workflow page should embed the same WorkflowPage component since the React Flow canvas is already self-contained. The difference is just the wrapper (no Topbar, uses AgentPageHeader instead).

```tsx
export function AgentWorkflowsPage() {
  const { t } = useTranslation("workflows");

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <AgentPageHeader title={t("title")} subtitle={t("subtitle")} />
      <div className="flex-1 min-h-0">
        <WorkflowPage />
      </div>
    </div>
  );
}
```

Note: This reuses the v1 `WorkflowPage` component directly inside the v2 layout. The workflow editor is a complex component that doesn't benefit from card-list conversion.

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/workflow.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentWorkflowsPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentWorkflowsPage").then((m) => ({ default: m.AgentWorkflowsPage })),
);

export const Route = createFileRoute("/agent/_panel/workflow")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentWorkflowsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentWorkflowsPage.tsx web/src/routes/agent/_panel/workflow.tsx
git commit -m "feat: create v2 AgentWorkflowsPage (wraps v1 WorkflowPage)"
```

---

### Task 14: AgentSessionsPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentSessionsPage.tsx`
- Create: `web/src/routes/agent/_panel/sessions.tsx`

- [ ] **Step 1: Create AgentSessionsPage component**

Session list page with card layout. Each session card shows: session ID, agent name, status badge, creation time, CWD. Actions: view detail (navigate to chat). Uses same API as v1 environments/sessions endpoints.

```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-center gap-3">
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm font-medium text-text-bright">{session.id}</span>
        <StatusBadge status={session.status} />
      </div>
      <p className="text-xs text-text-secondary mt-1">{session.agentName} · {session.cwd}</p>
    </div>
    <span className="text-xs text-text-muted">{formatTimestamp(session.createdAt)}</span>
    <Button size="xs" variant="outline" onClick={() => navigate({ to: "/agent/chat/$agentId/$sessionId", params: { agentId: session.agentId, sessionId: session.id } })}>
      {t("actions.view")}
    </Button>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/sessions.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentSessionsPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentSessionsPage").then((m) => ({ default: m.AgentSessionsPage })),
);

export const Route = createFileRoute("/agent/_panel/sessions")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentSessionsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentSessionsPage.tsx web/src/routes/agent/_panel/sessions.tsx
git commit -m "feat: create v2 AgentSessionsPage with card-list UI"
```

---

### Task 15: AgentKnowledgeBasesPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx`
- Create: `web/src/routes/agent/_panel/knowledge-bases.tsx`

- [ ] **Step 1: Create AgentKnowledgeBasesPage component**

Knowledge base management with card layout. Each KB card shows: name, slug, description, resource count. Actions: edit, delete. Header has "Create Knowledge Base" button.

```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-center gap-3">
    <div className="flex-1 min-w-0">
      <span className="text-sm font-medium text-text-bright">{kb.name}</span>
      <p className="text-xs text-text-muted">{kb.slug}</p>
      {kb.description && <p className="text-sm text-text-secondary mt-1 line-clamp-1">{kb.description}</p>}
    </div>
    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button size="xs" variant="outline" onClick={() => handleEdit(kb)}>{t("btn.edit")}</Button>
      <Button size="xs" variant="destructive" onClick={() => handleDelete(kb)}>{t("btn.delete")}</Button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/knowledge-bases.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentKnowledgeBasesPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentKnowledgeBasesPage").then((m) => ({ default: m.AgentKnowledgeBasesPage })),
);

export const Route = createFileRoute("/agent/_panel/knowledge-bases")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentKnowledgeBasesPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx web/src/routes/agent/_panel/knowledge-bases.tsx
git commit -m "feat: create v2 AgentKnowledgeBasesPage with card-list UI"
```

---

### Task 16: AgentTasksPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentTasksPage.tsx`
- Create: `web/src/routes/agent/_panel/tasks.tsx`

- [ ] **Step 1: Create AgentTasksPage component**

Scheduled tasks management with card layout. Each task card shows: name, cron expression, environment name, status badge (enabled/disabled), last run time, next run time, last result. Actions: edit, view logs, execute now, enable/disable, delete.

```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-start gap-3">
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-bright">{task.name}</span>
        <StatusBadge status={task.enabled ? "enabled" : "disabled"} />
      </div>
      <div className="flex items-center gap-3 mt-1 text-xs text-text-muted">
        <code className="bg-surface-2 px-1.5 py-0.5 rounded">{task.cron}</code>
        <span>{task.environmentName ?? task.environmentId}</span>
      </div>
      <div className="flex items-center gap-3 mt-1 text-xs text-text-dim">
        <span>Last: {formatTimestamp(task.lastRunAt)}</span>
        <span>Next: {formatTimestamp(task.nextRunAt)}</span>
        <span>Result: {formatLastResult(t, task)}</span>
      </div>
    </div>
    <div className="flex flex-wrap gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button size="xs" variant="outline" onClick={() => handleOpenEdit(task)}>{t("actions.edit")}</Button>
      <Button size="xs" variant="outline" onClick={() => handleViewLogs(task)}>{t("actions.logs")}</Button>
      <Button size="xs" variant="outline" disabled={triggering === task.id} onClick={() => handleTrigger(task)}>
        {t("actions.executeNow")}
      </Button>
      <Button size="xs" variant="outline" onClick={() => handleToggle(task)}>
        {task.enabled ? t("actions.disable") : t("actions.enable")}
      </Button>
      <Button size="xs" variant="destructive" onClick={() => handleDelete(task)}>{t("actions.delete")}</Button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/tasks.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentTasksPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentTasksPage").then((m) => ({ default: m.AgentTasksPage })),
);

export const Route = createFileRoute("/agent/_panel/tasks")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentTasksPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentTasksPage.tsx web/src/routes/agent/_panel/tasks.tsx
git commit -m "feat: create v2 AgentTasksPage with card-list UI"
```

---

### Task 17: AgentChannelsPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentChannelsPage.tsx`
- Create: `web/src/routes/agent/_panel/channels.tsx`

- [ ] **Step 1: Create AgentChannelsPage component**

Channel management with card layout. Each channel card shows: name, type badge, status, connection info. Actions: edit, delete. Same API as v1 ChannelsPage.

```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-center gap-3">
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-bright">{channel.name}</span>
        {/* Type badge */}
      </div>
    </div>
    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button size="xs" variant="outline" onClick={() => handleEdit(channel)}>{t("btn.edit")}</Button>
      <Button size="xs" variant="destructive" onClick={() => handleDelete(channel)}>{t("btn.delete")}</Button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/channels.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentChannelsPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentChannelsPage").then((m) => ({ default: m.AgentChannelsPage })),
);

export const Route = createFileRoute("/agent/_panel/channels")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentChannelsPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentChannelsPage.tsx web/src/routes/agent/_panel/channels.tsx
git commit -m "feat: create v2 AgentChannelsPage with card-list UI"
```

---

### Task 18: AgentApiKeysPage

**Files:**
- Create: `web/src/pages/agent-panel/pages/AgentApiKeysPage.tsx`
- Create: `web/src/routes/agent/_panel/apikeys.tsx`

- [ ] **Step 1: Create AgentApiKeysPage component**

API key management with card layout. Each key card shows: name, prefix hint, creation date, expiration status. Actions: copy key (on create), revoke/delete. Same API as v1 ApiKeyManager.

```tsx
<div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
  <div className="flex items-center gap-3">
    <div className="flex-1 min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium text-text-bright">{key.name}</span>
        <span className="font-mono text-xs text-text-muted bg-surface-2 px-1.5 py-0.5 rounded">{key.prefix}...</span>
      </div>
      <p className="text-xs text-text-dim mt-1">Created {formatDate(key.createdAt)}</p>
    </div>
    <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
      <Button size="xs" variant="destructive" onClick={() => handleRevoke(key)}>{t("btn.revoke")}</Button>
    </div>
  </div>
</div>
```

- [ ] **Step 2: Create route file**

```tsx
// web/src/routes/agent/_panel/apikeys.tsx
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const AgentApiKeysPage = lazy(() =>
  import("../../../pages/agent-panel/pages/AgentApiKeysPage").then((m) => ({ default: m.AgentApiKeysPage })),
);

export const Route = createFileRoute("/agent/_panel/apikeys")({
  component: () => (
    <Suspense fallback={<div className="flex flex-1 items-center justify-center"><div className="h-8 w-8 rounded-full border-2 border-brand border-t-transparent animate-spin" /></div>}>
      <AgentApiKeysPage />
    </Suspense>
  ),
});
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/pages/AgentApiKeysPage.tsx web/src/routes/agent/_panel/apikeys.tsx
git commit -m "feat: create v2 AgentApiKeysPage with card-list UI"
```

---

## Phase 4: Integration & Verification

### Task 19: Update AgentSidebarConfig dropdown to use v2 routes

**Files:**
- Modify: `web/src/pages/agent-panel/AgentSidebarConfig.tsx`

- [ ] **Step 1: Verify all NAV_GROUPS items navigate to internal v2 routes**

The dropdown menu items (dashboard, workflow, session, knowledge-bases, tasks, channels, apikeys) already use `onNavigate(pageId)` which calls `navigate({ to: `/agent/${pageId}` })` in `AgentPanelLayout`. This is correct — no further changes needed since `handleNavigate` in `AgentPanelLayout` already maps to `/agent/${pageId}`.

Verify that all page IDs in `QUICK_NAV` and `NAV_GROUPS` match the route file names:
- `models` → `_panel/models.tsx` ✓
- `skills` → `_panel/skills.tsx` ✓
- `mcp` → `_panel/mcp.tsx` ✓
- `organizations` → `_panel/organizations.tsx` ✓
- `dashboard` → `_panel/dashboard.tsx` ✓
- `workflow` → `_panel/workflow.tsx` ✓
- `session` → `_panel/sessions.tsx` ✓ (note: "session" in nav vs "sessions" in route — fix needed)
- `knowledge-bases` → `_panel/knowledge-bases.tsx` ✓
- `tasks` → `_panel/tasks.tsx` ✓
- `channels` → `_panel/channels.tsx` ✓
- `apikeys` → `_panel/apikeys.tsx` ✓

Fix the mismatch: `session` in NAV_GROUPS should be `sessions` to match the route file name.

- [ ] **Step 2: Fix session nav ID**

In `AgentSidebarConfig.tsx`, change:
```tsx
{ id: "session", labelKey: "agentPanel:sessions", icon: MessageSquare },
```
to:
```tsx
{ id: "sessions", labelKey: "agentPanel:sessions", icon: MessageSquare },
```

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/AgentSidebarConfig.tsx
git commit -m "fix: align session nav ID with route file name"
```

---

### Task 20: Build verification and typecheck

- [ ] **Step 1: Run typecheck**

Run: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run typecheck 2>&1`
Expected: No type errors

- [ ] **Step 2: Run lint**

Run: `bun run lint 2>&1`
Expected: No lint errors (warnings for `noExplicitAny` in test files are acceptable)

- [ ] **Step 3: Build frontend**

Run: `bun run build:web 2>&1`
Expected: Build succeeds with no errors. `routeTree.gen.ts` is auto-regenerated with all new routes.

- [ ] **Step 4: Verify route tree includes all new routes**

Run: `grep -E "(agent/_panel|agent/chat)" web/src/routeTree.gen.ts | head -20`
Expected: All new routes are registered:
- `agent/_panel` (layout)
- `agent/_panel/` (index)
- `agent/_panel/chat/$agentId`
- `agent/_panel/chat/$agentId/$sessionId`
- `agent/_panel/models`
- `agent/_panel/skills`
- `agent/_panel/mcp`
- `agent/_panel/organizations`
- `agent/_panel/dashboard`
- `agent/_panel/workflow`
- `agent/_panel/sessions`
- `agent/_panel/knowledge-bases`
- `agent/_panel/tasks`
- `agent/_panel/channels`
- `agent/_panel/apikeys`

- [ ] **Step 5: Run frontend tests**

Run: `bun test web/src/__tests__/ 2>&1`
Expected: All existing tests pass (new pages don't break existing tests)

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "feat: v2 agent panel SPA pages — all config pages with card-list UI

- Create AgentPanelLayout with AgentSidebar + Outlet
- Add pathless layout route (_panel.tsx) for all v2 pages
- Chat routes: /agent/chat/:agentId, /agent/chat/:agentId/:sessionId
- Config routes: /agent/models, /agent/skills, /agent/mcp, etc.
- Backward compat redirects: /agent/:agentId → /agent/chat/:agentId
- 11 new page components with card-list UI (not DataTable)
- Shared components: AgentPageHeader, AgentCardList
- Sidebar active state highlight based on current route
- v1 preserved, v2 is primary entry point"
```
