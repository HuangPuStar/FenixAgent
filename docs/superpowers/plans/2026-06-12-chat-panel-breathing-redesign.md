# Chat 面板呼吸感重设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Agent Chat 页面右侧区域（StatusHeader / Session List / Chat / Artifacts）从贴边硬边框风格改为浮动圆角卡片 + 浅灰 canvas 背景，Chat 消息区与背景同层。

**Architecture:** 纯 CSS + 类名调整，不涉及业务逻辑和组件 API。通过 `.agent-panel-content` 的 `padding + gap` 统一管理间距，避免子元素各自设 margin 累加。AgentSidebar（外层深蓝）完全不动。

**Tech Stack:** React 19 + Tailwind CSS v4 + 原生 CSS（`agent-panel.css`）+ lucide-react 图标

**Spec:** `docs/superpowers/specs/2026-06-12-chat-panel-breathing-redesign-design.md`

---

## 文件结构

本次改动涉及 3 个文件：

| 文件 | 角色 | 改动类型 |
|------|------|----------|
| `web/src/pages/agent-panel/agent-panel.css` | 三栏布局核心样式 | 新增 CSS 变量 + 修改 6 个选择器 |
| `web/src/components/agent-panel/StatusHeader.tsx` | 顶部状态栏组件 | 类名替换 |
| `web/components/ACPMain.tsx` | 内层 Session List + Chat 容器 | 类名替换 + 添加 gap |

**不动**：
- `AgentSidebar.tsx`（外层深蓝左侧栏）
- `ChatInterface.tsx`（聊天内部行为）
- `ArtifactsPanel.tsx`（Artifacts 组件逻辑层）
- `web/src/routes/agent/_panel/chat.$agentId.tsx`（折叠按钮已在 `.agent-panel-content` 内部，无需 JSX 改动，仅 CSS 定位调整）
- 所有后端代码

---

## Task 1: 新增 CSS 变量 + canvas 背景

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css:1-15`（`:root` 变量区）
- Modify: `web/src/pages/agent-panel/agent-panel.css:26-32`（`.agent-panel-body`）

- [ ] **Step 1: 在 `:root` 变量区追加 canvas 和 shadow 变量**

打开 `web/src/pages/agent-panel/agent-panel.css`，找到第 6-15 行的 `:root` 块：

```css
:root {
  --agent-sidebar-width: 240px;
  --agent-sidebar-collapsed: 64px;
  --agent-artifacts-width: 360px;
  --agent-artifacts-min: 280px;
  --agent-artifacts-max: 700px;
  --agent-sidebar-from: #1759dc;
  --agent-sidebar-to: #0d2a6e;
  --agent-sidebar-cyan: #6be6ff;
}
```

在 `}` 之前追加两个新变量，结果如下：

```css
:root {
  --agent-sidebar-width: 240px;
  --agent-sidebar-collapsed: 64px;
  --agent-artifacts-width: 360px;
  --agent-artifacts-min: 280px;
  --agent-artifacts-max: 700px;
  --agent-sidebar-from: #1759dc;
  --agent-sidebar-to: #0d2a6e;
  --agent-sidebar-cyan: #6be6ff;
  --color-canvas: #f5f6f8;
  --shadow-card: 0 4px 12px -6px rgba(15, 23, 42, 0.10);
}
```

- [ ] **Step 2: 在 `:root` 块之后追加暗色模式变量**

紧跟 `:root` 块之后（原第 15 行 `}` 之后），插入：

```css
:root.dark {
  --color-canvas: #1a1d23;
  --shadow-card: 0 4px 12px -6px rgba(0, 0, 0, 0.30);
}
```

- [ ] **Step 3: 给 `.agent-panel-body` 添加 canvas 背景**

找到 `.agent-panel-body`（约第 26 行）：

```css
.agent-panel-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
}
```

在 `overflow: hidden;` 之后追加 `background`：

```css
.agent-panel-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--color-canvas);
}
```

- [ ] **Step 4: 启动 dev server 视觉验证**

Run: `bun run dev:web`

打开浏览器访问任意 chat 页面（如 `/agent/chat/<某个 agentId>`），确认：
- AgentSidebar 仍是深蓝渐变（未改动）
- 右侧整体区域底色从纯白变为浅灰（`#f5f6f8`）
- 暗色模式切换后底色为深灰

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/agent-panel/agent-panel.css
git commit -m "feat(chat): 新增 canvas 背景与卡片阴影 CSS 变量"
```

---

## Task 2: `.agent-panel-content` 添加 padding + gap

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css:35-40`（`.agent-panel-content`）

- [ ] **Step 1: 给 `.agent-panel-content` 添加 padding 和 gap**

找到 `.agent-panel-content`（约第 35 行）：

```css
.agent-panel-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
```

追加 `padding` 和 `gap`：

```css
.agent-panel-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px;
  gap: 12px;
}
```

- [ ] **Step 2: 视觉验证**

刷新浏览器，确认：
- 右侧三列（Session List + Chat + Artifacts）整体四周有 12px 浅灰留白
- Session List 与 Chat 之间、Chat 与 Artifacts 之间各有 12px 间距
- 注意：此时 Session List 和 Artifacts 还是贴边样式（带 border），下一步才改成卡片

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/agent-panel.css
git commit -m "feat(chat): agent-panel-content 添加 padding 和 gap 形成留白"
```

---

## Task 3: `.agent-chat-area` 透明背景

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css:425-431`（`.agent-chat-area`）

- [ ] **Step 1: 给 `.agent-chat-area` 添加透明背景**

找到 `.agent-chat-area`（约第 425 行）：

```css
.agent-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

追加 `background: transparent`：

```css
.agent-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: transparent;
}
```

- [ ] **Step 2: 视觉验证**

刷新浏览器，确认 Chat 消息区底色与 canvas 一致（浅灰），不再有独立的白色背景。

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/agent-panel.css
git commit -m "feat(chat): chat-area 改为透明背景，与 canvas 同层"
```

---

## Task 4: `.agent-artifacts` 改为浮动圆角卡片

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css:434-448`（`.agent-artifacts`）

- [ ] **Step 1: 修改 `.agent-artifacts` 样式**

找到 `.agent-artifacts`（约第 434 行）：

```css
.agent-artifacts {
  width: var(--agent-artifacts-width);
  min-width: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--color-border-subtle);
  background: var(--color-surface-1);
  transition:
    width 300ms cubic-bezier(0.4, 0, 0.2, 1),
    min-width 300ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 200ms ease;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}
```

替换为（移除 `border-left`，增加 `border-radius: 12px` 与 `box-shadow`；圆角值 12px 与 Tailwind `rounded-xl` 对齐，保持三张卡片视觉一致）：

```css
.agent-artifacts {
  width: var(--agent-artifacts-width);
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--color-surface-1);
  border-radius: 12px;
  box-shadow: var(--shadow-card);
  transition:
    width 300ms cubic-bezier(0.4, 0, 0.2, 1),
    min-width 300ms cubic-bezier(0.4, 0, 0.2, 1),
    opacity 200ms ease;
  overflow: hidden;
  flex-shrink: 0;
  position: relative;
}
```

- [ ] **Step 2: 视觉验证**

刷新浏览器，确认：
- Artifacts 面板四角变为 12px 圆角（与 StatusHeader / Session List 的 `rounded-xl` 一致）
- 左侧硬边框线消失
- 卡片有轻微阴影浮起感
- 折叠/展开 Artifacts 功能仍正常工作

- [ ] **Step 3: 提交**

```bash
git add web/src/pages/agent-panel/agent-panel.css
git commit -m "feat(chat): artifacts 改为浮动圆角卡片"
```

---

## Task 5: StatusHeader 改为浮动圆角卡片

**Files:**
- Modify: `web/src/components/agent-panel/StatusHeader.tsx:22-28`

- [ ] **Step 1: 替换 StatusHeader 根 div 的 className 和 style**

打开 `web/src/components/agent-panel/StatusHeader.tsx`，找到第 22-28 行：

```tsx
    <div
      className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0"
      style={{
        background:
          "linear-gradient(135deg, color-mix(in srgb, var(--color-brand) 5%, transparent) 0%, transparent 60%)",
      }}
    >
```

替换为（移除 `border-b border-border` 和渐变背景，增加 margin、圆角、阴影）：

```tsx
    <div
      className="mx-3 mt-3 px-4 py-3 flex items-center gap-3 shrink-0 rounded-xl bg-surface-1"
      style={{
        boxShadow: "var(--shadow-card)",
      }}
    >
```

- [ ] **Step 2: 视觉验证**

刷新浏览器，确认：
- 顶部状态栏四角变为圆角
- 底部硬边框线消失
- 卡片浮在浅灰底上，与外层侧边栏和顶部各有 12px 间距
- 暗色模式下视觉协调

- [ ] **Step 3: 提交**

```bash
git add web/src/components/agent-panel/StatusHeader.tsx
git commit -m "feat(chat): StatusHeader 改为浮动圆角卡片"
```

---

## Task 6: ACPMain Session List 改为浮动圆角卡片

**Files:**
- Modify: `web/components/ACPMain.tsx:125-134`

- [ ] **Step 1: 给 ACPMain 最外层 div 添加 gap-3**

打开 `web/components/ACPMain.tsx`，找到第 125-126 行的 `return` 块：

```tsx
  return (
    <div className="flex h-full w-full">
```

替换为：

```tsx
  return (
    <div className="flex h-full w-full gap-3">
```

- [ ] **Step 2: 修改 Session List sidebar 的 className 和添加 style**

继续在 `ACPMain.tsx` 中，找到第 129-134 行的 Session List sidebar div：

```tsx
        <div
          className={cn(
            "hidden md:flex flex-col border-r border-border/60 bg-surface-1/50 transition-all duration-200 flex-shrink-0",
            sidebarCollapsed ? "w-12" : "w-64",
          )}
        >
```

替换为（移除 `border-r border-border/60 bg-surface-1/50`，增加 `rounded-xl bg-surface-1`，添加 `style`）：

```tsx
        <div
          className={cn(
            "hidden md:flex flex-col bg-surface-1 transition-all duration-200 flex-shrink-0 rounded-xl",
            sidebarCollapsed ? "w-12" : "w-64",
          )}
          style={{ boxShadow: "var(--shadow-card)" }}
        >
```

- [ ] **Step 3: 视觉验证**

刷新浏览器，确认：
- Session List 四角变为圆角
- 右侧硬边框线消失
- 卡片浮在浅灰底上
- Session List 与 Chat 内容之间有 12px 间距（由 gap-3 提供）
- 折叠 Session List（点击左面板切换按钮）功能仍正常

- [ ] **Step 4: 提交**

```bash
git add web/components/ACPMain.tsx
git commit -m "feat(chat): ACPMain Session List 改为浮动圆角卡片"
```

---

## Task 7: 折叠按钮与 resize handle 适配浮动卡片布局

**Files:**
- Modify: `web/src/pages/agent-panel/agent-panel.css:35-43`（`.agent-panel-content` 添加 `position: relative`）
- Modify: `web/src/pages/agent-panel/agent-panel.css:459-466`（`.agent-artifacts-expand-btn`）
- Modify: `web/src/pages/agent-panel/agent-panel.css:495-512`（`.agent-artifacts-resize-handle`）

**前提说明**：折叠按钮（`.agent-artifacts-expand-btn`）当前已经是 `.agent-panel-content` 的直接子元素（与 `ArtifactsPanel` 同级，在 `chat.$agentId.tsx:94-103`），**无需 JSX 改动**。只需调整 CSS 定位值。

- [ ] **Step 1: 修改 `.agent-panel-content` 添加 position relative**

打开 `web/src/pages/agent-panel/agent-panel.css`，找到 Task 2 修改过的 `.agent-panel-content`：

```css
.agent-panel-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px;
  gap: 12px;
}
```

追加 `position: relative`（让折叠按钮的绝对定位以 `.agent-panel-content` 为参照）：

```css
.agent-panel-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px;
  gap: 12px;
  position: relative;
}
```

- [ ] **Step 2: 修改 `.agent-artifacts-expand-btn` 定位**

找到 `.agent-artifacts-expand-btn`（约第 459 行）：

```css
.agent-artifacts-expand-btn {
  position: absolute;
  right: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 56px;
  ...
}
```

将 `right: 0` 改为 `right: 12px`（对齐 `.agent-panel-content` 的 padding，让按钮距 canvas 右边缘 12px 而非贴边）：

```css
.agent-artifacts-expand-btn {
  position: absolute;
  right: 12px;
  top: 50%;
  transform: translateY(-50%);
  width: 28px;
  height: 56px;
  ...
}
```

（仅改 `right` 值，其余属性不动）

- [ ] **Step 3: 修改 `.agent-artifacts-resize-handle` 定位**

找到 `.agent-artifacts-resize-handle`（约第 495 行）：

```css
.agent-artifacts-resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 150ms;
  flex-shrink: 0;
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  z-index: 2;
}
```

将 `left: 0` 改为 `left: -6px`（让 4px 宽的 handle 居中在 `.agent-panel-content` 的 12px gap 内，即 handle 左边缘距 Artifacts 卡片左边缘 -6px）：

```css
.agent-artifacts-resize-handle {
  width: 4px;
  cursor: col-resize;
  background: transparent;
  transition: background 150ms;
  flex-shrink: 0;
  position: absolute;
  left: -6px;
  top: 0;
  bottom: 0;
  z-index: 2;
}
```

- [ ] **Step 4: 视觉验证**

刷新浏览器，逐一验证：

1. **拖拽分隔线**：鼠标悬停在 Artifacts 左侧的 gap 区域，应看到蓝色高亮线；拖拽可调整 Artifacts 宽度
2. **折叠 Artifacts**：点击 Artifacts 标题栏的折叠按钮，Artifacts 收起为宽度 0
3. **展开按钮位置**：折叠后，右侧应出现竖向"展开"按钮，位置距右边缘 12px（不再贴边）
4. **点击展开**：点击展开按钮，Artifacts 恢复显示

- [ ] **Step 5: 提交**

```bash
git add web/src/pages/agent-panel/agent-panel.css
git commit -m "fix(chat): 折叠按钮与拖拽分隔线适配浮动卡片布局"
```

---

## Task 8: 最终验证（precheck + build + 视觉回归）

**Files:**
- 无文件改动，纯验证步骤

- [ ] **Step 1: 运行 precheck**

Run: `bun run precheck`

Expected: 全部通过（`biome format`、`biome check`、`tsc`、`biome check` 四步全绿）

如果有报错：
- 格式/import 排序问题：precheck 的 `--write` 会自动修复，重新运行即可
- TypeScript 报错：检查 Task 5、6 的 className 是否拼写正确
- Biome lint 报错：按提示修复

- [ ] **Step 2: 运行生产构建**

Run: `bun run build:web`

Expected: 构建成功，`web/dist/` 目录更新

- [ ] **Step 3: 视觉回归验证（亮色模式）**

启动 `bun run dev` + `bun run dev:web`，访问 `/agent/chat/<某个 agentId>`，逐项确认：

| # | 检查项 | 预期 |
|---|--------|------|
| 1 | AgentSidebar | 深蓝渐变贴边，完全未变 |
| 2 | 整体右侧底色 | 浅灰 `#f5f6f8` |
| 3 | StatusHeader | 白色圆角浮动卡片，有阴影，四周 12px 留白 |
| 4 | Session List | 白色圆角浮动卡片，与 Chat 内容有 12px gap |
| 5 | Chat 消息区 | 与背景同层（浅灰），无卡片、无圆角、无阴影 |
| 6 | Artifacts | 白色圆角浮动卡片 |
| 7 | 卡片间距均匀 | StatusHeader / Session List / Chat / Artifacts 之间的间距一致（12px） |
| 8 | 拖拽 Artifacts 宽度 | 功能正常 |
| 9 | 折叠 Artifacts | 收起后无空白槽，展开按钮距右边缘 12px |
| 10 | 折叠/展开 Session List | 功能正常 |

- [ ] **Step 4: 视觉回归验证（暗色模式）**

切换到暗色模式，确认：

| # | 检查项 | 预期 |
|---|--------|------|
| 1 | 整体底色 | 深灰 `#1a1d23` |
| 2 | 卡片底色 | 项目 theme 的 surface-1 暗色值 |
| 3 | 阴影可见 | 暗色模式下阴影透明度 0.30，肉眼可辨 |
| 4 | Chat 消息区 | 与暗色 canvas 同层 |

- [ ] **Step 5: 视觉回归验证（移动端）**

浏览器 DevTools 切换到移动端视图（< 768px），确认：

| # | 检查项 | 预期 |
|---|--------|------|
| 1 | Session List | 自动隐藏（`md:` 断点） |
| 2 | Artifacts | 自动折叠 |
| 3 | Chat 区 | 占满宽度，底色仍为 canvas |

- [ ] **Step 6: 确认无回归（已有测试）**

Run: `bun test web/src/__tests__/`

Expected: 所有前端测试通过（本次纯样式改动不应破坏任何 flow test）

如果某个测试失败，说明该测试可能依赖了被改动的 className 或 DOM 结构，需要检查并修复测试或回退相关改动。

- [ ] **Step 7: 最终提交（如有修复）**

如果前面 Task 1-7 的提交已经完整且 precheck/build/test 全绿，则无需额外提交。

如果验证过程中发现并修复了问题：

```bash
git add <修改的文件>
git commit -m "fix(chat): 呼吸感重设计验证修复"
```

---

## 完成标准

所有以下条件满足时，本次重设计完成：

- [ ] `bun run precheck` 通过
- [ ] `bun run build:web` 成功
- [ ] `bun test web/src/__tests__/` 全绿
- [ ] 亮色模式下视觉回归 10 项全部符合预期
- [ ] 暗色模式下视觉回归 4 项全部符合预期
- [ ] 移动端视图 3 项全部符合预期
- [ ] 所有提交符合 Angular 风格 + 中文标题 + Co-authored-by
