# Workflow Editor Meta Agent 左侧布局重构 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 WorkflowEditor 中的 MetaAgentPanel 从画布右侧移到左侧，toggle 按钮适配到右边缘

**Architecture:** 纯布局换位，3 个文件改动。WorkflowEditor 中交换 MetaAgentPanel 和画布 div 的顺序，MetaAgentPanel 中 toggle 按钮移到面板右边缘，CSS 中 border/border-radius 方向取反

**Tech Stack:** React 19, TypeScript, CSS (Tailwind v4 + app CSS)

---

## 文件结构

| 文件 | 操作 | 职责 |
|------|------|------|
| `web/src/pages/workflow/WorkflowEditor.tsx` | 修改 | 交换 MetaAgentPanel 与画布 div 的渲染顺序 |
| `web/components/MetaAgentPanel.tsx` | 修改 | toggle 按钮从面板左边缘移至右边缘，图标反转 |
| `web/src/index.css` | 修改 | `.meta-agent-toggle-btn` 的 border/border-radius 方向适配右边缘位置 |

---

### Task 1: 换位 — WorkflowEditor.tsx

**Files:**
- Modify: `web/src/pages/workflow/WorkflowEditor.tsx:508-509,917-925`

- [ ] **Step 1: 将 MetaAgentPanel 从末尾移到画布 div 之前**

当前外层 flex 容器结构（约第 508-938 行）：

```tsx
return (
    <div className="flex w-full h-full bg-surface-0">
      {/* 隐藏的 file input */}
      <input ... style={{ display: "none" }} />

      <div className="flex-1 relative overflow-hidden">
        {/* ReactFlow 画布 + Panels + Popovers */}
      </div>

      {/* 版本管理 Sheet */}
      <Sheet ...>...</Sheet>
      {/* 触发器 Sheet */}
      <Sheet ...>...</Sheet>

      {/* Meta Agent Chat 侧边栏 */}
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={scenePrompt}
        contextKey={contextKey}
        onPromptComplete={handleRefreshDraft}
      />

      {/* RunParamsDialog */}
      ...
    </div>
  );
```

将 `<MetaAgentPanel ... />` 块移动到画布 `<div className="flex-1 relative overflow-hidden">` 之前（紧随 `<input>` 之后）：

```tsx
return (
    <div className="flex w-full h-full bg-surface-0">
      {/* 隐藏的 file input */}
      <input ... style={{ display: "none" }} />

      {/* Meta Agent Chat 侧边栏 */}
      <MetaAgentPanel
        chatOpen={chatOpen}
        setChatOpen={setChatOpen}
        metaAgentId={metaAgentId}
        scenePrompt={scenePrompt}
        contextKey={contextKey}
        onPromptComplete={handleRefreshDraft}
      />

      <div className="flex-1 relative overflow-hidden">
        {/* ReactFlow 画布 + Panels + Popovers */}
      </div>

      {/* 版本管理 Sheet */}
      <Sheet ...>...</Sheet>
      {/* 触发器 Sheet */}
      <Sheet ...>...</Sheet>

      {/* RunParamsDialog */}
      ...
    </div>
  );
```

- [ ] **Step 2: 更新注释**

将 `{/* Meta Agent Chat 侧边栏 */}` 注释改为 `{/* Meta Agent Chat 左侧面板 */}`。

- [ ] **Step 3: 验证构建**

```bash
bun run build:web
```

预期：构建成功，无 TS 类型错误。

- [ ] **Step 4: 提交**

```bash
git add web/src/pages/workflow/WorkflowEditor.tsx
git commit -m "refactor(workflow): move MetaAgentPanel to left side of canvas"
```

---

### Task 2: Toggle 按钮换边 — MetaAgentPanel.tsx

**Files:**
- Modify: `web/components/MetaAgentPanel.tsx:39-82`

- [ ] **Step 1: 将 toggle 按钮从第一个子元素移到最后**

当前结构：

```tsx
export function MetaAgentPanel({...}: MetaAgentPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100%" }}>
      {/* 左侧拉手 — 始终渲染 */}
      <button
        type="button"
        className={`meta-agent-toggle-btn${chatOpen ? " open" : ""}`}
        onClick={() => setChatOpen(!chatOpen)}
        title={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
        aria-label={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
        aria-expanded={chatOpen}
      >
        {chatOpen ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
      </button>

      {/* 主面板 */}
      {chatOpen && (
        <div className="meta-agent-panel" style={{ width: 400, ... }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <ChatPanel ... />
          </div>
        </div>
      )}
    </div>
  );
}
```

改为：toggle 按钮移到主面板之后（flex 容器的最后一个子元素），同时反转图标方向：

```tsx
export function MetaAgentPanel({...}: MetaAgentPanelProps) {
  const { t } = useTranslation(NS.COMPONENTS);

  return (
    <div style={{ display: "flex", flexDirection: "row", height: "100%" }}>
      {/* 主面板 */}
      {chatOpen && (
        <div className="meta-agent-panel" style={{ width: 400, ... }}>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <ChatPanel ... />
          </div>
        </div>
      )}

      {/* 右侧拉手 — 始终渲染，位于聊天面板与画布之间 */}
      <button
        type="button"
        className={`meta-agent-toggle-btn${chatOpen ? " open" : ""}`}
        onClick={() => setChatOpen(!chatOpen)}
        title={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
        aria-label={chatOpen ? t("metaAgent.chat_collapse") : t("metaAgent.chat_expand")}
        aria-expanded={chatOpen}
      >
        {/* 展开时显示左箭头（收起聊天），收起时显示右箭头（展开聊天） */}
        {chatOpen ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
      </button>
    </div>
  );
}
```

**变更要点**：
1. 主面板块和 toggle 按钮块**交换位置**
2. 图标取反：
   - `chatOpen`：`ChevronRight` → `ChevronLeft`（展开时点击可收起）
   - `!chatOpen`：`ChevronLeft` → `ChevronRight`（收起时点击可展开）
3. 注释从"左侧拉手"改为"右侧拉手"

- [ ] **Step 2: 验证构建**

```bash
bun run build:web
```

预期：构建成功。

- [ ] **Step 3: 提交**

```bash
git add web/components/MetaAgentPanel.tsx
git commit -m "refactor(workflow): move MetaAgentPanel toggle to right edge, flip chevron icons"
```

---

### Task 3: CSS 适配 — index.css

**Files:**
- Modify: `web/src/index.css:826-850`

- [ ] **Step 1: 修改 .meta-agent-toggle-btn 样式**

当前样式（第 826-850 行）：

```css
/* 左侧拉手按钮 — 仿照 .agent-artifacts-expand-btn 的 vertical tab 设计
   按钮作为 flex item 渲染在最左侧，圆角朝外（左）、右侧贴面板（无边框无圆角） */
.meta-agent-toggle-btn {
  align-self: center;
  width: 28px;
  height: 56px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid var(--color-border-subtle);
  border-right: none;
  border-radius: 6px 0 0 6px;
  background: var(--color-surface-1);
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background 150ms,
    color 150ms;
  font-size: 10px;
  font-weight: 500;
  writing-mode: vertical-lr;
  letter-spacing: 0.05em;
}
```

改为：

```css
/* 右侧拉手按钮 — 仿照 .agent-artifacts-expand-btn 的 vertical tab 设计
   按钮作为 flex item 渲染在面板右侧，圆角朝外（右）、左侧贴面板（无边框无圆角） */
.meta-agent-toggle-btn {
  align-self: center;
  width: 28px;
  height: 56px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px solid var(--color-border-subtle);
  border-left: none;
  border-radius: 0 6px 6px 0;
  background: var(--color-surface-1);
  color: var(--color-text-muted);
  cursor: pointer;
  transition:
    background 150ms,
    color 150ms;
  font-size: 10px;
  font-weight: 500;
  writing-mode: vertical-lr;
  letter-spacing: 0.05em;
}
```

**变更要点**：
- `border-right: none` → `border-left: none`（贴面板侧无边框）
- `border-radius: 6px 0 0 6px` → `border-radius: 0 6px 6px 0`（外侧圆角）

- [ ] **Step 2: 验证构建**

```bash
bun run build:web
```

预期：构建成功。

- [ ] **Step 3: 提交**

```bash
git add web/src/index.css
git commit -m "refactor(workflow): flip meta-agent-toggle-btn border/border-radius for right edge"
```

---

### Task 4: precheck + 最终验证

- [ ] **Step 1: 运行 precheck**

```bash
bun run precheck
```

预期：tsc + biome check 全部通过。

- [ ] **Step 2: 运行前端测试**

```bash
bun test web/src/__tests__/
```

预期：所有测试通过（本次改动不涉及功能变更，因此不应引入测试失败）。

- [ ] **Step 3: 提交（如有 format/import 排序自动修复产物）**

```bash
git add -u
git commit -m "chore: precheck auto-fixes for MetaAgentPanel left-move"
```
