# Chat 面板呼吸感重设计

**日期**：2026-06-12
**状态**：待实现
**作者**：KonghaYao + Claude（brainstorming session）

## 背景与目标

当前 Agent Chat 页面（`/agent/chat/$agentId`）的三栏布局采用贴边 + 硬边框的视觉风格：

- 顶部 `StatusHeader` 使用 `border-b border-border` 实线分割
- 内层 Session List（ACPMain 内置）使用 `border-r` 贴边
- 中间 Chat 消息区直接落在外层白色背景上
- 右侧 Artifacts 使用 `border-left` 贴边

整体视觉过于"工程化"，缺乏呼吸感。本次重设计目标是通过**浮动圆角卡片 + 浅灰 canvas 背景**，让右侧三个面板（StatusHeader / Session List / Artifacts）"浮"起来，而 Chat 消息区与背景同层，形成视觉层次对比。

## 修改范围

### In Scope（仅右侧区域）

| 组件 | 路径 | 改动 |
|------|------|------|
| 外层容器背景 | `web/src/pages/agent-panel/agent-panel.css` | `.agent-panel-body` 增加 canvas 背景 |
| StatusHeader | `web/src/components/agent-panel/StatusHeader.tsx` | 移除 `border-b`，改为圆角浮动卡片 |
| Session List | `web/components/ACPMain.tsx` | 内层会话列表 sidebar 改为圆角浮动卡片 |
| Chat 消息区 | `web/src/pages/agent-panel/agent-panel.css`（`.agent-chat-area`）| 透明背景、与 canvas 同层 |
| Artifacts | `web/src/pages/agent-panel/agent-panel.css`（`.agent-artifacts`）| 移除 `border-left`，改为圆角浮动卡片 |

### Out of Scope（明确不动）

- **`AgentSidebar`（外层深蓝渐变左侧栏）** — 完全保持现状（贴边、直角、深蓝渐变、`box-shadow: 12px 0 28px`）
- **`ChatInterface` 内部行为**（消息渲染、输入框、工具调用卡片等）
- **组件 API**（props 接口不变）
- **路由结构、JSX 层级关系**

## DOM 层级（重要前提）

设计前必须明确当前 DOM 嵌套关系（本次不改层级，只改样式）：

```
.agent-panel-layout (flex row)
├── AgentSidebar（外层深蓝，本次完全不动）
└── .agent-panel-body (flex column, 本次加 canvas 背景)
    ├── StatusHeader（直接子元素）
    └── .agent-panel-content (flex row)
        ├── .agent-chat-area (flex 1)
        │   └── ChatPanel
        │       └── ACPMain (flex row, h-full w-full)
        │           ├── Session List sidebar（ACPMain 内部）
        │           └── Chat content（ACPMain 内部）
        │               └── ChatInterface
        └── .agent-artifacts（直接子元素）
```

关键点：**Session List 嵌套在 `.agent-chat-area` → ChatPanel → ACPMain 内部**，不是 `.agent-panel-content` 的直接子元素。因此 Session List 的浮动卡片样式需要在 `ACPMain.tsx` 内部修改，而不是在 `agent-panel.css` 里。

## 设计要点

### 1. Canvas 背景

`.agent-panel-body` 整体改为浅灰 canvas 底色，作为右侧所有元素的"桌面"。

```css
.agent-panel-body {
  background: var(--color-canvas);
}
```

新增 CSS 变量：

```css
:root {
  --color-canvas: #f5f6f8;  /* 浅灰，接近白 */
}

:root.dark {
  --color-canvas: #1a1d23;  /* 暗色模式：深灰 */
}
```

Chat 消息区最终通过多层透明继承落在此背景上，**不额外加色**。

### 2. 统一间距方案：`.agent-panel-content` 用 padding + gap

为避免各元素各自 margin 互相累加导致间距不一致，**canvas 边缘间距统一由 `.agent-panel-content` 的 padding 提供，元素之间的间距由 flex gap 提供**。

```css
.agent-panel-content {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 12px;       /* canvas 边缘留白（同时提供 StatusHeader 下方的 gap）*/
  gap: 12px;           /* .agent-chat-area 与 .agent-artifacts 之间的间距 */
}
```

间距分工：

- **StatusHeader 与下方行的 gap**：由 `.agent-panel-content` 的 `padding-top: 12px` 提供（StatusHeader 本身不设 bottom margin）
- **canvas 四周边缘**：StatusHeader 用 `mx-3 mt-3`；`.agent-panel-content` 用 `padding: 12px`（注意 `.agent-panel-content` 不再额外设 margin，padding 已包含边缘留白）
- **`.agent-chat-area` 与 `.agent-artifacts` 之间**：由 `.agent-panel-content` 的 `gap: 12px` 提供

### 3. StatusHeader — 圆角浮动卡片

**当前**（`web/src/components/agent-panel/StatusHeader.tsx:23`）：

```tsx
<div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0"
     style={{ background: "linear-gradient(...)" }}>
```

**改为**：

```tsx
<div className="mx-3 mt-3 px-4 py-3 flex items-center gap-3 shrink-0 rounded-xl bg-surface-1"
     style={{ boxShadow: "var(--shadow-card)" }}>
```

关键点：

- 移除 `border-b border-border`
- `mx-3 mt-3`：左右各 12px、顶部 12px（与 `.agent-panel-content` 的 padding 对齐）；**不设 bottom margin**，下方 gap 由 `.agent-panel-content` 的 `padding-top` 提供
- `rounded-xl`（10px 圆角）
- 背景从渐变 → 纯白 `bg-surface-1`
- `box-shadow` 实现"浮起"，阴影值统一用 CSS 变量 `--shadow-card`（见视觉规范）

### 4. Session List（ACPMain 内层会话列表）— 圆角浮动卡片

**当前**（`web/components/ACPMain.tsx:129-134`）：

```tsx
<div className="flex h-full w-full">
  <div className={cn(
    "hidden md:flex flex-col border-r border-border/60 bg-surface-1/50 transition-all duration-200 flex-shrink-0",
    sidebarCollapsed ? "w-12" : "w-64",
  )}>
```

**改为**（ACPMain 最外层加 `gap-3`，Session List 改为卡片）：

```tsx
<div className="flex h-full w-full gap-3">  {/* 新增 gap-3 */}
  <div className={cn(
    "hidden md:flex flex-col bg-surface-1 transition-all duration-200 flex-shrink-0 rounded-xl",
    sidebarCollapsed ? "w-12" : "w-64",
  )}
  style={{ boxShadow: "var(--shadow-card)" }}>
```

关键点：

- ACPMain 最外层 flex 容器新增 `gap-3`，提供 Session List 与 Chat content 之间的 12px 间距
- Session List 不需要自身 margin（已经在 `.agent-panel-content` 的 padding 范围内）
- 移除 `border-r border-border/60`
- `bg-surface-1/50` → `bg-surface-1`（纯白）
- 新增 `rounded-xl` 和 `box-shadow`

### 5. Chat 消息区 — 与 canvas 同层（不套卡片、不加 padding）

**当前**（`agent-panel.css` 的 `.agent-chat-area`）：

```css
.agent-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
```

**改为**：

```css
.agent-chat-area {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: transparent;  /* 关键：与 canvas 同层 */
  /* 不加 padding —— 会破坏 ChatInterface 内部布局（输入栏会浮空）*/
}
```

关键点：

- 透明背景，继承外层 canvas 底色
- 无圆角、无阴影、无 border
- **不加 padding**：ChatInterface 内部有自己的布局（消息滚动区 + 底部输入栏），外层 padding 会导致输入栏与底部产生空隙
- 横向间距已由 ACPMain 的 `gap-3`（左侧 Session List）和 `.agent-panel-content` 的 `gap: 12px`（右侧 Artifacts）提供

### 6. Artifacts 右侧 — 圆角浮动卡片

**当前**（`agent-panel.css` 的 `.agent-artifacts`）：

```css
.agent-artifacts {
  width: var(--agent-artifacts-width);
  border-left: 1px solid var(--color-border-subtle);
  background: var(--color-surface-1);
  ...
}
```

**改为**：

```css
.agent-artifacts {
  width: var(--agent-artifacts-width);
  border-radius: 10px;
  background: var(--color-surface-1);
  box-shadow: var(--shadow-card);
  /* 移除 border-left */
  /* 不设 margin —— 与 .agent-chat-area 的间距由 .agent-panel-content 的 gap 提供 */
  ...
}
```

折叠态保持原有 `width: 0` 逻辑即可，因为没有 margin 需要清零。

### 7. 拖拽与折叠按钮的适配

由于 Artifacts 变成浮动卡片，原有的两个绝对定位元素需要重新定位：

**`.agent-artifacts-resize-handle`**：

- 当前 `left: 0`（贴 Artifacts 左边缘）
- 改为 `left: -6px`（居中在 `.agent-panel-content` 的 12px gap 内）

**`.agent-artifacts-expand-btn`**（折叠态展开按钮）：

- 当前 `right: 0`（贴 `.agent-panel-content` 右边缘）
- 按钮已经是 `.agent-panel-content` 的直接子元素（与 `ArtifactsPanel` 同级，见 `chat.$agentId.tsx:94-103`），**无需 JSX 改动**
- 仅需 CSS 调整：`right: 0` → `right: 12px`（对齐 `.agent-panel-content` 的 padding，距 canvas 右边缘 12px）
- 同时给 `.agent-panel-content` 添加 `position: relative`，让按钮的绝对定位以 `.agent-panel-content` 为参照

## 视觉规范汇总

### CSS 变量定义（新增）

```css
:root {
  --color-canvas: #f5f6f8;
  --shadow-card: 0 4px 12px -6px rgba(15, 23, 42, 0.10);
}

:root.dark {
  --color-canvas: #1a1d23;
  --shadow-card: 0 4px 12px -6px rgba(0, 0, 0, 0.30);
}
```

所有浮动卡片统一引用 `var(--shadow-card)` 和 `bg-surface-1`，暗色模式自动适配。

### 浅色模式

| 元素 | 背景 | 圆角 | 阴影 |
|------|------|------|------|
| Canvas（`.agent-panel-body`）| `#f5f6f8` | — | — |
| StatusHeader | `#ffffff`（`bg-surface-1`） | 10px（`rounded-xl`） | `var(--shadow-card)` |
| Session List | `#ffffff`（`bg-surface-1`） | 10px | `var(--shadow-card)` |
| Chat 消息区 | 透明（继承 canvas） | — | — |
| Artifacts | `#ffffff`（`bg-surface-1`） | 10px | `var(--shadow-card)` |

### 暗色模式

`bg-surface-1` 和 `--shadow-card` 在暗色模式下的具体值由项目的 theme token 系统决定（不在本次新增，复用现有 `bg-surface-1` / `bg-surface-2` token）。

### 间距规范

间距统一通过 **`.agent-panel-content` 的 padding + gap** 提供，不在子元素上重复设 margin：

| 间距位置 | 实现方式 | 值 |
|----------|----------|-----|
| StatusHeader 与 canvas 左/右/上边缘 | StatusHeader `mx-3 mt-3` | 12px |
| StatusHeader 下方到 `.agent-panel-content` | `.agent-panel-content` `padding-top` | 12px |
| `.agent-panel-content` 与 canvas 左/右/下边缘 | `.agent-panel-content` `padding` | 12px |
| `.agent-chat-area` 与 `.agent-artifacts` 之间 | `.agent-panel-content` `gap` | 12px |
| Session List 与 Chat content 之间（ACPMain 内部）| ACPMain 最外层 `gap-3` | 12px |

## 文件改动清单

1. **`web/src/pages/agent-panel/agent-panel.css`**
   - 新增 CSS 变量 `--color-canvas`、`--shadow-card`（`:root` + `:root.dark`）
   - `.agent-panel-body` 增加 `background: var(--color-canvas)`
   - `.agent-panel-content` 增加 `padding: 12px; gap: 12px;`
   - `.agent-chat-area` 增加 `background: transparent`（**不加 padding**）
   - `.agent-artifacts` 改为浮动卡片样式（`border-radius` + `box-shadow`，移除 `border-left`，**不加 margin**）
   - `.agent-artifacts-resize-handle` 调整 `left: -6px`（居中在 gap 内）
   - `.agent-artifacts-expand-btn` 调整定位策略（详见 section 7）

2. **`web/src/components/agent-panel/StatusHeader.tsx`**
   - 替换 `border-b border-border` → `rounded-xl bg-surface-1 mx-3 mt-3`
   - 移除原渐变背景的 inline style
   - 内联 style 改为 `boxShadow: "var(--shadow-card)"`

3. **`web/components/ACPMain.tsx`**
   - 最外层 `<div className="flex h-full w-full">` 增加 `gap-3`
   - Session List sidebar div：移除 `border-r border-border/60 bg-surface-1/50`，增加 `rounded-xl bg-surface-1`
   - 添加 `style={{ boxShadow: "var(--shadow-card)" }}`

4. **`web/src/routes/agent/_panel/chat.$agentId.tsx`**（仅折叠按钮位置调整）
   - 将折叠态的 `.agent-artifacts-expand-btn` 从与 `.agent-artifacts` 同级渲染，移到 `.agent-panel-content` 内部
   - 按钮的 CSS 定位策略相应调整（详见 section 7）

## 测试策略

### 视觉验证

- 启动 `bun run dev:web`，访问 `/agent/chat/$agentId`
- 验证：
  1. AgentSidebar 保持贴边深蓝（未改动）
  2. StatusHeader 浮在浅灰底上，有阴影
  3. Session List 浮在浅灰底上，与 StatusHeader 视觉对齐
  4. Chat 消息直接落在浅灰底上，无卡片
  5. Artifacts 浮在浅灰底上
  6. 折叠 Artifacts 后不留空白槽
  7. 拖拽分隔线仍可调整 Artifacts 宽度
  8. 暗色模式下视觉协调

### 不需要新增单元测试

本次改动纯属 CSS + 类名调整，不涉及业务逻辑。已有的前端 flow 测试不依赖具体样式，应该不受影响。

### precheck

- `bun run precheck` 必须通过
- `bun run build:web` 必须成功

## 已知风险与权衡

### 1. 拖拽分隔线位置变化

Artifacts 变成浮动卡片后，原有的 resize handle 需要重新定位。如果实现时发现拖拽行为不稳定，备选方案是将 resize handle 改为相对 `.agent-panel-content` 定位，宽度撑满 chat 与 artifacts 之间的 gap 区域。

### 2. 暗色模式阴影可见度

深色背景下阴影天然不明显，可能需要把暗色模式的阴影透明度提高到 0.3 左右才能感知。实现时实测调整。

### 3. 移动端适配

`md:` 以下（< 768px）Session List 已经隐藏。Artifacts 在移动端也会自动折叠。Canvas 背景在移动端依然生效，不会造成视觉问题。

### 4. 折叠按钮位置

折叠态的 `.agent-artifacts-expand-btn` 原本贴 Artifacts 右边缘（`right: 0`，Artifacts 折叠后宽度为 0）。本次改动中 Artifacts 不再有 margin，折叠后 `width: 0` 会让按钮无处附着，需要将按钮移到 `.agent-panel-content` 内部、绝对定位 `right: 12px`。这涉及 JSX 微调（`chat.$agentId.tsx`），是本次改动中最容易出问题的细节，需要重点测试。

## 不在本次范围（未来可考虑）

- AgentSidebar 是否也改为浮动卡片（用户明确表示本次不动）
- 卡片悬停时的微动效（如阴影加深）
- 卡片之间的视觉关联（如统一外层 wrapper）

## 实现顺序建议

1. 新增 CSS 变量（`--color-canvas`、`--shadow-card`）
2. `.agent-panel-body` 加 canvas 背景
3. `.agent-panel-content` 加 `padding` + `gap`
4. `.agent-chat-area` 加 `background: transparent`（不加 padding）
5. `.agent-artifacts` 改浮动卡片样式（radius + shadow，移除 border-left）
6. StatusHeader 类名调整
7. ACPMain 最外层加 `gap-3`，Session List 改卡片样式
8. 调整 resize handle 和 expand button 定位（含 `chat.$agentId.tsx` JSX 微调）
9. 视觉验证（亮色 + 暗色）
10. `bun run precheck` + `bun run build:web`
