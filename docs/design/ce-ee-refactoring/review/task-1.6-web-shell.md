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
| T5 | `chat-channel/web` 清零 | a,b,c1,c2,c5,d 已交付 | 见下方 §7.4–§7.10 |
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
| T5b | `ChatArea` 簇迁至宿主 | **已交付**（§7.5）：`ChatArea.tsx` / `chat-area-lifecycle.ts` / `chat-layout.css` 迁 `apps/web/src/pages/agent-panel/`；`ProdViewPage` 改注入窄端口；环境删除用例随迁 |
| T5c | `ChatPanel` 改指 ui-components 面板 | **c1 已交付**（§7.6，一致性缺口修复见 §7.7）、**c2 已交付**（§7.8）；c3（宿主注入 `boundMcps`）与 c4（chat CSS 切包）并入 c2——CSS 必须与 DOM 同批，分离提交会出现两端样式都错版的中间态；**c5 测试归位已交付**（§7.9） |
| T5d | `chat-channel/web` 退场 | **已交付**（§7.10）：删 3 个组件与入口共 11 个文件（含 §四.9 的 `ContextPanel` 死代码链）、删 `./web` 出口与 tsconfig paths、knowledge 侧测试与依赖同批删除、删台账 1 条 |

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

### 7.5 T5b `ChatArea` 簇迁至宿主（2026-09-21）

#### 迁移清单

| 动作 | 对象 |
| --- | --- |
| `git mv` | `packages/chat-channel/web/src/pages/agent-panel/ChatArea.tsx` → `apps/web/src/pages/agent-panel/ChatArea.tsx` |
| `git mv` | 同目录 `chat-area-lifecycle.ts` → `apps/web/src/pages/agent-panel/chat-area-lifecycle.ts` |
| `git mv` | 同目录 `chat-layout.css` → `apps/web/src/pages/agent-panel/chat-layout.css` |
| `git mv` | `packages/chat-channel/web/src/__tests__/chat-area-environment-deletion.test.tsx` → `apps/web/src/__tests__/`（导入改宿主相对路径 `../pages/agent-panel/chat-area-lifecycle`） |
| 删除 | `packages/chat-channel/web/chat-area.ts`；随之删 `package.json` 的 `exports["./web/chat-area"]`、`exports["./web/chat-area-lifecycle"]` 与 `packages/chat-channel/tsconfig.json` 的两条 paths |
| 改指 | `AgentPanelLayout.tsx` 第 1 行 → `import { ChatArea } from "./ChatArea"` |
| 样式 | `chat-layout.css` **仍由 `ChatArea.tsx` 副作用导入**（`artifacts-workspace.css` 之后接 `chat-layout.css`，与迁移前逐字相同）。中途曾改挂到 `agent-panel.css` 第 2 行的 `@import`，复核阶段实测到级联倒置（见下方「复核」第 1 条）后已完整回退，`agent-panel.css` 相对 HEAD 无 diff |
| 新增端口 | `packages/resources/prod-view/web/pages/prod-view/ProdViewPage.tsx` 的 `ProdViewChatAreaProps` / `ProdViewPageProps`，由宿主路由 `apps/web/src/routes/view/$prodViewId.tsx` 注入 `ChatArea` |
| 连带 | prod-view `package.json` 移除 `@fenix/chat-channel`；prod-view 的 browser-surface 守卫、README、`fenix.module.ts` 注释与 `prod-view-list-states.test.tsx` 同步 |

#### 三处非显然取舍

1. **`chat-layout.css` 继续挂在 `ChatArea.tsx` 的副作用导入上，不改挂 `agent-panel.css`**（本片最初改挂了，
   复核阶段推翻并回退，结论与理由如下）。这份样式含两份宿主壳层声明（`.agent-panel-content--chat{padding:0}`、
   `.agent-chat-workspace{gap:0}`），它们**必须**排在「静态页面样式」与「`artifacts-workspace.css`」之后才生效：
   - `agent-panel.css` 是 `index.html` 的静态 `<link>`，而 `ChatArea.tsx` 属懒加载 chunk（其 CSS 由 preload
     helper 在运行期 `appendChild` 到 head 末尾）——**运行期注入的样式表必然晚于静态 `<link>`**。迁移前
     chat-layout 与 artifacts-workspace 同属 `ChatArea-*.css`（chat-layout 靠文件内导入顺序在后）而胜，
     且整体晚于静态 `agent-panel-*.css` 而胜。
   - 改挂后 chat-layout 落进静态 `agent-panel.css` 第 2 行（offset ≈24953），于是输给同文件更靠后的
     `.agent-panel-content{padding:12px}`（offset ≈25816）与懒加载 `artifacts-workspace.css` 的
     `.agent-chat-workspace{gap:10px}`：聊天区凭空内缩 12px、docked 布局多 10px 间隙（后者的 headless
     Chrome 复现：`gap:10px`、chat 列宽 756−320−10=426）。
   - 当时的「顺序等价性」论证只核对了 `chat-design` 与 `chat-layout` 之间的重叠选择器（那两项确实无冲突），
     **漏掉了「chat-layout 相对 `agent-panel.css` 自身规则」这一组**（迁移前 chat-layout 晚于它、改挂后早于它）。
   回退后重建产物与 HEAD 的构建**逐字节同名同内容**：`ChatArea-CwUaWDM8.css`（内为 artifacts-workspace
   `gap:10px`@0 → chat-layout `padding:0`@10666 / `gap:0`@10719）与静态 `agent-panel-NcFXVk17.css`。
2. **`ProdViewPage` 改注入 `chatArea` prop 而不是继续 lazy import 聊天包**。理由：分享页只解析
   「哪个 Environment 的哪个实例」，聊天容器持有宿主路由态、keep-alive 槽位与页面壳层样式，按 §2.3
   「Shell 属于 app，不属于资源包」归宿主。端口 `ProdViewChatAreaProps` 刻意小于宿主 `ChatArea` 的完整
   props（不含 `deletedEnvironmentIds`——分享页没有删除流），宿主多出的可选 prop 不影响赋值。
   连带 **prod-view 不再依赖 `@fenix/chat-channel`**（`dependencies` 已移除），其浏览器面守卫的登记表随之
   收窄一条。
3. **删除 `ChatArea.tsx` 的再导出** `export { evictDeletedEnvironmentSlots, resolveActiveChatEnvironmentId }`。
   它的唯一消费方是包入口 `web/chat-area.ts` 的转发（供跨包取用），该入口随本片退场；迁移前实测全仓
   无其他消费方（唯一引用点是那个测试文件，已改为直接导入 `chat-area-lifecycle`）。

#### 实测依据（守卫收窄不是猜的）

- 移除 prod-view 守卫里 `PENDING_MIGRATION_DIRS` 的 `packages/chat-channel/` 条目后该文件仍全绿
  （15 pass），说明 prod-view 的 web 值导入图确实不再包含 `packages/chat-channel/` 下的任何文件；
  同一实测也确认 `packages/chat-channel/web/chat-area.ts` 已从 `reachedPackageFiles` 消失，
  故把这条 pin 从「遍历有效性自检」中删除而不是替换。
- 复核进一步实测：全图宿主别名引用为 **0 处**（本包 0 + 跨包 0），`PENDING_MIGRATION_DIRS` 的两条余留
  登记（`packages/resources/agent-config/`、`packages/platform/identity/web/`）同样不再命中任何引用，
  身份那条还引用了 T4a 已删除的台账条目、并写着实测为 0 的「33 处」，属失实死登记。因此整张登记表与
  `underPendingDirs` 一并删除，断言改为「本包与跨包文件一律零宿主别名」（与清空后的登记制等价，但没有
  一张能被删空而不影响断言的表），并保留 `foreignRefs.length > 20` 作为「空集不是图没跨包」的有效性自检。
  README「边界残留」的对应说明同步改写为「无待迁移债务」。
- 架构台账 `web-package-not-to-app @fenix/chat-channel @fenix/web-app` **本片不动**：迁移后
  `packages/chat-channel/web` 仍有 35 处宿主别名、分布在 5 个文件（3 个待退场组件 + 2 个待归位测试），
  指纹未归零，删条目会命中门禁的「指纹恰好归零」反向报错；该条目的删除归 T5d。

#### 明确不在本片范围

- T5c（`ChatPanel` 改指 ui-components、`boundMcps` 注入、chat 设计层 CSS 切包）与 T5d（组件与入口退场）。
  本片结束时聊天面板仍由 `@fenix/chat-channel/web` 的 `ACPMain`/`ChatInterface` 渲染，`agent-panel.css`
  第 1 行仍指向包内 `chat-design.css`——CSS 切包必须与该 DOM 同批（T5c），否则类名集不匹配会错版。

#### 复核（4 视角评审 → 逐条对抗式证伪，2026-09-21）

四位评审分别走「悬空引用 / 契约与消费方 / CSS 级联 / 门禁与文档」四条线，产出的每条发现再交给独立
复核 agent 尝试证伪（默认判伪、要求亲手复现；13 个 agent / 553 次工具调用）。原始 9 条（其中 CSS 级联
一条被 3 位评审重复报出）去重为 5 个缺陷；证伪读数 8 条成立、1 条判「不可达」——那条正是本表第 1 条，
判「不可达」只因复核运行时我已并发回退，该复核仍用 headless Chrome 复现过它成立时的 `gap:10px`。
5 个缺陷全部已修：

| # | 发现 | 判定与修法 |
| --- | --- | --- |
| 1 | `chat-layout.css` 改挂 `agent-panel.css` 后级联倒置：`.agent-panel-content--chat{padding:0}` 输给 `.agent-panel-content{padding:12px}`（聊天区内缩 12px），`.agent-chat-workspace{gap:0}` 输给 `artifacts-workspace.css` 的 `gap:10px`（docked 多 10px 间隙） | 3 位评审独立发现，3 位复核分别用产物 offset、临时 worktree 对照构建、headless Chrome + 真实 preload helper 复现（`gap:10px`、chat 列 756−320−10=426）。**已回退**：`ChatArea.tsx` 恢复副作用导入、`agent-panel.css` 删除该 `@import`（该文件相对 HEAD 已无 diff），重建产物与 HEAD 同名同内容 |
| 2 | prod-view 守卫的登记制退化为空集恒真，且 identity 登记失实（写「33 处」、引用 T4a 已删的台账条目） | 已删表与 `underPendingDirs`，断言改为全图零别名 + `foreignRefs.length > 20` 自检（见上节） |
| 3 | `packages/ui-components/README.md:88` 与 `web/chat/shell/ChatInterface.tsx:19` 仍以 `@fenix/chat-channel/web/chat-area` 描述宿主路径，该说明符已不可解析 | 两处改为指向宿主 `apps/web/src/pages/agent-panel/ChatArea.tsx` 并注明 T5b 迁入 |
| 4 | ui-components 的 `chat/css/chat-layout.css:4`（复制来源路径）与 `chat/css/chat.css:23`（「源由 chat-channel 的 ChatArea.tsx 导入」）指向已位移的源 | 路径改为 `apps/web/src/pages/agent-panel/chat-layout.css`，并说明宿主 `ChatArea.tsx` 是导入方 |
| 5 | `bun.lock` 与 prod-view `package.json` 不一致（本片移除 `@fenix/chat-channel` 但未重生成锁文件） | 已 `bun install --lockfile-only` 重生成：diff = prod-view 块删该行 + identity 块补齐 T3/T4a 遗留的 13 行漂移（`@fenix/ui-components`/`@fenix/web-runtime`/`ahooks`/`lucide-react`/`sonner`/`happy-dom` 与 peerDependencies）。门禁盲区已确认：precheck 无 install/lockfile 步骤，`--frozen-lockfile` 容忍 manifest 删依赖后的残留（exit 0），只有非 frozen 安装才会暴露 |

复核同时确认的两点「不修」（记录以免重复排查）：

- `apps/web/dist` 的 chunk 归属与迁移前一致（`ChatArea-*.css` 仍属懒加载 chunk），因此上表第 1 条之外的
  级联次序无需再调；`AgentFormDialog-*.css` 里的 `.agent-panel-body{isolation:isolate}` 是动态表覆盖
  静态表的老行为，与 `.agent-panel-body` 的 `min-width/min-height` 无值冲突。
- 架构台账 `web-package-not-to-app @fenix/chat-channel` 仍不动（35 处别名未归零，归 T5d）。

#### 验证

- `env -u ANTHROPIC_MODEL bun run precheck` → ✓ All passed：server-and-script-tests 770 pass / 0 fail、
  package-tests **7334 pass / 2 skip / 0 fail**、web-app-tests **949 pass / 0 fail**（后者 = 迁移前 946 + 随迁的 3 个用例）
- `bun run build:web` → ✓ built，含 `ChatPanel-*.js` / `ArtifactsPanel-*.js` 分片正常产出；
  复核修复后的产物中两个受级联影响的文件与 HEAD 的构建**同名同内容**：`ChatArea-CwUaWDM8.css`
  （`artifacts-workspace.css` 的 `gap:10px`@0 → chat-layout 的 `padding:0`@10666 / `gap:0`@10719）
  与静态 `agent-panel-NcFXVk17.css`——即 CSS 行为已逐字节回到迁移前
- `bun run architecture:check` → ✓ 2240 files / 10 rules / 26 条已登记例外（文件数 −1 = 删除 `web/chat-area.ts`）
- `bun run check:dependencies` → ✓ 2391 modules / 11 条已登记例外 / 0 条新增违规
- `tsc --noEmit`（根）与 `tsc -p apps/web/tsconfig.json --noEmit` → 均无输出（exit 0）

### 7.6 T5c1 ui-components 侧两个缺口补齐（2026-09-21）

T5c（`ChatPanel` 改指 ui-components 面板）拆为 5 个独立提交：c1 ui-components 侧补齐 → c2 `ChatPanel`
改指与端口接线 → c3 宿主注入（`boundMcps`）→ c4 chat CSS 切包 → c5 测试归位。本节只记 c1。

#### 缺口 A：`ACPMain` 丢弃 `onOpenWorkspaceFile`

纯化把「打开工作区文件」从宿主事件总线（`dispatchArtifactsPreviewFile`）改成宿主回调 prop，
`ChatInterface` 用它渲染用户消息正文里的 `@./path` 引用按钮与状态面板的变更文件行；但 `ACPMainProps`
从未声明该 prop，透传给 `ChatInterface` 的那一行也不存在。T5c2 里 `ChatPanel` 即使传入也会被丢弃，
而**类型检查不会发现**——可选 prop 不传合法，传了被忽略同样合法。

修法：`ACPMainProps` 增声明、组件形参解构、透传一行（3 处），行为在 c2 接线后生效。

#### 缺口 B：建议提示词与消息「引用」的包内环路断开

源实现中这两个动作由 `ChatView` 经 window 自定义事件（`chat:apply-suggested-prompt` / `chat:quote`）
回到 `ChatComposer`，生产方与消费方都在 chat 层内部。纯化把派发点改成回调 prop、把消费侧改成宿主注入的
`subscribeExternal`，但没有把这条环路接回去：`ChatInterface` 不传 `onApplySuggestedPrompt` / `onQuote`，
两者恒为 `undefined` ⇒ 点空状态建议提示词、点消息「引用」**静默无反应**（无异常、无日志）。

修法：新增 `web/chat/shell/internal/use-composer-input-bridge.ts`——把包内事件汇入宿主注入的同一条订阅
通道（`ChatInterface` 用「宿主订阅 + 包内处理器集合」的合并订阅喂给 `ChatComposer`，`ChatView` 的两个
回调 `emit` 包内事件）。

两条非显然取舍：

1. **不新增注入端口**（如 `onApplySuggestedPrompt` 回调）：这两个动作的生产方就在包内，要求宿主代为转达
   会把包内环路变成宿主的义务，任一宿主漏接即重现同一种静默失效。合并订阅让「包内事件」与「宿主外部来源」
   对 `ChatComposer` 而言是同一件事，订阅入口仍只有一条。
2. **不做 `contextScope` 过滤**：源实现按 `contextScope` 过滤 window 事件，是因为 window 是全局通道，
   同一页面内多个会话实例（主面板与 MetaAgentPanel 同时挂载）会互相串扰。合并通道按 `ChatInterface`
   实例分发，订阅者集合属于该实例，跨实例串扰在结构上不可能——这不是放宽校验，而是把「靠过滤补救」换成
   「靠作用域不成立」。宿主注入的外部来源（如文件树引用）仍由宿主自己做会话/环境归属过滤
   （`composer-effects.ts` 的纯化说明不变）。

#### 新增测试

`packages/ui-components/web/__tests__/chat-shell-wiring.test.tsx`（3 用例，happy-dom + 包内 mock 会话），
针对的正是上面两种静默失效：

1. 不注入任何宿主订阅时，点空状态建议提示词 → 草稿正文更新（环路闭合）；
2. 宿主外部事件（`file-reference`）与包内事件共用同一通道，两者都到达输入岛（合并未吞掉宿主来源）；
3. `ACPMain` 透传 `onOpenWorkspaceFile`：只读模式渲染 mock 会话，点消息里的 `@./src/lib/context-queue.ts`
   → 回调收到 `(envId, path)`（缺透传行即失败）。

#### 明文不在本片范围

- `ChatPanel` 的改指与端口接线（c2）、`boundMcps` 宿主注入（c3）、chat CSS 切包（c4）、测试归位（c5）。
- 本包仍未被 `apps/web` 接入，c1 交付后线上行为不变：`grep -rl useComposerInputBridge apps/web/dist/assets` 无命中。

#### 验证

- `env -u ANTHROPIC_MODEL bun run precheck` → ✓ All passed：server-and-script-tests **770 pass / 0 fail**、
  package-tests **7337 pass / 2 skip / 0 fail**（= T5b 的 7334 + 3 个新用例）、web-app-tests **949 pass / 0 fail**
- `bun test packages/ui-components/web/__tests__/` → 33 pass / 0 fail
- `bun run build:web` → ✓ built（本包 shell 尚未被接入，无 chunk 受影响）
- `bun run architecture:check` → ✓ 2242 files / 10 rules / 26 条已登记例外（+2 = 新增 bridge 钩子与其测试）
- `bun run check:dependencies` → ✓ 2394 modules / 11 条已登记例外 / 0 条新增违规

### 7.7 T5c1b 端口消费一致性核查与四处缺口修复（2026-09-21，`98a84ad68`）

c2 要把 `ACPMain` 的宿主职责从「组件内直连」改为「宿主注入」，前提是那张端口对照表逐条对齐线上实
现（chat-channel 的 `ChatInterface` / `ACPMain` 是该边界的现役代码，包内实现是它的纯化版）。核查用一
个并发一致性工作流：每个端口一个子代理，读源实现与包内实现两侧代码，产出「源行为 → 包内行为 → 是否
等价」；每条结论再由独立子代理对抗验证（默认尝试证伪，必须给出**线上可达路径**才算 real）。规模 23
个子代理、0 error。

结论：4 条缺口，其中 **1 条 real=True（用户可见）**，3 条 real=False（机制成立，线上链路不可达）。

#### 缺口 A：卡片标签注册表两份模块实例（real=True，用户可见）

- **机制**：宿主 `apps/web/src/lib/card-renderer/{registry,emitter,context}` 与包内
  `web/lib/card-renderer.tsx`（是宿主三文件的超集）是两份互不相通的 `Map`。`agent-sites` 卡片由宿主
  `src/lib/card-renderer/builtins.ts` 注册，而 markdown 渲染方（包内 `web/chat/primitives/message.tsx`）
  在 T3 之后读的是**包内**注册表 ⇒ 标签不在白名单 ⇒ rehype-sanitize 直接剥离整个标签。
- **影响**：助手回复里的站点卡片连同「查看站点」入口一起消失，而 skill 文档规定该卡片是告知用户建站
  访问地址的唯一渠道（禁止手工拼 URL）——即用户拿不到自己刚建好的站点地址。
- **修**：注册落点与渲染方统一到包内注册表（`builtins.ts` + 宿主 `ai-elements/message.tsx`）。宿主
  `src/lib/card-renderer/` 三文件自此是死副本，随 T8 连同 T4a 的别名债务一并删除。

#### 缺口 B：发送边界的图片二次压缩未接端口（real=False）

源实现在输入岛与发送边界（`useChatInputSubmit`）各压缩一次；纯化后 `compressImage` 只接到输入岛，
发送边界不传 ⇒ 只剩一次压缩，失去源实现「发出图片 ≤2MiB」的兜底。对抗验证未能在线上构造出可达路径
（正常链路输入岛已用同一份参数压缩过，判 real=False）；修复理由是端口语义一致：**同一个端口必须被同
一条链路上的所有消费点消费**，压缩失败回退为原文件这类边界仍会走到第二道压缩。

#### 缺口 C：引用配额读渲染期快照（real=False）

源实现用 `quotesRef.current` 同步累加配额；包内 `useSemiControlledState` 只暴露渲染期值 ⇒ 同一 React
批次内连续派发的多条引用各自按旧额度放行，可绕过 8 条 / 8000 字符上限。线上 `chat:quote` 生产方一次
只派发一条，故 real=False。修法：半受控状态原语增第三个返回值 `read`（同一份 ref 的同步读口，源实现
`quotesRef.current` 的等价物），`handleQuote` 改用它；补一条同批次回归测试
（`chat-composer.test.tsx`：一次 `act` 内派发 3 条 4000 字符引用 → 只保留 2 条；去掉修复即失败）。

#### 缺口 D：`onNotice` 未透传到侧栏与头部（real=False）

`ACPMainProps` 已有 `onNotice`，但没有透传给 `ChatHeader` / `SidebarSessionList` / 移动端抽屉三个消费
点 ⇒ 会话重命名、删除失败的提示无出口（源实现在 `SidebarSessionList` 内直连 sonner）。该路径需服务端
返回错误才触发，判 real=False；修它是因为这三处正是该端口在 c2 之后唯一的用途。

#### 提交切分

4 条修复单独成 `98a84ad68`（9 个文件），与 c2 的切换本体分开：修复不依赖 c2 的 DOM/CSS 同批约束，
单独可 `precheck`、单独可回滚。同一文件 `ACPMain.tsx` 按 hunk 级切分——缺口 D 的 4 行 `onNotice` 透传
进本提交，c2 的 `boundMcps?: readonly BoundMcpOption[]` 一行留在切换提交（它服务于 c2 的注入端口）。

#### 验证

- `env -u ANTHROPIC_MODEL bun run precheck` → ✓ All passed：server 770 pass、package 7338 pass / 2 skip
  （= §7.6 的 7337 + 1 个新配额用例）、web-app 949 pass
- `bun run lint` / `bun run typecheck:web` / `bun run check:dependencies` / `bun run architecture:check` → ✓
- `bun run build:web` → ✓

### 7.8 T5c2 `ChatPanel` 改指 ui-components 面板（2026-09-21，`1fd40fb8b`）

本片是 T5 的**原子切换**：`agent-runtime` 的 `ChatPanel` 从 `@fenix/chat-channel/web` 的 `ACPMain` 改指
`@fenix/ui-components/chat/shell/ACPMain`，宿主职责全部经端口注入。c3（`boundMcps` 注入）与 c4（chat
CSS 切包）并入本片而非各自成片，理由见下。

#### 端口装配（新增 `web/agent-panel/chat-panel-ports.tsx`）

12 个端口（`renderPeriTaskDetail` / `sidebarOpen` / `onSidebarOpenChange` / `projectEntries` /
`flushContext` / `uploadFiles` / `compressImage` / `renderFilePicker` / `subscribeExternal` / `onNotice` /
`onStatsChange` / `onOpenWorkspaceFile`）集中在一个模块里装配，逐端口对照表写在文件头（源实现位置 ↔
本模块做法 ↔ 偏差与理由）。`ChatPanel.tsx` 只加两行：`const ports = useChatPanelPorts({ agentId, sessionId })`
与 `{...ports}`，既避免 ChatPanel 越过 500 行红线，也让「每个端口对应哪段源实现」可逐条对照。

**已知风险**：`ChatPanel.tsx` 本片后为 **497 行 / 500 行红线**（端口外移正是为了让本片净增的 18 行不越线）。
T6 把 `ChatPanel` 归位宿主时须顺手拆分（transport 建连与渲染分支已是天然边界），否则下一次改动必然撞线。

两个非显然取舍记在文件头：`onStatsChange` **不传 `emit`**（保住 window `chat:stats` 派发路径，否则
`ChatArea` 的 `useChangedFilesFromStats` 会静默丢掉 ArtifactsPanel 的变更文件）；`subscribeExternal` 只
桥接 `file-tree:reference`（建议提示词与引用已在 c1 走包内闭环，再桥接会重复投递）。

#### 上下文队列双副本修复（用户可见）

`context-queue` 是**有状态**模块（模块级 `Map`）。写入方（`workflow/web`）在任务 1.3 已改指
`@fenix/web-runtime/chat/context-queue`，而取出方（chat-channel `ChatInterface.flushContext`）读宿主副本
`apps/web/src/lib/context-queue.ts`——宿主副本无人写入、恒返回 `null`，**workflow 注入的上下文自 1.3 起
被静默丢弃**。端口改读包副本（与写入方同实例）即修复；宿主副本随 T8 删除。该链路此前没有测试覆盖，
属「1.3 的改指不完整」而非本片引入的回归。

#### `boundMcps` 宿主注入（原 c3）

`loadBoundMcps` 的调用点在宿主 `ChatArea.tsx`：查询同时读 agent-config 与 MCP 资源包，而 `ChatPanel`
所在的 `@fenix/agent-runtime` 按 `.dependency-cruiser.cjs` 的 `agent-runtime-not-to-resources` 不得依赖
resources（含 `agent-config`）。只注入**当前活跃 slot**——keep-alive 的隐藏 slot 若拿到活跃 agent 的
列表，重新激活时会短暂显示另一个 agent 的 MCP 条目。查询失败降级为「无绑定 MCP」（面板仍可用），
与源实现「列表为空则命令菜单不显示 MCP 组」一致。类型上 `boundMcps?: readonly BoundMcpOption[]`
（宿主传入的是只读视图，不复制数组）。

#### chat CSS 切包（原 c4，必须与 c2 同批）

`agent-panel.css` 第 1 行的 `@import` 从 `chat-channel/web/src/pages/agent-panel/chat-design.css` 改指
`packages/ui-components/web/chat/css/chat.css`（聚合入口，按级联顺序导入 12 份分段样式表）；文件末尾原
「玻璃磨砂命令岛」补充段（旧 916–1022 行）删除——该段已逐字包含在包内 `chat-design-composer.css`，且
包内注释记录了它必须排在设计规则之后的级联理由。

**为什么 CSS 不能单独成片**：包内 DOM 的命令菜单是 **4 轨网格**（`.chat-command-menu-command-icon` 行首
图标 + `.chat-command-menu-tail` 尾列包裹，`grid-template-columns: 16px …`），旧样式表是 3 轨、且没有这
两个类的规则。单换样式或单换 DOM 都会错版——这正是「CSS 必须与产生该 DOM 的代码同批」的实例。

#### 其他改动

- i18n：宿主登记第 15 个包命名空间 `UI_COMPONENTS`（字典经 `@fenix/ui-components/i18n`，常量经
  `@fenix/ui-components/i18n/namespace`）。未登记时 i18next 回显原始 key，整片文案变成 `chat.…`。
  T9 的 i18n 重划由此提前一格完成，T9 只剩宿主自有命名空间的收敛。
- `structuredToThreadEntries` 形参放宽为 `readonly StructuredMessage[]`（端口签名要求只读入参）；
  `agent-runtime/package.json` 增 `@fenix/ui-components` 依赖。
- `ChatArea` 惰性加载的 `ChatPanel` 仍按宿主别名解析（`@/src/pages/agent-panel/ChatPanel` 指向
  agent-runtime 的实现），T6 才把 ChatPanel 归位宿主。

#### 明文不在本片范围

`chat-channel/web` 出口与 3 个旧组件的删除、`initialCwd` 的移除（T5d）；测试归位（c5）；宿主
`context-queue` / `chat-stats` / `structured-to-thread` / `artifacts-preview-events` 死副本与整份
`src/lib/card-renderer/` 的删除（T8）；`agent-runtime/web` 的别名清零（T6）。

#### 验证

- `env -u ANTHROPIC_MODEL bun run precheck` → ✓ All passed：server 770 pass、package 7338 pass / 2 skip、
  web-app 949 pass
- `bun run typecheck:web` / `bun run lint` → ✓ 零告警
- `bun run check:dependencies` → ✓ 2395 modules / 11 条已登记例外 / 0 条新增违规
- `bun run architecture:check` → ✓ 2243 files / 10 rules / 26 条已登记例外
- `bun run build:web` → ✓（`ChatPanel` chunk 301.69 kB；dist `agent-panel-*.css` 含 `chat-header-card` ×7、
  `chat-command-menu-tail` ×1、`chat-composer-wrapper` ×5——切换后的样式表确实进入了生产产物；i18n chunk
  含 `quoteLimitReached`，字典装载到位）

### 7.9 T5c5 三个 Chat 测试归位（2026-09-21，`d6a0caceb`）

三个测试此前住在 `packages/chat-channel/web/src/__tests__/`，但它们断言的对象早已不属于 chat-channel：
c2 之后线上渲染的是 ui-components 的 `ACPMain`、派发/消费摘要的是 web-runtime 的模块。留在旧包会同时
产生两个问题——① 断言的是 T5d 即将删除的实现（删 `chat-channel/web` 时测试一起消失，覆盖归零，且不会
有人发现）；② 位置与命名误导后来者，以为 chat-channel 仍是 chat 行为的 owner。

| 测试 | 新位置 | 断言对象 | 迁移改动 |
| --- | --- | --- | --- |
| `acp-main-session-recovery.test.tsx` | `packages/ui-components/web/__tests__/` | 包内 shell 的刷新恢复（loading 中恢复当前会话仍发 `load_session`） | `ACPMain` 改包内相对导入；happy-dom 初始化改用 `@fenix/ui-components/testing`（T3 收敛的唯一实现——原先以相对路径读 `apps/web/src/__tests__/happy-dom-window`，属 `web-package-not-to-app` 越界）；快照类型改 `../chat/types`（ui-components 刻意不与 `@fenix/chat-channel` 建边，类型已在包内重声明，见其 README）；补 i18next 实例初始化（否则包内 shell 的文案走 react-i18next 的「无实例」告警路径） |
| `chat-stats.test.tsx` | `packages/web-runtime/web/__tests__/` | `ChatStatsDispatcher`（`web/lib/chat-stats`）+ `useChangedFilesFromStats`（`web/hooks/use-changed-files-stats`） | 两者都在 web-runtime，故整份迁入，**不必**按原计划拆成「包侧派发方 + 宿主消费方」两半（消费 hook 也已在 web-runtime 有归属）；`ChangedFile` 改 `@fenix/ui-components/chat/lib/extract-changed-files`（web-runtime 实际消费的类型来源） |
| `structured-to-thread.test.ts` | `packages/web-runtime/web/__tests__/` | `web/chat/structured-to-thread` | 投影导入改包内相对路径；`@fenix/chat-channel/server` 的聚合层导入保留 |

其他改动：web-runtime 补 devDependencies（`happy-dom` / `react-dom` / `@types/react-dom`）——包内测试自带
DOM 与 React 渲染需要，`bun.lock` 同步。`bun test packages/` 自动发现，CI 无需改动。

**台账不动**：`scripts/root-source-owner-rules.ts` 里 `web/src/__tests__/…` 的条目按**历史根路径**登记
（RMD-01 → chat-channel），审计对象是已不存在的根目录（`bun run check:root-owner-inventory` → `files=0`）。
改写它等于篡改阶段 1 的迁移记录，故保留原样。

#### 验证

- `bun test packages/ui-components/web/__tests__/ packages/web-runtime/web/__tests__/` → 70 pass / 0 fail
- `env -u ANTHROPIC_MODEL bun run precheck` → ✓ All passed（83876ms）：server 770 pass、package 7338 pass /
  2 skip、web-app 949 pass——迁移前后 **package-tests 总数不变**（3 个文件换位置，用例数相同）
- `bun run build:web` → ✓（纯测试迁移，产物无变化）
- `bun run check:dependencies` → ✓ 2395 modules / 0 条新增违规；`bun run architecture:check` → ✓ 2243 files
- `bun run lint` → ✓（迁移后首跑有 1 条 import 排序错误，已按 biome 修复）

### 7.10 T5d `chat-channel/web` 退场（2026-09-21，`8f364c109`）

c2 之后线上聊天界面由 ui-components 的 `ACPMain` 渲染，`chat-channel/web` 已无运行时消费方；继续保留它
会让「谁渲染聊天 UI」的归属再次含糊，也会让 `@fenix/chat-channel/web` 这个出口成为绕过 `exports` 收敛的
后门。按 §四.9 的裁定整片删除：

| 类别 | 内容 |
| --- | --- |
| 包内 web 面 | `packages/chat-channel/web/**` 共 11 个文件：`index.ts`、`components/{ACPMain,ChatInterface,ContextPanel}.tsx`、`src/pages/agent-panel/chat-design{,-composer,-messages-tools,-responsive,-selection,-shell,-status}.css` |
| 出口与路径 | `package.json` 删 `./web` 出口（`exports` 精确剩 `["." , "./server"]`）；`tsconfig.json` 删 `@fenix/chat-channel/web` paths |
| 死代码唯一消费者 | `git rm packages/resources/knowledge/web/src/__tests__/context-panel-ssr.test.tsx`（5 个用例）；并从 knowledge 的 `package.json` 删 `@fenix/chat-channel` 依赖——全包仅该测试使用它 |
| 死属性 | `initialCwd`：ui-components `web/chat/shell/ACPMain.tsx` 的声明、`packages/agent-runtime/web/agent-panel/ChatPanel.tsx` 的声明 / 解构 / 透传一并删除。c2 起 cwd 由 `ChatArea` 经端口注入，该 prop 在两条渲染路径上都没有消费方 |
| 守卫改写 | `chat-channel-browser-surface.test.ts`：删 `WEB_ENTRY` 常量与两个 web 入口用例（9 → 7 个用例），包内 web 路径并入「旧聊天根路径不存在」，并把 `exports` 键断言（精确等于 `[".", "./server"]`）并进同一用例——出口撤除与文件删除同批受守护 |
| 台账 | `scripts/architecture/exceptions.json` 删 `web-package-not-to-app @fenix/chat-channel -> @fenix/web-app`：该条目的指纹已归零，按门禁规则必须与代码同批删除，否则报 stale |

#### 连带修正（同批必需）

- **`scripts/__tests__/rmd-05-migration.test.ts`**：阶段 1 RMD-05 的 5 条迁移记录里，第 5 条的目标正是被删的
  `context-panel-ssr.test.tsx`，其「目标必须存在」断言因此变红。处置**不是**删条目——那等于篡改阶段 1 的
  迁移记录（与 §7.9「台账不动」同口径）。改为把它移入显式的 `RMD_05_TARGETS_LATER_DELETED`（附删除依据与
  §四.9 出处），保留 `4 + 1 = 5` 的总数断言，并新增用例断言「源与目标都保持不存在」：记录的是「已裁定删除」，
  不是「迁移丢失」。
- **`packages/chat-channel/README.md`**：删去「web vite alias 直连」措辞——T1 起宿主不再登记 `@fenix/*` vite alias，
  浏览器与 bun / tsc / dependency-cruiser 走同一条包 `exports` 通道；并明写「本包不含 UI，聊天界面归
  `@fenix/ui-components/web/chat/**`」。
- **`packages/resources/knowledge/README.md`**：两处引用已删测试的历史记录加注（说明该文件随 `ContextPanel`
  死代码链删除、依据在本文 §四.9），避免后来者按图索骥找不到文件。

#### 遗留（不属 T5d）

- `packages/agent-runtime/web/components/chat/chat-interface-types.ts`（44 行）是 `ChatInterfaceProps` /
  `ChatInterfaceHandle` 的**零消费方死副本**（ui-components 已自持同名类型），其 `hideContextPanel?: boolean`
  一行虽在 §四.9 的删除口径内，但该文件整体归 T6（`agent-runtime/web` 收敛），本片不动。
- `CLAUDE.md` 不变量 11 的「前端 vite alias 直连根入口」措辞、`docs/design/2026-09-18-packages-web-ui-components-migration.md`
  中指向 `chat-channel/web/**` 的行号引用：前者机制描述仍成立（从根入口 re-export 服务端模块会打进 bundle）只是
  通道不再叫 alias，后者是历史快照。两者一并归 T12 的文档复核。

#### 验证

- `env -u ANTHROPIC_MODEL bun run precheck` → ✓ All passed（84972ms）：server-and-script-tests 771 pass、
  package-tests 7331 pass / 2 skip、web-app-tests 949 pass。**package 比 T5c5 后少 7 = 已删的 5 + 2 个用例**
  （`context-panel-ssr.test.tsx` 5 个 + browser-surface 两个 web 入口用例），无其他用例增减。
- `bun run build:web` → ✓ built in 1.90s（删除 CSS 与组件后产物正常生成，无悬空 `@import`）
- `bun run check:dependencies` → ✓ 2390 modules / 11 条已登记例外 / 0 条新增违规（T5c5 后为 2395 modules）
- `bun run architecture:check` → ✓ 2238 files / 25 条已登记例外（T5c5 后为 2243 files / 26 条，差值即本片删除）
- `bun run lint` → ✓（由 precheck 的 lint 步骤覆盖，零告警）

首次 `precheck` 曾因 `rmd-05-migration.test.ts` 红（1 fail / 770 tests），即上方「连带修正」第一条；修正后全绿。

---

## 八、用户可见行为变更

本节汇总 T3–T5c2 期间「包内实现与线上 chat-channel 实现」之间**用户可感知**的差异，供发布说明与回归
验收使用。分两类：切换后修复（此前行为是坏的）、有意的呈现取舍（此前行为正常，包内实现选择不同）。

### 8.1 切换后修复的缺陷

| # | 现象（切换前） | 成因 | 归属 |
| --- | --- | --- | --- |
| 1 | 助手建站后回复里的站点卡片不显示，用户拿不到站点地址 | 卡片注册表两份模块实例（§7.7 缺口 A） | T5c1b `98a84ad68` |
| 2 | workflow 注入的上下文丢失（Agent 看不到工作流上下文） | `context-queue` 双副本，写入方与取出方各持一份（§7.8） | T5c2 |
| 3 | 状态面板「变更文件」里点击文件条目无反应 | 源实现该处派发的事件详情只有 `{path}`、缺 `envId`，被消费方的环境隔离校验判为「其他 environment」恒忽略（工具卡片与消息内 `@./path` 的点击一直正常） | T5c2 |
| 4 | 会话重命名 / 删除失败时无提示 | `onNotice` 未透传到侧栏与头部（§7.7 缺口 D） | T5c1b `98a84ad68` |

第 3 条的修法是两处共用同一个派发器（`dispatchArtifactsPreviewFile(envId, path)`）；事件名未变，变的
是状态面板那条的详情补齐了 `envId`。第 4 条在线上需服务端返回错误才触发（对抗验证判 real=False）。

### 8.2 有意的呈现取舍

| # | 差异 | 理由 | 归属 |
| --- | --- | --- | --- |
| 1 | 工具卡片不再展示脱敏错误的 `Type` / `ID` 两行 | 该块是网格第二列，与标题下方第二行的错误信息重复（`narrate` 的 `errorDetail` 优先取 `publicError.message`），只保留后者的信息量 | T3 `b858bf68f` |
| 2 | 工具卡片运行中标题改为 Shimmer 动效、完成态状态词移除 | 复用包内 `chat/primitives/shimmer`（与推理「思考中」同源），状态词与左侧图标重复 | T3 `b858bf68f` |
| 3 | `TodoChanges` 每条待办右侧的变更标签（带底色 badge）移除 | 变更语义已由左侧图标与文案样式表达；随之删除两个语言包里仅此处使用的 `chat.components.todoChanges.*` | 前置 `e8c73280a` |
| 4 | 用户消息图片缩略图 80px 居中 → 96px（`size-24`）右对齐（`ml-auto`） | 复用包内 `primitives/message-attachments`，与附件条的尺寸/对齐统一 | T3 `b858bf68f` |
| 5 | 附件上传失败提示为通用文案，原文只进控制台 | 包内无法翻译宿主上传回调抛出的业务错误；属包校验的错误（`chatComposer.*` key）仍按原文翻译 | 前置 `e8c73280a` |
| 6 | 空状态建议提示词与消息「引用」的投递范围为**本实例**（源实现走全局 window 事件，靠 `contextScope` 过滤跨实例串扰） | 合并订阅按 `ChatInterface` 实例分发，订阅者集合属于该实例，跨实例串扰在结构上不可能（§7.6 取舍 2）；宿主注入的外部来源（文件树引用）仍由宿主做环境归属过滤 | T5c1 `403af2969` |

第 6 条在线上无可观测差异（验证判 real=False）：源实现的 `contextScope` 过滤已把多实例串扰挡住，包内
实现是把「靠过滤补救」换成「靠作用域不成立」。

### 8.3 发布验收建议

按 8.1 的 4 条做定向回归（建站卡片可见并可跳转、工作流上下文注入、状态面板文件点击、会话重命名失败
提示），8.2 的 6 条按「与旧版截图比对」验一次即可；`chat-channel/web` 尚未删除，旧实现可随时对比
（T5d 删除后仅存 git 历史）。
