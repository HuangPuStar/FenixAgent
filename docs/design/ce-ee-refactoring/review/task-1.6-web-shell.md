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
9. **`ContextPanel` 由「迁入 ui-components」改为删除（2026-09-21 实测修正，先反馈）**：向用户呈报切片时，
   该面板按「迁入 `ui-components/web/chat/panels/`」描述。落地前实测证明它是**生产不可达的死代码**：
   `packages/chat-channel/web/components/ACPMain.tsx:401` 恒传 `hideContextPanel={true}`，渲染分支
   `{!readonly && !hideContextPanel && (…)}` 在当前所有调用路径上恒假；`apps/web` 从不渲染它（宿主走
   `chat-channel/web/chat-area`）；`@fenix/ui-components` 的 `ChatInterface.tsx` 已在 2026-09-18 按同一结论
   移除该面板与开关（另见 `packages/ui-components/README.md:88`）。唯一消费者是
   `packages/resources/knowledge/web/src/__tests__/context-panel-ssr.test.tsx`——它测的是一个宿主从不渲染的
   组件，其「本包页面内嵌 ContextPanel」的前提不成立。按 CLAUDE.md 原则 10「删除优于兼容」，处置改为删除：
   组件本体、上述 SSR 测试、chat-channel `ChatInterface` 的渲染分支与 `hideContextPanel` 透传、`web/index.ts`
   的导出、chat-channel browser-surface 守卫中对应的三条断言一并删除。**连带收益**：ui-components 聊天字典
   不需要补 `contextPanel.*` 六个键，T9 范围相应缩小。
10. **`boundMcps` 的注入点是宿主容器，不是 `agent-runtime` 的 `ChatPanel`**：用户裁定「`agent-config/web`
    提供助手」后，本打算让 `packages/agent-runtime/web/agent-panel/ChatPanel.tsx` 直接调它。实测不可行：
    §2.3 禁止 `agent-runtime` 依赖除 Machine/Sandbox 外的 `resources`，且这条边已在任务 1.4 W4b 通过两个端口
    消除（`packages/agent-runtime/src/server/services/agent-config-lookup-port.ts:6` 明写「阶段 2 任务 1.4 W4b
    已消除该边」），`.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources` 按文件级路径拦截。故助手落
    `agent-config/web`（裁定不变），改由**宿主容器调用**：`ChatArea`（T5b 起属 `apps/web`）以
    `loadBoundMcps(activeAgentId)` 取数，经 `ChatPanel` 透传给 ui-components 面板的 `boundMcps` 端口。
    已知代价：ChatArea 与助手各取一次 environment 详情（前者供 ArtifactsPanel 的站点绑定），随第 11 条的归位
    合并。
11. **`ChatPanel` 的归位留给 T6，T5 只加一个透传 prop**：`ChatPanel.tsx` 现物理位于
    `packages/agent-runtime/web/agent-panel/`，但它是宿主接线层——别名 `@/src/pages/agent-panel/ChatPanel`
    就是按宿主模块寻址它的，且它依赖只属于宿主的 `@/src/lib/auth-client`（identity 的 web）与
    `@/src/hooks/use-task-views`（task 资源的 web），而 §2.3 同样禁止 `agent-runtime` 依赖这两者。因此 T6 的
    「164 处别名归零」必然要求把它迁到 `apps/web`；本任务不做这次搬迁，只按裁定把它的 `ACPMain` 来源从
    `@fenix/chat-channel/web` 改指 `@fenix/ui-components/chat/shell/ACPMain` 并加 `boundMcps` 透传，
    避免与 T6 重复改写同一文件。

---

## 五、分片进度

| # | 标题 | 状态 | 提交 |
| --- | --- | --- | --- |
| T1 | 别名表与依赖声明归一 | 已交付 | `5e342aa31` |
| T2 | 宿主零消费死代码与重复副本删除 | 已交付 | 见下方 §7.2 |
| T3 | `@fenix/ui-components` 扩面 | 已交付 | `b858bf68f` |
| T4 | `identity/web` 清零 + i18n | 4a 已交付 / 4b 待办 | 见下方 §7.3 |
| T5 | `chat-channel/web` 清零 | a 已交付 / b,c,d 待办 | 见下方 §7.4 |
| T6 | `agent-runtime/web` 收敛 | 待办 | — |
| T7 | 5 条 `special-dependency` 消除 | 待办 | — |
| T8 | 宿主组件/lib/api 簇改指并删除 | 待办 | — |
| T9 | i18n 归属重划与 `quoteTruncatedBadge` 缺陷修复 | 待办 | — |
| T10 | 测试迁移与 happy-dom 收敛 | 待办 | — |
| T11 | WebShell 落地 | 待办 | — |
| T12 | 收尾：台账复核、文档修订、证据留痕 | 待办 | — |

**T5 分片**（用户裁定「整体退场，由 ui-components 接管」+「`agent-config/web` 提供助手」的落地顺序；
每片独立可 `precheck`、独立提交，避免一个提交裹住全部改动）：

| # | 标题 | 内容 |
| --- | --- | --- |
| T5a | `agent-config/web` 新增 `loadBoundMcps` | 纯新增助手 + 出口，见 §7.4；`agent-runtime` 不得持有该查询（§四.10） |
| T5b | `ChatArea` 簇迁至宿主 | `ChatArea.tsx` / `chat-area-lifecycle.ts` 迁 `apps/web/src/pages/agent-panel/`；chat 设计层 CSS 归 ui-components；宿主页面壳层规则留在宿主；`ProdViewPage` 改注入；环境删除用例随迁 |
| T5c | `ChatPanel` 改指 ui-components 面板 | `@fenix/chat-channel/web` → `@fenix/ui-components/chat/shell/ACPMain`；补 `boundMcps` 透传；`agent-runtime` 声明 `@fenix/ui-components` 依赖 |
| T5d | `chat-channel/web` 退场 | 删 3 个组件与入口（含 §四.9 的 `ContextPanel` 死代码链）、删 `./web*` 出口与 tsconfig paths、测试归位、删台账 1 条 |

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

### 6.4 T4（本节，已拆为 4a / 4b）

T4 计划为一片，实测后发现两半的**失败面**不同，故拆成两片各自成绿：

- **4a**（本次交付）：identity 别名归零 + `web/i18n` 建设 + **删 2 条台账**。这一半的改动会让
  T3 遗留的三条「上游别名债务」白名单断言与 `RMD_08_MOVES` 的目标存在性断言**同时变红**，
  必须同批处理（见 §7.3 的连带改动），否则 4a 无法独立成绿。
- **4b**（**已并入 T7**，见下）：移除 3 处 `mock.module("@fenix/identity/web", …)`。

**4b 为何并入 T7**：这 3 处替身（`skill` / `mcp` / `knowledge` 的 `*-page-states.test.tsx`）替换的正是
`useOrg` / `useSession`，而 T7 要做的事就是把这 5 个资源页从「import `@fenix/identity/web` 的 hook」
改为「消费 `@fenix/web-runtime` 的 org/session 契约」。替身去掉后测试要么改为挂真实 `OrgProvider`
+ fetch 桩（`useOrg` 在无 Provider 时 throw，见 `OrgContext.tsx:134`），要么改为注入 T7 的新契约——
**后者的形状取决于 T7 的裁定**。在 T4b 里先按前者重写一遍、T7 再按后者重写一遍，是纯粹的返工，
且会让 3 个测试文件短暂持有「与 T7 即将删除的依赖耦合」的写法。故 4b 随 T7 一起落地。

原计划的判据「3 条固化断言不会破 4a」**是错的**：

| 计划预判 | 实际 |
| --- | --- |
| 「3 条断言是宽容过滤器，identity 清零后集合自然为空，不破 4a」 | agent-config 的 `expect(upstreamDebt.length).toBeGreaterThan(0)` 是**非空硬断言**（防空集假绿），必然变红；mcp / skill 的 `isUpstreamAliasDebt` 随白名单一起失去意义，留着就是死代码 |
| 「身份包 45/35 处别名」 | 实测 mcp 侧还多一处**非别名**连带：identity 的 API Key 页面从宿主 `@/components/ui/label`（别名解析不到、图在此断掉）改为 `@fenix/ui-components/ui/label`（可解析、图继续下行），于是 `@radix-ui/react-label` 首次进入 mcp 的浏览器可达面，需要显式评审后进白名单 |

另外两项**计划外但由本片直接造成**的改动：

1. 计划把「宿主 `lib/api/hooks/types` 簇改指并删除」全部归 T8；但 `apps/web/src/api/registry.ts`
   的最后消费者正是 identity 组织机器页的 `@/src/api/registry` 别名，本片把该消费改为端口注入后它立即零消费，
   且与 `packages/resources/machine/web/api/registry.ts` **除 import 说明符外逐字相同**（`diff` 实测）。
   留着就是「零消费的宿主重复副本」——正是 T2 的删除口径，故随本片删除并改挂 `RMD_08_RELOCATED`。
2. identity 组织页需要机器注册表能力，而 §2.3 禁止 platform 实现依赖 resources。经用户裁定采用
   **窄端口注入**：identity 声明 `MachineView` / `MachineRegistryPort`，宿主 route adapter 注入
   `@fenix/resource-machine/web` 的 `registryApi`，字段漂移在组合根变成类型错误。
   这顺带把 `apps/web/src/routes/agent/_panel/organizations.tsx` 改成直连包入口，
   删掉一条 vite 别名——方向与 T11 一致，但**只**在该页做（`AgentApiKeysPage` 的别名与 `apikeys.tsx`
   保持原样，留给 T11，遵循「禁止顺手重构无关代码」）。

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

### 7.3 T4a `identity/web` 别名清零 + i18n 建设（2026-09-21）

#### 别名归零

`packages/platform/identity/web/**` 的宿主越界引用归零：**44 处 `@/...` 别名 + 1 处相对越界**
（`__tests__/organization-invite-dialog.test.tsx` 的 `../../../../../apps/web/src/__tests__/happy-dom-window`）。
两者都改为包自有依赖或包内相对路径：

| 原说明符 | 去向 |
| --- | --- |
| `@/src/api/request`（`unwrap` / `request`） | `@fenix/web-runtime/api/request` |
| `@/src/i18n`（`NS`） | `@fenix/web-runtime/i18n/namespace` |
| `@/components/ui/*`、`@/components/config/*` | `@fenix/ui-components/{ui,config}/*` |
| `@/src/components/layout/*` | `@fenix/ui-components/layout/*` |
| `@/src/pages/agent-panel/shared/agent-master-detail-workspace` | `@fenix/ui-components/components/agent-master-detail-workspace` |
| `@/src/api/{api-keys,organizations}` | 包内相对 `../../../api/*`（别名此前就指向 identity 自己的文件，属别名自指，改后行为不变） |
| `apps/web/src/__tests__/happy-dom-window` | `@fenix/ui-components/testing`（T3 建立的单份 happy-dom 入口；两者行为一致，仅注释不同） |

#### 机器注册表能力改走窄端口注入

identity 的组织页有机器 Tab（列表 / 预注册 / 改删），此前经 `@/src/api/registry` 取宿主的 `registryApi`。
`@/src` 别名归零后这条路径不存在，而 `.dependency-cruiser.cjs` 的
`platform-not-to-agent-runtime-resources-apps`（error）禁止 `packages/platform/**` → `packages/resources/**`，
identity 不能直连 `@fenix/resource-machine/web`。经用户裁定采用**窄端口注入**：

- identity 在 `agent-organizations-types.ts` 声明结构类型 `MachineView` 与 `MachineRegistryPort`
  （`list` / `create` / `update` / `remove` 四个方法的形状），`AgentOrganizationsPage` 新增
  `machineRegistry: MachineRegistryPort` prop；宿主与包之间不再有 `MachineRecord` 这个名字的耦合。
- 宿主 route adapter `apps/web/src/routes/agent/_panel/organizations.tsx` 把
  `@fenix/resource-machine/web` 的 `registryApi` 注入进去——组合只发生在 apps（唯一 composition root）。
- 漂移后果：`registryApi` 的签名一旦变化，在**组合根**变成类型错误（`tsc (web)` 门禁），
  而不是运行期取到 `undefined`。

#### i18n 归位

- 字典经 `git mv` 移到 `web/i18n/locales/{en,zh}/{apikey,orgs}.json`（apikey 14 顶层 / 35 叶子，
  orgs 46 顶层 / 116 叶子，两语言键集一致）。
- 新建 `web/i18n/namespace.ts`（`APIKEY_NS` / `ORGS_NS` 取自 `@fenix/web-runtime/i18n/namespace` 的中心表，
  不复制字面量）与 `web/i18n/index.ts`（转出两个 NS 常量 + `apikeyResources` / `orgResources`）。
- `package.json` 新增出口 `"./web/i18n"`（带 `web/` 前缀——本包 `exports` 的 `./web` 本身带前缀，
  与 ui-components 省略前缀的 `./i18n` 形态不同）。
- 宿主 `apps/web/src/i18n/index.ts` 不再深相对路径读 identity 的 JSON，改为
  `import { APIKEY_NS, apikeyResources, ORGS_NS, orgResources } from "@fenix/identity/web/i18n"`，
  并从 `hostResources` 移除这两个命名空间、加入 `packageResources`。

#### 新增守护测试

`packages/platform/identity/web/__tests__/identity-i18n.test.ts`（11 例）：两字典 en/zh 键集一致与规模底线、
插值占位符一致、源码字面量 `t("key")` 全命中、动态键族齐备（`roles.*`、`machineStatus.*`、
`createMachineDialog.*` / `editMachineDialog.*`）、无带命名空间前缀的寄居键、NS 常量等于中心表取值且与文件名一致、
出口指向同一批 JSON 且不含宿主路径、`package.json` 的 `./web/i18n` 出口形态。

其中 **T9 债务被显式登记而非豁免**：`ChangePasswordDialog.tsx` 借宿主 `NS.SETTINGS` 的 11 个键、
`OrgContext.tsx` 借宿主 `NS.COMPONENTS` 的 `orgSwitchFailed`，共 12 个键此刻不在 identity 字典内
（已核实它们确实存在于宿主字典）。测试用 `BORROWED_KEYS` 双向钉住：白名单外的缺失一律失败，
且这些键**不得**出现在本包字典里——T9 真把键搬进来时该断言先失败，迫使白名单与债务注释一起删除。

#### 连带改动（台账与断言必须与代码削减同批）

- `scripts/architecture/exceptions.json`：删除两条台账条目
  `web-package-not-to-app / @fenix/identity / @fenix/web-app`（原登记 45 处 / 15 文件）与
  `platform-not-to-agent-runtime-resources-apps / @fenix/identity / @fenix/web-app`（原登记 35 处）。
  门禁计数由 27 + 12 变为 **26 + 11 = 37 条**，两侧均无「精确归零」报错。
- 三条上游别名债务白名单随清零一起删除并**反向化**（这正是 4a 必须连带处理的原因，见 §6.4）：
  - `packages/resources/agent-config/web/__tests__/agent-config-browser-surface.test.ts`：
    删 `UPSTREAM_ALIAS_DEBT_DIRS`，`expect(upstreamDebt.length).toBeGreaterThan(0)` 改为
    `expect(graphOffenders).toEqual([])`（全图零别名）
  - `packages/resources/mcp/web/__tests__/mcp-browser-surface.test.ts`、`skill` 同名文件：
    删 `UPSTREAM_ALIAS_DEBT_DIR` 与 `isUpstreamAliasDebt`，两处调用点改为严格过滤
  - `packages/resources/task/web/__tests__/task-browser-surface.test.ts`：仅更新引用该白名单的注释
- mcp 白名单新增 `@radix-ui/react-label`：identity 的 API Key 页改指 `@fenix/ui-components/ui/label` 后，
  该原语首次进入 mcp 的值导入图（此前 `@/components/ui/label` 是别名，图在此断掉）。
  其余 8 个包的 browser-surface 早已收录该原语。
- `scripts/__tests__/rmd-08-migration.test.ts`：`["web/src/api/registry.ts", "apps/web/src/api/registry.ts"]`
  从 `RMD_08_MOVES` 移入 `RMD_08_RELOCATED`（owner = `packages/resources/machine/web/api/registry.ts`），
  长度断言 `153 → 152`、`9 → 10`，文件头补第 6 条改判说明。
- 删除 `apps/web/src/api/registry.ts`（172 行）+ `apps/web/vite.config.ts` 删除
  `@/src/pages/agent-panel/pages/AgentOrganizationsPage` 别名（留注释说明为何别名无法表达这次装配）。
  同批的两处注释订正：`packages/resources/machine/web/index.ts` 与
  `machine-browser-surface.test.ts` 关于「identity 直连 registryApi」的描述已过期，改为「宿主 route adapter 注入」。
- `packages/platform/identity/package.json` 新增依赖 `@fenix/ui-components`、`@fenix/web-runtime`
  与 devDependency `happy-dom`（版本对齐 `^20.9.0`）。

#### 明确不在本片范围

- T9：`ChangePasswordDialog` / `OrgContext` 的借键（已由测试双向钉住，见上）。
- T11：`AgentApiKeysPage` 的 `@/src` 别名与 `apps/web/src/routes/agent/_panel/apikeys.tsx` 的骨架
  （该页不需要注入，别名仍然可用）。本片只动了因端口注入而**必须**动的 organizations 一页。
- T4b：3 处 `mock.module("@fenix/identity/web", …)`。

#### 验证

- `bun test packages/platform/identity` → 52 pass / 0 fail（含新增 11 例）
- `bun run architecture:check` → ✓ 2240 files / 10 rules / **26 条**已登记例外
- `bun run check:dependencies` → ✓ 2392 modules / **11 条**已登记例外 / 0 条新增违规
- `precheck` → ✓ All passed（server-and-script-tests 770 pass；package-tests 7337 pass / 2 skip / 0 fail；
  web-app-tests 946 pass）
- `build:web` → rc=0。dist 证据（`grep -F <仓库相对路径> apps/web/dist/assets/*.map`）：
  - 命中 `packages/platform/identity/web/pages/agent-panel/pages/AgentOrganizationsPage.tsx`（`web-BQFMzAZk.js.map`）
    与 `packages/platform/identity/web/i18n/locales/en/orgs.json`（`i18n-C-6WWKdl.js.map`）——
    字典确经包出口注册，不再走宿主路径
  - 命中 `packages/resources/machine/web/api/registry.ts`（`web-DHPVSti_.js.map`）——
    机器注册表来自包内唯一实现
  - **未**命中 `apps/web/src/api/registry.ts` —— 宿主重复副本确实已离开产物
  - `main-wVYkOXRU.js` 同时动态 import 上述两个 `web-*` chunk，组合根的注入在产物中可见

### 7.4 T5a `agent-config/web` 新增 `loadBoundMcps`（2026-09-21）

#### 新增

- `packages/resources/agent-config/web/lib/bound-mcps.ts`：`loadBoundMcps(agentId)`，实现逐段对应源
  `packages/chat-channel/web/components/ChatInterface.tsx:95-122` 的组件内查询链
  （`envApi.get → agentConfigId → agentApi.list → agentApi.get(getAgentConfigLookupKey) → mcpIds →
  mcpApi.list` 过滤），返回形状即 ui-components 的 `boundMcps` 端口类型 `BoundMcpOption`
  （`{ id, name, description: summary }`）。
- `packages/resources/agent-config/web/index.ts`：转出 `loadBoundMcps`，并在文件头的「导出面覆盖当前
  跨包消费方」清单里记明新消费方（宿主 ChatArea）。

#### 两处与源实现的刻意差异

- **不吞错**：源写法是 `void Promise.all([...]).then(async ([...]) => {...})`，其中 `agentApi.get` 的失败
  会落成未处理拒绝；这里按原样抛出，由调用方的 `useRequest` 决定降级（UI 侧表现为「无绑定 MCP」）。
  只有「环境没有所属 Agent」（`agentConfigId` 为空，ACP/Bridge 环境的正常形态）返回空数组。
- **归属理由写进文件头**：该查询同时需要 Agent 配置与 MCP 资源，而 §2.3 禁止 `agent-runtime` 依赖除
  Machine/Sandbox 外的 `resources`（该边已在任务 1.4 W4b 端口化消除），因此只能由 `agent-config` 持有，
  由宿主容器调用——详见 §四.10。

#### 明确不在本片范围

- T5b/T5c/T5d（`ChatArea` 迁宿主、`ChatPanel` 改指、`chat-channel/web` 退场）——本片只做助手，不含任何
  消费方改动，故对现有行为零影响。

#### 验证

- `bun test packages/resources/agent-config` → 405 pass / 0 fail（含 browser-surface 守卫：
  新引用的四个说明符 `@fenix/agent-runtime/web/api/environments`、`@fenix/resource-mcp/web`、
  `@fenix/web-runtime/api/request`、`@fenix/ui-components/chat/shell/chat-interface-types` 均已在
  该包的既有值导入图中，未新增外部依赖）
- `tsc --noEmit`（根）→ 无输出（exit 0）；`tsc -p apps/web/tsconfig.json --noEmit` → 无输出
- `bun run architecture:check` → ✓ 2241 files / 10 rules / 26 条已登记例外
- `bun run check:dependencies` → ✓ 2393 modules / 11 条已登记例外 / 0 条新增违规
