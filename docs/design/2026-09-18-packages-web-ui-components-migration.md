# 设计：packages 的 web 前端切换到 @fenix/ui-components

> 日期：2026-09-18 | 分支：`feat/ui-components-demo` | 状态：待批准后开工

## 背景与目标

`packages/ui-components` 已完成独立化（`web/` 下 40 个基础控件、6 个通用容器、2 个页面骨架、
文件树/预览/工作台复合组件、`lib/` 基础设施、122 个文件的完整 Chat 体系），但除自身 demo 外
零消费方。各 packages 的 `web/` 仍通过宿主 `apps/web` 的别名取组件，导致同一份组件长期双份存在。

**目标**：把 `packages/**/web/**` 的前端统一到「`@fenix/ui-components` 供组件 + 各包自身公共出口供领域代码」，
并顺带解除对 `apps/web` 私有模块的依赖，使 packages 的 web 前端不再需要宿主别名供给。

**本轮不做**：`apps/web` 自身的组件副本（`apps/web/components/{ui,config,ai-elements}`、
`apps/web/src/components/layout`）不在本轮切换，仅做迁出模块的连带引用更新。宿主应用壳的收敛是下一批。

## 现状数据（`packages/**` 对 `@/` 别名的 833 处引用）

| 桶 | 处数 | 性质 |
| --- | --- | --- |
| A | ~502 | ui-components 已有纯净实现，机械替换 + 删重复 |
| B | 96 | 目标文件已在某个 package 内，只是走 apps/web 别名；需补 `./web/*` exports |
| C | ~235 | 真正住在 apps/web、无包归属的宿主模块 |

## Bucket A 映射表（机械替换）

| 现 specifier | 目标 |
| --- | --- |
| `@/components/ui/*`（40 个文件 1:1） | `@fenix/ui-components/ui/*` |
| `@/components/config/{ConfirmDialog,FormDialog,DataTable,EmptyState,StatusBadge,BatchActionBar}` | `@fenix/ui-components/config/*` |
| `@/components/ai-elements/{conversation,message,reasoning}` | `@fenix/ui-components/chat/primitives/*` |
| `@/components/chat/ChatView` | `@fenix/ui-components/chat/view/ChatView` |
| `@/components/chat/{MessageBubble,SystemMessage,ChatQuoteMessage,CitationLink,chat-navigation-aids}` | `@fenix/ui-components/chat/view/*` |
| `@/components/chat/{ChatComposer,CommandMenu,SessionModeSelector,chat-image-content,composer-assets,composer-context-meter,composer-file-processing,composer-prompt,composer-handler*,composer-state,composer-toolbar,useDragUpload}` | `@fenix/ui-components/chat/composer/*` |
| `@/components/chat/{ChatHeader,AgentAvatar,AgentBadge,sidebar-session-list,FilePickerPanel,ContextPanel,ACPMain,ChatInterface,chat-interface-types}` | `@fenix/ui-components/chat/shell/*` |
| `@/components/chat/{PermissionPanel,QuestionPanel,chat-status-panel}` | `@fenix/ui-components/chat/panels/*` |
| `@/components/chat/{ToolCallRow,ToolCallGroup,TodoChanges,HindsightToolCard,SubAgentPanel,sub-agent-tool-call-context}` | `@fenix/ui-components/chat/timeline/*` |
| `@/components/chat/narrators/*`（16 个） | `@fenix/ui-components/chat/narrators/*` |
| `@/components/chat/{chat-derived-state,chat-render-layout,context-queue,extract-changed-files,session-actions,session-grouping,simplify-model-display-name,strip-html-tags,token-stats,tool-call-utils,tool-semantic}` | `@fenix/ui-components/chat/lib/*` |
| `@/src/lib/{context-queue,extract-changed-files,strip-html-tags,token-stats,tool-semantic}` | `@fenix/ui-components/chat/lib/*` |
| `@/src/lib/types`（Chat 数据模型 ThreadEntry / ToolCallData …） | `@fenix/ui-components/chat/types` |
| `@/src/lib/card-renderer` | `@fenix/ui-components/lib/card-renderer` |
| `@/src/lib/utils` 的 `cn` | `@fenix/ui-components/lib/cn` |
| `@/src/components/layout/{app-header,app-page}` | `@fenix/ui-components/layout/*` |
| `@/src/components/file-icon-helper` | `@fenix/ui-components/components/file-icon-helper` |
| `@/src/components/agent-panel/WorkbenchPanel` | `@fenix/ui-components/components/WorkbenchPanel` |
| `@/src/pages/agent-panel/shared/{AgentCardList,agent-master-detail-workspace}` | `@fenix/ui-components/components/*` |

### 例外：`TodoPanel` / `PeriTask*` 四个文件不进本表（2026-09-18 实测更正）

`TodoPanel`、`PeriTaskList`、`PeriTaskViewCard`、`PeriTaskDetailSheet` 曾被本表列入 ui-components 目标，
实为误列：`git log --all --name-only` 证明这四个文件**从未住在 `apps/web`**，源头是
`packages/agent-runtime/web/components/chat/`，按 ui-components「只收录源自 `apps/web` 的组件」的范围线
（同 `7bfa8968`）必须留在 agent-runtime。已在 ui-components 侧删除（提交 `bad0d388`）。

实测引用关系（决定处置）：

| 文件 | 全仓引用 | 处置 |
| --- | --- | --- |
| `TodoPanel` | 零渲染方、零 import（仅注释提及） | 留在 agent-runtime（死代码，本轮不清理） |
| `PeriTaskList` / `PeriTaskViewCard` | 仅 `PeriTaskList` 内部 import `PeriTaskViewCard`，无渲染方 | 同上 |
| `PeriTaskDetailSheet` | **live**：`packages/chat-channel/web/components/ChatInterface.tsx:484` 渲染 | 留在 agent-runtime，改由注入槽承接（见下） |

**能力保留方式**：ui-components `ChatInterface` / `ACPMain` 新增可选注入槽
`renderPeriTaskDetail?: (task: PeriTaskViewProjection, close: () => void) => ReactNode`。
chat-channel 外壳切到包内 `ChatInterface` 时，用它继续渲染 agent-runtime 的 `PeriTaskDetailSheet`
（详情数据加载留在宿主），未注入时任务行只读。因此 Phase 2 删除 agent-runtime 重复 chat 实现时，
**`PeriTask*` 与 `TODO` 相关文件不在删除清单内**，`use-task-views` / `api/peri-task-details` 亦保持 live。

## Bucket B 映射表（改用对方包名，需补 `exports` + alias）

跨包引用全部经 `@fenix/<pkg>/web/...` 公共出口，不再走 apps/web 别名。

| 现 specifier | 目标 |
| --- | --- |
| `@/src/api/{agents,sites}`、`@/src/pages/agent-panel/agent-editor/agent-editor-model` | `@fenix/agent-config/web/*` |
| `@/src/api/{api-keys,organizations}`、`@/src/pages/agent-panel/pages/agent-organizations-utils` | `@fenix/resource-identity-admin/web/*` |
| `@/src/api/{knowledge-bases,knowledge-models}`、`@/src/types/knowledge`、`@/src/pages/agent-panel/pages/agent-knowledge-*` | `@fenix/resource-knowledge/web/*` |
| `@/src/api/{models,providers,model-gateway}`、`@/src/lib/model-config-utils` | `@fenix/model-management/web/*` |
| `@/src/api/{mcp}`、`@/src/lib/mcp-resource-access` | `@fenix/resource-mcp/web/*` |
| `@/src/api/skills`、`@/src/lib/{skill-resource-access,skill-upload}` | `@fenix/resource-skill/web/*` |
| `@/src/api/{prod-views}`、`@/src/lib/prod-view-modules` | `@fenix/resource-prod-view/web/*` |
| `@/src/api/{hindsight}` | `@fenix/resource-memory/web/*` |
| `@/src/api/{tasks-v2}` | `@fenix/resource-task/web/*` |
| `@/src/api/{observer,system-people-tree}` | `@fenix/resource-observer/web/*` |
| `@/src/api/channels` | `@fenix/resource-channel/web/*` |
| `@/src/api/environments` | `@fenix/agent-runtime/web/api/environments` |
| `@/src/pages/workflow/*`（4 个入口） | `@fenix/resource-workflow/web/pages/workflow/*` |

> `no-cross-package-src` 规则要求跨包只能经 export 导入，因此上述每个包都必须新增 `./web/*`（或精确子路径）
> 出口；`resources/machine` 当前无 `web/` 目录，本轮需首次创建。

## Bucket C 归属表（本次需批准的核心）

### C1 → 新建 `@fenix/web-runtime`（`packages/web-runtime/`）

**为什么必须新建**：这些模块零领域语义或跨领域复用，无处下沉；且 `structured-to-thread` 依赖
`@fenix/chat-channel`，若塞进 `packages/platform/*` 会触发 `platform-not-to-agent-runtime-resources-apps` 规则，
所以必须是**顶层包**（与 `packages/ui-components` 同级）。

| 现文件 | 新位置 | 引用数 | 理由 |
| --- | --- | --- | --- |
| `apps/web/src/api/request.ts`（349 行，零 import） | `web/api/request.ts` | 73 | 15 个包共用的纯 HTTP 客户端，无领域语义 |
| `apps/web/src/i18n/index.ts` 的 `NS` 常量表 | `web/i18n/namespace.ts` | 58 | 跨包命名空间注册表；i18n **单例**仍留宿主 |
| `apps/web/src/lib/config-events.ts` | `web/lib/config-events.ts` | 4 | 通用配置变更事件总线 |
| `apps/web/src/lib/artifacts-preview-events.ts` | `web/lib/artifacts-preview-events.ts` | 3 | 通用文件预览事件总线 |
| `apps/web/src/lib/chat-stats.ts` | `web/lib/chat-stats.ts` | 2 | chat:stats 摘要协议 |
| `apps/web/src/hooks/use-changed-files-stats.ts` | `web/hooks/use-changed-files-stats.ts` | 2 | chat:stats 消费端 |
| `apps/web/src/hooks/usePageVisible.ts` | `web/hooks/use-page-visible.ts` | 2 | ChatPageVisibleContext，保活可见性契约 |
| `apps/web/src/lib/structured-to-thread.ts` | `web/chat/structured-to-thread.ts` | 4 | Chat Doc → ThreadEntry 投影层（依赖 chat-channel + yjs） |
| `apps/web/src/lib/todo.ts` | `web/chat/todo.ts` | 0（随上条） | 仅被 structured-to-thread 使用 |

### C2 → 下沉到领域包

| 现文件 | 新位置 | 引用数 | 归属理由 |
| --- | --- | --- | --- |
| `apps/web/src/types/config.ts`（372 行） | `agent-config/web/types/config.ts` | 32 | AgentConfig/ResourceAccess/AgentNode 领域类型 |
| `apps/web/src/lib/agent-resource-access.ts` | `agent-config/web/lib/agent-resource-access.ts` | 4 | Agent 资源访问器 |
| `apps/web/src/lib/agent-node.ts` | `agent-config/web/lib/agent-node.ts` | 3 | AgentNode 选择逻辑 |
| `apps/web/src/lib/agent-utils.ts` | `agent-config/web/lib/agent-utils.ts` | 2 | Agent 名称校验 + Knowledge 表单状态 |
| `apps/web/src/hooks/useMetaAgent.ts` | `agent-config/web/hooks/use-meta-agent.ts` | 1 | 已依赖 `@fenix/agent-config/web` |
| `apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx` | `agent-config/web/pages/agent-panel/AgentSidebarConfig.tsx` | 2 | 消费方全是 agent-config |
| `apps/web/src/lib/citation-preview-context.tsx` | **删除**（见遗留待核实 1） | 1 | 迁移后零消费方 |
| `apps/web/src/contexts/OrgContext.tsx`（136 行） | `identity-admin/web/contexts/OrgContext.tsx` | 2 | 组织上下文 |
| `apps/web/src/lib/auth-client.ts` | `identity-admin/web/lib/auth-client.ts` | 3 | better-auth 客户端 |
| `apps/web/src/lib/admin-key.ts` | `identity-admin/web/lib/admin-key.ts` | 11 | master key sessionStorage 助手 |
| `apps/web/src/lib/password-crypto.ts` | `identity-admin/web/lib/password-crypto.ts` | 1 | AES-GCM 密码加密 |
| `apps/web/src/api/registry.ts`（172 行） | `machine/web/api/registry.ts` | 6 | `/web/registry/machines` 机器注册表域 |
| `apps/web/src/api/fs.ts`（319 行） | `agent-runtime/web/api/fs.ts` | 3 | `/web/environments/:id/fs` 工作区文件域 |
| `apps/web/src/api/peri-task-details.ts` | `agent-runtime/web/api/peri-task-details.ts` | 1 | Peri Task detail |
| `apps/web/src/hooks/use-task-views.ts`（240 行） | `task/web/hooks/use-task-views.ts` | 1 | Session Doc 的 Peri Task 投影订阅 |
| `apps/web/src/lib/use-workflow-events.ts` | `workflow/web/lib/use-workflow-events.ts` | 2 | 工作流事件 → context queue |
| `apps/web/src/pages/agent-panel/components/KnowledgeGraphPanel.tsx` | `knowledge/web/pages/agent-panel/components/KnowledgeGraphPanel.tsx` | 1 | 知识图谱面板 |
| `apps/web/src/types/index.ts` 的 `FileInfo` | 内联进 `ui-components/web/chat/types.ts` | 3 | ui-components chat 的 FilePickerPanel/ChatComposer 需要 |
| `apps/web/src/types/index.ts` 其余（Environment/Session/Channel/File DTO） | `agent-runtime/web/types/index.ts` | 0 | environment/session/file 域 DTO |

### C3 → 进 ui-components（纯 UI 域，追加到已抽取面）

| 现文件 | 新位置 | 引用数 |
| --- | --- | --- |
| `apps/web/src/lib/use-context-queue.ts` | `ui-components/web/chat/lib/use-context-queue.ts` | 1 |
| `apps/web/src/components/FilePickerDialog.tsx` | `ui-components/web/components/FilePickerDialog.tsx` | 1 |

### C4 → agent-runtime

| 现文件 | 新位置 | 引用数 | 理由 |
| --- | --- | --- | --- |
| `apps/web/components/MetaAgentPanel.tsx` | `agent-runtime/web/components/MetaAgentPanel.tsx` | 1 | 包装 agent-runtime 的 ChatPanel；消费方 workflow 反向依赖合法 |

### 不搬清单（留在 `apps/web`，属宿主职责）

- `apps/web/src/i18n/index.ts` 单例与 `apps/web/src/i18n/locales/**`：宿主注册各包 locale 的既有约定不变。
  本轮新增 `uiComponents` 命名空间注册（`@fenix/ui-components/i18n/locales/*/uiComponents.json`）。
- `apps/web/src/lib/{agent-resource-access→迁走后} apps/web` 侧剩余 lib、`random-uuid-polyfill`、`theme`、
  `auth-preference`、`app-brand`、`clipboard-polyfill`、`form-utils`、`retry`、`streamdown-table-patch`、
  `api-result`、`api/instances.ts`：本轮无 package 消费或纯宿主启动逻辑。

### 遗留待核实（开工前由 Phase 0 agent 确认）

1. **`citation-preview-context.tsx` 已成死代码**（实测，非本次改动造成）：全仓搜索 `useCitationPreview` /
   `CitationPreviewContext` / `openCitation`，只有该文件自身与 `packages/agent-runtime/web/components/chat/CitationLink.tsx`
   两处引用；而 `CitationLink` 在 ui-components 与 agent-runtime 两侧都**没有任何渲染方**（仅 ui-components demo 渲染）。
   文件头声称的 `ChatRoute` Provider 已随 chat 迁出而不存在。
   - 处理：Phase 2 删除 agent-runtime 的重复 `CitationLink`（属重复实现范畴）后，本文件零消费方 → 一并删除，
     并在提交信息记录「本次改动使其失去最后引用」。
   - 若宿主要恢复引用预览能力，契约是 ui-components `CitationLink` 的 `onOpen` prop（非 Context），
     由渲染 markdown 的宿主层注入 —— 属新功能，不在本轮范围。
2. `resources/machine/web/src/__tests__/file-icon-and-card-registry-pure.test.ts` 用相对路径深链
   `apps/web/src/lib/card-renderer/registry`，需一并改为 `@fenix/ui-components/lib/card-renderer`。

## 接线清单（Phase 0 一次性完成）

1. 新建 `packages/web-runtime/`：`package.json`（`@fenix/web-runtime`，`exports` 含 `.`、`./web/*`）、
   `tsconfig.json`、`README.md`（范围约定与不搬清单）。
2. 各消费包 `package.json` 新增 `./web/*`（或精确子路径）出口；`resources/machine` 首次建 `web/`。
3. `apps/web/tsconfig.json` + `apps/web/vite.config.ts` 新增：
   `@fenix/ui-components`（含 `styles.css` 正则条目，复用 `packages/ui-components/vite.config.ts` 的写法）、
   `@fenix/web-runtime`、以及各包 `@fenix/<pkg>/web/*` 映射。根 `tsconfig.json` 同步。
4. 各消费包 `tsconfig.json` 同步新增同名 `paths`。
5. `apps/web/src/i18n/index.ts` 注册 `uiComponents` 命名空间资源（en/zh）。
6. `apps/web/src/index.css` 确认 `@source` 覆盖 `packages/web-runtime/web`（Tailwind 扫描约定）。
7. `apps/web` 自身对迁出模块的 ~110 处引用连带更新（`apps/web/src/**` 约 40 个文件 + 2 个配置文件）。

### 接线补充结论（2026-09-18 实测，避免实施时重复决策）

- **CSS 无需改动**：`apps/web/src/index.css` 已有 `@source "../../../packages/**/web/**/*.{ts,tsx}"`，
  自动覆盖 `packages/web-runtime/web`。**不要**新增 `@import "@fenix/ui-components/styles.css"` ——
  实测两侧 `--*` token 集合**完全相同**（互相差集均为空），且 `border-color: var(--color-border)`、
  `:focus-visible`、`prefers-reduced-motion` 三条全局规则宿主已具备，重复 import 只会产生同值重复声明。
- **exports 用显式子路径，禁止通配符**：全仓 `package.json` 零 `"./x/*"` 通配出口，跨包一律显式列出
  目标文件（参照 `packages/resources/machine` 的 `./file-ws-handler` 等写法）。因此 Bucket B 的每个
  跨包子路径都要在目标包 `exports` 里逐个登记，不使用 `"./web/*"`。
- **`agent-config` 的既有形态**：`packages/resources/agent-config` 的 `"."` 出口是**浏览器安全 barrel**
  （`src/index.ts` 转导 `web/**`），`"./web"` 目前也指向 `./src/index.ts`；其 web 源码分布在
  `web/api`、`web/components`、`web/pages`、`web/src/api` 四处。改它的出口前先确认现有语义，不要臆造新布局。

## 执行计划与 agent workflow 设计

```
Phase 0  单 agent 串行（唯一写入者）—— 共享契约，无法并行
         建包 + 搬迁 C1/C2/C3/C4 + exports/alias/i18n 接线 + apps/web 连带 + 落映射表
         gate: bunx tsc -p apps/web/tsconfig.json --noEmit 全绿

Phase 1  16 个模块 agent 并行 —— 纯消费映射表，零跨模块写冲突
         每 agent 独占一个 packages/<pkg>/web/**，按 A/B/C 映射表替换 + 删本包重复实现
         每 agent 自证：本包相关 bun test + 定点 tsc
         完成即一个 commit（feat/fix 中文标题 + 约定尾注）

Phase 2  2 个高风险 agent（串行于 Phase 1 后）
         agent-runtime：删 web/components/chat/**（48+16 文件），ChatPanel 改为消费
                        @fenix/ui-components/chat/* 并补注入 props；33 个 chat 测试迁到 ui-components
         chat-channel：删 web/components/{ACPMain,ChatInterface,ContextPanel}.tsx，ChatArea 补齐
                        boundMcps / onStatsChange / onNotice / projectEntries 注入

Phase 3  单 agent 全局验证：bun run precheck + bun run build:web + 残留 @/ 扫描回归

Phase 4  每模块一个 review agent 并行：核对残留引用、双份实现、行为等价与 i18n 文案缺失
```

**为什么 Phase 0 必须串行**：它改的是被 16 个模块共同消费的公共契约（包出口、tsconfig/vite alias、i18n 注册）。
若交给并行 agent，每个模块会独立决定 `@fenix/web-runtime/api/request` 的路径与导出形态，产出 16 套互不兼容的答案。
Phase 0 结束后映射表冻结，Phase 1 才是可安全并行的纯消费阶段。

## 验证口径

- 手工验证基线（2026-09-18 实测）：`bun run check:dependencies` 绿（2338 模块）；
  `bunx tsc -p apps/web/tsconfig.json --noEmit` 绿，覆盖 ~245 个 packages web 文件。
- 每阶段最小专项验证：`bun test packages/<pkg>/web` + `tsc` 定点。
- 阶段收口全量验证：`bun run precheck` + `bun run build:web`（后端从 `apps/web/dist/` 挂载静态资源，构建不可省）。
- 回归断言：`packages/**` 内 `@/components/*`、`@/src/*` 引用数归零（除不搬清单白名单）。

## 回滚

每模块一个 commit，出问题按模块 `git revert`。Phase 0 是独立 commit，回滚它即回到当前状态。
