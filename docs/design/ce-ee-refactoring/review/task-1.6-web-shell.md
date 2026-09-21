# 任务 1.6 评审记录：apps/web 的 Shell 与资源页面装配

对应 `docs/design/ce-ee-refactoring/ce-ee-refactoring-stage-2-plan.md` §1.6。
执行计划与分片见 `.claude/plans/task-1.6-web-shell.md`。本文只记录**实测基线、设计裁定、与计划的偏差、用户可见行为变更**，
复述计划原文的段落不在此重复。

---

## 一、范围

§1.6 要求把 `apps/web` 收敛为最终形态：WebShell + 登录/全局 Provider + 品牌/布局/导航容器 + 错误边界 +
薄 TanStack Router 路由适配器；资源页面、领域 API 客户端、hook、i18n 与领域组件迁入其 owner 包的 `web/`；
WebShell 从静态 registry 收集各资源包的 web contribution（不反向控制、不运行时注入路由、不加载远程脚本）；
保持文件路由与生成的 `routeTree` 工具链；前端访问后端只经 API 客户端；审计并修复构建别名、Vite 入口、
静态资源、路由、测试与生产静态挂载；分支绿灯不作为证据。

---

## 二、现状实测（2026-09-21，起点 `3eef17345`）

| 口径 | 数值 |
| --- | --- |
| apps/web 非测试文件 | 226（含 61 个与包内重复的组件副本） |
| apps/web 测试文件 | 54 |
| 包内 web 面宿主别名越界 `@/(src\|components)/` | **253 处**：agent-runtime 164 / chat-channel 45 / platform-identity 44 |
| 包内 web 面相对越界（happy-dom-window / `../lib/types`） | 9 处 |
| vite alias 条目 | 88（其中 73 条指向 packages，5 条被 `@/components` 前缀遮蔽成死条目） |
| 根 tsconfig paths | 87 条（`tsconfig.base.json` 另有 15 条被整体遮蔽） |
| demo 分支三态 | 580 改动 = 已落地 313 / 需新增 31 / 需融合 236 / 需删除 0 |
| 1.6 名下台账 | 9 条（3 `web-package-not-to-app` + 1 `platform-not-to-...` + 5 `special-dependency`），全部真实命中 |

---

## 三、用户裁定（2026-09-21）

| 议题 | 裁定 | 影响 |
| --- | --- | --- |
| 浏览器 registry 产物形态 | **新增浏览器专用产物**（`apps/generated/web-contributions.ts`），只静态导入各包纯数据 web contribution；现有 `module-registry.ts` 与 server 装配图不动 | §1.1 registry 扩展、门禁断言范围、`deploy/assembly/ce.json` 的 web 语义 |
| org/session 上下文契约落点 | **`@fenix/web-runtime` 提供 contract**（React context + 单 hook：`organizationId` / `userId` / `pending`），identity 的 `OrgContext` 为实现方，Shell 在 `__root` 装配 Provider | 消除 5 条 `special-dependency`；反转 3 条正向固化断言 |
| 「`git grep identity-admin` 必须为 0」硬检查 | **作废**：包已不存在，全仓 0 处功能引用；67 处命中全为溯源注释、docs 与 `rmd-06` 迁移台账数据 | 收尾口径改为「包不存在 + 0 处功能性引用」并同步修订 §1.6 文本 |

---

## 四、执行期裁定（据实测证据 + 计划文本，可推翻）

1. **chat 渲染分层**：按 `feat/ui-components-demo` 既有分层重放——`@fenix/ui-components/web/chat/**` 承担纯净呈现层，
   `packages/agent-runtime/web/components/chat/**` 保留为**领域组合层**（narrators、tool-call 语义、ACP 接线、
   chat-render-layout），只把 `@/` 引用改指 ui-components 公开面。**不删除那 53 个文件、约 6000 行。**
2. **`AgentHomePage`**（678 行「创建智能体」首页）：值依赖 `agentApi` / `envApi` / `modelApi` / `AgentGenerationForm`，
   判为资源页面 → `packages/resources/agent-config/web/`。
3. **agent-panel 壳层容器**（`AgentSidebar` / `AgentSidebarTree` / `AgentPanelLayout` / `ArtifactsPanel` 与两份 CSS）：
   判为「品牌/布局/导航容器」→ `apps/web/src/shell/`（落地在 T11）。
4. **`peri-task-details` web 客户端**：后端 route、service、schema 实测均在 `packages/resources/model-management`，
   按「web 客户端随其后端 owner」落 `model-management/web/api/`；与 1.3 §三「peri-task 命名归 task」的差异记入本文，
   作为耦合一并搬迁项。
5. **`fs.ts` web 客户端**：按 1.3 裁决文件域归 `machine` → `packages/resources/machine/web/api/`（demo 落 agent-runtime，不采）。
6. **`structured-to-thread` 投影层**：保留现状落点 `packages/web-runtime/web/chat/`（§1.6 正文写的
   `chat-channel/web/lib/` 与实测不符且会新增边），同步修订 §1.6 文本。
7. **包侧语义差异**（calendar 类名键、date-picker 去 i18n、connection-status 内联类型、tree internal 拆分、
   theme 跟随系统偏好）随重放生效，逐条记入本文「用户可见行为变更」。
8. **`@server/**` 在 `packages/**` 的 84 文件消费面**（其中 `@server/db/schema` 61 处）：不属本任务，
   保留台账 owner=1.7。

---

## 五、分片进度

| # | 标题 | 状态 | 提交 |
| --- | --- | --- | --- |
| T1 | 别名表与依赖声明归一 | 已交付 | `5e342aa31` |
| T2 | 宿主零消费死代码与重复副本删除 | 已交付 | 见下方 §7.2 |
| T3 | `@fenix/ui-components` 扩面 | 已交付 | `b858bf68f` |
| T4 | `identity/web` 清零 + i18n | 待办 | — |
| T5 | `chat-channel/web` 清零 | 待办 | — |
| T6 | `agent-runtime/web` 收敛 | 待办 | — |
| T7 | 5 条 `special-dependency` 消除 | 待办 | — |
| T8 | 宿主组件/lib/api 簇改指并删除 | 待办 | — |
| T9 | i18n 归属重划与 `quoteTruncatedBadge` 缺陷修复 | 待办 | — |
| T10 | 测试迁移与 happy-dom 收敛 | 待办 | — |
| T11 | WebShell 落地 | 待办 | — |
| T12 | 收尾：台账复核、文档修订、证据留痕 | 待办 | — |

---

## 六、与计划的偏差（T1–T3）

### 6.1 T1（`5e342aa31`）

| 计划原文 | 实际 | 原因 |
| --- | --- | --- |
| 「`tsconfig.base` 去遮蔽条目」 | **未改动** | 其 15 条 paths 对 apps/server 与 14 个包是**活的**；删掉会让这些消费方失去解析 |
| 「根 tsconfig 去零消费条目」 | 部分执行 | 逐条实测消费方后剔除，未按「看起来没用」批量删 |
| `@fenix/ui-components\|web-runtime` 补「精确 + `/*`」两条 paths | **拒绝** | 会让 dependency-cruiser 把公开入口导入判成 `no-cross-package-src`（`dependencyTypes: ["local"]` 下的假阳性） |
| 为 5 个包补 `@fenix/*` tsconfig paths | **拒绝** | 6 份包 typecheck 实测 `Cannot find module` 为 0，无缺口可补 |
| 创建 `model-management/tsconfig.json` | **未创建** | 该包已能从 extends 链解析全部 import |
| 「`admin-key.ts` 有落盘风险」 | **已过期** | 该风险在 1.3 已消解，本任务无需动作 |

附带修复：`packages/chat-channel/src/__tests__/chat-channel-browser-surface.test.ts` 原先断言
「vite alias 文本指向 chat-channel 根入口」。T1 删除该 alias 后断言失效。改为在**包 `exports` 层**守护同一不变量
（`.` 条目必须指向 `src/index.ts`），保留 alias 漂移作为次级条款；两个方向均以反向控制验证过会真实失败。

### 6.2 T3（`b858bf68f`）

| 计划原文 | 实际 | 原因 |
| --- | --- | --- |
| 出口 `./web/i18n` | **`./i18n`** | 本包 `exports` 键一律省略 `web/` 前缀（`.` → `./web/index.ts`），与 `@fenix/resource-observer` 等包 `./web/i18n` 的形态不同。同目录内保持既有命名法优于跨包对齐 |
| 「`./chat/shell/*` 等 exports 缺口」 | 缺口不止 chat 分组 | 补齐口径定为「barrel 的公开面 ⊆ `exports`」，实际补 67 键（含 `components/`、`ui/`、`lib/`、`config/`、`layout/`），`exports` 由 78 键增至 144 键 |

新增守护测试：`packages/ui-components/web/__tests__/i18n-barrel.test.ts`（8 例）、
`barrel-exports.test.ts` 追加 2 例双向断言（barrel ⊆ `exports` 深链键；`exports` 子路径键无悬空）。
两组断言均以反向控制验证过会真实失败（删键 / 加悬空键）。

### 6.3 T2（本节）

见 §7.2。

---

## 七、交付记录

### 7.1 T1 别名表与依赖声明归一（2026-09-21，`5e342aa31`）

见 §6.1。验证：`precheck` ✓ All passed；`build:web` rc=0，dist 扫描 server-only 痕迹 0 处。

### 7.2 T2 宿主零消费死代码与重复副本删除（2026-09-21）

#### 删除清单（23 个文件，3387 行）

`apps/web/components/ai-elements/`：`code-block.tsx`、`index.ts`、`permission-request.tsx`、`prompt-input.tsx`、`tool.tsx`
`apps/web/components/config/`：`BatchActionBar.tsx`、`EmptyState.tsx`、`index.ts`
`apps/web/components/ui/`：`chart.tsx`、`dialog-xl.tsx`、`progress.tsx`、`slider.tsx`
`apps/web/src/components/`：`OrgSwitcher.tsx`、`PermissionTab.tsx`、`agent-panel/ChangedFilesSection.tsx`、
`agent-panel/FileTreeContextMenu.tsx`、`agent-panel/WorkbenchPanel.tsx`
`apps/web/src/i18n/LanguageSwitcher.tsx`、`apps/web/src/lib/use-context-queue.ts`
`apps/web/src/pages/agent-panel/`：`AgentAppShell.tsx`、`AgentPanelPage.tsx`、`components/KnowledgeGraphPanel.tsx`、
`shared/AgentCardList.tsx`

#### 判定口径与三重证据

判定「零消费」= 全仓不存在任何消费者（**测试也算消费者**）。三条互相独立的证据链结论一致：

1. **传递可达性扫描**（测试算根）：以 `index.html` → `main.tsx`、`apps/web/src/routes/**`、`*.d.ts`、
   `vite.config.ts`、全部测试文件与 test-utils 为根做 BFS。23 个文件不可达，其余 224 个可达。
2. **逐标识符全仓 grep**（并行代理，按目录分组）：对每个文件列出全部具名导出 / 默认导出 / CSS 类名再逐一 grep；
   特别核查 `routeTree.gen.ts`、vite / tsconfig / postcss 配置、`scripts/architecture/exceptions.json`、
   字符串形式动态 import、Tailwind `@source` glob、文档与 `.claude/plans/`。
3. **现有 dist sourcemap 实证**：`grep -F <相对路径> apps/web/dist/assets/*.map`，23 个文件**全部未出现**；
   对照组 `components/ui/button.tsx`、`pages/agent-panel/AgentSidebar.tsx` 均命中。

第 3 条在收尾时升级为**受控实验**：把 23 个文件 `git checkout` 回来重新构建，产物回到 T1/T3 的
`main-C8ac0ZG2.css` / `main-DfxZwCui.js`；再次删除后回到 `main-D-UjVD9j.css` / `main-OlRpRmHc.js`。
两次构建确定性可复现，且 267 个产物中仅这两个主 chunk 的哈希变化。

#### 为什么主 chunk 会变（而非完全不变）

`apps/web/src/index.css` 有 `@source "../**/*.{ts,tsx}"`，Tailwind 会扫描 apps/web 下**全部** ts/tsx
（含未被 import 的文件）来生成工具类。删除这 23 个文件后，仅它们用到的工具类不再生成，因此产物哈希变化。
这恰好说明被删文件对 **JS 图零贡献**，只参与了 CSS 扫描集。

#### 连带改动

- `scripts/__tests__/rmd-08-migration.test.ts`：`RMD_08_MOVES` 删除 18 条（这 18 个文件的 owner 目标就是被删的宿主副本），
  长度断言 `171 → 153`；文件头补第 5 条改判说明。台账与代码削减同批提交（门禁对「目标文件缺失」直接失败）。
- 其余 5 个文件（`ui/chart.tsx`、`ui/dialog-xl.tsx`、`ui/progress.tsx`、`ui/slider.tsx`、`i18n/LanguageSwitcher.tsx`）
  从未进入 `RMD_08_MOVES`，属拆分后新产生的孤儿。

#### 明确不在本片范围

下列文件同样是「生产零消费」，但**仍被 `packages/*/web/**` 经宿主别名引用**（`@/components/...`、`@/src/...`），
属 T6/T8 的「改指后删」，本片不动：`ai-elements/{conversation,reasoning,shimmer}.tsx`、
`config/FormDialog.tsx`、`ui/{sheet,use-roving-list-navigation}.tsx`。逐条证据：
`packages/agent-runtime/web/components/chat/ChatView.tsx` → `conversation`；
`…/MessageBubble.tsx` → `reasoning`；`packages/chat-channel/web/components/ACPMain.tsx` → `sheet`；
`packages/agent-runtime/web/components/chat/CommandMenu.tsx` → `use-roving-list-navigation`。

同样地，`apps/web/src/{App.tsx,api/helpers.ts,lib/{retry,agent-utils,form-utils,api-result}.ts}`
只被测试文件续命（各自的专属测试尚未迁出），依赖 T10 的测试归位后一并删除，本片保留。

#### 验证

- `bun test apps/web/src/__tests__/` → 946 pass / 0 fail（与基线一致，无测试受影响）
- `bun test scripts/__tests__/` → 83 pass / 0 fail
- `precheck` → ✓ All passed（package-tests 7326 pass / 2 skip / 0 fail；web-app-tests 946 pass）
- `build:web` → rc=0，产物与受控实验一致
- 非源码引用仅文档与 README（无代码、无门禁依赖），按 T12 统一修订。其中**需要改的是两处活文档**，
  其余是历史记录（迁移计划、review 文档、`FUNCTIONAL_MODULE_INVENTORY.md`、`docs/need-to-change/25,27`）：
  - `docs/arch/tech-stack-frontend.md:47,54` 仍把 `BatchActionBar` / `EmptyState` 登记为 `apps/web/components/config/` 的现存组件
  - `docs/developer/guide/frontend-development.md:233` 仍把 `apps/web/components/config/` 描述为统一交互模式的来源目录
