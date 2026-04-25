# 界面文本中文化（i18n-chinese）执行计划

**目标:** 将 web/src 下所有英文界面文本统一替换为中文，保留 Agent、API Key、Session、Dashboard、ACP、Claude Code 等专有名词英文，不引入 i18n 框架。

**技术栈:** React 19, TypeScript, Bun (构建与测试), Vite

**设计文档:** spec/feature_20260425_F001_ui-i18n-chinese/spec-design.md

## 改动总览

- 本次改动涉及 7 个前端组件文件（App.tsx、Dashboard.tsx、LoginPage.tsx、ApiKeyManager.tsx、Sidebar.tsx、EnvironmentList.tsx、SessionList.tsx），将英文界面文本硬编码替换为中文，保留 Agent/API Key/Session/Dashboard/ACP/Claude Code 等专有名词英文
- 5 个功能 Task 按文件独立性划分，各 Task 之间无依赖关系，可并行执行
- 采用纯文本替换方式，不引入 i18n 框架，不修改组件 props 接口或逻辑代码，不新增依赖
- 经代码确认：App.tsx 中 "模型"/"Agent"/"技能" 标签已为中文（L127-L145），无需修改；Navbar.tsx 仅展示后端 status 字段值，无需翻译

---

### Task 0: 环境准备

**背景:**
确保前端构建和测试工具链在当前开发环境中可用，避免后续 Task 因环境问题阻塞。

**执行步骤:**

- [x] 验证前端构建工具可用
  - 运行命令: `bun run build:web 2>&1 | tail -5`
  - 预期: 构建成功，输出包含 "built in" 且无 error
- [x] 验证测试框架可用
  - 运行命令: `cd web && bun test 2>&1 | tail -10`
  - 预期: 测试框架运行，输出包含测试结果统计

**检查步骤:**

- [x] 构建命令执行成功
  - `bun run build:web 2>&1 | tail -3`
  - 预期: 构建成功，无错误
- [x] 测试命令可用
  - `cd web && bun test 2>&1 | tail -3`
  - 预期: 测试框架可用，无配置错误

---

### Task 1: App.tsx 界面文本汉化

**背景:**
App.tsx 是前端主入口组件，包含导航栏标签、页面标题和加载状态等英文界面文本。当前这些文本为英文，与已汉化的模型/Agent/技能页面语言不一致。本 Task 将所有英文界面文本替换为中文，无其他 Task 依赖本 Task 的输出。

**涉及文件:**

- 修改: `web/src/App.tsx`
- 新建: `web/src/__tests__/app-i18n.test.ts`

**执行步骤:**

- [x] 替换导航栏 "Dashboard" 标签为 "仪表盘"
  - 位置: `web/src/App.tsx` ~L102
  - 原文: `label: "Dashboard",`
  - 替换为: `label: "仪表盘",`
  - 原因: 仪表盘导航标签需显示中文

- [x] 替换导航栏 "Session" 标签为 "会话"
  - 位置: `web/src/App.tsx` ~L109
  - 原文: `label: "Session",`
  - 替换为: `label: "会话",`
  - 原因: 会话导航标签需显示中文

- [x] 替换底部导航 "API Keys" 标签为 "API Key"
  - 位置: `web/src/App.tsx` ~L120
  - 原文: `label: "API Keys",`
  - 替换为: `label: "API Key",`
  - 原因: 按设计文档统一为 "API Key"（专有名词保留英文，去掉复数形式）

- [x] 替换 pageTitle 中 "API Keys" 为 "API Key"
  - 位置: `web/src/App.tsx` ~L155
  - 原文: `if (showApiKeys) return "API Keys";`
  - 替换为: `if (showApiKeys) return "API Key";`
  - 原因: 页面标题与导航标签保持一致

- [x] 替换 pageTitle 中 "Session" 为 "会话"
  - 位置: `web/src/App.tsx` ~L160
  - 原文: `if (currentSessionId) return "Session";`
  - 替换为: `if (currentSessionId) return "会话";`
  - 原因: 会话页面标题需显示中文

- [x] 替换 pageTitle 默认值 "Dashboard" 为 "仪表盘"
  - 位置: `web/src/App.tsx` ~L161
  - 原文: `return "Dashboard";`
  - 替换为: `return "仪表盘";`
  - 原因: 仪表盘页面标题需显示中文

- [x] 替换会话加载状态文本 "Loading..." 为 "加载中..."
  - 位置: `web/src/App.tsx` ~L168
  - 原文: 在 `if (isPending)` 分支内的 `Loading...`
  - 替换为: `加载中...`
  - 原因: 加载状态提示需显示中文

- [x] 替换 Suspense fallback 文本 "Loading..." 为 "加载中..."
  - 位置: `web/src/App.tsx` ~L191
  - 原文: `<Suspense fallback={<div ...>Loading...</div>}>`
  - 替换为: `<Suspense fallback={<div className="flex h-full items-center justify-center text-text-muted">加载中...</div>}>`
  - 原因: 懒加载占位文本需显示中文

- [x] 为 App.tsx 文本汉化编写单元测试
  - 测试文件: `web/src/__tests__/app-i18n.test.ts`
  - 测试场景:
    - 导航项 navItems 包含中文标签 "仪表盘": 验证 navItems 中 id 为 "dashboard" 的项 label 为 "仪表盘"
    - 会话导航项包含中文标签 "会话": 验证 navItems 中 id 为 "session" 的项 label 为 "会话"
    - 底部导航 footerItems 中 API Key 项 label 为 "API Key": 验证 footerItems 中 id 为 "apikeys" 的项 label 为 "API Key"
    - 源文件中不包含英文标签 "Dashboard"（作为导航标签或 pageTitle）: grep 源文件确认 `label: "Dashboard"` 不存在
    - 源文件中不包含英文标签 `"Session"`（作为导航标签或 pageTitle）: grep 源文件确认 `label: "Session"` 和 `return "Session"` 不存在
    - 源文件中不包含 `"Loading..."`: grep 源文件确认该字符串不存在
    - 源文件中包含 "加载中...": grep 源文件确认该字符串存在
    - 源文件中包含 "仪表盘" 和 "会话": grep 源文件确认中文字符串已写入
  - 运行命令: `cd web && bun test src/__tests__/app-i18n.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证源文件中不再包含 "Dashboard" 英文标签
  - `grep -n '"Dashboard"' web/src/App.tsx`
  - 预期: 无匹配输出（grep 返回退出码 1）

- [x] 验证源文件中不再包含 "Session" 英文标签和页面标题
  - `grep -n 'label: "Session"' web/src/App.tsx; grep -n 'return "Session"' web/src/App.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含 "Loading..."
  - `grep -n '"Loading\.\.\."' web/src/App.tsx`
  - 预期: 无匹配输出

- [x] 验证中文文本已正确写入
  - `grep -n '仪表盘\|会话\|加载中' web/src/App.tsx`
  - 预期: 输出包含 "仪表盘"（至少2处）、"会话"（至少2处）、"加载中..."（2处）

- [x] 验证前端构建无错误
  - `cd web && bun run build 2>&1 | tail -5`
  - 预期: 构建成功，无错误

- [x] 运行本 Task 单元测试
  - `cd web && bun test src/__tests__/app-i18n.test.ts`
  - 预期: 所有测试通过

---

### Task 2: Dashboard.tsx 界面文本汉化

**背景:**
Dashboard.tsx 是仪表盘主页面，包含统计卡片标题（Agents/Sessions/Active）和区域标题（Agents/Sessions）等英文界面文本。当前文本均为英文，需替换为中文以保持界面语言一致。sr-only 标题 "Dashboard" 为屏幕阅读器专有名词，按设计文档规则保留英文。本 Task 无其他 Task 依赖。

**涉及文件:**

- 修改: `web/src/pages/Dashboard.tsx`
- 新建: `web/src/__tests__/dashboard-i18n.test.ts`

**执行步骤:**

- [x] 替换统计卡片标题 "Agents" 为 "Agent"
  - 位置: `web/src/pages/Dashboard.tsx` ~L51
  - 原文: `<div className="text-xs font-medium text-text-muted">Agents</div>`
  - 替换为: `<div className="text-xs font-medium text-text-muted">Agent</div>`
  - 原因: Agent 为专有名词，按设计文档统一使用单数形式 "Agent"

- [x] 替换统计卡片标题 "Sessions" 为 "会话"
  - 位置: `web/src/pages/Dashboard.tsx` ~L55
  - 原文: `<div className="text-xs font-medium text-text-muted">Sessions</div>`
  - 替换为: `<div className="text-xs font-medium text-text-muted">会话</div>`
  - 原因: 会话统计卡片标题需显示中文

- [x] 替换统计卡片标题 "Active" 为 "活跃"
  - 位置: `web/src/pages/Dashboard.tsx` ~L59
  - 原文: `<div className="text-xs font-medium text-text-muted">Active</div>`
  - 替换为: `<div className="text-xs font-medium text-text-muted">活跃</div>`
  - 原因: 活跃数量统计卡片标题需显示中文

- [x] 替换 Agent 列表区域标题 "Agents" 为 "Agent"
  - 位置: `web/src/pages/Dashboard.tsx` ~L68
  - 原文: `<h2 className="mb-3 text-sm font-semibold text-text-primary">Agents</h2>`
  - 替换为: `<h2 className="mb-3 text-sm font-semibold text-text-primary">Agent</h2>`
  - 原因: Agent 区域标题与统计卡片保持一致，使用专有名词单数形式

- [x] 替换 Session 列表区域标题 "Sessions" 为 "会话"
  - 位置: `web/src/pages/Dashboard.tsx` ~L74
  - 原文: `<h2 className="mb-3 text-sm font-semibold text-text-primary">Sessions</h2>`
  - 替换为: `<h2 className="mb-3 text-sm font-semibold text-text-primary">会话</h2>`
  - 原因: 会话区域标题需显示中文

- [x] 保留 sr-only 标题 "Dashboard" 不翻译
  - 位置: `web/src/pages/Dashboard.tsx` ~L46
  - 原文: `<h1 className="sr-only">Dashboard</h1>`
  - 不做修改
  - 原因: Dashboard 为专有名词，sr-only 文本仅供屏幕阅读器使用，按设计文档规则保留英文

- [x] 为 Dashboard.tsx 文本汉化编写单元测试
  - 测试文件: `web/src/__tests__/dashboard-i18n.test.ts`
  - 测试场景:
    - 源文件中统计卡片区域不再包含英文标题 "Agents": 读取源文件，验证字符串 `>Agents<` 不存在
    - 源文件中不再包含英文标题 "Sessions": 读取源文件，验证字符串 `>Sessions<` 不存在
    - 源文件中不再包含英文标题 "Active": 读取源文件，验证字符串 `>Active<` 不存在
    - 源文件中包含中文标题 "会话": 读取源文件，验证 `>会话<` 出现 2 次
    - 源文件中包含中文标题 "活跃": 读取源文件，验证 `>活跃<` 出现 1 次
    - 源文件中包含专有名词 "Agent": 读取源文件，验证 `>Agent<` 出现 2 次（统计卡片 + 区域标题）
    - 源文件中 sr-only 标题保留英文 "Dashboard": 读取源文件，验证 `sr-only">Dashboard` 存在
  - 运行命令: `cd web && bun test src/__tests__/dashboard-i18n.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证源文件中不再包含英文统计卡片标题 "Agents"
  - `grep -n '>Agents<' web/src/pages/Dashboard.tsx`
  - 预期: 无匹配输出（grep 返回退出码 1）

- [x] 验证源文件中不再包含英文标题 "Sessions"
  - `grep -n '>Sessions<' web/src/pages/Dashboard.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含英文标题 "Active"
  - `grep -n '>Active<' web/src/pages/Dashboard.tsx`
  - 预期: 无匹配输出

- [x] 验证中文文本已正确写入
  - `grep -n '>会话<\|>活跃<\|>Agent<' web/src/pages/Dashboard.tsx`
  - 预期: 输出包含 "会话"（2处）、"活跃"（1处）、"Agent"（2处）

- [x] 验证 sr-only 标题保留英文
  - `grep -n 'sr-only.*Dashboard' web/src/pages/Dashboard.tsx`
  - 预期: 输出 1 行，包含 `sr-only">Dashboard`

- [x] 验证前端构建无错误
  - `cd web && bun run build 2>&1 | tail -5`
  - 预期: 构建成功，无错误

- [x] 运行本 Task 单元测试
  - `cd web && bun test src/__tests__/dashboard-i18n.test.ts`
  - 预期: 所有测试通过

---

### Task 3: LoginPage.tsx 界面文本汉化

**背景:**
LoginPage.tsx 是登录/注册页面，包含页面标题、副标题、表单标签、占位符、按钮文本、错误消息和切换链接等英文界面文本。当前文本均为英文，需全部替换为中文以保持界面语言一致。本 Task 无其他 Task 依赖。

**涉及文件:**

- 修改: `web/src/pages/LoginPage.tsx`
- 新建: `web/src/__tests__/login-i18n.test.ts`

**执行步骤:**

- [x] 替换注册错误默认消息
  - 位置: `web/src/pages/LoginPage.tsx` ~L29
  - 原文: `setError(res.error.message || "Registration failed");`
  - 替换为: `setError(res.error.message || "注册失败");`
  - 原因: 注册失败的默认提示需显示中文

- [x] 替换登录错误默认消息
  - 位置: `web/src/pages/LoginPage.tsx` ~L38
  - 原文: `setError(res.error.message || "Login failed");`
  - 替换为: `setError(res.error.message || "登录失败");`
  - 原因: 登录失败的默认提示需显示中文

- [x] 替换未知错误消息
  - 位置: `web/src/pages/LoginPage.tsx` ~L44
  - 原文: `setError(err instanceof Error ? err.message : "Unknown error");`
  - 替换为: `setError(err instanceof Error ? err.message : "未知错误");`
  - 原因: 异常捕获的未知错误提示需显示中文

- [x] 替换页面标题 — "Create Account" / "Sign In"
  - 位置: `web/src/pages/LoginPage.tsx` ~L55
  - 原文: `{isSignUp ? "Create Account" : "Sign In"}`
  - 替换为: `{isSignUp ? "创建账户" : "登录"}`
  - 原因: 页面 h1 标题需显示中文

- [x] 替换副标题 — 注册模式
  - 位置: `web/src/pages/LoginPage.tsx` ~L59
  - 原文: `"Create an account to manage your agents"`
  - 替换为: `"创建账户以管理你的 Agent"`
  - 原因: 注册模式副标题需显示中文，Agent 为专有名词保留英文

- [x] 替换副标题 — 登录模式
  - 位置: `web/src/pages/LoginPage.tsx` ~L60
  - 原文: `"Sign in to manage your agents"`
  - 替换为: `"登录以管理你的 Agent"`
  - 原因: 登录模式副标题需显示中文，Agent 为专有名词保留英文

- [x] 替换名称表单标签
  - 位置: `web/src/pages/LoginPage.tsx` ~L68
  - 原文: 在 `<label>` 标签内的 `Name`
  - 替换为: `名称`
  - 原因: 注册表单的名称字段标签需显示中文

- [x] 替换名称输入框占位符
  - 位置: `web/src/pages/LoginPage.tsx` ~L74
  - 原文: `placeholder="Your name"`
  - 替换为: `placeholder="你的名称"`
  - 原因: 名称输入框的占位提示需显示中文

- [x] 替换邮箱表单标签
  - 位置: `web/src/pages/LoginPage.tsx` ~L82
  - 原文: 在 `<label>` 标签内的 `Email`
  - 替换为: `邮箱`
  - 原因: 邮箱字段标签需显示中文

- [x] 替换密码表单标签
  - 位置: `web/src/pages/LoginPage.tsx` ~L96
  - 原文: 在 `<label>` 标签内的 `Password`
  - 替换为: `密码`
  - 原因: 密码字段标签需显示中文

- [x] 替换提交按钮文本
  - 位置: `web/src/pages/LoginPage.tsx` ~L118
  - 原文: `{loading ? "Please wait..." : isSignUp ? "Create Account" : "Sign In"}`
  - 替换为: `{loading ? "请稍候..." : isSignUp ? "创建账户" : "登录"}`
  - 原因: 提交按钮的三种状态文本（加载中/注册/登录）均需显示中文

- [x] 替换注册模式下 "已有账户" 提示文本
  - 位置: `web/src/pages/LoginPage.tsx` ~L125
  - 原文: `Already have an account?{" "}`
  - 替换为: `已有账户？{" "}`
  - 原因: 切换到登录模式的提示文本需显示中文

- [x] 替换注册模式下切换到登录的链接按钮文本
  - 位置: `web/src/pages/LoginPage.tsx` ~L130
  - 原文: 在 `<button>` 内的 `Sign In`
  - 替换为: `登录`
  - 原因: 切换到登录模式的按钮文本需显示中文

- [x] 替换登录模式下 "没有账户" 提示文本
  - 位置: `web/src/pages/LoginPage.tsx` ~L135
  - 原文: `Don't have an account?{" "}`
  - 替换为: `没有账户？{" "}`
  - 原因: 切换到注册模式的提示文本需显示中文

- [x] 替换登录模式下切换到注册的链接按钮文本
  - 位置: `web/src/pages/LoginPage.tsx` ~L139
  - 原文: 在 `<button>` 内的 `Create Account`
  - 替换为: `创建账户`
  - 原因: 切换到注册模式的按钮文本需显示中文

- [x] 为 LoginPage.tsx 文本汉化编写单元测试
  - 测试文件: `web/src/__tests__/login-i18n.test.ts`
  - 测试场景:
    - 源文件中不再包含英文 "Registration failed": 读取源文件，验证字符串 `"Registration failed"` 不存在
    - 源文件中不再包含英文 "Login failed": 读取源文件，验证字符串 `"Login failed"` 不存在
    - 源文件中不再包含英文 "Unknown error": 读取源文件，验证字符串 `"Unknown error"` 不存在
    - 源文件中不再包含英文标题 "Create Account": 读取源文件，验证字符串 `"Create Account"` 不存在
    - 源文件中不再包含英文标题 "Sign In": 读取源文件，验证字符串 `"Sign In"` 不存在
    - 源文件中不再包含英文副标题 "manage your agents": 读取源文件，验证字符串 `"manage your agents"` 不存在
    - 源文件中不再包含英文 "Please wait...": 读取源文件，验证字符串 `"Please wait..."` 不存在
    - 源文件中不再包含英文标签 "Name"（作为 label 文本）: 读取源文件，验证 `>Name<` 不存在
    - 源文件中不再包含英文标签 "Email"（作为 label 文本）: 读取源文件，验证 `>Email<` 不存在
    - 源文件中不再包含英文标签 "Password"（作为 label 文本）: 读取源文件，验证 `>Password<` 不存在
    - 源文件中不再包含英文占位符 "Your name": 读取源文件，验证 `placeholder="Your name"` 不存在
    - 源文件中不再包含英文 "Already have an account": 读取源文件，验证该字符串不存在
    - 源文件中不再包含英文 "Don't have an account": 读取源文件，验证该字符串不存在
    - 源文件中包含中文 "注册失败": 读取源文件，验证 `"注册失败"` 存在
    - 源文件中包含中文 "登录失败": 读取源文件，验证 `"登录失败"` 存在
    - 源文件中包含中文 "未知错误": 读取源文件，验证 `"未知错误"` 存在
    - 源文件中包含中文 "创建账户": 读取源文件，验证 `"创建账户"` 出现 3 次（标题 + 按钮 + 切换链接）
    - 源文件中包含中文 "登录": 读取源文件，验证 `"登录"` 出现至少 3 次（标题 + 按钮 + 切换链接 + 错误消息）
    - 源文件中包含中文 "名称": 读取源文件，验证 `>名称<` 存在
    - 源文件中包含中文占位符 "你的名称": 读取源文件，验证 `placeholder="你的名称"` 存在
    - 源文件中包含中文 "邮箱": 读取源文件，验证 `>邮箱<` 存在
    - 源文件中包含中文 "密码": 读取源文件，验证 `>密码<` 存在
    - 源文件中包含中文 "请稍候...": 读取源文件，验证 `"请稍候..."` 存在
    - 源文件中包含中文 "已有账户？": 读取源文件，验证 `"已有账户？"` 存在
    - 源文件中包含中文 "没有账户？": 读取源文件，验证 `"没有账户？"` 存在
  - 运行命令: `cd web && bun test src/__tests__/login-i18n.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证源文件中不再包含英文界面文本 "Create Account"
  - `grep -n '"Create Account"' web/src/pages/LoginPage.tsx`
  - 预期: 无匹配输出（grep 返回退出码 1）

- [x] 验证源文件中不再包含英文界面文本 "Sign In"
  - `grep -n '"Sign In"' web/src/pages/LoginPage.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含英文错误消息
  - `grep -n '"Registration failed"\|"Login failed"\|"Unknown error"' web/src/pages/LoginPage.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含英文表单标签
  - `grep -n '>Name<\|>Email<\|>Password<' web/src/pages/LoginPage.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含英文占位符和提示文本
  - `grep -n '"Your name"\|"Please wait..."\|"Already have an account"\|"Don'"'"'t have an account"' web/src/pages/LoginPage.tsx`
  - 预期: 无匹配输出

- [x] 验证中文文本已正确写入
  - `grep -n '创建账户\|登录\|注册失败\|登录失败\|未知错误\|名称\|邮箱\|密码\|请稍候\|已有账户\|没有账户' web/src/pages/LoginPage.tsx`
  - 预期: 输出包含所有中文文本

- [x] 验证前端构建无错误
  - `cd web && bun run build 2>&1 | tail -5`
  - 预期: 构建成功，无错误

- [x] 运行本 Task 单元测试
  - `cd web && bun test src/__tests__/login-i18n.test.ts`
  - 预期: 所有测试通过

---

### Task 4: ApiKeyManager.tsx 界面文本汉化

**背景:**
ApiKeyManager.tsx 是 API Key 管理页面，包含加载状态、页面标题、错误消息、成功提示、按钮文本、输入框占位符和空状态提示等英文界面文本。当前文本均为英文，需全部替换为中文以保持界面语言一致。本 Task 无其他 Task 依赖。

**涉及文件:**

- 修改: `web/src/pages/ApiKeyManager.tsx`
- 新建: `web/src/__tests__/apikey-manager-i18n.test.ts`

**执行步骤:**

- [x] 替换加载失败错误消息
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L30
  - 原文: `setError("Failed to load API keys");`
  - 替换为: `setError("加载 API Key 失败");`
  - 原因: 加载失败时的错误提示需显示中文

- [x] 替换创建失败错误消息
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L48
  - 原文: `setError(err instanceof Error ? err.message : "Failed to create key");`
  - 替换为: `setError(err instanceof Error ? err.message : "创建 Key 失败");`
  - 原因: 创建 API Key 失败时的默认错误提示需显示中文

- [x] 替换删除失败错误消息
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L57
  - 原文: `setError("Failed to delete key");`
  - 替换为: `setError("删除 Key 失败");`
  - 原因: 删除 API Key 失败时的错误提示需显示中文

- [x] 替换更新标签失败错误消息
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L67
  - 原文: `setError("Failed to update label");`
  - 替换为: `setError("更新标签失败");`
  - 原因: 更新标签失败时的错误提示需显示中文

- [x] 替换加载状态文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L74
  - 原文: `Loading...`
  - 替换为: `加载中...`
  - 原因: 页面加载中的状态提示需显示中文

- [x] 替换返回按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L84
  - 原文: `&larr; Back`
  - 替换为: `&larr; 返回`
  - 原因: 返回导航按钮文本需显示中文

- [x] 替换页面标题
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L86
  - 原文: `<h1 className="text-lg font-semibold text-text-primary">API Keys</h1>`
  - 替换为: `<h1 className="text-lg font-semibold text-text-primary">API Key</h1>`
  - 原因: 页面标题按设计文档统一为 "API Key"，去掉复数形式

- [x] 替换创建成功提示标题
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L97
  - 原文: `<p className="text-sm font-medium text-text-primary">API Key Created</p>`
  - 替换为: `<p className="text-sm font-medium text-text-primary">API Key 已创建</p>`
  - 原因: 创建成功后的提示标题需显示中文

- [x] 替换创建成功提示描述
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L99
  - 原文: `Copy this key now. You won't be able to see it again.`
  - 替换为: `请立即复制此 Key，之后将无法再查看。`
  - 原因: 创建成功后的安全提示描述需显示中文

- [x] 替换复制按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L111
  - 原文: `Copy`
  - 替换为: `复制`
  - 原因: 复制按钮文本需显示中文

- [x] 替换关闭按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L118
  - 原文: `Dismiss`
  - 替换为: `关闭`
  - 原因: 关闭成功提示的按钮文本需显示中文

- [x] 替换创建区域标题
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L125
  - 原文: `<h2 className="mb-3 text-sm font-medium text-text-primary">Create New Key</h2>`
  - 替换为: `<h2 className="mb-3 text-sm font-medium text-text-primary">创建新 Key</h2>`
  - 原因: 创建新 API Key 区域的标题需显示中文

- [x] 替换标签输入框占位符
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L131
  - 原文: `placeholder="Label (optional)"`
  - 替换为: `placeholder="标签（可选）"`
  - 原因: 标签输入框的占位提示需显示中文

- [x] 替换创建按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L138
  - 原文: 在 `<button>` 内的 `Create`
  - 替换为: `创建`
  - 原因: 创建 API Key 的按钮文本需显示中文

- [x] 替换空状态提示文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L147
  - 原文: `No API keys yet. Create one above to connect your agents.`
  - 替换为: `暂无 API Key。请在上方创建一个以连接你的 Agent。`
  - 原因: 无 API Key 时的空状态提示需显示中文，Agent 为专有名词保留英文

- [x] 替换保存按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L172
  - 原文: 在编辑模式下 `<button>` 内的 `Save`
  - 替换为: `保存`
  - 原因: 编辑标签时的保存按钮文本需显示中文

- [x] 替换取消按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L178
  - 原文: 在编辑模式下 `<button>` 内的 `Cancel`
  - 替换为: `取消`
  - 原因: 编辑标签时的取消按钮文本需显示中文

- [x] 替换无标签默认显示文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L185
  - 原文: `{key.label || "Unnamed"}`
  - 替换为: `{key.label || "未命名"}`
  - 原因: 未设置标签时的默认显示文本需显示中文

- [x] 替换编辑按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L198
  - 原文: 在 `<button>` 内的 `Edit`
  - 替换为: `编辑`
  - 原因: 编辑按钮文本需显示中文

- [x] 替换删除按钮文本
  - 位置: `web/src/pages/ApiKeyManager.tsx` ~L203
  - 原文: 在 `<button>` 内的 `Delete`
  - 替换为: `删除`
  - 原因: 删除按钮文本需显示中文

- [x] 为 ApiKeyManager.tsx 文本汉化编写单元测试
  - 测试文件: `web/src/__tests__/apikey-manager-i18n.test.ts`
  - 测试场景:
    - 源文件中不再包含英文错误消息 "Failed to load API keys": 读取源文件，验证字符串 `"Failed to load API keys"` 不存在
    - 源文件中不再包含英文错误消息 "Failed to create key": 读取源文件，验证字符串 `"Failed to create key"` 不存在
    - 源文件中不再包含英文错误消息 "Failed to delete key": 读取源文件，验证字符串 `"Failed to delete key"` 不存在
    - 源文件中不再包含英文错误消息 "Failed to update label": 读取源文件，验证字符串 `"Failed to update label"` 不存在
    - 源文件中不再包含英文 "Loading...": 读取源文件，验证字符串 `Loading...` 不存在
    - 源文件中不再包含英文按钮 "Back": 读取源文件，验证 `Back` 在 JSX 文本内容中不存在（排除 `onBack` 属性名）
    - 源文件中不再包含英文标题 "API Keys": 读取源文件，验证 `>API Keys<` 不存在
    - 源文件中不再包含英文提示 "API Key Created": 读取源文件，验证 `>API Key Created<` 不存在
    - 源文件中不再包含英文描述 "Copy this key now": 读取源文件，验证该字符串不存在
    - 源文件中不再包含英文按钮 "Copy": 读取源文件，验证 `>Copy<` 不存在
    - 源文件中不再包含英文按钮 "Dismiss": 读取源文件，验证 `>Dismiss<` 不存在
    - 源文件中不再包含英文标题 "Create New Key": 读取源文件，验证 `>Create New Key<` 不存在
    - 源文件中不再包含英文占位符 "Label (optional)": 读取源文件，验证 `placeholder="Label (optional)"` 不存在
    - 源文件中不再包含英文空状态 "No API keys yet": 读取源文件，验证该字符串不存在
    - 源文件中不再包含英文 "Unnamed": 读取源文件，验证 `"Unnamed"` 不存在
    - 源文件中不再包含英文按钮 "Save": 读取源文件，验证 `>Save<` 不存在
    - 源文件中不再包含英文按钮 "Cancel": 读取源文件，验证 `>Cancel<` 不存在
    - 源文件中不再包含英文按钮 "Edit": 读取源文件，验证 `>Edit<` 不存在
    - 源文件中不再包含英文按钮 "Delete": 读取源文件，验证 `>Delete<` 不存在
    - 源文件中包含中文 "加载 API Key 失败": 读取源文件，验证 `"加载 API Key 失败"` 存在
    - 源文件中包含中文 "创建 Key 失败": 读取源文件，验证 `"创建 Key 失败"` 存在
    - 源文件中包含中文 "删除 Key 失败": 读取源文件，验证 `"删除 Key 失败"` 存在
    - 源文件中包含中文 "更新标签失败": 读取源文件，验证 `"更新标签失败"` 存在
    - 源文件中包含中文 "加载中...": 读取源文件，验证 `加载中...` 存在
    - 源文件中包含中文 "返回": 读取源文件，验证 `返回` 存在
    - 源文件中包含中文标题 "API Key"（h1）: 读取源文件，验证 `>API Key<` 存在
    - 源文件中包含中文 "已创建": 读取源文件，验证 `已创建` 存在
    - 源文件中包含中文 "请立即复制此 Key": 读取源文件，验证该字符串存在
    - 源文件中包含中文按钮 "复制": 读取源文件，验证 `>复制<` 存在
    - 源文件中包含中文按钮 "关闭": 读取源文件，验证 `>关闭<` 存在
    - 源文件中包含中文 "创建新 Key": 读取源文件，验证 `>创建新 Key<` 存在
    - 源文件中包含中文占位符 "标签（可选）": 读取源文件，验证 `标签（可选）` 存在
    - 源文件中包含中文 "暂无 API Key": 读取源文件，验证该字符串存在
    - 源文件中包含中文 "未命名": 读取源文件，验证 `"未命名"` 存在
    - 源文件中包含中文按钮 "保存": 读取源文件，验证 `>保存<` 存在
    - 源文件中包含中文按钮 "取消": 读取源文件，验证 `>取消<` 存在
    - 源文件中包含中文按钮 "编辑": 读取源文件，验证 `>编辑<` 存在
    - 源文件中包含中文按钮 "删除": 读取源文件，验证 `>删除<` 存在
    - 源文件中包含中文 "创建"（创建按钮）: 读取源文件，验证 `>创建<` 存在
  - 运行命令: `cd web && bun test src/__tests__/apikey-manager-i18n.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证源文件中不再包含英文错误消息
  - `grep -n '"Failed to load API keys"\|"Failed to create key"\|"Failed to delete key"\|"Failed to update label"' web/src/pages/ApiKeyManager.tsx`
  - 预期: 无匹配输出（grep 返回退出码 1）

- [x] 验证源文件中不再包含英文 "Loading..."
  - `grep -n 'Loading\.\.\.' web/src/pages/ApiKeyManager.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含英文按钮和标题文本
  - `grep -n '>Back<\|>API Keys<\|>API Key Created<\|>Copy<\|>Dismiss<\|>Create New Key<\|>Save<\|>Cancel<\|>Edit<\|>Delete<\|>Create<' web/src/pages/ApiKeyManager.tsx`
  - 预期: 无匹配输出

- [x] 验证源文件中不再包含英文占位符和提示文本
  - `grep -n 'Label (optional)\|Copy this key now\|No API keys yet\|"Unnamed"' web/src/pages/ApiKeyManager.tsx`
  - 预期: 无匹配输出

- [x] 验证中文文本已正确写入
  - `grep -n '加载 API Key 失败\|创建 Key 失败\|删除 Key 失败\|更新标签失败\|加载中\|返回\|已创建\|复制\|关闭\|创建新 Key\|标签（可选）\|暂无 API Key\|未命名\|保存\|取消\|编辑\|删除\|创建' web/src/pages/ApiKeyManager.tsx`
  - 预期: 输出包含所有中文文本

- [x] 验证前端构建无错误
  - `cd web && bun run build 2>&1 | tail -5`
  - 预期: 构建成功，无错误

- [x] 运行本 Task 单元测试
  - `cd web && bun test src/__tests__/apikey-manager-i18n.test.ts`
  - 预期: 所有测试通过

---

### Task 5: 共享组件界面文本汉化（Sidebar + EnvironmentList + SessionList）

**背景:**
Sidebar.tsx、EnvironmentList.tsx 和 SessionList.tsx 是三个共享 UI 组件，分别提供侧栏导航收起/展开按钮、环境列表空状态提示和会话列表空状态提示。当前这些组件中的按钮文本和空状态提示为英文，需替换为中文以保持界面语言一致。本 Task 无其他 Task 依赖。

**涉及文件:**

- 修改: `web/src/components/shell/Sidebar.tsx`
- 修改: `web/src/components/EnvironmentList.tsx`
- 修改: `web/src/components/SessionList.tsx`
- 新建: `web/src/__tests__/shared-components-i18n.test.ts`

**执行步骤:**

- [x] 替换收起按钮 title 属性中的英文文本
  - 位置: `web/src/components/shell/Sidebar.tsx` ~L92
  - 原文: `title={collapsed ? "Expand sidebar" : "Collapse sidebar"}`
  - 替换为: `title={collapsed ? "展开侧栏" : "收起侧栏"}`
  - 原因: 收起/展开按钮的鼠标悬停提示需显示中文

- [x] 替换收起按钮显示文本 "Collapse" 为 "收起"
  - 位置: `web/src/components/shell/Sidebar.tsx` ~L99
  - 原文: `<span className="text-xs">Collapse</span>`
  - 替换为: `<span className="text-xs">收起</span>`
  - 原因: 侧栏收起按钮的可见文本需显示中文

- [x] 替换环境列表空状态提示 "No active environments" 为 "暂无活跃环境"
  - 位置: `web/src/components/EnvironmentList.tsx` ~L14
  - 原文: `No active environments`
  - 替换为: `暂无活跃环境`
  - 原因: 环境列表为空时的提示文本需显示中文

- [x] 保留 ACP Agent / Claude Code 类型标签不翻译
  - 位置: `web/src/components/EnvironmentList.tsx` ~L23
  - 原文: `const typeLabel = isAcp ? "ACP Agent" : "Claude Code";`
  - 不做修改
  - 原因: "ACP Agent" 和 "Claude Code" 为专有名词/产品名，按设计文档规则保留英文

- [x] 替换会话列表空状态提示 "No sessions yet" 为 "暂无会话"
  - 位置: `web/src/components/SessionList.tsx` ~L14
  - 原文: `No sessions yet`
  - 替换为: `暂无会话`
  - 原因: 会话列表为空时的提示文本需显示中文

- [x] 为三个共享组件文本汉化编写单元测试
  - 测试文件: `web/src/__tests__/shared-components-i18n.test.ts`
  - 测试场景:
    - Sidebar.tsx 中不再包含英文 title "Expand sidebar": 读取源文件，验证 `"Expand sidebar"` 不存在
    - Sidebar.tsx 中不再包含英文 title "Collapse sidebar": 读取源文件，验证 `"Collapse sidebar"` 不存在
    - Sidebar.tsx 中不再包含英文按钮文本 "Collapse": 读取源文件，验证 `>Collapse<` 不存在
    - Sidebar.tsx 中包含中文 title "展开侧栏": 读取源文件，验证 `"展开侧栏"` 存在
    - Sidebar.tsx 中包含中文 title "收起侧栏": 读取源文件，验证 `"收起侧栏"` 存在
    - Sidebar.tsx 中包含中文按钮文本 "收起": 读取源文件，验证 `>收起<` 存在
    - EnvironmentList.tsx 中不再包含英文空状态 "No active environments": 读取源文件，验证 `No active environments` 不存在
    - EnvironmentList.tsx 中包含中文空状态 "暂无活跃环境": 读取源文件，验证 `暂无活跃环境` 存在
    - EnvironmentList.tsx 中保留专有名词 "ACP Agent": 读取源文件，验证 `"ACP Agent"` 存在
    - EnvironmentList.tsx 中保留专有名词 "Claude Code": 读取源文件，验证 `"Claude Code"` 存在
    - SessionList.tsx 中不再包含英文空状态 "No sessions yet": 读取源文件，验证 `No sessions yet` 不存在
    - SessionList.tsx 中包含中文空状态 "暂无会话": 读取源文件，验证 `暂无会话` 存在
  - 运行命令: `cd web && bun test src/__tests__/shared-components-i18n.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 Sidebar.tsx 中不再包含英文 title 文本
  - `grep -n '"Expand sidebar"\|"Collapse sidebar"' web/src/components/shell/Sidebar.tsx`
  - 预期: 无匹配输出（grep 返回退出码 1）

- [x] 验证 Sidebar.tsx 中不再包含英文按钮文本 "Collapse"
  - `grep -n '>Collapse<' web/src/components/shell/Sidebar.tsx`
  - 预期: 无匹配输出

- [x] 验证 Sidebar.tsx 中文文本已正确写入
  - `grep -n '展开侧栏\|收起侧栏\|>收起<' web/src/components/shell/Sidebar.tsx`
  - 预期: 输出包含 "展开侧栏"（1处）、"收起侧栏"（1处）、"收起"（按钮文本 1处）

- [x] 验证 EnvironmentList.tsx 中不再包含英文空状态
  - `grep -n 'No active environments' web/src/components/EnvironmentList.tsx`
  - 预期: 无匹配输出

- [x] 验证 EnvironmentList.tsx 中文文本已写入且专有名词保留
  - `grep -n '暂无活跃环境\|"ACP Agent"\|"Claude Code"' web/src/components/EnvironmentList.tsx`
  - 预期: 输出包含 "暂无活跃环境"（1处）、"ACP Agent"（1处）、"Claude Code"（1处）

- [x] 验证 SessionList.tsx 中不再包含英文空状态
  - `grep -n 'No sessions yet' web/src/components/SessionList.tsx`
  - 预期: 无匹配输出

- [x] 验证 SessionList.tsx 中文文本已正确写入
  - `grep -n '暂无会话' web/src/components/SessionList.tsx`
  - 预期: 输出 1 行，包含 "暂无会话"

- [x] 验证前端构建无错误
  - `cd web && bun run build 2>&1 | tail -5`
  - 预期: 构建成功，无错误

- [x] 运行本 Task 单元测试
  - `cd web && bun test src/__tests__/shared-components-i18n.test.ts`
  - 预期: 所有测试通过

---

### Task 6: 界面文本中文化验收

**前置条件:**

- Task 1 ~ Task 5 全部执行完成
- 前端构建环境就绪: `bun run build:web`

**端到端验证:**

1. [x] 运行完整测试套件确保无回归
   - `cd web && bun test 2>&1 | tail -20`
   - 预期: 所有测试通过（包括 Task 1~5 新增的 i18n 测试文件）
   - 失败排查: 检查各 Task 的单元测试步骤，定位失败的测试文件

2. [x] 验证前端构建无错误
   - `bun run build:web 2>&1 | tail -10`
   - 预期: 构建成功，无 TypeScript 编译错误或 Vite 构建错误
   - 失败排查: 检查 Task 1~5 的构建检查步骤

3. [x] 全局英文残留检查 — 确认所有目标文件中不再包含需翻译的英文界面文本
   - `grep -n '"Dashboard"\|"Session"\|"Loading\.\.\."' web/src/App.tsx`
   - 预期: 无匹配输出
   - 失败排查: 检查 Task 1

   - `grep -n '>Agents<\|>Sessions<\|>Active<' web/src/pages/Dashboard.tsx`
   - 预期: 无匹配输出
   - 失败排查: 检查 Task 2

   - `grep -n '"Create Account"\|"Sign In"\|"Registration failed"\|"Login failed"\|"Unknown error"\|"Please wait\.\.\."\|"Already have\|"Don'"'"'t have' web/src/pages/LoginPage.tsx`
   - 预期: 无匹配输出
   - 失败排查: 检查 Task 3

   - `grep -n '"Failed to\|Loading\.\.\.\|>Back<\|>API Keys<\|>API Key Created<\|>Copy<\|>Dismiss<\|>Create New Key<\|Label (optional)\|No API keys yet\|"Unnamed"\|>Save<\|>Cancel<\|>Edit<\|>Delete<\|>Create<' web/src/pages/ApiKeyManager.tsx`
   - 预期: 无匹配输出
   - 失败排查: 检查 Task 4

   - `grep -n '"Expand sidebar"\|"Collapse sidebar"\|>Collapse<\|No active environments\|No sessions yet' web/src/components/shell/Sidebar.tsx web/src/components/EnvironmentList.tsx web/src/components/SessionList.tsx`
   - 预期: 无匹配输出
   - 失败排查: 检查 Task 5

4. [x] 全局中文文本存在性检查 — 确认所有中文字符串已正确写入
   - `grep -c '仪表盘\|加载中' web/src/App.tsx`
   - 预期: 输出计数 ≥ 4（仪表盘至少 2 处 + 加载中 2 处）
   - 失败排查: 检查 Task 1

   - `grep -c '会话\|活跃\|>Agent<' web/src/pages/Dashboard.tsx`
   - 预期: 输出计数 ≥ 5（会话 2 + 活跃 1 + Agent 2）
   - 失败排查: 检查 Task 2

   - `grep -c '创建账户\|登录\|注册失败\|登录失败\|未知错误\|名称\|邮箱\|密码' web/src/pages/LoginPage.tsx`
   - 预期: 输出计数 ≥ 12
   - 失败排查: 检查 Task 3

   - `grep -c '加载中\|返回\|已创建\|复制\|关闭\|创建新 Key\|标签（可选）\|暂无 API Key\|未命名\|保存\|取消\|编辑\|删除\|创建' web/src/pages/ApiKeyManager.tsx`
   - 预期: 输出计数 ≥ 20
   - 失败排查: 检查 Task 4

   - `grep -c '收起\|展开侧栏\|暂无活跃环境\|暂无会话' web/src/components/shell/Sidebar.tsx web/src/components/EnvironmentList.tsx web/src/components/SessionList.tsx`
   - 预期: 三个文件合计计数 ≥ 5
   - 失败排查: 检查 Task 5

5. [x] 专有名词保留检查 — 确认 ACP Agent / Claude Code / API Key 等专有名词未被翻译
   - `grep -c '"ACP Agent"\|"Claude Code"' web/src/components/EnvironmentList.tsx`
   - 预期: 输出计数 = 2（各出现 1 次）
   - 失败排查: 检查 Task 5

   - `grep -c 'Dashboard' web/src/pages/Dashboard.tsx`
   - 预期: sr-only 标题中保留 1 处 "Dashboard"
   - 失败排查: 检查 Task 2

6. [x] 已汉化页面不受影响 — 确认模型/Agent/技能/权限页面无变化
   - `grep -c '模型\|Agent\|技能' web/src/pages/ModelsPage.tsx web/src/pages/AgentsPage.tsx web/src/pages/SkillsPage.tsx`
   - 预期: 各文件中中文文本计数不变（与改动前一致）
   - 失败排查: 检查是否有 Task 意外修改了这些文件
