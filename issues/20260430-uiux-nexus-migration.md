# UIUX 迁移 Todo — Nexus Command Center 样式升级

> 设计稿: `design-preview.html` → 目标项目: `web/` 前端
> 目标品牌色: `#409EFF` (SaaS Blue) → `#6366F1` (Indigo/Nexus)
> 当前 Shell: 水平顶部导航栏 → 设计稿: 左侧 Sidebar + Topbar 组合

---

## Phase 1: Design Token 基础层（全局变量 + 字体）

### TODO-1.1 颜色体系迁移
**现状**: `web/src/index.css` 使用 SaaS Blue 主题 (`#409EFF`)
**目标**: Nexus Indigo 主题 (`#6366F1`)

- [x] 替换品牌色: `--color-brand` 从 `#409EFF` → `#6366F1`
- [x] 新增品牌色辅助色: `--brand-light: #818CF8`, `--brand-subtle: rgba(99,102,241,0.08)`, `--brand-glow: rgba(99,102,241,0.15)`
- [x] 新增 Cyan 强调色: `--cyan: #22D3EE`, `--cyan-subtle: rgba(34,211,238,0.10)`
- [x] 替换 Surface 层级:
  - `surface-void: #F8FAFC` (页面底色)
  - `surface-base: #FFFFFF` (卡片底色)
  - `surface-elevated: #FFFFFF` (浮起层)
  - `surface-overlay: #F1F5F9` (遮罩)
  - `surface-hover: #EEF2FF` (悬停，带紫调)
- [x] 替换边框色: `--border-subtle: rgba(0,0,0,0.06)`, `--border-default: rgba(0,0,0,0.10)`, `--border-active: rgba(99,102,241,0.35)`
- [x] 替换文字色:
  - `--text-bright: #0F172A` (标题)
  - `--text-primary: #334155` (正文)
  - `--text-secondary: #64748B` (辅助)
  - `--text-dim: #94A3B8` (禁用/标签)
- [x] 统一语义状态色:
  - `--status-active: #10B981` (运行中)
  - `--status-idle: #6366F1` (空闲)
  - `--status-error: #EF4444` (错误)
  - `--status-warning: #F59E0B` (警告)
- [x] 更新 Shadow 系统: `--shadow-card`, `--shadow-elevated`

**影响文件**: `web/src/index.css`, `web/components/ui/` 中使用硬编码颜色的组件

---

### TODO-1.2 字体系统迁移
**现状**: 主字体 Inter, 等宽 JetBrains Mono
**目标**: Display = Geist Sans, Body = DM Sans, Mono = JetBrains Mono

- [x] 添加 Geist Sans 字体引入 (CDN 或本地)
- [x] 添加 DM Sans 字体引入 (Google Fonts)
- [x] 保留 JetBrains Mono (已有)
- [x] 定义字体变量: `--font-display`, `--font-body`, `--font-mono`
- [x] 更新全局 `font-family` 为 `--font-body`，基础字号 `13px`

**影响文件**: `web/src/index.css`, `web/index.html` (字体 link)

---

### TODO-1.3 布局常量
- [x] 定义: `--sidebar-width: 240px`, `--sidebar-collapsed: 60px`, `--topbar-height: 56px`
- [x] 定义: `--radius: 8px`, `--radius-lg: 12px`
- [x] 统一 scrollbar 样式 (6px 宽，圆角，半透明)

**影响文件**: `web/src/index.css`

---

## Phase 2: Shell 布局重构（Sidebar + Topbar）

### TODO-2.1 Sidebar 组件
**现状**: `web/src/components/shell/AppShell.tsx` — 水平 Header + 横向 Tab 导航
**目标**: 左侧 Sidebar（可折叠）+ 右侧主内容区

- [x] 新建 `web/src/components/shell/Sidebar.tsx`
- [x] 实现折叠/展开切换（`collapsed` state，宽度 240px ↔ 60px 动画）
- [x] Brand 区域: 图标 "R" + 文字 "RCS" + 折叠按钮
- [x] 导航分组:
  - "控制台" 组: 概览、智能体、模型、会话
  - "配置" 组: Skills、MCP、定时任务、Channels、API Key
- [x] 导航项: Lucide 图标 + 文字标签，active 态有左侧 3px 品牌色指示条
- [x] 底部状态面板: Agents 运行数 (LIVE badge)、活跃会话数、events/min
- [x] 折叠态: 只显示图标，label 隐藏，状态面板缩为圆点

**影响文件**: 新建 `Sidebar.tsx`, 修改 `AppShell.tsx`

---

### TODO-2.2 Topbar 组件
**现状**: 导航栏与 Header 合一
**目标**: 独立 Topbar（56px 高）

- [x] 新建/重构 `web/src/components/shell/Topbar.tsx`
- [x] 左侧: 面包屑导航 (`Dashboard / 概览`)
- [x] 右侧: 搜索框 (Cmd+K hint) + 用户头像 (首字母)
- [x] 搜索框样式: 圆角边框、hover 态变化、kbd 标签

**影响文件**: 新建 `Topbar.tsx`, 修改 `AppShell.tsx`

---

### TODO-2.3 AppShell 重构
**现状**: 单列 flex 布局 (header + content)
**目标**: `Sidebar | Main(Sidebar + Topbar + Content)`

- [x] 重构 `AppShell.tsx` 为左右两栏布局
- [x] 左侧: `<Sidebar />`
- [x] 右侧: `<Topbar />` + `<Content />`
- [x] 全局高度 `100vh`, `overflow: hidden`
- [x] 内容区 `overflow-y: auto`, padding `24px`

**影响文件**: `web/src/components/shell/AppShell.tsx`

---

## Phase 3: Dashboard 概览页重构

### TODO-3.1 KPI Strip（5 张指标卡）
**现状**: `web/src/pages/Dashboard.tsx` — 简单的环境/会话列表
**目标**: 5 列 KPI 指标卡片条

- [x] KPI 卡片组件: 图标 + 趋势标签 + 大数字 + 标签 + sparkline SVG 背景
- [x] 5 张卡片: 智能体数、会话数、模型数、可用率(%)、定时任务数
- [x] 数字入场动画 (easeOut counter)
- [x] hover 提升 + 阴影效果
- [x] glow blob 装饰 (右上角模糊圆形)

**影响文件**: `web/src/pages/Dashboard.tsx`, 可抽 `KPICard.tsx` 组件

---

### TODO-3.2 系统健康度（Health Rings）
- [x] 3 个 SVG 环形进度: Agents 在线率、会话活跃率、配置启用率
- [x] 每个环: 底环 + 进度环 + 中心图标 + 底部标签 + 子标签(分数)
- [x] 进入动画: `stroke-dashoffset` transition

**影响文件**: `Dashboard.tsx`, 可抽 `HealthRing.tsx`

---

### TODO-3.3 Agent 拓扑图
**现状**: 无拓扑可视化
**目标**: SVG 拓扑图，展示 RCS Hub → 各 Agent 的连接关系

- [x] SVG 组件: RCS Hub 中心节点 + Agent 子节点
- [x] 连线: 渐变色 + 数据粒子流动动画 (`<animate>`)
- [x] Agent 节点: 运行中(绿光) / 空闲(靛蓝) / 离线(灰虚线)
- [x] Hub 脉冲动画
- [x] "实时监控中" 脉冲指示器

**影响文件**: `Dashboard.tsx`, 新建 `AgentTopology.tsx`

---

### TODO-3.4 最近活动 Feed
- [x] 活动项列表: 彩色圆点 + 描述文字 + 时间戳
- [x] 颜色按类型区分: green=成功, amber=权限, cyan=工具调用, violet=定时任务
- [x] hover 背景高亮

**影响文件**: `Dashboard.tsx`, 可抽 `ActivityFeed.tsx`

---

### TODO-3.5 快速统计面板
- [x] 标签-值行: Agent 配置、Skills (6/9)、MCP 服务器 (4/6)、会话归档、定时任务、消息渠道
- [x] 活跃数字用绿色高亮

**影响文件**: `Dashboard.tsx`

---

## Phase 4: 智能体页面（Agent 卡片网格）

### TODO-4.1 Agent Detail Card 组件
**现状**: `web/src/pages/AgentsPage.tsx` — 表格列表
**目标**: 响应式卡片网格 (`auto-fill, minmax(260px, 1fr)`)

- [x] 卡片结构:
  - 顶栏: 状态图标(带背景色) + 名称 + 模型名 + 状态 pill
  - 主体: 2 列统计格 (会话数、Events 数)
  - 底栏: 最后活跃时间 + 操作按钮
- [x] 状态色: 运行中=绿, 空闲=靛蓝, 警告=琥珀, 错误=红
- [x] hover 提升 + 阴影 + 微上移
- [x] 错误状态卡片显示 "重试" 按钮 (danger-ghost)

**影响文件**: `web/src/pages/EnvironmentsPage.tsx`

---

### TODO-4.2 View Toggle（视图切换）
**现状**: 无
**目标**: 表格/卡片视图切换

- [x] 添加 view toggle 组件 (表格图标 / 卡片图标)
- [x] 保留现有 DataTable 视图
- [x] 新增卡片网格视图

**影响文件**: `EnvironmentsPage.tsx`

---

## Phase 5: 会话详情页重构

### TODO-5.1 Session Header 重构
**现状**: `web/src/pages/SessionDetail.tsx` 中简单标题
**目标**: 返回按钮 + Agent 名称 + Session ID + 状态指示 + 时间

- [ ] 返回按钮 (← arrow-left + "返回")
- [ ] 标题格式: `agent-prod / session-abc123`
- [ ] 状态: 绿色脉冲点 + "Running" + "Started 5min ago"

**影响文件**: `web/src/pages/SessionDetail.tsx` 或 ACP 相关会话组件

---

### TODO-5.2 Session Stats Row
**现状**: 无
**目标**: 水平统计条 (Model / Tokens / Tools / Duration)

- [ ] 4 格统计: 图标 + 标签 + 值
- [ ] Model = sonnet-4-6, Tokens = 4.6k/200k, Tools = 21 calls, Duration = 5m 23s
- [ ] 各自有颜色编码 (brand/green/cyan/amber)

**影响文件**: 会话详情页

---

### TODO-5.3 聊天面板样式升级
**现状**: 已有 `ChatInterface` 组件
**目标**: 对齐设计稿的消息样式

- [ ] 消息气泡: user 品牌色背景 + 白字 / assistant 灰色背景 + 深字
- [ ] 圆角: 12px，底部角收窄 (4px)
- [ ] 消息入场动画: `fade-up 0.3s`
- [ ] 输入框: 品牌色 focus ring (`box-shadow: 0 0 0 3px var(--brand-glow)`)
- [ ] 发送按钮: 品牌色圆角按钮
- [ ] Typing indicator: 三点弹跳动画

**影响文件**: ACP 相关 chat 组件

---

### TODO-5.4 Tool Call 可视化
**现状**: 工具调用在消息流中以简单方式展示
**目标**: 结构化工具调用表格

- [ ] 工具调用行组件:
  - 状态色条 (3px 左侧)
  - 状态图标: ⟳ 运行中 / ✓ 完成 / ✗ 失败
  - 工具名 (mono 字体)
  - 状态 pill
  - 描述 (溢出省略)
  - 展开箭头
- [ ] 展开详情: 灰色背景 + mono 代码文本
- [ ] 折叠/展开动画 (`max-height` transition)

**影响文件**: ACP 相关 event 渲染组件

---

### TODO-5.5 Context Panel（右侧信息面板）
**现状**: 无独立侧面板
**目标**: 可折叠右侧面板 (320px)

- [ ] Agent 信息区: 模型、温度、时长
- [ ] Token 消耗环: SVG 圆环进度 + 百分比 + 明细 (输入/输出/总量)
- [ ] 工具使用统计: 水平进度条 (bash/edit/grep/read)
- [ ] 权限请求队列: 琥珀圆点 + 请求描述 + pending 标签
- [ ] 折叠按钮: 圆形浮动按钮，点击折叠/展开
- [ ] 折叠态: `width: 0, opacity: 0` 过渡

**影响文件**: 会话详情页, 新建 `ContextPanel.tsx`, `TokenRing.tsx`, `ToolUsageBar.tsx`

---

## Phase 6: 配置页样式升级

### TODO-6.1 配置页 Header
**现状**: 各配置页 (ModelsPage, AgentsPage 等) 各自标题
**目标**: 统一的页头 + 操作按钮

- [x] 标题: `font-display, 20px, 600`
- [x] 操作区: Import 按钮 (secondary) + 新增按钮 (primary)

**影响文件**: 各配置页 `*Page.tsx`

---

### TODO-6.2 配置页 Tabs + Toolbar
**现状**: 各配置页有各自的 tab 系统
**目标**: 统一 tab 样式 + 搜索/筛选工具栏

- [x] Tabs: 圆角分组, active 态白色背景 + 阴影 (非品牌色填充)
- [x] 搜索框: 带图标 + focus ring
- [x] 筛选/排序按钮

**影响文件**: 各配置页

---

### TODO-6.3 数据表格样式升级
**现状**: `web/src/components/config/DataTable.tsx` — 已有但样式需更新
**目标**: 对齐设计稿的表格交互

- [x] 行 hover: 左侧 3px 品牌色指示条
- [x] 操作按钮: hover 时显示 (`opacity: 0 → 1`)
- [x] 展开行: chevron 旋转 + 展开详情区
- [x] 状态指示器: 脉冲动画 (active) / 静态 (idle) / 呼吸告警 (error)

**影响文件**: `web/src/components/config/DataTable.tsx`

---

## Phase 7: 组件库 & 动画系统

### TODO-7.1 按钮层级
- [ ] `btn-primary`: 品牌色填充 + 白字
- [ ] `btn-secondary`: 白底 + 边框
- [ ] `btn-ghost`: 透明底
- [ ] `btn-danger`: 红色填充
- [ ] `btn-danger-ghost`: 红色文字
- [ ] `active` 态缩放 `scale(0.98)`

**影响文件**: `web/components/ui/button.tsx` (shadcn)，或 Tailwind 配置

---

### TODO-7.2 输入框样式
- [ ] 统一 focus ring: `border-color: var(--brand)` + `box-shadow: 0 0 0 3px var(--brand-glow)`
- [ ] placeholder 色 `--text-dim`

**影响文件**: `web/components/ui/input.tsx`, Tailwind config

---

### TODO-7.3 状态指示器组件
- [ ] 脉冲点 (active): `glow-breathe` 动画 + `pulse-ring` 扩散
- [ ] 静态点 (idle): 无动画
- [ ] 告警点 (error): `glow-alert` 动画
- [ ] 警告点 (warning): 静态琥珀色

**影响文件**: 各 `StatusBadge` 组件, 可抽 `StatusDot.tsx`

---

### TODO-7.4 入场动画系统
- [ ] `fade-up`: 从下渐入 (页面元素)
- [ ] `fade-in`: 简单渐显
- [ ] `slide-in-right`: 右侧滑入
- [ ] `slide-in-bottom`: 底部滑入
- [ ] `message-enter`: 消息气泡入场 (translateY 8px)
- [ ] `timeline-enter`: 时间线从左滑入
- [ ] Stagger 延迟: 子元素依次 50ms 递增
- [ ] `prefers-reduced-motion` 降级

**影响文件**: `web/src/index.css` (Tailwind 层)

---

### TODO-7.5 代码块组件
**现状**: 可能依赖 markdown 渲染器默认样式
**目标**: 自定义代码块

- [ ] 头部: 语言标签 + 复制按钮
- [ ] 复制成功态: 绿色背景 + "已复制" 文字 + 1.5s 自动恢复
- [ ] 代码区: `font-mono, 12px, pre-wrap`

**影响文件**: ACP chat 渲染, 新建 `CodeBlock.tsx`

---

## Phase 8: 响应式 & 暗色模式适配

### TODO-8.1 暗色模式适配
**现状**: 已有暗色模式支持 (theme-toggle)
**目标**: 所有新设计 Token 的暗色版本

- [ ] 暗色 Surface: `void: #0F172A`, `base: #1E293B`, `elevated: #1E293B`
- [ ] 暗色文字: `bright: #F8FAFC`, `primary: #E2E8F0`, `secondary: #94A3B8`, `dim: #64748B`
- [ ] 暗色边框: `subtle: rgba(255,255,255,0.06)`, `default: rgba(255,255,255,0.10)`
- [ ] 暗色背景装饰调整

**影响文件**: `web/src/index.css`, `web/src/lib/theme.ts`

---

### TODO-8.2 响应式断点
- [ ] `sidebar` 在小屏自动折叠
- [ ] KPI strip: `5列 → 3列 → 2列 → 1列` 响应
- [ ] Agent 卡片网格自适应
- [ ] Session 布局: `2列 → 1列` (面板堆叠)

**影响文件**: 各页面组件, `AppShell.tsx`

---

## 执行优先级建议

| 优先级 | 阶段 | 说明 |
|--------|------|------|
| **P0** | Phase 1 (Design Token) | 基础设施，所有后续工作依赖 |
| **P0** | Phase 2 (Shell 布局) | 核心布局变化，影响所有页面 |
| **P1** | Phase 3 (Dashboard) | 最高频访问页面 |
| **P1** | Phase 7.1-7.3 (按钮/输入/状态) | 全局组件，一次性改完 |
| **P2** | Phase 5 (会话详情) | 第二高频页面 |
| **P2** | Phase 6 (配置页) | 现有功能保持，样式微调 |
| **P2** | Phase 4 (智能体卡片) | 增强型功能 |
| **P3** | Phase 7.4-7.5 (动画/代码块) | 锦上添花 |
| **P3** | Phase 8 (响应式/暗色) | 完善阶段 |

---

## 迁移注意事项

1. **渐进式迁移**: Phase 1 (Token) 可以做到"改完立即生效"，不需要改组件逻辑，只需改 CSS 变量
2. **Phase 2 (Shell) 是最大的破坏性变更**: 需要同步修改 `App.tsx` 的路由逻辑和 `AppShell.tsx` 的布局结构
3. **图标系统**: 设计稿使用 Lucide Icons，项目已有 shadcn/ui + lucide-react，无需更换
4. **组件库**: 项目使用 shadcn/ui，大部分组件已有，只需调整样式参数（variant 颜色等）
5. **前后依赖**: Phase 1 完成后再启动 Phase 2-6 的任何工作，否则颜色/字体/间距不一致
6. **构建步骤**: 每次修改前端代码后必须 `bun run build:web`
