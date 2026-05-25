# 统一智能体面板 (Unified Agent Panel) - 实施计划

**目标:** 新建独立路由页面 `/ctrl/agent/`，使用全新三栏布局 `AppShell`，将侧边栏导航、智能体实例选择、聊天交互、内容展示整合为一个连贯的操作页面。纯前端改动，后端完全复用现有 API。

**技术栈:** React + TypeScript (前端), Tailwind CSS (样式), Vite (构建), Bun test (测试)

**设计文档:** `spec/feature_20260519_F001_unified-agent-panel/spec-design.md`

---

## 改动总览

- 新建 `web/src/pages/agent-panel/` 目录，包含 6 个核心组件文件和 1 个 CSS 文件
- 新建 `web/src/components/agent-panel/` 目录，包含 2 个组件文件
- 修改 `web/src/App.tsx`：增加 `/ctrl/agent/` 路由分发逻辑
- 修改 `web/src/components/shell/Sidebar.tsx`：将 `environments` 导航项跳转改为 `/ctrl/agent/`
- 依赖关系：任务 1（目录结构+样式）为所有后续任务的基础；任务 2（AgentSidebar）和任务 3（ChatPanel）可并行；任务 4（ArtifactsPanel）独立；任务 5（AgentAppShell 集成）依赖 2、3、4；任务 6（路由集成）依赖 5；任务 7（入口改造）依赖 6

---

### 任务 0: 环境准备

**背景:**
确保构建和测试工具链在当前开发环境中可用。

**执行步骤:**

- [ ] 验证 TypeScript 编译无错误
  - `bunx tsc --noEmit 2>&1 | tail -5`
  - 预期: 无 TypeScript 编译错误
- [ ] 验证前端构建工具可用
  - `cd web && bunx vite build 2>&1 | tail -3`
  - 预期: 构建成功
- [ ] 验证 Bun test 可执行
  - `bun test web/src/__tests__/app-i18n.test.ts 2>&1 | tail -5`
  - 预期: 测试框架可用

---

### 任务 1: 创建目录结构与面板专用样式

**背景:**
创建所有新文件所需的目录结构，并编写面板专用 CSS 变量和样式。

**涉及文件:**
- 新建: `web/src/pages/agent-panel/agent-panel.css`
- 新建: `web/src/pages/agent-panel/AgentPanelPage.tsx`（占位文件）
- 新建: `web/src/components/agent-panel/ArtifactPreview.tsx`（占位文件）
- 新建: `web/src/components/agent-panel/ArtifactContext.tsx`（占位文件）

**执行步骤:**

- [ ] 创建目录结构
  - `mkdir -p web/src/pages/agent-panel web/src/components/agent-panel`

- [ ] 编写 `agent-panel.css` — 面板专用样式
  - CSS 变量: `--agent-sidebar-width: 220px`, `--agent-sidebar-collapsed: 60px`, `--agent-artifacts-width: 400px`, `--agent-artifacts-min: 300px`, `--agent-artifacts-max: 600px`
  - 三栏布局容器 `.agent-panel-layout`: `display: flex; height: 100%`
  - 左侧边栏 `.agent-sidebar`: 固定宽度，transition 动画，`.collapsed` 变为 60px
  - 中间聊天 `.agent-chat-area`: `flex: 1; min-width: 0`
  - 右侧 Artifacts `.agent-artifacts`: 固定宽度，`.collapsed` 宽度归零
  - 拖拽分隔线 `.agent-artifacts-resize-handle`: 4px 宽，hover 高亮
  - 智能体树样式: `.agent-tree-template`（灰色小字）、`.agent-tree-instance`（实色可点击）
  - 状态指示灯 `.status-dot`: 8px 圆点，按状态着色

- [ ] 创建占位文件
  - `AgentPanelPage.tsx`: 空组件 `<div>Agent Panel (placeholder)</div>`
  - `ArtifactPreview.tsx`: 接收 `entries` props 的空组件
  - `ArtifactContext.tsx`: 接收 `entries` props 的空组件

---

### 任务 2: AgentSidebar — 左侧边栏

**背景:**
实现左侧边栏，包含品牌区、配置导航区（复用 NAV_GROUPS）、智能体树（模板→实例两层）、团队切换器。

**涉及文件:**
- 新建: `web/src/pages/agent-panel/AgentSidebar.tsx`
- 新建: `web/src/pages/agent-panel/AgentSidebarConfig.tsx`
- 新建: `web/src/pages/agent-panel/AgentSidebarTree.tsx`

**执行步骤:**

- [ ] 实现 `AgentSidebarConfig.tsx` — 配置导航区
  - 复用 Sidebar.tsx 的 `NAV_GROUPS` 常量，排除 `environments` 条目
  - 点击调用 `onNavigate(pageId)`，上层处理跳转到 `/ctrl/xxx`
  - 折叠后只显示图标

- [ ] 实现 `AgentSidebarTree.tsx` — 智能体树
  - 数据获取: `apiFetchEnvironments()` + 各环境实例列表 API
  - 两层结构: 灰色字模板名（分组标题）→ 实色字实例名（可点击）
  - 状态指示灯: 绿色=运行中、黄色=空闲/启动中、灰色=停止、红色=错误
  - 15 秒轮询刷新实例状态
  - 右键/hover 操作菜单: 新建实例、停止、重启、删除

- [ ] 实现 `AgentSidebar.tsx` — 侧边栏主容器
  - 自上而下: 品牌区 → AgentSidebarConfig → AgentSidebarTree（flex-1 overflow-y-auto）→ TeamSwitcher
  - 折叠时添加 `.collapsed` class

---

### 任务 3: ChatPanel — 中间聊天面板

**背景:**
复用 ACPMain 组件，根据是否选中实例显示不同内容。

**涉及文件:**
- 新建: `web/src/pages/agent-panel/ChatPanel.tsx`

**执行步骤:**

- [ ] 实现 `ChatPanel.tsx`
  - 未选中实例: 欢迎空状态（Bot 图标 + 提示文字）
  - 选中实例: 创建 ACP relay client → 渲染 `<ACPMain />`
  - 连接状态管理: connecting(加载动画) → connected(ACPMain) → error(错误+重试)
  - useEffect 创建/销毁 relay client，依赖 instanceId 变化

---

### 任务 4: ArtifactsPanel — 右侧内容面板

**背景:**
实现右侧 Artifacts 面板，支持 tabs 切换、折叠/展开、拖拽调整宽度。

**涉及文件:**
- 新建: `web/src/pages/agent-panel/ArtifactsPanel.tsx`
- 修改: `web/src/components/agent-panel/ArtifactPreview.tsx`
- 修改: `web/src/components/agent-panel/ArtifactContext.tsx`

**执行步骤:**

- [ ] 实现 `ArtifactPreview.tsx` — 预览 Tab
  - 从 entries 中过滤 tool_call 类型的文件操作（Write/Edit/Read）
  - 渲染为代码块列表: 文件名标签 + 语法高亮 + 复制按钮
  - 无内容时显示空状态

- [ ] 实现 `ArtifactContext.tsx` — 上下文 Tab
  - 包装现有 `ContextPanel` 组件，传入 entries 等参数

- [ ] 实现 `ArtifactsPanel.tsx` — 面板主容器
  - 顶部 Tab 栏: [预览] [上下文] [×]
  - Tab 切换持久化到 localStorage (`agent-panel:artifacts-tab`)
  - 折叠/展开交互
  - 拖拽调整宽度 (300-600px)

---

### 任务 5: AgentAppShell — 新 AppShell 集成三栏

**背景:**
创建新的 AgentAppShell 组件，管理顶层状态（折叠、选中实例、URL 同步），集成三栏布局。

**涉及文件:**
- 新建: `web/src/pages/agent-panel/AgentAppShell.tsx`

**执行步骤:**

- [ ] 实现 `AgentAppShell.tsx`
  - 顶层状态: selectedInstanceId, sidebarCollapsed, artifactsCollapsed, chatEntries
  - localStorage 持久化折叠状态
  - URL 同步: 选中实例时 `history.pushState` 更新为 `/ctrl/agent/:instanceId`
  - 配置导航跳转: `window.location.href = '/ctrl/${page}'`
  - 响应式: 窄屏 (<768px) 自动折叠侧边栏和 Artifacts
  - 渲染三栏: AgentSidebar + ChatPanel + ArtifactsPanel

---

### 任务 6: 路由集成 — App.tsx

**背景:**
修改 App.tsx 路由解析，增加 `/ctrl/agent/` 前缀判断。

**涉及文件:**
- 修改: `web/src/App.tsx`

**执行步骤:**

- [ ] 添加 AgentAppShell 的 lazy 导入
- [ ] 新增 state: agentPanelMode, selectedInstanceId, selectedSessionId
- [ ] parseRoute 中增加 `/ctrl/agent/` 前缀拦截
- [ ] render 中支持两种 AppShell 分支渲染

---

### 任务 7: 入口改造 — Sidebar 导航项跳转

**背景:**
修改现有 Sidebar 的「智能体」导航项跳转到新面板。

**涉及文件:**
- 修改: `web/src/components/shell/Sidebar.tsx`

**执行步骤:**

- [ ] environments 导航项点击改为 `window.location.href = '/ctrl/agent/'`
- [ ] 确保 `/ctrl/environments` 直接访问仍显示 EnvironmentsPage

---

### 任务 8: ArtifactsPanel entries 数据流打通

**背景:**
将 ChatPanel 内部的聊天消息数据传递到 ArtifactsPanel。

**涉及文件:**
- 修改: `web/src/pages/agent-panel/ChatPanel.tsx`
- 修改: `web/src/pages/agent-panel/AgentAppShell.tsx`

**执行步骤:**

- [ ] ChatPanel 添加 `onEntriesChange` 回调
- [ ] AgentAppShell 管理 chatEntries 状态，传递给 ArtifactsPanel
- [ ] 可能方案: 监听 ACPClient 消息事件维护 entries 副本，或给 ACPMain 添加 onEntriesChange prop

---

### 任务 9: 最终集成与验收测试

**背景:**
完成所有组件集成，进行全面验收。

**执行步骤:**

- [ ] 前端构建无编译错误: `cd web && bunx vite build`
- [ ] 通过 `/ctrl/agent/` 进入智能体面板
- [ ] 左侧边栏显示配置导航区和智能体树
- [ ] 点击实例后 Chat 加载 ACP 中继会话
- [ ] 未选中实例显示欢迎空状态
- [ ] Artifacts 面板支持预览/上下文 Tab 切换
- [ ] Artifacts 面板可折叠/展开，状态记忆到 localStorage
- [ ] 侧边栏支持折叠为图标模式
- [ ] 所有现有页面 (/ctrl/*) 不受影响
- [ ] 现有 Sidebar「智能体」导航项跳转到新面板
- [ ] 从新面板配置导航区可跳回旧布局
- [ ] 运行所有前端测试: `bun test web/src/__tests__/`

---

## 实现要点与风险

1. **ACPMain 复用无需修改**: ACPMain 接收 ACPClient props 即可独立工作
2. **entries 数据流是最复杂的设计点**: ACPMain 内部 entries 不对外暴露，需要通过 ACPClient 事件监听或添加 onEntriesChange prop
3. **路由不使用 react-router**: 基于 window.location.pathname + history.pushState 手动路由
4. **CSS 隔离**: 新面板使用 agent-panel.css 专用样式，三栏用 flexbox
5. **性能**: 智能体树用 useMemo 缓存，轮询间隔 15 秒，Chat 虚拟滚动由 ACPMain 内部支持

### 关键参考文件

| 文件 | 作用 |
|------|------|
| `web/src/App.tsx` | 路由入口，添加 /ctrl/agent/ 路由 |
| `web/components/ACPMain.tsx` | Chat 面板核心复用组件 |
| `web/src/components/shell/Sidebar.tsx` | NAV_GROUPS 常量和视觉样式参考 |
| `web/components/ContextPanel.tsx` | Artifacts 上下文 Tab 复用 |
| `web/src/pages/SessionDetail.tsx` | ACP relay client 连接管理模式参考 |
