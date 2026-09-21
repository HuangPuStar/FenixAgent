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
| T4 | `identity/web` 清零 + i18n | 已交付（a + b 并入 T7） | 4a 见 §7.3 / 4b 见 §7.12 |
| T5 | `chat-channel/web` 清零 | a,b,c1,c2,c5,d 已交付 | 见下方 §7.4–§7.10 |
| T6 | `agent-runtime/web` 收敛 | 已交付（a–e） | 见下方 §7.11 |
| T7 | 5 条 `special-dependency` 消除 | 已交付（含 4b） | 见下方 §7.12 |
| T8 | 宿主组件/lib/api 簇改指并删除 | 已交付（a–d + z） | 见下方 §7.13 |
| T9 | i18n 归属重划与 `quoteTruncatedBadge` 缺陷修复 | **a、b、c、d 已交付** | a 见 §7.15 / b 见 §7.16 / c 见 §7.17 / d 见 §7.18 |
| T10 | 测试迁移与 happy-dom 收敛 | **a、b1–b5 已交付**（余下分片随 T11 收口） | a 见 §7.19 / b1 见 §7.20 / b2 见 §7.21 / b3 见 §7.22 / b4 见 §7.23 / b5 见 §7.24 |
| T11 | WebShell 落地 | **a 已交付**（b–e 见下方分片表） | a 见 §7.25 |
| T12 | 收尾：台账复核、文档修订、证据留痕 | 待办 | — |

**T5 分片**（用户裁定「整体退场，由 ui-components 接管」+「`agent-config/web` 提供助手」的落地顺序；
每片独立可 `precheck`、独立提交，避免一个提交裹住全部改动）：

| # | 标题 | 内容 |
| --- | --- | --- |
| T5a | `agent-config/web` 新增 `loadBoundMcps` | 纯新增助手 + 出口，见 §7.4；`agent-runtime` 不得持有该查询（§四.10） |
| T5b | `ChatArea` 簇迁至宿主 | **已交付**（§7.5）：`ChatArea.tsx` / `chat-area-lifecycle.ts` / `chat-layout.css` 迁 `apps/web/src/pages/agent-panel/`；`ProdViewPage` 改注入窄端口；环境删除用例随迁 |
| T5c | `ChatPanel` 改指 ui-components 面板 | **c1 已交付**（§7.6，一致性缺口修复见 §7.7）、**c2 已交付**（§7.8）；c3（宿主注入 `boundMcps`）与 c4（chat CSS 切包）并入 c2——CSS 必须与 DOM 同批，分离提交会出现两端样式都错版的中间态；**c5 测试归位已交付**（§7.9） |
| T5d | `chat-channel/web` 退场 | **已交付**（§7.10）：删 3 个组件与入口共 11 个文件（含 §四.9 的 `ContextPanel` 死代码链）、删 `./web` 出口与 tsconfig paths、knowledge 侧测试与依赖同批删除、删台账 1 条 |

**T11 分片**（本任务最大的一片：契约、生成器、13 个包的贡献、Shell 落地、37 个 route adapter 与
两套过渡别名表的拆除都在它名下。按「每片独立可 `precheck`、独立提交」拆开，依赖顺序 T11a →
T11b* → T11c → T11d → T11e*）：

| # | 标题 | 内容 |
| --- | --- | --- |
| T11a | 契约与形状定稿 | **已交付**（§7.25）：`@fenix/web-runtime` 新出口 `./shell/contribution`，载荷 `WebAppContribution`（导航项含 id/groupId/order/ns/labelKey/icon） |
| T11b | 各包 `web/contribution.ts` | 按包分批（b1 agent-config、b2 model-management、b3 identity、b4 workflow/skill/knowledge、b5 mcp/task/memory）：贡献导航项 + `exports["./web/contribution"]` + 导航文案随项迁入各包字典 |
| T11c | 生成器与浏览器产物 | `scripts/generate-web-contributions.ts` 读 `deploy/assembly/ce.json` 的 `web` 列表生成 `apps/generated/web-contributions.ts`（只含静态 import）；`ci.ts` 新增子项；`ce.json` 的 `web` 落 13 项 |
| T11d | Shell 落地 | `apps/web/src/shell/`：`DefaultAppShell` 消费产物、侧栏导航改由 registry 渲染、`AgentSidebarConfig` 宿主/包内双写收敛 |
| T11e | route adapter 直连包入口 | 22 条 `@/src/...` 桥接改造 + 删 `apps/web/vite.config.ts` 与根 `tsconfig.json` 的桥接条目 + 宿主剩余页面归位（`AgentHomePage` / `AgentManagementPage` / `AgentDashboardPage`） |

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
- **4b**（**已并入 T7 并随之交付**，见 §7.12）：移除 3 处 `mock.module("@fenix/identity/web", …)`。

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
  **已了结**：整个 `web/components/chat/**` 53 个文件随 T6c2 `f2741a82d` 删除。
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

### 7.11 T6 `agent-runtime/web` 收敛：旧 chat 退场、`ChatPanel` 归位、别名归零（2026-09-21）

#### 前置核查：删除前必须证明包内是超集（用户裁定的硬条件）

用户对「`packages/agent-runtime/web/components/chat/**` 整体退场删除」附加了前置条件：
**删除前先做逐文件行为比对，确认 ui-components 侧是超集**。核查按两步做：

1. **机械预筛**：52 对同名/同职责文件逐对 `diff`。50 对全部有差异——差异来自 T3 的纯化改写
   （`@/` 别名改指包内、i18n 收敛到 `UI_COMPONENTS_NS`、类型包内重声明、宿主依赖改 prop / 端口注入），
   机械 diff 无法区分「纯化改写」与「功能丢失」，故必须逐对语义判定。
2. **语义判定 + 对抗反驳**（工作流 `t6-duplicate-coverage-audit`，57 个 agent）：每对文件由独立核查员
   完整读 A / B 后判定 `superset` / `equivalent` / `gap`，对判为 `gap` 的条目再由对抗核查员尽力反驳
   （倾向驳回，只有找不到任何实现或等价物才承认缺失）。

**结果**：52 对全部返回，`equivalent` 39 + `superset` 10 + `gap` 3；3 对共 5 条 gap 全部被反驳，
**存活缺失 0 条**。5 条 gap 的处置：

| 文件 | 指控 | 处置 |
| --- | --- | --- |
| `ToolCallRow.tsx` | ① `publicError` 块（message + Type + ID）不再渲染 ② 完成态状态词（`Done` / `已完成`）被抑制 | 均为 §8.2 第 1、2 行已登记的 T3 有意取舍（`b858bf68f`），非本片引入 |
| `TodoChanges.tsx` | ① 每条待办右侧的变更标签 badge ② 随之删除的 6 条 `chat.components.todoChanges.*` 文案 | §8.2 第 3 行已登记的 `e8c73280a` 有意取舍；`packages/ui-components/README.md` 同载 |
| `narrators/helpers.ts` | `resolveToolCardKind` 第 3 级「按 title 兜底分类」被删，只读 `tool.semantic` | **采纳并修复**（见下） |

`narrators/helpers.ts` 的反驳意见是「在线链路由投影端口 `projectEntries` 写入 `semantic` / `kind`，
该分支不可观测」。结论虽真，但它把包内行为押在宿主投影契约上（`ToolCallData.semantic` 在包类型里仍是可选）。
包内已有逐字一致的 `../lib/tool-semantic`（含 `classifyToolSemantic`），故直接恢复源实现的三级优先：
`const semantic = tool.semantic ?? classifyToolSemantic({ name: tool.title, rawInput: tool.rawInput, display: tool.display })`，
使该模块不再依赖任何宿主模块也不丢分支——**这是核查发现的唯一实质缺口，已按「删除前补齐」而非「记录为取舍」处置**。

#### T6a：`PeriTaskDetailSheet` 迁 ui-components（`9998926ec`）

| 动作 | 内容 |
| --- | --- |
| 新增 | `packages/ui-components/web/chat/panels/PeriTaskDetailSheet.tsx`（150 行）：Button / Sheet 走包内、i18n 收敛 `chat.components.periTask.*`、`PeriTaskViewProjection` 从 `../types` 取；**详情取数改为 `loadDetail` prop 注入**——源实现直连宿主 `@/src/api/peri-task-details`，而该 API 后端 owner 是 `resources/model-management`，包内不得依赖资源包 |
| 字典 | en / zh 各补 10 键（`periTask.detail*` / `kind*` / `previewOnly`），`i18n-barrel.test.ts` 与 en/zh 键集一致性用例同步通过 |
| 出口 | `package.json` 增 `./chat/panels/PeriTaskDetailSheet` |
| 改指 | `chat-panel-ports.tsx` 改从包导入并把宿主 `getPeriTaskDetail` 注入 `loadDetail`；端口表对应行同步改写 |
| 删除 | 3 个零引用死组件：`TodoPanel` / `PeriTaskList` / `PeriTaskViewCard`（全仓仅注释提及、无 import；待办展示由包内 `TodoChanges` 承接） |

#### T6b：宿主两处改指（`912569796`）

`FilePickerDialog` 改用 `@fenix/ui-components/chat/shell/FilePickerPanel`（`listDir` 经 `unwrap` 解包、
`uploadFiles` 直连 `uploadChatFiles`，与包内 props 文档示例一致）；`AgentManagementPage` 改用
`@fenix/ui-components/chat/shell/AgentBadge`。这两处是宿主对 `agent-runtime/web/components/chat` **仅存的活引用**，
T6c 整体退场的前置。

#### T6c：旧 chat 实现整体退场（`f2741a82d`）

| 动作 | 内容 |
| --- | --- |
| 删除源码 | `packages/agent-runtime/web/components/chat/**` 53 个文件；`packages/agent-runtime/web/src/**` 整目录（2 个孤儿测试） |
| 删除测试 | `web/__tests__/` 中 33 个旧 chat 测试（覆盖已由 T6c1 的 35 个包内测试承接，见 §7.11 上表）；保留 12 个非 chat 测试（`chat-auth-state` / `chat-panel-transport-lifecycle` / `use-chat-state*` / `yjs-*` 等，随 T6d、T6e 处置） |
| 别名清理 | 删除四处 `@/components/chat`：根 `tsconfig.json`、`packages/agent-runtime/tsconfig.json`、`packages/chat-channel/tsconfig.json`、`apps/web/vite.config.ts` |
| 台账 | 删 1 条指纹归零的 stale 例外（`agent-runtime-not-to-resources` → `@fenix/model-management`，唯一消费方 `composer-toolbar.tsx` 已删）；`web-package-not-to-app` 的 rationale 更新为 T6c2 后实测 10 处 / 4 文件（T6 起点 170 处 / 68 文件） |
| 端口反转 | `chat-panel-ports.tsx` 的 `uploadFiles` 改为「包内 `uploadComposerFiles(files, upload)` 做体积校验 → 宿主 `uploadChatFiles(agentId, batch)` 注入」，包内 composer 自此不持网络依赖 |
| 连带修复 | DOM 全局注入成对化（下条） |

**连带修复：`HTMLElement` 与 `customElements` 必须成对注入。** `bun test` 在同一进程内依次求值全部
测试文件，删除 33 个旧测试改变了文件求值顺序，使一个**此前潜伏**的全局污染显形：本包 6 处用例把
`globalThis.HTMLElement` 指向 happy-dom 的构造器却不注入 `customElements`，而 streamdown 的 diff 组件
（`@pierre/diffs`）在模块求值期判定 `typeof HTMLElement !== "undefined" && customElements.get(TAG) == null`
——于是「有 DOM」成立而 `customElements` 为 `undefined`，此后任何导入该链路的文件（`resources/{task,
prod-view,model-management}` 经桶入口间接触达）以 `ReferenceError: customElements is not defined` 崩在
测试之间的空档里（`precheck` 实测 4 例）。修法是在 6 处注入点各补一行 `customElements`（与 `HTMLElement`
同源，`customElements.define` 与 `instanceof HTMLElement` 因此落在同一注册表）；不变量写入
`packages/ui-components/web/testing.ts` 头部（该文件是 happy-dom 初始化的唯一实现）。宿主
`apps/web/src/__tests__/agent-resource-picker-interaction.test.tsx` 的注入在 `afterAll` 已还原全局，不泄漏，
故未改。

#### T6d：`ChatPanel` 归位宿主并拆成三份（用户裁定「宿主注入」）

**先决问题：workflow 包是 `ChatPanel` 的消费方。** 原裁定只说「`ChatPanel` 迁 `apps/web`」，但盘点消费方
时发现 `packages/resources/workflow/web/pages/workflow/components/MetaAgentPanel.tsx` 正从
`@fenix/agent-runtime` 根出口 import `ChatPanel`。若照搬，`@fenix/resource-workflow` 就要依赖 `apps/web`
——踩 `web-package-not-to-app` 与 §2.3 依赖矩阵两条红线。按工程原则第 6 条「职责与公共契约变化必须先反馈」
向用户呈报三个候选（宿主注入 / 面板下沉到 workflow 包 / 端口传递 hooks），用户裁定
**「宿主注入（沿用 T5b 先例）」**：`WorkflowEditor` 声明 `chatPanel` 端口，宿主路由注入自己的实现。

| 动作 | 内容 |
| --- | --- |
| 搬迁（模块） | `chat-auth-state.ts` / `chat-visible-reconnect.ts` / `session-mutation-refresh.ts` 原样 `git mv` 至 `apps/web/src/pages/agent-panel/`；`chat-panel-ports.tsx` 同迁并改写头部（原在包内、现为宿主模块，对包只依赖包出口） |
| 拆分（视图） | `ChatPanel.tsx` 494 行的单文件按天然边界拆三份：`ChatPanel.tsx`（184 行，只做分支渲染 + `PublicErrorCard`）、`use-chat-panel-runtime.ts`（437 行，YJS 建连/重连状态机、commandId 幂等缓存、出站 Action 回调与派生展示态，无 JSX）、`chat-panel-ports.tsx`（205 行，ui-components 面板的宿主端口装配）——各 ≤500 行，满足原则 2 |
| 搬迁（测试） | 4 个测试 `git mv` 至 `apps/web/src/__tests__/`，导入路径改 `../pages/agent-panel/...` |
| 端口形状 | 包侧 `MetaAgentChatPanelProps { agentId; scenePrompt?; contextKey?; onPromptComplete?; hideSidebar? }`；`WorkflowEditorProps` 增 `chatPanel: ComponentType<MetaAgentChatPanelProps>`，`MetaAgentPanel` 只透传不复制会话/连接逻辑（宿主注入端的同型先例见 `routes/view/$prodViewId.tsx` 的 `chatArea`） |
| 注入点 | `apps/web/src/routes/agent/_panel/workflow_.$id.edit.tsx` 增 lazy `ChatPanel` 并 `chatPanel={ChatPanel}` |
| 包出口 | `packages/agent-runtime/src/index.ts` 撤出 `ChatPanel` 导出并在头注写明去向（该出口的契约是「只导出 Environment / Chat / YJS 的浏览器侧实现」，ChatPanel 依赖宿主 i18n 与 identity 的 web 会话，本就不该在此） |
| 别名 | 删 `@/src/pages/agent-panel/ChatPanel` 两条特殊别名（根 `tsconfig.json`、`apps/web/vite.config.ts`），删后由通用 `@/src/*` 覆盖；`ChatArea.tsx` 的 lazy import 改相对路径 |
| 台账 | `web-package-not-to-app`（`@fenix/agent-runtime -> @fenix/web-app`）rationale 由 T6c2 的 10 处 / 4 文件更新为 **2 处 / 2 文件**（`web/hooks/use-chat-state.ts` 与 `use-session-state.ts` 各一处 `@/src/lib/structured-to-thread`，随 T6e 归零）；ChatPanel 6 处与 chat-panel-ports 2 处随本片消失 |
| 连带注释 | workflow 包三处（`web/index.ts` 头注、`workflow-browser-surface.test.ts` 的编辑器守护说明、`workflow-page-route.test.ts` 头注）原先都把「经 ChatPanel 到 `@fenix/chat-channel` 的腿」记为债务，本片改写为「该腿已消失，剩余债务须靠守卫实测」 |

**测试锚点迁移。** `chat-panel-transport-lifecycle.test.ts` 用源码锚点钉住两处建连语义（`acpSessionId:
acpSessionIdRef.current || undefined` 必须存在、`sessionState.acpSessionId` 不得出现在建连 effect 片段内）。
拆分后这两处已移入 `use-chat-panel-runtime.ts`，常量由包内 `agent-panel/ChatPanel.tsx` 改指该文件，断言
与注释同步更新——**没有放宽断言**。

**登记既有 i18n 缺口（属 T9，不在本片修）。** `ChatPanel.tsx` 的 `PublicErrorCard` 标题是硬编码中文
`执行出错`（`git log -S` 追溯为 `0562da970` 迁包时带入，非本片引入）。宿主已有可用键
`components.messageBubble.turnError`，但把它接到错误卡片上属于 i18n 归属重划（T9）的范围，故此处只登记
不改动，避免本片与 T9 重复改写同一文件。

验证：`env -u ANTHROPIC_MODEL bun run precheck` 全绿（package-tests 7311 pass / 0 fail，web-app-tests
968 pass / 0 fail）；`bun run build:web` 成功（`ChatPanel` 独立 chunk 304.73 kB）；拆分后 `bun test
packages/agent-runtime/` 488 pass（原 507 减已迁出的 19）、`bun test packages/resources/workflow/` 725 pass、
4 个搬迁测试 19 pass。

#### T6e：别名与配置收尾，`web-package-not-to-app` 归零

| 动作 | 内容 |
| --- | --- |
| 包内改指 | `agent-runtime/web/hooks/{use-chat-state,use-session-state}.ts` 的 `@/src/lib/structured-to-thread` → `@fenix/web-runtime/chat/structured-to-thread` |
| 宿主改指 | `apps/web/src/hooks/use-task-views.ts` 与其测试的 `@/src/yjs/doc-hub` → `@fenix/agent-runtime`（宿主与包此后取**同一份** doc-hub 模块实例；DocHub 是模块级单例，双实例等于两份 Y.Doc） |
| 别名删除 | `@/src/yjs`：根 `tsconfig.json`、`packages/agent-runtime/tsconfig.json`、`apps/web/vite.config.ts` 各 1 条；该别名只是让包内实现看起来像宿主实现，doc-hub / yjs-ws 本就经包根出口对外 |
| 配置收敛 | `packages/agent-runtime/tsconfig.json` 重写为**只声明 `@server/*`**：原文件另有 6 条指向本包 web 的别名（`@/src/hooks/use-*`、`@/src/pages/agent-panel/*` × 4，后者随 T6d 起目标已不存在）+ 8 条宿主路径别名（`@/src/i18n*`、`@/src/api/*`、`@/src/lib/*`、`@/src/contexts/*`、`@/components/*`、`@/src/*`）。实测包内 `src/**` 与 `web/**` 对 `@/` 的引用已为 0，宿主 `apps/server/src/**` 也无 `@/` 引用，故全部删除。**刻意不补回**：`paths` 一旦存在，包内多写一行 `@/` 也不会报错，别名消失反而让越界在 typecheck 期直接失败 |
| 测试基础设施 | `agent-runtime/web/__tests__/use-chat-state-hook.test.tsx` 的 happy-dom 初始化由相对路径读 `apps/web/src/__tests__/happy-dom-window` 改为 `@fenix/ui-components/testing`——**这是台账该条目的最后一处真实命中**（package 测试跨相对路径读宿主，既越界也让本包离开宿主后无法独立测试）。该做法与 `chat-composer.test.tsx` 一致，也是本任务计划里记的「收敛为跨包测试工具入口」在 agent-runtime 上的落地；`resources/{skill,memory,workflow}` 的 3 份包内副本仍未收敛，属 T10 / 1.3 W4 范围 |
| 台账 | 删除 `web-package-not-to-app / @fenix/agent-runtime -> @fenix/web-app`（T6 起点 170 处 / 68 文件 → 0）。**该条目必须删**：`architecture:check` 对「已不再违规」的登记直接判 red，这也是删除过程中唯一一处「先删条目→检查报红→才暴露出的真命中」——即上面的 happy-dom 相对导入，若按 T6d 时的口径「实测 2 处」直接删条目就会漏掉它 |
| 注释同步 | `tsconfig.json` 的别名段补写 `@/src/yjs` 删除理由；`use-chat-panel-runtime.ts` 头注由「残留 `@/src/yjs/*` 随 T6e 收敛」改为「已随 T6e 删除」 |

**等价性证据（改指前必须核对，不靠「看起来一样」）**：两份 `structured-to-thread` 的 `diff` 只有 4 处——
文件头注释、import 位置（宿主版取 `./tool-semantic` / `./types`，包版取 `@fenix/ui-components/chat/lib/tool-semantic` /
`/chat/types`）、以及 `structuredToThreadEntries` 的入参由 `StructuredMessage[]` 放宽为 `readonly StructuredMessage[]`。
被依赖的 `tool-semantic` 两份**逐字一致**（包版注释自述「逐字复制」）；类型侧包版已拆成
`internal/types-*` 并按 barrel 重导出，但 `structured-to-thread` 对它的使用是 `import type`，不进运行时。
故 `sessionOptionKindsToPermissionOptions` / `chatDocEntriesToStructuredMessages` 的运行时行为不变。

**T6 至此全部交付（a–e）。** 包内 `web/` 保留 `api/` / `hooks/` / `yjs/` / `__tests__/`（agent-runtime 的浏览器侧
实现，经根出口对外）；`@/` 宿主别名在包内为 0，台账本任务名下不再有 `web-package-not-to-app`。

验证：`env -u ANTHROPIC_MODEL bun run precheck` 全绿（server-and-script-tests 771 pass、package-tests 7311
pass / 0 fail、web-app-tests 968 pass / 0 fail）；`bun run build:web` 成功；`bun run architecture:check` ✓
（2183 files / 24 条已登记例外）；`bun run check:dependencies` ✓（0 条新增违规）。

### 7.12 T7 / T4b 组织与会话上下文改经 `@fenix/web-runtime` 契约（2026-09-21，`b5c5323fa` + `9fd834be4`）

**先决问题：契约落在哪。** 5 条 `special-dependency` 的成因完全相同——skill / mcp / knowledge /
model-management / agent-config 的 web 面 `import { useOrg, useSession } from "@fenix/identity/web"`。
但 §6.5 的裁定「组织上下文必须取宿主挂载的**同一份** React context 实例」与 §2.3 的「`resources` 不得
依赖 `platform-impl`」在此正面冲突：资源包内自建 context 会拿到第二个实例（取值永远落在默认值），照搬
identity 的 context 又违反依赖矩阵。按工程原则 6 向用户呈报三个候选（契约落 `@fenix/web-runtime` /
资源包经 props 注入 / 台账长期豁免），用户裁定 **「契约落在 `@fenix/web-runtime`（推荐）」**。

**第二次裁定：`isOwner`。** 裁定后的契约形状是 `{ organizationId, userId, pending }`，但盘点 5 个站点
时发现 `AgentKnowledgeBasesPage` 还需要组织角色（`role === "owner"` 决定 `canManage` 与详情页的
`canManageDetail`）。这同样是公共契约变更，再次弹窗，用户裁定 **「契约补 `isOwner` 布尔（推荐）」**：
只给资源包真实需要的粒度，角色枚举（`owner` / `admin` / `member`）属身份域词汇，不外泄到 5 个包的
类型面。

| 动作 | 内容 |
| --- | --- |
| 契约新建 | `packages/web-runtime/web/contexts/org-session.tsx`：`OrgSession { organizationId; userId; isOwner; pending }` + `OrgSessionProvider` + `useOrgSession()`（不在 Provider 内即抛，不静默回落默认值）；出口 `./contexts/org-session` |
| 实现方投影 | identity 的 `OrgProvider` 新增 `useSession()` 订阅与 `orgSessionValue` useMemo，外层包一层 `OrgSessionProvider`；取数、切换与 fetch 头注入等身份域逻辑仍只在本包（web-runtime 只声明形状） |
| 5 个站点改指 | `AgentSkillsPage` / `AgentMcpPage` / `AgentKnowledgeBasesPage` / `AgentModelsPage` 改 `useOrgSession()`；`agent-config` 的 `use-agent-editor.ts` 同改（原 `useOrg`） |
| 测试断言反转 | 3 条 `*-browser-surface` 的正向固化（`expect(page).toContain('from "@fenix/identity/web"')`）改为「取自契约 + 源码不得出现 `@fenix/identity`」；skill / mcp / knowledge / model-management / agent-config 的跨包到达面钉子由 `packages/platform/identity/web/contexts/OrgContext.tsx` 改指 `packages/web-runtime/web/contexts/org-session.tsx` |
| T4b | 删 3 处 `mock.module("@fenix/identity/web")` 替身，改挂**真实** `OrgSessionProvider`（§6.4 的「4b 并入 T7」据此落地） |
| 台账 | 删 5 条 `special-dependency … → @fenix/identity`（条目 34 → 29；`architecture:check` 24 → 19 条已登记例外，`check:dependencies` 仍 10 条 / 0 条新增违规） |
| 死依赖 | 5 个资源包的 `@fenix/identity` workspace 依赖删除（import 归零后已无消费方），`bun.lock` 同步 8 行 |
| 白名单死条目 | 4 份 `*-browser-surface` 白名单里的「经 `@fenix/identity/web` 传递进入」条目（`better-auth` / `@better-auth/api-key` / `@noble/ciphers` / `@tanstack/react-router`）随边消失删除；**删除本身就是证据**——若它们仍可达，「包外运行时依赖在白名单内」会立刻报红（实测删除后全绿，故确为死条目） |
| 跨包到达面阈值 | skill 25 → 20、mcp 30 → 20（identity 子树离开值导入图，可达面缩小是预期结果）；model-management 的 20 未变 |
| README | skill / mcp / knowledge / task 四份 README 的「边界残留 / 依赖边界 / 守卫范围」段落改写为「已消除」并记录新落点 |

**为什么是 projection 而不是 re-export 身份的 context。** re-export 会把身份域的实现细节（`orgApi.list`
的调用时机、`switchOrg` 的乐观更新与回滚、给全局 `fetch` 注入 `X-Active-Org-Id`）留在资源包的依赖链上，
依赖方向问题只是被一句 re-export 掩盖。投影让资源包的类型面只含四项，且「值来自同一份实现」这一点由
**实现方主动投影**保证：`OrgProvider` 是唯一的投影点，资源包之间不可能各自造出第二份值。

**为什么不选「props 逐层注入」（T5b / T6d 的先例形态）。** 5 个站点都是**整页装配**——宿主路由直接
渲染 `AgentSkillsPage` 这类页面组件，中间没有可注入的宿主边界；补一层包装组件只是把同一个 hook 换个
地方调用，对上下文的依赖既没减少也没消失。契约 + 单 hook 与「取宿主同一份 context 实例」的约束同构，
且不需要为 5 个页面各加一个包装点。

**契约用 `null`、消费方口径是 `undefined`：在取值处一次归一。** 契约按 `/web` 视图模型的既有习惯用
`string | null` 表达「不存在」（与 `types/config.ts` 的 `string | null` 一致）；5 个站点的比较函数
（`isExternalSkill` / `isExternalMcp` / `providerMatchesScope` / `mapModelOptions`）与子组件 prop 用的是
`string | undefined`。取舍是**在取值处归一**（`const activeOrganizationId = organizationId ?? undefined;`）
而不是把 `| null` 扩散进这些签名：null 语义挡在契约边界内，调用点保持原样，改动面最小。

**T4b 的测试保真度确实提高了，不只是「换个注入方式」。** 3 个 page-states 用例原先的替身是
`useOrg: () => ({ org: { id: "org-current" }, role: "owner" })`——它把页面**怎么用**组织上下文也一并
替身掉了（`role` 到 `isOwner` 的转换、会话与组织两个来源的合并都不过被测代码）。改挂真实
`OrgSessionProvider` 后，页面走的是契约的真实解构与比较路径：少给一个字段（例如漏挂 Provider）用例会
立刻抛 `useOrgSession must be used within OrgSessionProvider`，而不是静默拿到默认值继续跑。取值与旧替身
逐项等价：`organizationId` 与用例内的资源归属一致（否则本组织资源会被判成共享来源）、`isOwner: true`
对应旧 `role: "owner"`、`userId: undefined` 对应旧空会话。

**观察到但未处理的既有现象（非本片引入）。** `bun test packages/resources`（本任务期间用于快速回归的
**窄口径**）在本片改动前后都报 4 例 `# Unhandled error between tests`：3 例是 `@pierre/diffs` 模块求值期
的 `ReferenceError: customElements is not defined`，1 例是 `spawn zip` ENOENT（本机无 `zip`）。基线对比：
在 HEAD 的临时 worktree 跑同一命令同样得 4 errors（另有 98 例失败是该 worktree 的路径依赖用例，与本片
无关），故为既有条件而非本片引入。CI 的真实门禁 `bun test packages/`（`scripts/ci.ts` 的 package-tests）
全绿，本片未触及它的触发面；§7.11 记录的「`HTMLElement` 与 `customElements` 必须成对注入」修复针对的是
T6c2 删除 33 个测试后的求值顺序，本节不重复处理，统一归 T10（测试迁移与 happy-dom 收敛）。

**登记一处文档债务（不属本片可写范围）。** `packages/resources/model-management/README.md` 用行号引用
`scripts/architecture/exceptions.json`（`:239` / `:303` / `:407`）；本片删除 5 条条目后文件降到 266 行，
这些引用彻底失效（该段本就自述「已失真」）。model-management 的 README 归该包与 T12 文档收尾，本片只
登记不改写。

验证：`env -u ANTHROPIC_MODEL bun run precheck` 全绿（server-and-script-tests 771 pass、package-tests
7311 pass / 0 fail / 2 skip、web-app-tests 968 pass / 0 fail）；`bun run build:web` 成功；
`bun run architecture:check` ✓（2184 files / 19 条已登记例外）；`bun run check:dependencies` ✓
（2335 modules / 10 条已登记例外 / 0 条新增违规）；5 个资源包与 model-management / prod-view / task 的
`*-browser-surface` 与 3 个 page-states 专项用例全部通过。

---

### 7.13 T8 宿主副本簇退场（2026-09-21）

T8 的验收目标是让 `apps/web` 不再持有「owner 已经迁走」的实现副本。宿主副本与包内实现并存会持续制造
分叉（本任务已两次遇到宿主副本与包内契约语义不一致），因此本片的判定标准必须是**可复现的实证**而非
文件名或体量估算。

#### 判定口径（三张清单，先用脚本产出再动手）

1. **「副本」的判定**：按**行集合相似度**打分（非空、非注释行集合的交并比），并对每个候选做**逐导出面
   比对**（导出名、导出种类、签名差异逐条列出）。文件名相同或目录名相同都不作为证据。
2. **「改指后删」的执行**：用**确定性 codemod** 重写所有消费方的导入说明符，再删宿主文件。codemod 必须
   同时解析三种说明符形态——相对路径、tsconfig `paths` 中的 `@/` 别名、vite `alias`——只替换说明符本身。
3. **消费方包含宿主测试**：把测试的 import 改指到包出口是本片的责任；T10 只负责搬迁测试文件本身。

实测规模：**80 个删除目标**、**215 个消费点**（三种形态分别计数）。相似度打分低于 0.7 的 12 项逐一定性，
其中 8 项是 basename 假阳性（同名不同物），2 项是真分叉（`tree`、`file-tree-view`）——后者都取到了包内
自带的超集证明或导出面实证，故仍按「改指后删」处理。

一次必须记录的教训：首轮扫描的 `paths` 解析正则漏掉了 `["./..."]` 这一 JSON 形态（`[` 后紧跟引号），
导致全部别名形态消费点被漏计（消费点从 44 处升到 215 处）。消费点计数偏低的代价是删掉仍有引用的文件，
所以扫描脚本的解析覆盖度本身就是证据链的一部分，不能靠抽查验证。

#### 簇划分与提交序

按「同一批宿主文件不会被多簇同时改写」切分，每片可独立跑门禁、独立提交：**T8a** `components/ui/**`、
**T8b** `components/config/**` + `components/ai-elements/**`、**T8c** `src/components/**` 11 个副本、
**T8d** `src/{lib,hooks,api,types}` 簇（含 10 项零消费直删）。零消费且包内无对应物的宿主文件（`lib/{retry,
form-utils,api-result}.ts`、`api/helpers.ts`、`App.tsx`）按 T2 先例保留，交 T10 处理。

同样必须记录的一条方法论取舍：本片**没有**用并发子代理改文件。多簇会改同一批宿主文件
（`ArtifactsPanel.tsx` 同时消费 `lib` 与 `components`），并行代理写同一文件必然冲突；codemod 逐簇串行、
可复现、可审计，是这里唯一正确的执行方式。

#### T8a：`apps/web/components/ui/**` 退场（`451e2163c`）

删除 36 个路径（35 个副本 + `index.ts` 聚合器），28 个文件被 codemod 改指（65 处），
`tsconfig.json` 与 `apps/web/vite.config.ts` 各自的 `@/components/ui` 别名同步删除。

**契约差异处置（1 处）**：`date-picker.test.tsx` 原断言宿主副本用 `useTranslation("datePicker.placeholder")`
取默认占位；包内契约明确为「英文默认文案 + 调用方 `placeholder` 覆盖，不自带 i18n 单例」，本地化由
`locale` prop 承担。按 owner 契约改写断言（`Select date`，并补 `locale="en-US"` 用例），差异写在
`apps/web/src/__tests__/date-picker.test.tsx` 头注。同批**删除该文件模块作用域的 `react-i18next` 替身**
与配套 `afterEach(mock.restore)`——CLAUDE.md 禁止测试直接调用 `mock.module()`，且该替身会跨文件残留。

#### T8b：`components/config/**` 与 `components/ai-elements/**` 退场（`9b19d15c9`）

删除 11 个文件（`config` 4 + `ai-elements` 6 + `chat-message-content.css`），`apps/web/components/` 目录
随之消失；8 个文件被 codemod 改指（8 处），`tsconfig.json` 与 `apps/web/vite.config.ts` 的 `@/components/*`
别名删除。

**契约差异处置（1 处）**：`data-table-ssr.test.tsx` 的分页断言。宿主副本是硬编码中文「上一页/下一页」
（无对应 i18n 键），包内改为英文默认值并在实现处明文登记为「已知限制：仅这两个按钮的可见文案未本地化，
移除条件是消费方提出本地化需求」。该用例守护的是「`pageCount > 1` 时翻页控件出现」这条结构，语言差异
随 owner 契约走，断言改为 `Previous` / `Next`，理由写在测试注释内。

**连带修正（同批必需）**：

- `packages/chat-channel/tsconfig.json` 删除 5 条指向宿主 `apps/web` 的死别名（`@/components/ui/*`、
  `@/components/*`、`@/src/api/request`、`@/src/lib/utils`、`@/src/*`）。§1.3 静态条件 3 要求
  `packages/**` 内不得出现指向 `apps/web` 的相对路径，而包内实测零 `@/` import，这些条目只会让宿主式
  说明符在包内静默解析成功。保留指向包内的 5 条。全仓包 `tsconfig.json` 现已无 `apps/web` 条目。
- `confirm-dialog.test.tsx` 的「内部用 AlertDialog」断言改读包内实现
  （`packages/ui-components/web/config/ConfirmDialog.tsx`），守护意图不变。
- `components.json`（shadcn CLI 配置，`Dockerfile:18` 会 `COPY`，不能删）的 `aliases` 全部指向已被
  本片删除的路径，一并修正为真实落点：`ui` → `packages/ui-components/web/ui`（owner 包，新增 UI 原语
  应落在包内而非宿主），其余四项指向仍存在的宿主目录。
- `scripts/__tests__/rmd-08-migration.test.ts` 台账同步：`RMD_08_MOVES` 删 11 条（152 → 141），
  `RMD_08_RELOCATED` 增 11 条三元组（10 → 21，owner 为 `packages/ui-components/web/{chat/primitives,config}/*`）。

#### T8c：`apps/web/src/components/**` 副本簇退场（`f2ae6bf59`）

删除 11 个路径（`PreviewTab`、`file-tree-{input-dialog,model,view}`、`file-icon-helper`、
`layout/{app-header,app-page}`、`preview/{FileViewerPreview,html-plugin,native-pdf-plugin,overrides.css}`），
7 个宿主文件 11 处消费点改指到 `@fenix/ui-components` 的 `components/**` 与 `layout/**` 出口。

**超集证明先行（本片最重的一项）**：`file-tree-view.tsx` 是最可疑的候选——宿主单文件 544 行、与包内
同名文件的行集合相似度只有 0.41。实测证明这是**拆分造成的相似度失真**而非功能缺失：宿主单文件在包内被
拆成 `file-tree-view`（容器）+ `file-tree-arborist`（含 sticky 目录条、`ResizeObserver` 测高、
`requestAnimationFrame` 滚动换算、行内新建/删除/刷新按钮）+ `file-tree-context-menu`（7 个菜单项、
视口贴边、portal 到 body）+ `file-tree.css`，四者并集覆盖宿主的全部非空行，逐行等价（差异只有改名、
`viewProps` 类型收窄、`32`/`12` 提为 `ROW_HEIGHT`/`INDENT` 常量、i18n 命名空间）。该结论与包内头注
自带的纯化取舍说明互相印证，故此处的「副本」判定不采信相似度分数。

**契约差异处置（1 处，含消费方适配）**：包内 `FileTreeView` 去掉了宿主契约里的 `envId`（宿主概念，
不应进入公共契约），改为语义化的 `canMutate`；同时摘除在该视图内**没有任何使用点**的死 props
`isDirectory` 与 `onOpen`。因此消费方 `FileTreeTab.tsx`（宿主活文件，未随包迁移）需要同步适配：
`envId={envId}` → `canMutate={!!envId}`、删掉 `isDirectory` / `onOpen` 两个传参，并删除因此不再被引用的
`isDirectory` `useCallback`（`findFileNode` 仍被 `handleToggle` / `handleContextMenu` 使用，保留）。
三处适配的语义等价性：`canMutate` 的判定与源实现逐字一致（`disabled={!props.envId}` → `disabled={!canMutate}`），
`onPreviewFile` 仍经 `handleSelect` 生效（`onOpen` 在源实现里从未被调用）。

**零消费直删 4 项**：`preview/{FileViewerPreview,html-plugin,native-pdf-plugin,overrides.css}` 的唯一宿主
消费方就是 `PreviewTab`（本身是副本），`PreviewTab` 改指包出口后这 4 项在宿主零引用，直接删——它们的
owner 在包内（`web/components/preview/**`）。同目录的 `preview/utils.ts` **不删**：`ArtifactsPanel.tsx` 与
`preview-utils-normalize.test.ts` 仍在消费它，这正是包内 README 第 43 条「只取子集、原文件保持不动」的
前提，本片不得推翻。

**验收无回归的一处核对**：包内 `PreviewTab` 与 `FileTreeView` 的文案改用包内 `UI_COMPONENTS_NS`。
逐字核对后确认两处文案值与宿主一致（面板标题 zh「文件」/ en `File Browser` ↔ 包内 `fileTree.title` 同值），
且宿主 `apps/web/src/i18n/index.ts:123,140` 已注册该命名空间与字典，故不是用户可见变化。

**呈现取舍（1 处，登记到 §8.2）**：`AppHeader` / `AppPage` 的硬编码色值（`#e4eaf2` / `#17233a` /
`#94a3b8` / `#f5f7fb`）在包内改为主题 token（`border` / `text-bright` / `text-muted` / `surface-0`）。
宿主 `apps/web/src/index.css` 已定义同名 token，且亮色值已在同色域（`surface-0` 为 `#f8fafc` 而非
`#f5f7fb`），因此有极轻微的色差，换来的是暗色主题下不再破色。这 3 个消费方页面（`AgentDashboardPage` /
`AgentManagementPage` / `workflow.tsx`）的视觉验收应纳入回归清单。

**契约收窄的一处连带改动**：`file-tree-model.ts` 的 `MAX_FILE_UPLOAD_SIZE_LABEL` 依赖宿主上传上限配置
（`@/src/api/fs` 的 `MAX_UPLOAD_SIZE_BYTES`），包内只收纯数据子集。该常量改由唯一消费方
`use-file-uploads.ts` 自持，理由写在常量注释内（业务配置而非组件契约，因此不迁入包内）。

**台账同步**：`RMD_08_MOVES` 141 → 130，`RMD_08_RELOCATED` 21 → 32（owner 为
`packages/ui-components/web/{components,layout}/**`）。

#### T8d + T8z：`src/{api,hooks,lib,types}` 副本簇退场与零消费直删

**为何与 T8z 合并成一批**：T8d 删掉 `lib/types.ts` 后，T8z 的直删目标 `lib/token-stats.ts` 会立刻报
TS2307（`Cannot find module './types'`）。两片拆开必然产生一个类型检查失败的中间提交，故合并为一批。

**T8d：15 项「改指后删」，60 处消费点 / 29 个文件改指**（其中 15 个是宿主测试——按 T8 口径，测试
文件的导入说明符由本片改指到包出口，测试文件本身的搬迁属 T10）。

| 宿主副本 | 包内 owner 出口 |
|---|---|
| `src/api/request.ts` | `@fenix/web-runtime/api/request` |
| `src/hooks/{use-changed-files-stats,usePageVisible}.ts` | `@fenix/web-runtime/hooks/**` |
| `src/lib/{agent-node,agent-resource-access,agent-utils}.ts` | `@fenix/agent-config` 的 `web/lib/**`（本片新增 3 条出口） |
| `src/lib/{artifacts-preview-events,chat-stats,config-events}.ts`、`structured-to-thread.ts`、`todo.ts` | `@fenix/web-runtime` 的 `lib/**` 与 `chat/**` |
| `src/lib/{extract-changed-files,strip-html-tags,tool-semantic}.ts`、`types.ts` | `@fenix/ui-components` 的 `chat/lib/**` 与 `chat/types` |

`agent-config` 的三条 `./web/lib/*` 出口是本片新增。归属理由：这三个模块是 agent 配置领域的浏览器侧
助手（解析 agent 节点、判定资源可访问性、配置展示助手），与既有的 `./web` 出口同属一层；放进
`web-runtime` 会污染「跨资源运行时契约」的定位，放进 `ui-components` 则与 UI 无关。

**T8z：9 项零消费直删**：`lib/{context-queue,token-stats,citation-preview-context.tsx}`、
`lib/card-renderer/{index,registry,emitter,context.tsx}`、`types/{cytoscape-fcose,react-file-icon}.d.ts`。

- `card-renderer/` 的 4 项是宿主死副本：宿主注册表与包内注册表是两份互不相通的模块实例，而 markdown
  渲染器已归 `@fenix/ui-components`（`web/chat/primitives/message.tsx` 读的是包内注册表），写进宿主
  注册表的条目不会被渲染。同目录 `builtins.ts` **保留**：它是宿主的注册入口（`main.tsx:6` 经
  `./lib/card-renderer/builtins` 加载），负责把宿主专有的 `agent-sites` 卡片注册到包内注册表；其文件
  注释同步更新为「本目录其余文件已随 T8z 删除」。
- 两份第三方类型垫片的归属本来就在各包（`packages/resources/memory/web/types/cytoscape-fcose.d.ts`、
  `packages/ui-components/web/types/react-file-icon.d.ts`），宿主只是重复声明。

**连带修正 1：`apps/web/tsconfig.json` 的 include 补包垫片 glob。** 删掉宿主垫片后
`tsc -p apps/web/tsconfig.json` 报 3 处 TS7016——宿主 tsc 会顺各包 `exports` 的 types 条件检查包源
文件，而包自带垫片不在宿主 include 内，`declare module` 不生效。修正为
`../../packages/*/web/types/*.d.ts` 与 `../../packages/*/*/web/types/*.d.ts` 两条 glob，理由写在
该文件注释里。这是把「宿主为包提供类型」的隐式耦合显式化，而不是在宿主保留副本，也不是放宽检查。

**连带修正 2：`context-queue.test.ts` 拆成两个 owner 来源。** 宿主副本删除后，用例里「有状态队列」
与「纯函数」两组断言分别断言 `@fenix/web-runtime/chat/context-queue`（`contextQueues` 模块级 Map，
即 workflow 写入方与 chat-channel 取出方共用的那一个实例）与 `@fenix/ui-components/chat/lib/context-queue`
（无副作用的引用解析/截断/序列化）。拆分的理由写在文件头注释内。

**连带修正 3：死别名条目清理。** 根 `tsconfig.json` 与 `apps/web/vite.config.ts` 删除 `@/src/api/request`
条目；`@/src/lib/card-renderer` 条目同样删除（`@/src/lib/card-renderer/*` 通配保留，`main.tsx` 走相对
路径 `./lib/card-renderer/builtins`）。

**未列入本片的宿主 `src/lib` 保留项**：`app-brand` / `clipboard-polyfill` / `random-uuid-polyfill` /
`streamdown-table-patch` / `theme` / `utils` 在包内**没有**对应实现（逐个 `find` 核对，同名文件都在
无关目录），不是副本；`api-result` / `auth-preference` / `form-utils` / `retry` / `password-crypto`
仍在台账在册，宿主仍有活消费方。二者都不属本片范围。

**台账同步**：`RMD_08_MOVES` 130 → 111（在册的 T8d 14 项 + T8z 5 项；`api/request.ts` 与
`card-renderer/**` 本就不在 MOVES 中，故 19 ≠ 15 + 9），`RMD_08_RELOCATED` 32 → 47（T8d 15 项的三元组）。
台账里 `password-crypto.ts` 一行的第二个元素是 `packages/...` 而非 `apps/web/...`，用脚本重排数组时必须
按原文保留——本片第一次批量改写就把它漏掉了，靠长度断言（111 vs 110）才发现。

#### 验证

T8a / T8b / T8c / T8d+T8z 四片各自跑过一轮完整门禁，均全绿。最终一轮（含 T8d+T8z）：
`env -u ANTHROPIC_MODEL bun run precheck` 全绿（format / import-sort / module-registry / architecture /
tsc server+web+app-skeletons / dependency-boundaries / lint / server-and-script-tests 771 pass /
package-tests 7311 pass + 2 skip / web-app-tests 969 pass，0 fail）；`bun run build:web` 成功。
结构性证据（四片合计）：全仓零 `@/components/*` 导入说明符；`apps/web/components/` 目录已不存在，
`apps/web/src/components/` 仅剩 9 个活文件（`FilePickerDialog`、`agent-panel/{FileTabsBar,FileTreeTab,
TopModeTabs,artifacts-dialogs,artifacts-files-workspace,use-file-tree-events,use-file-uploads}`、
`agent-panel/preview/utils.ts`）；`apps/web/src/{api,hooks,lib,types}` 的副本已清空，剩余 20 个文件里
`src/lib` 的 11 项均有明确归属（6 项宿主专有、5 项台账在册仍有活消费方，见上），`src/types` 只剩
`global.d.ts` 与 `index.ts`，`src/hooks` 只剩 `use-task-views.ts`。T8d 的改指由确定性 codemod 完成，
`dry` 复核为 0 处残留；台账的 `RMD_08_MOVES` 全条目（111 条）的 legacy 路径与 `RMD_08_RELOCATED`
（47 条）的 legacy + shell 路径均不存在、owner 落点均存在。

### 7.15 T9a identity 借键结清（2026-09-21，`fc5a39f85`）

T9 拆四片：**T9a 借键结清**（本节）、T9b i18n 缺陷修复、T9c 宿主自有命名空间收敛、T9d 公开错误正文
本地化（§7.18，由 T9b 末段登记的跨包缺口派生）。范围以本文件 §7.10 的结论为准——「T9 的 i18n 重划由此
提前一格完成，T9 只剩宿主自有命名空间的收敛」（T5c2 已把包命名空间的注册做完，`uiComponents` 字典随切换接入）。

**债务来源**：T4（§7.3）把 identity 的字典搬进包内时，**只搬了 apikey / orgs 两份**，
`ChangePasswordDialog` 读的宿主 `NS.SETTINGS`（11 键全在 `apps/web/src/i18n/locales/*/settings.json`）
与 `OrgContext` 读的宿主 `NS.COMPONENTS`（键 `orgSwitchFailed`）留作债务，由
`identity-i18n.test.ts` 的 `BORROWED_KEYS` 白名单**双向**登记（既覆盖全部越界键，又反向断言这些键
此刻不在本包字典里）。本次搬迁后白名单与其文件头债务注释一并删除——不留「已搬迁但仍被豁免」的通道。

**不改命名空间，只改 owner**：沿用中心表已有的 `NS.SETTINGS`（`"settings"`），把字典 owner 从宿主搬到
identity 包，而不是新建一个 `account` 命名空间。理由：`settings` 命名空间在宿主已无任何其它消费方
（11 键全部来自这一个对话框），新建命名空间只会让「设置」语义在两个 literal 之间分裂。

**改动**：

| 项 | 处理 |
|---|---|
| `apps/web/src/i18n/locales/{en,zh}/settings.json` | `git mv` 到 `packages/platform/identity/web/i18n/locales/{en,zh}/settings.json`（**译文逐字未变**） |
| 宿主 `i18n/index.ts` | 删除该字典的 import 与 `hostResources` 条目；改从 `@fenix/identity/web/i18n` 取 `SETTINGS_NS` / `settingsResources`，登记进 `packageResources` |
| identity `web/i18n/{namespace,index}.ts` | 新增 `SETTINGS_NS` 与 `settingsResources` 出口；头注从「两个命名空间」改为三个并写明搬迁来由 |
| `ChangePasswordDialog.tsx` | `useTranslation(NS.SETTINGS)`（web-runtime 中心表）→ `useTranslation(SETTINGS_NS)`（本包出口） |
| `OrgContext.tsx` | `useTranslation(NS.COMPONENTS)` → `useTranslation(NS.ORGS)`；`orgSwitchFailed` 从宿主 `components.json` 搬入 identity `orgs.json`（译文逐字未变） |
| `identity-i18n.test.ts` | 收下第三份字典（键集一致、占位符一致、规模底线 ≥11）；删除 `BORROWED_KEYS` / 借键吻合断言 / 债务断言；「字面量键都在字典内」改为无白名单 |

**台账同步**：`RMD_08_MOVES` 111 → 109（`settings.json` 两份的宿主落点不再存在），
`RMD_08_RELOCATED` 47 → 49（owner = `packages/platform/identity/web/i18n/locales/{en,zh}/settings.json`）。

**验证**：`env -u ANTHROPIC_MODEL bun run precheck` 全绿（771 / 7310 + 2 skip / 969，0 fail）；
`bun run build:web` 成功。首次 precheck 时 `package-tests` 出现过一次非确定性失败
（`packages/resources/machine/src/server/__tests__/file-ws-events.test.ts:207`「未声明环境的事件被丢弃并写
registryEvent 告警」）：该文件单跑 12 pass、`bun test packages/` 连跑两轮均 7310 pass 0 fail，
随后两轮 precheck 亦全绿——与本次 i18n 改动无因果关系（该用例不涉及 i18n），按非确定性失败记录。

### 7.16 T9b i18n 缺陷修复：引用截断徽标漏译、错误卡片标题硬编码（2026-09-21，`90138dcd8`）

| # | 缺陷（修复前） | 成因 | 处理 |
|---|---|---|---|
| 1 | 引用被截断时，**中文界面显示英文徽标**：正文里出现 `23 chars omitted` | `quoteTruncatedBadge` 的 en / zh 两份值逐字相同（照抄 en）。既有的「键集一致」「插值占位符一致」两条守护都挡不住这类漏译——键在、占位符也在，只是译文没写 | zh 改为 `已省略 {{count}} 个字符`（与同级 `quoteTruncated`「引用过长，已省略 {{count}} 个字符」用词一致）；`i18n-barrel.test.ts` 增一条钉住该键 zh ≠ en 的断言 |
| 2 | 该徽标的渲染无人守：T6c1 前那条断言固化的是「key 回显」缺陷（当时宿主字典缺此键），按规则删除后未恢复 | — | `message.ssr.test.tsx`「用户消息将结构化引用显示为引用胶囊」用例恢复断言：断言真实译文 `23 chars omitted`（用例 i18next 实例 `lng: "en"`）并显式否定 key 回显 |
| 3 | 会话面板错误卡片标题对英文用户显示中文 `执行出错` | T6d 拆 `ChatPanel.tsx` 时硬编码带入（`git log -S` 追溯为 `0562da970` 迁包时引入），§7.11 已登记「属 i18n 归属重划（T9）」 | `PublicErrorCard` 改经 `t()`：命名空间 `NS.UI_COMPONENTS`，键 `chat.components.messageBubble.turnError` |

**为什么标题取包命名空间，而不是 §7.11 登记的宿主 `components.messageBubble.turnError`。** 核查后改判：同一张卡片
（同样的 class 串、`role="alert"`、`Type:` / `ID:` 尾注）在 `@fenix/ui-components` 的 `MessageBubble.tsx` 渲染 turn
失败错误时**已经**在用 `chat.components.messageBubble.turnError`；而宿主 `components.json` 的整个 `messageBubble`
子树（11 键）在 T6 搬迁后已无任何宿主消费方。取包键 = 一处文案一个 owner，宿主那份死字典随 T9c 整体删除；
取宿主键则要在 11 键死字典里留下唯一复活的 1 键，与 §4「键的最终所在地 = 包的 owner」相悖。宿主消费包命名空间
有既有先例（`AgentManagementPage` 用 `NS.AGENTS`、`routes/admin/*` 用 `"observer"`），常量经中心表
`NS.UI_COMPONENTS` 取，未新增 import。

**登记未处理（→ 已由 T9d 按方案 ② 处理，见 §7.18）：`PublicError.message` 恒为英文，中文界面必然中英混排。**
`packages/chat-channel/src/public-error.ts` 的 `PUBLIC_ERROR_MESSAGES` 为 28 个 type 各备 `zh` / `en` 两条，但
`createPublicError` 与跨边界校验 `isPublicError` 都把它钉在 `.en` 上（后者要求 `message === PUBLIC_ERROR_MESSAGES[type].en`
才认作合法公开错误）——`zh` 那一半在**全仓没有任何读取点**，只有 `src/__tests__/public-error.test.ts` 断言它非空；
而两处 UI 卡片（包的 `MessageBubble` 与宿主 `PublicErrorCard`）都直接渲染 `error.message`。因此本片修完标题后，
中文界面下卡片仍是「中文标题 + 英文正文」。可选修法有三条——① 保持契约现状、只登记；② 前端按稳定的 `error.type`
查本地化字典渲染；③ 把 28×2 条文案从 TS 表迁进包 i18n 字典、由 UI 按 `type` 取——三条都会改到 `@fenix/chat-channel`
的公共契约或引入跨包同步义务，按 CLAUDE.md「公共契约变化必须先反馈」留待用户裁定，**本片未改动该文件**（T9d
同样未改动它，理由见 §7.18）。

**验证**：`bun test packages/ui-components/` 412 → 413 pass（新增 1 条守译断言）；`bun test
packages/ui-components/web/__tests__/message.ssr.test.tsx` 11 pass / 40 expect；宿主
`chat-area-environment-deletion` + `chat-panel-transport-lifecycle` 4 pass；`env -u ANTHROPIC_MODEL bun run precheck`
全绿（771 / 7311 + 2 skip / 969，0 fail）；`bun run build:web` 成功。

### 7.17 T9c 宿主自有字典收敛：死键剪除与四份空壳字典退场（2026-09-21，`e69deeeb1`）

T9 的第三片（写就时以为收尾，随后 T9b 登记的跨包缺口又派生出 §7.18）。T9a 结清借键、T9b 修缺陷，
本片只做一件事：把宿主自有命名空间里**无人消费的键**和**零绑定的整份字典**清掉，并给宿主补上与各包
对等的一致性守护。

**判定口径（证据脚本 `/tmp/t9/deadkeys.py`，不入库）。** 消费点 = 全仓 `.ts` / `.tsx`（含测试、含
`ui-sandbox`，排除 `node_modules` / `dist` / `docs`）里的**字符串字面量**；文件归属的命名空间由
`useTranslation(<arg>)` 解析（`NS.X` 查中心表、`<CONST>` 查各包 `namespace.ts`、字面量；无参 →
`common`），据此把「形如点路径的裸字面量」记为该文件绑定命名空间下的消费；显式限定 `"<ns>:<path>"`
单独记账；模板字面量按静态前缀 + 尾缀匹配。**无 `useTranslation` 调用的文件里的点路径字面量一律进
UNKNOWN 集合且永不删除**——口径刻意保守，宁可留下真死键也不误删。结果：**684 条确定性死键 + 136 条
UNKNOWN**。

**过程中发现并修补的两个脚本缺口（都不修补就会真的误删）：**

1. **裸模板字面量被整段跳过。** 初版对 `"${" in raw` 的字面量直接 `continue`，于是
   `FileTreeTab.tsx` 的 `` t(`fileTree.dialog.${errorKey}`) ``、`` t(`fileTree.dialog.${dialogKind}Title`) ``
   这类动态键被判成死键。修补为「前缀是点路径且以 `.` 结尾、尾缀是纯标识符」时记录为「前缀 + 尾缀」
   消费（两条件共同排除把 URL / 拼装串当成键前缀）。确定性死键 700 → 684，救回 16 条，其中
   `agentPanel:siteDeployment.visibility.*` 5 条已核实为 `packages/resources/agent-config/web/pages/`
   两个页面经 `NS.AGENT_PANEL` 的真实消费。
2. **脚本只以 zh 字典为准遍历，en 单侧的键从未进入审查。** 补做 en / zh 单侧键审计后查出
   `agentPanel.dragHint`（**仅 en 存在、全仓 0 个消费点**，全仓唯一出现即字典自身）——删掉 en 那一份后
   宿主字典的 zh / en 键集才完全对称。这条缺口说明「以单一语言字典为遍历基准」的判定结构会系统性漏掉
   单侧键，故把「键集逐字一致」固化成守卫（见下方新增测试）。

**整份退场：`TASKS` / `SESSIONS` / `ENVIRONMENTS` / `TOOL_NARRATOR`。** 决定性判据是「全仓有无
`useTranslation(<该 ns>)` 绑定」——四者均为 **0**（`NS.TASKS_V2` 之类的 `NS.X` 精确匹配已排除词边界
干扰；`NS.X` 在 `i18n/index.ts` 的登记处与中心表自身的出现不计），即字典 100% 无人读取。它们各自的
UNKNOWN 残留（合计 38 条，如 `active` / `online` / `sessions`）来自 DB 状态值、Y.Doc key、URL 段等
无关文件里的通用词字面量，不是真实消费方。8 个 JSON 文件（4 命名空间 × 2 语言）整份删除；`i18n/index.ts`
的 import 与 `hostResources` 登记同步移除；守护 `toolNarrator` 字典的**自指测试**
`apps/web/src/__tests__/narrators-i18n.test.ts` 一并删除（它只读该字典并断言同一文件里的键，字典没了就
没有对象可测）。

**保留中心表里这四个常量名。** `packages/web-runtime/web/i18n/namespace.ts` 的 `NS.TASKS` 等 4 个
常量**不删**：它是跨包共享的**名称注册表**，删常量没有功能收益（字典与登记都已不在），却要改一处
跨包契约文件并牵动全部消费方。取舍是「名称注册表可以比实际在用的命名空间宽」，与 §4「键的最终所在地
= 包的 owner」不冲突——那条约束管的是键与字典，不是名称常量。此项已在 `i18n/index.ts` 头注写明。

**剪除量与分布（zh 侧键数，en 侧多删 1 条 `dragHint`）。**

| 字典 | 前 | 后 | 处置 |
|---|---:|---:|---|
| `components` | 472 | 103 | 删 369 条死键 |
| `agentPanel` | 141 | 116 | 删 25 条死键 |
| `common` | 94 | 63 | 删 33 条死键，**补 2 条**（见下） |
| `dashboard` | 43 | 3 | 删 40 条死键 |
| `login` | 57 | 44 | 删 13 条死键 |
| `sidebar` | 26 | 19 | 删 7 条死键 |
| `agentHome` | 21 | 19 | 删 2 条死键 |
| `environments` / `sessions` / `tasks` / `toolNarrator` | 68 / 60 / 85 / 20 | 0 | 整份删除（其中 38 条 UNKNOWN 随字典一并消失） |
| **合计** | **1087** | **367** | **净 −720** |

`agentPanel.json` 含内联短对象（`"pagination": { "label": … }`、`"status": { "published": … }`），
`json.dumps` 重排会产生与本次剪除无关的整文件 diff，故对它改用**行级**剪除（删末键后留下的尾逗号单独
清理），diff 只含删行与一处逗号移除；其余字典先逐字节校验 `json.dumps(…, indent=2) + "\n"` 与原文一致
再重写。

**顺带补齐 `common.next` / `common.previous`。** 这两条不是本次删的键，而是审计中发现的**反向缺口**：
`packages/resources/memory` 的 `DocumentsView` 以限定字面量引用宿主 `common:previous` / `common:next`，
且该包的 `memory-i18n.test.ts` 已把 `["common:cancel", "common:next", "common:previous"]` 登记为
「跨命名空间依赖，只能依赖已登记三条」——宿主 `common` 字典却只提供了 `cancel`。即字典相对**已声明的
跨命名空间契约**是缺的，中文界面下这两处分页按钮一直靠 `defaultValue` 显示英文。按「引用的键必须在
字典里」的不变式补齐（zh 上一页 / 下一页，en Previous / Next），使下面那条守卫无需任何豁免名单。

**对抗验证（三重独立检查 + 双向对照）。** 删键的风险全在「删过头」，故用三种口径反查被删的 685 条键：

1. **ns 感知的调用点反查**：对每个被删键，找出 `t("key")` 调用点，只在该文件绑定的命名空间**包含**该
   宿主命名空间时才算疑点 → **0 条**。
2. **整串严格相等**：文件绑定了该宿主命名空间，且文件里出现「整串等于键或等于 `<ns>:<key>`」的字符串
   字面量 → **0 条**（此口径已用阳性对照验证有效：`agentPanel.selectAgent`、`agentPanel.showArtifacts`、
   `sidebar.navGroupCore` 均被正确命中）。
3. **HEAD 与现版字典的回归对照**：同一引用在 HEAD 版字典可解析、现版不可解析 → **0 条**。

中途三种宽松口径曾分别报出 341 / 189 / 105 条疑点，逐条定位后**全部**是校验器自身的口径缺陷而非误删：
末段子串匹配过松（`error` 命中任意含该词的字符串）、同文件多个 hook 的绑定取并集后归属错位
（`AgentManagementPage` 第 68 行绑 `NS.AGENTS`，第 171 行的 `t("management.title")` 属 agents 包）、
限定符未校验（`"agentPanel:apiKeys"` 被当作 `sidebar:apiKeys`）。三种口径收敛到零且阳性对照有效后才提交。
另外确认 `apps/web/src/lib/theme.ts` 的 `"light" | "dark"` 是主题联合类型取值、`routes/__root.tsx` 的
`errors.not_found` 等是无关命名空间，均非 i18n 引用。

**新增守护：`apps/web/src/__tests__/host-i18n.test.ts`。** 每个资源包都有自己的 `*-i18n.test.ts`，宿主
此前**一份都没有**——这正是 `dragHint` 单侧漂移和 684 条死键能长期无人发现的结构性原因。本片把包侧的
四条断言补到宿主侧：① 每份字典 zh / en 键集逐字一致（挡 `dragHint` 类）；② 每份字典两个语言文件都存在
且非空（挡「两边一起缺」）；③ `i18n/index.ts` 登记了全部**且仅有**磁盘上的宿主字典（挡「有字典没登记 →
整片回显 key」与「登记了没文件 → 引导期 import 失败」两种形态）；④ 全仓限定字面量 `t("<ns>:<key>")` 都能
在对应宿主字典里查到（挡删键时连带踩掉跨包引用，同时独立校验各包登记的跨命名空间清单）。两条关键断言
都做了负向对照（人为删 `common.cancel`、人为造 en 单侧键），确认失败信息准确。

**台账同步**：`RMD_08_MOVES` 109 → **100**（8 份字典 + 1 个自指测试的落点不再存在），按既有先例从清单
移除条目、递减长度断言、在文件头追加第 7 条改判说明，并补一条「自指测试不得复活」的断言。

**登记新债务（本片不处理）：包页面跨包消费宿主命名空间。** 迁移后仍有多处**包内**页面直接绑定宿主的
`NS.AGENT_PANEL` / `NS.COMPONENTS`（如 `packages/resources/agent-config/web/pages/agent-panel/` 的
`AgentSitesPage.tsx` / `agent-sites-catalog.tsx`，`packages/resources/skill`、`model-management`、
`mcp` 的同类页面），使宿主 `agentPanel` / `components` 两份字典实际是「包与宿主共用」。这是 §1.3
「资源的浏览器入口只从 `./web` 导出…」尚未走完的部分，方向是把这些键的 owner 交还各资源包并新建
命名空间。本片按死键口径处理时已把这些**真实消费方全部保住**（第 1 条验证正是为此），但归属没有改变
——故 `agentPanel` / `components` 两份字典在收拾资源包命名空间时应一并复核，属「改职责边界」的决定，
不在本片范围。

**邻近发现（本片未处理，仅登记）**：`apps/web/src/App.tsx` 的 `parseConfigView` 只被它自己的
`config-routing.test.ts` 消费，全仓无生产调用点（`/ctrl/*` 前缀已由 TanStack 文件路由接管）——属 T8
「零消费直删」口径的漏网项，因不在 i18n 范围内故本片未删。另：包内仍有 415 行硬编码中文用户可见文案
（46 个文件，集中在 knowledge 的 RAGFlow 组件、model-management 的两个目录页、task 的 zod 校验层），
远超本任务范围，登记为技术债。

**验证**：`bun test apps/web/src/__tests__/` 962 → 966 pass（删 7 条自指用例、新增 4 条宿主守卫，
0 fail）；`bun test packages/` 7311 pass / 2 skip / 0 fail（首轮用 `bun test packages/` 直跑时有 8 条
Claude ACP adapter 用例失败，系会话注入的 `ANTHROPIC_MODEL` 污染环境，`env -u ANTHROPIC_MODEL` 复跑
同批次 1016 pass 0 fail，与本次改动无关）；`env -u ANTHROPIC_MODEL bun run precheck` 全绿
（772 / 7311 + 2 skip / 966，0 fail）；`bun run build:web` 成功。

### 7.18 T9d 公开错误正文按 `type` 取本地化文案（2026-09-21，`2a61e7513`）

T9 的第四片，结掉 §7.16 末段登记的那个跨包缺口。用户 2026-09-21 裁定走方案 ②：UI 用稳定的 `error.type`
取本地化文案，`message` 退化为「未登记 type 的兜底 + 日志字段」，**wire 契约与 `isPublicError` 完整性校验不变**。

**为什么不能直接渲染 `message`**：它是 `PublicError`（WS 错误帧载荷，`chat-channel/src/schema.ts` 第 66 / 79 / 131 行）
的字段，`createPublicError` 恒取 `PUBLIC_ERROR_MESSAGES[type].en`，而 `isPublicError` 更把它当作**不可信帧的完整性
依据**（要求 `message === PUBLIC_ERROR_MESSAGES[type].en` 才认作合法公开错误）。也就是说 `message` 属于协议、
且必然恒为英文；界面正文改由 `type` 取译文后，它只剩「未登记 type 的兜底」一个前端用途（日志侧
`serializePublicErrorLog` 只记 `errorId` / `errorType`，本来就不用它）。

**落地（三个文件 + 两处调用点）**：
- 字典：`@fenix/ui-components` 的 `uiComponents.json` 新增 `chat.components.publicError.<域>.<原因>`，28 键 ×2 语言。
- 取值：新增 `web/chat/view/public-error-text.ts` 的 `publicErrorText(t, error)`，两处卡片共用。键 = 前缀 + `type`，
  **不做「type → 键名」映射表**——协议 type 自带 `<域>.<原因>` 结构，字典按同样两级嵌套组织，少一张表就少一处会与
  协议漂移的第二真相（漏键由穷举断言挡）。未登记 type 回退 `error.message`，绝不回显 key。
- 调用点：包内 `MessageBubble.tsx`（`publicErrorText(t, entry.error)`）与宿主 `ChatPanel.tsx` 的 `PublicErrorCard`
  （`publicErrorText(t, error)`）——此前两处都直接渲染 `error.message`，是同一个缺陷的两个现身点。

**方案 ③（把 28×2 条文案从 TS 表迁进字典、删表里的 `zh`）没有一并做**：`PUBLIC_ERROR_MESSAGES` 是
`@fenix/chat-channel` 的公开导出，删掉 `PublicErrorMessages.zh` 字段属公共契约变更（CLAUDE.md 要求先反馈），
且该包为 CE / EE 共享，EE 侧可能自行消费 `zh`。代价是同一句中文在两处各存一份——改用**宿主契约测试**钉住
（见下表第三行），而不是靠人工同步。**本片未改动 `@fenix/chat-channel` 任何文件。**

**守护测试**：

| 文件 | 钉住什么 |
| --- | --- |
| `packages/ui-components/web/__tests__/public-error-text.test.ts`（新） | 内联契约的 `PublicErrorType` 取值集合 ↔ 字典 `publicError` 子树**双向**一一对应（少键 = key 回显或退回英文，多键 = 协议已删 type 留下的死键）；28 条 zh 均非 en 照抄；`publicErrorText` 的键推导与两条回退路径（未登记 type、未登记且摘要为空） |
| `packages/ui-components/web/__tests__/message.ssr.test.tsx` | 新增一条中文渲染用例：把 `entry.error.message` 刻意写成与字典都不同的第三种文案，断言渲染出中文且**不出现**该 message——组件若退回读 `message`，会同时命中两个失败面 |
| `apps/web/src/__tests__/public-error-i18n.test.ts`（新） | 协议表 ↔ 字典逐字相等（28 个 type 的 en / zh），且字典不含协议表之外的 type。落点在宿主：`apps/web/src/i18n/index.ts` 是全仓唯一同时依赖两个包的地方 |

`public-error-text.test.ts` 的类型清单**从 `types-chat-projection.ts` 源码里解析**而不是在测试里再抄一份：
本包对 chat 契约整体逐字内联，抄一份就等于多一处会漂移的第二真相，且协议新增 type 时测试不会跟着变。

**对照验证（三条都在本次实测）**：删一条 zh 键 → 穷举断言失败；把 `MessageBubble` 退回读 `entry.error.message`
→ 中文渲染用例失败；把字典某条 zh 改写一个标点 → 宿主契约测试失败（失败信息直接打印协议表值与字典值两侧）。

**验证**：`bun test packages/ui-components/` 413 → 420 pass（新增 6 + SSR 用例 1）；`bun test apps/web/src/__tests__/`
966 → 968 pass（新增 2）；`env -u ANTHROPIC_MODEL bun run precheck` 全绿（772 / 7318 + 2 skip / 968，0 fail）；
`bun run build:web` 成功。

### 7.19 T10a happy-dom 五份副本收敛为一份（2026-09-21，`31e2da0c7`）

T3 已把 `initializeHappyDomWindow` 定为**唯一实现**（`@fenix/ui-components/testing`，落点理由见该文件头注：
本包是 `standalone` 纯前端包、依赖矩阵允许全部类别依赖它，放在 `apps/web/src/__tests__/` 则会被
`.dependency-cruiser.cjs` 判为 `web-package-not-to-app` 越界），并留下了 5 份副本中的第 5 份；
副本本身的删除留在本片。

本片删除宿主 `apps/web/src/__tests__/happy-dom-window.ts` 与 `resources/{memory,skill,workflow}` 各
`web/__tests__/happy-dom-window.ts` 共 4 份。4 份与唯一实现**逐字相同**（差异只在注释），所以删除是行为等价
改动，不需要「先证明包内是超集」那一轮前置核查（对比 §7.11）。删除后 8 个调用点改经
`@fenix/ui-components/testing` 导入；连同 T6e 已先改指的 agent-runtime 那 1 处，全仓 9 个调用点走同一入口，
`happy-dom` 由本包在 `devDependencies` 声明，调用点不再各自声明。

连带修正两处指向旧副本路径的注释：`apps/server/src/test-utils/setup-globals.ts`（说明「需要真实 DOM 的
用例各自显式建立 happy-dom Window」的落点）与 `packages/resources/memory/README.md` 已知项 3（由
「happy-dom-window.ts 有 4 份副本」划改为「已收敛」）。

**验证**：改指的 8 个文件 48 pass 0 fail（`apps/web` 2 + memory 2 + skill 1 + workflow 3）；
`git ls-files | grep -c happy-dom-window` = 0。完整门禁与 `build:web` 见 §7.20（本片与 T10b1 在同一工作区
里跑门禁时，唯一失败项是 T10b1 尚未同步的 RMD-08 台账，补台账后全绿）。

### 7.20 T10b1 宿主测试按 owner 归位：12 个 ui-components 用例迁入包内（2026-09-21，`f1ce9ddd5`）

T10 的第二片。判定口径是**导入图谱**而不是文件名相似度：把宿主 `apps/web/src/__tests__/` 的 60 个用例逐个
解析 import 说明符，按「包所有 / 宿主所有 / 标准库 / 相对宿主」四分类，凡「被测实现的 owner 已在 T8b/T8c 归
`@fenix/ui-components`，且用例除标准库外只引用该包出口」者即搬——留在宿主等于让「包内实现」被「应用壳测试」
守护，而 T8b/T8c 已把宿主副本删干净，这类用例正是宿主侧仅存的续命引用。

迁入 `packages/ui-components/web/__tests__/` 的 12 个：表格与分页 `config-datatable`、`config-helpers`、
`data-table-round41-pure`、`data-table-ssr`、`pagination`、`params-editor-round42-pure`；日期与确认
`date-picker`、`confirm-dialog`；纯逻辑与 SSR `extract-changed-files`、`extract-changed-files-boundaries`、
`strip-html-tags`、`message-additional-ssr`。

迁移改动只有两类：import 说明符改指包名自引用（`@fenix/ui-components/...`，仓库已有
`@fenix/ui-components/testing` 先例）；以及 `confirm-dialog.test.tsx` 里读实现源码的路径——原先从宿主以
四级相对路径回包读，迁入后变成同包内一跳 `join(import.meta.dirname, "..", "config/ConfirmDialog.tsx")`。
三处提到 `apps/web` / 「宿主副本」的历史注释（`confirm-dialog:53`、`data-table-ssr:95`、`date-picker:1`）
描述的是**T8a/T8b 已删除的宿主副本**，与用例当前落点无关，按「注释不改写历史结论」保留原文。

**台账与搬迁同批**（计划红线）：这 12 项从 `RMD_08_MOVES` 移出（`toHaveLength(100)` → 88），按 relocated
语义追加进 `RMD_08_RELOCATED`（`toHaveLength(49)` → 61，断言旧根路径与宿主副本都不存在、包侧 owner 存在），
文件头追加第 8 条改判、块内计数注释同步。只搬文件不改台账会被门禁直接挡住
（`apps/web target is missing: apps/web/src/__tests__/config-datatable.test.ts`）——这正是「不许静默搬迁」的
守护形态，门禁对「指纹恰好归零」的条目反向报错、对新增指纹直接失败。

**本片排除项（逐条有因，不是遗漏）**：`dark-mode-components.test.tsx` 的被测主体是宿主全局样式表
`apps/web/src/index.css` 的 `.dark` 变量块，owner 仍是宿主；`peri-task-details-api`、`use-task-views`、
`pure-logic-transform-boundaries`、`agent-form-dialog-*`（4 份）的导入图里仍有宿主实现（`../api/*`、
`../hooks/*`、`../lib/*`），要等 T11 把页面与别名的宿主实现收口后才能判定归属；`chat-area-*`、
`config-routing`、`host-i18n` 等被测对象本来就是宿主装配，留在宿主。余下分片按同一口径继续。

**验证**：宿主 `apps/web/src/__tests__/` 60 → 48 个用例文件，包侧 `packages/ui-components/web/__tests__/`
41 → 53 个；`bun test packages/ui-components/` 420 → 596 pass 0 fail；
`bun test scripts/__tests__/rmd-08-migration.test.ts` 6 pass（含两条 relocated / moves 断言）。
完整门禁 `env -u ANTHROPIC_MODEL bun run precheck` 全绿（772 / 7496 + 2 skip / 792，0 fail），
`bun run build:web` 与 `bun run docs:build` 均成功。

### 7.21 T10b2 宿主测试按 owner 归位：7 个 web-runtime 用例迁入包内（2026-09-21，`2a8c45b1e`）

T10 的第三片，判定口径与 T10b1（§7.20）同一张导入图谱，owner 换成 `@fenix/web-runtime`：`request` 与两个
`structured-thread-*`、`todo`、`permission-options`、`artifacts-preview-events`、`config-types` 共 7 个宿主
用例的导入说明符除标准库外全部指向该包出口（`api/request`、`chat/{structured-to-thread,todo}`、
`lib/artifacts-preview-events`、`types/config`），宿主侧的被测实现已在 T8d 整体退场，用例留在宿主是同一种
「包内实现被应用壳测试守护」。

**本片是纯搬运**：7 个文件的 import 在 T8d 改指时就已写成包名自引用，因此工作区里只有 `git mv` 与台账，
没有任何文本改动（rename 相似度 100%）——这也反过来验证了 T8d 的改指是完整的。

`request.test.ts` **不在 RMD-08 快照内**（它守护的 `api/request` 是 T8d 才上收到包里的），本片一并归位并补进
relocated 断言，避免它成为台账之外的宿主复活口。

**台账与搬迁同批**：6 项（`request.test.ts` 不在快照内）从 `RMD_08_MOVES` 移出（`toHaveLength(88)` → 82），
7 项追加进 `RMD_08_RELOCATED`（`toHaveLength(61)` → 68），文件头追加第 9 条改判。

**验证**：`bun test packages/web-runtime/` 157 pass 0 fail（该包用例文件 3 → 10）；
`bun test scripts/__tests__/rmd-08-migration.test.ts` 6 pass。宿主 `apps/web/src/__tests__/` 48 → 41 个用例文件。
完整门禁 `env -u ANTHROPIC_MODEL bun run precheck` 全绿（772 / 7618 + 2 skip / 670，0 fail），
`bun run build:web` 与 `bun run docs:build` 均成功。

### 7.22 T10b3 收尾 ui-components 归属：1 项随实现迁入、1 项按 owner 拆开、1 项重复覆盖直删（2026-09-21，`c0c70dfcd`）

T10 的第四片，宿主侧最后一组「除标准库外只引用 `@fenix/ui-components` 出口」的用例。三种处置：

**① `tree-component.test.tsx` 随实现迁入包内**（`@fenix/ui-components/web/__tests__/`），并把两处
`mock.module` 替身换成**真字典 + `I18nextProvider`**（与 `message.ssr.test.tsx` 同一约定）：
- 对宿主 `@/src/i18n` 的替身是宿主副本时代（T8a 之前）的残留——`ui/tree` 只依赖包内 `web/i18n/namespace`，
  包内不存在该导入方，删除后用例仍全绿，等于顺带证明它是死替身。
- 对 `react-i18next` 的替身必须改掉：**它实测会跨文件泄漏**。本文件迁入包内后与 `message.ssr.test.tsx`、
  `chat-composer.test.tsx` 同进程求值，`afterEach` 的 `mock.restore()` 挡不住已经拿到替身绑定的模块，
  整包测试随即出现 14 条失败——i18n 断言退化成回显 key（`chat.components.composerAssets.quoteNumber`）。
  换成真字典后恢复全绿；顺带也满足了「测试文件禁止直接调用 `mock.module()`」（CLAUDE.md）。

**② `context-queue.test.ts` 按 owner 拆开**。它一个文件同时守护两个 owner：队列状态（`contextQueues` 模块级
Map）归 `@fenix/web-runtime/chat/context-queue`，纯函数子集（引用解析 / Unicode 安全截断 / 序列化）归
`@fenix/ui-components/chat/lib/context-queue`。拆开后：队列一半**随宿主副本一并删除**——它与该包
`web/__tests__/context-queue.test.ts` 的 7 条用例**逐字重复**（同注释、同断言），留一份即够；纯函数一半移入
包内新用例。宿主侧因此没有覆盖损失。

**③ `ui-components.test.ts` 直删（重复覆盖）**。它是一份 87 行的 barrel 冒烟用例，两类断言都已有更强或对位的
守护：导出名清单由包内 `barrel-exports.test.ts` 逐名 + 计数 + `package.json` 出口一致性覆盖（该文件明确
「只断言公共出口的名称与非空性，不渲染组件、不 mock 模块」）；`cn` 的两条断言守护的是**宿主**自己的
`apps/web/src/lib/utils.ts`，故不迁包、并入宿主 `utils.test.ts`（该文件原先未覆盖 `cn`）。删除按
「重复覆盖」口径，不属搬迁。

**台账与改动同批**：`context-queue.test.ts` 与 `tree-component.test.tsx` 从 `RMD_08_MOVES` 移出
（`toHaveLength(82)` → 80）；`tree-component.test.tsx` 追加进 `RMD_08_RELOCATED`（`toHaveLength(68)` → 69）；
拆分归属无法用 relocated 三元组表达，另立专项断言（`splits the host context queue test between its two
package owners`：旧的根路径与宿主副本都不得复活、两个 owner 侧用例都必须存在）。文件头追加第 10 条改判。

**验证**：`bun test packages/ui-components/` 617 pass 0 fail（迁入两个用例文件后 58 → 60 个文件、596 → 617
个用例）；四个对位文件（web-runtime 与 ui-components 各一份 `context-queue`、`tree-component`、宿主
`utils.test.ts`）65 pass 0 fail；`bun test scripts/__tests__/rmd-08-migration.test.ts` 7 pass。宿主
`apps/web/src/__tests__/` 41 → 38 个用例文件（web-app-tests 630 pass / 38 文件）。
完整门禁 `env -u ANTHROPIC_MODEL bun run precheck` 全绿（773 / 7639 + 2 skip / 630，0 fail，lint 零
warning），`bun run build:web` 与 `bun run docs:build` 均成功。

### 7.23 T10b4 宿主测试按 owner 归位：8 个 agent-config 用例迁入包内（2026-09-21，`8788be029`）

T10 的第五片，收掉最后一批「实现已在包内、用例仍在宿主」的用例：`agent-form-dialog-*`（5 份）与
`agent-resource-picker-interaction.test.tsx`、`agent-node-selector.test.ts`、`agent-utils.test.ts`。它们的
被测实现全是 `@fenix/agent-config/web/pages/agent-panel/agent-editor/**` 与 `web/lib/{agent-node,agent-utils}`，
此前只能从宿主以 `../../../../packages/resources/agent-config/web/...` **四级相对路径反向读取包内实现**——
这本身就是跨边界依赖（`§2.3` 的「跨包相对说明符把别包内部结构变成事实契约」），迁入后同一跳改为 `../`，
共改写 11 处。`agent-node-selector` 与 `agent-utils` 的导入已是包名自引用，零文本改动。

`agent-form-dialog-pure-logic.test.ts` **不在本片**：它同时导入宿主 `../api/fs`、`../lib/{api-result,form-utils}`，
而这三者是 T8d 判定为「宿主专有」的模块（无包侧 owner）。归位的前提是先有 owner，属 T11 的收口范围；
强行搬进包内会把宿主实现变成包的事实依赖。

`agent-resource-picker-interaction.test.tsx` 直接 `import { Window } from "happy-dom"`，本包未声明该 devDependency
（与 `resources/skill` 同形：都只经由 `@fenix/ui-components/testing` 的入口取用），实测在 workspace 根解析下
正常，故本片不为它单独改 `package.json` 与锁文件。

**台账与搬迁同批**：8 项从 `RMD_08_MOVES` 移出（`toHaveLength(80)` → 72），追加进 `RMD_08_RELOCATED`
（`toHaveLength(69)` → 77），文件头追加第 11 条改判。

**验证**：`bun test packages/resources/agent-config/` 741 pass 0 fail（该包用例文件 5 → 13）；
`bun test scripts/__tests__/rmd-08-migration.test.ts` 7 pass。宿主 `apps/web/src/__tests__/` 38 → 30 个用例文件。
完整门禁 `env -u ANTHROPIC_MODEL bun run precheck` 全绿（773 / 7975 + 2 skip / 294，0 fail，lint 零 warning），
`bun run build:web` 与 `bun run docs:build` 均成功。

### 7.24 T10b5 自指用例退役：`new-session-dialog-form.test.ts` 直删（2026-09-21，）

宿主测试盘点时发现的一处**不守护任何实现**的用例，按 §7.17 的先例退役。该文件 38 行，5 条断言的全部内容
是：在文件内定义 `const newSessionSchema = z.object({ title: z.string(), envId: z.string() })`，随后断言
它的 `safeParse` 对 `""` 成功、对 `null` 失败、对 `"   "` 成功。

**判据（三条都要成立才算自指）**：① 被守护对象是文件内字面量，不是任何导入的生产模块；② 全仓没有任何生产
模块导出 `newSessionSchema`（逐标识符 grep）；③ 其命名的实现 `NewSessionDialog` 在全仓已不存在（`grep -rl`
零命中，会话创建表单的能力已并入 `@fenix/ui-components` 的 chat shell）。三条成立的后果是：这 5 条断言只
在测 zod 自身的语义，任何产品改动都不会让它失败，也不会被它拦住。

**没有覆盖损失**：删除前后宿主侧无对位用例被削弱——它从未守护过宿主模块；包内 chat shell 的会话创建路径由
`packages/ui-components/web/__tests__/chat-shell-wiring.test.tsx` 等用例覆盖。

**台账与删除同批**：从 `RMD_08_MOVES` 移出（`toHaveLength(72)` → 71），并另立专项断言
（`keeps the self-referential session form schema test deleted`：旧根路径与应用壳路径都不得复活），文件头
追加第 12 条改判——「删除」必须与「防复活断言」成对出现，否则等于留了一个可以被静默还原的空位。

**验证**：`bun test scripts/__tests__/rmd-08-migration.test.ts` 8 pass（新增的防复活断言计入）；宿主
`apps/web/src/__tests__/` 30 → 29 个用例文件。完整门禁 `env -u ANTHROPIC_MODEL bun run precheck` 全绿
（774 / 7975 + 2 skip / 289，0 fail，lint 零 warning），`bun run build:web` 与 `bun run docs:build` 均成功。
脚本测试计数 773 → 774 即本次新增的那条专项断言。

### 7.25 T11a 契约定稿：浏览器侧 web contribution 载荷（2026-09-21，）

T11 的第一片，只定契约不接实现：`@fenix/web-runtime` 新增出口 `./shell/contribution`
（`web/shell/contribution.ts`），导出 `WebNavigationItem` 与 `WebAppContribution`。契约形状此前被
两处文档明确留白——`task-1.3` 评审写了「`manifest.web` 字段不在本任务声明：其形状必须与 §1.6 WebShell
的消费方式同时设计」，`platform-sdk` 的 `WebContribution<TValue>` 也只钉了 `{ id, contribution }`
外壳、`TValue` 留空。本片把 `TValue` 填上。

**三条用户裁定（2026-09-21）**：

| 议题 | 裁定 | 后果 |
| --- | --- | --- |
| 导航项图标如何表达 | **载荷含 `LucideIcon` 组件**（非图标名、非宿主决定） | 项形状与现有 `NavEntry` 逐字一致（`id`/`labelKey`/`icon`/`order`），14 项搬迁零改写；载荷**不进** `fenix.module.ts`，故 server 装配图不受影响 |
| 分组（core / config）与组顺序归谁 | **Shell 声明** | 包只声明 `groupId` 与组内 `order`；全局布局属应用壳，符合 standards §4.1「资源页不能反向决定全局布局」 |
| 导航文案归属 | **随项迁入各包字典** | 项携带 `{ ns, labelKey }`，Shell 用 `t(labelKey, { ns })` 取译文；宿主 `agentPanel` 字典里的导航键随项下沉，顺带消解已登记的「包页面跨包消费宿主命名空间」债务中的导航部分 |

**为什么契约落 `@fenix/web-runtime`**：与 §1.6 T7 的 org/session 契约同一判据——它是浏览器运行时
基础设施包，宿主与全部资源包的 web 面都已依赖它，且它自己不依赖任何 `@fenix/*` 业务包；契约放进某个
资源包会让其余包反向依赖那个包。代价是本包新增一条 `lucide-react` 声明（其余包与宿主都已在用同一个
库，`standards:56` 把它列为可安全打进浏览器 bundle 的普通依赖）。

**为什么不复用 `platform-sdk` 的 `WebContribution`**：那一层是**服务端装配**契约
（`profile.web` 选择列表 → registry 解析 → `bootstrap.webContributions`），其值会沿 registry 进入
server 编译图；本载荷携带 React 组件，写进 manifest 就等于把浏览器依赖拖进服务端装配图——正是
`assertWebShellIsPureMetadata` 与 `.dependency-cruiser.cjs` 两侧都在防的事。两者是同一概念的两侧：
server 侧选择「哪些 web 模块参与装配」，浏览器侧承载「装配什么」。

**载荷只含导航**：standards §4.1 列了四类语义范畴（导航、权限提示、页面元数据、路由目标声明），
本片只落导航。路由目标已由导航项的 `id` 表达（Shell 组装 `/agent/<id>`），页面本体走 TanStack 文件
路由（standards:274「不要尝试运行时注入路由」），权限提示与页面元数据没有第二个真实消费方——按
「抽象延迟到第二个真实用例出现」的原则留白，而不是先把四个槽位一次铺满。

**「导航的两条来源」不是冲突**：`standards:343` 写「运行时变化的品牌、导航和功能开关从受控的
`/web` 配置接口读取」，与「导航由静态 contribution 收集」并存。现状本就如此且语义自洽：静态 contribution
是**全集**，`sidebarConfigApi.get()` 的 `hiddenTabs` 只做**运行时裁剪**（`filterNavGroups`），两者不重叠。

**文档冲突登记（T12 修订）**：standards §4.1 的目录树写 `packages/resources/<module>/web/contribution.ts`，
执行计划 T11 行写 `web-contribution.ts` —— 采用 standards 的 `web/contribution.ts`（在 `web/` 目录内，
浏览器面归属自然）；standards §9 归属表把「导航」同时归给「apps/web 壳」与「资源模块静态 contribution」，
按本次三条件裁定补一句分工说明。

**验证**：`bunx tsc -p packages/web-runtime/tsconfig.json` 0 error；`bun install` 锁文件 +1 行；
完整门禁 `env -u ANTHROPIC_MODEL bun run precheck` 全绿（774 / 7975 + 2 skip / 289，0 fail，lint 零
warning），`bun run build:web` 成功。

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
| 5 | 引用被截断时的徽标在中文界面显示英文（`23 chars omitted`）；更早的宿主实现在此位置直接显示原始 key `composerAssets.quoteTruncatedBadge` | `quoteTruncatedBadge` 的 zh 值照抄 en；键集 / 占位符两条守护都挡不住这类漏译 | T9b |
| 6 | 会话面板错误卡片的标题对英文用户显示中文 `执行出错` | T6d 拆 `ChatPanel.tsx` 时硬编码带入 | T9b |
| 7 | 回忆库（hindsight）文档视图的分页按钮在中文界面显示英文 `Previous` / `Next` | memory 包以限定字面量引用宿主 `common:previous` / `common:next`（且已登记为跨命名空间依赖），宿主 `common` 字典却缺这两条，一直靠 `defaultValue` 兜底 | T9c |
| 8 | 错误卡片正文（聊天 turn 失败、会话面板错误）在中文界面显示英文摘要 | `PublicError.message` 是 wire 与日志字段，`createPublicError` / `isPublicError` 把它钉在 `.en` 上，两处卡片却直接渲染它；`PUBLIC_ERROR_MESSAGES` 的 `zh` 一半全仓无读取点 | T9d |

第 3 条的修法是两处共用同一个派发器（`dispatchArtifactsPreviewFile(envId, path)`）；事件名未变，变的
是状态面板那条的详情补齐了 `envId`。第 4 条在线上需服务端返回错误才触发（对抗验证判 real=False）。
第 5、6、8 条属文案语言错误，验收时把界面语言切到英文（第 6 条）或中文（第 5、8 条）各看一处即可。
第 6 条修的是标题、第 8 条修的是正文，两处已在同一张卡片上；第 8 条的正文改由稳定 `error.type` 取译文后，
`error.message` 只作未登记 type 的兜底（取舍见 §7.18）。
第 7 条只影响回忆库文档视图翻页按钮的文案，验收时把界面语言切到中文看该页脚即可。

### 8.2 有意的呈现取舍

| # | 差异 | 理由 | 归属 |
| --- | --- | --- | --- |
| 1 | 工具卡片不再展示脱敏错误的 `Type` / `ID` 两行 | 该块是网格第二列，与标题下方第二行的错误信息重复（`narrate` 的 `errorDetail` 优先取 `publicError.message`），只保留后者的信息量 | T3 `b858bf68f` |
| 2 | 工具卡片运行中标题改为 Shimmer 动效、完成态状态词移除 | 复用包内 `chat/primitives/shimmer`（与推理「思考中」同源），状态词与左侧图标重复 | T3 `b858bf68f` |
| 3 | `TodoChanges` 每条待办右侧的变更标签（带底色 badge）移除 | 变更语义已由左侧图标与文案样式表达；随之删除两个语言包里仅此处使用的 `chat.components.todoChanges.*` | 前置 `e8c73280a` |
| 4 | 用户消息图片缩略图 80px 居中 → 96px（`size-24`）右对齐（`ml-auto`） | 复用包内 `primitives/message-attachments`，与附件条的尺寸/对齐统一 | T3 `b858bf68f` |
| 5 | 附件上传失败提示为通用文案，原文只进控制台 | 包内无法翻译宿主上传回调抛出的业务错误；属包校验的错误（`chatComposer.*` key）仍按原文翻译 | 前置 `e8c73280a` |
| 6 | 空状态建议提示词与消息「引用」的投递范围为**本实例**（源实现走全局 window 事件，靠 `contextScope` 过滤跨实例串扰） | 合并订阅按 `ChatInterface` 实例分发，订阅者集合属于该实例，跨实例串扰在结构上不可能（§7.6 取舍 2）；宿主注入的外部来源（文件树引用）仍由宿主做环境归属过滤 | T5c1 `403af2969` |
| 7 | 业务页标题区与页面容器的色值由硬编码改为主题 token：`#e4eaf2` → `border`、`#17233a` → `text-bright`、`#94a3b8` → `text-muted`、`#f5f7fb` → `surface-0`（`surface-0` 亮色值为 `#f8fafc`，有极轻微色差） | `layout/AppHeader` 与 `layout/AppPage` 归 `@fenix/ui-components`（§7.13 T8c），包内组件不应写死宿主页面色值；改用 token 后随主题切换，暗色下不再破色。信息层级与间距完全不变 | T8c |

第 6 条在线上无可观测差异（验证判 real=False）：源实现的 `contextScope` 过滤已把多实例串扰挡住，包内
实现是把「靠过滤补救」换成「靠作用域不成立」。第 7 条须与旧版截图比对一次，消费方为
`AgentDashboardPage`、`AgentManagementPage` 与 `routes/agent/_panel/workflow.tsx` 三个页面。

### 8.3 发布验收建议

按 8.1 的 8 条做定向回归（建站卡片可见并可跳转、工作流上下文注入、状态面板文件点击、会话重命名失败
提示、引用截断徽标的中文文案、错误卡片标题的英文文案、回忆库文档视图分页按钮的中文文案、错误卡片正文
的中文文案），8.2 的 7 条按「与旧版截图比对」验一次即可；
`chat-channel/web` 尚未删除，旧实现可随时对比（T5d 删除后仅存 git 历史）。
