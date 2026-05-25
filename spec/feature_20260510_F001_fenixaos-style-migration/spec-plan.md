# fenixaos-style-migration 执行计划

**目标:** 为 `mothership/apps/web` 建立可复用的深色控制台视觉系统，并让 Dashboard 成为第一批规范消费页。

**技术栈:** Bun、React 19、TypeScript、Vite 6、原生 CSS Custom Properties、Bun Test

**设计文档:** `spec/feature_20260510_F001_fenixaos-style-migration/spec-design.md`

## 改动总览

本次改动集中在 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src`，先补齐 `styles/`、`components/ui/`、`components/shell/`、`components/patterns/` 四层，再迁移现有 Dashboard 页面与环境列表。
经代码分析确认，当前前端只有 `DashboardPage`、`EnvironmentList`、`PluginCapabilityBadge` 三个展示组件承载视觉输出，且几乎全部样式都以内联 `style` 写在组件内，因此迁移成本低，适合先抽离全局 token 和 primitives。
Task 1 建立规范文档与 token 源，Task 2 基于 token 建立 primitives，Task 3 组合出 console shell 与 dashboard patterns，Task 4 再修改 `App.tsx`、`dashboard.tsx` 和列表组件完成试点迁移。
经代码分析确认，`DashboardPage` 仅被 `src/App.tsx` 与 `src/__tests__/dashboard.test.tsx` 调用，`EnvironmentList` 仅被 `src/pages/dashboard.tsx` 调用，`PluginCapabilityBadge` 仅被 `src/components/environment-list.tsx` 调用，因此页面重构的调用面清晰，可在单个 feature 内完成闭环。

---

### Task 0: 环境准备

**背景:**
当前 `apps/web` 已具备独立的 `build`、`typecheck` 脚本，测试通过 Bun 直接运行 `src/__tests__`。
后续 Task 会新增 CSS 入口、多个组件文件与静态渲染测试，先验证现有构建链路可用，避免把环境问题误判成实现问题。

**执行步骤:**
- [x] 验证前端构建命令可用
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/package.json:scripts.build`
  - 执行 `bun run build`，确认当前 Vite 生产构建可在 `apps/web` 独立完成。
  - 原因: Task 1 和 Task 4 都会修改构建入口 `src/main.tsx`，需要先确认基线正常。
- [x] 验证类型检查命令可用
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/package.json:scripts.typecheck`
  - 执行 `bun run typecheck`，确认新增组件前 TypeScript 配置无历史错误。
  - 原因: 后续 plan 会新增多层组件与共享类型，必须依赖稳定的类型反馈。
- [x] 验证当前 dashboard 测试命令可用
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/dashboard.test.tsx`
  - 执行 `bun test src/__tests__/dashboard.test.tsx`，确认 Bun Test 与 React 静态渲染测试可直接运行。
  - 原因: 后续每个 Task 都需要用同一套测试基础设施补充单测。

**检查步骤:**
- [x] 构建命令执行成功
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run build`
  - 预期: 输出包含 `vite build` 和 `built in`，无报错
- [x] 类型检查命令执行成功
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run typecheck`
  - 预期: 命令退出码为 0，无 TypeScript 错误
- [x] 测试命令执行成功
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/dashboard.test.tsx`
  - 预期: 现有 3 个 dashboard 测试通过

---

### Task 1: 建立视觉规范与主题 Token

**背景:**
本 Task 为整个 feature 提供“文档规范 + 代码 token”双份源头，解决当前样式分散在页面内联对象中的问题。
经代码分析确认，`src/main.tsx` 当前只挂载 `<App />`，尚未引入任何全局样式；`mothership/apps/web/docs/` 目录已存在但为空，适合放置本次视觉系统规范文档。
Task 2 的 primitives、Task 3 的 shell 与 Task 4 的页面迁移都依赖统一的命名和 token 语义，因此本 Task 必须先落地。

**涉及文件:**
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/docs/ui-style-guide.md`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/styles/theme.ts`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/styles/theme.css`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/styles/index.css`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/theme.test.ts`
- 修改: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/main.tsx`

**执行步骤:**
- [x] 编写视觉系统规范文档，固定四层分层与命名约束
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/docs/ui-style-guide.md`
  - 文档按“视觉定位 → Design Tokens → Semantic Tokens → UI Primitives → Page Shell Patterns → Dashboard 试点约束”的顺序组织，并把设计文档中已经定死的内容写成确定性规范：深色控制台定位、surface-0~3、状态语义色、模块功能色、排版层级、间距节拍、按钮/卡片/Badge/表单/侧栏规则。
  - 明确写出当前仓库真实目录：`src/styles/`、`src/components/ui/`、`src/components/shell/`、`src/components/patterns/`，避免沿用不存在的路径占位。
  - 原因: 本 feature 的目标不是单页美化，而是为后续页面开发建立统一基线。
- [x] 在 `theme.ts` 中定义可复用的语义 token 常量
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/styles/theme.ts`
  - 导出 `SURFACE_TOKENS`、`STATUS_TONES`、`MODULE_TONES`、`TYPOGRAPHY_SCALE`、`SPACING_SCALE` 五组常量，并为 `status` 与 `module` tone 提供字面量类型，供后续 `Badge`、`Sidebar`、`SummaryCard` 直接消费。
  - 常量名必须与文档和 CSS 自定义属性一一对应，例如 `surface-0` ↔ `--surface-0`、`status.info` ↔ `--status-info-bg` / `--status-info-fg`。
  - 原因: 让测试与组件逻辑都能引用同一份语义命名，而不是在多个组件里重复硬编码颜色字符串。
- [x] 在 `theme.css` 中落地深色控制台 CSS Custom Properties
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/styles/theme.css`
  - 在 `:root` 定义基础背景、surface、文本、边框、阴影、状态色、模块色、圆角、间距、动效时长等自定义属性，并用注释分隔“surface / text / border / status / module / motion”几个区块。
  - 保持系统字体栈，只使用 `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif` 及中文 fallback，不引入外部字体资源。
  - 原因: 后续所有组件都应通过语义变量消费颜色和层级，而不是再发明页面级配色。
- [x] 在 `index.css` 中建立全局基线样式并接入 `theme.css`
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/styles/index.css`
  - 顶部使用 `@import "./theme.css";`，然后为 `:root`、`html`、`body`、`#root`、`button`、`input`、`textarea`、`select` 补充深色控制台基础 reset、背景、文字色、焦点 ring、滚动条和选中文本样式。
  - 保留“克制动效”原则，仅定义 hover/focus/opacity/transform 级别的基础过渡，不引入大幅位移或弹跳。
  - 原因: 让 Task 2 之后新增的 primitives 天然继承统一基线，而不是每个组件重复 reset。
- [x] 在应用入口接入全局样式
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/main.tsx` 顶部 import 区，`import { App } from "./App";` 之前
  - 新增 `import "./styles/index.css";`，其他挂载逻辑保持不变。
  - 原因: `main.tsx` 是当前唯一浏览器入口，全局样式必须在这里一次性接入。
- [x] 为主题 token 编写单元测试
  - 测试文件: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/theme.test.ts`
  - 测试场景:
    - token 分层完整: `SURFACE_TOKENS` 必须包含 `surface-0` 到 `surface-3`
    - 语义色完整: `STATUS_TONES` 必须覆盖 `info/success/warning/danger/neutral`
    - 模块色完整: `MODULE_TONES` 必须覆盖 `dashboard/runtime/session/plugin/config/danger`
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/theme.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查样式入口已接入
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'styles/index.css|styles/theme.css' src/main.tsx src/styles/index.css`
  - 预期: `src/main.tsx` 引入 `styles/index.css`，`src/styles/index.css` 引入 `theme.css`
- [x] 检查规范文档与 token 命名一致
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'surface-0|status\\.info|module|UI Primitives|Page Shell Patterns' docs/ui-style-guide.md src/styles/theme.ts`
  - 预期: 文档与 `theme.ts` 中都能找到相同的语义命名
- [x] 运行主题测试
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/theme.test.ts`
  - 预期: 主题 token 测试全部通过

---

### Task 2: 实现深色控制台 UI Primitives

**背景:**
当前 `DashboardPage`、`EnvironmentList`、`PluginCapabilityBadge` 都直接输出内联样式，缺少可复用的按钮、卡片、Badge 和统一面板头。
经代码分析确认，这三个组件的样式诉求高度重叠：都需要 surface 分层、状态色、标题/说明/操作区节奏，因此适合先抽成 primitives，再由后续 Task 组合成 shell 和业务页面。
Task 3 的 shell/patterns 与 Task 4 的 dashboard 迁移都直接依赖本 Task 输出。

**涉及文件:**
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/button.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/card.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/badge.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/panel-header.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/ui-primitives.test.tsx`

**执行步骤:**
- [x] 新建 `Button` 组件，固定动作语义和尺寸体系
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/button.tsx`
  - 导出 `Button` 组件，使用原生 `<button>` 包装，支持 `primary`、`secondary`、`outline`、`ghost`、`danger` 五个 variant，以及 `md`、`sm`、`icon` 三个 size。
  - 用 `data-variant` / `data-size` 或明确 className 分支把样式切到 `index.css` / `theme.css` 中定义的 token，禁止再写颜色字面量。
  - 原因: 后续 Dashboard 页头主动作、空状态按钮和工具栏按钮都需要共享同一套按钮语义。
- [x] 新建 `Card` 组件族，承载 surface 分层
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/card.tsx`
  - 导出 `Card`、`CardHeader`、`CardTitle`、`CardDescription`、`CardContent`、`CardFooter` 六个组件，默认使用 `surface-2`，并支持 `surface="1" | "2" | "3"` 的显式覆盖。
  - 组件内部结构固定为标题、说明、内容、脚注插槽，避免 Task 4 再在业务页面里重复组织容器样式。
  - 原因: 设计文档明确要求后续页面不得各自发明“差不多”的卡片容器。
- [x] 新建 `Badge` 组件，统一状态和类别两类标签
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/badge.tsx`
  - 导出 `Badge` 组件，支持 `kind="status" | "category"`、`tone` 参数；`status` 直接消费 Task 1 的 `STATUS_TONES`，`category` 消费 `MODULE_TONES`。
  - 为 `offline/idle/running/error` 这类文本预留 `statusToneByLabel` 映射函数，供 Task 4 的环境列表直接复用。
  - 原因: 当前环境状态和 capability 标签都各自写了一套 pill 样式，后续必须统一收口。
- [x] 新建 `PanelHeader` 组件，统一页头与面板头节奏
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/ui/panel-header.tsx`
  - 导出 `PanelHeader` 组件，接收 `eyebrow`、`title`、`description`、`actions` 四个插槽，适配 Dashboard 页头和列表卡片头部。
  - 布局使用“标题区 + 操作区”双列结构，小屏幕下自然换行，不新增额外断点逻辑。
  - 原因: 设计文档要求页头、区块头、卡片头维持统一节奏。
- [x] 为 UI primitives 编写静态渲染测试
  - 测试文件: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/ui-primitives.test.tsx`
  - 测试场景:
    - Button 语义: `danger` 和 `ghost` variant 输出对应语义标记
    - Card 结构: `CardHeader`、`CardContent` 组合后能渲染标题与正文
    - Badge 语义: `status=success` 与 `category=plugin` 能输出稳定的 tone 标记
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/ui-primitives.test.tsx`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 primitives 导出齐全
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'export function (Button|Badge|PanelHeader)|export function Card|export function CardHeader|export function CardContent' src/components/ui`
  - 预期: 四个 primitives 文件都包含对应导出
- [x] 运行 primitives 测试
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/ui-primitives.test.tsx`
  - 预期: Button、Card、Badge、PanelHeader 测试全部通过
- [x] 运行类型检查
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run typecheck`
  - 预期: 新增组件无类型错误

---

### Task 3: 组装 Console Shell 与 Dashboard Patterns

**背景:**
设计文档要求先确定“侧边栏 + 工作区”的控制台骨架，以及 summary-card、empty-state 这类可重复使用的模式组件。
经代码分析确认，当前 `DashboardPage` 自己承担了页头、概览卡片和内容容器三层责任，缺少 shell 与 pattern 的分界；在真正改页面前，需要先把这些结构抽离出来。
Task 4 会直接消费本 Task 的 `AppShell`、`Sidebar`、`SummaryCard`、`EmptyState`，因此这里的接口要先稳定。

**涉及文件:**
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/shell/app-shell.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/shell/sidebar.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/patterns/summary-card.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/patterns/empty-state.tsx`
- 新建: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/shell-patterns.test.tsx`

**执行步骤:**
- [x] 新建 `AppShell`，固定控制台整体骨架
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/shell/app-shell.tsx`
  - 组件负责渲染最外层 `surface-0` 背景、左侧导航栏、主工作区容器和可选右侧附加区，API 设计为 `sidebar`、`children`、`aside` 三个插槽。
  - 主工作区内容宽度与 padding 固定为设计文档推荐的 `24-32px` 节奏，不能再由业务页面自行决定整页背景和最大宽度。
  - 原因: 把“控制台壳层”从 Dashboard 业务内容里剥离出来，后续 Environment/Session/Config 页面可直接复用。
- [x] 新建 `Sidebar`，固定模块导航激活态与分组节奏
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/shell/sidebar.tsx`
  - 接收导航项数组，字段至少包含 `id`、`label`、`description`、`tone`、`active`，当前先内置 Dashboard、Environment、Session、Plugin、Config 五个模块项。
  - 激活态通过左侧色条、背景提升和 tone 图标底片表达，禁用态与占位模块保持可读但不抢主视觉。
  - 原因: 设计文档明确要求模块功能色只承担导航激活提示和局部点缀，不做整块背景。
- [x] 新建 `SummaryCard` 与 `EmptyState` 两个组合模式
  - 位置: 新建 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/patterns/summary-card.tsx` 与 `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/patterns/empty-state.tsx`
  - `SummaryCard` 组合 `Card` 与 `Badge`，接收 `label`、`value`、`description`、`tone`、`status`；`EmptyState` 组合 `Card`、`PanelHeader` 和可选 `Button` actions，用于“无环境”“加载失败”“暂无数据”三类场景。
  - 结构上不要嵌入 Dashboard 专属字段名，确保 Task 4 之外的页面也能直接复用。
  - 原因: 文档中点名要求概览页和列表页共享相同的卡片与空状态节奏。
- [x] 为 shell 与 patterns 编写静态渲染测试
  - 测试文件: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/shell-patterns.test.tsx`
  - 测试场景:
    - AppShell 布局: 传入 sidebar 与 children 后能输出导航区和主工作区标记
    - Sidebar 激活态: `dashboard` 项 active 时输出对应 tone 与 active 标记
    - SummaryCard/EmptyState: 能渲染 value、description 和 action 文案
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/shell-patterns.test.tsx`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 shell 与 patterns 文件已创建
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'export function (AppShell|Sidebar|SummaryCard|EmptyState)' src/components/shell src/components/patterns`
  - 预期: 四个组件均有导出
- [x] 运行 shell/pattern 测试
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/shell-patterns.test.tsx`
  - 预期: 壳层与模式组件测试全部通过
- [x] 运行类型检查
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run typecheck`
  - 预期: 组件接口与 tone 类型无错误

---

### Task 4: 迁移 Dashboard 为第一批规范消费页

**背景:**
本 Task 把现有 prototype dashboard 从“浅色营销风 + 大量内联样式”迁到深色控制台系统，并验证新体系能覆盖概览页、列表页、错误态和加载态。
经代码分析确认，`loadDashboardData()` 只在 `src/App.tsx` 调用，`DashboardPage` 的 props 只被 `App.tsx` 和 `dashboard.test.tsx` 使用；`EnvironmentList` 只被 `DashboardPage` 调用，`PluginCapabilityBadge` 只被 `EnvironmentList` 调用，因此可以一次性调整这些接口而不影响其他页面。
本 Task 依赖 Task 1 的 token、Task 2 的 primitives 和 Task 3 的 shell/patterns，完成后 Dashboard 会成为后续 Environment/Session/Plugin 页面迁移的样板。

**涉及文件:**
- 修改: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/App.tsx`
- 修改: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/pages/dashboard.tsx`
- 修改: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/environment-list.tsx`
- 修改: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/plugin-capability-badge.tsx`
- 修改: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/dashboard.test.tsx`

**执行步骤:**
- [x] 在 `App.tsx` 中显式管理 loading / error / success 三态
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/App.tsx:15-46` 的状态与返回逻辑
  - 在现有 `data`、`error` 基础上增加 `isLoading` 推导或独立状态，并把 `loading` 布尔值传给 `DashboardPage`；保留 `loadDashboardData()` 的调用时机和取消标记逻辑不变。
  - 不修改 `loadDashboardData()` 的返回类型与请求路径，避免把视觉迁移和数据层变更耦合在一起。
  - 原因: 当前加载态会直接渲染空白页，不符合“运行中的系统工作台”定位。
- [x] 重写 `DashboardPage`，改为消费 shell、primitives 与 patterns
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/pages/dashboard.tsx` 中 `DashboardPage()` 函数主体（~L29 起）以及底部 `SummaryCard()` 本地函数（~L118 起）
  - 新增 `loading?: boolean` 到 `DashboardPageProps`，删除本地 `SummaryCard` 实现，改为导入 `AppShell`、`Sidebar`、`PanelHeader`、`SummaryCard`、`EmptyState`。
  - 页面结构固定为：左侧 `Sidebar`、主区域页头、三张 summary cards、环境列表卡片区；错误态和加载态都通过 `EmptyState` / `Card` 渲染在相同壳层中，不再切回浅色整页容器。
  - 原因: 让 Dashboard 成为 design system 的真实消费页，而不是继续持有自己的一次性样式。
- [x] 改造 `EnvironmentList`，把环境卡片、状态 pill 和空状态统一到 primitives
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/environment-list.tsx:16-118`
  - 保留 `environments` 与 `agents` 的 props 结构，但用 `Card`、`PanelHeader`、`Badge`、`EmptyState` 重写 JSX；把空列表分支改成 `EmptyState`，把每个 environment 的根容器改成 `Card`。
  - 用 `props.agents.find()` 的本地 join 逻辑保持不变，仅把 `instanceStatus` 和实例列表状态文本接入统一 `Badge` tone 映射。
  - 原因: 当前环境列表已经承担列表页雏形，适合作为“surface + status + category badge”三类规范的试点。
- [x] 改造 capability 标签组件，复用统一 `Badge`
  - 位置: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/components/plugin-capability-badge.tsx:14-40`
  - 保留 `CAPABILITY_LABELS` 常量与 `enabledCapabilities` 过滤逻辑，把 `<span style={...}>` 改为复用 Task 2 的 `Badge kind="category"`，并把 capability tone 固定到 `plugin` 模块色。
  - 组件只负责 capability 文案筛选，不再关心任何颜色或圆角细节。
  - 原因: 能力标签是类别 badge，不应继续维护独立皮肤。
- [x] 扩展 dashboard 静态渲染测试，覆盖新壳层和状态分支
  - 测试文件: `/Users/liyuan/Work/mothership-beta/mothership/apps/web/src/__tests__/dashboard.test.tsx`
  - 测试场景:
    - 加载成功: 渲染 sidebar、summary card、environment 卡片和 capability badge
    - 错误态: 传入 `error` 后仍保留控制台框架，并显示统一错误面板
    - 加载态: 传入 `loading` 后渲染占位卡或 loading empty state，而不是空白页
  - 运行命令: `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/dashboard.test.tsx`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 dashboard 已接入 shell 与 pattern 组件
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'AppShell|Sidebar|PanelHeader|SummaryCard|EmptyState' src/pages/dashboard.tsx src/components/environment-list.tsx`
  - 预期: `dashboard.tsx` 和 `environment-list.tsx` 都引用了新组件
- [x] 检查旧内联样式已退出核心展示组件
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && ! rg -n 'style=\\{\\{' src/pages/dashboard.tsx src/components/environment-list.tsx src/components/plugin-capability-badge.tsx`
  - 预期: 无匹配结果，三个核心展示组件不再保留内联样式对象
- [x] 运行 dashboard 测试
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun test src/__tests__/dashboard.test.tsx`
  - 预期: dashboard 三态和 capability badge 测试全部通过
- [x] 运行前端构建
  - `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run build`
  - 预期: 生产构建成功，说明 CSS 入口与新组件依赖闭环正常

---

### Task 5: fenixaos-style-migration 验收

**前置条件:**
- 启动命令: `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && bun run dev`
- 测试数据准备: 无需额外造数，静态渲染测试直接使用 `src/__tests__/dashboard.test.tsx` 内嵌 fixture
- 其他环境准备: 在 `/Users/liyuan/Work/mothership-beta/mothership` 根目录执行命令，确保 workspace 依赖按现状可用

**端到端验证:**

1. 运行完整测试套件确保无回归
   - [x] `cd /Users/liyuan/Work/mothership-beta/mothership && bun test`
   - 预期: 全仓测试通过，至少包含 `apps/web/src/__tests__/dashboard.test.tsx`、`theme.test.ts`、`ui-primitives.test.tsx`、`shell-patterns.test.tsx`
   - 失败排查: 先检查 Task 1~4 各自的测试步骤

2. 运行 workspace 类型检查
   - [x] `cd /Users/liyuan/Work/mothership-beta/mothership && bun run typecheck`
   - 预期: `apps/web` 通过类型检查，无新增 props 或 tone 类型错误
   - 失败排查: 检查 Task 2 的 primitives 接口和 Task 4 的 `DashboardPageProps` 调整

3. 运行 workspace 构建
   - [x] `cd /Users/liyuan/Work/mothership-beta/mothership && bun run build`
   - 预期: `apps/web` 的 Vite 构建成功，输出新的静态资源
   - 失败排查: 检查 Task 1 的样式入口和 Task 4 的页面导入链

4. 验证视觉规范文档与代码 token 同步存在
   - [x] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'surface-0|surface-3|status\\.success|Dashboard / Overview|Environment / Runtime|Plugin / Capability' docs/ui-style-guide.md src/styles/theme.ts src/styles/theme.css`
   - 预期: 文档、TS token、CSS token 中都能找到相同语义分层和模块色定义
   - 失败排查: 检查 Task 1 的规范文档与 token 命名是否漂移

5. 验证 Dashboard 已成为 design system 消费页
   - [x] `cd /Users/liyuan/Work/mothership-beta/mothership/apps/web && rg -n 'AppShell|Sidebar|SummaryCard|EmptyState|Badge' src/pages/dashboard.tsx src/components/environment-list.tsx src/components/plugin-capability-badge.tsx`
   - 预期: Dashboard、环境列表和 capability badge 全部通过 shell/patterns/primitives 组合完成，不再依赖旧的本地 `SummaryCard` 或内联标签皮肤
   - 失败排查: 检查 Task 3 的 pattern 导出与 Task 4 的页面迁移是否完整
