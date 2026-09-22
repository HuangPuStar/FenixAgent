# @fenix/resource-prod-view

把「Agent 配置 + 一组 Chat 模块开关」组装成可对外分享的只读发布视图，并承载视图加载链路。

## 定位与 owner

本包是「发布视图」这一能力的唯一 owner：领域规则、持久化、HTTP 交付物、浏览器面与文案都在包内，宿主只做装配与注入。分层上属 `resources` 类别的 **L1（叶子）**：`fenix.module.ts` 的 `dependsOn: []`，实测依据是服务端生产代码对**已注册资源模块**没有任何值导入。唯一需要参与装配依赖判定的跨包值导入是 `src/server/services/prod-view.ts` 的 `@fenix/agent-runtime/runtime`（属固定启用的基础模块，该跨类别边由 `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §2.3 依赖矩阵约束）；另有 3 处 `@fenix/platform-sdk` 值导入（`src/server/db.ts` 的 `getDatabase`、`src/server/routes/web/prod-views.ts` 与 `.../config/prod-views.ts` 的 `WebErrSchema`）——platform-sdk 是契约包、没有模块 ID 可声明，不进入 `dependsOn`（实测命令见「边界残留」末条）。

判定方式以静态条件为准（可 grep，不依赖「测试全绿」），八条条件的逐条断言落在 `src/__tests__/prod-view-package-contract.test.ts`；浏览器面的可达性单独由 `web/__tests__/prod-view-browser-surface.test.ts` 守护（该守卫递归进入跨包 exports，故其结论覆盖 agent-config 的 `web/index.ts` 全量索引能到达的那一层，详见测试文件头）。包内自测命令：`bun test packages/resources/prod-view`（2026-09-22 从仓库根实测 116 pass / 0 fail / 10 文件；此前的红见「已知项」）。

三个页面的加载状态分支（加载中 / 加载失败 / 无权限 / 空态 / 重试）由 `web/__tests__/prod-view-list-states.test.tsx` 用 happy-dom + `react-dom/client` 真实渲染断言：`error` 必须是持久分支并带 `role="alert"`，401/403 走独立的无权限分支且不给重试按钮，重试按钮要真的重新发起请求。为什么不能只读源码：`error` 被解构却在 UI 上不可见（本次缺口）在源码里看不出区别，只有运行时分支顺序能证伪。

## 服务端交付物

- 路由（工厂形态，均挂在宿主的 `/web` 前缀下，包内路径保持相对形式）：`src/server/routes/web/prod-views.ts` 的 `createWebProdViewsRoutes`（`/prod-views/:id/load` 分享页加载面，要求同组织会话且视图 `enabled=true`）与 `src/server/routes/web/config/prod-views.ts` 的 `createWebConfigProdViewsRoutes`（`/config/prod-views` 的 CRUD 管理面）。守卫由宿主注入——Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，注入契约写在 `src/server/routes/dependencies.ts`。
- 领域与数据：`src/server/services/prod-view.ts` 六个用例（create / get / list / update / delete / load）；`src/server/repositories/prod-view.ts` 是 `prod_view` 表的唯一数据访问点，每条查询都带组织谓词，服务层只从认证上下文取 `organizationId` / `userId`（写入 `createdBy`、圈定实例归属）。表对象自 §1.7 B11 起由本包 `db/schema.ts` 持有，仓储经出口 `@fenix/resource-prod-view/db` 取用（**自我引用**而非相对路径：`db/` 不在本包 `tsconfig.json` 的 `include` 里，走出口与外部消费方同一条解析路径）。DB 句柄经 `src/server/db.ts` 的 `getProdViewDatabase()` 在请求时取用（模块图可能在宿主初始化基础设施之前求值）。
- 组合根：`src/module.ts` 的 `createProdViewModule()` 返回包内既有单例（进程级单例语义），`fenix.module.ts` 的 `create` 惰性指向它。
- 出口：`./server` → `src/server.ts`（repositories、schemas、services、两个路由工厂与依赖类型）；`./db` → `db/schema.ts`（`prod_view` 表定义与 `ProdViewRow` / `ProdViewInsert` 行类型，§1.7 B11 起）；`./module` → `fenix.module.ts`；`./web` 与 `./web/i18n` 见下节。根出口 `src/index.ts` 刻意为空（`export {}`），避免把浏览器代码或宿主实现拖进服务端图。
- 视图加载链路：`loadProdView` 经 `createWebEnvironment` 建视图专用 environment，再以 `findOrCreateDefaultInstance(envId, userId)` 解析该用户的持久实例，返回 `agentConfigId / environmentId / instanceUid / name / modulesConfig`；只解析实例身份、不预启动 runtime。这两项外部能力以 `ProdViewServiceDeps` 端口注入，包内用例据此覆盖成功路径而无需真实数据库。

## web 面与 i18n

- 浏览器出口是 `web/index.ts`（`exports["./web"]` 指向它），导出 `prodViewApi` 与其类型、`ProdViewsPanel`、`AgentProdViewsPage`、`ProdViewPage`，以及 i18n 的 `PROD_VIEWS_NS` / `prodViewsResources`。包内实现细节（`web/lib/prod-view-modules` 的辅助函数等）不转出，避免形成无人消费的公共面；消费方一律走这个根入口，不深入 `web/**` 子路径。
- 宿主别名已清零：`grep -rn 'from "@/' packages/resources/prod-view/web` 无命中。跨包能力改走 `@fenix/ui-components/<子路径>`（UI）、`@fenix/web-runtime/<子路径>`（请求封装、i18n 命名空间、类型）、`@fenix/agent-config/web`（agent 名称），全部经对方 `package.json` 的 `exports` 声明，不写文件级深路径。
- 聊天容器由宿主注入（CE 阶段 2 任务 1.6 T5b）：`ProdViewPage` 不再 lazy import `@fenix/chat-channel/web/chat-area`，改为接收 `chatArea` prop（类型 `ProdViewChatAreaProps`），由宿主路由 `apps/web/src/routes/view/$prodViewId.tsx` 注入 `apps/web` 的 `ChatArea`。理由：聊天容器持宿主路由态、keep-alive 槽位与页面壳层样式，按 §2.3「Shell 属于 app，不属于资源包」归宿主；分享页只解析「哪个 Environment 的哪个实例」。连带效果：本包已从 `dependencies` 移除 `@fenix/chat-channel`。
- 文案归属：本包域内键（含从宿主 `components` 命名空间迁入的 `panel.*` 28 个键）落在 `web/i18n/locales/{en,zh}/prodViews.json`，由 `web/i18n/index.ts` 聚合、`web/i18n/namespace.ts` 声明命名空间，`package.json` 的 `exports["./web/i18n"]` 指向 `web/i18n/index.ts`——布局与黄金样本 sandbox 一致（计划 §4 的目标态）。键一致性（en/zh 同集合、插值占位符成对、源码字面量键可查、28 个 `panel.*` 齐备）由 `web/__tests__/prod-view-i18n.test.ts` 守护。宿主侧注册需同批切到 `@fenix/resource-prod-view/web/i18n` 子路径（深相对路径的旧 JSON 位置已不存在），宿主侧同名键的删除见「边界残留」的 W3 patch 清单。

## 边界残留

以下残留都是**已登记、有 owner、可在条件满足时删除**的，不是设计意图：

- **宿主内部导入已归零（§1.7 B11）**：`prod_view` 的表定义与 `ProdViewRow` / `ProdViewInsert` 行类型已迁入本包 `db/schema.ts`（出口 `./db`），原来的 2 处 `@server/db/schema` 导入（`src/server/repositories/prod-view.ts` 与测试夹具 `src/__tests__/prod-view-db-stub.ts`）同批改指本包出口；`apps/server/src/db/schema.ts` 里该表随之删除。复核命令：`command grep -rn --include="*.ts" --include="*.tsx" -E 'from "@server/' src web db` → **0 处**。契约测试（条件 1）与台账（`apps-boundary @fenix/resource-prod-view`）同批由「白名单放行一条残留」改为「零例外 / 条目删除」。`package.json` 因此新增 `@fenix/agent-config`（`workspace:*`）——表定义里 `agent_id` 的外键列对象来自 `@fenix/agent-config/db`，属迁移链层面的列对象来源，**不进** `dependsOn`（装配校验只扫 `src/**`；同口径见 agent-config / knowledge / memory 的 manifest 注释）。
- 宿主 `apps/web` 侧：**route adapter 已随 §1.6 T11e 直连包入口**——`apps/web/src/routes/view/$prodViewId.tsx`、`apps/web/src/routes/agent/_panel/views.tsx` 改从 `@fenix/resource-prod-view/web` 取 `ProdViewPage` / `AgentProdViewsPage`，不再经 `@/src/pages/prod-view/*`、`@/src/pages/agent-panel/pages/AgentProdViewsPage` 别名穿透本包 `web/**`；宿主 Shell 的 `ArtifactsPanel.tsx` 已随 §1.6 T11e-4a 改从 `@fenix/resource-prod-view/web` 取 `ProdViewsPanel` 与 `ProdViewModulesConfig`（`ChatArea` 经 `ArtifactsPanel` 间接消费，全仓已无第二处引用本包），`@/src/api/prod-views`、`@/src/pages/agent-panel/ProdViewsPanel` 两条 alias 随之无消费方，并随 T11e-4b 移除（2026-09-21 实测 0 命中）。服务端一侧已按工厂接线（2026-09-20 实测）：`apps/server/src/routes/web/index.ts:16` 导入并在 `:59` 构造 `createWebProdViewsRoutes({ authGuardPlugin })`、`:87` `.use(...)`；`apps/server/src/routes/web/config/index.ts:4` 导入并在 `:24` 构造 `createWebConfigProdViewsRoutes({ authGuardPlugin })`、`:33` `.use(...)`。
- 文案双写窗口：宿主 `apps/web/src/i18n/locales/{en,zh}/components.json` 的 `panelMode.views*` 键组在本包迁出后应只做删除（保留被 `TopModeTabs.tsx` 消费的 `panelMode.views` 本身）；实测宿主已无任何代码消费其余 `views*` 键。
- 浏览器面跨包耦合：`@fenix/agent-config/web` 的 `./web` 指向该包 `web/index.ts` 全量索引（其文件头自述「导出面覆盖当前跨包消费方」）。**无待迁移债务**：`web/__tests__/prod-view-browser-surface.test.ts` 曾用 `PENDING_MIGRATION_DIRS` 登记「跨包文件仍写宿主别名」的包（原三条：chat-channel、agent-config、identity/web），T4a 清零 identity 的别名、T5b 又随 ChatArea 迁往宿主而让 chat-channel 整个离开本包的值导入图，全图实测 0 处宿主别名，该登记表已删除，断言改为「本包与跨包文件一律零宿主别名」。

**待落盘的宿主 patch 清单（W3，编排者独占的共享文件）**：

1. `apps/web/src/i18n/index.ts:21-22` —— 删除两行深相对路径导入（旧 JSON 位置已不存在），改为 `import { PROD_VIEWS_NS, prodViewsResources } from "@fenix/resource-prod-view/web/i18n";`（形状照抄同文件 `:3` 的 sandbox 子路径导入），并把 `:119` / `:147` 的 `[NS.PROD_VIEWS]: prodViewsEN/ZH` 换成 `prodViewsResources.en/zh`。ns 名 `prodViews`、导出名 `prodViewsResources`、JSON 新路径 `web/i18n/locales/{en,zh}/prodViews.json`。
2. `apps/web/src/i18n/locales/{en,zh}/components.json`（两份文件的 `:66-98`，即 `panelMode.views*` 除首键外的整段）—— 删除 `viewsEmpty`、`viewsEmptyHint`、`viewsManage`、`viewsLoadFailed`、`viewsToggleFailed`、`viewsListTitle`、`viewsCopyLink`、`viewsEdit`、`viewsDelete`、`viewsLinkCopied`、`viewsCopyFailed`、`viewsCreate`、`viewsCreateTitle`、`viewsEditTitle`、`viewsDeleteTitle`、`viewsDeleteConfirm`、`viewsNameLabel`、`viewsNamePlaceholder`、`viewsDescLabel`、`viewsDescPlaceholder`、`viewsModulesLabel`、`viewsLinkLabel`、`viewsCreateSuccess`、`viewsUpdateSuccess`、`viewsDeleteSuccess`、`viewsSave`、`viewsCancel`、`viewsOpenView`、`viewsSuggestedNames`、`viewsChatModules`、`viewsPanelModules`、`viewsEnabled`、`viewsDisabled`（保留 `panelMode.views`）；本包 `panel.*` 已覆盖其语义。
3. `scripts/architecture/exceptions.json` —— prod-view 的 `apps-boundary` 条目**已随 §1.7 B11 删除**（迁出前 owner 1.7、rationale「实测 2 处导入 / 2 个文件，全部为 `@server/db/schema` 表定义导入」）；台账至此共 18 条（`apps-boundary` 3 + `no-circular` 10 + `undeclared-workspace-dependency` 5）。`web-package-not-to-app @fenix/resource-prod-view @fenix/web-app` 这条 stale 条目更早已不在台账中。
4. 台账引用的实测命令（便于复核断言强度）：`grep -rn 'from "@fenix/' packages/resources/prod-view/src --include='*.ts' | grep -v 'import type'` → 4 条生产值导入（1 条 `@fenix/agent-runtime/runtime` + 3 条 `@fenix/platform-sdk`），另有 1 条自身的 `@fenix/resource-prod-view/db`（B11 起），其余为测试内的 `@fenix/platform-sdk/testing`。

## 已知项

- **`AgentCardList` 内部列表缺 `key`（非本包缺陷）**：`packages/ui-components/web/components/AgentCardList.tsx` 的 `filtered.map(...)` 未传 `key`，渲染有数据的列表时 React 会打印 "Each child in a list should have a unique \"key\" prop"（`web/__tests__/prod-view-list-states.test.tsx` 与真实页面都会触发）。影响范围：仅控制台告警，不影响渲染结果与本次状态分支结论；修复位置在 ui-components（超出本包写入范围，见任务 1.3 的包侧约束），移除条件是该组件补 `key={cardKey(item)}` 后删除本条。
- **仓库根跑包内测试曾因外部原因变红（已消解）**：W2 期间 `env -u ANTHROPIC_MODEL bun test packages/resources/prod-view` 从仓库根是 0 pass / 8 fail，报错为 machine 的陈旧入口（`Cannot find module './routes/api/workspaces' from packages/resources/machine/src/server.ts`）；2026-09-20 复核时 machine 的 `src/server.ts` 已改指 `./server/routes/**`，该命令回到 104 pass / 0 fail。当时包目录内运行残留的 2 fail / 2 error 同样经 `agent-runtime → sandbox → machine` 传导，一并消失。
- **详情路由的 404 声明未落实（迁移前既有缺陷）**：`GET /config/prod-views/:id` 声明了 `404: WebErrSchema`，处理器却把失败信封以默认 200 状态返回，撞上 `OkResponseSchema` 后被 Elysia 的响应校验拒绝成 **422**，客户端拿到的是校验错误体而不是 `{ success: false, error }`。HEAD 版本（`git show HEAD:packages/resources/prod-view/src/server/routes/web/config/prod-views.ts`）同样如此，本次迁移按原样保留，用例 `prod-view-routes.test.ts` 钉住现状以免无声漂移；修复属对外协议行为变更，需与前端错误处理同批评估。
- **真实守卫无覆盖**：宿主 `apps/server/src/__tests__/` 与 `apps/web/src/__tests__/` 中 `grep -rln "prod-view\|prodView"` 无命中，因此「无会话时被拒绝」「组织上下文由守卫解析」这两条合同当前没有用例覆盖。包内 `src/__tests__/guard-stubs.ts` 只能注入替身（注入真实守卫等于依赖宿主实现），替身放行是刻意的；缺口归任务 1.3 §1.5 的宿主协议聚合。
- **无 `./server/testing` 子路径（刻意）**：本包不读模块配置、也没有需要宿主复用的夹具，唯一的测试缝 `setProdViewDeps` 只服务包内用例（用例在 `afterEach` 复位）。等宿主用例确需包内基建时再按平台契约补该子路径，避免现在造一个无人消费的出口。
- **`ProdViewPage` 不带 `auth` prop**：分支版本为该页面新增了 `useSession` 与 `auth` 传参，属跨包（chat-channel 会话授权）契约的调整，不在本波范围，故只重放其新增内容中的本包能力；分享页的会话授权形态需与 chat-channel 一起定型。
- **`manifest.web` / `contributions` 未声明**：两者的消费方分别是 §1.6 的 WebShell 装配与 §1.5 的宿主挂载，形状必须与消费端同时定型，单方面发明会返工。
