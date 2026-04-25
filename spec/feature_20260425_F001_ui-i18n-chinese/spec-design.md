# Feature: 20260425_F001 - ui-i18n-chinese

## 需求背景

当前项目前端界面混用中英文，部分页面（如 Dashboard、LoginPage、ApiKeyManager、SessionList、EnvironmentList、Sidebar 等）完全使用英文文本，而另一部分页面（如 ModelsPage、AgentsPage、SkillsPage、PermissionTab）已使用中文。界面语言不一致影响用户体验。

## 目标

- 将所有界面文本统一为中文，保持语言一致性
- 保留专有名词英文：Agent、API Key、Session、Dashboard、ACP
- 采用硬编码替换方式，不引入 i18n 框架
- 不改动 UI 布局和交互逻辑

## 方案设计

### 汉化范围与翻译对照表

按文件逐个列出需替换的英文文本：

#### 1. `web/src/App.tsx`

| 原文 | 中文 |
|------|------|
| `label: "Dashboard"` | `label: "仪表盘"` |
| `label: "Session"` | `label: "会话"` |
| `label: "API Keys"` | `label: "API Key"` |
| `"Loading..."` | `"加载中..."` |
| `"API Keys"`（pageTitle） | `"API Key"` |
| `"Session"`（pageTitle） | `"会话"` |
| `"Dashboard"`（pageTitle） | `"仪表盘"` |

#### 2. `web/src/pages/Dashboard.tsx`

| 原文 | 中文 |
|------|------|
| `"Agents"`（统计卡片标题） | `"Agent"` |
| `"Sessions"`（统计卡片标题） | `"会话"` |
| `"Active"`（统计卡片标题） | `"活跃"` |
| `"Agents"`（区域标题） | `"Agent"` |
| `"Sessions"`（区域标题） | `"会话"` |

#### 3. `web/src/pages/LoginPage.tsx`

| 原文 | 中文 |
|------|------|
| `"Create Account"` | `"创建账户"` |
| `"Sign In"` | `"登录"` |
| `"Create an account to manage your agents"` | `"创建账户以管理你的 Agent"` |
| `"Sign in to manage your agents"` | `"登录以管理你的 Agent"` |
| `Name`（label） | `"名称"` |
| `"Your name"`（placeholder） | `"你的名称"` |
| `Email`（label） | `"邮箱"` |
| `Password`（label） | `"密码"` |
| `"Please wait..."` | `"请稍候..."` |
| `"Already have an account?"` | `"已有账户？"` |
| `"Don't have an account?"` | `"没有账户？"` |
| `"Registration failed"` | `"注册失败"` |
| `"Login failed"` | `"登录失败"` |
| `"Unknown error"` | `"未知错误"` |

#### 4. `web/src/pages/ApiKeyManager.tsx`

| 原文 | 中文 |
|------|------|
| `"Loading..."` | `"加载中..."` |
| `"← Back"` | `"← 返回"` |
| `"API Keys"`（标题） | `"API Key"` |
| `"Failed to load API keys"` | `"加载 API Key 失败"` |
| `"Failed to create key"` | `"创建 Key 失败"` |
| `"Failed to delete key"` | `"删除 Key 失败"` |
| `"Failed to update label"` | `"更新标签失败"` |
| `"API Key Created"` | `"API Key 已创建"` |
| `"Copy this key now. You won't be able to see it again."` | `"请立即复制此 Key，之后将无法再查看。"` |
| `"Copy"` | `"复制"` |
| `"Dismiss"` | `"关闭"` |
| `"Create New Key"` | `"创建新 Key"` |
| `"Label (optional)"` | `"标签（可选）"` |
| `"Create"` | `"创建"` |
| `"No API keys yet. Create one above to connect your agents."` | `"暂无 API Key。请在上方创建一个以连接你的 Agent。"` |
| `"Unnamed"` | `"未命名"` |
| `"Edit"` | `"编辑"` |
| `"Delete"` | `"删除"` |
| `"Save"` | `"保存"` |
| `"Cancel"` | `"取消"` |

#### 5. `web/src/components/shell/Sidebar.tsx`

| 原文 | 中文 |
|------|------|
| `"Collapse"` | `"收起"` |
| `"Expand sidebar"`（title） | `"展开侧栏"` |
| `"Collapse sidebar"`（title） | `"收起侧栏"` |

#### 6. `web/src/components/EnvironmentList.tsx`

| 原文 | 中文 |
|------|------|
| `"No active environments"` | `"暂无活跃环境"` |
| `"ACP Agent"` | `"ACP Agent"`（保留） |
| `"Claude Code"` | `"Claude Code"`（保留） |

#### 7. `web/src/components/SessionList.tsx`

| 原文 | 中文 |
|------|------|
| `"No sessions yet"` | `"暂无会话"` |

### 不需修改的文件

以下文件已完成汉化，无需改动：

- `web/src/pages/ModelsPage.tsx` — 已使用中文
- `web/src/pages/AgentsPage.tsx` — 已使用中文
- `web/src/pages/SkillsPage.tsx` — 已使用中文
- `web/src/components/PermissionTab.tsx` — 已使用中文
- `web/src/components/Navbar.tsx` — 仅 StatusBadge，展示的是状态码

### 专有名词保留规则

| 保留原文 | 理由 |
|---------|------|
| Agent | 用户要求保留 |
| API Key | 用户要求保留 |
| Session | 技术专有名词，业内通用 |
| Dashboard | 技术专有名词，业内通用 |
| ACP | 协议缩写 |
| Claude Code | 产品名 |
| NPM / npm | 技术生态名词 |
| Base URL | 技术专有名词 |
| Prompt | AI 领域通用术语 |

## 实现要点

- 纯文本替换，每个文件使用 Edit 工具逐处替换
- 不引入任何新依赖或框架
- 不修改组件 props 接口或逻辑代码
- `web/src/components/shell/AppShell.tsx` 本身无需修改，其 title 由 App.tsx 传入
- `web/src/components/Navbar.tsx` 的 StatusBadge 直接展示 status 字段值，这些值来自后端 API，不做翻译

## 验收标准

- [ ] 所有 `web/src/` 下 .tsx 文件的界面可见文本均为中文（专有名词除外）
- [ ] 登录页、Dashboard、API Key 管理页、侧栏、环境列表、会话列表均已汉化
- [ ] 已汉化的页面（模型、Agent、技能、权限）不受影响
- [ ] 无新增依赖
