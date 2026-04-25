# Settings UI 管理页面 人工验收清单

**生成时间:** 2026-04-24
**关联计划:** spec/feature_20260424_F002_settings-ui/spec-plan.md, spec-plan-1.md, spec-plan-2.md
**关联设计:** spec/feature_20260424_F002_settings-ui/spec-design.md

---

## 验收前准备

### 环境要求

- [ ] [AUTO] 检查 bun 版本: `bun --version`
- [ ] [AUTO] 编译前端项目: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5`
- [ ] [AUTO/SERVICE] 启动后端服务: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev` (port: 3000)
- [ ] [AUTO/SERVICE] 启动前端开发服务器: `cd /Users/konghayao/code/pazhou/remote-control-server && bun run dev:web` (port: 5173)

---

## 验收项目

### 场景 1：环境与构建验证

#### - [x] 1.1 前端 Vite 构建成功

- **来源:** spec-plan.md Task 0 / spec-plan-1.md Task 0
- **目的:** 确认构建工具链可用
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx vite build 2>&1 | grep -c "built in"` → 期望包含: `≥ 1`

#### - [x] 1.2 测试框架可用

- **来源:** spec-plan.md Task 0 / spec-plan-1.md Task 0
- **目的:** 确认 bun:test 可正常运行
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server/web && bun test src/__tests__/utils.test.ts 2>&1 | grep -c "pass"` → 期望包含: `≥ 1`

---

### 场景 2：依赖安装与类型定义

#### - [x] 2.1 sonner 和 react-markdown 已安装

- **来源:** spec-plan-1.md Task 1 / spec-plan.md Task 4&7
- **目的:** 确认 Toast 和 Markdown 依赖就绪
- [A] `ls /Users/konghayao/code/pazhou/remote-control-server/node_modules/sonner/package.json /Users/konghayao/code/pazhou/remote-control-server/node_modules/react-markdown/package.json 2>&1` → 期望包含: `package.json`

#### - [x] 2.2 App.tsx 包含 Toaster 全局组件

- **来源:** spec-plan-1.md Task 1
- **目的:** 确认 Toast 容器已挂载
- [A] `grep -n "Toaster" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx` → 期望包含: `import` 和 `Toaster` 使用行

#### - [x] 2.3 配置模块类型定义文件存在

- **来源:** spec-plan-1.md Task 1
- **目的:** 确认类型安全保障基础
- [A] `test -f /Users/konghayao/code/pazhou/remote-control-server/web/src/types/config.ts && echo "OK"` → 期望精确: `OK`

#### - [x] 2.4 配置类型测试通过

- **来源:** spec-plan-1.md Task 1
- **目的:** 确认类型接口编译正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-types.test.ts 2>&1 | tail -5` → 期望包含: `pass`

---

### 场景 3：API Client 配置函数

#### - [x] 3.1 配置 API 函数完整导出

- **来源:** spec-plan.md Task 1 / spec-plan-1.md Task 2
- **目的:** 确认 20+ 配置 API 函数已定义
- [A] `grep -c "export function api" /Users/konghayao/code/pazhou/remote-control-server/web/src/api/client.ts` → 期望包含: `≥ 20`

#### - [x] 3.2 配置 API 客户端测试通过

- **来源:** spec-plan.md Task 1 / spec-plan-1.md Task 2
- **目的:** 确认 API mock 和类型定义正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-api-client.test.ts 2>&1 | tail -5` → 期望包含: `pass`

#### - [x] 3.3 TypeScript 编译无 API 层错误

- **来源:** spec-plan.md Task 1
- **目的:** 确认 API 层类型安全
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server/web && npx tsc --noEmit --skipLibCheck 2>&1 | grep -i "client.ts" || echo "OK"` → 期望精确: `OK`

---

### 场景 4：共享 UI 组件

#### - [x] 4.1 共享组件文件完整（7 个文件）

- **来源:** spec-plan.md Task 3 / spec-plan-1.md Task 3-4
- **目的:** 确认所有共享组件已创建
- [A] `ls /Users/konghayao/code/pazhou/remote-control-server/web/components/config/*.tsx /Users/konghayao/code/pazhou/remote-control-server/web/components/config/*.ts 2>&1 | wc -l` → 期望包含: `7`

#### - [x] 4.2 index.ts 导出所有 6 个组件

- **来源:** spec-plan.md Task 3 / spec-plan-1.md Task 4
- **目的:** 确认统一导出入口完整
- [A] `grep -c "export" /Users/konghayao/code/pazhou/remote-control-server/web/components/config/index.ts` → 期望包含: `≥ 6`

#### - [x] 4.3 DataTable 包含泛型 Column 接口

- **来源:** spec-plan.md Task 3
- **目的:** 确认 DataTable 支持泛型列配置
- [A] `grep "interface Column" /Users/konghayao/code/pazhou/remote-control-server/web/components/config/DataTable.tsx` → 期望包含: `Column<T>`

#### - [x] 4.4 DataTable 导出纯函数（排序/筛选/分页）

- **来源:** spec-plan.md Task 3 / spec-plan-1.md Task 3
- **目的:** 确认纯逻辑可独立测试
- [A] `grep "export function" /Users/konghayao/code/pazhou/remote-control-server/web/components/config/DataTable.tsx | wc -l` → 期望包含: `≥ 4`

#### - [x] 4.5 DataTable 纯函数测试通过

- **来源:** spec-plan.md Task 3 / spec-plan-1.md Task 3
- **目的:** 确认排序/筛选/分页逻辑正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-datatable.test.ts 2>&1 | tail -5` → 期望包含: `pass`

#### - [x] 4.6 辅助组件测试通过

- **来源:** spec-plan-1.md Task 4
- **目的:** 确认 StatusBadge 颜色映射等逻辑正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-helpers.test.ts 2>&1 | tail -5` → 期望包含: `pass`

---

### 场景 5：侧边栏与路由

#### - [x] 5.1 Sidebar 支持分隔线渲染

- **来源:** spec-plan.md Task 2
- **目的:** 确认 Separator 组件已集成
- [A] `grep -c "separator" /Users/konghayao/code/pazhou/remote-control-server/web/src/components/shell/Sidebar.tsx` → 期望包含: `≥ 3`

#### - [x] 5.2 App.tsx 新增 4 个 lucide 图标

- **来源:** spec-plan.md Task 2 / spec-plan-1.md Task 5
- **目的:** 确认配置入口图标就绪
- [A] `grep -E "Cloud|Cpu|Bot|Wrench" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx | wc -l` → 期望包含: `≥ 4`

#### - [x] 5.3 ViewId 类型包含 4 个配置视图

- **来源:** spec-plan.md Task 2 / spec-plan-1.md Task 5
- **目的:** 确认路由类型安全
- [A] `grep "providers.*models.*agents.*skills" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx` → 期望包含: `providers.*models.*agents.*skills`

#### - [x] 5.4 路由解析测试通过

- **来源:** spec-plan.md Task 2 / spec-plan-1.md Task 5
- **目的:** 确认配置路由 URL 正确解析
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-routing.test.ts 2>&1 | tail -5` → 期望包含: `pass`

#### - [x] 5.5 懒加载导入数量正确

- **来源:** spec-plan-1.md Task 5
- **目的:** 确认 4 个新页面使用 lazy 加载
- [A] `grep "lazy" /Users/konghayao/code/pazhou/remote-control-server/web/src/App.tsx | grep -c "Page"` → 期望包含: `≥ 6`

---

### 场景 6：服务商管理页面

#### - [x] 6.1 ProvidersPage 组件正确导出

- **来源:** spec-plan.md Task 4 / spec-plan-2.md Task 6
- **目的:** 确认命名导出与 lazy 加载匹配
- [A] `grep "export function ProvidersPage" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ProvidersPage.tsx` → 期望包含: `export function ProvidersPage`

#### - [x] 6.2 ProvidersPage 引用全部 API 函数

- **来源:** spec-plan.md Task 4
- **目的:** 确认 CRUD API 对接完整
- [A] `grep -c "apiListProviders\|apiSetProvider\|apiTestProvider\|apiDeleteProvider" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ProvidersPage.tsx` → 期望包含: `≥ 4`

#### - [x] 6.3 ProvidersPage 引用全部共享组件

- **来源:** spec-plan.md Task 4
- **目的:** 确认共享组件正确使用
- [A] `grep -c "DataTable\|FormDialog\|ConfirmDialog\|BatchActionBar\|StatusBadge\|EmptyState" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ProvidersPage.tsx` → 期望包含: `≥ 6`

#### - [x] 6.4 Providers 页面校验函数测试通过

- **来源:** spec-plan.md Task 4 / spec-plan-2.md Task 6
- **目的:** 确认表单校验逻辑正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-providers-page.test.ts 2>&1 | tail -5` → 期望包含: `pass`

---

### 场景 7：模型管理页面

#### - [x] 7.1 ModelsPage 组件正确导出

- **来源:** spec-plan.md Task 5 / spec-plan-2.md Task 7
- **目的:** 确认命名导出与 lazy 加载匹配
- [A] `grep "export function ModelsPage" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ModelsPage.tsx` → 期望包含: `export function ModelsPage`

#### - [x] 7.2 ModelsPage 不包含不需要的功能

- **来源:** spec-plan.md Task 5
- **目的:** 确认 Models 页面无 CRUD 弹窗和批量操作
- [A] `grep -c "FormDialog\|BatchActionBar\|ConfirmDialog" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/ModelsPage.tsx` → 期望包含: `0`

#### - [x] 7.3 Models 页面辅助函数测试通过

- **来源:** spec-plan.md Task 5 / spec-plan-2.md Task 7
- **目的:** 确认模型使用状态判断逻辑正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-models-page.test.ts 2>&1 | tail -5` → 期望包含: `pass`

---

### 场景 8：Agent管理页面

#### - [x] 8.1 AgentsPage 包含全部 6 个 API 调用

- **来源:** spec-plan.md Task 6 / spec-plan-2.md Task 8
- **目的:** 确认 Agent CRUD + 设为默认 API 对接完整
- [A] `grep -c "apiListAgents\|apiGetAgent\|apiCreateAgent\|apiSetAgent\|apiDeleteAgent\|apiSetDefaultAgent" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/AgentsPage.tsx` → 期望包含: `≥ 6`

#### - [x] 8.2 内置 Agent 保护逻辑存在

- **来源:** spec-plan.md Task 6 / spec-plan-2.md Task 8
- **目的:** 确认内置 Agent 不可删除
- [A] `grep -c "BUILT_IN_AGENTS" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/AgentsPage.tsx` → 期望包含: `≥ 2`

#### - [x] 8.3 Agents 页面校验函数测试通过

- **来源:** spec-plan.md Task 6 / spec-plan-2.md Task 8
- **目的:** 确认 Agent 名称格式和步数校验正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-agents-page.test.ts 2>&1 | tail -5` → 期望包含: `pass`

---

### 场景 9：技能管理页面

#### - [x] 9.1 react-markdown 依赖已安装

- **来源:** spec-plan.md Task 7
- **目的:** 确认 Markdown 渲染库可用
- [A] `grep -q "react-markdown" /Users/konghayao/code/pazhou/remote-control-server/web/package.json && echo "OK"` → 期望精确: `OK`

#### - [x] 9.2 SkillsPage 包含全部 6 个 API 调用

- **来源:** spec-plan.md Task 7 / spec-plan-2.md Task 9
- **目的:** 确认 Skill CRUD + 启用/禁用 API 对接完整
- [A] `grep -c "apiListSkills\|apiGetSkill\|apiSetSkill\|apiDeleteSkill\|apiEnableSkill\|apiDisableSkill" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/SkillsPage.tsx` → 期望包含: `≥ 6`

#### - [x] 9.3 Markdown 编辑器组件引用

- **来源:** spec-plan.md Task 7 / spec-plan-2.md Task 9
- **目的:** 确认 Markdown 实时预览功能
- [A] `grep -c "ReactMarkdown\|Markdown" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/SkillsPage.tsx` → 期望包含: `≥ 1`

#### - [x] 9.4 删除确认弹窗包含"此操作不可逆"文案

- **来源:** spec-plan.md Task 7 / spec-design.md Skills
- **目的:** 确认危险操作提示完整
- [A] `grep "此操作不可逆" /Users/konghayao/code/pazhou/remote-control-server/web/src/pages/SkillsPage.tsx` → 期望包含: `此操作不可逆`

#### - [x] 9.5 Skills 页面校验函数测试通过

- **来源:** spec-plan.md Task 7 / spec-plan-2.md Task 9
- **目的:** 确认 Skill 表单校验和 metadata 构建逻辑正确
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/config-skills-page.test.ts 2>&1 | tail -5` → 期望包含: `pass`

---

### 场景 10：全局构建与完整测试

#### - [x] 10.1 完整测试套件通过

- **来源:** spec-plan.md Task 8 / spec-plan-1.md Task [5 验收] / spec-plan-2.md Task [总体验收]
- **目的:** 确认无回归问题
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun test web/src/__tests__/ 2>&1 | tail -15` → 期望包含: `0 fail`

#### - [x] 10.2 前端生产构建通过

- **来源:** spec-plan.md Task 8 / spec-plan-2.md Task [总体验收]
- **目的:** 确认所有 TypeScript 编译无错误
- [A] `cd /Users/konghayao/code/pazhou/remote-control-server && bun run build:web 2>&1 | tail -5` → 期望包含: `built in`

#### - [x] 10.3 API Client 配置函数总数达标

- **来源:** spec-plan-1.md Task [5 验收]
- **目的:** 确认所有模块 API 函数已导出
- [A] `grep "export function api.*Provider\|export function api.*Model\|export function api.*Agent\|export function api.*Skill" /Users/konghayao/code/pazhou/remote-control-server/web/src/api/client.ts | wc -l` → 期望包含: `≥ 20`

---

### 场景 11：端到端视觉验收

#### - [x] 11.1 Sidebar 显示 7 个平铺入口

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准 / spec-plan-2.md Task [总体验收]
- **目的:** 确认导航入口完整可见
- [H] 打开 `http://localhost:5173/code/`，检查 Sidebar 显示：仪表盘、会话（如有活跃会话）、API 密钥、服务商、模型、Agent、技能、退出 → 是否所有入口可见且中文标签和图标正确？

#### - [x] 11.2 4 个配置页面懒加载正常

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准 / spec-plan-2.md Task [总体验收]
- **目的:** 确认页面按需加载
- [H] 依次点击 Sidebar 的"服务商"、"模型"、"Agent"、"技能"入口，检查 URL 变化和页面渲染，DevTools Network 面板确认各页面 JS 为独立 chunk → 是否 URL 正确变为 /code/providers 等，页面正常渲染？

#### - [x] 11.3 Providers 页面完整 CRUD

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准
- **目的:** 确认服务商管理功能完整
- [H] 打开 `http://localhost:5173/code/providers`，执行：新建 Provider（填写名称和 API Key）→ 编辑（修改 Base URL）→ 测试连接（观察 loading → 成功弹窗展示模型列表）→ 删除（ConfirmDialog 确认）→ 是否所有操作正常且 Toast 反馈正确？

#### - [x] 11.4 Models 页面模型切换即时生效

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准
- **目的:** 确认模型配置即时保存
- [H] 打开 `http://localhost:5173/code/models`，切换主模型 Select → 刷新页面确认保持 → 点击"刷新"按钮观察列表更新 → 是否 Select 切换即时生效且刷新正常？

#### - [x] 11.5 Agents 页面新建与内置保护

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准
- **目的:** 确认 Agent 管理和内置保护
- [H] 打开 `http://localhost:5173/code/agents`，新建自定义 Agent（填写名称、模型、模式、步数）→ 确认内置 Agent（build/plan/general 等）操作列无"删除"按钮 → 设为默认 → 批量选择自定义 Agent → 批量删除 → 是否新建成功且内置保护生效？

#### - [x] 11.6 Skills 页面 Markdown 编辑器

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准
- **目的:** 确认 Markdown 编辑和实时预览
- [H] 打开 `http://localhost:5173/code/skills`，新建 Skill → 在 Markdown 编辑器左侧输入内容 → 观察右侧实时预览 → 保存 → 启用/禁用切换 → 编辑 → 批量删除（确认弹窗含"此操作不可逆"）→ 是否 Markdown 预览正常且操作流程完整？

#### - [x] 11.7 Toast 通知正常显示

- **来源:** spec-design.md 验收标准 / spec-plan-2.md Task [总体验收]
- **目的:** 确认操作反馈机制有效
- [H] 在任意模块执行操作（如删除），观察右上角 Toast 通知 → 是否成功/错误 Toast 均正确显示？

#### - [x] 11.8 搜索、筛选、排序、分页功能

- **来源:** spec-plan.md Task 8 / spec-design.md 验收标准
- **目的:** 确认 DataTable 交互一致
- [H] 在 Providers 页面搜索框输入文字 → 点击"名称"列头排序 → 切换分页 → 是否过滤/排序/分页均正常？

---

### 场景 12：边界与回归

#### - [x] 12.1 空状态显示正确

- **来源:** spec-design.md 验收标准
- **目的:** 确认无数据时的友好提示
- [H] 在无数据的模块页面（如删除所有测试 Provider 后），检查 EmptyState 组件是否正确显示"暂无数据"和操作按钮 → 是否空状态友好且可操作？

#### - [x] 12.2 表单校验错误提示

- **来源:** spec-design.md 实现要点 §5
- **目的:** 确认前端校验与后端一致
- [H] 在 Providers 新建弹窗中提交空名称 → 在 Agents 新建弹窗中输入 "MY-AGENT"（大写）→ 在 Skills 新建弹窗中清空内容 → 是否字段下方显示红色校验提示？

#### - [x] 12.3 API 错误 Toast 提示

- **来源:** spec-design.md 验收标准
- **目的:** 确认错误反馈机制有效
- [H] 在后端未运行时访问 Providers 页面，观察错误提示 → 是否 Toast 显示具体错误信息？

#### - [x] 12.4 批量删除确认弹窗

- **来源:** spec-design.md 验收标准
- **目的:** 确认批量操作有二次确认
- [H] 在 Providers 或 Skills 页面选中多行 → 点击批量删除 → 检查 ConfirmDialog 是否显示"确定要删除选中的 N 个..."→ 是否确认弹窗文案正确且需确认后执行？

#### - [x] 12.5 Models 手动输入模型 ID

- **来源:** spec-design.md Models 页面
- **目的:** 确认 Select 下拉支持自定义输入
- [H] 打开 Models 页面 → 在主模型 Select 下方的输入框手动输入一个不在列表中的模型 ID → 观察是否接受并保存 → 是否手动输入功能正常？

---

## 验收后清理

- [ ] [AUTO] 终止后台服务 [后端服务]: `kill $(lsof -t -i:3000) 2>/dev/null; echo "done"` (对应准备阶段启动的后端 dev 服务)
- [ ] [AUTO] 终止后台服务 [前端开发服务器]: `kill $(lsof -t -i:5173) 2>/dev/null; echo "done"` (对应准备阶段启动的前端 dev:web 服务)

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | Vite 构建成功 | 1 | 0 | ✅ |
| 场景 1 | 1.2 | 测试框架可用 | 1 | 0 | ✅ |
| 场景 2 | 2.1 | sonner/react-markdown 已安装 | 1 | 0 | ✅ |
| 场景 2 | 2.2 | App.tsx Toaster 组件 | 1 | 0 | ✅ |
| 场景 2 | 2.3 | 类型定义文件存在 | 1 | 0 | ✅ |
| 场景 2 | 2.4 | 配置类型测试通过 | 1 | 0 | ✅ |
| 场景 3 | 3.1 | API 函数完整导出 | 1 | 0 | ✅ |
| 场景 3 | 3.2 | API 客户端测试通过 | 1 | 0 | ✅ |
| 场景 3 | 3.3 | TypeScript 编译无错 | 1 | 0 | ✅ |
| 场景 4 | 4.1 | 共享组件文件完整 | 1 | 0 | ✅ |
| 场景 4 | 4.2 | index.ts 导出完整 | 1 | 0 | ✅ |
| 场景 4 | 4.3 | DataTable Column 接口 | 1 | 0 | ✅ |
| 场景 4 | 4.4 | DataTable 纯函数导出 | 1 | 0 | ✅ |
| 场景 4 | 4.5 | DataTable 测试通过 | 1 | 0 | ✅ |
| 场景 4 | 4.6 | 辅助组件测试通过 | 1 | 0 | ✅ |
| 场景 5 | 5.1 | Sidebar 分隔线支持 | 1 | 0 | ✅ |
| 场景 5 | 5.2 | 4 个 lucide 图标 | 1 | 0 | ✅ |
| 场景 5 | 5.3 | ViewId 类型完整 | 1 | 0 | ✅ |
| 场景 5 | 5.4 | 路由解析测试通过 | 1 | 0 | ✅ |
| 场景 5 | 5.5 | 懒加载数量正确 | 1 | 0 | ✅ |
| 场景 6 | 6.1 | ProvidersPage 正确导出 | 1 | 0 | ✅ |
| 场景 6 | 6.2 | API 函数引用完整 | 1 | 0 | ✅ |
| 场景 6 | 6.3 | 共享组件引用完整 | 1 | 0 | ✅ |
| 场景 6 | 6.4 | Providers 测试通过 | 1 | 0 | ✅ |
| 场景 7 | 7.1 | ModelsPage 正确导出 | 1 | 0 | ✅ |
| 场景 7 | 7.2 | Models 无多余功能 | 1 | 0 | ✅ |
| 场景 7 | 7.3 | Models 测试通过 | 1 | 0 | ✅ |
| 场景 8 | 8.1 | Agents API 调用完整 | 1 | 0 | ✅ |
| 场景 8 | 8.2 | 内置 Agent 保护 | 1 | 0 | ✅ |
| 场景 8 | 8.3 | Agents 测试通过 | 1 | 0 | ✅ |
| 场景 9 | 9.1 | react-markdown 已安装 | 1 | 0 | ✅ |
| 场景 9 | 9.2 | Skills API 调用完整 | 1 | 0 | ✅ |
| 场景 9 | 9.3 | Markdown 编辑器引用 | 1 | 0 | ✅ |
| 场景 9 | 9.4 | 删除确认弹窗文案 | 1 | 0 | ✅ |
| 场景 9 | 9.5 | Skills 测试通过 | 1 | 0 | ✅ |
| 场景 10 | 10.1 | 完整测试套件通过 | 1 | 0 | ✅ |
| 场景 10 | 10.2 | 生产构建通过 | 1 | 0 | ✅ |
| 场景 10 | 10.3 | API 函数总数达标 | 1 | 0 | ✅ |
| 场景 11 | 11.1 | Sidebar 7 个入口 | 0 | 1 | ✅ |
| 场景 11 | 11.2 | 4 页面懒加载 | 0 | 1 | ✅ |
| 场景 11 | 11.3 | Providers CRUD | 0 | 1 | ✅ |
| 场景 11 | 11.4 | Models 切换即时生效 | 0 | 1 | ✅ |
| 场景 11 | 11.5 | Agents 新建+保护 | 0 | 1 | ✅ |
| 场景 11 | 11.6 | Skills Markdown 编辑器 | 0 | 1 | ✅ |
| 场景 11 | 11.7 | Toast 通知显示 | 0 | 1 | ✅ |
| 场景 11 | 11.8 | 搜索筛选排序分页 | 0 | 1 | ✅ |
| 场景 12 | 12.1 | 空状态显示 | 0 | 1 | ✅ |
| 场景 12 | 12.2 | 表单校验提示 | 0 | 1 | ✅ |
| 场景 12 | 12.3 | API 错误 Toast | 0 | 1 | ✅ |
| 场景 12 | 12.4 | 批量删除确认 | 0 | 1 | ✅ |
| 场景 12 | 12.5 | 手动输入模型 ID | 0 | 1 | ✅ |

**验收结论:** ✅ 全部通过
