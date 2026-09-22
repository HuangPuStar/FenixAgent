# @fenix/ui-components

从 `apps/web` 抽取并纯化的通用 React UI 组件包，自带一个最小 Vite 展示页（demo）。本期只产出可消费的源码包，
不接入任何消费方、不做兼容层、不发布。

## 包定位

- 组件以 **TypeScript 源码**形式被消费方打包（`exports` 直指 `web/**/*.ts(x)`），不做 lib build；
  `bun run build` 只构建 demo 静态资源。
- 只依赖第三方 npm 包与 React 生态，**不依赖任何 `@fenix/*` 业务包**。
- 多租户、鉴权、请求、路由、i18n 单例等宿主职责一律不进入本包。

## 目录约定

```
web/                      组件源码；必须在 web/ 下
  index.ts                barrel
  lib/                    cn / i18n 命名空间常量 / theme / card-renderer
  styles/theme.css        设计 token（唯一样式入口）
  i18n/locales/{en,zh}/   包内文案，命名空间 uiComponents
  ui/ config/ chat/ components/ layout/
demo/                     Vite 展示页（非库产物）
```

**为什么必须在 `web/` 下**：宿主仓库的 Tailwind 约定是「应用壳 + 各包源码所在的 `web/` 目录」一起扫描
（见 `apps/web/src/index.css` 的 `@source`）。包内 `theme.css` 也用 `@source "../**/*.{ts,tsx}"` 反扫自身。
组件若放在 `web/` 之外，宿主与 demo 都不会扫描到其中的工具类，样式会被静默裁剪。

## 纯化决策（相对 apps/web 源实现）

| 位置 | 源实现 | 本包做法 |
| --- | --- | --- |
| `web/lib/cn.ts` | `@/src/lib/utils`（同文件还有 esc/formatTime/uuid 等） | 只保留 `cn`，其余工具属于宿主应用 |
| `web/lib/i18n.ts` | `@/src/i18n` 单例 + `NS.COMPONENTS` / `NS.COMMON` | 只导出 `UI_COMPONENTS_NS = "uiComponents"`，资源由宿主注册 |
| `web/lib/theme.tsx` | 源实现临时强制浅色，忽略 localStorage 与系统偏好 | 移除该 hack：初始主题取 localStorage，缺省回退 `defaultTheme`，`system` 跟随系统 |
| `web/lib/card-renderer.tsx` | `@/src/lib/card-renderer/registry` + context/emitter | 只保留注册表，去掉会话事件通道；初始注册表为空 |
| `web/chat/primitives/conversation.css`（**阶段三已迁并删除**） | `.chat-scroll-navigation` / `.chat-scroll-to-latest` 定义在 `packages/chat-channel/.../chat-design-shell.css` | 组件用到的样式随组件收进包内（逐字迁移），去掉跨包样式表依赖；其后随 chat 样式迁移改成 `conversation.tsx` 里工具类，本文件删除 |
| `web/chat/primitives/message.tsx` | `chat-markdown-content` 容器类由宿主 `MessageBubble` 注入，markdown 排版全挂在它上面 | 改由 `MessageResponse` 自身携带，独立使用时排版才生效（见「已知限制」第 8 条） |
| `web/layout/`、`web/components/` 中的颜色字面量 | 源实现混用精确 hex（`#e4eaf2`、`#17233a`、`#1a2944`、`#f6f8fb`、`#e7ecf3`、`#99a8bc` 等） | 换成最近的语义 token（`border-border`、`text-text-bright`、`bg-surface-0`…）。**与宿主存在可见色差，属有意取舍**（2026-09-18 确认保持 token 化）：等值的（`#1677ff`→`brand`、`#94a3b8`→`text-muted`、`#ffffff`→`surface-1`）无差异，等值的以外的若要求与源逐像素一致，需改回 hex |
| `web/components/preview/FileViewerPreview.tsx` | `buildPreviewUrl` 在组件内部硬编码宿主文件代理路由；重试参数固定用 `&` 拼接；`locale="zh-CN"` 与内置 `zhCNMessages` 中文写死 | `buildPreviewUrl` 提为可选 prop，默认值仍保留源实现（见「已知限制」第 9 条）；`&retry=` 改为按 URL 是否已含 `?` 选择分隔符（自定义构建器返回无 query 的 URL 时旧拼接会产出非法地址）；`locale` / `messages` 提为 props，默认值与源一致 |
| `web/components/preview/FileViewerPreview.tsx` 错误边界内的中文串 | 「预览组件加载失败」等提示硬编码中文 | 逐字保留：它是 React 边界内的兜底提示，不属于预览器文案，未纳入 props；需要多语言的宿主应在外层包一层本地化边界（见「已知限制」第 10 条） |
| `web/components/preview/overrides.css` | 宿主页面样式表里的预览工具栏修正（工具栏置底等） | 随组件收进包内，且必须与 `FileViewerPreview` 同目录并被其 `import`；缺失会导致预览工具栏回到顶部 |
| `web/components/preview/preview-source.ts` | `agent-panel/preview/utils.ts` 全量（含 `encodePathSegment`、`buildPreviewUrl`、`normalizeToUserPath`、`formatFileSize`） | 只取 L1–167 的分类表与源加载子集：URL 构建/路径规范化属宿主路由与展示约定。宿主 `ArtifactsPanel.tsx` 与 `preview-utils-normalize.test.ts` 仍引用原文件，故原文件保持不动 |
| `web/components/PreviewTab.tsx` | 宿主 tab 的占位容器，仅换 i18n 命名空间 | 未透传 `buildPreviewUrl` / `messages` / `locale`：需要预览定制时直接使用 `FileViewerPreview`，本组件保持最小契约 |
| `web/chat/timeline/ToolCallRow.tsx` | 完成态右侧显示状态词（`Done` / `已完成`）；运行中只有 `Loader2` 转圈 + 静态标题；错误信息内联在标题行内，长错误会把标题挤到看不见；另有 `publicError` 块（message + Type + ID）落在卡片右侧 | 完成态不渲染状态词（默认结果的噪音，其余状态词保留）；运行中标题文字套包内 `Shimmer` 基元做载入微光（图标位仍转圈）；错误信息独占第二行，随之为 `.tool-call-row-error` 补 `display: block`（否则该选择器的 `text-overflow: ellipsis` 对行内盒子失效）；移除右侧 `publicError` 块——其 message 与第二行同源（`narrate` 的 `errorDetail` 优先取 `publicError.message`），脱敏错误的 Type / ID 因此不再出现在卡片上 |
| `web/chat/timeline/TodoChanges.tsx` | 每条待办右侧带变更标签（`新增` / `已完成` / `进行中` 等底色 badge） | 去掉该标签：变更语义由左侧图标与文案样式表达，右侧标签是重复信息；随之删除 `CHANGE_STYLES.labelClassName` 与两个语言包里仅此处使用的 `chat.components.todoChanges.*` 文案 |
| `web/chat/primitives/message-attachments.tsx` | 图片 `alt` 固定取文件名，缺文件名时回落通用文案「Attachment」 | 新增可选 `alt` prop（优先于文件名），图片附件可传更准确的替代文本；缺省行为与源实现一致 |
| `web/chat/shell/internal/use-composer-input-bridge.ts` | 空状态建议提示词与消息「引用」经 window 自定义事件（`chat:apply-suggested-prompt` / `chat:quote`）从 `ChatView` 回环到 `ChatComposer`，生产与消费都在 chat 包内部 | 包内事件汇入宿主注入的 `subscribeExternal` 同一条通道（不新增注入端口）：宿主不注入任何订阅时这两个动作也必须生效。副产物是源实现按 `contextScope` 过滤 window 事件不再需要——本通道按 `ChatInterface` 实例分发，跨实例（主面板与 MetaAgentPanel）串扰在结构上不可能（2026-09-21） |
| `web/chat/css/chat-design-composer.css`（**阶段二已迁并删除**，现行实现见 `composer/ChatComposer.tsx` 的卡片工具类） | 卡片与元信息条的三条设计规则挂在宿主壳类 `.acp-main-root` 下（`.acp-main-root .chat-composer-card`、`:focus-within`、`.chat-composer-meta`） | 改用组件自身的 `.chat-composer-wrapper` 作前缀：特指度同为 (0,2,0)，与宿主补充段的级联关系逐条不变，但 `ChatComposer` 独立渲染时不再依赖宿主壳类 —— 否则元信息条失去 `display:flex`，本应同行的 `meta-main` / `meta-actions` 竖排成两行（demo 输入岛示例即此形态，2026-09-18 修正） |
| `web/chat/css/chat-design-status.css`、`chat-design-responsive.css`（**阶段四已迁并删除**，现行实现见 `panels/**` 的宽度/台阶工具类） | 交互区 / 状态面板宽度 `min(760px, calc(100% - 32px))`（窄屏 `calc(100% - 20px)`），与输入岛卡片等宽甚至更宽 | 改为比输入岛卡片每侧窄 16px（共 32px），形成台阶：`min(756px, calc(100% - 64px))`、窄屏 `calc(100% - 52px)`。源值只在宽列下比卡片窄 28px，列宽不足 792px 时与卡片完全齐平（2026-09-18） |
| `web/chat/css/chat-design-composer.css`（**阶段二已迁并删除**，现行实现见 `composer/composer-toolbar.tsx` 的 `bg-brand`） | `.chat-composer-send.is-stop`（turn 运行中，图标切成停止方块）底色为深墨蓝 `#25344a` | 改用包内 token `var(--color-brand)`：源色在浅色下近乎黑色、暗色下几乎融进背景，且与本包其余「主题色」入口不一致（`.is-ready` 的蓝、`PromptInputSubmit` 的 `bg-primary`）；尺寸、圆角与 `color: #fff` 保持不变（2026-09-18） |
| `web/chat/composer/CommandMenu.tsx`、`web/chat/css/chat-design-command-menu.css`（**阶段五整文件删除**：其中仅剩 popover/inline 外壳死代码，行内样式已全部迁入 `CommandMenu.tsx` 工具类） | 命令/技能行的名称是蓝色 `/{name}` 文本（`#3d5f95`，能力面板内 `#58739d`）且加粗（620 / 面板内 600），hover 与 `.is-active` 取 `#294d87` / `#f4f7fc`，选中勾选 `#5f83bd`；只有 MCP 行有 16px 图标列（技能行名称比 MCP 行名称左缩 22px）；行的提示与勾选是并列的网格子项 | 行首 `/` 改为 `Sparkles` 图标并独立成网格首列（技能行与 MCP 行的名称列因此对齐；图标取技能目录页 `getSkillIcon` 的兜底分支，见 `packages/resources/skill/.../agent-skills-catalog.tsx`）；名称改菜单正文色 `#263247` 且不再加粗（620 / 600 → 400），hover 底色改中性 `#f5f7fa`，勾选改与 MCP「已连接」同源的绿 `#25856e`，`.is-active` 左侧强调条改 `var(--color-brand)`；提示与勾选收进 `.chat-command-menu-tail`（源实现里两者同时出现的行会多出一个网格子项被挤到隐式第二行，34px → 47px）；插入草稿的文本仍是 `/${name} `，协议未变（2026-09-18） |

`ConnectionState`、`PermissionOption` 等原先来自 `@fenix/chat-channel` 的类型，改为包内同构联合类型/字面量结构类型，
避免把业务包拖进依赖图。

### 收录范围：只收录源自 `apps/web` 的组件

抽取过程中曾把 `packages/resources/{sandbox,memory,task}/web` 的 5 个组件一并纳入
（`SearchableSelect`、`TagFilterInput`、`SegmentedSwitcher`、`CronEditor`、`CollapsibleSidePanel`）。
这 5 个在 `apps/web` 中既无同名实现也无功能等价物，且 `apps/web` 不依赖任何 `@fenix/resources` 包
（`apps/web/package.json` 无相关依赖，源码中零 import），因此不属于「web 的通用前端组件」，已于 2026-09-18 删除，
连同它们的 barrel 出口、demo 示例、`cron` / `tagInput` 文案键与 `cron-parser` 依赖。

- 影响范围：这 5 个组件在源包（如 `packages/resources/task/web/pages/agent-panel/components/CronEditor.tsx`）
  中仍各自存在，删除只影响本包的覆盖面，不影响任何消费方——本包尚未被接入。
- 重新纳入的条件：先确认这些组件的宿主归属与真实消费方（谁渲染、谁提供文案与数据），
  再按同一套纯化约定单独评估，不要因为「看起来通用」而再次越过 `apps/web` 这条范围线。

同一条线在 2026-09-18 又清掉 4 个源自 `packages/agent-runtime/web/components/chat/` 的组件：
`PeriTaskList`、`PeriTaskViewCard`、`PeriTaskDetailSheet`、`TodoPanel`。它们在 `apps/web` 中同样没有
对应渲染组件（`apps/web/src/hooks/use-task-views.ts` 只派生投影数据，源码里没有这些组件的引用），属旧组件。

- 一并移除的接线：仅为详情抽屉存在的 `loadPeriTaskDetail` 宿主端口（`ChatInterface` / `ACPMain` /
  `chat-interface-types` 三处）、demo 的对应示例、`chat.components.todoPanel.*` 文案，以及仅这 4 个组件
  引用的 `chat.components.periTask.*` 键（`loading` / `reconnecting` / `unknownTitle` / `status.*`
  由 `ChatStatusPanel` 继续使用，故保留）。
- 保留的部分：`PeriTaskViewProjection` 等投影类型与 mock 样本仍在用（`ChatStatusPanel` 的 tasks Tab）。
- 详情入口的去向：不再由 `ChatInterface` 直接渲染抽屉，改为可选注入槽
  `renderPeriTaskDetail?: (task, close) => ReactNode`（`ChatInterface` / `ACPMain` 均透传）。
  宿主注入后，点任务行会把选中的投影与关闭回调交给宿主自己的抽屉（详情数据加载也在宿主侧）；
  不注入时任务行只读。这是 2026-09-18 与宿主对齐的结论：既有消费方 `packages/chat-channel`
  的 `ChatInterface` 仍在渲染 agent-runtime 的 `PeriTaskDetailSheet`，切到本包后必须继续保有该能力。
- 重新纳入的条件：先确认 Peri Task / Todo 面板的真实归属与消费方（谁渲染、谁提供数据与详情端口）；
  若确认抽屉是通用能力（不绑 agent-runtime），再连同本槽位一并收进包内。

同一条线在 2026-09-18 又清掉 `ContextPanel`（源自 `packages/chat-channel/web/components/ContextPanel.tsx`，
会话右栏：模型信息 / token 用量 / 工具调用统计 / 待确认队列）。宿主走自己的
`apps/web/src/pages/agent-panel/ChatArea.tsx`（CE 阶段 2 任务 1.6 T5b 从 `@fenix/chat-channel/web/chat-area`
迁入宿主，该说明符已不存在），从不渲染它；源 `ACPMain` 也一直传 `hideContextPanel={true}`，
即既有宿主路径下这块面板本就是隐藏的。

- 一并移除的接线：`hideContextPanel` prop（`ChatInterface` / `ACPMain` / `chat-interface-types` 三处）、
  `contextPanelOpen` 状态与右栏渲染块、demo 的 ContextPanel 示例、`chat.components.contextPanel.*`
  文案（13 键 × zh/en 两份字典）。
- 保留的部分：`renderEntries` 与 `promptUsage` 仍由 `ChatStatusPanel` 与输入岛上下文计使用；
  `createMockTokenUsage()` 仍是输入岛示例的样本来源。
- 影响范围：源包 `packages/chat-channel/web/components/ContextPanel.tsx` 原样保留（`packages/resources/knowledge`
  的 SSR 用例仍引用它），删除只影响本包覆盖面 —— 本包尚未被任何消费方接入。
- 重新纳入的条件：宿主出现渲染上下文面板的真实需求，并给出数据来源（`entries` / `acpUsage`）与折叠交互的宿主契约。

## i18n

本包不自带 i18n 实例。宿主渲染这些组件前必须把包内文案注册到 `uiComponents` 命名空间：

```ts
import en from "@fenix/ui-components/i18n/locales/en/uiComponents.json";
import zh from "@fenix/ui-components/i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/lib/i18n";

i18n.addResourceBundle("en", UI_COMPONENTS_NS, en, true, true);
i18n.addResourceBundle("zh", UI_COMPONENTS_NS, zh, true, true);
```

键名沿用源仓库 `components` 命名空间的末段路径（`components.codeBlock.copy` → `codeBlock.copy`），
另合并了 `common` 的 `preview` / `small` / `medium` / `large` / `fullscreen`。
两份语言文件的键结构必须保持一致。

## 已知限制

1. **未引入 `tw-animate-css`**：源仓库虽然在其 devDependencies 里声明了该包，但没有任何 CSS 实际 `@import` 它，
   因此 `animate-in` / `animate-out` / `animate-accordion-*` 在源仓库本就是空操作。本包保持现状一致，不引入。
   demo 例外：`demo/demo.css` 为展示过渡效果单独 `@import` 了它，该依赖因此只声明在 devDependencies，不随包产物分发。
   - 影响范围：依赖这些类的过渡动画（dialog、accordion 等）在源仓库同样没有动画。
   - 移除条件：源仓库正式引入 `tw-animate-css` 并在主题入口 `@import` 之后再同步。
2. **`status-badge-active` 是未定义类**：`config/StatusBadge.tsx` 使用该类，但源仓库与本包都没有定义它，不产生样式。
   - 移除条件：宿主提供该工具类，或改为包内 token 驱动的高亮。
3. **`@plugin "@tailwindcss/typography"`**：`tool` / `reasoning` 组件使用 `prose` 系列类名，主题入口因此声明了该插件，
   消费方编译本包 CSS 时需能解析到 `@tailwindcss/typography`（已列入 dependencies）。
4. **宿主外观只迁移「组件强依赖」的部分**：`theme.css` 带走了三条缺失即静默走样的全局规则——
   `*, ::before, ::after { border-color: var(--color-border) }`（包内 51 处只写宽度的 `border` / `divide-*` 依赖它，
   否则回落到 `currentColor`）、`:focus-visible { outline: none }`（组件自带 ring，缺它会双层描边）与
   `prefers-reduced-motion` 降级；两条原本全局的 streamdown 规则（隐藏 streamdown 代码块头部、放行浮动
   操作按钮点击）也随组件收进包内，现由 `chat/primitives/internal/markdown-classes.ts` 的容器变体
   （`[&_[data-streamdown=…]]:`）表达。
   以下仍是应用壳，不进入包内：`html, body` 的字号字体、sonner 定位、滚动条，以及
   `@utility tool-status-pill*` / `tool-call-*` 与 `@keyframes status-active-pulse` 等。
   chat 簇自己用到的关键帧（`loadingDotBounce`、`loadingDotBounceDark`、`shimmerSlide`、
   `chat-active-prompt-flash`、`agent-badge-pulse`）已收进包内 `web/chat/css/chat-animations.css`。
   - 影响范围：这些 `@utility` / `@keyframes` 的实际使用方是 `agent-runtime`、`chat-channel` 的组件
     （`ToolCallRow`、`AgentBadge` 等），本包 `ui/`、`config/`、`chat/` 下组件均不引用；
     后续批次若引入依赖它们的组件需重新评估。
   - demo 为观感一致，自行复制了 `html, body` 基准字号与滚动条，不随包分发。
5. **`ui/pagination.tsx` 的 `translationPrefix` 默认值为 `"runs"`**，其文案来自调用方注入的 `t`（非本包命名空间），
   本包字典不含该命名空间；消费方必须自行传入 `t`。
6. **未迁移 streamdown 表格全屏补丁**：源宿主在 `apps/web/src/main.tsx` 入口调用 `installStreamdownTablePatch()`，
   为 streamdown 全屏表格对话框补上缺失的 `data-streamdown="table-wrapper"`（缺失时全屏视图下的复制/下载按钮无响应）。
   该补丁依赖 streamdown 内部 DOM 结构，属于应用壳，未随组件进入本包。
   - 影响范围：仅 `chat/primitives/message.tsx`（`MessageResponse` 渲染 streamdown）的表格全屏视图；demo 未安装该补丁，
     需要该行为的宿主必须在自己的入口安装等价补丁。
   - 移除条件：streamdown 修复全屏表格缺失 `data-streamdown="table-wrapper"` 的行为。
7. **`MessageResponse` 的 `envId` 指向宿主文件代理路由**：传入 `envId` 时相对资源路径会被改写为
   `/web/environments/<envId>/fs/<path>?preview=true`（源宿主应用约定），本包不定义该路由。
   - 影响范围：不传 `envId` 时 URL 原样透传，组件不依赖任何宿主路由；传 `envId` 的宿主需自行提供该路由。
   - 移除条件：宿主改为注入自定义 `urlTransform`，或把代理前缀提升为 prop。
8. **markdown 排版改由 `MessageResponse` 自带的容器工具类承担**：阶段三把原
   `chat/primitives/chat-message-content.css`（标题/列表/引用/行内代码/代码块/表格与 streamdown 内部 DOM）
   全部改写成容器上的 arbitrary variant，落在 `chat/primitives/internal/markdown-classes.ts`
   （导出 `MARKDOWN_CONTENT_CLASS`）。宿主因此**不再需要**给 markdown 注入包裹类名。
   - 影响范围：`streamdown` 的根节点只接收它自己的 props（未知属性不落到 DOM），所以 markdown 容器
     挂不上 `data-slot`；对它的断言改用容器内部 `data-streamdown="…"` 结构标记（见守卫用例）。
   - 移除条件：无（这是终态；若将来 streamdown 支持自定义属性透传，可补一个 `data-slot` 锚点）。
9. **`FileViewerPreview` 的默认 `buildPreviewUrl` 指向宿主文件代理路由**：不传该 prop 时预览 URL 为
   `/web/environments/<envId>/fs/<path>?preview=true`（源宿主应用约定），本包不定义该路由。
   - 影响范围：仅默认值；与第 7 条 `MessageResponse.envId` 属同类取舍。宿主传入自定义 `buildPreviewUrl`
     即完全解除该路由依赖。组件同时带 `import "@open-file-viewer/core/style.css"` 副作用导入，
     消费方（含 demo）编译时需能解析该 CSS —— 依赖已列入 dependencies。
   - 移除条件：宿主统一注入自定义构建器，或把代理前缀提升为必填 prop。
10. **`FileViewerPreview` 的内置预览文案默认简体中文**：`locale` 默认 `"zh-CN"`、`messages` 默认值为内置中文；
    React 错误边界内的提示（「预览组件加载失败」等）是硬编码中文，不随 `locale` / `messages` 变化。
    - 影响范围：非中文宿主需显式传 `locale` / `messages`；边界提示需要多语言时由宿主在外层再包一层本地化边界。
    - 移除条件：错误边界提示纳入 `messages` props（需要先定义边界提示的键位契约）。
11. **`UserMessageImage.url` 是包内新增的展示用字段**：源类型只有 `mimeType` + `data`（base64），
    想展示一张真实网络图片就必须把二进制内联进源码。包内加可选 `url`，渲染方统一按「`url` 优先、
    缺省回退到 `data` 拼出的 data URL」取地址（消息气泡与输入岛附件行同规则），发送路径仍只读 `data`。
    - 影响范围：新增字段可选，宿主既有 `UserMessageImage` 可直接传入，不构成破坏性变更。
    - demo 例外：mock 与输入岛示例的图片因此指向 `https://picsum.photos/...`（见 `MOCK_USER_IMAGE_URL`），
      是 demo 里唯一的远程资源——断网时该图退化为 alt 文案，其余示例仍全部离线可渲染。
    - 移除条件：宿主把展示地址纳入协议（例如 Chat 历史直接下发可访问 URL），包内即可退化为直接透传该字段。
12. **`ChatHeader` 的外壳形态依赖祖先类名 `.acp-main-root`**：阶段五后该页的样式已全部落在
    `ChatHeader.tsx` 的 `HEADER_CARD_CLASS` 里，其中「外壳内形态」（`height: 45px`、仅底边分隔线、圆角置零、
    去除玻璃底与 `backdrop-filter`）用祖先变体 `[.acp-main-root_&…]` 表达——`acp-main-root` 是 `ACPMain`
    根节点的类名，同时是宿主 `apps/web/src/index.css`（`.meta-agent-panel .acp-main-root`）的作用域钩子，
    因此现阶段保留；独立渲染（demo / 单测）时只拿到玻璃形态（圆角 16px + `backdrop-filter`）。
    - 影响范围：仅外观（扁平 vs 玻璃），不破坏布局；包内 `ChatHeader` 目前只由 `ACPMain` 渲染，自带该类名。
    - 移除条件：宿主不再以 `.acp-main-root` 作选择器后，`ACPMain` 删类名并把这些变体改为直接工具类
      （同 `chat-layout.css` 的阻塞项，见下节的移除条件）。

## chat 样式现状（阶段一至五迁移台账）

chat 簇的手写 CSS + 语义类名已全部迁成组件 `className` 里的 Tailwind 工具类（口径：能迁就迁；
工具类无法表达的关键帧与「控制我们在 React 树外/其它包里渲染不出或改不了的节点」才留 CSS）。
起点 `cfacc426^` 为 **2888 行 / 15 个样式表**，现状 **144 行 / 3 个样式表**：

| 存活文件 | 行数 | 保留理由 | 移除条件 |
| --- | --- | --- | --- |
| `web/chat/css/chat-layout.css` | 32 | 唯一高度链（`.acp-main-root` / `.chat-main-column` / `.chat-interface-root` / `.chat-interface-column` 的 `min-width/min-height/overflow`）。这些类名**同时是宿主** `apps/web/src/index.css` 与宿主 `apps/web/src/pages/agent-panel/chat-layout.css` 的选择器，删类名必须宿主同步 | 宿主侧改用自己的选择器后：把这些声明落进 `ACPMain` / `ChatInterface` 的工具类，删除本文件与 `chat.css` 的对应 `@import` |
| `web/chat/css/chat-animations.css` | 86 | 五个 `@keyframes`（`loadingDotBounce` / `loadingDotBounceDark` / `shimmerSlide` / `chat-active-prompt-flash` / `agent-badge-pulse`）：动画定义无法用工具类表达，工具类只能按名引用 | 改用 Tailwind v4 `@theme { --animate-* }` 命名动画 token（需动 `web/styles/theme.css`）后可删 |
| `web/chat/css/chat.css` | 26 | 聚合入口（仅剩两条 `@import` + 迁移台账注释），由 `web/chat/index.ts` 与根 `web/index.ts` 副作用导入 | 上一条 `chat-layout.css` 也消失后，本文件随之删除并移除两处副作用导入 |

- 已迁成工具类并删除的样式表（13 个）：`chat-design-shell`、`chat-design-composer`、`chat-design-messages`、
  `chat-design-selection`、`chat-design-status`、`chat-design-tools`、`chat-design-command-menu`、
  `chat-design-responsive`、`chat-navigation-aids`、`chat-loading`、`chat-agent-badge`（以上在 `web/chat/css/`）
  与 `primitives/conversation.css`、`primitives/chat-message-content.css`（后者现为
  `primitives/internal/markdown-classes.ts` 的容器工具类）。
- 守卫用例（`web/__tests__/chat-style-migration*.test.tsx` + `chat-style-migration-helpers.ts`）常驻校验：
  已删文件不存在、已迁类名不得回流（含阶段五退役的命令面板三形态）、关键帧齐备、聚合入口的 `@import` 有效。

## 未来接入 apps/web（本期不做）

1. 在 `apps/web/vite.config.ts` 增加 `@fenix/ui-components` → `packages/ui-components/web/index.ts` 的 alias
   （以及 `.../styles.css` → `packages/ui-components/web/styles/theme.css`）。
2. `apps/web/tsconfig.json` 的 `paths` 增加同名映射，`apps/web/src/i18n/index.ts` 注册 `uiComponents` 命名空间资源，
   并让 `NS.COMPONENTS` 使用方逐步切换到 `UI_COMPONENTS_NS`。
3. 逐组件把 `apps/web` 下的引用改为 `@fenix/ui-components/*`，确认无重复实现后删除 `apps/web` 中的旧文件
   （同一份组件不得长期双份存在）。
4. 接入后运行 `bun run build:web` 与 `bun run precheck`，重点确认 Tailwind 扫描到包内工具类且文案无缺失。

## 脚本

```bash
bun run dev        # 启动 demo（固定端口 49917，strictPort：端口被占用时直接失败而不改端口）
bun run build      # 构建 demo 到 dist/
bun run preview    # 预览 demo 构建产物
bun run typecheck  # tsc -p tsconfig.json --noEmit
bun run test       # bun test
```
