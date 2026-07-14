# RCS 前端设计规范 — "Fenix Agent 控制面板"

> 明亮科技风 · AI Agent 控制中枢 · 数据驱动可视化 · 清爽专业

---

## 1. 设计理念

### 1.1 核心隐喻

将 RCS 定位为 **"AI Agent 的任务控制中心"**—— 类似 Stripe/Linear 的清爽专业感，注入 AI 产品的生命力。用户打开控制面板的第一眼，应该感受到：

- **清爽感**：白色基底、通透的层次、呼吸般的留白
- **掌控感**：一切状态一目了然，关键操作触手可及
- **高级感**：精致的排版、考究的色彩、克制的动效

### 1.2 设计原则

| 原则 | 说明 |
|------|------|
| **信息密度优先** | 一屏展示尽可能多的有效信息，减少滚动和页面跳转 |
| **状态即视觉** | Agent 状态、会话进度用颜色和动效表达，而非文字标签 |
| **渐进式复杂度** | 默认视图简洁有力，悬停/展开显示深度信息 |
| **克制的动效** | 每个动画都有明确目的（反馈/引导/表达状态），不为炫而炫 |
| **明亮为骨** | 以白色明亮主题为默认设计基准，深色为可选适配 |

### 1.3 视觉关键词

`Clean Tech` · `Bright Studio` · `Data-Clarity` · `Stripe-esque`

---

## 2. 色彩系统

全部定义在 `web/src/index.css:7-119`（Tailwind CSS v4 `@theme` 语法）。

### 2.1 品牌色

```css
--color-brand: #1677ff;
--color-brand-light: #4096ff;
--color-brand-subtle: rgba(22, 119, 255, 0.08);
--color-brand-glow: rgba(22, 119, 255, 0.15);
```

**选择理由**：`#1677ff` 是 Ant Design 经典科技蓝，辨识度高。

### 2.2 辅色

```css
--color-cyan: #22d3ee;
--color-cyan-subtle: rgba(34, 211, 238, 0.1);
```

### 2.3 完整色板（明亮主题）

#### Surface 层级

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-surface-0` | `#f8fafc` | 最底层背景 |
| `--color-surface-1` | `#ffffff` | 主背景 / 卡片 |
| `--color-surface-2` | `#f1f5f9` | 次级表面 |
| `--color-surface-3` | `#e2e8f0` | 最深表面 |
| `--color-surface-hover` | `#e6f0ff` | 悬停态（淡蓝） |
| `--color-surface-elevated` | `#ffffff` | 抬起表面 |
| `--color-surface-overlay` | `#f1f5f9` | 覆盖层 |

#### 边框

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-border` | `rgba(0,0,0,0.1)` | 默认边框 |
| `--color-border-light` | `rgba(0,0,0,0.06)` | 浅边框 |
| `--color-border-subtle` | `rgba(0,0,0,0.06)` | 微弱边框 |
| `--color-border-default` | `rgba(0,0,0,0.1)` | 标准边框 |
| `--color-border-active` | `rgba(22,119,255,0.35)` | 激活态边框 |
| `--color-input` | `rgba(0,0,0,0.1)` | 输入框边框 |

#### 文字

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-text-bright` | `#0f172a` | 标题/重点 |
| `--color-text-primary` | `#334155` | 正文 |
| `--color-text-secondary` | `#64748b` | 次要文字 |
| `--color-text-muted` | `#94a3b8` | 辅助/占位 |
| `--color-text-dim` | `#94a3b8` | 弱化文字 |

#### 语义色

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-status-active` | `#10b981` | 运行中 (翠绿) |
| `--color-status-running` | `#10b981` | 同上 |
| `--color-status-idle` | `#1677ff` | 空闲 (品牌蓝) |
| `--color-status-error` | `#ef4444` | 错误 (红色) |
| `--color-status-warning` | `#f59e0b` | 警告 (琥珀) |

#### 消息气泡

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-user-bubble` | `#1677ff` | 用户消息气泡背景 |
| `--color-user-bubble-border` | `#4096ff` | 气泡边框 |
| `--color-bg-inverted` | `#1677ff` | 反色背景 |
| `--color-text-inverted` | `#ffffff` | 反色文字 |

#### 强调色

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-accent-tiffany` | `#22d3ee` | 蒂芙尼蓝 |
| `--color-accent-pink` | `#f472b6` | 粉色 |
| `--color-accent-green` | `#10b981` | 绿色 |
| `--color-accent-yellow` | `#f59e0b` | 黄色 |
| `--color-accent-red` | `#ef4444` | 红色 |

#### 专用色

| 变量 | 值 | 说明 |
|------|-----|------|
| `--color-tool-card` | `#f1f5f9` | 工具调用卡片背景 |
| `--color-warning-bg` | `#fef3c7` | 警告横幅背景 |
| `--color-warning-border` | `#f59e0b` | 警告横幅边框 |
| `--color-warning-text` | `#92400e` | 警告横幅文字 |

#### shadcn/ui tokens

| 变量 | 值 |
|------|-----|
| `--color-background` | `#ffffff` |
| `--color-foreground` | `#0f172a` |
| `--color-card` | `#ffffff` |
| `--color-card-foreground` | `#0f172a` |
| `--color-popover` | `#ffffff` |
| `--color-popover-foreground` | `#0f172a` |
| `--color-primary` | `#1677ff` |
| `--color-primary-foreground` | `#ffffff` |
| `--color-secondary` | `#f1f5f9` |
| `--color-secondary-foreground` | `#334155` |
| `--color-muted` | `#f1f5f9` |
| `--color-muted-foreground` | `#94a3b8` |
| `--color-accent` | `#f1f5f9` |
| `--color-accent-foreground` | `#334155` |
| `--color-destructive` | `#ef4444` |
| `--color-ring` | `#1677ff` |

#### 全局默认值

| 变量 | 值 | 说明 |
|------|-----|------|
| `--default-border-color` | `var(--color-border)` | Tailwind v4 默认 |
| `--default-ring-color` | `var(--color-ring)` | Tailwind v4 默认 |

#### 阴影

| 变量 | 值 (全局) | 局部覆盖 |
|------|-----------|----------|
| `--shadow-card` | `0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` | `agent-panel.css:16` 覆盖为 `0 4px 12px -6px rgba(15,23,42,0.1)` |
| `--shadow-elevated` | `0 4px 16px rgba(22,119,255,0.08), 0 1px 4px rgba(0,0,0,0.04)` | — |

> ⚠️ `--shadow-card` 在 `index.css` 和 `agent-panel.css` 中定义了不同值。由于都作用于 `:root`，后者覆盖前者，属于维护隐患。

#### 圆角 & 布局

```css
--radius: 0.5rem;
--radius-lg: 0.75rem;
--navbar-height: 48px;
--sidebar-width: 200px;
--sidebar-collapsed: 60px;
--topbar-height: 56px;
```

### 2.4 深色主题

通过 `.dark` 类切换，定义在 `web/src/index.css:124-190`。所有表面/文字/边框变量反转。暗色模式下的 `loadingDotBounceDark` 关键帧（`index.css:437-454`）品牌色发光增强（box-shadow alpha 从 0.3 → 0.35）。

### 2.5 侧边栏专用变量

定义在 `web/src/pages/agent-panel/agent-panel.css:6-17`：

```css
--agent-sidebar-width: 240px;
--agent-sidebar-collapsed: 64px;
--agent-artifacts-width: 360px;
--agent-artifacts-min: 280px;
--agent-artifacts-max: 700px;
--agent-sidebar-from: #1759dc;
--agent-sidebar-to: #0d2a6e;
--agent-sidebar-cyan: #6be6ff;
--color-canvas: #f9fafb;
```

### 2.6 状态视觉反馈

状态通过颜色圆点（`.status-dot`）表达，CSS 变量控制：

| 状态 | CSS | 颜色 |
|------|-----|------|
| running | `var(--color-status-running)` | `#10b981` |
| idle / starting | `var(--color-status-warning)` | `#f59e0b` |
| stopped | `var(--color-text-muted)` | `#94a3b8` |
| error | `var(--color-status-error)` | `#ef4444` |

### 2.7 已知偏离

`AgentPageHeader` 组件（`shared/AgentPageHeader.tsx:13-18`）使用硬编码色值（`#1a2944`、`#94a3b8`、`#e8edf4`），而非 CSS 变量，暗色模式下不会自动反转。

---

## 3. 字体系统

**不使用外部字体**，系统原生字体栈，零网络依赖，零 FOIT。

```css
--font-sans:
  system-ui, -apple-system, "Segoe UI", "Helvetica Neue", Helvetica,
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif;
--font-display: /* 同 --font-sans */;
--font-body:    /* 同 --font-sans */;
--font-mono:
  ui-monospace, "Cascadia Code", "Fira Code", "JetBrains Mono", Menlo, monospace;
```

### 字号层级

| 元素 | 字号 | 字重 | 其他 |
|------|------|------|------|
| 品牌名 (侧边栏) | 18px | 800 | letter-spacing: 0.08em |
| 页面标题 (AgentPageHeader) | 22px | — | — |
| Section 标签 (侧边栏) | 10px | 700 | uppercase, letter-spacing: 0.1em, 微透明白 |
| 导航项 | 12px | 500 | — |
| 正文 | 13px | 400 | `font-family: var(--font-body)` |
| 辅助文字 (侧边栏) | 11px | — | 微透明白 |
| 代码 | 13px | — | `font-family: var(--font-mono)` |

---

## 4. 布局架构

### 4.1 整体布局：侧边栏 + 内容区

布局分两级：

**第一级 (路由级)** — `AgentPanelLayout`（`AgentPanelLayout.tsx`）：

```
┌──────────────────────────────────────────────────────────────┐
│ ┌───────────┐ ┌────────────────────────────────────────────┐ │
│ │           │ │              agent-panel-body               │ │
│ │  Sidebar  │ │              ┌──────────────────────────┐  │ │
│ │  (240px)  │ │              │       <Outlet />          │  │ │
│ │           │ │              └──────────────────────────┘  │ │
│ └───────────┘ └────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**第二级 (页面级)** — 子路由渲染 `<Outlet />` 内：

- **配置类页面**：直接渲染页面组件（含 `AgentPageHeader` + `DataTable` 等）
- **聊天页面** (`chat.$agentId.tsx`)：额外嵌套 `agent-panel-content` → `ResizablePanelGroup`

```
AgentPanelLayout
  ├── AgentSidebar
  └── agent-panel-body (flex column, flex: 1, bg: --color-canvas)
      └── <Outlet />
          ├── 配置页面 → [page content]
          └── chat.$agentId → agent-panel-content (flex row, padding: 12px)
              └── ResizablePanelGroup
                  ├── ResizablePanel(chat, 默认 60%, min 30%)
                  │   └── agent-chat-area
                  │       └── ChatPanel
                  ├── ResizableHandle (+ toggle button)
                  └── ResizablePanel(artifacts, 默认 40%, collapsible)
                      └── ArtifactsPanel
```

### 4.2 关键 CSS 类

| 类名 | 文件 | 说明 |
|------|------|------|
| `.agent-panel-layout` | `agent-panel.css:25` | 顶层 flex row，`height: 100dvh` |
| `.agent-panel-body` | `agent-panel.css:33` | `flex column, flex: 1, min-width: 0, overflow: hidden` |
| `.agent-panel-content` | `agent-panel.css:43` | 聊天页专用，`flex row, padding: 12px` |
| `.agent-panel-resizable` | `agent-panel.css:53` | ResizablePanelGroup 容器，`flex: 1` |
| `.agent-chat-area` | `agent-panel.css:600` | ChatPanel 包装器，`flex column, height: 100%` |

### 4.3 z-index 层级

```
z-index: 20  →  .agent-sidebar-toggle (侧边栏折叠按钮)
z-index: 10  →  .agent-sidebar (侧边栏主体)
z-index: 10  →  .agent-artifacts-expand-btn (Artifacts 切换按钮)
z-index: 1   →  .agent-sidebar > * (侧边栏子元素)
```

---

## 5. 侧边栏设计

### 5.1 视觉风格

深蓝色渐变背景（`#1759dc → #0d2a6e`），与白色内容区形成强对比。顶部有 `::before` 伪元素产生青色光晕（`#6be6ff` 亮点，径向渐变）。

```css
.agent-sidebar {
  width: var(--agent-sidebar-width);           /* 240px */
  min-width: var(--agent-sidebar-width);
  background:
    linear-gradient(135deg, rgba(255,255,255,0.1), transparent 48%),
    linear-gradient(180deg, #1759dc, #0d2a6e);
  color: #fff;
  transition: width 300ms cubic-bezier(0.4,0,0.2,1),
              min-width 300ms cubic-bezier(0.4,0,0.2,1);
  box-shadow: 12px 0 28px rgba(12,26,58,0.12);
  z-index: 10;
}
```

**折叠切换按钮**：`position: absolute; top: 24px; right: -12px`，24×24px 白色圆形按钮，悬停变蓝。

### 5.2 侧边栏结构

```
┌─────────────────────────────────┐
│  [Fenix Logo 图标 + "Fenix Agent"]│  ← 品牌区，链接到 /agent/home
├─────────────────────────────────┤
│  核心                            │  ← .agent-sidebar-section-label
│  ○ 创建 Agent     (Plus)        │  ← .agent-sidebar-nav-item
│  ○ 智能体管理      (Bot)        │
│  ○ 工作流         (Workflow)    │
│                                 │
│  配置                            │
│  ○ 模型           (Cpu)         │
│  ○ Skill 管理     (Settings)    │
│  ○ Memories       (Brain)       │
│  ○ 知识库         (BookOpen)    │
│  ○ MCP 管理       (Plug)        │
│  ○ 定时任务       (Clock)       │
│  ○ 智能体站点     (Globe)       │
│  ○ 组织管理       (Users)       │
│  ○ API Keys       (KeyRound)    │
├─────────────────────────────────┤
│  智能体                          │  ← .agent-tree-section-title
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐  │
│  │ agent-prod    ● 运行中     │  │  ← .agent-sidebar-agent-card
│  │ └ instance-1  ● session   │  │
│  │ └ instance-2  ○ idle      │  │
│  │ agent-dev     ○ 空闲       │  │
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘  │
├─────────────────────────────────┤
│  ┌─ agent-sidebar-footer-card ─┐│
│  │ [头像] 用户名         [▾]   ││  ← 用户信息（下拉菜单）
│  │─────────────────────────────││
│  │ [icon] 组织名          [▾]  ││  ← 组织切换
│  └─────────────────────────────┘│
└─────────────────────────────────┘
```

**组件实现**：
- 导航项由 `AgentSidebarQuickNav` 组件（`AgentSidebarConfig.tsx`）渲染
- `AgentSidebarConfig` 组件（原底部导航）**已废弃**，返回 `null`
- 导航分组定义在 `useNavGroups()` hook 中：`navGroupCore`（3 项）+ `navGroupConfig`（9 项）

### 5.3 导航项样式

```css
/* 默认态 */
.agent-sidebar-nav-item {
  color: rgba(255,255,255,0.68);
  background: transparent;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
}

/* 悬停态 */
.agent-sidebar-nav-item:hover {
  color: #fff;
  background: rgba(255,255,255,0.09);
}

/* 激活态 */
.agent-sidebar-nav-item.active {
  color: #fff;
  background: rgba(255,255,255,0.16);
  box-shadow: inset 0 0 0 1px rgba(255,255,255,0.08);
}

/* 活跃指示器 — ::before 伪元素左侧渐变竖线 */
.agent-sidebar-nav-item.active::before {
  width: 3px;
  height: 60%;
  border-radius: 0 2px 2px 0;
  background: linear-gradient(180deg, #6be6ff, #0f6bff);
}
```

> ⚠️ 激活态导航项存在**双重指示器**：`AgentSidebarConfig.tsx:73-77` 使用 Tailwind `border-l-2 border-brand`（2px 蓝色实线），同时 CSS `::before` 产生 3px 渐变竖线覆盖其上。

### 5.4 折叠态（64px icon-only 模式）

- **触发**：点击侧边栏右上角的切换按钮
- **持久化**：`localStorage["agent-panel:sidebar-collapsed"]`
- **过渡**：`width + min-width` 同步过渡，300ms

| 元素 | 正常态 | 折叠态 |
|------|--------|--------|
| nav-item width | `calc(100% - 16px)` | `48px` |
| nav-item padding | `6px 16px` | `10px 0` |
| nav-item justify | `flex-start` | `center` |
| nav-item span (文字) | 显示 | `display: none` |
| sidebar-nav padding | `px-2 py-1` | `0` |
| sidebar-nav overflow | auto | `overflow-x: hidden` |
| active::before left | `0` | `-8px` |
| tree-wrap | 显示 | `visibility: hidden; pointer-events: none` |
| footer 内边距 | 默认 | `8px 10px 12px` |
| user-button | border-bottom 可见 | `border-bottom: none; min-height: 48px; justify-content: center` |
| org 行 | 显示 | `display: none` |

### 5.5 Agent 树

`AgentSidebarTree` 组件（`AgentSidebarTree.tsx`）：

- **数据源**：`agentApi.list()` + `envApi.list()`，15 秒轮询
- **实时刷新**：监听 `useConfigChangeListener("agents")` 事件
- **Agent 卡片**：深色半透明背景（`rgba(255,255,255,0.08)`），悬停变亮 + 青色边框 + 阴影提升，激活态带壳状内阴影和渐变竖线
- **悬停操作**：展开实例 / 重启 / 编辑 / 删除按钮
- **实例行**：展开后显示每个实例的状态指示灯 + 重载/停止按钮，点击跳转聊天
- **Meta Agent 卡片**：专用样式，localStorage 持久化开关

---

## 6. 聊天界面

### 6.1 顶层布局

聊天页面使用 `react-resizable-panels` 实现可拖拽的左右分栏：

```
┌──────────────────────────────────────────────────────────────┐
│  [ChatPanel]                      │  [ArtifactsPanel]       │
│  默认 60% | 最小 30%              │  默认 40% | 可折叠       │
│                                   │                         │
│  ┌── ACPMain ─────────────────┐   │  ┌─ TopModeTabs ────┐  │
│  │ ┌─ ChatHeader (玻璃卡片) ─┐│   │  │ Files │ Sites     │  │
│  │ └─────────────────────────┘│   │  └──────────────────┘  │
│  │ ┌─ 双栏 ──────────────────┐│   │  ┌─ 文件树 popover ─┐  │
│  │ │ SidebarSessionList│Chat ││   │  │ 文件树 │ 预览    │  │
│  │ │ 可折叠             │    ││   │  │ 或 Site iframe   │  │
│  │ │                    │    ││   │  └──────────────────┘  │
│  │ │               ChatView ││   │                         │
│  │ │               ──────── ││   │                         │
│  │ │               Error    ││   │                         │
│  │ │               Banner   ││   │                         │
│  │ │               ──────── ││   │                         │
│  │ │               ChatCom- ││   │                         │
│  │ │               poser    ││   │                         │
│  │ └────────────────────────┘│   │                         │
│  └───────────────────────────┘   │                         │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 聊天组件层级

| 组件 | 文件 | 职责 |
|------|------|------|
| `ChatPanel` | `web/src/pages/agent-panel/ChatPanel.tsx` | ACP WebSocket relay 连接管理，连接状态 → 渲染决策 |
| `ACPMain` | `web/components/ACPMain.tsx` | 聊天主容器：`ChatHeader` + `SidebarSessionList` + `ChatInterface` |
| `ChatHeader` | 内嵌于 ACPMain | 顶部标题栏（`chat-header-card`）：会话标题、popover、session 切换、按日期分组 |
| `SidebarSessionList` | 内嵌于 ACPMain | 左侧会话历史面板，按日期分组（今天/昨天/更早），可折叠。使用 `session-grouping.ts` 的分组逻辑 |
| `ChatInterface` | `web/components/ChatInterface.tsx` | 核心聊天交互，约 40KB：消息流 + 权限 + Todo + 输入 + 上下文面板 |

**ChatInterface 内部结构**：

```
ChatInterface (flex container)
├── 主聊天区 (flex column, flex-1)
│   ├── ChatView              消息流列表
│   ├── PermissionPanel       待处理权限
│   ├── TodoPanel             待办事项
│   ├── ErrorBanner           红色错误横幅（5-8s 自动消失）
│   └── ChatComposer          玻璃磨砂输入卡
└── ContextPanel              右侧上下文面板
```

### 6.3 ChatComposer — 玻璃磨砂命令岛

```css
.chat-composer-card {
  background: rgba(255,255,255,0.72);
  backdrop-filter: blur(16px) saturate(180%);
  border: 1px solid rgba(255,255,255,0.9);
  border-radius: 20px;
  box-shadow: 0 4px 20px rgba(0,0,0,0.06);
}

/* 暗色模式 */
:root.dark .chat-composer-card {
  background: rgba(45,45,47,0.72);
  border: 1px solid rgba(255,255,255,0.08);
}

/* 聚焦态 — 品牌色微边框 */
.chat-composer-card:focus-within {
  border-color: color-mix(in srgb, var(--color-brand) 8%, transparent);
}
```

**元信息条**（`.chat-composer-meta`）：
- **模式选择器** — `SessionModeSelector` 组件
- **模型选择器** — `ModelSelectorPopover` / `ModelSelectorPicker`（`web/components/model-selector/`）
- **新会话按钮**
- **Token 进度条**：双色条（输入=品牌蓝、输出=绿色），基准 `MAX_CONTEXT_TOKENS = 200000`
- **分隔线**：`.chat-composer-divider`（1px 竖线）

### 6.4 ACP 连接与会话管理

#### 连接流程 (ACPMain)

1. `ChatPanel` 通过 `createRelayClient(agentId)` 创建 WebSocket relay 客户端
2. 管理状态：`disconnected → connecting → connected / error`
3. 监听 `agent:reconnect` 自定义事件实现自动重连
4. 连接后指数退避等待 `capabilities` 就绪
5. 调用 `client.listSessions()` 寻找最新会话自动恢复
6. 无现有会话时通过 `chatRef.current?.newSession()` 创建

#### 断连恢复

- `wasLoadingBeforeDisconnectRef` 记住 loading 状态，重连后恢复
- 解决"断连时工具调用卡在 running"的问题

#### Prompt 完成时工具调用兜底

`finalizeRunningToolCalls()` 函数在 prompt 完成时将仍为 running 的工具调用标记为 complete，防止远程 agent 不推送 completed 状态时 UI 永久转圈。

#### 取消标记链

`userCancelledRef.current = true` 阻止取消后的 `promptComplete` 和 `errorMessage` 弹出误导错误。

### 6.5 打字/思考指示器

**三点弹跳**（`.chat-loading-dots`）：品牌色脉冲 + 发光波纹，1.4s 循环，逐级延迟。

```css
@keyframes loadingDotBounce {
  0%, 80%, 100% { transform: scale(0.4); opacity: 0.3; }
  40%          { transform: scale(1); opacity: 1;
                 box-shadow: 0 0 8px 2px rgba(22,119,255,0.3); }
}
```

暗色模式使用独立 `loadingDotBounceDark` 关键帧（发光增强，alpha 0.35）。

**微光扫过**（`.loading-text-shimmer`）：品牌色渐变在文字上滑动。

### 6.6 消息流核心机制

#### 工具调用嵌套 (`getParentToolUseId`)

带 `parentToolUseId` 的 session update 路由到父工具调用的 `subEntries`，通过 `applySessionUpdateToEntries` 递归处理。子 Agent 消息流在 `SubAgentPanel` 组件中渲染（`web/components/chat/SubAgentPanel.tsx`）。

#### 权限请求 standalone 降级

当工具调用在 entries 中找不到时，创建 `isStandalonePermission: true` 的独立权限条目。批准后立即标记完成而非 running。

#### 图片压缩

ChatInterface 和 ChatComposer 使用 `browser-image-compression` 库压缩上传图片（目标 2MB，最大 2048px，JPEG 转换）。

### 6.7 拖拽分隔 + 折叠

分隔手柄中央嵌入一个按钮（`agent-artifacts-expand-btn`，28×56px），使用 `PanelRight` lucide 图标（不是文字）：

- **拖拽**：鼠标按下 + 移动 → resize
- **切换**：鼠标按下 + 松开（不移动）→ collapse/expand

### 6.8 自动展开策略

- mount 时立即折叠 ArtifactsPanel
- 首次出现 diff 文件时自动展开
- 用户手动收起后不再自动展开
- 窄屏（≤768px）自动折叠

### 6.9 跨组件事件通信

| 事件 | 来源 | 监听者 | 用途 |
|------|------|--------|------|
| `chat:stats` | ChatInterface | `chat.$agentId.tsx` | 广播 entries → 提取 changedFiles → 传给 ArtifactsPanel |
| `chat:inject-skill` | AgentBadge | ChatComposer | 点击技能标签注入聊天 |
| `artifacts:select-site` | 卡片组件 | ArtifactsPanel + `chat.$agentId.tsx` | 触发站点绑定 + 展开面板 |
| `agent:reconnect` | 外部 | ChatPanel | 实例重启后自动重连 |

### 6.10 空状态：AgentBadge 工牌卡

`web/components/chat/AgentBadge.tsx` — 无消息时的占位展示：
- 显示 Agent 名称、描述、技能标签
- 可点击的技能标签触发 `chat:inject-skill` 事件
- 骨架屏加载态：脉冲动画

---

## 7. 聊天高级功能

### 7.1 CommandMenu (Slash 命令)

`web/components/chat/CommandMenu.tsx` — 输入框输入 `/` 时浮现在 ChatComposer 上方：
- 键盘导航（↑↓ 选择，Enter 确认）
- 前缀过滤匹配
- 命令列表涵盖常见操作

### 7.2 Tool Narrator 系统

`web/components/chat/narrators/` 下 16 个 narrator（`bash.ts`、`read.ts`、`write.ts`、`edit.ts`、`grep.ts`、`glob.ts`、`web-search.ts`、`web-fetch.ts` 等），将原始工具调用转换为人类可读文案。使用 `NS.TOOL_NARRATOR` 命名空间做 i18n。

```ts
// 示例：bash narrator 的叙事化输出
// 原始："bash ls -la"
// 叙事："列出了当前目录下的所有文件"
```

### 7.3 工具调用可视化

`tool-status-pill` 系列 `@utility`（`index.css:309-367`）：

| 状态 | utility class | 颜色 |
|------|---------------|------|
| running | `tool-status-pill-running` | 绿色 |
| complete | `tool-status-pill-complete` | 绿色 |
| error | `tool-status-pill-error` | 红色 |
| pending | `tool-status-pill-pending` | 蓝色 |

展开/折叠用 chevron 旋转动画（`.tool-call-chevron` / `.tool-call-chevron-open`），内容区 `max-height` 过渡 `0.25s cubic-bezier(0.4, 0, 0.2, 1)`。

### 7.4 HindsightToolCard

`web/components/chat/HindsightToolCard.tsx` — 记忆工具专属卡片渲染，紫色知识主题，带详细参数弹窗。

### 7.5 PlanView

`web/components/chat/PlanView.tsx` — DAG 执行计划可视化：进度条、优先级标签、折叠展开。

---

## 8. Artifacts 面板

### 8.1 顶层结构

```
┌── ArtifactsPanel ─────────────────────┐
│  ┌─ TopModeTabs ────────────────────┐ │
│  │ Files (badge: pendingDiffCount)  │ │
│  │ Sites                            │ │
│  └──────────────────────────────────┘ │
│  ┌─ 内容区 ─────────────────────────┐ │
│  │ Files 模式:                       │ │
│  │   ┌─ FileTabsBar ──────────────┐ │ │
│  │   │ doc.md  plan.ts  (LRU 8)   │ │ │
│  │   └────────────────────────────┘ │ │
│  │   ┌─ split layout ─────────────┐ │ │
│  │   │ 文件树 popover │ PreviewTab│ │ │
│  │   └────────────────────────────┘ │ │
│  │                                    │ │
│  │ Sites 模式:                       │ │
│  │   ┌─ SiteTabsBar ──────────────┐ │ │
│  │   │ localhost:5173  │ doc site │ │ │
│  │   └────────────────────────────┘ │ │
│  │   ┌─ SiteFrame (iframe) ───────┐ │ │
│  │   │ 站内页面嵌入                  │ │ │
│  │   └────────────────────────────┘ │ │
│  └──────────────────────────────────┘ │
└──────────────────────────────────────┘
```

### 8.2 Files 模式

- **FileTabsBar**：已打开文件的 tab 条，LRU 淘汰策略（最多 8 个）
- **预览/文件树分离**：
  - **文件树 popover**（`agent-artifacts-tree-pane`，200px）：工作区文件浏览器
  - **PreviewTab**（`agent-artifacts-preview-pane`，flex-1）：代码/图片/Markdown/PDF/HTML/表格预览

### 8.3 拖拽上传

ArtifactsPanel 支持完整的文件拖拽上传到 `user/` 目录：

- `dragCounterRef` 跟踪嵌套 dragEnter/dragLeave，防止闪烁
- 拖入文件时自动切换 topMode 到 Files（`userPickedSiteRef` 标记重置）
- 显示 upload progress 进度条
- 切换 agent 后 handler 保持绑定

### 8.4 Sites 模式

- **SiteTabsBar**：绑定的站点列表 tab 切换
- **SiteFrame**：iframe 嵌入站点页面
- **自动绑定**：监听 `artifacts:select-site` 事件，自动调 `agentSitesApi.bindSite()`
  - 并发锁 `autoBindingRef` 防止快速点击重复绑定
- **挂载弹层**：`MountSiteDialog` 组件
- **卸载确认**：`AlertDialog` 组件

### 8.5 pendingDiffCount 角标系统

用户在 Sites 模式下切换时，后台累计 diff 文件数。返回 Files tab 时在 `TopModeTabs` 的 Files 标签上显示角标。独立于自动展开逻辑。

### 8.6 折叠/展开

- 通过 `react-resizable-panels` 的 `PanelImperativeHandle.collapse()/expand()` 控制，动画由库内部管理
- CSS 同时提供 `width 300ms` + `opacity 200ms` 过渡作为补充
- `.collapsed` 类设置 `width: 0; opacity: 0; pointer-events: none`

### 8.7 agentConfigId 解析

优先使用传入的 `agentConfigId` prop，若为 null 则从 `envId` 内部拉取（`GET /v1/environments/:id`）。

---

## 9. 登录页

### 9.1 路由

`/login` — `web/src/routes/login.tsx`，lazy load `LoginPage`。

根路由（`__root.tsx`）在 `useSession()` 返回未认证时自动重定向到 `/login`。

### 9.2 LoginPage

`web/src/pages/LoginPage.tsx`（约 27KB）：

- **登录**：邮箱 + 密码
- **注册**：创建新账户
- **忘记密码**：重置流程
- **组织选择**：登录后选择/切换到所属组织
- 使用 `NS.LOGIN` 命名空间 (en/zh JSON 翻译)

### 9.3 无权限页

`/no-access` — `web/src/routes/no-access.tsx`，显示 403 无权限提示。

---

## 10. Hindsight 记忆模块

### 10.1 路由 & 入口

`/agent/memories` → `web/src/pages/hindsight/MemoriesPage.tsx`

i18n 命名空间：`NS.HINDSIGHT`（`web/src/i18n/locales/{en,zh}/hindsight.json`）。

### 10.2 组件体系

```
web/src/pages/hindsight/
├── MemoriesPage.tsx         主页面
├── types.ts                 类型定义
└── components/
    ├── DataView.tsx          数据集视图 (~54KB, 最大组件)
    ├── Constellation.tsx     3D 星图可视化 (~38KB)
    ├── Graph2d.tsx           Cytoscape 二维图谱
    ├── EntitiesView.tsx      实体视图
    ├── DocumentsView.tsx     文档视图
    ├── MemoryDetailPanel.tsx 记忆详情面板
    ├── ConversationsView.tsx 对话视图
    ├── MentalModelsView.tsx  心智模型视图
    ├── ObservationsView.tsx  观察视图
    └── RelationsView.tsx     关系视图
```

---

## 11. 工作流 UI (Workflow)

### 11.1 路由

| 路由 | 页面 | 说明 |
|------|------|------|
| `/agent/workflow` | WorkflowList / WorkflowRuns | 列表 + 运行记录（tab 切换） |
| `/agent/workflow/$id/edit` | WorkflowEditor | DAG 可视化编辑器 |
| `/agent/workflow/$id/versions` | WorkflowVersions | 版本管理 |

### 11.2 组件体系

```
web/src/pages/workflow/
├── WorkflowList.tsx          工作流列表
├── WorkflowEditor.tsx        可视化编辑器 (~38KB)
├── WorkflowVersions.tsx      版本管理
├── WorkflowRuns.tsx          运行记录
├── WorkflowBreadcrumb.tsx    面包屑导航
├── yaml-utils.ts             YAML 工具函数
├── utils.ts                  通用工具
├── presets.ts                预设模板
├── preset-utils.ts           模板工具
├── layout.ts                 布局工具
├── workflow.css              专用样式
├── components/
│   ├── NodeConfigSheet.tsx   节点配置抽屉
│   ├── NodeConfigCard.tsx    节点配置卡片 (~37KB)
│   ├── NodeConfigPanel.tsx   节点配置面板
│   └── ...                   更多节点组件
└── hooks/
    └── ...                   workflow hooks
```

i18n 命名空间：`NS.WORKFLOWS`。

---

## 12. 页面结构

### 12.1 完整路由表

| 路由路径 | 页面 | 说明 |
|----------|------|------|
| `/` | → `/agent` | 根路径重定向 |
| `/login` | LoginPage | 登录/注册 |
| `/no-access` | 403 页面 | 无权限 |
| `/agent` | → `/agent/home` | 默认入口 |
| `/agent/$agentId` | → `/agent/chat/$agentId` | 兼容重定向 |
| `/agent/$agentId/$sessionId` | → `/agent/chat/$agentId/$sessionId` | 兼容重定向 |
| `/agent/home` | AgentHomePage | AI 智能创建 / 模板创建 |
| `/agent/dashboard` | AgentDashboardPage | **占位页（空壳）** |
| `/agent/agents` | AgentManagementPage | Agent 配置管理 |
| `/agent/chat/$agentId` | ChatPanel + ArtifactsPanel | 聊天页 |
| `/agent/chat/$agentId/$sessionId` | ChatPanel + ArtifactsPanel | 聊天页（指定 session） |
| `/agent/workflow` | WorkflowList / WorkflowRuns | 工作流列表 |
| `/agent/workflow/$id/edit` | WorkflowEditor | 工作流编辑器 |
| `/agent/workflow/$id/versions` | WorkflowVersions | 版本管理 |
| `/agent/tasks` | AgentTasksPage | 定时任务 |
| `/agent/skills` | AgentSkillsPage | Skill 管理 |
| `/agent/sessions` | AgentSessionsPage | 会话列表 |
| `/agent/sites` | AgentSitesPage | 站点/Registry |
| `/agent/models` | AgentModelsPage | 模型配置 |
| `/agent/mcp` | AgentMcpPage | MCP 服务器 |
| `/agent/memories` | MemoriesPage | Hindsight 记忆 |
| `/agent/knowledge-bases` | AgentKnowledgeBasesPage | 知识库 |
| `/agent/organizations` | AgentOrganizationsPage | 组织管理 |
| `/agent/channels` | AgentChannelsPage | IM 通道 |
| `/agent/apikeys` | AgentApiKeysPage | API Key |

### 12.2 Dashboard 状态

**占位实现**：仅显示 `AgentPageHeader`（标题"数据面板"）+ 欢迎文字。无 KPI 卡片、图表或数据可视化。侧边栏导航中**无入口链接**。

### 12.3 配置页面约定

- 使用 `AgentPageHeader` 作为标题栏（`shared/AgentPageHeader.tsx`）
- 使用 `DataTable` 展示列表数据
- 弹窗操作使用 `Dialog` / `AlertDialog`（shadcn/ui）
- 所有用户可见文字通过 `useTranslation()` 国际化
- **未使用统一的配置页面框架**，各页面独立实现

---

## 13. 动效系统

### 13.1 实现方式

**纯 CSS 动画**，不使用 `motion` 库（虽然已安装但未被源码引用）。动画定义分布在：

| 文件 | 定义内容 |
|------|----------|
| `web/src/index.css` | 全局动画（状态脉冲、淡入、打字弹跳、微光、shimmer） |
| `web/src/pages/agent-panel/agent-panel.css` | 面板动画（骨架屏脉冲） |

### 13.2 关键帧

| 动画名 | 文件 | 用途 |
|--------|------|------|
| `status-active-pulse` | `index.css:249` | Agent 运行中状态绿色脉冲 |
| `glowBreathe` | `index.css:281` | 呼吸发光，3s 循环 |
| `fadeUp` | `index.css:295` | 淡入上移 (24px) |
| `loadingDotBounce` | `index.css:418` | 三点打字弹跳 + 发光，1.4s 循环 |
| `loadingDotBounceDark` | `index.css:437` | 暗色三点弹跳（发光增强） |
| `shimmerSlide` | `index.css:471` | "思考中"文字微光滑动 |
| `streamingInputPulse` | `index.css:377` | 流式输入脉冲 |
| `glimmer-pulse` | `index.css:259` | 微光脉冲 |
| `pulse-subtle` | `index.css:269` | 柔和脉冲 |
| `agent-badge-pulse` | `agent-panel.css:787` | 骨架屏加载脉冲，2s |
| `typing-bounce` | — | (已不存在于代码中) |

### 13.3 过渡动画

| 元素 | 时长 | 缓动 |
|------|------|------|
| 侧边栏折叠 | 300ms | `cubic-bezier(0.4,0,0.2,1)` |
| ArtifactsPanel 折叠 | `width` 300ms + `opacity` 200ms | `cubic-bezier(0.4,0,0.2,1)` / ease |
| 导航项悬停 | 150ms | — |
| 工具调用展开 | 250ms | `cubic-bezier(0.4,0,0.2,1)` (max-height) |
| chevron 旋转 | 200ms | ease |

### 13.4 无障碍

```css
@media (prefers-reduced-motion: reduce) {
  *, ::before, ::after {
    animation-duration: 0.01ms;
    animation-iteration-count: 1;
    transition-duration: 0.01ms;
  }
}
```

所有图标有 `aria-label`。

---

## 14. ACP 客户端层

### 14.1 文件结构

```
web/src/acp/
├── types.ts          # ACP 协议类型定义
├── client.ts         # 底层 WebSocket + JSON-RPC 通信
├── relay-client.ts   # Relay 模式客户端（前端与后端 relay 桥接）
└── index.ts          # 导出汇总
```

### 14.2 连接模式

前端不直连 acp-link 进程，而是通过后端 WebSocket relay 桥接：

```
浏览器 ←→ WebSocket relay (后端 /acp/relay) ←→ ACP agent 进程
```

- relay 层拦截 `keep_alive` 不透传前端
- relay 必须转发 agent `status`（前端依赖 `capabilities`）
- 前端断连只关 WS，不终止 acp-link 进程

---

## 15. API 客户端层

### 15.1 SDK 架构

`web/src/api/sdk.ts` — 类架构 SDK，`credentials: "include"`：

```ts
import { envApi, sessionApi } from "@/src/api/sdk";
```

### 15.2 模块分布

| 文件 | 职责 |
|------|------|
| `web/src/api/sdk.ts` | 主 API 客户端 |
| `web/src/api/hindsight.ts` | 记忆模块 API |
| `web/src/api/workflow-defs.ts` | 工作流定义 API |
| `web/src/api/workflow-engine.ts` | 工作流引擎 API |
| `web/src/api/workflow-sse.ts` | 工作流 SSE 事件流 |
| `web/src/api/meta-agent.ts` | Meta Agent API |
| `web/src/lib/use-workflow-events.ts` | 工作流事件 hook |

---

## 16. 组件库

### 16.1 shadcn/ui 组件

`web/components/ui/index.ts` 导出 **33 个组件**，基于 Radix UI 基元 + Tailwind CSS v4。

| 类别 | 组件 |
|------|------|
| 布局 | `card`, `resizable`, `scroll-area`, `separator` |
| 表单 | `button`, `button-group`, `checkbox`, `date-picker`, `form`, `input`, `input-group`, `label`, `select`, `switch`, `textarea` |
| 导航 | `pagination`, `tabs` |
| 弹窗 | `alert-dialog`, `dialog`, `dropdown-menu`, `hover-card`, `popover`, `tooltip` |
| 折叠 | `accordion`, `collapsible`, `sheet` (未导出) |
| 数据展示 | `badge`, `calendar`, `command`, `connection-status`, `progress` (未导出), `skeleton`, `table`, `tree` |
| 工具 | `theme-toggle` |

**架构模式**：
- 使用 `data-slot` 属性匹配样式
- 变体通过 `class-variance-authority` (`cva`) 管理
- `@radix-ui/react-slot` 的 `Slot` 组件实现 `asChild` 多态渲染
- 禁止直接使用 Radix 原生组件

### 16.2 图标系统

| 用途 | 库 | 约束 |
|------|-----|------|
| 通用 UI 图标 | `lucide-react` | 唯一来源，禁止内联 SVG |
| AI 模型/品牌图标 | `@lobehub/icons` | 仅通过 `<ModelIcon>` 渲染，禁止业务代码直接导入 |

**ModelIcon 匹配策略** (`web/components/model-icon/`)：
1. `modelId` 转小写后与本地映射表 `model-icon-map.ts` 做正则前缀匹配
2. 未命中兜底到 `@lobehub/icons` 内置 helper（不做大小写归一化）

> ⚠️ 两层匹配大小写处理不一致（映射表做了 `.toLowerCase()`，内置 helper 不做），是已知维护陷阱。

### 16.3 完整组件目录

```
web/components/
├── ui/                   shadcn/ui (34 files, 33 exported)
├── chat/                 聊天组件
│   └── narrators/        工具叙事器 (16 files)
├── ai-elements/          AI 消息渲染元素
├── config/               配置页通用组件
├── model-icon/           模型图标 (ModelIcon + model-icon-map)
├── model-selector/       模型选择器弹窗 (ModelSelectorPopover + ModelSelectorPicker)
├── index.ts              (空文件)
├── ACPMain.tsx           聊天主容器
├── ACPConnect.tsx        ACP 连接组件
├── ChatInterface.tsx     聊天核心交互 (~41KB)
├── ChatMessage.tsx       单条消息渲染
├── ContextPanel.tsx      上下文面板 (~13KB)
├── MetaAgentPanel.tsx    Meta Agent 面板
├── ThreadHistory.tsx     会话历史 (~11KB)
└── ChangePasswordDialog.tsx  修改密码弹窗
```

### 16.4 通用页面组件

| 组件 | 文件 | 说明 |
|------|------|------|
| `AgentPageHeader` | `shared/AgentPageHeader.tsx` | 页面标题栏 |
| `AgentCardList` | `shared/AgentCardList.tsx` | 卡片列表 |
| `AgentFormDialog` | `AgentFormDialog.tsx` | 创建/编辑 Agent |
| `AgentGenerationForm` | `components/AgentGenerationForm.tsx` | AI 生成表单 |
| `ChangePasswordDialog` | `components/ChangePasswordDialog.tsx` | 修改密码 |

---

## 17. 国际化 (i18n)

### 17.1 技术栈

- `i18next` + `react-i18next`
- 语言检测：`i18next-browser-languagedetector`（localStorage "rcs-lang" → navigator.language）
- 默认语言：英文 (`en`)，支持中文 (`zh`)
- 初始化：`web/src/i18n/index.ts`，启动时阻塞加载所有 JSON

### 17.2 命名空间（22 个）

| `NS` 常量 | 字符串 | 模块 |
|-----------|--------|------|
| `NS.COMMON` | `common` | 通用文本 |
| `NS.LOGIN` | `login` | 登录页 |
| `NS.SIDEBAR` | `sidebar` | 侧边栏 |
| `NS.DASHBOARD` | `dashboard` | Dashboard |
| `NS.AGENTS` | `agents` | Agent 管理 |
| `NS.MODELS` | `models` | 模型配置 |
| `NS.SKILLS` | `skills` | Skill 管理 |
| `NS.MCP` | `mcp` | MCP 管理 |
| `NS.TASKS` | `tasks` | 定时任务 |
| `NS.WORKFLOWS` | `workflows` | 工作流 |
| `NS.SETTINGS` | `settings` | 设置 |
| `NS.SESSIONS` | `sessions` | 会话 |
| `NS.ENVIRONMENTS` | `environments` | 环境 |
| `NS.ORGS` | `orgs` | 组织 |
| `NS.APIKEY` | `apikey` | API Key |
| `NS.CHANNELS` | `channels` | IM 通道 |
| `NS.KNOWLEDGE` | `knowledge` | 知识库 |
| `NS.AGENT_PANEL` | `agentPanel` | Agent 面板通用 |
| `NS.COMPONENTS` | `components` | 公共组件 |
| `NS.HINDSIGHT` | `hindsight` | 记忆模块 |
| `NS.AGENT_HOME` | `agentHome` | 创建 Agent 首页 |
| `NS.TOOL_NARRATOR` | `toolNarrator` | 工具调用叙事化文本 |

### 17.3 规则

- 禁止在 JSX 中硬编码用户可见字符串
- 禁止模块级 `i18n.t()` 调用
- 新增命名空间：创建 en/zh JSON → 注册到 `index.ts`

---

## 18. 技术栈与依赖

### 18.1 核心框架

| 依赖 | 用途 |
|------|------|
| `react` ^19 | UI 框架 |
| `@tanstack/react-router` | 路由（file-based） |
| `tailwindcss` ^4.3 | CSS 框架 |
| `@tailwindcss/vite` ^4.3 | Tailwind v4 Vite 插件 |
| `@tailwindcss/typography` ^0.5 | 排版插件（`@plugin` 方式，非 `plugins` 数组） |
| `typescript` ^5 | 类型系统 |

### 18.2 UI 库

| 依赖 | 用途 |
|------|------|
| `react-resizable-panels` | 可拖拽分栏 |
| `lucide-react` ^1.16 | 通用 UI 图标 |
| `@lobehub/icons` ^5.10 | AI 模型品牌图标 |
| `@radix-ui/react-*` (17 个直接依赖) | UI 基元 |
| `sonner` | Toast 通知 |
| `class-variance-authority` ^0.7 | 组件变体 (cva) |
| `clsx` ^2.1 | 类名拼接 |
| `tailwind-merge` ^3.6 | Tailwind 类合并 |
| `tw-animate-css` ^1.4 | Tailwind 动画 utilities |
| `react-hook-form` | 表单管理 |
| `zod` ^4 | Schema 验证 |
| `browser-image-compression` | 聊天图片压缩 |
| `streamdown` | 消息 Markdown/代码块渲染 |

### 18.3 国际化

| 依赖 | 用途 |
|------|------|
| `i18next` | 国际化核心 |
| `react-i18next` | React 绑定 |
| `i18next-browser-languagedetector` | 语言检测 |

### 18.4 已安装但未使用的依赖

| 依赖 | 说明 |
|------|------|
| `motion` ^12.40 | 已安装，源码中无引用。仅 vite.config 中作为 manualChunk 分组 |
| `recharts` ^3.8 | 已安装，源码中无引用 |

---

## 19. Vite 构建配置

### 19.1 关键配置

`web/vite.config.ts`：

| 配置 | 值 | 说明 |
|------|-----|------|
| `base` | `"/ctrl/"` | 静态资源基础路径，与后端挂载一致 |
| Tailwind 插件 | `tailwindcss()` | Vite 插件方式加载，**必须放在 plugins 第一位** |
| TanStack Router 插件 | `@tanstack/router-plugin/vite` | 自动生成 `routeTree.gen.ts` |

### 19.2 Dev Server Proxy

```ts
{
  "/web": "http://localhost:3000",
  "/api": "http://localhost:3000",
  "/acp": { target: "http://localhost:3000", ws: true }
}
```

### 19.3 分包策略 (manualChunks)

7 个独立 chunk：

| chunk | 内容 |
|-------|------|
| `shiki` | 代码高亮 |
| `mermaid` | 图表渲染 |
| `motion` | 动画库 |
| `ai-sdk` | Vercel AI SDK |
| `radix-ui` | UI 基元 |
| `tanstack` | 路由框架 |
| `hookform` | 表单管理 |

---

## 20. 文件约定

### 20.1 完整目录结构

```
web/
├── src/
│   ├── routes/                           # TanStack Router
│   │   ├── __root.tsx                    # 根（登录守卫、ThemeProvider、OrgProvider）
│   │   ├── index.tsx                     # / → /agent
│   │   ├── login.tsx                     # /login
│   │   ├── no-access.tsx                 # /no-access (403)
│   │   └── agent/
│   │       ├── $agentId.tsx              # 兼容重定向 → /agent/chat/$agentId
│   │       ├── $agentId_.$sessionId.tsx  # 兼容重定向
│   │       ├── _panel.tsx                # AgentPanelLayout
│   │       └── _panel/                   # 子路由
│   │           ├── index.tsx             # → /agent/home
│   │           ├── home.tsx
│   │           ├── dashboard.tsx
│   │           ├── agents.tsx
│   │           ├── chat.$agentId.tsx
│   │           ├── chat.$agentId_.$sessionId.tsx
│   │           ├── workflow.tsx / workflow_.$id.edit.tsx / workflow_.$id.versions.tsx
│   │           ├── tasks.tsx / skills.tsx / sessions.tsx / sites.tsx / models.tsx
│   │           ├── mcp.tsx / memories.tsx / knowledge-bases.tsx
│   │           ├── organizations.tsx / channels.tsx / apikeys.tsx
│   │           └── routeTree.gen.ts      # 自动生成，严禁手动编辑
│   ├── pages/
│   │   ├── LoginPage.tsx
│   │   ├── WorkflowPage.tsx
│   │   ├── agent-panel/
│   │   │   ├── AgentPanelLayout.tsx
│   │   │   ├── AgentAppShell.tsx         # 聊天页顶级容器
│   │   │   ├── AgentPanelPage.tsx        # 占位组件
│   │   │   ├── AgentSidebar.tsx
│   │   │   ├── AgentSidebarConfig.tsx    # QuickNav + 废弃的 Config
│   │   │   ├── AgentSidebarTree.tsx
│   │   │   ├── ChatPanel.tsx
│   │   │   ├── ArtifactsPanel.tsx
│   │   │   ├── AgentFormDialog.tsx
│   │   │   ├── agent-panel.css
│   │   │   ├── components/              # AgentGenerationForm 等
│   │   │   ├── pages/                   # 各页面组件
│   │   │   └── shared/                  # AgentPageHeader, AgentCardList
│   │   ├── workflow/                    # 工作流模块 (13 files + components/ + hooks/)
│   │   └── hindsight/                   # 记忆模块 (MemoriesPage + components/10 files)
│   ├── i18n/
│   │   ├── index.ts
│   │   └── locales/{en,zh}/             # 各 22 个 JSON 文件
│   ├── acp/                             # ACP 客户端层
│   │   ├── types.ts / client.ts / relay-client.ts / index.ts
│   ├── api/                             # API 客户端
│   │   ├── sdk.ts
│   │   ├── hindsight.ts / workflow-defs.ts / workflow-engine.ts / workflow-sse.ts / meta-agent.ts
│   ├── hooks/                           # 通用 hooks (13 files)
│   │   ├── useModels.ts / useACPConnection.ts / useTokens.ts / useCommands.ts ...
│   ├── contexts/                        # React Context
│   │   └── OrgContext.tsx
│   ├── lib/                             # 工具函数
│   │   ├── utils.ts (cn)
│   │   ├── auth-client.ts
│   │   ├── extract-changed-files.ts
│   │   ├── use-workflow-events.ts
│   │   ├── types.ts
│   │   └── card-renderer/              # 卡片渲染系统 (emitter, registry, context, builtins)
│   └── types/                           # 类型声明 (5 files)
├── components/
│   ├── ui/                              # shadcn/ui (34 files, 33 exported, index.ts)
│   ├── chat/                            # 聊天组件 + narrators/ (16 files)
│   ├── ai-elements/                     # AI 消息渲染
│   ├── config/                          # 配置页通用组件
│   ├── model-icon/                      # ModelIcon + model-icon-map
│   ├── model-selector/                  # ModelSelectorPopover + ModelSelectorPicker
│   ├── ACPMain.tsx / ACPConnect.tsx
│   ├── ChatInterface.tsx / ChatMessage.tsx
│   ├── ContextPanel.tsx / MetaAgentPanel.tsx
│   ├── ThreadHistory.tsx / ChangePasswordDialog.tsx
│   └── index.ts
├── index.html                           # <html>, Vite entry
└── vite.config.ts                       # Vite 配置
```

### 20.2 命名约定

| 类型 | 风格 | 示例 |
|------|------|------|
| 路由文件 | camelCase + `$` 动态段 | `chat.$agentId.tsx` |
| React 组件 | PascalCase | `AgentSidebar`, `DataTable` |
| 函数/变量 | camelCase | `handleNavigate`, `formSaving` |
| CSS 类 | kebab-case | `agent-panel-layout` |
| CSS 变量 | kebab-case | `--agent-sidebar-width` |
| JSON 翻译 key | camelCase | `"createAgent"` |

### 20.3 路径别名

| 别名 | 实际路径 | 用途 |
|------|----------|------|
| `@/src` | `web/src/` | 页面内引用 (api/, i18n/, lib/, hooks/, types/ 等子目录也在此范围) |
| `@/components` | `web/components/` | 组件引用 |
| `@server` | `../src` | 后端引用 |

---

## 21. 性能注意事项

| 关注点 | 策略 |
|--------|------|
| 动画性能 | 纯 CSS 动画（transform + opacity），无 JS 布局重排 |
| 字体加载 | 零外部字体，系统字体栈，无 FOIT |
| 代码分割 | `React.lazy` → 聊天组件按需加载；Vite `manualChunks` 7 个独立包 |
| 实时数据 | Agent 树 15 秒轮询 + `configChangeListener` 事件驱动 |
| 暗色模式 | CSS 变量切换（`.dark` 类），不重新渲染 |
| 无障碍 | `prefers-reduced-motion` 全局禁用动画 |

---

## 22. 设计参考

| 产品 | 借鉴点 |
|------|--------|
| **Linear** | 侧边栏交互、白色清爽感 |
| **Stripe** | 明亮科技风、数据卡片 |
| **Notion** | 白色基底、留白节奏 |

---

## 23. 维护注意事项

### 23.1 新增页面

1. `web/src/routes/agent/_panel/` 下创建路由文件
2. `web/src/pages/agent-panel/pages/` 下创建页面组件
3. 如需新 i18n namespace：创建 en/zh JSON → 注册 `web/src/i18n/index.ts`
4. 如需侧边栏入口：在 `AgentSidebarConfig.tsx` 的 `useNavGroups()` 中添加
5. `routeTree.gen.ts` **严禁手动编辑**

### 23.2 CSS 修改

- 全局 Token：`web/src/index.css` `@theme` 块
- Agent 面板样式：`web/src/pages/agent-panel/agent-panel.css`
- shadcn/ui 样式：`@theme` 中的对应 token
- 组件级样式：优先 Tailwind utility，必要时 `@utility` 或组件级 CSS

### 23.3 构建

- 修改前端后必须 `bun run build:web`
- 提交前必须 `bun run precheck`（格式 + import 排序 + tsc + lint）

---

*本规范由 RCS 团队维护，基于 2026-06-26 代码库实际状态编写。*
