# 界面文本中文化（i18n-chinese）人工验收清单

**生成时间:** 2026-04-25
**关联计划:** spec/feature_20260425_F001_ui-i18n-chinese/spec-plan.md
**关联设计:** spec/feature_20260425_F001_ui-i18n-chinese/spec-design.md

---

## 验收前准备

### 环境要求

- [ ] [AUTO] 检查 bun 运行时版本: `bun --version`
- [ ] [AUTO] 编译前端项目: `bun run build:web 2>&1 | tail -5`

### 测试数据准备

- 无需额外测试数据，本功能为纯文本替换

---

## 验收项目

### 场景 1：构建环境验证

#### - [x] 1.1 前端构建工具可用

- **来源:** spec-plan.md Task 0
- **目的:** 确认构建链路正常
- **操作步骤:**
  1. [A] `bun run build:web 2>&1 | tail -3` → 期望包含: `built in`

#### - [x] 1.2 测试框架可用

- **来源:** spec-plan.md Task 0
- **目的:** 确认测试框架可执行
- **操作步骤:**
  1. [A] `cd web && bun test 2>&1 | tail -3` → 期望包含: `tests`

---

### 场景 2：App.tsx 导航与页面标题汉化

#### - [x] 2.1 英文文本残留检查

- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认英文标签已全部移除
- **操作步骤:**
  1. [A] `grep -n '"Dashboard"' web/src/App.tsx` → 期望精确: （无输出，退出码 1）
  2. [A] `grep -n 'label: "Session"' web/src/App.tsx; grep -n 'return "Session"' web/src/App.tsx` → 期望精确: （无输出）
  3. [A] `grep -n '"Loading\.\.\."' web/src/App.tsx` → 期望精确: （无输出）

#### - [x] 2.2 中文文本写入验证

- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认中文文本已正确写入
- **操作步骤:**
  1. [A] `grep -n '仪表盘\|会话\|加载中' web/src/App.tsx` → 期望包含: `仪表盘` `会话` `加载中`

#### - [x] 2.3 前端构建无错误

- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认 App.tsx 改动不影响构建
- **操作步骤:**
  1. [A] `cd web && bun run build 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 2.4 单元测试通过

- **来源:** spec-plan.md Task 1 检查步骤
- **目的:** 确认 App.tsx i18n 测试全部通过
- **操作步骤:**
  1. [A] `cd web && bun test src/__tests__/app-i18n.test.ts` → 期望包含: `all tests passed`

---

### 场景 3：Dashboard.tsx 统计卡片与区域标题汉化

#### - [x] 3.1 英文文本残留检查

- **来源:** spec-plan.md Task 2 检查步骤
- **目的:** 确认英文统计标题已全部移除
- **操作步骤:**
  1. [A] `grep -n '>Agents<' web/src/pages/Dashboard.tsx` → 期望精确: （无输出）
  2. [A] `grep -n '>Sessions<' web/src/pages/Dashboard.tsx` → 期望精确: （无输出）
  3. [A] `grep -n '>Active<' web/src/pages/Dashboard.tsx` → 期望精确: （无输出）

#### - [x] 3.2 中文文本写入验证

- **来源:** spec-plan.md Task 2 检查步骤
- **目的:** 确认中文统计标题已正确写入
- **操作步骤:**
  1. [A] `grep -n '>会话<\|>活跃<\|>Agent<' web/src/pages/Dashboard.tsx` → 期望包含: `会话` `活跃` `Agent`

#### - [x] 3.3 sr-only 标题保留英文

- **来源:** spec-plan.md Task 2 检查步骤 / spec-design.md 专有名词保留规则
- **目的:** 确认 Dashboard 专有名词在 sr-only 中保留
- **操作步骤:**
  1. [A] `grep -n 'sr-only.*Dashboard' web/src/pages/Dashboard.tsx` → 期望包含: `sr-only">Dashboard`

#### - [x] 3.4 前端构建无错误

- **来源:** spec-plan.md Task 2 检查步骤
- **目的:** 确认 Dashboard.tsx 改动不影响构建
- **操作步骤:**
  1. [A] `cd web && bun run build 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 3.5 单元测试通过

- **来源:** spec-plan.md Task 2 检查步骤
- **目的:** 确认 Dashboard.tsx i18n 测试全部通过
- **操作步骤:**
  1. [A] `cd web && bun test src/__tests__/dashboard-i18n.test.ts` → 期望包含: `all tests passed`

---

### 场景 4：LoginPage.tsx 登录/注册表单汉化

#### - [x] 4.1 英文页面标题残留检查

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认英文标题已移除
- **操作步骤:**
  1. [A] `grep -n '"Create Account"' web/src/pages/LoginPage.tsx` → 期望精确: （无输出）
  2. [A] `grep -n '"Sign In"' web/src/pages/LoginPage.tsx` → 期望精确: （无输出）

#### - [x] 4.2 英文错误消息残留检查

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认英文错误消息已替换
- **操作步骤:**
  1. [A] `grep -n '"Registration failed"\|"Login failed"\|"Unknown error"' web/src/pages/LoginPage.tsx` → 期望精确: （无输出）

#### - [x] 4.3 英文表单标签残留检查

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认英文表单标签已替换
- **操作步骤:**
  1. [A] `grep -n '>Name<\|>Email<\|>Password<' web/src/pages/LoginPage.tsx` → 期望精确: （无输出）

#### - [x] 4.4 英文占位符和提示文本残留检查

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认英文占位符和提示文本已替换
- **操作步骤:**
  1. [A] `grep -n '"Your name"\|"Please wait..."\|"Already have an account"\|"Don'"'"'t have an account"' web/src/pages/LoginPage.tsx` → 期望精确: （无输出）

#### - [x] 4.5 中文文本写入验证

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认中文文本已正确写入
- **操作步骤:**
  1. [A] `grep -n '创建账户\|登录\|注册失败\|登录失败\|未知错误\|名称\|邮箱\|密码\|请稍候\|已有账户\|没有账户' web/src/pages/LoginPage.tsx` → 期望包含: `创建账户` `登录` `注册失败` `登录失败` `未知错误` `名称` `邮箱` `密码`

#### - [x] 4.6 前端构建无错误

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认 LoginPage.tsx 改动不影响构建
- **操作步骤:**
  1. [A] `cd web && bun run build 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 4.7 单元测试通过

- **来源:** spec-plan.md Task 3 检查步骤
- **目的:** 确认 LoginPage.tsx i18n 测试全部通过
- **操作步骤:**
  1. [A] `cd web && bun test src/__tests__/login-i18n.test.ts` → 期望包含: `all tests passed`

---

### 场景 5：ApiKeyManager.tsx 管理页面汉化

#### - [x] 5.1 英文错误消息残留检查

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认英文错误消息已替换
- **操作步骤:**
  1. [A] `grep -n '"Failed to load API keys"\|"Failed to create key"\|"Failed to delete key"\|"Failed to update label"' web/src/pages/ApiKeyManager.tsx` → 期望精确: （无输出）

#### - [x] 5.2 英文加载状态残留检查

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认英文加载文本已替换
- **操作步骤:**
  1. [A] `grep -n 'Loading\.\.\.' web/src/pages/ApiKeyManager.tsx` → 期望精确: （无输出）

#### - [x] 5.3 英文按钮和标题残留检查

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认英文按钮和标题已替换
- **操作步骤:**
  1. [A] `grep -n '>Back<\|>API Keys<\|>API Key Created<\|>Copy<\|>Dismiss<\|>Create New Key<\|>Save<\|>Cancel<\|>Edit<\|>Delete<\|>Create<' web/src/pages/ApiKeyManager.tsx` → 期望精确: （无输出）

#### - [x] 5.4 英文占位符和提示文本残留检查

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认英文占位符和提示文本已替换
- **操作步骤:**
  1. [A] `grep -n 'Label (optional)\|Copy this key now\|No API keys yet\|"Unnamed"' web/src/pages/ApiKeyManager.tsx` → 期望精确: （无输出）

#### - [x] 5.5 中文文本写入验证

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认中文文本已正确写入
- **操作步骤:**
  1. [A] `grep -n '加载 API Key 失败\|创建 Key 失败\|删除 Key 失败\|更新标签失败\|加载中\|返回\|已创建\|复制\|关闭\|创建新 Key\|标签（可选）\|暂无 API Key\|未命名\|保存\|取消\|编辑\|删除\|创建' web/src/pages/ApiKeyManager.tsx` → 期望包含: `加载 API Key 失败` `创建 Key 失败` `返回` `复制` `关闭`

#### - [x] 5.6 前端构建无错误

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认 ApiKeyManager.tsx 改动不影响构建
- **操作步骤:**
  1. [A] `cd web && bun run build 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 5.7 单元测试通过

- **来源:** spec-plan.md Task 4 检查步骤
- **目的:** 确认 ApiKeyManager.tsx i18n 测试全部通过
- **操作步骤:**
  1. [A] `cd web && bun test src/__tests__/apikey-manager-i18n.test.ts` → 期望包含: `all tests passed`

---

### 场景 6：共享组件汉化（Sidebar / EnvironmentList / SessionList）

#### - [x] 6.1 Sidebar 英文文本残留检查

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认 Sidebar 英文文本已替换
- **操作步骤:**
  1. [A] `grep -n '"Expand sidebar"\|"Collapse sidebar"' web/src/components/shell/Sidebar.tsx` → 期望精确: （无输出）
  2. [A] `grep -n '>Collapse<' web/src/components/shell/Sidebar.tsx` → 期望精确: （无输出）

#### - [x] 6.2 Sidebar 中文文本写入验证

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认 Sidebar 中文文本已写入
- **操作步骤:**
  1. [A] `grep -n '展开侧栏\|收起侧栏\|>收起<' web/src/components/shell/Sidebar.tsx` → 期望包含: `展开侧栏` `收起侧栏` `收起`

#### - [x] 6.3 EnvironmentList 英文空状态残留检查

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认英文空状态提示已替换
- **操作步骤:**
  1. [A] `grep -n 'No active environments' web/src/components/EnvironmentList.tsx` → 期望精确: （无输出）

#### - [x] 6.4 EnvironmentList 中文文本与专有名词验证

- **来源:** spec-plan.md Task 5 检查步骤 / spec-design.md 专有名词保留规则
- **目的:** 确认中文文本已写入且专有名词保留
- **操作步骤:**
  1. [A] `grep -n '暂无活跃环境\|"ACP Agent"\|"Claude Code"' web/src/components/EnvironmentList.tsx` → 期望包含: `暂无活跃环境` `ACP Agent` `Claude Code`

#### - [x] 6.5 SessionList 英文空状态残留检查

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认英文空状态提示已替换
- **操作步骤:**
  1. [A] `grep -n 'No sessions yet' web/src/components/SessionList.tsx` → 期望精确: （无输出）

#### - [x] 6.6 SessionList 中文文本写入验证

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认中文空状态提示已写入
- **操作步骤:**
  1. [A] `grep -n '暂无会话' web/src/components/SessionList.tsx` → 期望包含: `暂无会话`

#### - [x] 6.7 前端构建无错误

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认共享组件改动不影响构建
- **操作步骤:**
  1. [A] `cd web && bun run build 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 6.8 共享组件单元测试通过

- **来源:** spec-plan.md Task 5 检查步骤
- **目的:** 确认共享组件 i18n 测试全部通过
- **操作步骤:**
  1. [A] `cd web && bun test src/__tests__/shared-components-i18n.test.ts` → 期望包含: `all tests passed`

---

### 场景 7：全局端到端验证

#### - [x] 7.1 完整测试套件通过

- **来源:** spec-plan.md Task 6 步骤 1
- **目的:** 确认所有测试无回归
- **操作步骤:**
  1. [A] `cd web && bun test 2>&1 | tail -20` → 期望包含: `all tests passed`

#### - [x] 7.2 前端构建无错误

- **来源:** spec-plan.md Task 6 步骤 2
- **目的:** 确认全局构建成功
- **操作步骤:**
  1. [A] `bun run build:web 2>&1 | tail -10` → 期望包含: `built in`

#### - [x] 7.3 全局英文残留检查

- **来源:** spec-plan.md Task 6 步骤 3
- **目的:** 确认所有目标文件无英文界面文本残留
- **操作步骤:**
  1. [A] `grep -n '"Dashboard"\|"Session"\|"Loading\.\.\."' web/src/App.tsx` → 期望精确: （无输出）
  2. [A] `grep -n '>Agents<\|>Sessions<\|>Active<' web/src/pages/Dashboard.tsx` → 期望精确: （无输出）
  3. [A] `grep -n '"Create Account"\|"Sign In"\|"Registration failed"\|"Login failed"\|"Unknown error"\|"Please wait\.\.\."\|"Already have\|"Don'"'"'t have' web/src/pages/LoginPage.tsx` → 期望精确: （无输出）
  4. [A] `grep -n '"Failed to\|Loading\.\.\.\|>Back<\|>API Keys<\|>API Key Created<\|>Copy<\|>Dismiss<\|>Create New Key<\|Label (optional)\|No API keys yet\|"Unnamed"\|>Save<\|>Cancel<\|>Edit<\|>Delete<\|>Create<' web/src/pages/ApiKeyManager.tsx` → 期望精确: （无输出）
  5. [A] `grep -n '"Expand sidebar"\|"Collapse sidebar"\|>Collapse<\|No active environments\|No sessions yet' web/src/components/shell/Sidebar.tsx web/src/components/EnvironmentList.tsx web/src/components/SessionList.tsx` → 期望精确: （无输出）

#### - [x] 7.4 全局中文文本存在性检查

- **来源:** spec-plan.md Task 6 步骤 4
- **目的:** 确认所有中文字符串已正确写入
- **操作步骤:**
  1. [A] `grep -c '仪表盘\|加载中' web/src/App.tsx` → 期望包含: `4`（≥4）
  2. [A] `grep -c '会话\|活跃\|>Agent<' web/src/pages/Dashboard.tsx` → 期望包含: `5`（≥5）
  3. [A] `grep -c '创建账户\|登录\|注册失败\|登录失败\|未知错误\|名称\|邮箱\|密码' web/src/pages/LoginPage.tsx` → 期望包含: `12`（≥12）
  4. [A] `grep -c '加载中\|返回\|已创建\|复制\|关闭\|创建新 Key\|标签（可选）\|暂无 API Key\|未命名\|保存\|取消\|编辑\|删除\|创建' web/src/pages/ApiKeyManager.tsx` → 期望包含: `20`（≥20）
  5. [A] `grep -c '收起\|展开侧栏\|暂无活跃环境\|暂无会话' web/src/components/shell/Sidebar.tsx web/src/components/EnvironmentList.tsx web/src/components/SessionList.tsx` → 期望包含: `5`（≥5）

#### - [x] 7.5 专有名词保留检查

- **来源:** spec-plan.md Task 6 步骤 5 / spec-design.md 专有名词保留规则
- **目的:** 确认专有名词未被翻译
- **操作步骤:**
  1. [A] `grep -c '"ACP Agent"\|"Claude Code"' web/src/components/EnvironmentList.tsx` → 期望包含: `2`
  2. [A] `grep -c 'Dashboard' web/src/pages/Dashboard.tsx` → 期望包含: `1`（sr-only 中保留 1 处）

#### - [x] 7.6 已汉化页面不受影响

- **来源:** spec-plan.md Task 6 步骤 6 / spec-design.md 不需修改的文件
- **目的:** 确认模型/Agent/技能页面无变化
- **操作步骤:**
  1. [A] `grep -c '模型\|Agent\|技能' web/src/pages/ModelsPage.tsx web/src/pages/AgentsPage.tsx web/src/pages/SkillsPage.tsx` → 期望包含: `模型` `Agent` `技能`

#### - [x] 7.7 无新增依赖验证

- **来源:** spec-design.md 实现要点 / spec-plan.md 改动总览
- **目的:** 确认未引入新依赖
- **操作步骤:**
  1. [A] `git diff HEAD -- web/package.json` → 期望精确: （无输出）

---

## 验收后清理

- 无需清理（本功能不涉及启动服务或创建临时资源）

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 前端构建工具可用 | 1 | 0 | ⬜ |
| 场景 1 | 1.2 | 测试框架可用 | 1 | 0 | ⬜ |
| 场景 2 | 2.1 | App.tsx 英文文本残留检查 | 3 | 0 | ⬜ |
| 场景 2 | 2.2 | App.tsx 中文文本写入验证 | 1 | 0 | ⬜ |
| 场景 2 | 2.3 | App.tsx 前端构建无错误 | 1 | 0 | ⬜ |
| 场景 2 | 2.4 | App.tsx 单元测试通过 | 1 | 0 | ⬜ |
| 场景 3 | 3.1 | Dashboard 英文文本残留检查 | 3 | 0 | ⬜ |
| 场景 3 | 3.2 | Dashboard 中文文本写入验证 | 1 | 0 | ⬜ |
| 场景 3 | 3.3 | Dashboard sr-only 保留英文 | 1 | 0 | ⬜ |
| 场景 3 | 3.4 | Dashboard 前端构建无错误 | 1 | 0 | ⬜ |
| 场景 3 | 3.5 | Dashboard 单元测试通过 | 1 | 0 | ⬜ |
| 场景 4 | 4.1 | LoginPage 英文标题残留检查 | 2 | 0 | ⬜ |
| 场景 4 | 4.2 | LoginPage 英文错误消息残留检查 | 1 | 0 | ⬜ |
| 场景 4 | 4.3 | LoginPage 英文表单标签残留检查 | 1 | 0 | ⬜ |
| 场景 4 | 4.4 | LoginPage 英文占位符提示残留检查 | 1 | 0 | ⬜ |
| 场景 4 | 4.5 | LoginPage 中文文本写入验证 | 1 | 0 | ⬜ |
| 场景 4 | 4.6 | LoginPage 前端构建无错误 | 1 | 0 | ⬜ |
| 场景 4 | 4.7 | LoginPage 单元测试通过 | 1 | 0 | ⬜ |
| 场景 5 | 5.1 | ApiKeyManager 英文错误消息残留检查 | 1 | 0 | ⬜ |
| 场景 5 | 5.2 | ApiKeyManager 英文加载状态残留检查 | 1 | 0 | ⬜ |
| 场景 5 | 5.3 | ApiKeyManager 英文按钮标题残留检查 | 1 | 0 | ⬜ |
| 场景 5 | 5.4 | ApiKeyManager 英文占位符提示残留检查 | 1 | 0 | ⬜ |
| 场景 5 | 5.5 | ApiKeyManager 中文文本写入验证 | 1 | 0 | ⬜ |
| 场景 5 | 5.6 | ApiKeyManager 前端构建无错误 | 1 | 0 | ⬜ |
| 场景 5 | 5.7 | ApiKeyManager 单元测试通过 | 1 | 0 | ⬜ |
| 场景 6 | 6.1 | Sidebar 英文文本残留检查 | 2 | 0 | ⬜ |
| 场景 6 | 6.2 | Sidebar 中文文本写入验证 | 1 | 0 | ⬜ |
| 场景 6 | 6.3 | EnvironmentList 英文空状态残留检查 | 1 | 0 | ⬜ |
| 场景 6 | 6.4 | EnvironmentList 中文与专有名词验证 | 1 | 0 | ⬜ |
| 场景 6 | 6.5 | SessionList 英文空状态残留检查 | 1 | 0 | ⬜ |
| 场景 6 | 6.6 | SessionList 中文文本写入验证 | 1 | 0 | ⬜ |
| 场景 6 | 6.7 | 共享组件前端构建无错误 | 1 | 0 | ⬜ |
| 场景 6 | 6.8 | 共享组件单元测试通过 | 1 | 0 | ⬜ |
| 场景 7 | 7.1 | 完整测试套件通过 | 1 | 0 | ⬜ |
| 场景 7 | 7.2 | 前端构建无错误 | 1 | 0 | ⬜ |
| 场景 7 | 7.3 | 全局英文残留检查 | 5 | 0 | ⬜ |
| 场景 7 | 7.4 | 全局中文文本存在性检查 | 5 | 0 | ⬜ |
| 场景 7 | 7.5 | 专有名词保留检查 | 2 | 0 | ⬜ |
| 场景 7 | 7.6 | 已汉化页面不受影响 | 1 | 0 | ⬜ |
| 场景 7 | 7.7 | 无新增依赖验证 | 1 | 0 | ⬜ |

**验收结论:** ⬜ 全部通过 / ⬜ 存在问题
