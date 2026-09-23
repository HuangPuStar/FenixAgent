# 前端开发规范

> **版本**：v3.0.10 | **最后更新**：2026-09-23 | **维护者**：前端团队
>
> **最近变更**：
> - v3.0.10 (2026-09-23)：§9.4 硬编码用户可见文案的收口批次——该节登记的**五处现存命中全部改走各包字典**：`agent-config/AgentSitesCard.tsx`（6 处中文，另含兜底英文 `Unknown Site`；失败态同时由「比对中文前缀」改为 `missing-attribute` / `load-failed` 枚举，否则文案本地化后判定失效）、`knowledge/ChunkDetailSheet.tsx`（复用既有 `preview.loadError`，不新增同义键）、`task/TasksPanel.tsx`、`task/TaskForm.tsx`（3 处）、`ui-components/FileViewerPreview.tsx`（内置 `zhCNMessages` 与错误边界提示改由包内字典按当前语言取值，`locale` 不再固定 `zh-CN`；`messages` / `locale` 保留为覆盖端口）。`ui-components` 的 `html-plugin.ts`（插件直接操作 DOM、不在 React 树内）与 `preview-source.ts`（纯逻辑模块不得 import UI i18n，见 §9.3）两处**有意保留**的硬编码随之登记到该包 README「已知限制」第 12 / 13 条，`html-plugin.ts` 文件头原先「见 README」的悬空引用改为指向该条；同表三处「第 N 条」交叉引用（`message.tsx`、`FileViewerPreview.tsx` 两处）原本整体 +1 错位，一并订正。§9.4 与 §11.3 的包内 i18n 测试计数 13 → **14** 就地重测（`plugin-market-i18n.test.ts` 随插件市场模块入库；`ui-components` 的字典守卫名为 `i18n-barrel.test.ts`，不在该 glob 内，§11.3 一并写明）。
> - v3.0.9 (2026-09-23)：目录索引统一批次（`f73f9265` 把 `components/agent-catalog-index` 的视觉默认值全部下沉到组件 CSS，五页目录改成同一套）后的文档对账。§4.1 该原语的一条按用户裁定重写并**作废**旧口径「共享结构、字号 / 内边距 / 行高 / 圆角 / 选中配色留各页刻度」——现在默认值全在共享组件、五页渲染同一组计算值、页面覆盖归零（各页 30 余条目录规则随之下沉删除），页面只保留独有语义（知识库行尾删除按钮的外壳与不可用态、组织页角色三态图标着色，以及知识库 ≤760px 隐藏与组织页 ≤900px 横置两处布局行为），并写明不再留各页刻度的原因。§10.1 的两行计数就地重测并把测量点从 `5626bb1a` 推到 **`f73f9265`**：资源侧页面级 2636 → **2416** 行（12 份不变；`agent-knowledge.css` 331→268、`agent-models.css` 330→278、`agent-mcp.css` 132→34、`agent-skills.css` 83→76），宿主页面级 5 份 / 1811 行不变，类别 ③ 伴随表 3792 → **3857** 行（68 份不变，64 份配 `.tsx` + 4 份配 `.ts`；两处变化是 `agent-catalog-index.css` 199→299 与 `agent-organizations-workspace.css` 92→57），token 入口 781 + 272 行、第三方覆盖表 43 行、chat 模块表 3 份 / 148 行均按同一命令复核无变化。
> - v3.0.8 (2026-09-23)：目录栏收敛批次（「左侧目录 + 右侧内容」面板的目录栏收成一套共享构件集，并删掉 `components/WorkbenchPanel`）后的文档对账。§4.1 补登本批下沉的 `components/agent-catalog-index`（技能库 / MCP / 模型库 / 知识库 / 组织管理五页改用），并记 `components/agent-master-detail-workspace` **不在**该小节的「去重批次」口径内——它早于该批次（2026-09-20 的 `e8c73280` 前置落地），本批只是把记忆页从已删除的 `components/WorkbenchPanel` 切到它。子路径数与 barrel 行数改为实测值（156→**158** 条 `exports` 子路径、160→**161** 行 barrel；本批删 `./components/WorkbenchPanel`、增 `./components/agent-catalog-index`，条数净 0）。§10.1 的两行计数就地写明口径并重测（宿主页面级 5 份 / 1811 行、资源侧 12 份 / 2636 行；类别 ③ 伴随表 68 份 / 3792 行；token 入口 781 + 272 行），该节附带可原样复跑的统计命令——v3.0.5 / v3.0.7 变更行里的「页面级 9 → 8 个 / 2496 → 1983 行」与「伴随表 66 → 67 份 / 3348 → 3391 行」都是在前一次记下的数字上做加减得来的（起点 66 是提交信息里的新增文件数，行数没有实测支撑），与实测不符，已随之作废。
> - v3.0.7 (2026-09-23)：组织管理页（`packages/platform/identity/.../agent-organizations.css`，513 行）整片转换为 Tailwind 工具类并删除该表——页面级样式表再少一张；唯一无法用工具类表达的部分（≤900px 断点组：非标准断点 + 必须压过库内未分层的列定义）下沉为同目录同名的伴随表 `agent-organizations-workspace.css`（43 行，类别 ③）。§10.1 计数按此同步：资源侧页面级 9 → **8** 个 / 2496 → **1983** 行，类别 ③ 伴随表 66 → **67** 份 / 3348 → **3391** 行。字号档位映射（含 13px 根字号下的实测偏差）见 `agent-organizations-workspace.tsx` 文件头注释。
> - v3.0.6 (2026-09-23)：§2.5 删去「极简（无 `Suspense`）」这一壳形态（原例 `_panel/agents.tsx`），改为「不许有无 `Suspense` 的极简壳」并说明原因：缺边界的懒加载会冒泡到 `_panel.tsx` 为壳自身备的整屏 `Spinner variant="screen"`，把整个 WebShell 卸载重建（用户视为「整页刷新」）。`_panel/agents.tsx` 同批补上 `Suspense` + `PanelRouteFallback`，接线形态回到「标准」。
> - v3.0.5 (2026-09-23)：Web 样式禁止行为门禁（`bun run check:web-style`）接入后，§10 新增**类别 ③「深层样式伴随表」**——与源文件同目录同名的 `.css`，承载无法用扁平工具类表达的选择器嵌套／复合表达式值／无标准变体的媒体查询，并给出三条约束（严格同名同目录、优先沿用源选择器名、不包 `@layer` 且逐处确认胜负关系）；「新增 `.css` 的落位」由「只用前两种」放宽为「只用前三类」。§10.1 的页面级 `.css` 计数按实测口径重写（资源侧 14 → **9** 个 / 3370 → **2496** 行；token 入口与新增伴随表同步实测）。规则口径与存量清理过程见 `forbidden-code-patterns.md`。
> - v3.0.4 (2026-09-22)：前端去重批次（约 65 个 commit）后的文档对账。§4.1 补登本轮新下沉的原语（`config/AdminKeyGate`、`config/LabeledField`、`ui/status-dot`、`components/ClosableTabPill`、`lib/clipboard`、`lib/format`、`chat/view/PublicErrorCard`、`chat/panels/chat-interaction-region`、`chat/timeline/tool-json-block`），并把「空态 / 失败 / 无权限刻意共用一个骨架」与「无权限不给重试、失败给重试」写进该节的口径——**不要新建第二个空态/失败组件**；子路径数与 barrel 行数改为实测值（145→**156** 条 `exports` 子路径、151→**160** 行 barrel）。§4.8 新增「刻意分叉 / 刻意不进库」四条冻结项（三种节点配置容器、cytoscape 与自绘 canvas 两套图谱、红描边危险按钮、形态未定型包内共享件）。`MasterKeyGate` 全量订正为 `@fenix/ui-components/config/AdminKeyGate` + `@fenix/web-runtime/hooks/use-admin-key-gate`（§2.3、§6.3 与 `docs/arch/21-observability-observer-service.md`）。§5.6 / §5.9 删去已随 `ac642962` 删除的 `workflow/web/api/workflows.ts`，§4.8 的文件规模快照（16→**17** 个超 500 行、400–499 区间 27→**25**）与 §10.1 的页面级 `.css` 计数按实测口径重写。
> - v3.0.3 (2026-09-22)：§2.5 的加载壳口径改写——原「三种壳形态都合规」**作废**（它把逐字复制的圆环类名固化成规范），路由 `Suspense` fallback 与整块加载提示一律改用 `Spinner`（`@fenix/ui-components/ui/spinner`），并补 `variant` / `size` / `label` 的选择口径；§2.7 登记存量未迁移位置。
> - v3.0.2 (2026-09-22)：把「失败必须有用户可见反馈」从隐含口径写成**可 review 的规则**（§5.8 新增：三条件判据 + 三类必然豁免 + `/login`、`/admin` 下无 `Toaster` 的坑）。据此做了一轮全量处理：4 处原生 `confirm()` 全部迁 `ConfirmDialog`（删除 §6.5 对应偏离项），逐点复核全仓 `console.error` 并补齐缺失反馈，未动的残留登记到 §5.9。§11.2 补「`react-i18next` 替身必须返回稳定 `t`」——该替身缺陷会让测试陷入反复拉取且生产不复现。
> - v3.0.1 (2026-09-22)：精简第 1 章与第 10 章——原 §1.1 应用根 / §1.2 宿主源码目录 / §1.3 包边界与引用纪律，以及原 §10.1～§10.5，改写为几段说明与规则列表，只保留可据以 review 的硬规则；§1 子节重编号为 §1.1 装配产物与构建、§1.2 路径别名纪律、§1.3 现状偏离。同步移除 `packages/supaflow/web` 与 `e2e/` 的排除项（两者已从仓库移除），并补充"新增 `.css` 的落位"与"禁止 `@apply`"两条纪律。
> - v3.0.0 (2026-09-22)：按 CE/EE 1.6 / 1.7 收口后的**代码事实**全面重写。删除全部 target / transitional 标记与 `docs/need-to-change/*` 引用（该目录已删除），规范只描述**当前不变量**；每章新增「现状偏离」记录规则尚未落地的已知位置；新增适用范围声明（§0.1）、装配产物（§1.1）、侧栏装配（§2.6）、iframe 沙箱（§6.2）、实时通道登记（§8.1）、CSS 文件边界（§10）。
> - v2.0.0 (2026-09-22)：按 CE/EE 任务 1.6 T11e 收口后的架构校订。
> - v1.0.0 (2026-06-30)：初始版本。

本文档面向 FenixAgent 主控制台前端开发，约束目录组织、包边界、路由与导航、状态管理、组件规范、API 调用、安全规范、错误边界、实时通信、i18n 国际化和样式体系。规则冲突时以本文档、`CLAUDE.md` 与 `CONTRIBUTING.md` 为准；三者不一致时以本文档为准，并同批修正另外两处。

## 0. 使用约定

### 0.1 适用范围

**覆盖**：`apps/web/**`（宿主应用）与 `packages/**/web/**`（各 owner 包的 web 面）。

**不在管辖内**——读者 grep 到这些目录里的写法时，不要当成本规范的反例，也不要照抄：

| 目录 | 是什么 | 为什么排除 |
|------|--------|-----------|
| `ui-sandbox/` | 独立 Vite 设计沙盘（端口 5174，Hash 路由，全 Mock），自带 `bun.lock`，**不在 bun workspace 内** | 设计稿验证环境，不是产品代码，不参与 `precheck` |
| `packages/**/src/server/**`、`packages/chat-channel/src/server.ts` | 服务端能力 | 由后端规范约束（见 `backend-development.md`） |

### 0.2 规则与现状

本文档只写**当前规则**——即代码已按此实现、可以据以 review 的不变量。每章末尾的 **「现状偏离」** 只做一件事：记录该章规则**尚未落地**的已知位置，让读者能区分「规则要求什么」与「现在做到哪」。

**偏离不是许可**。不要因为某处已经违规就照抄它的写法；新代码按规则写。

> 历史上本文档用 `current` / `target` / `transitional` 三态标记配合 `docs/need-to-change/<n>` 编号跟踪在途项。该目录已于 2026-09-22 删除，三态标记与编号引用一并移除；未落地事项改为在对应章节按**具体文件位置**登记。
>
> 偏离清单是**快照**，不是持久账本：修复后请顺手删掉对应条目，不要让它变成"历史记录"。

## 1. 目录结构与包边界

`apps/web` 是本版本**唯一的前端构建入口**（React 19 + Vite + TanStack Router，挂在 `/ctrl`），只提供应用壳——路由、Provider、侧栏装配与宿主专有页面；业务能力按**资源归属**分布在 `packages/**`，各包经 `package.json` 的 `exports` 暴露 web 面。宿主 `apps/web/src/` 的分工：`routes/` 路由壳 · `pages/` 宿主专有页面 · `shell/` 应用壳与侧栏装配 · `api/` 宿主专有域 · `components/` · `hooks/` · `lib/` · `i18n/` 装配 · `types/` · `__tests__/`。UI 原语、请求基建、组织会话契约、资源域 API / 页面 / 字典、共享域类型一律由包提供，宿主不留副本。

`apps/web/` 的入口约定：`index.html` 是 Vite 唯一 HTML input（挂 `src/main.tsx`）；`main.tsx` 是唯一启动入口（装 polyfill → `loadAppBrand()` → `createRouter({ routeTree, basepath: "/ctrl" })`）；`src/index.css` 是 Tailwind v4 入口（token 与 `@source` 扫描范围，见 §10）；`fenix.module.ts` 是 `kind: "web-shell"` 的装配描述符，**只允许 `import type`**；`src/routeTree.gen.ts` 是**入库的生成产物，严禁手改**；`src/App.tsx` **不是 React 组件**，只导出 `parseConfigView(pathname)` 纯函数。

**路径前缀三处必须一致**：`vite.config.ts` 的 `base: "/ctrl/"`、`main.tsx` 的 `basepath: "/ctrl"`、服务端 `staticPlugin` 的 `prefix: "/ctrl"`。

三条硬规则：

- **引用一律经对方 `exports`**：禁止深引 `@fenix/<pkg>/src/*` 或 `@fenix/<pkg>/web/src/*`（`package-no-internal-imports` 阻断，见 §11.2）。`web/src/**` 是包内实现路径、不是域模块出口——它当前存在于 `sandbox` / `agent-config` / `model-management` / `knowledge` / `machine` 五个包（历史差异），新增包一律用 `web/api/`。
- **组件源码必须落在 `<pkg>/web/` 下**：宿主 Tailwind 的 `@source` 只扫 `packages/**/web/**`，放到 `packages/<pkg>/components/` 的组件其工具类会被**静默裁剪**（§10）。同一个理由让 `web/` 成为浏览器安全边界的判据目录（§11.2）。
- **导出面按包外真实消费点收敛**：未出现第二个消费者前不导出（内部视图的 props 形状不是对外契约）；确需跨包少量复用时才单开窄口，并在 `exports` 显式声明。

**归属按资源落位**：接口对应哪张表、哪个 owner，域模块就放在那个包。宿主 `apps/web/src/api/` 只收**无资源包归属**的宿主专有域——`branding` / `fs` / `instances` / `peri-task-details` / `helpers`（后者是 UUID 工具，不含 HTTP）。

**包的 `./web` 出口形状不统一**，改包前先看它的 `exports`：

- 标准三件套 `./web` + `./web/contribution` + `./web/i18n`：`resources/*` 的 8 个包（agent-config / knowledge / mcp / memory / model-management / skill / task / workflow）与 `platform/identity`，合计 9 个，与 `ce.json` 的 `web` 列表等长。
- 只有 `./web`、无 contribution：`machine` / `observer` / `prod-view` / `sandbox` / `channel`——有 web 面但不在 CE 的 web profile 里。
- 不走 `web` 前缀：`ui-components`（根 barrel + 158 条 `exports` 子路径，按需深链优先）、`web-runtime`（`./api/request`、`./contexts/org-session`、`./types/config`…）、`agent-runtime`（web 面仅 `./web/api/environments` 一条窄口，浏览器不得依赖其反向 `export *` 的服务端根入口）、`chat-channel`（无 web 面，根入口必须浏览器安全，见 §8.6）。

### 1.1 装配产物与构建

| 环节 | 事实 |
|------|------|
| 路由树 | `apps/web/vite.config.ts` 的 `TanStackRouterVite` 插件在 dev/build 时生成 `src/routeTree.gen.ts`；**没有独立生成脚本**，改路由后必须跑一次 `bun run dev:web` 或 `build:web` 才会重生 |
| 导航装配 | `scripts/generate-web-contributions.ts` 读 `deploy/assembly/ce.json` 的 `web` 列表，产出 `apps/generated/web-contributions.ts`；`bun run generate:web-contributions --check` 进 CI |
| 模块注册 | `scripts/generate-module-registry.ts` 产出 `apps/generated/module-registry.ts`，由服务端 bootstrap 消费 |
| 产物保管 | `apps/generated/` **入库**，`biome.json` 排除格式化。它是浏览器 bundle 的**静态依赖**（`shell-navigation.ts` 直接 import），所以换部署 profile 必须重跑 `build:web`——产物本身入库是为了让构建可复现与可 diff，不是让 profile 免于重构建 |
| 构建命令 | `bun run build:web` = `vite build --config apps/web/vite.config.ts`；生产开 `sourcemap: true` |
| 静态挂载 | `apps/server/src/plugins/static.ts` 从 `apps/web/dist/` 挂载；SPA fallback 依赖 `onError({ as: "global" })` + 显式 `set.status = 200` + 注册在 `errorPlugin` 之前，改这块前先读该文件注释 |
| chunk 分组 | `manualChunks` 分 10 组（shiki / mermaid / motion / vendor / ai-sdk / qr / radix-ui / tanstack-router / tanstack / hookform），改名或合并会影响缓存与首屏 |
| 部署变量 | 打包部署必须设 `RCS_APPLICATION_ROOT`（未设时回落到源码根），Docker build 阶段还必须 `COPY apps/generated` |

### 1.2 路径别名纪律

别名只保留**宿主自有**目标（指向 `apps/web/src/**` 与 `apps/server/src/**`）。**禁止新增指向 `packages/**` 的别名**——跨包引用一律经各包 `exports`。

仓库里共有三张 `paths` / `alias` 表，改动前必须分清哪张对谁生效：`apps/web/vite.config.ts` 的 `resolve.alias`（构建期解析，8 条前缀式键）、根 `tsconfig.json` 的 `paths`（前端类型检查 + **dependency-cruiser 的判定基准**，8 条 `*` 模式键）、`tsconfig.base.json` 的 `paths`（服务端与包，12 条 `@fenix/*` → `packages/**/src/**`）。**`apps/web` 看不到第三张表的条目**——`tsconfig` 的 `paths` 是整体替换而非合并，已用 `tsc -p apps/web/tsconfig.json --showConfig` 验证。

纪律：

- vite 表与根 `paths` 表**必须逐条对应**。键写法不同（前缀 vs `*` 模式）无法机械对账，删改时必须同批改两张表；只改一张会产生最难查的一类问题——门禁能解析、生产构建解析不到。
- `@/src/i18n/locales` 必须排在 `@/src/i18n` 之前（vite 按声明顺序取首个匹配），否则字典目录会被 i18n 单例吃掉。
- 包内自建别名表（`acp-link` / `agent-runtime` / `chat-channel` / `agent-config` / `ui-components`（tsconfig 与 vite 两张）/ `web-runtime`，共 6 个包）只服务包自身，不要指望宿主别名在包内生效。

### 1.3 现状偏离

- **`apps/web/src/api/helpers.ts` 零生产消费方**（仅别名声明与测试引用），是事实死代码。
- **浏览器安全入口守卫未覆盖全部带 web 面的包**：13 份 `web/__tests__/*-browser-surface.test.ts` 全在 `packages/resources/*`；`platform/identity` 有完整 `./web` 面但无守卫，`ui-components` / `web-runtime` / `agent-runtime` 的 web 面同样无守卫（当前只作为别人导入图里的共享基础设施被间接断言）。
- **`apps/web/src/types/index.ts` 仍持有 channel 域类型**（`ChannelProviderInfo` / `ChannelInfo` / `ChannelBinding` 等），而 channel 已有 `@fenix/resource-channel/web`；归属待裁定。

## 2. 路由与导航

使用 TanStack Router（file-based routing）：`@tanstack/react-router` ^1.170、`@tanstack/router-plugin` ^1.168。`apps/web/src/routes/` 下的文件由 Vite 插件映射为 URL，产物 `src/routeTree.gen.ts` **入库且严禁手改**（`biome.json` 已排除其格式化）。应用挂在 `/ctrl` 前缀下（`main.tsx` 的 `basepath` 与 `vite.config.ts` 的 `base` 必须同时改）。

### 2.1 文件命名约定

| 语法 | 含义 | 真实示例 |
|------|------|----------|
| `_panel` | pathless 布局片段（不贡献 URL 段） | `agent/_panel.tsx` → `/agent`，`_panel/` 下 23 个路由文件共享它 |
| `$param` | 动态路径参数 | `_panel/chat.$agentId.tsx` → `/agent/chat/$agentId` |
| `_` 后缀（动态段） | 分隔相邻动态参数 | `chat.$agentId_.$sessionId.tsx` → `chat/$agentId/$sessionId` |
| `_` 后缀（静态段） | 阻止后续段成为前一段的子路由 | `workflow_.$id.edit.tsx` → `/agent/workflow/$id/edit`（否则 `$id` 会挂到 `workflow.tsx` 下） |

**`_panel` 的边界要记清**：它只管 `/agent/<面板页>` 与 `/agent/chat/*`。`/agent/$agentId` 与 `/agent/$agentId/$sessionId` 是 **rootRoute 的兄弟**，不受 `_panel` 布局包裹——它们只有 `beforeLoad` + `throw redirect` 的兼容旧 URL 重定向桩，**不声明 `component`**（redirect 在渲染前抛出，桩永远不渲染任何东西）。

### 2.2 路由参数

```tsx
const { agentId } = Route.useParams();              // 路由壳内
const search = useSearch({ strict: false }) as { runId?: string };  // 宿主未声明 validateSearch，必须断言
```

包内页面需要读宿主动态段时，用带 `from` 的形式——此时**宿主的 route id 成为跨包契约**，改宿主路由必须同步搜跨包引用：

```tsx
// packages/resources/prod-view/web/pages/prod-view/ProdViewPage.tsx
const { prodViewId } = useParams({ from: "/view/$prodViewId" }) as { prodViewId: string };
```

`useSearch({ strict: false })` 的断言**不做运行时校验**：新增查询参数时要自己兜底默认值。

### 2.3 鉴权与重定向

**全局守卫只有一处**，在 `apps/web/src/routes/__root.tsx`，用 `useEffect` + `navigate` 实现（不是 `beforeLoad`）：

- 会话未就绪 → 渲染 spinner；未登录且非 `/login` 非 `/admin` → 渲染 `null` 并跳 `/login`；已登录访问 `/login` → 跳 `/agent`。
- `/admin` **豁免 better-auth 会话**，由页面内 `AdminKeyGate`（`@fenix/ui-components/config/AdminKeyGate` 配 `@fenix/web-runtime/hooks/use-admin-key-gate`）把关（见 §6.3）。

**路由壳内**的重定向一律用 `beforeLoad` + `throw redirect`：

```tsx
// apps/web/src/routes/agent/_panel/index.tsx
export const Route = createFileRoute("/agent/_panel/")({
  beforeLoad: () => { throw redirect({ to: "/agent/home" }); },
});
```

### 2.4 导航

```tsx
import { useNavigate, Link } from "@tanstack/react-router";

const navigate = useNavigate();
void navigate({ to: "/agent/home" });
void navigate({ to: "/agent/chat/$agentId", params: { agentId } });
void navigate({ to: "/agent/workflow/$id/edit", params: { id }, search: { runId } });

<Link to="/agent/home">Home</Link>
```

**禁止** `window.location.href` / `window.location.replace` / `window.location.reload` / `window.history.pushState`。`window.location` 只允许**读取**（`pathname` / `search` / `host` / `protocol` / `origin`），当前合规用法集中在拼 WebSocket URL 与分享链接。

### 2.5 懒加载与路由壳

路由壳只做懒加载与边界，页面实现放 owner 包：

```tsx
// apps/web/src/routes/agent/_panel/models.tsx
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { createFileRoute } from "@tanstack/react-router";
import { lazy, Suspense } from "react";

const Page = lazy(() => import("@fenix/model-management/web").then((m) => ({ default: m.AgentModelsPage })));

export const Route = createFileRoute("/agent/_panel/models")({
  component: () => (
    <Suspense fallback={<Spinner variant="panel" />}>
      <Page />
    </Suspense>
  ),
});
```

**加载提示一律用 `Spinner`**：路由 `Suspense` fallback 与页面内整块加载提示都走它，**不要手写圆环类名**。组件在 `@fenix/ui-components/ui/spinner`（深链优先，也可从包根 barrel 取），属 §4.1 的 `ui/*` 基础原语，不是业务组件。

`variant` 决定容器形态，三选一，**不要用 `className` 复刻**：

| `variant` | 容器 | 用在哪 |
|-----------|------|--------|
| `panel` | `flex flex-1`，撑满父级剩余空间 | 路由 `Suspense` fallback、`_panel/*` 内容区、tab 内容区 |
| `screen` | `flex h-screen` | 整屏等待：`__root.tsx` 的会话加载分支、全屏路由壳 |
| `inline`（组件默认） | `inline-flex`，跟随内容流 | 按钮内联、卡片/表单局部；**外边距由调用方 `className` 给** |

`size` 四档：`xs` 14px（按钮内联）· `sm` 24px（小面板、标签页内容区）· `md` 32px（默认，面板级内容区）· `lg` 40px（整屏等待）。环径只在这四档里选，不要在 `className` 里另写 `size-*` / `h-* w-*`。

环色跟随容器文字色（组件兜底 `text-brand`，即默认就是品牌色）：**落在填充按钮之类的有色底上时传 `className="text-current"`** 跟随该处前景色——不要去调用点重写环的 `border-*` 类名。

**`label` 的有无同时决定读屏行为**（三者互斥，按场景选一）：

- **有可见文案** → 传 `label`，组件渲染在环下方并自带 `role="status"`；不要再自己包一层 `<p role="status">`。
- **只有读屏文案** → `label={<span className="sr-only">{t("loading")}</span>}`。
- **纯装饰的转圈**（旁边已有可见文案）→ **不传** `label`；整块对读屏隐藏（`aria-hidden`），念一个空的加载区只是噪音。

```tsx
// 整屏等待（apps/web/src/routes/__root.tsx 的会话加载分支）：有可见文案
// t 来自 useTranslation("common")，"connecting" = 正在连接控制面板…
<Spinner variant="screen" size="lg" label={t("connecting")} />

// 面板 fallback：只有读屏文案
<Spinner variant="panel" label={<span className="sr-only">{t("loading")}</span>} />
```

> **原「三种壳形态都合规」的判断作废**。它把「加载提示长什么样」也划成自由项：三种写法并列合规、示例直接给出那串圆环类名，于是**复制粘贴被写成了规范**——同一段类名散到 21 个路由壳与多张业务页面，尺寸、容器、文案各写各的（`admin/{logs,people,sandbox}.tsx` 只剩一行文字、连指示器都没有；`workflow_.$id.edit.tsx` 把 lucide `Loader` 图标按圆环类名渲染，与环形边框叠成双圈）。加载提示不再有第二个写法。**壳的接线形态只有下面两种**——那是结构选择，与加载提示无关：

| 形态 | 例子 | 说明 |
|------|------|------|
| 标准 | 多数 `_panel/*.tsx` | 单懒组件 + `Suspense` |
| **组合根端口注入** | `_panel/organizations.tsx` | `Promise.all([import("@fenix/identity/web"), import("@fenix/resource-machine/web")])`，把 `machine.registryApi` 作为端口传给页面。跨包装配是壳的职责 |

> **不许有「无 `Suspense` 的极简壳」**（v3.0.3 曾把 `_panel/agents.tsx` 列为合规的第三种形态，已作废）：懒加载挂起时若本壳没有边界，React 会一路冒泡到最近的上层边界——`_panel.tsx` 为壳自身代码块准备的**整屏** `Spinner variant="screen"`。后果是整个 WebShell（侧栏、聊天保活）被卸载重建，用户看到的是「切换进这个页面时整页刷新一次」。页面内的 `loading` 只覆盖**取数**，接不住**代码块加载**，因此「页面自身已处理加载态」不构成省掉边界的理由。边界与壳一一对应，每个 `lazy` 壳都必须自带。

**壳里可以有接线，但不做取数**：tab 状态、创建回调、端口注入属壳；数据获取必须在页面或域模块内完成（`workflow.tsx`、`workflow_.$id.versions.tsx`、`view/$prodViewId.tsx` 是当前较重的壳，改动前先看它们的接线方式）。

**禁止**用相对路径穿透到包内文件（如 `import("../../../pages/agent-panel/pages/X")`）——那是包内实现，须经包 `exports` 进入。

### 2.6 侧栏装配

导航项由**各资源包**声明，Shell 只做装配与渲染。契约 `WebNavigationItem` 定义在 `@fenix/web-runtime/shell/contribution`：

| 字段 | 类型 | 语义 |
|------|------|------|
| `id` | `string` | 唯一标识，**同时是路由目标**（Shell 组装为 `/agent/<id>`）与运行时裁剪键 |
| `groupId` | `string` | 所属分组；分组定义与组间顺序归 Shell |
| `order` | `number` | 组内排序键，**组内必须唯一**；约定 10 步长递增 |
| `labelKey` | `string` | 文案 key，owner 是贡献方本包 |
| `ns` | `string` | `labelKey` 所属命名空间 |
| `icon` | `LucideIcon` | 组件随项贡献 |

一份完整声明（`packages/resources/skill/web/contribution.ts`）：

```ts
import type { WebAppContribution } from "@fenix/web-runtime/shell/contribution";
import { Settings } from "lucide-react";
import { SKILL_NS } from "./i18n/namespace";

export const webContribution: WebAppContribution = {
  navigation: [{ id: "skills", groupId: "config", order: 30, ns: SKILL_NS, labelKey: "nav.skills", icon: Settings }],
};
```

**装配链**（改任一段前先走一遍这条链）：

```
deploy/assembly/ce.json 的 web 列表（9 个包）
  → bun run generate:web-contributions
    → apps/generated/web-contributions.ts
      → apps/web/src/shell/shell-navigation.ts 的 assembleNavGroups()
        → use-shell-navigation.ts（翻译 + 按 hiddenTabs 裁剪）
          → ShellNavigation.tsx → AgentSidebar.tsx
```

- **分组与组间顺序由 Shell 持有**（`shell-navigation.ts` 的 `SHELL_NAV_GROUPS`），资源包只声明自己属于哪一组、组内排第几。
- **装配期直接抛错**：未知 `groupId`、同组内 `order` 重复。不会静默丢项——加分组必须同时改 `SHELL_NAV_GROUPS` 与宿主 `sidebar` 字典的 `navGroup*`。
- **`hiddenTabs`**：来自 `GET /web/sidebar-config`，服务端值源是 `APP_HIDDEN_SIDEBAR_TABS`（逗号分隔，刻意不校验 id 是否已知）。前端**只删项**，不改序、不改分组；取不到时按"无隐藏项"处理。
- **`activeNav` 由 pathname 手算**（`DefaultAppShell.tsx`）：`/agent/home` 取 `home`，chat 路径取 `null`，其余取路径首段。新增页面时若不高亮，先核对这里的推导。

**新增一个控制台页面的完整步骤**：

1. 页面实现落 `packages/<pkg>/web/pages/`，从包根 `web/index.ts` 导出。
2. 包字典补 `nav.<id>`：`packages/<pkg>/web/i18n/locales/{en,zh}/<ns>.json`。
3. 包内 `web/contribution.ts` 的 `navigation` 加一项（`order` 用 10 步长、组内唯一）。
4. 宿主建路由壳 `apps/web/src/routes/agent/_panel/<id>.tsx`（`id` 必须与路由文件同名，否则点进去 404）。
5. `bun run generate:web-contributions`，然后跑门禁。

新增**新包**时还要：`packages/<pkg>/fenix.module.ts` 补 `web.contribution` 说明符 → `package.json` 补 `./web`、`./web/contribution`、`./web/i18n` → `deploy/assembly/ce.json` 的 `web` 数组加模块 id → `bun run generate:module-registry` → `apps/web/src/i18n/index.ts` 登记该包 NS 与 resources（见 §9.2）。

### 2.7 现状偏离

- **`/admin` 有第二张硬编码导航表**（`apps/web/src/routes/admin.tsx` 的 `NAV_ITEMS`），完全绕过 contribution 装配。它是有意保留（观察面板独立于会话体系）还是待收敛，尚无裁定；新增 `/admin` 页面时按现有形态加项。
- **导航 `id` 与路由文件之间没有一致性检查**：`shell-navigation.test.ts` 只断言与迁移前快照一致、装配失败条件与裁剪语义。`id` 打错成不存在的路由，装配照样通过、点击后 404。
- **`router.invalidate()` 全仓零使用**。`CLAUDE.md` 把它列为允许的导航手段，但没有任何真实范例——不要把它当成既有做法照写。
- **`CLAUDE.md` 的「Sidebar 导航项必须提供 `to`」与实现不符**：`ShellNavigation.tsx` 用 `<button onClick={onNavigate(item.id)}>`，路由目标由 `id` 拼装，没有 `to`。以本文档为准，`CLAUDE.md` 待同步。
- **三个页面有路由但无导航项**（`_panel/dashboard.tsx`、`channels.tsx`、`views.tsx`），只能靠输入 URL 到达。是刻意保留深链入口还是迁移遗漏，无记录。
- **`DefaultAppShell.tsx` 用 `navigate({ to: \`/agent/${pageId}\` as never })`** 绕过 TanStack 类型检查，是反面样例，不要照抄。
- **按钮 / 行内的「图标转圈」尚未收敛**：`Spinner` 管的是**独立成块的环形指示**，而 `Loader2` / `LoaderCircle` / `Loader` + `animate-spin` 这类**图标转圈**（约 25 处，如 `ui-components/web/chat/shell/ChatHeader.tsx`、`ui-components/web/chat/timeline/SubAgentPanel.tsx`、`resources/agent-config/web/components/agent-panel/MountSiteDialog.tsx`）是另一种视觉形态，两者是否合并尚无裁定；存量尺寸（`h-4 w-4` / `size-3.5` / `h-[18px] w-[18px]`）与间距（`mr-2`）也各写各的。当前口径：**按钮内联**的加载提示优先用 `Spinner size="xs"`（环，落在填充底上传 `className="text-current"` 跟随前景色）；若沿用图标转圈，在 `Button` 内不要再写 `h-* w-*`——`Button` 的 `[&_svg:not([class*='size-'])]:size-4` 会统一成 16px，写了反而与其它按钮图标不一致。收敛完成前不要新增第二套写法。

## 3. 状态管理

使用 **React Context + `useState`/`useCallback`**，不引入 Zustand / Jotai / Redux / TanStack Query（当前零依赖，`bun.lock` 里出现的同类包均为传递依赖）。数据获取统一走 ahooks `useRequest`（见 §3.4）。

### 3.1 Provider 装配

装配在 `apps/web/src/routes/__root.tsx`，**是四分支条件树，不是一条线形链**：

| 分支 | 渲染 |
|------|------|
| 会话加载中 | `<ThemeProvider>` + spinner |
| 未登录、非 `/login` 非 `/admin` | `null`（靠 §2.3 的 effect 跳转） |
| 未登录、`/login` 或 `/admin` | `<ThemeProvider><Outlet /></ThemeProvider>`——**无 OrgProvider、无 Toaster** |
| 已登录 | `<ThemeProvider><OrgProvider><Outlet /><Toaster richColors closeButton position="top-right" /></OrgProvider></ThemeProvider>` |

两个后果必须记住：**在 `/login` 与 `/admin` 下调用 `useOrgSession()` 会抛错**；这两条路径上 `toast` 无处落地。

**不是 Provider 的两个全局能力**（不要给它们补 Provider）：

- i18n 走 `initReactI18next` 单例（`apps/web/src/i18n/index.ts`），无 `I18nextProvider`。
- 主题走 `@fenix/ui-components/lib/theme` 的 `ThemeProvider`。

### 3.2 主题（全局强制亮色）

**本程序只有亮色一种外观**：不读 `localStorage`、不监听 `prefers-color-scheme`、也没有任何主题切换入口。系统/浏览器处于深色偏好时同样渲染亮色。

实现只有一份：`packages/ui-components/web/lib/theme.tsx`，导出 `ThemeProvider` / `useTheme()`；`useTheme` 在 Provider 外抛错，不静默回落。Provider 现在的职责是给需要布尔判定的消费方（canvas / SVG 渲染器，如 `memory/hindsight/components/`）提供恒为 `"light"` 的 `resolvedTheme`，并在挂载时清掉 `documentElement` 上残留的 `dark` 类（兜「上一版本写过」与「扩展脚本塞类」两类外部来源）。它**不再有参数**，宿主 `apps/web/src/routes/__root.tsx` 的三处挂载点与 demo 都直接写 `<ThemeProvider>`。

深色要能生效必须同时满足三件事，而第一件在当前没有任何生产者：

1. 某段代码给 `<html>` 或某个祖先加上 `.dark` 类——当前仓库无任何此类代码；
2. `apps/web/src/index.css` 的 `.dark` token 块随之生效（该块及其派生规则，如 `shell/agent-panel.css` 的 `:root.dark`，都保留着；在无法触发的前提下属死代码而非风险）；
3. `color-scheme` 被固定为 `light`——由 `apps/web/index.html` 的 `<meta name="color-scheme" content="light">` 与 `index.css` 的 `:root { color-scheme: light }` 两处共同保证：后者覆盖样式表生效之后的常规取值，前者覆盖「样式表生效之前」的窗口（缺了它，系统深色偏好下首帧会按深色画布绘制，即首屏闪深色）。

**不要在任何调用点补第二份主题实现。**

### 3.3 组织与会话上下文

**契约与实现分离**：

- **契约**在 `packages/web-runtime/web/contexts/org-session.tsx`，只声明资源包真正需要的粒度：`organizationId` / `userId` / `isOwner` / `pending`。全字段可空可假，**消费方必须自己处理未就绪态**。
- **实现**方是身份包的 `OrgProvider`（`@fenix/identity/web`）——取数、切换与请求头注入属于身份域，不下沉到 `web-runtime`。

契约放在中性的 `web-runtime` 的原因：资源包需要组织上下文判断资源归属，但依赖矩阵禁止 `resources` 依赖具体平台实现。因此 `OrgSessionContext` **只能有一个 `createContext` 站点**——出现第二份会让资源包永远读到 `null`，而现象只是"权限判定全体失效"，很难从界面反推。

Context 必须用守卫 hook 消灭 `undefined` 判断，且**不静默回落默认值**：

```tsx
export function useOrgSession(): OrgSession {
  const ctx = useContext(OrgSessionContext);
  if (!ctx) throw new Error("useOrgSession must be used within OrgSessionProvider（由身份的 OrgProvider 挂载）");
  return ctx;
}
```

**组织身份只有两种合法读法**：

| 读法 | 允许的消费方 |
|------|-------------|
| `useOrgSession()` | **资源包唯一允许**的读法（返回契约投影的 4 个字段） |
| `useOrg()`（身份包的富上下文） | 仅宿主 shell 与身份包自身；资源包不得依赖平台实现 |

**禁止绕过上下文读取组织身份**（`localStorage.getItem("active_org_id")`），也禁止自行拼 `?active_org_id=`。这类写法会制造"UI 显示 A、请求操作 B"的 split-brain。当前偏离见 §3.6。

**请求头注入由身份域持有**：`OrgContext.tsx` 通过 `installFetchInterceptor()` monkey-patch `window.fetch`，每次请求现场读取 `localStorage` 注入 `X-Active-Org-Id`；服务端解析优先级见 `CLAUDE.md`。域模块**不得**自己读组织 id 拼 URL 或头——那会绕过这套机制。

**切换组织的唯一入口**是身份包 `OrgContext.tsx` 的 `switchOrg`（`packages/platform/identity/web/contexts/OrgContext.tsx`）；宿主 `AgentSidebar` 只是调用方（关菜单后 `await switchOrg(orgId)`）。它的序列是：快照当前值 → 乐观更新 state → 写 `localStorage` → `await orgApi.setActive()` → `navigate({ to: "/agent/home", replace: true })`；失败时回滚 `localStorage` 与 state 并 `toast.error`。注意客户端可见快照在服务端确认前已变更，一致性依赖切换后的 replace 导航重建组件。

### 3.4 数据获取

统一用 ahooks **`useRequest`**；禁止手写 `useCallback` + `useEffect` + `setState` 组合管理数据获取。当前全仓 `from "ahooks"` 只导入 `useRequest` 一个 hook。

```tsx
import { useRequest } from "ahooks";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 查询：自动管理 loading / error / data 三态
const { data, loading, error, refresh } = useRequest(() => unwrap(taskV2Api.list()));

// 变更：manual 模式，手动触发
const { run: createTask, loading: creating } = useRequest(
  async (body: TaskV2CreateBody) => unwrap(taskV2Api.create(body)),
  {
    manual: true,
    onSuccess: () => {
      refresh();
      toast.success(t("toast.saved"));
    },
    onError: (err) => {
      console.error("创建任务失败", err);
      toast.error(err.message);
    },
  },
);
```

> **必须 `unwrap()` 或显式判断 `success`**：域模块返回 `ApiResponse`，`request()` 对 HTTP / 业务失败**返回 `{ success: false }` 而不 throw**，而 `useRequest` 的 `error` / `onError` 只理解 rejected Promise——直接 `await` 会把 4xx/5xx 当成成功，继续推进 loading/empty 状态。详见 §5.2。

**真实使用的配置项**（按出现频次；只列有真实范例的）：

| 配置 | 用途 | 范例 |
|------|------|------|
| `refreshDeps` | 依赖变化自动重查 | `WorkflowVersions.tsx`（`[workflowId]`）、`AgentTasksPage.tsx`（`[page, debouncedKeyword, typeFilter]`） |
| `ready` | 条件请求（前置数据未就绪时不发） | `FileTreeTab.tsx`、`ChatArea.tsx`、`MountSiteDialog.tsx` |
| `manual` | mutation / 手动触发 | `AgentTasksPage.tsx` 的 toggle、`WorkflowList.tsx` 的创建 |
| `pollingInterval` | 轮询 | `use-agent-sidebar-tree.ts`（15s）、`AdminObserverPage.tsx` |
| `loadingDelay` | 抑制骨架闪烁 | `use-agent-sidebar-tree.ts`（300ms） |
| `onSuccess` / `onError` | 反馈与刷新 | 普遍 |

**租户作用域轮询必须把组织 id 纳入 `refreshDeps` 并配 `ready`**（样板：`use-agent-sidebar-tree.ts` 的 `pollingInterval: 15_000, refreshDeps: [orgId], ready: !!orgId`）。不要用共享的 `intervalRef` 手写 `setInterval` 跨资源复用轮询。

**跨组件刷新**用 `@fenix/web-runtime/lib/config-events` 的事件总线（`dispatchConfigChange` / `useConfigChangeListener`）——这是当前主力机制，例如侧栏在配置变更后刷新。`useRequest` 的 `cacheKey` 全仓 1 处（`use-shell-navigation.ts` 的 `"sidebar-config"`）、`cancel()` 1 个文件（`AdminModelGatewayPage.tsx`，用于组件卸载时取消在途请求），`cache.mutate` / `debounceWait` / `retryCount` **当前没有任何使用范例**；需要时先确认 ahooks 行为并在 code review 中说明，不要凭文档想象它的语义。

**取消**：需要主动取消时用 `request()` 的 `signal` 选项传 `AbortSignal`（产品侧现有用法集中在文件读写、上传与文件树）。**不要依赖 `useRequest` 替你取消**——它的并发语义随版本变化，长轮询与"后发请求覆盖先发结果"的场景必须显式持有信号并在 cleanup 里 abort。

**Loading / Empty / Error 三态**：

```tsx
if (loading) return <Skeleton className="h-32 w-full" />;
if (error) {
  return (
    <EmptyState
      icon={<TriangleAlert />}
      title={t("loadState.failed", { message: error.message })}
      tone="danger"
      role="alert"
      action={{ label: t("common.retry"), onClick: refresh }}
    />
  );
}
if (!data?.length) return <EmptyState icon={<FolderOpen />} title={t("empty.title")} />;
```

**失败不得映射成 empty 或成功**——这是最容易通过 review 的静默缺陷。

### 3.5 Hooks 约定

- **落点跟随归属**：宿主 `apps/web/src/hooks/` 只放无域归属的 hook（当前仅 `use-task-views`，它是 Y.Doc 投影、不发请求）；有明确归属的 hook 放在它服务的目录旁（`shell/use-*.ts`、`pages/agent-panel/use-*.ts`、`components/agent-panel/use-*.ts`）。包内 hook 放 `<pkg>/web/hooks/`。
- **命名**：文件名 kebab-case 的 `use-<domain>-<noun>.ts`，导出 camelCase。
- **三层分工**：纯模型（`*-model.ts`，纯函数）↔ 编排 hook（数据与副作用）↔ 渲染组件（JSX）。样板是 `shell/agent-sidebar-tree-model.ts` + `use-agent-sidebar-tree.ts` + `AgentSidebarTree.tsx`；拆页面时优先按这三层切，而不是按行数切。
- **`useRef` 稳定引用**：事件订阅类 hook 用 `useRef` 持有稳定回调，避免 `useEffect` 反复订阅/取消。
- **表单用 react-hook-form + zod**，不手写 `useState` 管理表单状态。命名：`formSchema` / `FormValues` / `form`。
- **Chat 状态 hook 有归属**：`useChatState` / `useSessionState` 在 `packages/agent-runtime/web/hooks/`；`useChatPageVisible` 与 `ChatPageVisibleContext` 在 `packages/web-runtime/web/hooks/use-page-visible.ts`（该文件**没有** `usePageVisible` 导出）。宿主不要在 `src/hooks/` 复制包内实现。

### 3.6 现状偏离

- **组织身份被绕过读取的 2 处生产点**：`apps/web/src/components/agent-panel/use-file-tree-events.ts`（拼 `/web/file-events` 的 WS query）、`packages/agent-runtime/web/yjs/yjs-ws.ts`（拼 `/acp/yjs/*` 的 `active_org_id`）。两处都直接 `localStorage.getItem("active_org_id")`。WS 无法带自定义头，收口需要契约化的组织参数传递方式，属已知缺口。
- ~~**主题强制浅色 + 存在第二份主题实现**~~ 已消解（2026-09-23）：全站改为全局强制亮色，宿主与包内两份实现合一，见 §3.2。
- **手写取数（`useCallback` + `useEffect` + `useState`）的现行违规**，集中在三处：`packages/resources/memory/web/pages/hindsight/**`（8 处）、`packages/resources/workflow/web/pages/workflow/**`（`components/` 下 3 处 + 同目录 `WorkflowList.tsx` 手写 `setInterval(pollList, 15_000)`）、`packages/resources/knowledge/web/pages/agent-panel/KnowledgeGraphPanel.tsx`（手写 `requestId` 令牌而非 `AbortSignal`）。`WorkflowList.tsx` 的数据获取本身走 `useRequest`，只有轮询是手写的——属"一半在轨"的混合形态。同仓同类页面已用规范做法，无能力缺口理由。
- **组织切换不是原子转换**：`localStorage` 先于服务端确认写入（见 §3.3）。失败回滚已实现，但切换瞬间存在"本地快照已变、服务端未确认"的窗口。
- **`useRequest` 的多数配置项缺少范例**：`cacheKey` 全仓 1 处（`use-shell-navigation.ts` 的 `"sidebar-config"`）、`cancel()` 1 个文件（`AdminModelGatewayPage.tsx`，在组件卸载路径上取消在途请求）；`cache.mutate` / `debounceWait` / `retryCount` 零使用。需要时先确认 ahooks 语义并在 code review 中说明，不要凭文档想象。

## 4. 组件规范

### 4.1 组件归属

**已有组件禁止重复开发**。`packages/ui-components` 是唯一来源：

- 基础 UI 原语：`@fenix/ui-components/ui/<name>`（含 `chat/**` 下的聊天基元，均逐文件子路径）。
- 通用业务组件：`@fenix/ui-components/config/<name>`。
- 无渲染工具：`@fenix/ui-components/lib/<name>`；不可归入 `ui/` 或 `config/` 的共享件：`components/<name>`。
- 该包**有根出口**（`@fenix/ui-components`，161 行 barrel），也存在 158 条 `exports` 子路径（口径：`package.json` 的 `exports` 键数，含根出口 `.` 与样式表 `./styles.css` 两条非组件条目）。**按需深链优先**；根出口适合一次取多个组件的场景。新增/删除组件时必须同批改 `web/index.ts` 与 `package.json` 的 `exports`——两者的不一致会让"深链可用、整包导入不可用"，由 `web/__tests__/barrel-exports.test.ts` 的显式名单守护。

**归属由消费者集合决定**：出现第二个包消费时就下沉到 `ui-components`，而不是在消费方各留一份；只有一个消费者时留在原处，不做推测性抽象。

`config/` 下当前 9 个组件的真实契约：

| 组件 | 用途 | 关键 props |
|------|------|-----------|
| `FormDialog` | 通用表单对话框 | `open` / `onOpenChange` / `title` / `children` / `formConfig?` / `onSubmit?` / `submitLabel?` / `cancelLabel?` / `loading?` / `disabled?` / `hideSubmit?` / `width?`（默认 `sm:max-w-lg`） |
| `ConfirmDialog` | 危险操作确认 | `open` / `onOpenChange` / **`title`（必填）** / **`description`（必填）** / `onConfirm` / `variant?: "default" \| "destructive"` / `confirmLabel?` / `cancelLabel?` / `loading?` |
| `EmptyState` | 内联状态块：空态 / 无匹配 / 读取失败 / 无权限共用一个组件 | `title` / `description?` / `icon?` / `action?: { label, onClick, icon?, disabled? }` / `tone?: "neutral" \| "danger"` / 其余 `<div>` 属性透传（`role`、`className` 等） |
| `StatusBadge` | 状态徽标 | `status` / `label?`（覆盖 i18n `statusBadge.<status>`）/ `tone?: "success" \| "info" \| "warning" \| "danger" \| "neutral"` / `toneMap?`（业务状态词表 → 色调）/ `indicator?: "none" \| "dot" \| "pulse"` |
| `ScopeFilterBar` | 配置型目录页的「搜索框 + 作用域过滤条」 | `query` / `onQueryChange` / `placeholder` / `searchLabel` / `scopes: { value, label, count? }[]` / `scope` / `onScopeChange` / `scopeGroupLabel` / 其余 `<div>` 属性透传 |
| `DataTable` | TanStack Table 封装（含搜索/选择/分页/展开） | `columns` / `data` / `searchable` / `selectable` / `actions` / `expandableRow` / `rowKey` / `pageSize` |
| `BatchActionBar` | 批量操作条 | 见包内实现 |
| `AdminKeyGate` | 系统 Master Key 输入门（纯展示，受控） | `unlocked` / `onUnlock(key)` / **`title`（必填）** / **`description`（必填）** / **`inputPlaceholder`（必填）** / **`submitLabel`（必填）** / `error?: string \| null` / `children`（解锁后渲染）；不取数、不 import `web-runtime`，状态机见 `@fenix/web-runtime/hooks/use-admin-key-gate` |
| `LabeledField` | 表单字段名与控件的关联包装 | `label` / `hint?` / `htmlFor?`（不传＝隐式关联：`<label>` 包裹单个可标记控件；传＝显式关联，children 与独立 `<label htmlFor>` 同层）/ 其余 `<div>` 属性透传 |

> `StatusBadge` 只收语义（色调），不收色值：业务状态词表经 `toneMap` 注入，配色（含 dark 变体）留在包内。
> 需要在包外判定色调时用 `getStatusTone(status, toneMap)`，不要复刻配色类。
> `EmptyState` 同样只收语义：`tone` 默认 `neutral`（确实没有数据、筛选后没有匹配），`danger` 用于读取失败、无权限；持久错误再补 `role="alert"`。图标不传尺寸类时沿用 lucide 默认的 24px（组件只负责居中与配色），颜色一律不要手写——配色（含 dark 变体）归 `tone` 管。
> 它**不自带 Card 外壳**：容器（卡片、边框、外边距）由调用方给——面板内联直接用，需要卡片形态时把 `<EmptyState>` 放进调用方的 `Card` / `CardContent`。默认内边距是 `py-10`，紧一点的场景用 `className` 覆盖（如 `className="py-8"`）。
> `ScopeFilterBar` **不接 i18n**：文案（`placeholder` / `searchLabel` / `scopeGroupLabel` 与每个 `label`）全由 props 传入，key 与语言资源只留在调用方——库内组件自带命名空间会把两边的 key 绑死，同一处文案在两侧各留一份。它也不认识业务作用域（不知道「组织 / 公开」是什么），只把受控的 `query` / `scope` 渲染成统一形态。
> **空态 / 失败 / 无权限刻意共用一个骨架**（2026-09-22 冻结）：不要新建第二个「空态组件」或「加载失败组件」——三套语义的结构相同，差别只在措辞与「要不要给重试」。判据：**无权限不给重试**（401/403 重试只会重复被拒，该做的是重新登录或找管理员），**失败给重试**。

**2026-09-22 起去重批次新下沉共享库的原语**（逐个实测存在，下列名字即 `exports` 子路径或具名导出）：

- `ui/status-dot`（`StatusDot` / `StatusDotTone`）：状态圆点收敛为唯一原语，页面级圆点 CSS 随之删除。
- `ui/spinner`（`Spinner`）：独立成块的加载圆环（§2.5），不再手写圆环类名。
- `components/ClosableTabPill`（`ClosableTabPill`）：可关闭的页签药丸。
- `components/agent-catalog-index`（`AgentCatalogIndex` / `AgentCatalogIndexNav` / `AgentCatalogIndexItem` / `AgentCatalogIndexIcon` / `AgentCatalogIndexCopy` / `AgentCatalogIndexMeta` / `AgentCatalogIndexArrow`）：主从面板左侧目录栏的共享构件集——容器 + 目录 + 行 + 图标 / 文案 / 尾注 / 箭头四个槽位件；技能库 / MCP / 模型库 / 知识库 / 组织管理五页改用。**默认值全在这一份组件里**（`f73f9265` 起）：容器内边距与底色、头部几何、行距、行高、圆角、三态配色、图标盒、字号、尾注与箭头都由 `agent-catalog-index.css` 给，五页渲染出同一组计算值，**页面覆盖归零**——各页此前为目录写的 30 余条规则（MCP 12 条、模型库 10 条、技能库 1 条、知识库的目录骨架与两条头部覆盖、组织页 3 条）已同批删除。**页面仍可覆盖，但只保留页面独有的语义**：知识库行尾删除按钮的外壳与不可用态（`shell` + `trailing`）、组织页行首图标的角色三态色（落在工具类上——共享图标盒刻意不声明 `color`），以及两处布局行为——知识库 ≤760px 隐藏目录、组织页 ≤900px 目录横置（`stripOnNarrow`）。**为什么不再留各页刻度**：「共享结构、字号 / 内边距 / 行高 / 圆角 / 选中配色留各页刻度」只统一了结构，同一组件在两页之间观感不成一套（12px 与 9.75px 两套刻度并存）；而共享 CSS 未分层，页面想改就得靠更高特异性去抢（`data-slot` 钩子正是为此存在的），偏差只能靠逐页纠偏收拾——本批顺带修掉的条目标题字重、三态配色落点、三页目录 hover 不可见、模型库尾注列缺规则四处即属此类。目录现在只有一个该改的地方：**改共享 CSS，不要再在页面里长出一份**。
- `lib/clipboard`（`copyTextToClipboard`）与 `lib/format`（`formatDate` / `formatDateTime` / `formatClockTime`）：无渲染的跨包工具，复制与时间展示口径不再各包一份。
- `chat/view/PublicErrorCard`、`chat/panels/chat-interaction-region`（`ChatInteractionRegion` / `ChatInteractionStack`）、`chat/timeline/tool-json-block`（`ToolJsonBlock`）：聊天域的错误卡、交互区与工具 JSON 块骨架。

> `components/agent-master-detail-workspace`（主从壳）**不在上列**：它早于去重批次（2026-09-20 的 `e8c73280` 前置落地）即已入库，不是该批次新下沉的原语。本批动的是它的消费者——记忆页从已删除的 `components/WorkbenchPanel` 切到它；主从壳现有六个消费者（技能库 / MCP / 模型库 / 知识库 / 组织管理 + 记忆页），前五个的目录栏由上面的 `agent-catalog-index` 供给。

### 4.2 Dialog 状态管理

三个关联 `useState` 控制新增/编辑/删除：

```tsx
const [dialogOpen, setDialogOpen] = useState(false);
const [editingItem, setEditingItem] = useState<Item | null>(null);  // null = 创建
const [confirmOpen, setConfirmOpen] = useState(false);
const [deleteTarget, setDeleteTarget] = useState<Item | null>(null);
```

- **创建**：清空编辑状态 → `setDialogOpen(true)`
- **编辑**：填充表单 → `setDialogOpen(true)`
- **`onOpenChange`** 回调中清理状态：`if (!open) resetState()`

### 4.3 表单提交

使用 **react-hook-form + zod**（`zod/v4`）配合 `FormDialog`，禁止手动 `useState` + 手写校验。

**`FormDialog` 在内部创建 `useForm`**，页面不持有 form 实例；把 schema 与提交函数经 `formConfig` 传入，子组件用 `useFormContext()` 绑定字段：

```tsx
// 页面：packages/resources/task/web/pages/agent-panel/pages/AgentTasksPage.tsx
<FormDialog
  key={`${editingTask?.id ?? "create"}-${formResetKey}`}   // key 变化 = 强制重挂载，重置内部 useForm
  open={dialogOpen}
  onOpenChange={setDialogOpen}
  title={editingTask ? t("dialog.editTitle", { name: editingTask.name }) : t("dialog.createTitle")}
  width="sm:max-w-2xl"
  formConfig={formConfig}
  loading={saving}
>
  <TaskForm agents={agents} isEditing={!!editingTask} initialType={editingTask?.type ?? "http"} />
</FormDialog>

// 表单字段：packages/resources/task/web/pages/agent-panel/components/TaskForm.tsx
export function TaskForm({ agents, isEditing, initialType = "http" }: TaskFormProps) {
  const { register, formState: { errors } } = useFormContext<TaskFormValues>();
  // ... 字段直接 register / Controller，错误从 formState.errors 取
}
```

规则：

- **重置表单靠 `key`**，不要在 `onOpenChange` 里手工 `reset()`——内部 `useForm` 的生命周期由 `key` 控制。
- `formConfig.onFormSubmit` 的入参类型是 `Record<string, unknown>`；调用方按域类型收窄后再用，不要在包内引入域类型。
- **`onSubmit` 与 `formConfig` 互斥**：传了 `formConfig` 时 `onSubmit` 被忽略；不传 `formConfig` 的 `onSubmit` 只做 `preventDefault` + 回调，**不做校验**——无校验需求才用它。
- `schema` / `defaultValues` / `onFormSubmit` 三者要同时在 `formConfig` 里给出。

### 4.4 组件声明与类型

- **业务页面与业务组件统一用 `function` 声明**：`export function AgentSkillsPage() {...}`。这条与 `ui-components` 的既有形态一致，不需要为它开例外。
- **例外只针对 `chat/primitives/*`**：该目录沿用上游写法使用箭头函数组件（`ui/*` 仍然是 `function` 声明）。不要把这个例外扩散到业务代码。
- props 类型用顶部 `interface` 或内联类型，不用匿名对象字面量散落多处。
- **禁止 `as any`**。手写生产代码当前只有 `lib/clipboard-polyfill.ts`、`lib/random-uuid-polyfill.ts` 两处（浏览器 API 垫片）与 `FormDialog.tsx` 一处带 `biome-ignore` + 原因的行级例外。生成产物（`routeTree.gen.ts`，36 处）与测试不计入——生成文件另有豁免口径（见 §4.7）。第三方类型缺陷用最小范围收窄，不要扩散。
- **`React.memo` 的 comparator 必须与调用方 prop 稳定性一致**：`ChatView` / `EntryRenderer` / `MessageResponse` 有显式 comparator，改动它们的 props 时同步更新 comparator 与相关渲染测试，否则会出现"消息不更新"或"整表重渲染"两类反向故障（见 §8.5）。

### 4.5 类型定义

| 场景 | 位置 |
|------|------|
| 只在该页面使用的类型 | 页面文件内联（组件函数上方） |
| 资源域类型 | 跟随域模块定义在 owner 包的 `web/api/<domain>.ts`，经包 `exports` 按消费点导出 |
| 跨资源包共享的域类型 | `@fenix/web-runtime/types/config`（`AgentInfo` / `ProviderInfo` / `SkillInfo` / `ModelEntry` 等，6 个资源包共用） |
| 只服务宿主页面、无资源包归属的类型 | `apps/web/src/types/` |

- **边界转换**：协议 DTO、领域对象与视图模型在边界处独立转换，不做跨层共享可变结构。前端类型必须对应后端真实返回，**禁止声明后端不存在的"幻影字段"**。
- 域内类型优先跟随域模块；只有当**第二个包**也需要它时才上提到 `types/config`——上提后它就是跨包契约，改动需要同步搜全部消费方。
- 契约漂移没有编译期保护：`request<T>()` 的泛型是断言而非校验。改后端响应时必须同批改前端类型，别指望类型检查发现。

### 4.6 文件结构

import 顺序由 Biome 的 import-sort 统一（`precheck` 会跑），实际形态是**字母序分组**，包内相对导入放最后。人工组织时按此语义分组：

```tsx
// 1. React / 框架
import { lazy, Suspense, useCallback, useEffect, useState } from "react";

// 2. 路由
import { Link, useNavigate } from "@tanstack/react-router";

// 3. 第三方库（含 @fenix/ui-components 的基础 UI）
import { Bot, Plus, Search, Trash2 } from "lucide-react";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";

// 4. 跨包能力（经各包 exports，不用别名）
import { taskV2Api } from "@fenix/resource-task/web";
import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n";
import { unwrap } from "@fenix/web-runtime/api/request";

// 5. 本包 / 本目录相对导入
import { TaskForm } from "./components/TaskForm";

// 6. 类型（按需，用 import type）
import type { TaskV2Info } from "@fenix/resource-task/web";

export function AgentTasksPage() {
  const { t } = useTranslation(TASKS_V2_NS);
}
```

### 4.7 文件规模与模块拆分

- **单个文件不得超过 500 行**。接近上限时应重构模块边界，而不是继续追加；生成文件豁免（如 `routeTree.gen.ts`）。
- 拆分按**职责**切，不按行数切：一个文件对应一个稳定职责与对外形状。"页面 + 数据编排 + 传输适配"挤在一个文件里是超限的常见成因；成功样本见 `packages/resources/task/web/pages/agent-panel/`——`TasksPanel.tsx`（壳）+ `pages/AgentTasksPage.tsx`（页面）+ `pages/agent-tasks-registry.tsx`（列与动作登记）+ `pages/agent-task-runtime-board.tsx`（运行态看板）+ `pages/agent-tasks-utils.ts`（纯工具）+ `components/`（表单与对话框）。
- 收益判据是耦合而非行数：拆出的模块若仍需反向读取原文件内部状态，说明缝切错了——应先抽状态归属，再拆渲染。
- 上传/预览/文件树等重型交互按 §3.5 的三层拆分（纯模型 / 编排 hook / 渲染组件）。

### 4.8 现状偏离

- **17 个生产文件超 500 行**（快照，从大到小）：`model-management/AdminModelGatewayPage.tsx` 1247、`knowledge/AgentKnowledgeBasesPage.tsx` 1231、`workflow/components/NodeConfigCard.tsx` 1182、`workflow/WorkflowEditor.tsx` 1117、`memory/hindsight/components/Constellation.tsx` 978、`memory/hindsight/components/DataView.tsx` 968、`memory/hindsight/components/Graph2d.tsx` 713、`agent-config/AgentHomePage.tsx` 675、`workflow/hooks/useWorkflowRun.ts` 576、`knowledge/ResourcePreviewContent.tsx` 558、`workflow/components/NodeConfigPanel.tsx` 557、`knowledge/EmbeddingModelManager.tsx` 542、`web-runtime/chat/structured-to-thread.ts` 537、`knowledge/RetrievalTestPanel.tsx` 522、`ui-components/chat/shell/ACPMain.tsx` 513、`agent-runtime/hooks/use-chat-state.ts` 509、`model-management/agent-models-dialogs.tsx` 501。400–499 行区间另有 25 个（口径：`apps/web/src` + `packages/**/web/**`，排除测试、生成文件与服务端路径；行数是文件总行数）。
- **2 个 config 组件生产零消费**：`DataTable` / `BatchActionBar` 目前只有包内测试与 demo 引用。`EmptyState` 早已不是零消费——2026-09-22 重写为内联状态块后，它已是本仓页面状态块的统一实现：实测 `grep -rln 'from "@fenix/ui-components/config/EmptyState"' packages apps` 命中 **37 个生产文件**（workflow 的 `WorkflowList.tsx` / `WorkflowRuns.tsx` / `WorkflowVersions.tsx`，observer 的 `AdminObserverPage.tsx`（此前的同名本地实现已删除），task 的 `TasksPanel.tsx` / `components/ExecutionLogTable.tsx`，agent-config 的 `pages/agent-sites-catalog.tsx`（空态与失败态，`542772c7`），以及 knowledge / memory / mcp / model-management / prod-view / channel / skill / identity 各包的页面与状态块；原记的 `task/components/TaskLogDialog.tsx` 已不直接消费它，日志弹窗经 `ExecutionLogTable` 间接复用）。收口前先确认包内 API 是否够用（`StatusBadge` 已在 2026-09 泛化后接入 task / workflow / prod-view 三处生产消费方，不再是零消费）。
- **`task` 包的域类型未从包出口导出**：`TaskV2Info` 的权威定义在服务端 zod schema，web 侧页面用相对路径 `from "../../../api/tasks-v2"` 取，未过 `@fenix/resource-task/web`。与 §4.5 的"经包 exports 导出"不一致，新增类型不要照抄这种取法。
- **刻意分叉（已裁定，不要以"去重"为由重开）**：`workflow/pages/workflow/components/` 的三种节点配置容器 `NodeConfigPopover`（浮层）/ `NodeConfigSheet`（侧栏）/ `NodeConfigCard`（卡片）服务不同交互场景——props 解构块虽 17 行逐字相同，合并会把差异藏进参数。2026-09-22 的两次收敛（`524127a7` / `6095073b`）都按此口径留手写并登记。
- **刻意分叉（已裁定）：`memory/hindsight/components/` 的两套图谱**——`Graph2d.tsx`（Cytoscape.js）与 `Constellation.tsx`（自绘 canvas）的图形逻辑不做归一，只收敛它们外围的重复（可视化高度读取、暗色判定、加载块）。两者的渲染模型不同，抽公共层只会得到一层薄转发。
- **刻意不进库：红描边危险按钮**——`sandbox/web/src/pages/admin/components/RowDeleteButton.tsx` 的 `size="sm"` + `variant="outline"` + 红描边类串全仓只有本包在用（同包另有一处 `InstanceDetailDialog` 的 clearOverride 配方相同）；其余包的红按钮要么是 `ghost` + `text-destructive`、要么是无描边实心 `destructive`，换上红描边会单独改变这一颗按钮的视觉权重。按"抽象延迟到第二个真实用例"的既有口径留在包内，理由与复核结论写在文件头注释里（`94a0c020`）。
- **刻意不上移：形态未定型、第二个真实用例仍在本包内的共享件**——如 sandbox 的 `JsonPreview`（管理面板四处 JSON 展示块收敛而来），先用包内共享件而不是进 `ui-components`。这与"归属由消费者集合决定"是同一条口径，不是遗漏。

## 5. API 建模层

前端对后端的 HTTP 调用统一经 `@fenix/web-runtime/api/request` 的 `request<T>()`；域模块按**资源归属**定义在 owner 包的 `web/api/` 下。

### 5.1 分层与归属

| 层 | 位置 | 职责 | 引用方式 |
|----|------|------|----------|
| 请求基建 | `packages/web-runtime/web/api/request.ts` | credentials、序列化、超时、合并外部信号、错误标准化 | `@fenix/web-runtime/api/request` |
| 域模块 | `packages/<group>/<pkg>/web/api/<domain>.ts` | URL 拼装、请求/响应序列化、域内类型 | `@fenix/<pkg>/web` |
| 宿主专有域 | `apps/web/src/api/<domain>.ts` | 只服务宿主、无资源包归属的接口 | `@/src/api/<domain>` |
| 组件 | — | 调用域模块 → 处理结果 → 更新 UI | — |

- **归属判据**：接口对应哪张表、哪个 owner，域模块就放在那个包（见 §1）。
- **请求基建不做组织头注入**：租户身份靠 `credentials: "include"` 携带的 better-auth 会话 cookie，以及身份包 fetch 拦截器注入的 `X-Active-Org-Id`（见 §3.3）。域模块不要自己拼组织参数。
- **组件负责**：调用域模块 → 处理结果 → 更新 UI。不写 `fetch`、不拼后端 URL。
- **窄口**：默认经包根 `./web` 出口；确需跨包少量复用时单开（现仅 `@fenix/agent-runtime/web/api/environments`），须在该包 `exports` 显式声明，且导出文件必须是浏览器安全入口。

### 5.2 共享请求基建契约

实现见 `packages/web-runtime/web/api/request.ts`。**本节只描述契约，不复制实现**——实现会变，契约才是约束。

#### 导出面

| 导出 | 作用 |
|------|------|
| `request<T>(url, options)` | 统一请求函数，返回 `Promise<ApiResponse<T>>` |
| `unwrap<T>(resp)` | 解包 `ApiResponse`：成功返回 `data`，失败抛 `ApiError` |
| `ApiError` | 统一错误类，字段为 **`message` / `code` / `data`** |
| `ApiResponse<T>` | `{ success, data?, error?: { code, message, data? } }` |
| `PaginatedResponse<T>` | `{ items, total, page?, pageSize? }`——`page`/`pageSize` 可选，并非所有分页端点都返回 |
| `ErrorCode` | `KnownErrorCode \| (string & {})`，兼容后端透传的自定义业务错误码 |
| `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS` | 均为 120s，与后端 file_op / upload 对齐 |

`RequestOptions` 与 `NetworkError` **不是导出符号**：调用方无法对 request 层做类型标注，也无法用 `instanceof` 区分网络类错误，只能判 `error.code === "NETWORK_ERROR"`。`ApiError` **没有 `status` 字段**——HTTP 状态码在这一层已丢失，需要按状态码分支时只能靠 `code`。

#### `RequestOptions` 字段

| 字段 | 语义 |
|------|------|
| `params` | 路径参数 `:id` 插值 |
| `query` | 查询参数自动拼装 |
| `body` | 普通对象走 JSON，`FormData` / `Blob` 直传 |
| `timeout` | 超时 ms，默认 30000 |
| `signal` | 外部取消信号，与内部超时信号合并 |
| `opId` | 文件写操作幂等 ID，透传 `x-file-op-id`（`docs/arch/12-files.md` §7.2）；重试须复用同一 opId，服务端据此去重 |
| `bearerToken` | 注入 `Authorization: Bearer`（如系统 Master Key，`docs/arch/21` §5） |
| `headers` | 请求头透传（如 `If-None-Match` 条件请求） |

> **`headers` 当前会覆盖内部注入头**（`content-type` / `x-file-op-id` / `authorization`）：实现里 `...init` 在合并后的 `headers` 之后展开，而 `headers` 未被从 `init` 中解构排除。现有测试覆盖不到这一路径，生产代码也暂时没有调用方传 `headers`。**在修好之前不要依赖二者的合并语义**；修法是先把 `headers` 从 `init` 解构排除，再与内部头合并。

#### 失败语义

**这是最容易踩的一条**：

- `request()` 对 HTTP 失败（4xx/5xx）与业务失败（`success === false`）**返回 `{ success: false, error }`，不 throw**。
- `unwrap()` 负责把失败转成 `throw ApiError`。
- 因此**直接 `await request()` 并依赖 `catch` / `onError` 的代码会把 4xx/5xx 当成成功**——`useRequest` 的 `error` / `onError` 只理解 rejected Promise。

**强制要求**：调用方必须 `unwrap()` 或显式判断 `success` 后再使用数据；不得省略解包，也不得新增依赖 `catch` 的调用点。

```tsx
// ❌ 4xx/5xx 会被当成成功，loading/empty 状态继续推进
try { const data = await taskV2Api.list(); } catch { /* 永远不会走到 */ }

// ✅
const data = await unwrap(taskV2Api.list());
// ✅ 需要拿 Result 时显式判断
const res = await taskV2Api.list();
if (!res.success) { /* 处理 res.error */ }
```

#### 其它约定

- **超时下限**：写操作的请求超时不得短于后端（file_op 60s / upload 120s），否则慢写会被前端提前掐断；需要区分时用 `WRITE_TIMEOUT_MS` / `UPLOAD_TIMEOUT_MS`。
- **错误码归一化**：后端用 snake_case 类型名（`not_found`、`validation_error`、`remote_error`），部分模块直接透传 `ErrorCode` 常量——`request()` 统一归一化，未提供时按 HTTP status 兜底映射（401/403 → `UNAUTHORIZED`、404 → `NOT_FOUND`、422 → `VALIDATION_ERROR`、≥500 → `SERVER_ERROR`）。
- **错误记录但不弹 UI**：`request()` 用 `console.error` 记录失败，**不调 `toast`**——UI 反馈是组件职责（见 §5.8）。

### 5.3 非标准响应与非 REST 传输

**每个例外点都必须登记在下面这张表里。** 表格分两类，性质不同，不要混用：

- **能力缺口**：`request()` 的实现缺失（blob / 流 / 进度 / 响应头 / 304）。修法是**给 `request()` 补能力**，不是在调用点继续手写；补完后这些点整体退回 `request()` + `unwrap()`。
- **协议例外**：传输面本身不经 `request()`（WebSocket、SSE、第三方客户端库），补能力后也不应改写。

| 形态 | 命中点 | 收口方式 | 类别 |
|------|--------|----------|------|
| 无业务载荷的成功响应 | knowledge `knowledge-models.ts`（`{ ok: true }`）、prod-view `prod-views.ts`（`{ ok: boolean }`） | `request<{ ok: boolean }>()` 原样返回 | 协议例外（不套 `data` 信封） |
| 业务体自带判别字段 | model-management `providers.ts`（`ModelTestResult{ok, content}`） | 原样保留 | 协议例外 |
| 裸响应体（无 `data` 字段） | identity `web/lib/password-crypto.ts` 取登录加密公钥、宿主 `pages/login-transport.ts` 取 `{ signupAllowed }` | `request<T>()` 后显式判 `success` 再取值 | 协议例外 |
| 二进制 / 文本 / PDF 读 | knowledge `web/api/knowledge-bases.ts` | 裸 `fetch` + 域内 `buildResourceReadError()` 归一为 `ApiError` | 能力缺口 |
| 二进制下载（Blob） | 宿主 `api/fs.ts`（文件 / ZIP）、skill `web/api/skills.ts`（`download`） | 裸 `fetch` / `XHR`，域模块把成功响应收成 `Blob` 交回调用方、失败归一为 `ApiError`（code 与 `unwrap()` 同源），不让组件看到原始 `Response` | 能力缺口 |
| 文本流下载 | observer `web/api/system-logs.ts`（`downloadSystemLog`） | 裸 `fetch` + `buildDownloadError()`；成功只回 `Blob`，建锚点与 `revokeObjectURL` 归调用方 | 能力缺口 |
| 文本 / 流式读（Bearer 鉴权） | sandbox `web/src/api/system-sandbox.ts`（toml、诊断文本、命令 SSE） | 裸 `fetch` + `buildStreamError()`；`executeCommand` 返回原始 `Response` 由调用方消费流。三处只带 `Authorization: Bearer`——`/api/system/*` 的守卫只读该头（`apps/server/src/plugins/system-api-auth.ts`），不送 cookie | 能力缺口 |
| 上传进度 | 宿主 `api/fs.ts`（`uploadFiles`） | `XMLHttpRequest`（进度 / 超时 / abort / `x-file-op-id` / 错误归一全自建） | 能力缺口 |
| 条件请求（`If-None-Match` → 304 + 读回 `ETag`） | 宿主 `api/fs.ts`（`revalidateWorkspaceTree`） | 裸 `fetch`；返回判别式结果而非抛错（304 不是失败） | 能力缺口 |
| WebSocket | `/acp/yjs/*`（§8）、`/web/file-events`（文件树事件） | 不走 `request()`；两条通道的登记见 §8.1 | 协议例外 |
| SSE | workflow `web/api/workflow-sse.ts`（`EventSource` + `withCredentials`） | 不走 `request()`；每个 workflowId 一条独立连接，前端以 `?fromSeqNum=` 续传（服务端另接受 `Last-Event-ID` 头） | 协议例外 |
| better-auth 客户端 | identity `web/lib/auth-client.ts`（`authClient.*`）及其 `/api/auth/sign-up/phone` | 传输由库内 `createFetch` 持有。库内核路由一律用客户端方法；自定义路由（无客户端方法）保留手写请求 | 协议例外 |
| 本地 blob / 预览源读取 | `ui-components/web/components/preview/html-plugin.ts`、`chat/primitives/internal/prompt-input-file.ts` | 读的是本地 blob URL，**不是后端调用**，不属本节管辖 | 不适用 |

**新增例外点的登记要求**：在提交里写明命中点、为何不能走 `request()`、失败归一函数、成功返回值形状，以及能力补齐后的回退动作。

### 5.4 域模块标准模式

域模块从 `@fenix/web-runtime/api/request` 取 `request` 与类型，**返回 `ApiResponse` 交给消费方解包**：

```ts
// packages/resources/task/web/api/tasks-v2.ts —— 节选，实际还有 update / toggle / trigger / logs / clearLogs
import type { PaginatedResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

export interface TaskV2Info { /* 域内类型跟随模块定义，不散落到宿主 */ }

export const taskV2Api = {
  /** 分页列表 */
  list: (query?: { page?: number; pageSize?: number; keyword?: string }) =>
    request<PaginatedResponse<TaskV2Info>>("/web/tasks/v2", { query }),

  /** 获取单个 */
  get: (id: string) => request<TaskV2Info>("/web/tasks/v2/:id", { params: { id } }),

  /** 创建 */
  create: (body: TaskV2CreateBody) =>
    request<TaskV2Info>("/web/tasks/v2", { method: "POST", body }),

  /** 删除 */
  del: (id: string) => request<void>("/web/tasks/v2/:id", { method: "DELETE", params: { id } }),
};
```

三点可复现的模式：**文件头注释说明域与例外** + **域内类型与模块同文件** + **单一具名对象导出、不在模块内做 UI 反馈**。

**解包归属要一次性决定**：新增模块**按上面的模式返回 `ApiResponse`**，不要在域模块内提前解包。当前仓库存在两类历史写法（见 §5.9），混用会让调用方无法从签名判断拿到的是数据还是 Result——新增代码不要扩大这个面。

### 5.5 域模块命名与组织

| 规则 | 说明 | 示例 |
|------|------|------|
| 文件名 kebab-case | 与资源域一致 | `knowledge-bases.ts`、`workflow-defs.ts` |
| 导出对象 camelCase + `Api` 后缀 | 避免与类型名冲突 | `taskV2Api`、`mcpApi`、`kbApi` |
| 位置跟随 owner 包 | `packages/<group>/<pkg>/web/api/` | `packages/resources/skill/web/api/skills.ts` |
| 由包 `./web` 出口转出 | 导出面按包外真实消费点收敛 | `export * from "./api/tasks-v2"` |
| 非 REST 传输与域模块同层 | 不塞进 `request()` | `workflow-sse.ts` |
| 请求头在同一个文件里组装 | 鉴权头的选择属于域模块 | `system-sandbox.ts` 的 `adminOptions()` |

### 5.6 域模块一览

| owner 包 | 域模块 | 说明 |
|----------|--------|------|
| `@fenix/web-runtime` | `web/api/request.ts` | 请求基建（非域模块） |
| `@fenix/agent-runtime` | `environments.ts` | 环境与实例；**窄口** `@fenix/agent-runtime/web/api/environments` |
| `@fenix/identity` | `api-keys.ts`、`organizations.ts` | API Key 与组织 |
| `@fenix/agent-config` | `agents.ts`、`sites.ts`、`web/src/api/sidebar-config.ts` | Agent 配置、站点、侧栏配置 |
| `@fenix/model-management` | `providers.ts`、`models.ts`、`model-gateway.ts` | Provider、模型、模型网关 |
| `@fenix/resource-skill` | `skills.ts` | Skill 元数据与内容 |
| `@fenix/resource-mcp` | `mcp.ts` | MCP server |
| `@fenix/resource-knowledge` | `knowledge-bases.ts`、`knowledge-models.ts` | 知识库与嵌入模型 |
| `@fenix/resource-task` | `tasks-v2.ts` | 定时任务（v2） |
| `@fenix/resource-workflow` | `workflow-defs.ts`、`workflow-engine.ts`、`workflow-sse.ts` | 工作流定义、引擎、SSE |
| `@fenix/resource-channel` | `channels.ts` | IM 通道 |
| `@fenix/resource-machine` | `registry.ts` | 机器注册表 |
| `@fenix/resource-memory` | `hindsight.ts` | 记忆 |
| `@fenix/resource-observer` | `observer.ts`、`system-logs.ts`、`system-people-tree.ts` | 观察面板与系统日志 |
| `@fenix/resource-prod-view` | `prod-views.ts` | 生产视图 |
| `@fenix/resource-sandbox` | `web/src/api/{sandbox-pools,system-organizations,system-sandbox}.ts` | 沙箱与系统组织 |
| 宿主 `apps/web/src/api/` | `branding.ts`、`fs.ts`、`instances.ts`、`peri-task-details.ts`、`helpers.ts` | 宿主专有域（无资源包归属） |

按 owner 归属维护，**不记录接口数量**（会漂）。新增域模块时同步本表；删除模块时同步删行。

### 5.7 组件中使用

组件不直接 `await` 域模块，统一交给 ahooks `useRequest`，并用 `unwrap()` 解包：

```tsx
import { useRequest } from "ahooks";
import { taskV2Api } from "@fenix/resource-task/web";
import { unwrap } from "@fenix/web-runtime/api/request";

// 查询：自动管理 loading / error / data，组件挂载时自动执行
const { data, loading, error, refresh } = useRequest(() =>
  unwrap(taskV2Api.list({ page: 1, pageSize: 20 })),
);

// 变更：manual 模式，手动触发，成功后刷新列表
const { run: saveTask, loading: saving } = useRequest(
  async (body: TaskV2CreateBody) => unwrap(taskV2Api.create(body)),
  {
    manual: true,
    onSuccess: () => { refresh(); toast.success(t("toast.saved")); },
    onError: (err) => { console.error("保存失败", err); toast.error(err.message); },
  },
);
```

### 5.8 禁止事项

- **禁止**在组件中直接写 `fetch` / `XMLHttpRequest`，或在 `useEffect` 中裸调 `fetch`（能力缺口见 §5.3，须登记后由域模块承载）
- **禁止**在组件中拼装后端 URL（含 WebSocket URL——见 §8.1）
- **禁止**在域模块中重复定义 `request()`——统一从 `@fenix/web-runtime/api/request` import
- **禁止**在 API 模块内调用 `toast.error`（UI 层职责，错误由组件 `onError` 处理）
- **禁止**新增 `/v1`、`/v2` 历史前缀（由 `frontend-no-legacy-api-prefix` 规则阻断，见 §11.2）
- **禁止**绕过包 `exports` 深引 `@fenix/<pkg>/src/*`、`@fenix/<pkg>/web/src/*`
- **禁止**直接 `await` 域模块并依赖 `catch`（必须解包，见 §5.2）
- **禁止**把失败静默映射成 empty 或成功状态
- **禁止**在用户可感知失败的位置只写 `console.error` 而不给用户可见反馈。判据是三条**同时**成立：① 位置在组件 / 页面 / hook 的 `catch` 或异步失败分支里；② 失败由用户操作触发，或使用户正在看的内容不可用；③ 同作用域（同一函数内）没有别的用户可见反馈（`toast` / 内联错误态 / 降级 UI）。

这条规则**没有门禁，只能人工 review**：`console.error` 是诊断信号，天然合法，工具无法区分"记录了"与"只记录了"。三类位置**必然豁免**，不需要也不该补提示：

| 豁免 | 理由 |
|------|------|
| 域模块与请求基建 | 模块内禁止 UI 反馈（见上一条与 §5.2 的 `request()` 契约） |
| ErrorBoundary 的 `onError` | 降级 UI 本身就是用户可见反馈（§7.1） |
| 后台触发路径（轮询、WS/SSE 回调、定时器、订阅） | 失败不改变用户此刻在做的事，弹提示属噪声 |

补反馈时用 `toast.error(t("<key>"))`，**保留原有 `console.error`**（它承载诊断上下文）；`packages/ui-components/**` 内部不直接调宿主 `toast`，只经 `onNotice` / `onError` 端口抛出文案。`/login` 与 `/admin` 下没有 `Toaster`（§3.1），这两条路径上的失败必须用内联错误态——在那里 `toast.error` 是静默 no-op。

### 5.9 现状偏离

- **`headers` 覆盖内部头的实现缺陷**（§5.2）：文档过去把"内部头不会被覆盖"写成已实现，实际相反。
- **实现与注释不一致的三处**（以代码为准，不要以注释为承诺）：① `request()` 的 catch 注释承诺"网络错误/超时自动重试 1 次并复用同一 opId"，**实现里没有第二次执行**；② 超时定时器在收到响应头后即清除，**不覆盖 body 消费**，慢 `json()` / `text()` 不受超时约束；③ `anySignal` 合并后的监听器在请求成功后不移除，会挂在调用方的 `signal` 上直到其 abort。
- **两处"失败被吞掉"的已知残留**（§5.8 判据命中，补法需改对外契约或属后台路径，2026-09-22 全量复核时未动）：① `platform/identity/web/contexts/OrgContext.tsx` 的 `refreshOrgs` 失败只 `console.error`，组织页会按"无组织"渲染（落到 `noOrgs` 空态、无失败态）——要补持久失败态必须扩 `OrgContextValue`；② `agent-config/web/components/agent-panel/SiteFrame.tsx` 的挂载二维码在后台预生成，失败只留 `console.error`，分享弹层会停在永久 spinner（补法建议在弹层内落"最近一次生成失败"静态态，而不是 toast——弹层可能在失败之后才被打开）。
- **解包归属存在两代写法**：9 个模块在域内 `unwrap()`（宿主 `fs.ts` / `peri-task-details.ts`、`model-gateway`、`observer`、`system-logs`、`system-people-tree`、`hindsight`、sandbox 的 `system-organizations` / `system-sandbox`），另有 3 个 blob 家族模块（`knowledge-bases`、`skills`、`system-sandbox` 的部分方法）在域内抛错。注意 `system-sandbox` 同时属于两组，去重后**合计 11 个模块的对外签名是数据或抛错，不是 Result**，与 §5.4 的"新增返回 `ApiResponse`"并存。
- **5 个模块用函数式导出而非 `*Api` 对象**：`model-gateway.ts`（12 个具名函数）、`observer.ts`、`system-logs.ts`、`system-people-tree.ts`、`system-organizations.ts`。与 §5.5 的命名规则不符。
- **`workflow/web/api/workflows.ts` 已删除**（`ac642962`，2026-09-22）：它是迁移期留下的第二份 `workflow-defs` 客户端，`WorkflowDefItem` / `WorkflowVersionItem` / `VersionYamlResponse` 与 `ENDPOINT` 常量同 `api/workflow-defs.ts` 逐字重复，导出的 `workflowApi` 全仓零引用（消费方一直用 `workflowDefApi`）。按"删除优于兼容"未留 shim 与别名，入口的三个 API client 是 `workflowDefApi` / `workflowEngineApi` / `customToolsApi`。**不要再以"补齐第二份客户端"为由重建**。
- **`frontend-no-legacy-api-prefix` 规则只识别裸 `request(...)` 调用**：写成成员调用（`this.request("/v1/...")`）或裸 `fetch("/v1/...")` 会绕过。当前控制台代码无 `/v1`、`/v2` 命中，但不要依赖这条规则做全量保证。
- **域模块路径仍普遍回显服务端 `err.message`**：32 个前端文件、102 处把 `err.message` 直接交给 `toast.error`（`FileTreeTab.tsx`、`AgentTasksPage.tsx`、`AgentKnowledgeBasesPage.tsx`、`agent-models-data.ts`、`EmbeddingModelManager.tsx`、`useWorkflowPersistence.ts` 等），另有模板字符串形态未被统计。与 §9.3「错误按稳定 code 映射文案」的要求不一致；Chat 域已按 error type 收敛（见 §6.5）。

## 6. 安全规范

前端安全是质量基线，以下规则**必须**遵守，违反需在 code review 中 block。

### 6.1 XSS 与不可信内容渲染

- **禁止** `dangerouslySetInnerHTML`，除非经过 DOMPurify 清洗。清洗即合规——**不需要**额外的批准注释，但需要在该行或函数上方写清**内容来源**（谁产生的、为什么可信）。
- 禁止直接拼接 HTML 字符串注入 DOM。
- 用户生成内容（UGC）与 **Agent / LLM 输出**同等对待：都是不可信输入。

```tsx
// ❌ 禁止
<div dangerouslySetInnerHTML={{ __html: userInput }} />

// ✅ 域模块内清洗，组件只接清洗后的值
import DOMPurify from "dompurify";
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(html) }} />
```

**Markdown 渲染**：以 `streamdown` 为唯一渲染器（`MessageResponse`，懒加载，经 `allowedTags` 白名单 + `urlTransform` 收口）。新增 Markdown 渲染场景时复用这条链路，不要另起一条。当前唯一例外是 `memory/web/pages/hindsight/components/CompactMarkdown.tsx`（`react-markdown` + `remark-gfm`，且是零消费者的死文件），已在 §6.5 登记。

### 6.2 iframe 沙箱

`allow-scripts` + `allow-same-origin` 同时开启时，iframe 内脚本可以读写父页面的 DOM 与存储——**等价于没有沙箱**。按来源分级：

| 来源 | 要求 | 当前实现 |
|------|------|----------|
| Markdown / Agent 输出里的 `<iframe>` | **必须**去掉 `allow-same-origin`，且对 `src` 做协议与域名校验 | 偏离（见 §6.5） |
| 用户自己的站点（`siteUrl`、`SiteFrame`） | 可保留 `allow-same-origin`，但必须带 `referrerPolicy` | 已带 `referrerPolicy="no-referrer"` |
| 同源文件预览（pdf / office 转 pdf） | 可用 `srcDoc` 或同源 URL，`sandbox` 可选 | 部分 iframe 无 `sandbox` 属性（同源，风险低） |

新增 iframe 时必须显式写出 `sandbox` 属性并说明取值理由。

### 6.3 凭据与本地存储

- **禁止**将 API Key、Token、Secret 存入 `localStorage` 或 `sessionStorage`。
- 认证 Token 仅通过 HttpOnly Cookie 传输，前端不直接读写。
- 前端配置中出现的密钥占位符（如 `{env:RCS_SECRET_xxx}`）**不得**在前端代码中展开或替换。
- API Key 创建成功后仅展示一次，前端**不得**将明文 Key 持久化到任何本地存储。

**唯一的凭据类例外**（用户裁定保留，不得作为新代码先例）：

- 系统 Master Key 存 `sessionStorage`（键 `rcs_admin_master_key`）：实现见 `packages/web-runtime/web/lib/admin-key.ts`，写入点是 `@fenix/web-runtime/hooks/use-admin-key-gate` 的 `unlock()`（门组件为 `@fenix/ui-components/config/AdminKeyGate`，5 处消费：sandbox / observer ×3 / model-management），经 `request()` 的 `bearerToken` 注入 `Authorization`；401 时调用方经 `fail()` 清 key 回门。master key 不进 better-auth 会话体系，落在标签页 session 内换取"刷新免重输"；代价是同源脚本与 XSS 可直接读走该值，因此**只允许服务系统管理员页**（sandbox / observer / model-management 的 master key 门），不得用于普通用户凭据。XSS 面由 §6.1 与 §6.2 控制。
- **移除条件**：master key 改由服务端 HttpOnly Cookie 或仅内存态承载（接受刷新重输）后，删除 `admin-key.ts` 及其全部消费方，并同步删除本条登记。

**`localStorage` 的合法用途白名单**（除 master key 外一律非凭据）：

| 用途 | 键 / 位置 |
|------|-----------|
| UI 维度与布局偏好 | `ChatArea`、`artifacts-files-workspace` |
| 面板开合状态 | `wf-editor:chat-open`（workflow 编辑器）、`acp-sidebar-open`（chat panel） |
| 侧栏折叠状态 | `AgentSidebar`、`AgentSidebarTree` |
| 语言 | `rcs-lang`（i18n 检测器托管） |
| 主题 | 无（全局强制亮色，见 §3.2；`theme` 键已不再被读写） |
| 登录页偏好 | `apps/web/src/lib/auth-preference.ts` |
| 匿名 UUID | `apps/web/src/api/helpers.ts`（当前零消费） |

**组织 id 不在"便利"的范畴**：它决定请求归属哪租户，只允许经上下文读取（见 §3.3）。

### 6.4 敏感操作

- 删除、权限变更、组织转移等敏感操作**必须**经过二次确认，用 `ConfirmDialog` 且 `variant: "destructive"`。
- **禁止原生 `confirm()` / `window.confirm()`**：它阻塞主线程、无法本地化、样式不受控，且绕过 `ConfirmDialog` 的可访问性实现。
- 敏感操作的 API 调用**禁止**在 URL 中携带敏感参数（使用 POST body）。

### 6.5 现状偏离

- **3 处 `dangerouslySetInnerHTML` 全部经 DOMPurify，但都用默认配置**（无 `ALLOWED_TAGS` 白名单）：`knowledge/web/components/knowledge/ResourcePreviewContent.tsx`、`knowledge/web/src/pages/agent-panel/components/ChunkDetailSheet.tsx`、`.../RetrievalTestPanel.tsx`。三处都写了内容来源注释，合规但清洗强度值得收紧。
- **存在 `streamdown` 之外的第二条 Markdown 渲染链**：`memory/web/pages/hindsight/components/CompactMarkdown.tsx` 用 `react-markdown` + `remark-gfm`（无 sanitize），且在包 README 里自述为零消费者的死文件。要么删除，要么接入 `MessageResponse`。
- **最大 XSS 面未收口**：`ui-components/web/chat/primitives/iframe-preview.tsx` 对 Markdown 里的 `<iframe>` 同时给 `allow-scripts` 与 `allow-same-origin`，且**前端不对 `src` 做任何校验**；来源是 Agent / LLM 输出。同上文件放大弹窗的 Dialog 内还有一份同样配置。
- **knowledge 预览的 Markdown 走 `react-markdown` 且未接 `rehype-sanitize`**（`ResourcePreviewContent.tsx`），输入是用户上传的知识库文件正文。属待收口项。
- **错误文案回显**：Chat 域已按稳定 `error.type` 映射字典（`public-error-text.ts` + 协议侧明确"不得使用原始异常文本"，并有 `public-error-i18n.test.ts` 守护）；但域模块与页面的 `onError` 仍普遍直接显示 `err.message`（见 §5.9）。

## 7. 错误边界

使用 ErrorBoundary 防止单个组件崩溃导致整个页面白屏。

### 7.1 放置规则

- **每个独立功能面板**各自包裹 ErrorBoundary，一个面板崩溃不影响其他面板。
- 顶层根布局需要兜底 ErrorBoundary。
- 路由段也应有边界；当前仓库**未使用** TanStack Router 的 `errorComponent` / `pendingComponent`（`__root.tsx` 只声明了 `notFoundComponent`），新增路由时按现有手段（ErrorBoundary 组件）包裹，不要假定框架层已经兜住。

**放置矩阵**（规则；当前落地情况见 §7.3）：

| 层级 | 包裹范围 | 位置 | 关键/非关键 |
|------|----------|------|------------|
| 根布局 | 整个应用 | `__root.tsx` 最外层 | 关键（兜底） |
| Agent 面板布局 | `_panel.tsx` 路由布局 | 包裹 `{children}` 出口 | 关键（Agent 页整体） |
| ChatPanel | 聊天交互面板 | `ChatPanel` 根组件 | 关键（核心功能） |
| ArtifactsPanel | 输出展示面板 | `ArtifactsPanel` 根组件 | 非关键（可降级） |
| Sidebar | 左侧导航 | `AgentSidebar` 根组件 | 非关键（可降级） |

```tsx
import { ErrorBoundary } from "react-error-boundary";

function ChatPanelFallback({ error, resetErrorBoundary }: FallbackProps) {
  return (
    <div className="flex flex-col items-center gap-3 p-6">
      <p className="text-sm text-muted">{t("errors.panelCrashed")}</p>
      <Button variant="outline" onClick={resetErrorBoundary}>{t("common.retry")}</Button>
    </div>
  );
}

<ErrorBoundary FallbackComponent={ChatPanelFallback} onError={(err) => console.error("ChatPanel 崩溃", err)}>
  <ChatPanel />
</ErrorBoundary>
```

### 7.2 降级策略

- `FallbackComponent` 必须提供**重试按钮**（调用 `resetErrorBoundary`）。
- **降级 UI 不得渲染 `error.message`**——它可能含内部实现细节与后端文案。用固定的本地化文案，原始错误只进 `console.error`。
- 降级 UI 不应改变页面布局结构，避免级联布局崩溃。
- `onError` 必须 `console.error` 记录原始错误；关键/非关键面板都可收缩为最小化状态（如一条错误提示条）。
- 降级 UI 本身就是用户可见反馈，**不需要**额外 `toast.error`。

### 7.3 现状偏离

- **全仓只有 3 个 ErrorBoundary**：路由级 `react-error-boundary`（`routes/view/$prodViewId.tsx`，带重试按钮）、`StreamdownErrorBoundary`（`chat/primitives/message.tsx`，降级为纯文本）、`FileViewerErrorBoundary`（`components/preview/FileViewerPreview.tsx`）。**§7.1 的放置矩阵基本未落地**——`__root.tsx`、`_panel.tsx`、`ChatPanel`、`ArtifactsPanel`、`AgentSidebar` 均未包裹，统一的 `ErrorFallback` 组件也不存在。新页面不要因为"反正都没有"继续省略。
- **`FileViewerErrorBoundary` 的降级 UI 直接渲染 `error.message`**（违反 §7.2），且该文件的中文兜底文案未走 `t()`。
- **所有边界只做 `console.error`，无任何上报通道**。

## 8. WebSocket / 实时通信

### 8.1 实时通道登记

前端与后端的实时连接**只有三条**，新增通道必须先在这里登记（路径、建连点、鉴权方式、重连策略）：

| 通道 | 路径 | 建连点 | 鉴权 | 重连 |
|------|------|--------|------|------|
| Chat 状态同步（Yjs） | `ws(s)://<host>/acp/yjs/:agentId` | `packages/agent-runtime/web/yjs/yjs-ws.ts` 的 `buildYjsUrl` → `@fenix/chat-channel` 的 `createYjsWsClient` | 会话 cookie + query `active_org_id`（**组织 id 直读 localStorage，见 §3.6**）；无 `Authorization` 头 | 指数退避，终态码不重连（§8.3） |
| 文件树事件 | `ws(s)://<host>/web/file-events` | `apps/web/src/components/agent-panel/use-file-tree-events.ts` | 同上 | 组件内自持 |
| Workflow 运行事件（SSE） | `/web/workflow/:id/events` | `packages/resources/workflow/web/api/workflow-sse.ts` | `withCredentials: true` | 每个 workflowId 一条独立 `EventSource`（禁止模块级单例）；前端以 `?fromSeqNum=` 续传，服务端另接受 `Last-Event-ID` 头 |

**不得在组件里拼装后端 URL**——通道二当前的 URL 拼装写在组件里，属已知偏离（§8.6）。

### 8.2 连接生命周期

- **建立**：`gateway.handleOpen` 认证 → `ensureRunning` → 打开 Chat Doc / Session Doc → **`relayReady = true` 之前发送初始快照** → `connect` 握手 → flush 缓冲消息。
- **前端建连守卫**：`use-chat-panel-runtime.ts` 在登录态 loading / failed 时早退，无 `sessionId` 不建连——**登录态未就绪不得建连**。
- **断开**：`handleClose` 释放连接级资源与 relay 引用计数；Agent 实例存活时重连后由 `handleOpen` 重新同步；`relay_closed`（实例断链）才销毁 Doc。
- **心跳**：前端每 30s 发 `{ type: "keep_alive" }`（仅页面可见时），服务端每 30s 下发 `keep_alive`。**服务端不再因客户端心跳超时而关闭连接**（客户端暂停心跳如页面冻结是被允许的）。`ping` / `pong` 属 acp-link 机器侧协议，不是前端聊天通道的心跳。

### 8.3 重连与终态码

客户端指数退避重连（1s → 2s → 4s → 8s → 16s → 30s），连续 6 次短连接（<30s）后停止（`chat-channel/src/transport/ws.ts` 的 `NO_RECONNECT_CODES` 与 `RECONNECT_DELAYS`）。**终态判定与 UI 语义的唯一来源是同一张策略表**：`chat-channel/src/transport/ws-close-codes.ts` 的 `WS_CLOSE_CODE_POLICY`（逐码两列 `stopReconnect` / `uiCode`，另有 `nonTerminalReason`）；`ws.ts` 的 `NO_RECONNECT_CODES` 与 `agent-runtime/web/yjs/yjs-ws.ts` 的 UI 语义视图都由它派生（2026-09-22 收敛，`88d59ff6`），**改行为只改这张表**。下表是它的可读视图：

| 关闭码 | 语义 | 前端行为 |
|--------|------|----------|
| 4001 | 实例空闲被回收（`instance_idle_reclaimed`） | 停自动重连；**切回前台时自动重连** |
| 4004 | 环境不可用（`environment_unavailable`） | 停自动重连，展示后手动恢复 |
| 4500 | 机器离线（`machine_unavailable`） | 停自动重连，手动重试 |
| 4501 | 客户端 keepalive 超时（`client_keepalive_timeout`） | 停自动重连；**切回前台时自动重连** |
| 4502 | spawn 永久拒绝（`spawn_rejected`，autoStart 关闭 / 并发上限等） | 停自动重连，按 `payload.code` 展示原因 |
| 4503 | 机器已被占用（`machine_already_connected`） | 停自动重连（`stopReconnect: true`）；`uiCode` 在策略表里**显式为 `null`**——缺口登记在该行，不是散落的遗漏（见下与 §8.6） |
| 1013 | 连接数超限（`too_many_connections`） | **不停自动重连**（`stopReconnect: false`，靠退避 + 短连接计数收敛）；只有 UI 语义是终态（`uiCode: "too_many_connections"`） |
| **1013（例外）** | 慢消费者追赶超时（close reason = `slow consumer resync timeout`） | **非终态**（`nonTerminalReason` 命中时 `uiCode` 取 `null`）：自动重连后走全量快照同步，不得展示"须手动恢复" |

**两个问题、两张视图、一张表**：传输层问的是"停不停自动重连"（`stopReconnect`），UI 层问的是"给用户什么语义"（`uiCode`），成员集合可以不同，所以 `WS_CLOSE_CODE_POLICY` 逐码登记两列、两个消费方各自派生自己的视图，`chat-channel/src/__tests__/ws-close-codes.test.ts` 把这两列与收敛前的字面量钉成基线（改表即同时改两层行为，两处基线测试必须一起过）。4503 的缺口在表内被显式登记（`uiCode: null`），见 §8.6。

**当前零调用点（按本仓「零消费导出保留 + 登记」的口径处置，不要顺手删）**：`getTerminalYjsWsErrorCode()`（`agent-runtime/web/yjs/yjs-ws.ts`）与可见性触发的自动重连规则 `shouldAutoReconnectOnVisible()`（`apps/web/src/pages/agent-panel/chat-visible-reconnect.ts`）在生产代码里都没有调用方——前者只剩包内用例逐码断言（`agent-runtime/web/__tests__/yjs-ws.test.ts`），后者只剩 `apps/web/src/__tests__/chat-visible-reconnect.test.ts`（该模块仍被 `use-chat-panel-runtime.ts:39` 取用其状态类型）。线上连接错误展示走服务端 `error` 帧 → `classifiedError` → `PublicErrorCard`（`use-chat-panel-runtime.ts:281`、`ChatPanel.tsx:120`），不经过这两个入口；是否重新接线或退场待裁定。

### 8.4 消息类型

| 类型 | 方向 | 说明 |
|------|------|------|
| `action`（commandId 信封） | 前端 → 后端 | 会话操作（send_prompt / cancel / load_session 等），`commandId` 幂等去重 + `accepted → committed` 两阶段 Ack |
| `keep_alive` | 双向 | 可见性标记与心跳 |
| Yjs 增量（`chat:` / `session:`） | 后端 → 前端 | 双 Doc 状态广播（消息时间线、会话元信息、权限、工具调用） |
| `action_ack` / `action_error` | 后端 → 前端 | 操作确认与稳定错误码 |
| `error` | 后端 → 前端 | 连接级错误（携带终态码对应 `payload.code`） |

**背压由服务端承担**：发送积压超过 64 KB 时服务端跳过该次发送，并在缓冲回落后**主动定向补发全量快照**（不需要客户端重连——`broadcaster.ts` 的注释明确写了不再依赖"下次重连"，属静默恢复）；持续滞后超过 30s 才 `close(1013, "slow consumer resync timeout")` 交回客户端重连路径。前端**不实现背压**，不要按"客户端要限流"的思路改代码。

### 8.5 前端 Chat 约束

以下约束共同保证刷新恢复、多标签页一致性与消息不重复，改动 Chat 相关代码前必须逐条确认：

1. **`rcsSessionId` 必须确定性生成**（`createDeterministicRcsSessionId`），不得用 `Date.now()` 或随机值——否则刷新后旧 Y.Doc 不可达。
2. **初始快照先于 `relayReady`**：服务端在 WebSocket open 时先发 Chat Doc 与 Session Doc 快照（前端侧是 state-vector 帧）。
3. **重连时必须恢复 `acpSessionId`**：服务端在 `handleOpen` 里读 Session Doc 的 `root.session.sessionId` 回填 `entry.acpSessionId`（`chat-channel/src/channel/gateway.ts`）——旧的 `chatMeta.activeSessionId` 字段已随 schema 重构删除，不要再引用。同一 ACP session 的 `load_session` 必须跳过 Agent 全量回放。
4. **`cwd` 由服务端 translator 注入**；Agent status 到达前不得发送 `list_sessions`。
5. **Doc 名固定为 `chat:{rcsSessionId}` / `session:{rcsSessionId}`**，广播必须按 `rcsSessionId` 隔离，禁止全局广播会话数据。
6. **用户消息只由后端写入 Y.Doc**。前端不得维护第二份 `localUserEntries` 之类的本地副本，否则 Agent 回显会造成双写。
7. **会话切换与内容清理走"换代"**：由 `DocManager.replaceProjection` 完成（`session-channel.ts` 调用）。**不要**使用 `chat-writer.ts` 的 `clearSessionDocContent`（零生产调用点，且 `docs/arch/19-yjs-chat-streaming.md` §4.2 明确禁止回到旧的清空流程），也不要用 destroy + recreate 制造异步竞态。`create_session` 同样必须先清空旧 Session Doc。
8. **同一 `instanceId + userId` 的多标签页共享一个 relay handle**；引用计数归零后才释放；切换 session 时同步同组客户端的 `acpSessionId`。
9. **连接上限与容量**：`YJS_MAX_CLIENTS` 默认 200，由 agent-runtime 模块声明并经 `AgentRuntimeModuleConfig.yjsMaxClients` 注入 chat-channel 装配（不要直读 env）。修改时必须保留限流、资源释放与单连接故障隔离。
10. **`ChatView` 与 `EntryRenderer` 使用 `React.memo`**，comparator 必须与调用方 prop 稳定性保持一致（`ChatView.tsx`、`EntryRenderer` 有显式逐 prop 比较，`MessageResponse` 比较 `children` + `envId`）。改动 props 时同步更新 comparator 与渲染测试。
11. **`@fenix/chat-channel` 根入口必须浏览器安全**：根入口只导出类型（`./types`）、schema、`public-error`、`chat-writer`、`yjs-store`、`protocol`、`transport`、`util`；服务端能力（channel 控制面、persist 持久化、state 聚合层）必须经 `@fenix/chat-channel/server` 导出。边界由 `packages/chat-channel/src/__tests__/chat-channel-browser-surface.test.ts` 静态走值导入图守护（`scripts/check-architecture.ts` 的 `browser-entry-server-import` 同时静态拦截 `@fenix/chat-channel/server`）。

> Chat 状态消费用 `useChatState` / `useSessionState`（`@fenix/agent-runtime` 根出口），Yjs URL 构造与客户端包装在 `packages/agent-runtime/web/yjs/yjs-ws.ts`。服务端生命周期见 `packages/chat-channel/src/channel/gateway.ts` 与 `docs/arch/19-yjs-chat-streaming.md`。

### 8.6 现状偏离

- **两条 WS 通道的组织 id 都直读 `localStorage`**（`yjs-ws.ts`、`use-file-tree-events.ts`），绕过组织上下文；WS 无法带自定义头，需要契约化的参数传递方式才能收口（同 §3.6）。
- **`/web/file-events` 的 URL 拼装写在组件里**（`use-file-tree-events.ts`），违反"不在组件中拼装后端 URL"。
- **前端零背压实现**：发送只判 `readyState`，依赖服务端 `close(1013)` 兜底。
- **`clearSessionDocContent` 仍在 `chat-writer.ts` 中导出并保留生产引用**：它零生产**调用**，但 chat-channel bootstrap 把 `prepareClearSessionSnapshot` 作为回调注入快照写入路径——删函数会打断生产编译，收口时要连引用一起清。
- **4503 的 UI 语义缺口（缺口本身已显式登记，本批不补）**：4503（`machine_already_connected`）在 `WS_CLOSE_CODE_POLICY` 里是 `stopReconnect: true` + `uiCode: null`（`chat-channel/src/transport/ws-close-codes.ts`），用户会看到"连接停了但没有任何提示"。**补齐 `uiCode` 是行为变化**（原先静默的路径会开始出现错误提示），必须单独一批、单独授权，不要以"消缺口"为由顺手补；裁定前保持 `null` 并在策略表注释里保留指向本节的位置（见 §8.3）。
- **`CLAUDE.md` 的 YJS/Chat 不变量第 7 条仍写"清理会话内容使用 `clearSessionDocContent`"**，与 `docs/arch/19-yjs-chat-streaming.md` 及当前实现冲突；以本文档 §8.5 第 7 条为准，`CLAUDE.md` 待同步。

## 9. i18n 国际化

技术栈：`i18next` + `react-i18next` + `i18next-browser-languagedetector`，经 `initReactI18next` 全局单例装配（**不是** Provider）。

### 9.1 使用

```tsx
import { useTranslation } from "react-i18next";
import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n";

const { t } = useTranslation(TASKS_V2_NS);

t("title");                             // 扁平 key
t("form.name.label");                   // 点号分层
t("toast.saved", { name: item.name });  // 插值：双花括号
```

**插值必须用 `{{var}}`**。单花括号 `{var}` 会被 i18next 当作字面文本原样输出，是静默失败——界面上会出现裸露的 `{var}`。全仓仅 `model-management` 字典里 2 处 `{env:NAME}` 是**有意**的字面展示（配置占位符长相如此），除此之外不要引入单花括号。

### 9.2 命名空间与归属

命名空间与词条**归属 owner 包**，宿主只做装配：

```ts
// apps/web/src/i18n/index.ts —— 宿主只登记，不写域内词条
import { TASKS_V2_NS, tasksV2Resources } from "@fenix/resource-task/web/i18n";

const packageResources = { en: { ...tasksV2Resources.en, ... }, zh: { ... } };
const resources = { en: { ...hostResources.en, ...packageResources.en }, zh: { ... } };

i18n.use(initReactI18next).init({
  resources,
  ns: Object.keys(resources.en),   // ns 列表从已登记资源反推，不手写数组
  fallbackLng: "en",
  defaultNS: NS.COMMON,
  detection: { order: ["localStorage", "navigator"], lookupLocalStorage: "rcs-lang", caches: ["localStorage"] },
});
```

**新增命名空间的完整步骤**：

1. 在 owner 包内建 `packages/<group>/<pkg>/web/i18n/`，导出 `<DOMAIN>_NS` 与 `xxxResources`，经该包 `exports["./web/i18n"]` 公开。
2. **NS 常量与字典拆成两个模块**（`namespace.ts` 只持常量，`index.ts` 持资源）：`useTranslation(NS)` 不应把整份字典拉进模块图。
3. 宿主 `apps/web/src/i18n/index.ts` 的 import 与两张资源表里登记该包；`ns` 会自动派生。
4. 消费方从包出口取 NS：`import { TASKS_V2_NS } from "@fenix/resource-task/web/i18n"`，不写字面量。
5. 只有真正跨资源包共用的词条才进 `@fenix/web-runtime/i18n/namespace` 或 `@fenix/ui-components/i18n/namespace`。

> `@fenix/ui-components` 的 i18n 出口是 **`./i18n` 与 `./i18n/namespace`**（不是 `./web/i18n`），写后者会解析失败。原因见该包 `package.json` 的历史形态。

### 9.3 规则

- 禁止在 JSX 中硬编码用户可见字符串。
- 命名空间用包的 `NS` 常量，不写字符串字面量。
- 中文注释与 `console.log` 不受 i18n 限制。
- **en / zh 的 key 必须对称**；新增 key 时同批补齐两种语言，并同步包内 `web/__tests__/*-i18n.test.ts` 的基线。
- **日期、数字、相对时间必须取当前 locale**，不得在共享组件中固定 `zh-CN`。
- **API / domain 错误按稳定 error code 映射到 message key**；未知错误使用安全通用文案，**不展示 raw message**。Chat 域是样板（`public-error-text.ts` + 协议侧约束 + `public-error-i18n.test.ts`）。
- **纯逻辑模块与后端不得 import UI i18n 或图标依赖**（见 §10）。

### 9.4 现状偏离

- **全仓级 key 对称没有门禁**：资源包侧有 14 份 `packages/**/web/__tests__/*-i18n.test.ts`（覆盖"键集一致、占位符一致、`t()` 字面量键齐备、无越域泄漏"），宿主侧另有 `apps/web/src/__tests__/host-i18n.test.ts` 与 `public-error-i18n.test.ts`。覆盖面已不窄，但**跨包漏注册**仍无专门检查；`precheck` 也没有 i18n 步骤。
- **无 `i18nKey` 编译期类型**：没有 `CustomTypeOptions` 或键生成脚本，写错的 key 只有在运行时回退成字面量才被发现。
- **硬编码用户可见文案**：2026-09-23 的收口批次把 `agent-config/AgentSitesCard.tsx`（6 处）、`knowledge/ChunkDetailSheet.tsx`、`task/TasksPanel.tsx`、`task/TaskForm.tsx`（3 处）与 `ui-components/FileViewerPreview.tsx`（内置预览文案 + 错误边界提示）的文案全部改走各包字典（键分别落在 `agents` / `knowledge` / `tasksV2` / `uiComponents`）。剩下的两处是**有意保留**、且已登记的：`ui-components` 的 `html-plugin.ts`（标签「渲染预览」/「源码」与三条提示——插件直接操作 DOM、不在 React 树内）与 `preview-source.ts`（`文件预览加载失败 (<status>)`——纯逻辑模块不得 import UI i18n，见 §9.3）；两处接文案都要在契约上新增参数，影响范围与移除条件见该包 README「已知限制」第 12 / 13 条。
- **首屏静态加载全部语言与全部 namespace**，未按 route / feature 拆分懒加载。
- **语言切换没有 UI 组件**：检测、`rcs-lang` 持久化与 `fallbackLng` 都是宿主启动决策。

## 10. 样式

**默认用 Tailwind v4 工具类，别写 CSS。** 全部纪律就下面这些：

- **配置只在 CSS 里**：Tailwind v4 CSS-first，仓库没有 `tailwind.config.*`。token 写在 `@theme`，自定义工具类（`@utility`）**只在宿主** `apps/web/src/index.css`。
- **两个入口，两份副本**：宿主 `apps/web/src/index.css` 与包入口 `packages/ui-components/web/styles/theme.css`（经 `@fenix/ui-components/styles.css` 暴露）持有**逐字重复**的 token——含品牌色、`surface-0..3`、`text-bright/primary/secondary/muted/dim`、`status-*`、shadcn 语义族、布局变量（`--navbar-height` 等）与字体变量。改 token 必须同批改两份，**没有任何一致性测试兜底**。
- **`@source` 只扫 `packages/**/web/**`**：组件源码放错位置（如 `packages/<pkg>/components/`）其工具类**不会被生成**——症状是样式静默消失，不是报错。这条由 `scripts/__tests__/app-entry-paths.test.ts` 固化，也是 §1 那条硬规则的由来。
- **优先 token 类而不是 `dark:` 变体**：`dark:` 变体确实与 `.dark` token 块同源了（两个主题入口都已声明 `@custom-variant dark (&:where(.dark, .dark *))`，见 §3.2），但 `.dark` 在应用内无法被触发，写 `dark:` 等于写死一段不会生效的样式；仍应写 `bg-surface-1` / `text-muted`。
- **`cn()` 唯一来自 `@fenix/ui-components/lib/cn`**；宿主 `apps/web/src/lib/utils.ts` 的遗留副本与 `@/src/lib/utils` 别名已随 2026-09 去重删除，不要再建第二份。
- **独立 `.css` 文件只许四类**：① token 入口（`index.css`、`theme.css`）；② **第三方渲染覆盖表**，判据是第三方 DOM **没有 className 挂载点**且第三方 CSS **未分层**（当前唯一实例：`ui-components/web/components/preview/overrides.css`，它也是 `web/components/` 下**除类别 ③ 伴随表外**仅存的 `.css`）；③ **深层样式伴随表**——与源文件同目录、同名的 `.css`，承载**无法用扁平工具类表达**的选择器嵌套／复合表达式值／无标准变体的媒体查询（判据与口径见 `forbidden-code-patterns.md` §「存量清理结果」，门禁 `bun run check:web-style`）；④ 迁移未完成的历史页面级样式表——**不鼓励**，见下。
- **类别 ② 的三条约束**（照 `overrides.css` 文件头执行）：保留未分层、靠导入顺序取胜，**不要改写成工具类**；**拒绝 `!important`**（全仓现有 6 处 `!` 修饰工具类都属待清理遗留，不要增加）；覆盖选择器必须带第三方类名前缀（如 `ofv-*`）。
- **类别 ③ 的三条约束**：文件名与源文件严格同名同目录（`AgentEditorChrome.tsx` ↔ `AgentEditorChrome.css`），由持有该样式的模块顶部 `import` 引入；类名优先沿用源码注释里记录的**源选择器名**，否则用 `kebab-case` 语义名；**不包 `@layer`**（未分层才能压过 `@layer utilities`），但每处下沉都要逐条确认胜负关系没变——原写法若会被消费方 `className` 覆盖，就不能整条下沉。
- **新增 `.css` 的落位**：现有形态——`ui-components/web/chat/css/*.css`（3 份，模块级）、`web/styles/theme.css`（token）、**与源文件同目录同名的伴随表**（类别 ③）、以及与页面同目录的 `xxx.css`（历史遗留，类别 ④）。**新代码只用前三类**；确实必须写 CSS 时优先放组件同目录、命名与组件同名，不要新增页面级样式表。
- **图标**：通用图标只用 `lucide-react`，**禁止内联 SVG**；模型图标走 `<ModelIcon modelId size variant>`（`model-management/web/components/model-icon/ModelIcon.tsx`），**禁止直接 `import "@lobehub/icons"`**（`model-icon-boundary` 规则强制，见 §11.2）。**纯逻辑模块不得依赖 UI 图标包**（后端与纯逻辑测试也不得**间接**加载）——`@lobehub/icons` 依赖 `antd-style`，后者在模块加载期裸调 `matchMedia`，无 DOM 的 `bun test` 进程里加载即崩。
- **字体**：系统字体栈，**禁止外部字体链接与 `@font-face`**；`--font-sans` / `--font-display` / `--font-body` 三者同值，`--font-mono` 独立，均应用在 `html, body`。
- **禁止 `@apply`**（当前零使用，不要引入——它会把"工具类 vs CSS"变成第三种说不清的形态）。

### 10.1 现状偏离

- ~~**`dark:` 变体与 `.dark` 类不同源**~~ 已消解（2026-09-23）：两个主题入口都声明了 `@custom-variant dark (&:where(.dark, .dark *))`，`dark:` 变体与 `.dark` token 块同源；30 个文件里的 `dark:` 一律保留但在应用内不会命中（系统深色偏好不再能让它们生效）。全站强制亮色见 §3.2。
- **页面级 `.css` 大量残留且无登记**（实测于 `f73f9265`，2026-09-23；重跑下面那条命令即可复算）：宿主 `apps/web/src` **5 份 / 1811 行**（含 `shell/agent-panel.css` 677 行、`shell/artifacts-workspace.css` 376 行、`pages/auth-light-brand.css` 371 行）、资源侧 `packages/**/web` **12 份 / 2416 行**（含 `workflow/workflow.css` 640 行、`task/.../agent-tasks.css` 480 行、`model-management/.../agent-models.css` 278 行、`knowledge/.../agent-knowledge.css` 268 行、`platform/identity/.../agent-api-keys.css` 209 行）。它们与业务 tsx 里的自定义类名联动（如 `agent-tasks-page`），迁移时两者必须同批改。

  **计数口径**（就是 §10 四类里**剩下的那一类**，排除项逐条对齐类别 ①②③）：

  - **计入**：`apps/web/src/**/*.css` 与 `packages/**/web/**/*.css` 中**没有同目录同名 `.tsx` / `.ts` 兄弟**的 `.css`；
  - **排除**：① token 入口 `apps/web/src/index.css`（781 行）与 `ui-components/web/styles/theme.css`（272 行）；② 第三方覆盖表 `ui-components/web/components/preview/overrides.css`（43 行）；③ 类别 ③ 伴随表 **68 份 / 3857 行**（64 份配 `.tsx` 兄弟、4 份配 `.ts` 兄弟）；④ `ui-components/web/chat/css/*.css`（3 份 / 148 行，模块级表，§10 单列）；
  - **口径外**：`ui-sandbox/`（独立演示应用）、`docs/**`（VitePress 主题）、`e2e/playwright-report/**` 与 `tmp/**`（产物与临时目录）、`.worktrees/**`、`node_modules`/`dist`，以及 `packages/ui-components/demo/demo.css`（包内 demo，不在 `@source` 扫描范围内）；
  - **边界一例**：`ui-components/web/chat/primitives/conversation-scroll.css` 的源文件叫 `conversation.tsx`（不同名），按上面的机械规则落进本类——它是模块级表而非页面表，这是机械规则的已知代价。

  ```bash
  # 逐文件分类 + 汇总（仓库根目录执行；输出即上面四类的份数与行数）
  { find apps/web/src -name '*.css' -not -path '*/node_modules/*' -not -path '*/dist/*'
    find packages -path '*/web/*' -name '*.css' -not -path '*/node_modules/*' -not -path '*/dist/*'; } | sort | while read -r f; do
    base=${f%.css}
    if [ "$f" = apps/web/src/index.css ] || [ "$f" = packages/ui-components/web/styles/theme.css ]; then kind=token
    elif [ "$f" = packages/ui-components/web/components/preview/overrides.css ]; then kind=override
    elif [[ "$f" == packages/ui-components/web/chat/css/* ]]; then kind=chat-module
    elif [ -f "$base.tsx" ] || [ -f "$base.ts" ]; then kind=companion
    else kind=page; fi
    printf '%s\t%s\n' "$kind" "$(wc -l < "$f" | tr -d ' ')"
  done | awk -F'\t' '{n[$1]++; l[$1]+=$2} END {for (k in n) printf "%-12s %2d 份 %5d 行\n", k, n[k], l[k]}'
  ```

  **别用「上次的数字 ± 本批增删」维护这两行**：v3.0.5 记下的「伴随表 66 份 / 3348 行」，66 取自 `21a8bffa` 提交信息「新增伴随表 66 份」那句——那是**该次下沉新增的文件数**（该提交前全仓只有 1 份伴随表，提交后全仓实测 66 份 / 3499 行，3348 行对不上），v3.0.7 再按「删掉一张 513 行的表」做加减得 67 份 / 3391 行，于是与实测一路偏离（v3.0.8 重测为 68 份 / 3792 行、`f73f9265` 重测为 68 份 / 3857 行）。**改这一节就重跑上面的命令**，不要接着算。

  2026-09 的 Tailwind 迁移已把此前的基数压下来（`agent-editor.css` / `-design.css` / `-responsive.css` 三表随 `bfd63e52` 删除；`agent-panel.css` 由 919 行降到 677、`artifacts-workspace.css` 由 664 行降到 376；`agent-organizations.css` 513 行随 2026-09-23 的组织页工具类转换整片删除，只留同目录同名的伴随表 `agent-organizations-workspace.css`——本批由 43 行扩到 92 行，随后 `f73f9265` 删去其中为目录写的三条覆盖后为 **57 行**），但**剩余部分仍未登记**。
- **`tw-animate-css` 声明了依赖但源仓库从未 `@import` 它**（只在包内 demo 的 CSS 里导入过），因此 shadcn 过渡动画工具类在应用中是空操作（已在 `ui-components` README 登记）。包内已知限制的完整清单见 `packages/ui-components/README.md`，以那里为准，不在此重复。

## 11. 开发落地清单

### 11.1 提交前自检

- [ ] **`bun run precheck` 通过**（15 步，见 §11.2）
- [ ] **前端改动额外跑 `bun run build:web`**（后端从 `apps/web/dist/` 挂载静态资源，类型检查通过 ≠ 构建通过）
- [ ] `precheck` 覆盖不到的前端测试已单独跑：`bun test apps/web/src/__tests__/`
- [ ] 每个 `test(...)` 上方有一行中文注释说明行为与业务意图
- [ ] 用户可见字符串全部走 `t()`；插值用 `{{var}}`；en / zh key 对称
- [ ] 导航使用 `useNavigate()` / `<Link>`，未使用 `window.location` 写操作
- [ ] 新增页面：路由壳放 `apps/web/src/routes/agent/_panel/`，页面实现放 owner 包 `web/pages/` 并经懒加载引入（见 §2.5）；已在 `web/contribution.ts` 加导航项并补包字典
- [ ] 新增路由后跑过一次 dev 或 build（`routeTree.gen.ts` 才会重生）
- [ ] API 调用经域模块，且已 `unwrap()` 或显式判断 `success`；组件中无裸 `fetch`、无自拼后端 URL
- [ ] 失败没有被映射成 empty 或成功状态
- [ ] 跨包引用经各包 `exports`；未新增指向 `packages/**` 的别名；vite 与根 tsconfig 两张别名表同步
- [ ] 单文件未超 500 行
- [ ] Loading 态有骨架屏守卫；Empty 态有占位提示
- [ ] 表单使用 `FormDialog` + `formConfig`（react-hook-form + zod），不手写 `useState` 校验
- [ ] Dialog `onOpenChange` 中清理状态；表单重置用 `key`
- [ ] 无 `dangerouslySetInnerHTML` 不经清洗使用；新增 iframe 显式声明 `sandbox`
- [ ] 无 API Key / Token 存入 localStorage；无原生 `confirm()`
- [ ] 改动过 UI 结构时：`packages/ui-components` 的 `web/index.ts` 与 `exports` 已同批更新

### 11.2 自动化检测

**`bun run precheck` = `scripts/ci.ts` 的 15 步**，顺序为：format → import-sort → `generate:module-registry --check` → `generate:web-contributions --check` → `check:root-owner-inventory` → `check:schema-ddl-drift` → `architecture` → tsc(server) → tsc(web) → tsc(app skeletons) → `check:dependencies` → lint → 三批 `bun test`（`apps/server/src/__tests__/ scripts/__tests__/ packages/platform/platform-sdk/src/__tests__/`、`packages/`、`apps/web/src/__tests__/`）。

其中三处与前端直接相关：

#### 硬红线（`scripts/check-architecture.ts`，零容忍）

| 规则 id | 约束 |
|---------|------|
| `browser-entry-server-import` | 浏览器生产代码（`apps/web/src/**`、各包 `web/**`）不得导入 `node:*`、`@server/*`、`@fenix/chat-channel/server`；测试代码可使用服务端测试工具 |
| `package-no-internal-imports` | 跨 workspace 包不得绕过公开导出访问 `@fenix/*/src/*`、`@fenix/*/web/src/*`，也不得用相对路径越界到其他包的 `src/`、`web/src/`、`db/` |
| `zod-v4-entrypoint` | Zod 必须从 `zod/v4` 导入 |
| `model-icon-boundary` | `@lobehub/icons` 只能由 model-management 的 `model-icon` 组件封装 |
| `frontend-no-legacy-api-prefix` | 经 `request()` 调用时不得使用 `/v1`、`/v2` 历史前缀 |
| `backend-no-route-imports` | （后端）Service / Repository 不得反向依赖 Route |

#### 边界规则（台账制，`scripts/lib/architecture-boundary-rules.ts`）

`undeclared-workspace-dependency`（导入 workspace 包但未声明依赖）、`apps-boundary`（`packages/**` 不得依赖各 app）、`special-dependency`（跨类别依赖矩阵 + 具体包禁则）、`web-package-not-to-app`（`packages/**/web/**` 不得用宿主别名或相对路径越界到 `apps/web`）。

这四条是**台账制**：只有**未登记的新增违规**才失败，豁免清单在 `scripts/architecture/exceptions.json`（逐条带 owner 与移除条件）。**已不再违规的条目要求删除**——修好问题后必须同步清理台账，不要让豁免过期。

#### dependency-cruiser（`bun run check:dependencies`）

规则名：`no-circular`、`no-cross-package-src:<pkg>`（每包一条）、`no-cross-package-db:<pkg>`（每包一条）、`platform-not-to-agent-runtime-resources-apps`、`agent-runtime-not-to-resources`、`ce-not-to-ee`（`<pkg>` 取的是工作区路径，如 `no-cross-package-src:packages/resources/task`）。它以**仓库根的 `tsconfig.json` 的 `paths`** 作为别名判定基准（见 §1.2）。

#### 浏览器安全入口守卫

各包的 `web/__tests__/*-browser-surface.test.ts`（当前 13 份，全在 `packages/resources/*`；`chat-channel` 的对应文件在 `src/__tests__/`）静态走根出口的**值导入图**，断言图中不出现服务端模块与 `node:*`。**新增包外运行时依赖时必须同步登记到该测试的白名单**——否则守卫会在别人的改动里失败。

#### 前端测试约定

- 框架是 **`bun test`**（无 vitest / jest）；`bunfig.toml` 只 preload 服务端侧垫片，**没有全局 DOM**。
- 需要 DOM 的用例自建 happy-dom Window，唯一入口是 `@fenix/ui-components/testing` 的 `initializeHappyDomWindow`（`HTMLElement` 与 `customElements` 必须**成对**注入，否则 streamdown 链路在用例之间崩）。
- 只测关键交互、状态与数据流，不写纯 UI 结构断言或仅重复类型检查的测试。
- **`react-i18next` 替身必须返回稳定的 `t`**：真身的 `t` 只在切语言时换身份，替身不能在 `useTranslation()` 里每次渲染新建对象或函数。"把 `t` 写进 `useCallback` 依赖、再用该回调喂 `useEffect`"的组件一旦碰上不稳定替身就会陷入反复拉取，**生产不复现**——纯属替身造成的假阳性（2026-09-22 在 `workflow/web/__tests__/workflow-versions-a11y.test.tsx` 上踩到，表现是 3 个用例 5s 超时，曾被误判成并发改动）。当前仍有 10 份 mock 用 `useTranslation: () => ({ ... })` 的写法，改到相关组件时顺手收口。

### 11.3 尚未自动化的规则

以下靠人工 review，不靠工具兜底：

| 规则 | 现状 |
|------|------|
| 组件中裸调 `fetch()` / `XMLHttpRequest` | 未自动化；现有例外点是登记制（§5.3） |
| 直接 `await` 域模块不解包 | 未自动化，签名层面无法区分 |
| `window.location` 写操作 | 无**全仓**门禁（当前生产代码零命中；`workflow/web/__tests__/workflow-page-route.test.ts` 只守 workflow 页面，`ui-components/web/testing.ts` 里的一处属测试工具） |
| `dangerouslySetInnerHTML` 不经清洗 | 未自动化（当前 3 处均已清洗） |
| `localStorage` 读写组织身份 | 未自动化（当前 2 处违规，见 §3.6） |
| 原生 `confirm()` / `alert()` / `prompt()` | 未自动化。2026-09-22 已全量复核：全仓零命中（4 处已迁 `ConfirmDialog`）；新增只能靠 review |
| `console.error` 缺配对用户可见反馈 | 未自动化，判据见 §5.8；2026-09-22 全量复核后仍有已知残留（见 §5.9） |
| iframe 的 `sandbox` 取值 | 未自动化 |
| 单文件 500 行上限 | 未自动化（当前 16 处超限，见 §4.8） |
| 组件重复开发检测 | 未自动化（当前 2 处本地重复实现，见 §4.8） |
| i18n 全仓 key 对称、`[object Object]` | 包级与宿主各有测试（14 份 `packages/**/web/__tests__/*-i18n.test.ts` + `ui-components` 的 `i18n-barrel.test.ts` + 宿主 `host-i18n.test.ts`），**跨包漏注册**无门禁（见 §9.4） |
| import 分组顺序、格式化 | 已由 Biome 覆盖（`import-sort` + `format`） |
