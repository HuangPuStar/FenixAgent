# fenixaos-style-migration 人工验收清单

**生成时间:** 2026-05-10 20:49
**关联计划:** `spec/feature_20260510_F001_fenixaos-style-migration/spec-plan.md`
**关联设计:** `spec/feature_20260510_F001_fenixaos-style-migration/spec-design.md`

---

## 验收前准备

### 环境要求
- [x] [AUTO] 检查 Bun 版本可用: `bun --version`
- [x] [AUTO] 运行前端专项测试: `cd /Users/liyuan/Work/mothership-beta/mothership && bun test apps/web/src/__tests__` 
- [x] [AUTO] 运行 workspace 类型检查: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run typecheck`
- [x] [AUTO] 运行 workspace 构建: `cd /Users/liyuan/Work/mothership-beta/mothership && bun run build`
- [x] [AUTO/SERVICE] 启动前端开发服务: `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run dev` (port: 5173)
- [x] [MANUAL] 确认 `http://localhost:4001` 可返回 dashboard 数据；若未启动后端，至少准备一个可观察错误壳层的页面环境

### 测试数据准备
- [ ] 使用仓库内现有 dashboard fixture 与本地环境数据，无需额外造数

---

## 验收项目

### 场景 1：基础质量门禁

#### - [x] 1.1 前端测试链路通过
- **来源:** spec-plan.md Task 0 / Task 5
- **目的:** 确认前端基线稳定
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/dashboard.test.tsx` → 期望包含: 3 pass
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/theme.test.ts` → 期望包含: pass
  3. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/ui-primitives.test.tsx` → 期望包含: pass
  4. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/shell-patterns.test.tsx` → 期望包含: pass

#### - [x] 1.2 workspace 构建与类型检查通过
- **来源:** spec-plan.md Task 0 / Task 5
- **目的:** 确认交付可集成
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun run typecheck` → 期望包含: Found 0 errors
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership && bun run build` → 期望包含: vite build

### 场景 2：设计系统资产落地

#### - [x] 2.1 视觉规范文档与 token 命名同步存在
- **来源:** spec-plan.md Task 1 / Task 5 / spec-design.md 设计系统分层、主题与颜色规范
- **目的:** 确认规范与代码同源
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'surface-0|surface-3|status\\.success|Dashboard / Overview|Environment / Runtime|Plugin / Capability' docs/ui-style-guide.md src/styles/theme.ts src/styles/theme.css` → 期望包含: surface-0
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'UI Primitives|Page Shell Patterns|surface-0|status\\.info' docs/ui-style-guide.md src/styles/theme.ts` → 期望包含: UI Primitives

#### - [x] 2.2 全局样式入口接入完成
- **来源:** spec-plan.md Task 1
- **目的:** 确认主题已真正生效
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'styles/index.css|@import \"\\./theme.css\"' src/main.tsx src/styles/index.css` → 期望包含: styles/index.css

#### - [x] 2.3 primitives 与 shell/pattern 组件导出齐全
- **来源:** spec-plan.md Task 2 / Task 3
- **目的:** 确认可复用组件齐备
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'export function (Button|Badge|PanelHeader)|export function Card|export function CardHeader|export function CardContent' src/components/ui` → 期望包含: export function Button
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'export function (AppShell|Sidebar|SummaryCard|EmptyState)' src/components/shell src/components/patterns` → 期望包含: export function AppShell

### 场景 3：Dashboard 成为第一批规范消费页

#### - [x] 3.1 Dashboard 已接入 design system 组件组合
- **来源:** spec-plan.md Task 4 / Task 5 / spec-design.md 与当前 mothership 的衔接方式
- **目的:** 确认页面完成迁移
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'AppShell|Sidebar|PanelHeader|SummaryCard|EmptyState' src/pages/dashboard.tsx src/components/environment-list.tsx` → 期望包含: AppShell
  2. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'AppShell|Sidebar|SummaryCard|EmptyState|Badge' src/pages/dashboard.tsx src/components/environment-list.tsx src/components/plugin-capability-badge.tsx` → 期望包含: Badge

#### - [x] 3.2 核心展示组件不再保留内联样式
- **来源:** spec-plan.md Task 4 / spec-design.md 实现要点
- **目的:** 防止样式再次分裂
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && if ! rg -n 'style=\\{\\{' src/pages/dashboard.tsx src/components/environment-list.tsx src/components/plugin-capability-badge.tsx; then echo CLEAN; fi` → 期望包含: CLEAN

#### - [x] 3.3 成功态页面具备控制台骨架与信息节奏
- **来源:** spec-plan.md Task 4 / spec-design.md 视觉定位、页面模式规范
- **目的:** 确认首批页面观感达标
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173`，查看 Dashboard 成功态是否同时具备侧边栏、页头、2-4 张概览卡片与环境列表区，且整体为深色控制台风格而非浅色后台 → 是/否

#### - [x] 3.4 状态与类别标签使用统一语义色
- **来源:** spec-plan.md Task 2 / Task 4 / spec-design.md 状态语义色、Badge / Status Pill
- **目的:** 确认状态表达统一
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173`，查看 environment 状态标签与 capability 标签是否分别表现为统一的状态色和类别色，且高亮色只做局部点缀没有大面积铺底 → 是/否

### 场景 4：边界与回归

#### - [x] 4.1 错误态仍保留控制台壳层
- **来源:** spec-plan.md Task 4 / spec-design.md 动效与反馈、导航与壳层原则
- **目的:** 确认异常时体验一致
- **操作步骤:**
  1. [H] 在后端不可用或请求失败条件下打开 `http://localhost:5173`，查看错误态是否仍保留侧边栏与统一错误面板，而不是退回空白页或浅色整页提示 → 是/否

#### - [x] 4.2 加载态不再出现空白页
- **来源:** spec-plan.md Task 4 / spec-design.md 动效与反馈
- **目的:** 确认加载反馈连续
- **操作步骤:**
  1. [A] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/dashboard.test.tsx` → 期望包含: loading
  2. [H] 打开 `http://localhost:5173` 并在初次加载时观察，确认出现加载占位或 loading empty state，而不是整页空白 → 是/否

#### - [x] 4.3 模块色与 surface 分层符合设计边界
- **来源:** spec-design.md 视觉定位、Surface 体系、模块功能色
- **目的:** 确认未偏离设计约束
- **操作步骤:**
  1. [H] 打开 `http://localhost:5173`，查看页面是否以 surface 明度差和边框做分层，模块色仅用于导航激活、图标底片、统计点缀，没有出现整块高饱和背景或营销站式大色块 → 是/否

---

## 验收后清理

- [x] [AUTO] 终止后台服务 [web dev server]: `kill $PID`

---

## 验收结果汇总

| 场景 | 序号 | 验收项 | [A] | [H] | 结果 |
|------|------|--------|-----|-----|------|
| 场景 1 | 1.1 | 前端测试链路通过 | 4 | 0 | ✅ |
| 场景 1 | 1.2 | workspace 构建与类型检查通过 | 2 | 0 | ✅ |
| 场景 2 | 2.1 | 视觉规范文档与 token 命名同步存在 | 2 | 0 | ✅ |
| 场景 2 | 2.2 | 全局样式入口接入完成 | 1 | 0 | ✅ |
| 场景 2 | 2.3 | primitives 与 shell/pattern 组件导出齐全 | 2 | 0 | ✅ |
| 场景 3 | 3.1 | Dashboard 已接入 design system 组件组合 | 2 | 0 | ✅ |
| 场景 3 | 3.2 | 核心展示组件不再保留内联样式 | 1 | 0 | ✅ |
| 场景 3 | 3.3 | 成功态页面具备控制台骨架与信息节奏 | 0 | 1 | ✅ |
| 场景 3 | 3.4 | 状态与类别标签使用统一语义色 | 0 | 1 | ✅ |
| 场景 4 | 4.1 | 错误态仍保留控制台壳层 | 0 | 1 | ✅ |
| 场景 4 | 4.2 | 加载态不再出现空白页 | 1 | 1 | ✅ |
| 场景 4 | 4.3 | 模块色与 surface 分层符合设计边界 | 0 | 1 | ✅ |

**验收结论:** ✅ 全部通过 / ⬜ 存在问题
