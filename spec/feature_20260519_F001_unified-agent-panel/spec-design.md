# Feature: 20260519_F001 - unified-agent-panel

## 需求背景

当前前端布局中，智能体管理（EnvironmentsPage）和会话交互（SessionDetail / ACPSessionDetail）是分离的两个页面，用户需要在不同页面之间切换才能完成"查看智能体 → 选择实例 → 开始对话"的操作流程。同时，会话过程中缺乏对 AI 生成内容和上下文信息的集中展示区域。

需要一个统一的新智能体面板，将侧边栏导航、智能体实例选择、聊天交互、内容展示整合为一个三栏布局的独立页面，提供连贯的操作体验。

## 目标

- 新建独立路由页面，使用全新 AppShell（三栏布局），通过 `/ctrl/agent/` 路由入口访问
- 左侧边栏整合配置导航（可跳回旧布局）和智能体树（模板 → 实例两层结构）
- 中间 Chat 面板复用现有 ACP 中继会话（ACPMain）
- 右侧 Artifacts 面板支持 tabs 切换（AI 内容预览 / 上下文面板），可折叠
- 纯前端改动，后端完全复用现有 API

## 方案设计

### 路由与入口

**新增路由前缀 `/ctrl/agent/`**，独立于现有 `/ctrl/` 路由体系。两个路由体系通过不同的 AppShell 渲染：

```
App.tsx 路由分发:
├── /ctrl/*        → 现有 AppShell + 各配置页面（不变）
└── /ctrl/agent/*  → AgentAppShell (新) + 智能体面板
```

**URL 结构**：

| URL | 含义 | 面板状态 |
|-----|------|----------|
| `/ctrl/agent/` | 智能体面板首页 | 显示欢迎空状态，提示选择实例 |
| `/ctrl/agent/:instanceId` | 选中某个实例 | Chat 加载该实例的 ACP 会话 |
| `/ctrl/agent/:instanceId/:sessionId` | 选中特定会话 | Chat 加载指定会话 |

**入口改造**：现有 Sidebar 的「智能体」导航项（environments）改为跳转到 `/ctrl/agent/`，取代原来的 EnvironmentsPage。EnvironmentsPage 仍保留，但不再从主侧边栏直接入口。

### 整体布局

```
┌────────────┬────────────────────────┬──────────────────────┐
│            │                        │ [预览] [上下文]  [×]  │
│  Agent     │     Chat Panel         │                      │
│  Sidebar   │   (复用 ACPMain)        │  Artifacts Panel     │
│  220px     │   flex-1 自适应         │  ~400px 可折叠        │
│  可折叠     │                        │                      │
│            │                        │                      │
├────────────┤                        ├──────────────────────┤
│ 团队切换    │                        │ [展开按钮（折叠时）]   │
└────────────┴────────────────────────┴──────────────────────┘
```

三栏使用 CSS flex 布局：
- 左侧 `AgentSidebar`：固定宽度 220px，支持折叠为 60px 图标模式
- 中间 `ChatPanel`：`flex: 1`，自适应填充剩余空间
- 右侧 `ArtifactsPanel`：默认宽度 400px，可通过拖拽调整（300-600px），支持折叠（折叠后仅显示一个展开按钮）

### AgentSidebar 设计

侧边栏自上而下分为三个区域：

```
┌─────────────────────┐
│  XAgent     [折叠]   │  ← 品牌区 + 折叠按钮
├─────────────────────┤
│  ⚙ 配置            │  ← 分组标题（灰色小字）
│    概览             │
│    智能体编排        │
│    模型             │
│    会话             │
│    技能             │
│    知识库           │
│    MCP              │
│    定时任务         │
│    消息渠道         │
│    API Key          │
├─────────────────────┤
│  🤖 智能体          │  ← 分组标题（灰色小字）
│  opencode (灰)       │  ← 智能体模板名（灰色，分组标题）
│    ● instance-1 (白) │    ← 运行实例（实色字 + 状态灯）
│    ○ instance-2 (白) │
│  claude-code (灰)    │
│    ● instance-3 (白) │
├─────────────────────┤
│  团队切换            │  ← 底部团队选择器
└─────────────────────┘
```

**配置导航区**：

- 数据源：复用现有 Sidebar 的 `NAV_GROUPS` 常量（两组：控制台 + 配置）
- 点击行为：跳转回 `/ctrl/xxx` 路由，进入旧布局对应页面
- 不包含"智能体"自身（因为已经在智能体面板内）
- 折叠后只显示图标

**智能体树**：

- 数据来源：
  - 智能体模板列表：复用 `apiFetchEnvironments()`
  - 实例列表：复用 `instancesMap`（`Record<string, EnvironmentInstance[]>`）
- 两层结构：
  - **灰色字（模板）**：`environment.name`，作为分组标题，不可点击选中，仅用于组织
  - **实色字（实例）**：`instance.id` / `instance.name`，可点击选中，点击后中间 Chat 加载该实例
- 状态指示灯：实例旁边的圆点颜色表示运行状态（绿色=运行中、黄色=空闲、灰色=离线）
- 选中态：当前实例高亮背景
- 折叠后：只显示实例的状态灯圆点列表

**实例操作**：

- 右键或 hover 显示操作菜单：新建实例、停止、重启、删除
- 操作复用现有 EnvironmentsPage 的 API 调用逻辑

### ChatPanel 设计

**复用策略**：直接嵌入 `ACPMain` 组件（从 `ACPSessionDetail` 中提取的 ACP 中继聊天组件）。

**状态**：

| 条件 | 显示内容 |
|------|----------|
| 未选中实例 | 欢迎空状态（"请从左侧选择一个智能体实例"） |
| 选中实例（有活跃会话） | ACPMain 聊天界面，加载该实例的会话 |
| 选中实例（无会话） | ACPMain 聊天界面，等待用户发送第一条消息 |

**数据流**：

```
用户点击侧边栏实例
    ↓
更新 selectedInstanceId 状态
    ↓
ACPMain 接收 agentId + instanceId props
    ↓
建立/复用 WebSocket relay 连接
    ↓
消息双向流动（用户 ↔ Agent）
```

**Chat 内部子组件复用**：
- `ChatView`：消息展示
- `ChatInput`：输入框（支持图片粘贴、文件引用）
- `PermissionViews`：权限请求面板（AskUser、Plan、Tool 权限）
- 所有组件通过 `RCSChatAdapter` 管理 WebSocket 通信

### ArtifactsPanel 设计

**顶部 Tab 栏**：

```
┌──────────────────────────────────┐
│  [📋 预览]  [📁 上下文]    [×]  │
├──────────────────────────────────┤
│                                  │
│  (Tab 内容区)                    │
│                                  │
└──────────────────────────────────┘
```

**Tab 1 — 预览（AI 生成内容）**：

- 展示 AI 在会话中生成的代码、文档、文件等可预览内容
- 内容类型：
  - 代码块：语法高亮 + 复制按钮 + 语言标签
  - 文件内容：文件名 + 预览区
  - 文档：Markdown 渲染
- 数据来源：从 Chat 消息流中解析 `tool_use` 类型的消息，提取生成/编辑的文件内容
- 交互：点击代码块可全屏查看，支持复制

**Tab 2 — 上下文**：

- 复用现有 `ContextPanel` 组件
- 展示内容：
  - 工作目录文件列表
  - 工具调用历史（最近的 tool_use 记录）
  - 会话统计（token 使用、消息数等）
- 数据来源：复用 `ContextPanel` 的现有 API 调用

**折叠交互**：

- 默认展开，宽度 400px
- 拖拽左边缘可调整宽度（300-600px）
- 点击 `[×]` 折叠面板，Chat 区域自动填满
- 折叠后在右边缘显示一个竖条按钮（`[▶]`），点击可重新展开
- 折叠状态记忆到 `localStorage`（`agent-panel:artifacts-collapsed`）

### 组件文件结构

```
web/src/
├── pages/
│   └── agent-panel/
│       ├── AgentPanelPage.tsx        ← 顶层页面容器（三栏布局）
│       ├── AgentAppShell.tsx         ← 新 AppShell（替代旧 AppShell）
│       ├── AgentSidebar.tsx          ← 左侧边栏
│       ├── AgentSidebarConfig.tsx    ← 配置导航区
│       ├── AgentSidebarTree.tsx      ← 智能体树
│       ├── ChatPanel.tsx             ← 中间 Chat 面板
│       ├── ArtifactsPanel.tsx        ← 右侧 Artifacts 面板
│       └── agent-panel.css           ← 面板专用样式
├── components/
│   └── agent-panel/
│       ├── ArtifactPreview.tsx       ← 预览 Tab 内容
│       └── ArtifactContext.tsx       ← 上下文 Tab 内容（包装 ContextPanel）
```

### 状态管理

**顶层状态（AgentPanelPage）**：

```typescript
// 选中的实例
const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
// 选中的会话
const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
// 侧边栏折叠
const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
// Artifacts 面板折叠
const [artifactsCollapsed, setArtifactsCollapsed] = useState(
  localStorage.getItem('agent-panel:artifacts-collapsed') === 'true'
);
// 当前 Artifacts tab
const [activeArtifactsTab, setActiveArtifactsTab] = useState<'preview' | 'context'>('preview');
```

**智能体树状态**：

```typescript
// 智能体列表（从 API 获取）
const [environments, setEnvironments] = useState<EnvironmentRecord[]>([]);
// 实例映射（environmentId → instances[]）
const [instancesMap, setInstancesMap] = useState<Record<string, EnvironmentInstance[]>>({});
```

**数据获取**：

- 页面加载时调用 `apiFetchEnvironments()` + 获取各环境实例列表
- 使用 `setInterval`（或 WebSocket 事件）定期刷新实例状态（复用 EnvironmentsPage 的轮询逻辑）

### 路由集成

在 `App.tsx` 的路由解析中增加 `/ctrl/agent/` 前缀判断：

```typescript
// 路由分发逻辑（伪代码）
if (pathname.startsWith('/ctrl/agent/')) {
  // 解析 instanceId、sessionId
  // 渲染 AgentAppShell
  return <AgentAppShell ... />;
} else {
  // 现有逻辑不变
  return <AppShell>...</AppShell>;
}
```

现有 Sidebar 的 `environments` 导航项改为：
```typescript
onNavigate('/ctrl/agent/');
```

### 与现有功能的复用关系

| 组件/功能 | 复用方式 |
|-----------|----------|
| `ACPMain` | 直接嵌入 ChatPanel，传入 agentId + instanceId |
| `ContextPanel` | 包装为 ArtifactContext 组件嵌入 ArtifactsPanel |
| `NAV_GROUPS` | 在 AgentSidebarConfig 中引用，排除 environments 项 |
| `StatusBadge` 颜色逻辑 | 实例状态灯复用相同颜色映射 |
| EnvironmentsPage 的 API 调用 | 提取为共享 hooks（`useEnvironments`、`useInstances`） |
| `TeamSwitcher` | 底部团队选择器直接复用 |
| `RCSChatAdapter` | ACPMain 内部已使用，无需额外处理 |

## 实现要点

1. **纯前端改动**：不涉及后端变更，所有数据通过现有 API 获取（`/web/config/`、`/acp/relay/`、`/v1/environments/`）
2. **组件提取**：`ACPMain` 需要从 `ACPSessionDetail` 中解耦，确保可以独立于 `SessionDetail` 使用。当前 `ACPMain` 已经是独立组件，接收 props 即可工作
3. **布局隔离**：新面板使用独立的 CSS，不影响现有页面的样式。三栏布局使用 flexbox，避免使用绝对定位
4. **状态同步**：智能体树的实例状态需要与 Chat 中的会话状态同步（实例离线时自动断开 Chat 的 WebSocket）
5. **性能考虑**：智能体树中的实例列表使用 `useMemo` 缓存，避免每次渲染重新计算。Chat 消息列表使用虚拟滚动（现有 ACPMain 已支持）
6. **localStorage 持久化**：Artifacts 面板的折叠状态、当前 Tab 选择持久化到 `localStorage`，key 前缀 `agent-panel:`

## 验收标准

- [ ] 通过 `/ctrl/agent/` 路由可进入新的智能体面板
- [ ] 现有 Sidebar 的「智能体」导航项跳转到新面板
- [ ] 左侧边栏显示配置导航区（点击跳回旧布局）和智能体树（模板灰色 + 实例实色）
- [ ] 点击智能体实例后，中间 Chat 加载该实例的 ACP 中继会话
- [ ] 未选中实例时显示欢迎空状态
- [ ] 右侧 Artifacts 面板支持「预览」和「上下文」两个 Tab 切换
- [ ] Artifacts 面板可折叠/展开，折叠状态记忆到 localStorage
- [ ] 侧边栏支持折叠为图标模式
- [ ] 所有现有页面（/ctrl/* 路由）功能不受影响
