# Unified Artifacts Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge ChatInterface's ContextPanel and ArtifactsPanel into a single unified right-side panel with a compact status header, a single "Files" tab, and a split file-tree + preview layout.

**Architecture:** Remove ContextPanel from ChatInterface (pass `hideContextPanel={true}` from ACPMain). Create a new `ArtifactsPanel` that renders a compact single-line status bar at the top (agent name, model, status, token progress), followed by a single "Files" tab containing a horizontal split of `FileTreeTab` (left) and `PreviewTab` (right). Lift session stats data from ChatInterface up through callbacks to AgentAppShell, then pass into ArtifactsPanel.

**Tech Stack:** React, TypeScript, Tailwind CSS, @pierre/trees (file tree), react-i18next

---

### Task 1: Add stats callback to ChatInterface to lift entries data up

**Files:**
- Modify: `web/components/ChatInterface.tsx:62-72` (props interface)
- Modify: `web/components/ChatInterface.tsx:160-162` (handle interface)
- Modify: `web/components/ChatInterface.tsx:600` (useImperativeHandle)
- Modify: `web/components/ChatInterface.tsx:164` (component signature)

- [ ] **Step 1: Add `onStatsChange` callback prop and expose entries via imperative handle**

In `ChatInterfaceProps`, add:
```typescript
onStatsChange?: (stats: {
  entries: ThreadEntry[];
  agentName?: string;
  modelName?: string;
}) => void;
```

In `ChatInterfaceHandle`, add:
```typescript
getEntries: () => ThreadEntry[];
```

In the component, add a `useEffect` that calls `onStatsChange` whenever `entries` changes:
```typescript
useEffect(() => {
  onStatsChange?.({
    entries,
    agentName: agentId,
    modelName: client.modelState
      ? client.modelState.availableModels.find(
          (m) => m.modelId === client.modelState!.currentModelId,
        )?.name ?? client.modelState.currentModelId
      : undefined,
  });
}, [entries, agentId, client.modelState, onStatsChange]);
```

Update `useImperativeHandle`:
```typescript
useImperativeHandle(ref, () => ({
  newSession: handleNewSession,
  getEntries: () => entries,
}), [handleNewSession, entries]);
```

- [ ] **Step 2: Build and verify no type errors**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds (no new errors from the added prop)

- [ ] **Step 3: Commit**

```bash
git add web/components/ChatInterface.tsx
git commit -m "feat: add onStatsChange callback and getEntries to ChatInterface"
```

---

### Task 2: Pass stats from ACPMain/ChatPanel up to AgentAppShell

**Files:**
- Modify: `web/src/pages/agent-panel/ChatPanel.tsx` (add onStatsChange prop)
- Modify: `web/components/ACPMain.tsx:11-19` (add onStatsChange prop)
- Modify: `web/components/ACPMain.tsx:240` (pass onStatsChange to ChatInterface)
- Modify: `web/src/pages/agent-panel/AgentAppShell.tsx` (receive stats state)

- [ ] **Step 1: Thread `onStatsChange` through ChatPanel → ACPMain → AgentAppShell**

In `ChatPanel.tsx`, add `onStatsChange` prop and pass through to `ACPMain`:
```typescript
interface ChatPanelProps {
  agentId: string | null;
  sessionId?: string | null;
  initialCwd?: string;
  hideSidebar?: boolean;
  onClientChange?: (client: ACPClient | null) => void;
  scenePrompt?: string;
  onStatsChange?: (stats: {
    entries: ThreadEntry[];
    agentName?: string;
    modelName?: string;
  }) => void;
}
```

Pass `onStatsChange` to `ACPMain`:
```tsx
<ACPMain
  client={client}
  agentId={agentId}
  initialCwd={initialCwd}
  hideSidebar={hideSidebar}
  rcsSessionId={sessionId ?? undefined}
  scenePrompt={scenePrompt}
  onStatsChange={onStatsChange}
/>
```

In `ACPMain.tsx`, add `onStatsChange` prop and pass to `ChatInterface`:
```typescript
interface ACPMainProps {
  // ... existing props
  onStatsChange?: (stats: {
    entries: ThreadEntry[];
    agentName?: string;
    modelName?: string;
  }) => void;
}
```

At line 240, add `onStatsChange` to `ChatInterface`:
```tsx
<ChatInterface ... onStatsChange={onStatsChange} />
```

In `AgentAppShell.tsx`, add state and pass down:
```typescript
import type { ThreadEntry } from "../../../src/lib/types";

// Inside component:
const [sessionStats, setSessionStats] = useState<{
  entries: ThreadEntry[];
  agentName?: string;
  modelName?: string;
} | null>(null);
```

Pass to `ChatPanel`:
```tsx
<ChatPanel
  agentId={selectedAgentId}
  sessionId={currentSessionId}
  onStatsChange={setSessionStats}
/>
```

Pass to `ArtifactsPanel`:
```tsx
<ArtifactsPanel
  collapsed={artifactsCollapsed}
  onToggleCollapse={() => setArtifactsCollapsed(!artifactsCollapsed)}
  envId={selectedAgentId}
  stats={sessionStats}
/>
```

- [ ] **Step 2: Build and verify**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/ChatPanel.tsx web/components/ACPMain.tsx web/src/pages/agent-panel/AgentAppShell.tsx
git commit -m "feat: lift session stats from ChatInterface to AgentAppShell via callbacks"
```

---

### Task 3: Create compact StatusHeader component

**Files:**
- Create: `web/src/components/agent-panel/StatusHeader.tsx`
- Modify: `web/src/i18n/locales/en/agentPanel.json`
- Modify: `web/src/i18n/locales/zh/agentPanel.json`

- [ ] **Step 1: Create StatusHeader component**

Create `web/src/components/agent-panel/StatusHeader.tsx`:
```typescript
import { useMemo } from "react";
import type { ThreadEntry, ToolCallEntry } from "../../../src/lib/types";

interface StatusHeaderProps {
  agentName?: string;
  modelName?: string;
  entries?: ThreadEntry[];
}

export function StatusHeader({ agentName, modelName, entries = [] }: StatusHeaderProps) {
  const stats = useMemo(() => computeStats(entries), [entries]);
  const displayName = useMemo(() => {
    if (!agentName) return "—";
    if (agentName.startsWith("env_")) return agentName.length > 14 ? agentName.slice(0, 14) + "…" : agentName;
    if (agentName.length > 18) return agentName.slice(0, 16) + "…";
    return agentName;
  }, [agentName]);

  const tokenPercent = stats.estimatedTokens > 0 ? Math.min((stats.estimatedTokens / 200000) * 100, 100) : 0;
  const inputPercent = stats.estimatedInputTokens > 0 ? (stats.estimatedInputTokens / 200000) * 100 : 0;
  const outputPercent = stats.estimatedOutputTokens > 0 ? (stats.estimatedOutputTokens / 200000) * 100 : 0;

  return (
    <div className="px-3 py-2 border-b border-border flex items-center gap-2 text-[11px] shrink-0"
      style={{ background: "linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 5%, transparent) 0%, transparent 60%)" }}>
      {/* Agent icon */}
      <div
        className="w-5 h-5 rounded flex items-center justify-center text-[10px] shrink-0"
        style={{
          background: "color-mix(in srgb, var(--color-brand) 10%, transparent)",
          border: "1px solid color-mix(in srgb, var(--color-brand) 18%, transparent)",
        }}>
        ⬡
      </div>

      {/* Name + model */}
      <span className="font-semibold text-text-primary truncate max-w-[100px]">{displayName}</span>
      <span className="text-text-muted truncate max-w-[80px] font-mono">{modelName || "—"}</span>

      {/* Running dot */}
      <span className="w-1.5 h-1.5 rounded-full bg-accent-green animate-[status-active-pulse_2s_ease-in-out_infinite] shrink-0"
        style={{ boxShadow: "0 0 4px color-mix(in srgb, var(--color-accent-green) 40%, transparent)" }} />

      {/* Token count + progress bar */}
      <span className="font-mono font-semibold text-text-secondary ml-auto shrink-0">
        {formatTokenCount(stats.estimatedTokens)}/200k
      </span>
      <div className="w-16 h-1 rounded-sm bg-surface-3 overflow-hidden flex shrink-0">
        <div className="h-full bg-brand transition-[width] duration-500 ease" style={{ width: `${inputPercent}%` }} />
        <div className="h-full bg-accent-green transition-[width] duration-500 ease" style={{ width: `${outputPercent}%` }} />
      </div>
    </div>
  );
}

function computeStats(entries: ThreadEntry[]) {
  let totalChars = 0;
  let inputChars = 0;
  let outputChars = 0;

  for (const entry of entries) {
    if (entry.type === "assistant_message") {
      const text = entry.chunks.reduce((sum, c) => sum + (c.text?.length || 0), 0);
      outputChars += text;
      totalChars += text;
    }
    if (entry.type === "user_message") {
      const text = entry.content?.length || 0;
      inputChars += text;
      totalChars += text;
    }
    if (entry.type === "tool_call") {
      const rawOutput = (entry as ToolCallEntry).toolCall.rawOutput;
      if (rawOutput) {
        const text = JSON.stringify(rawOutput).length;
        outputChars += text;
        totalChars += text;
      }
    }
  }

  return {
    estimatedTokens: Math.round(totalChars / 4),
    estimatedInputTokens: Math.round(inputChars / 4),
    estimatedOutputTokens: Math.round(outputChars / 4),
  };
}

function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
```

- [ ] **Step 2: Update i18n (no new keys needed for StatusHeader, it's all computed)**

No new i18n keys are needed — StatusHeader uses no translatable strings (agent name/model are dynamic data).

- [ ] **Step 3: Build and verify**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/src/components/agent-panel/StatusHeader.tsx
git commit -m "feat: create compact StatusHeader component for unified panel"
```

---

### Task 4: Rewrite ArtifactsPanel — unified layout with split file-tree + preview

**Files:**
- Modify: `web/src/pages/agent-panel/ArtifactsPanel.tsx` (major rewrite)
- Modify: `web/src/pages/agent-panel/agent-panel.css` (add split layout styles)

- [ ] **Step 1: Rewrite ArtifactsPanel**

Replace the entire content of `web/src/pages/agent-panel/ArtifactsPanel.tsx`:

```typescript
import { useCallback, useEffect, useRef, useState } from "react";
import { X, FolderTree } from "lucide-react";
import { useTranslation } from "react-i18next";
import { NS } from "../../i18n";
import type { ThreadEntry } from "../../../src/lib/types";
import { FileTreeTab } from "../../components/agent-panel/FileTreeTab";
import { PreviewTab } from "../../components/agent-panel/PreviewTab";
import { StatusHeader } from "../../components/agent-panel/StatusHeader";

interface SessionStats {
  entries: ThreadEntry[];
  agentName?: string;
  modelName?: string;
}

interface ArtifactsPanelProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  envId: string | null;
  stats?: SessionStats | null;
}

export function ArtifactsPanel({ collapsed, onToggleCollapse, envId, stats }: ArtifactsPanelProps) {
  const { t } = useTranslation(NS.AGENT_PANEL);
  const [previewFilePath, setPreviewFilePath] = useState<string | null>(null);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem("agent-panel:artifacts-width");
    return saved ? Number(saved) : 400;
  });

  const resizingRef = useRef(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(0);

  useEffect(() => {
    localStorage.setItem("agent-panel:artifacts-width", String(width));
  }, [width]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      resizingRef.current = true;
      startXRef.current = e.clientX;
      startWidthRef.current = width;

      const handleMouseMove = (ev: MouseEvent) => {
        if (!resizingRef.current) return;
        const delta = startXRef.current - ev.clientX;
        const newWidth = Math.min(600, Math.max(300, startWidthRef.current + delta));
        setWidth(newWidth);
      };

      const handleMouseUp = () => {
        resizingRef.current = false;
        document.removeEventListener("mousemove", handleMouseMove);
        document.removeEventListener("mouseup", handleMouseUp);
      };

      document.addEventListener("mousemove", handleMouseMove);
      document.addEventListener("mouseup", handleMouseUp);
    },
    [width],
  );

  const handlePreviewFile = useCallback((path: string) => {
    setPreviewFilePath(path);
  }, []);

  const handleReferenceFile = useCallback((path: string, name: string) => {
    window.dispatchEvent(
      new CustomEvent("file-tree:reference", {
        detail: { path, name },
      }),
    );
  }, []);

  if (collapsed) {
    return null;
  }

  return (
    <>
      {/* Resize handle */}
      <div className="agent-artifacts-resize-handle" style={{ left: 0 }} onMouseDown={handleMouseDown} />

      {/* Panel body */}
      <div className="agent-artifacts" style={{ width }}>
        {/* Status header — compact single line */}
        <StatusHeader
          agentName={stats?.agentName}
          modelName={stats?.modelName}
          entries={stats?.entries ?? []}
        />

        {/* Tab bar — single "Files" tab + close button */}
        <div className="agent-artifacts-tabs">
          <span className="agent-artifacts-tab active">
            <FolderTree className="inline h-3 w-3 mr-1" />
            {t("tabFiles")}
          </span>
          <button
            type="button"
            className="agent-artifacts-close-btn"
            onClick={onToggleCollapse}
            title={t("closePanel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Split content: file tree (left) + preview (right) */}
        <div className="agent-artifacts-split">
          <div className="agent-artifacts-tree-pane">
            <FileTreeTab
              envId={envId}
              onPreviewFile={handlePreviewFile}
              onReferenceFile={handleReferenceFile}
            />
          </div>
          <div className="agent-artifacts-preview-pane">
            <PreviewTab envId={envId} filePath={previewFilePath} />
          </div>
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 2: Add split layout CSS to agent-panel.css**

Append to `web/src/pages/agent-panel/agent-panel.css`:

```css
/* ---------- Artifacts split layout (tree + preview) ---------- */
.agent-artifacts-split {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-height: 0;
}

.agent-artifacts-tree-pane {
  width: 50%;
  min-width: 0;
  overflow: hidden;
  border-right: 1px solid var(--color-border-subtle);
}

.agent-artifacts-preview-pane {
  width: 50%;
  min-width: 0;
  overflow: hidden;
}
```

- [ ] **Step 3: Build and verify**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/agent-panel/ArtifactsPanel.tsx web/src/pages/agent-panel/agent-panel.css
git commit -m "feat: rewrite ArtifactsPanel with StatusHeader + split file-tree/preview layout"
```

---

### Task 5: Hide ContextPanel in ChatInterface when used in AgentAppShell

**Files:**
- Modify: `web/components/ACPMain.tsx:240` (already passes `hideContextPanel={hideSidebar}`, which is `true` from ChatPanel)

- [ ] **Step 1: Verify hideContextPanel is already true**

In `ACPMain.tsx` line 240, `hideContextPanel={hideSidebar}` is already set. When `ChatPanel` renders `ACPMain`, it passes `hideSidebar` which comes from `AgentAppShell` → `ChatPanel` prop. In the agent panel flow, `hideSidebar` defaults to `undefined` (falsy), so ContextPanel still shows.

Fix: In `ChatPanel.tsx`, when rendering `ACPMain` (line ~104), always pass `hideSidebar={true}` since the agent panel has its own sidebar:

```tsx
<ACPMain
  client={client}
  agentId={agentId}
  initialCwd={initialCwd}
  hideSidebar={true}
  rcsSessionId={sessionId ?? undefined}
  scenePrompt={scenePrompt}
  onStatsChange={onStatsChange}
/>
```

This ensures the session list sidebar inside ACPMain is hidden (AgentAppShell has its own AgentSidebar) AND the ContextPanel is hidden (replaced by the unified ArtifactsPanel).

- [ ] **Step 2: Build and verify**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/pages/agent-panel/ChatPanel.tsx
git commit -m "fix: always hide ACPMain sidebar and ContextPanel in agent panel layout"
```

---

### Task 6: Clean up unused i18n keys and imports

**Files:**
- Modify: `web/src/i18n/locales/en/agentPanel.json`
- Modify: `web/src/i18n/locales/zh/agentPanel.json`

- [ ] **Step 1: Remove unused tab keys**

Remove `tabPreview` and `tabContext` from both locale files since the panel now only has one tab ("Files").

In `en/agentPanel.json`, remove lines:
```json
"tabPreview": "Preview",
"tabContext": "Context",
```

In `zh/agentPanel.json`, remove lines:
```json
"tabPreview": "预览",
"tabContext": "上下文",
```

- [ ] **Step 2: Build and verify**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add web/src/i18n/locales/en/agentPanel.json web/src/i18n/locales/zh/agentPanel.json
git commit -m "chore: remove unused tabPreview/tabContext i18n keys"
```

---

### Task 7: Manual verification and polish

- [ ] **Step 1: Start dev server and verify visually**

Run: `bun run dev` and open the agent panel (`/ctrl/agent/:agentId`)

Check:
- [ ] Right panel shows compact status header (agent name, model, running dot, token progress bar) — all on one line
- [ ] Below the header, single "Files" tab with close button
- [ ] File tree on the left half, preview on the right half of the content area
- [ ] Clicking a file in the tree loads its content in the preview pane
- [ ] No ContextPanel visible inside the chat area
- [ ] No session list sidebar inside ACPMain (only AgentSidebar from AgentAppShell)
- [ ] Panel is resizable via drag handle
- [ ] Panel collapse/expand works correctly
- [ ] Token count updates as chat messages are exchanged

- [ ] **Step 2: Build for production**

Run: `bun run build:web 2>&1 | tail -5`
Expected: Build succeeds with no errors

- [ ] **Step 3: Final commit if any polish fixes were needed**

```bash
git add -A
git commit -m "fix: polish unified artifacts panel visual details"
```
