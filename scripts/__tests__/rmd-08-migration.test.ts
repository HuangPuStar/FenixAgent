import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";

/**
 * RMD-08 开始时从 root-source-owner audit 导出的精确迁移清单。
 *
 * 第二列是该文件**当前**唯一的 owner 落点。RMD-08 之后有五项改判：
 * 1. `password-crypto.ts` 属于身份密码职责，CE 阶段 2 任务 1.2 把它随 `auth-client.ts` 一并迁入
 *    `packages/platform/identity/web/lib/`，不再是 apps/web 的壳文件。
 * 2. `system-sandbox.test.ts` 验证的是沙盒资源自身的请求构造约定，CE 阶段 2 任务 1.3 把 owner 从应用壳
 *    交给 `packages/resources/sandbox`，宿主侧删除（见下方 relocated 断言）。
 * 3. `admin-key.ts` 是跨资源复用的浏览器端密钥投影，CE 阶段 2 任务 1.3 把它从应用壳上收到
 *    `packages/web-runtime/web/lib/admin-key.ts`，宿主侧删除（见下方 relocated 断言）。
 * 4. 任务 1.3 收口的 9 份「宿主副本」不再由 apps/web 持有：字典、共享类型、hook、面板与一份表单校验测试的
 *    owner 落在资源包 / web-runtime，宿主副本删除（见 `RMD_08_RELOCATED` 与下方 relocated 断言）。
 * 5. 任务 1.6 T2 删掉 18 个零消费宿主文件（171 → 153）：它们的 owner 落点**从未**被任何代码引用，
 *    是 RMD-08 的搬运残留再加之后续拆分留下的孤儿。删除依据是三重交叉验证：
 *    逐标识符全仓 grep + 传递可达性（测试算根与不算根两轮）+ 现有 dist sourcemap，三者结论一致。
 * 6. 任务 1.6 T4 再移出一项：`web/src/api/registry.ts` 的壳副本在 T4 之前一直由 identity 的组织机器页
 *    经 `@/src/api/registry` 别名消费，T4 把该页的机器注册表能力改成宿主注入的 `MachineRegistryPort`
 *    后，壳副本零消费，且与 `packages/resources/machine/web/api/registry.ts` 除 import 说明符外逐字相同，
 *    于是删除、owner 归 machine 包（见下方 relocated 断言）。
 * 7. 任务 1.6 T9c 直删 9 项（109 → 100）：`TASKS` / `SESSIONS` / `ENVIRONMENTS` / `TOOL_NARRATOR` 四个
 *    宿主命名空间的 8 份字典在全仓没有任何 `useTranslation` 绑定（历史迁出后留下的空壳，真实消费方各在
 *    资源包内），连同守护 `toolNarrator` 字典的**自指测试** `narrators-i18n.test.ts`（它只读该字典并断言
 *    同一文件里的键）一并删除。
 * 8. 任务 1.6 T10b1 把 12 个 ui-components 归属的宿主测试移入包内（100 → 88）：这些用例的被测实现
 *    在 T8b/T8c 已整体退场到 `@fenix/ui-components`，导入图里除标准库外只指向该包出口，留在宿主等于让
 *    「包内实现」被「应用壳测试」守护；搬运后宿主不再是它们的 owner（见下方 relocated 断言）。
 * 9. 任务 1.6 T10b2 把 7 个 web-runtime 归属的宿主测试移入包内（88 → 82）：判定口径同第 8 条，只是 owner
 *    换成 `@fenix/web-runtime`；其中 `request.test.ts` 不在 RMD-08 快照内（它守护的是 T8d 才上收到包里的
 *    `api/request`），一并归位并补进 relocated 断言，避免宿主侧复活。
 * 10. 任务 1.6 T10b3 收尾 ui-components 归属（82 → 80）：同上口径，另含两处变形——`tree-component.test.tsx`
 *     去掉宿主副本时代遗留的 `@/src/i18n` 替身（`ui/tree` 只依赖包内 `i18n/namespace`）；
 *     `context-queue.test.ts` 按 owner 拆开，队列一半随宿主副本删除（与包内用例逐字重复）。
 * 11. 任务 1.6 T10b4 把 8 个 agent-config 归属的宿主测试移入包内（80 → 72）：这 8 份此前以
 *     `../../../../packages/resources/agent-config/web/...` 反向读取包内实现，既是跨边界依赖也说明 owner
 *     已明确；`agent-form-dialog-pure-logic.test.ts` 因同时导入宿主 `../api/fs`、`../lib/{api-result,form-utils}`
 *     而不在本片；T11 定点归属后由 T12 按 owner 拆开搬迁（见第 16 条）。
 * 12. 任务 1.6 T10b5 直删 1 项自指用例（72 → 71）：`new-session-dialog-form.test.ts` 在文件内定义
 *     `newSessionSchema` 再断言它自身的 `safeParse`，全仓无任何生产模块导出该 schema（`NewSessionDialog`
 *     已不存在），五条断言只在测 zod；与文件头第 7 条的自指 i18n 测试同一口径，另立专项断言防复活。
 * 13. 任务 1.6 T11d 在 apps/web 内再搬 6 项（71 → 71，仅改第二列的落点）：壳层容器与两份 CSS 从
 *     `apps/web/src/pages/agent-panel/` 移入 `apps/web/src/shell/`，其中 `AgentPanelLayout.tsx` 改名
 *     `DefaultAppShell.tsx` 与 `apps/web/fenix.module.ts` 的 `kind: "web-shell"` 对齐。owner 仍是 apps-web
 *     （RMD-08 判定的资源归属未变），但落点已不是 `pages/`，故按本表的「当前唯一落点」语义更新第二列。
 *     同片的 T11d 收尾直删 1 项（71 → 70）：`AgentSidebarConfig.tsx` 是宿主侧那份 14 项导航表，侧栏的
 *     真相源改由各包 `web/contribution.ts` + WebShell 分组表装配后它零消费，属「删除优于兼容」的直删，
 *     另立专项断言防三处路径复活。
 * 14. 任务 1.6 T11e 把宿主剩余的三个 agent-panel 页面归位到 `@fenix/agent-config`（MOVES 70 → 66，
 *     RELOCATED 77 → 81）：它们的值依赖全部落在该包（`agentApi` / `envApi` / `modelApi` /
 *     `AgentFormDialog` / `AgentGenerationForm`），留在宿主只能靠 vite / tsconfig 的 `@/src/pages/...`
 *     桥接别名解析。T11e-3a 搬 `AgentManagementPage.tsx`（MOVES 69 / RELOCATED 78）；T11e-3b 搬
 *     `AgentDashboardPage.tsx` 与其 `dashboard` 字典两份——该页是全片唯一的 `dashboard` 命名空间
 *     消费方，字典随之按「键的最终所在地 = 包的 owner」归位，宿主 `hostResources` 登记与
 *     `./locales/<lang>/dashboard.json` 同时删除。T11e-3c 收口同片最后一批：搬 `AgentHomePage.tsx`、
 *     它与其生成表单共用的 `agentHome` 字典两份、宿主壳与首页共用的 `agent-create-navigation.ts`
 *     （落 `web/lib/`，经窄子路径出口给宿主壳），以及两个随被测实现归位的宿主测试
 *     （`agent-home-generation.test.tsx` / `agent-create-enter-flow.test.ts`）——后者导入宿主
 *     `@/src/api/environments` 只为拿类型，实现与 owner 全在包侧。MOVES 66 → 60 / RELOCATED 81 → 87。
 * 15. 任务 1.6 T12 归位最后一份 agent-config 归属的宿主测试 `agent-form-dialog-ssr.test.tsx`
 *     （MOVES 60 → 59，RELOCATED 87 → 88）：口径同第 8~11 条，被测实现 `AgentFormDialog` 归本包
 *     `web/pages/agent-panel/agent-editor/`，源文件此前以四级相对路径反向读取包内实现、并取宿主
 *     启动期 i18n 单例；迁入后改为自建空字典实例（三条断言全是「渲染为空」，不涉任何文案）。
 * 16. 任务 1.6 T12 按 owner 拆开搬迁最后一份混合归属的宿主测试 `agent-form-dialog-pure-logic.test.ts`
 *     （MOVES 59 → 58，RELOCATED 88 → 89）：它的 30 条用例同时守护宿主与包两侧的实现，第 11 条起
 *     正因此留在宿主。搬迁口径是「按被测实现归谁拆开」而非整份搬家——
 *       - 18 条迁入 `packages/resources/agent-config/web/__tests__/`，逐条带包内既有用例未覆盖的断言；
 *       - 5 条与本包既有用例等价而删除（选项映射见 `agent-form-dialog-{round54-pure,bulk-pure-options,
 *         options-boundaries}`，名称校验见 `agent-utils` / `config-agents-page`）；
 *       - 7 条守护宿主自有的 `api/fs`、`lib/api-result`、`lib/form-utils`，全部与宿主既有 owner 测试
 *         等价（`fs-upload-url` / `form-utils` / `pure-logic-transform-boundaries` / `api-result-utils`）
 *         而随宿主文件一并删除——含原计划准备补进 `api-result-utils.test.ts` 的「空服务端消息兜底」：
 *         实测它已由 `pure-logic-transform-boundaries.test.ts` 的「空字符串错误消息回退通用错误」覆盖，
 *         补进去只会制造第二处重复守护。
 *     迁入后的新文件经包出口消费兄弟包（`@fenix/{model-management,resource-mcp,resource-skill}/web`），
 *     这四个 workspace 依赖本已声明在 `agent-config/package.json` 的 `dependencies`，未新增跨包依赖。
 * 17. 任务 1.6 收口后经用户裁定，宿主 `web/src/lib/api-result.ts`（`ApiResult` 联合 + `ok` / `err` /
 *     `unwrapApiResult`）与其专属测试 `web/src/__tests__/api-result-utils.test.ts` 一并删除：请求错误建模
 *     已由 `@fenix/web-runtime/api/request` 的 `ApiError` / `unwrap` 承担，宿主消费方（如 `api/fs.ts`）
 *     改指该包出口，这两份 RMD-08 快照里的应用壳文件删除后全仓零引用（逐标识符 grep 只剩设计文档、
 *     包内一处历史注释与本表）。它们没有包内 owner 落点（`packages/**` 下不存在同名文件），故不进
 *     `RMD_08_RELOCATED`，而是按「已裁定删除」口径改挂 `RMD_08_TARGETS_LATER_DELETED`：MOVES 表 58 → 56、
 *     在册总数仍为 58，复活由下方 `later-deleted migration targets ... stay absent` 断言拦住——第 16 条里
 *     作为等价对照提到的 `api-result-utils`，即本轮退役的这一份。
 * 18. CE 收官后 `@fenix/ui-components/web/chat/**` 的设计层样式逐片迁成 Tailwind 工具类，15 份样式表删除
 *     （迁移台账见该包 `README.md`）。其中 `primitives/chat-message-content.css` 正是 RMD-08 的 relocated
 *     目标之一：它的元素级与后代排版规则改由 `primitives/internal/markdown-classes.ts` 的容器 arbitrary
 *     variant 承接，文件本身随片删除。于是本表出现唯一一条「host 副本已删、包内 owner 也已被后续迁移删除」
 *     的条目——它不再满足 `RMD_08_RELOCATED` 的「owner 必须存在」，改挂
 *     `RMD_08_RELOCATED_TARGETS_LATER_DELETED`（88 + 1 = 89，在册总数不变，只是断言方向翻转为三条路径
 *     全不得存在）。这两张表的长度之和才是 relocated 的在册数，改表时都要看。
 * 19. 前端重复实现去重（本表第 8 项口径的延续）：`apps/web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx`
 *     与 `@fenix/ui-components/web/components/agent-master-detail-workspace` 同名同 props，且视觉已分叉
 *     （宿主版硬编码 `bg-white` 与十六进制灰，包内版走主题 token），包外零消费者的宿主副本整份删除——它是
 *     「唯一消费者升级为第二个包」之前就该退场的那一类（`frontend-development.md` §1.3 已登记）。条目从
 *     `RMD_08_MOVES` 移入 `RMD_08_RELOCATED`（MOVES 58 → 57，RELOCATED 89 → 90，在册总数不因换表而变），
 *     宿主两条旧路径都不得复活、包侧 owner 必须存在。
 * 20. 漏登记补正（第 19 条之后本侧在册数由 58 降到 57 时的遗漏）：`4ff58f6f` 按本表口径搬到
 *     `apps/web/src/__tests__/utils.test.ts` 的宿主杂项函数自指测试，其被测实现 `apps/web/src/lib/utils.ts`
 *     在 `dd3ad35d`（宿主 lib 三处重复实现退场）整体删除、该测试随之一并删除，但清单没跟着换表——
 *     `RMD_08_MOVES` 里留了一条「源已删、目标也不存在」的记录，让 `removes every legacy source and retains
 *     its exact owner target` 的「目标必须存在」断言恒假。本次按本表语义移入
 *     `RMD_08_TARGETS_LATER_DELETED`：MOVES 55 → 54、豁免表 2 → 3，两侧一增一减，
 *     `MOVES + LATER_DELETED` 之和仍是 57；全表扫描确认这是清单里唯一一条目标缺失的条目，其余 54 条的
 *     源均已删除且目标仍在。
 */
const RMD_08_MOVES = [
  ["web/src/App.tsx", "apps/web/src/App.tsx"],
  [
    "web/src/__tests__/agent-sidebar-instance-order.test.ts",
    "apps/web/src/__tests__/agent-sidebar-instance-order.test.ts",
  ],
  ["web/src/__tests__/api-client.test.ts", "apps/web/src/__tests__/api-client.test.ts"],
  ["web/src/__tests__/auth-preference.test.ts", "apps/web/src/__tests__/auth-preference.test.ts"],
  ["web/src/__tests__/config-routing.test.ts", "apps/web/src/__tests__/config-routing.test.ts"],
  ["web/src/__tests__/dark-mode-components.test.tsx", "apps/web/src/__tests__/dark-mode-components.test.tsx"],
  ["web/src/__tests__/folder-upload-batching.test.ts", "apps/web/src/__tests__/folder-upload-batching.test.ts"],
  ["web/src/__tests__/form-utils.test.ts", "apps/web/src/__tests__/form-utils.test.ts"],
  ["web/src/__tests__/fs-upload-url.test.ts", "apps/web/src/__tests__/fs-upload-url.test.ts"],
  ["web/src/__tests__/instances-api.test.ts", "apps/web/src/__tests__/instances-api.test.ts"],
  ["web/src/__tests__/peri-task-details-api.test.ts", "apps/web/src/__tests__/peri-task-details-api.test.ts"],
  ["web/src/__tests__/preview-utils-normalize.test.ts", "apps/web/src/__tests__/preview-utils-normalize.test.ts"],
  [
    "web/src/__tests__/pure-logic-transform-boundaries.test.ts",
    "apps/web/src/__tests__/pure-logic-transform-boundaries.test.ts",
  ],
  ["web/src/__tests__/random-uuid-polyfill.test.ts", "apps/web/src/__tests__/random-uuid-polyfill.test.ts"],
  ["web/src/__tests__/retry.test.ts", "apps/web/src/__tests__/retry.test.ts"],
  ["web/src/__tests__/use-task-views.test.tsx", "apps/web/src/__tests__/use-task-views.test.tsx"],
  ["web/src/api/fs.ts", "apps/web/src/api/fs.ts"],
  ["web/src/api/instances.ts", "apps/web/src/api/instances.ts"],
  ["web/src/api/peri-task-details.ts", "apps/web/src/api/peri-task-details.ts"],
  ["web/src/components/FilePickerDialog.tsx", "apps/web/src/components/FilePickerDialog.tsx"],
  ["web/src/components/agent-panel/FileTabsBar.tsx", "apps/web/src/components/agent-panel/FileTabsBar.tsx"],
  ["web/src/components/agent-panel/FileTreeTab.tsx", "apps/web/src/components/agent-panel/FileTreeTab.tsx"],
  ["web/src/components/agent-panel/TopModeTabs.tsx", "apps/web/src/components/agent-panel/TopModeTabs.tsx"],
  ["web/src/components/agent-panel/artifacts-dialogs.tsx", "apps/web/src/components/agent-panel/artifacts-dialogs.tsx"],
  [
    "web/src/components/agent-panel/artifacts-files-workspace.tsx",
    "apps/web/src/components/agent-panel/artifacts-files-workspace.tsx",
  ],
  ["web/src/components/agent-panel/preview/utils.ts", "apps/web/src/components/agent-panel/preview/utils.ts"],
  [
    "web/src/components/agent-panel/use-file-tree-events.ts",
    "apps/web/src/components/agent-panel/use-file-tree-events.ts",
  ],
  ["web/src/components/agent-panel/use-file-uploads.ts", "apps/web/src/components/agent-panel/use-file-uploads.ts"],
  ["web/src/hooks/use-task-views.ts", "apps/web/src/hooks/use-task-views.ts"],
  ["web/src/i18n/locales/en/agentPanel.json", "apps/web/src/i18n/locales/en/agentPanel.json"],
  ["web/src/i18n/locales/en/common.json", "apps/web/src/i18n/locales/en/common.json"],
  ["web/src/i18n/locales/en/components.json", "apps/web/src/i18n/locales/en/components.json"],
  ["web/src/i18n/locales/en/login.json", "apps/web/src/i18n/locales/en/login.json"],
  ["web/src/i18n/locales/en/sidebar.json", "apps/web/src/i18n/locales/en/sidebar.json"],
  ["web/src/i18n/locales/zh/agentPanel.json", "apps/web/src/i18n/locales/zh/agentPanel.json"],
  ["web/src/i18n/locales/zh/common.json", "apps/web/src/i18n/locales/zh/common.json"],
  ["web/src/i18n/locales/zh/components.json", "apps/web/src/i18n/locales/zh/components.json"],
  ["web/src/i18n/locales/zh/login.json", "apps/web/src/i18n/locales/zh/login.json"],
  ["web/src/i18n/locales/zh/sidebar.json", "apps/web/src/i18n/locales/zh/sidebar.json"],
  ["web/src/lib/auth-preference.ts", "apps/web/src/lib/auth-preference.ts"],
  ["web/src/lib/form-utils.ts", "apps/web/src/lib/form-utils.ts"],
  ["web/src/lib/password-crypto.ts", "packages/platform/identity/web/lib/password-crypto.ts"],
  ["web/src/lib/retry.ts", "apps/web/src/lib/retry.ts"],
  ["web/src/pages/LoginPage.tsx", "apps/web/src/pages/LoginPage.tsx"],
  ["web/src/pages/agent-panel/AgentPanelLayout.tsx", "apps/web/src/shell/DefaultAppShell.tsx"],
  ["web/src/pages/agent-panel/AgentSidebar.tsx", "apps/web/src/shell/AgentSidebar.tsx"],
  ["web/src/pages/agent-panel/AgentSidebarTree.tsx", "apps/web/src/shell/AgentSidebarTree.tsx"],
  ["web/src/pages/agent-panel/ArtifactsPanel.tsx", "apps/web/src/shell/ArtifactsPanel.tsx"],
  ["web/src/pages/agent-panel/agent-panel.css", "apps/web/src/shell/agent-panel.css"],
  ["web/src/pages/agent-panel/artifacts-workspace.css", "apps/web/src/shell/artifacts-workspace.css"],
  ["web/src/types/global.d.ts", "apps/web/src/types/global.d.ts"],
  ["web/src/types/index.ts", "apps/web/src/types/index.ts"],
  ["web/src/vite-env.d.ts", "apps/web/src/vite-env.d.ts"],
  ["web/tsconfig.json", "apps/web/tsconfig.json"],
] as const;

/**
 * RMD-08 在册后迁移目标又被后续提交删除、且无包内 owner 落点可挂的条目（迁移记录保留在此，只豁免
 * 「目标必须存在」断言，断言方向翻转为源与目标双向缺席）。
 *
 * 前两条同为宿主自有的请求结果工具与其专属测试：`ApiResult` 联合 + `ok` / `err` / `unwrapApiResult` 的失败
 * 语义（把 `ok: false` 转 Error）已由 `@fenix/web-runtime/api/request` 的 `ApiError` / `unwrap` 承担，宿主
 * 消费方早已改指该包出口，删除后全仓零引用（逐标识符 grep 只剩设计文档与包内一处历史注释）。`packages/**`
 * 下不存在同名文件，没有 owner 落点可挂——所以是退役而非 relocated，记录留在此处是为了不让「RMD-08 快照
 * 里本来有这两条」的事实随清单长度流失（同 `rmd-05` 的 `RMD_05_TARGETS_LATER_DELETED` 口径）。
 *
 * 第三条 `utils.test.ts` 是同一类但成因不同的补登记：它随 `4ff58f6f` 与其他 MOVES 条目一同搬到
 * `apps/web/src/__tests__/`，守护的是宿主 `apps/web/src/lib/utils.ts` 里 `cn` / `esc` / `formatTime` /
 * `statusClass` 等杂项函数的宿主副本（全文件只从 `@/src/lib/utils` 取符号，属自指测试）。`dd3ad35d`
 * 按 owner 拆解该聚合模块——`cn` 归 `@fenix/ui-components/lib/cn`，其余函数语义由
 * `@fenix/ui-components/web/chat/*` 与 `@fenix/web-runtime/web/chat/structured-to-thread.ts` 承担——
 * 宿主模块与这份测试一并删除，迁移目标因此不再存在。留在 `RMD_08_MOVES` 会让「目标必须存在」断言恒假
 * （既非迁移丢失，也无包内同名 owner 可挂），故按本表口径收编；它是 MOVES 在册条目里唯一一条「目标已迁到
 * apps/web 又被后续提交删掉」的记录，其余目标均仍在。
 */
const RMD_08_TARGETS_LATER_DELETED = [
  ["web/src/__tests__/api-result-utils.test.ts", "apps/web/src/__tests__/api-result-utils.test.ts"],
  ["web/src/lib/api-result.ts", "apps/web/src/lib/api-result.ts"],
  ["web/src/__tests__/utils.test.ts", "apps/web/src/__tests__/utils.test.ts"],
] as const;

/**
 * 1.3 与 1.6 T4/T8 收口时删掉的宿主副本，三元组为 `[旧根路径, 应用壳路径, 包内 owner 落点]`。
 *
 * 这些文件在 RMD-08 时是「apps/web 的壳」，但键的 owner 与实现的 owner 都属于资源包 / web-runtime：
 * 宿主再留一份就是两份实现并存（i18n 字典尤其危险——命名空间同名时构建期不报错，运行期整片文案回退）。
 * 已退役的面板与 hook 改由下方删除清单断言所有落点不存在；`api/registry.ts` 由 T4 移出（见文件头第 6 条）。
 * 任务 1.6 T8b 再移出 11 项：`components/ai-elements/**`（7，owner 为 `chat/primitives/**`）与
 * `components/config/**`（4）——这 11 个宿主副本的消费方已全部改指 `@fenix/ui-components` 的对应出口，
 * 副本本身零引用。
 * 任务 1.6 T8c 再移出 11 项：`src/components/**` 的 `PreviewTab`、`file-tree-*`、`file-icon-helper`、
 * `layout/**` 与 `preview/**`——消费方已改指 `@fenix/ui-components` 的 `components/**` 与 `layout/**` 出口。
 * 任务 1.6 T8d 再移出 15 项：`src/{api,hooks,lib}` 的 `request`、两个 hooks 与 12 个 `lib` 模块——
 * owner 分属 `@fenix/web-runtime`（api/hooks/lib/chat）、`@fenix/agent-config`（web/lib）与
 * `@fenix/ui-components`（chat/lib、chat/types）。
 * 任务 1.6 T10b1 再移出 12 项：`src/__tests__/**` 的表格、分页、日期选择器、确认弹窗与 config 纯逻辑
 * 用例——被测实现的 owner 已在 T8b/T8c 归 `@fenix/ui-components`，这些用例的导入图里除标准库外只指向
 * 该包出口，于是用例随实现移入包内，宿主侧不再保留第二份。
 * 任务 1.6 T10b2 再移出 7 项：`request` 与两个 `structured-thread-*`、`todo`、`permission-options`、
 * `artifacts-preview-events`、`config-types` 的宿主用例——全部只引用 `@fenix/web-runtime` 出口（其中
 * `request.test.ts` 未被 RMD-08 快照收录，本片一并归位），owner 是该包的 `web/{api,lib,chat,types}`。
 * 任务 1.6 T10b3 再移出 1 项并拆 1 项：`tree-component.test.tsx` 随 `ui/tree` 的实现迁入 ui-components；
 * `context-queue.test.ts` 同时守护队列（web-runtime）与纯函数（ui-components）两个 owner，按 owner 拆开
 * （队列一半与 web-runtime 包内用例逐字重复，随宿主副本一并删除），拆分归属另立专项断言。
 * 任务 1.6 T10b4 再移出 8 项：`agent-form-dialog-*`（5）与 `agent-resource-picker-interaction`、
 * `agent-node-selector`、`agent-utils` 的宿主用例——被测实现是 agent-config 包的
 * `web/pages/agent-panel/agent-editor/**`，此前只能从宿主以四级相对路径反向读取包内实现，迁入后改为一跳。
 */
const RMD_08_RELOCATED = [
  [
    "web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx",
    "apps/web/src/pages/agent-panel/shared/agent-master-detail-workspace.tsx",
    "packages/ui-components/web/components/agent-master-detail-workspace.tsx",
  ],
  [
    "web/src/lib/use-workflow-events.ts",
    "apps/web/src/lib/use-workflow-events.ts",
    "packages/resources/workflow/web/lib/use-workflow-events.ts",
  ],
  ["web/src/types/config.ts", "apps/web/src/types/config.ts", "packages/web-runtime/web/types/config.ts"],
  ["web/src/api/registry.ts", "apps/web/src/api/registry.ts", "packages/resources/machine/web/api/registry.ts"],
  [
    "web/src/i18n/locales/en/agents.json",
    "apps/web/src/i18n/locales/en/agents.json",
    "packages/resources/agent-config/web/i18n/locales/en/agents.json",
  ],
  [
    "web/src/i18n/locales/zh/agents.json",
    "apps/web/src/i18n/locales/zh/agents.json",
    "packages/resources/agent-config/web/i18n/locales/zh/agents.json",
  ],
  [
    "web/src/i18n/locales/en/models.json",
    "apps/web/src/i18n/locales/en/models.json",
    "packages/resources/model-management/web/i18n/locales/en/models.json",
  ],
  [
    "web/src/i18n/locales/zh/models.json",
    "apps/web/src/i18n/locales/zh/models.json",
    "packages/resources/model-management/web/i18n/locales/zh/models.json",
  ],
  [
    "web/src/__tests__/task-form-schema.test.ts",
    "apps/web/src/__tests__/task-form-schema.test.ts",
    "packages/resources/task/web/__tests__/agent-tasks-utils.test.ts",
  ],
  [
    "web/components/ai-elements/conversation.tsx",
    "apps/web/components/ai-elements/conversation.tsx",
    "packages/ui-components/web/chat/primitives/conversation.tsx",
  ],
  [
    "web/components/ai-elements/iframe-preview.tsx",
    "apps/web/components/ai-elements/iframe-preview.tsx",
    "packages/ui-components/web/chat/primitives/iframe-preview.tsx",
  ],
  [
    "web/components/ai-elements/message-attachments.tsx",
    "apps/web/components/ai-elements/message-attachments.tsx",
    "packages/ui-components/web/chat/primitives/message-attachments.tsx",
  ],
  [
    "web/components/ai-elements/message.tsx",
    "apps/web/components/ai-elements/message.tsx",
    "packages/ui-components/web/chat/primitives/message.tsx",
  ],
  [
    "web/components/ai-elements/reasoning.tsx",
    "apps/web/components/ai-elements/reasoning.tsx",
    "packages/ui-components/web/chat/primitives/reasoning.tsx",
  ],
  [
    "web/components/ai-elements/shimmer.tsx",
    "apps/web/components/ai-elements/shimmer.tsx",
    "packages/ui-components/web/chat/primitives/shimmer.tsx",
  ],
  [
    "web/components/config/ConfirmDialog.tsx",
    "apps/web/components/config/ConfirmDialog.tsx",
    "packages/ui-components/web/config/ConfirmDialog.tsx",
  ],
  [
    "web/components/config/DataTable.tsx",
    "apps/web/components/config/DataTable.tsx",
    "packages/ui-components/web/config/DataTable.tsx",
  ],
  [
    "web/components/config/FormDialog.tsx",
    "apps/web/components/config/FormDialog.tsx",
    "packages/ui-components/web/config/FormDialog.tsx",
  ],
  [
    "web/components/config/StatusBadge.tsx",
    "apps/web/components/config/StatusBadge.tsx",
    "packages/ui-components/web/config/StatusBadge.tsx",
  ],
  [
    "web/src/components/agent-panel/PreviewTab.tsx",
    "apps/web/src/components/agent-panel/PreviewTab.tsx",
    "packages/ui-components/web/components/PreviewTab.tsx",
  ],
  [
    "web/src/components/agent-panel/file-tree-input-dialog.tsx",
    "apps/web/src/components/agent-panel/file-tree-input-dialog.tsx",
    "packages/ui-components/web/components/file-tree-input-dialog.tsx",
  ],
  [
    "web/src/components/agent-panel/file-tree-model.ts",
    "apps/web/src/components/agent-panel/file-tree-model.ts",
    "packages/ui-components/web/components/file-tree-model.ts",
  ],
  [
    "web/src/components/agent-panel/file-tree-view.tsx",
    "apps/web/src/components/agent-panel/file-tree-view.tsx",
    "packages/ui-components/web/components/file-tree-view.tsx",
  ],
  [
    "web/src/components/file-icon-helper.tsx",
    "apps/web/src/components/file-icon-helper.tsx",
    "packages/ui-components/web/components/file-icon-helper.tsx",
  ],
  [
    "web/src/components/layout/app-header.tsx",
    "apps/web/src/components/layout/app-header.tsx",
    "packages/ui-components/web/layout/app-header.tsx",
  ],
  [
    "web/src/components/layout/app-page.tsx",
    "apps/web/src/components/layout/app-page.tsx",
    "packages/ui-components/web/layout/app-page.tsx",
  ],
  [
    "web/src/components/agent-panel/preview/FileViewerPreview.tsx",
    "apps/web/src/components/agent-panel/preview/FileViewerPreview.tsx",
    "packages/ui-components/web/components/preview/FileViewerPreview.tsx",
  ],
  [
    "web/src/components/agent-panel/preview/html-plugin.ts",
    "apps/web/src/components/agent-panel/preview/html-plugin.ts",
    "packages/ui-components/web/components/preview/html-plugin.ts",
  ],
  [
    "web/src/components/agent-panel/preview/native-pdf-plugin.ts",
    "apps/web/src/components/agent-panel/preview/native-pdf-plugin.ts",
    "packages/ui-components/web/components/preview/native-pdf-plugin.ts",
  ],
  [
    "web/src/components/agent-panel/preview/overrides.css",
    "apps/web/src/components/agent-panel/preview/overrides.css",
    "packages/ui-components/web/components/preview/overrides.css",
  ],
  ["web/src/api/request.ts", "apps/web/src/api/request.ts", "packages/web-runtime/web/api/request.ts"],
  [
    "web/src/hooks/use-changed-files-stats.ts",
    "apps/web/src/hooks/use-changed-files-stats.ts",
    "packages/web-runtime/web/hooks/use-changed-files-stats.ts",
  ],
  [
    "web/src/hooks/usePageVisible.ts",
    "apps/web/src/hooks/usePageVisible.ts",
    "packages/web-runtime/web/hooks/use-page-visible.ts",
  ],
  [
    "web/src/lib/agent-node.ts",
    "apps/web/src/lib/agent-node.ts",
    "packages/resources/agent-config/web/lib/agent-node.ts",
  ],
  [
    "web/src/lib/agent-resource-access.ts",
    "apps/web/src/lib/agent-resource-access.ts",
    "packages/resources/agent-config/web/lib/agent-resource-access.ts",
  ],
  [
    "web/src/lib/agent-utils.ts",
    "apps/web/src/lib/agent-utils.ts",
    "packages/resources/agent-config/web/lib/agent-utils.ts",
  ],
  [
    "web/src/lib/artifacts-preview-events.ts",
    "apps/web/src/lib/artifacts-preview-events.ts",
    "packages/web-runtime/web/lib/artifacts-preview-events.ts",
  ],
  ["web/src/lib/chat-stats.ts", "apps/web/src/lib/chat-stats.ts", "packages/web-runtime/web/lib/chat-stats.ts"],
  [
    "web/src/lib/config-events.ts",
    "apps/web/src/lib/config-events.ts",
    "packages/web-runtime/web/lib/config-events.ts",
  ],
  [
    "web/src/lib/extract-changed-files.ts",
    "apps/web/src/lib/extract-changed-files.ts",
    "packages/ui-components/web/chat/lib/extract-changed-files.ts",
  ],
  [
    "web/src/lib/strip-html-tags.ts",
    "apps/web/src/lib/strip-html-tags.ts",
    "packages/ui-components/web/chat/lib/strip-html-tags.ts",
  ],
  [
    "web/src/lib/structured-to-thread.ts",
    "apps/web/src/lib/structured-to-thread.ts",
    "packages/web-runtime/web/chat/structured-to-thread.ts",
  ],
  ["web/src/lib/todo.ts", "apps/web/src/lib/todo.ts", "packages/web-runtime/web/chat/todo.ts"],
  [
    "web/src/lib/tool-semantic.ts",
    "apps/web/src/lib/tool-semantic.ts",
    "packages/ui-components/web/chat/lib/tool-semantic.ts",
  ],
  ["web/src/lib/types.ts", "apps/web/src/lib/types.ts", "packages/ui-components/web/chat/types.ts"],
  [
    "web/src/i18n/locales/en/settings.json",
    "apps/web/src/i18n/locales/en/settings.json",
    "packages/platform/identity/web/i18n/locales/en/settings.json",
  ],
  [
    "web/src/i18n/locales/zh/settings.json",
    "apps/web/src/i18n/locales/zh/settings.json",
    "packages/platform/identity/web/i18n/locales/zh/settings.json",
  ],
  [
    "web/src/__tests__/config-datatable.test.ts",
    "apps/web/src/__tests__/config-datatable.test.ts",
    "packages/ui-components/web/__tests__/config-datatable.test.ts",
  ],
  [
    "web/src/__tests__/config-helpers.test.ts",
    "apps/web/src/__tests__/config-helpers.test.ts",
    "packages/ui-components/web/__tests__/config-helpers.test.ts",
  ],
  [
    "web/src/__tests__/confirm-dialog.test.tsx",
    "apps/web/src/__tests__/confirm-dialog.test.tsx",
    "packages/ui-components/web/__tests__/confirm-dialog.test.tsx",
  ],
  [
    "web/src/__tests__/data-table-round41-pure.test.tsx",
    "apps/web/src/__tests__/data-table-round41-pure.test.tsx",
    "packages/ui-components/web/__tests__/data-table-round41-pure.test.tsx",
  ],
  [
    "web/src/__tests__/data-table-ssr.test.tsx",
    "apps/web/src/__tests__/data-table-ssr.test.tsx",
    "packages/ui-components/web/__tests__/data-table-ssr.test.tsx",
  ],
  [
    "web/src/__tests__/date-picker.test.tsx",
    "apps/web/src/__tests__/date-picker.test.tsx",
    "packages/ui-components/web/__tests__/date-picker.test.tsx",
  ],
  [
    "web/src/__tests__/extract-changed-files-boundaries.test.ts",
    "apps/web/src/__tests__/extract-changed-files-boundaries.test.ts",
    "packages/ui-components/web/__tests__/extract-changed-files-boundaries.test.ts",
  ],
  [
    "web/src/__tests__/extract-changed-files.test.ts",
    "apps/web/src/__tests__/extract-changed-files.test.ts",
    "packages/ui-components/web/__tests__/extract-changed-files.test.ts",
  ],
  [
    "web/src/__tests__/message-additional-ssr.test.tsx",
    "apps/web/src/__tests__/message-additional-ssr.test.tsx",
    "packages/ui-components/web/__tests__/message-additional-ssr.test.tsx",
  ],
  [
    "web/src/__tests__/pagination.test.tsx",
    "apps/web/src/__tests__/pagination.test.tsx",
    "packages/ui-components/web/__tests__/pagination.test.tsx",
  ],
  [
    "web/src/__tests__/params-editor-round42-pure.test.tsx",
    "apps/web/src/__tests__/params-editor-round42-pure.test.tsx",
    "packages/ui-components/web/__tests__/params-editor-round42-pure.test.tsx",
  ],
  [
    "web/src/__tests__/strip-html-tags.test.ts",
    "apps/web/src/__tests__/strip-html-tags.test.ts",
    "packages/ui-components/web/__tests__/strip-html-tags.test.ts",
  ],
  [
    "web/src/__tests__/artifacts-preview-events.test.ts",
    "apps/web/src/__tests__/artifacts-preview-events.test.ts",
    "packages/web-runtime/web/__tests__/artifacts-preview-events.test.ts",
  ],
  [
    "web/src/__tests__/config-types.test.ts",
    "apps/web/src/__tests__/config-types.test.ts",
    "packages/web-runtime/web/__tests__/config-types.test.ts",
  ],
  [
    "web/src/__tests__/permission-options.test.ts",
    "apps/web/src/__tests__/permission-options.test.ts",
    "packages/web-runtime/web/__tests__/permission-options.test.ts",
  ],
  [
    "web/src/__tests__/request.test.ts",
    "apps/web/src/__tests__/request.test.ts",
    "packages/web-runtime/web/__tests__/request.test.ts",
  ],
  [
    "web/src/__tests__/structured-thread-additional.test.ts",
    "apps/web/src/__tests__/structured-thread-additional.test.ts",
    "packages/web-runtime/web/__tests__/structured-thread-additional.test.ts",
  ],
  [
    "web/src/__tests__/structured-thread-boundaries.test.ts",
    "apps/web/src/__tests__/structured-thread-boundaries.test.ts",
    "packages/web-runtime/web/__tests__/structured-thread-boundaries.test.ts",
  ],
  [
    "web/src/__tests__/todo.test.ts",
    "apps/web/src/__tests__/todo.test.ts",
    "packages/web-runtime/web/__tests__/todo.test.ts",
  ],
  [
    "web/src/__tests__/tree-component.test.tsx",
    "apps/web/src/__tests__/tree-component.test.tsx",
    "packages/ui-components/web/__tests__/tree-component.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-bulk-pure-options.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-editor-guards.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-editor-guards.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-editor-guards.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-high-gap-conversions.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-options-boundaries.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-options-boundaries.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-round54-pure.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-round54-pure.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-round54-pure.test.ts",
  ],
  [
    "web/src/__tests__/agent-node-selector.test.ts",
    "apps/web/src/__tests__/agent-node-selector.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-node-selector.test.ts",
  ],
  [
    "web/src/__tests__/agent-resource-picker-interaction.test.tsx",
    "apps/web/src/__tests__/agent-resource-picker-interaction.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-resource-picker-interaction.test.tsx",
  ],
  [
    "web/src/__tests__/agent-utils.test.ts",
    "apps/web/src/__tests__/agent-utils.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-utils.test.ts",
  ],
  [
    "web/src/pages/agent-panel/pages/AgentManagementPage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentManagementPage.tsx",
    "packages/resources/agent-config/web/pages/agent-panel/pages/AgentManagementPage.tsx",
  ],
  [
    "web/src/pages/agent-panel/pages/AgentDashboardPage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentDashboardPage.tsx",
    "packages/resources/agent-config/web/pages/agent-panel/pages/AgentDashboardPage.tsx",
  ],
  [
    "web/src/i18n/locales/en/dashboard.json",
    "apps/web/src/i18n/locales/en/dashboard.json",
    "packages/resources/agent-config/web/i18n/locales/en/dashboard.json",
  ],
  [
    "web/src/i18n/locales/zh/dashboard.json",
    "apps/web/src/i18n/locales/zh/dashboard.json",
    "packages/resources/agent-config/web/i18n/locales/zh/dashboard.json",
  ],
  [
    "web/src/pages/agent-panel/pages/AgentHomePage.tsx",
    "apps/web/src/pages/agent-panel/pages/AgentHomePage.tsx",
    "packages/resources/agent-config/web/pages/agent-panel/pages/AgentHomePage.tsx",
  ],
  [
    "web/src/pages/agent-panel/agent-create-navigation.ts",
    "apps/web/src/pages/agent-panel/agent-create-navigation.ts",
    "packages/resources/agent-config/web/lib/agent-create-navigation.ts",
  ],
  [
    "web/src/i18n/locales/en/agentHome.json",
    "apps/web/src/i18n/locales/en/agentHome.json",
    "packages/resources/agent-config/web/i18n/locales/en/agentHome.json",
  ],
  [
    "web/src/i18n/locales/zh/agentHome.json",
    "apps/web/src/i18n/locales/zh/agentHome.json",
    "packages/resources/agent-config/web/i18n/locales/zh/agentHome.json",
  ],
  [
    "web/src/__tests__/agent-home-generation.test.tsx",
    "apps/web/src/__tests__/agent-home-generation.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-home-generation.test.tsx",
  ],
  [
    "web/src/__tests__/agent-create-enter-flow.test.ts",
    "apps/web/src/__tests__/agent-create-enter-flow.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-create-enter-flow.test.ts",
  ],
  [
    "web/src/__tests__/agent-form-dialog-ssr.test.tsx",
    "apps/web/src/__tests__/agent-form-dialog-ssr.test.tsx",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-ssr.test.tsx",
  ],
  [
    "web/src/__tests__/agent-form-dialog-pure-logic.test.ts",
    "apps/web/src/__tests__/agent-form-dialog-pure-logic.test.ts",
    "packages/resources/agent-config/web/__tests__/agent-form-dialog-pure-logic.test.ts",
  ],
] as const;

/**
 * `RMD_08_RELOCATED` 在册、但其包内 owner 落点在本轮 chat 样式迁移中被删除的条目（三元组口径同上）。
 *
 * `chat-message-content.css` 的排版声明在 RMD-08 时确实迁到了 `@fenix/ui-components`，本表记录的是那之后的
 * 第二段事实：CE 之后 `packages/ui-components/web/chat/**` 的 15 份设计层样式表逐片迁成 Tailwind 工具类并
 * 删除（本条目属阶段三，见 `review/` 与包内 `README.md` 的迁移台账），这份样式表是其中一份——它的元素级与
 * 后代规则改由 `primitives/internal/markdown-classes.ts` 的容器 arbitrary variant 承接。于是「owner 必须存在」
 * 在这条上不再是事实：owner 的**声明**仍在，只是换了载体。
 *
 * 仍留在册、不与 `RMD_08_RELOCATED` 合并的理由是反过来的一半——历史副本与包内副本必须**同时**不存在。
 * 若哪天它从任一侧复活，等于把「未分层 CSS 压过 @layer utilities」的旧排版层重新接回应用壳或组件包，
 * 与容器工具类形成两份真相，因此本表的断言方向是三条路径全为 absent。
 */
const RMD_08_RELOCATED_TARGETS_LATER_DELETED = [
  [
    "web/components/MetaAgentPanel.tsx",
    "apps/web/components/MetaAgentPanel.tsx",
    "packages/resources/workflow/web/pages/workflow/components/MetaAgentPanel.tsx",
  ],
  [
    "web/src/hooks/useMetaAgent.ts",
    "apps/web/src/hooks/useMetaAgent.ts",
    "packages/resources/agent-config/web/hooks/use-meta-agent.ts",
  ],
  [
    "web/components/ai-elements/chat-message-content.css",
    "apps/web/components/ai-elements/chat-message-content.css",
    "packages/ui-components/web/chat/primitives/chat-message-content.css",
  ],
] as const;

describe("RMD-08 apps/web migration", () => {
  // 100 个保留的应用壳源文件都必须从旧根路径移除，并保留在唯一的 owner 目标。
  // 任务 1.3 收口移出的一项：`__tests__/task-form-schema.test.ts` 是内联的表单校验 schema 副本，宿主侧
  // 既无 TaskForm 组件也无导入方，且已与包内唯一 owner 漂移；owner 是 task 包，见下方 relocated 断言。
  // 任务 1.6 T2 再移出 18 项零消费文件，见文件头第 5 条；T4 又移出 1 项（`api/registry.ts`，
  // 见文件头第 6 条），153 → 152；T8b 再移出 11 项，152 → 141；T8c 再移出 11 项，141 → 130；
  // T8d 再移出 15 项（改指包出口）并直删 5 项零消费文件（`context-queue` 宿主副本、`token-stats`、
  // `citation-preview-context`、两份第三方类型垫片——垫片归各包自持，见 §1.6 T8z），130 → 111；
  // T9a 把宿主 `settings.json` 两份交给 identity 包（唯一消费方是包内的 `ChangePasswordDialog`），
  // 111 → 109——i18n 归属重划：键的物理落点必须等于 owner；T9c 直删 8 份零绑定字典与 1 项自指测试
  // （见文件头第 7 条），109 → 100；T10b1 把 12 个 ui-components 归属的宿主测试移入包内（见文件头第 8 条），
  // 100 → 88；T10b2 把 7 个 web-runtime 归属的宿主测试移入包内（见文件头第 9 条），88 → 82；
  // T10b3 又移出 2 项（见文件头第 10 条），82 → 80；T10b4 把 8 个 agent-config 归属的宿主测试移入包内
  // （见文件头第 11 条），80 → 72；T10b5 直删 1 项自指用例（见文件头第 12 条），72 → 71；
  // T11d 随导航贡献化直删 `AgentSidebarConfig.tsx`（见文件头第 13 条），71 → 70；T11e 把三个 agent-panel
  // 页面与其自有字典归位到 `@fenix/agent-config`（见文件头第 14 条），70 → 60；T12 把最后一份
  // agent-config 归属的宿主测试 `agent-form-dialog-ssr.test.tsx` 归位（见文件头第 15 条），60 → 59；
  // T12 再把 `agent-form-dialog-pure-logic.test.ts` 按 owner 拆开搬迁（见文件头第 16 条），59 → 58。
  // 用户裁定的退役（见文件头第 17 条）：宿主 `lib/api-result.ts` 与其专属测试无包内 owner 落点，从本清单
  // 移入 `RMD_08_TARGETS_LATER_DELETED`——只豁免这两条的「目标必须存在」断言；第 19 条再把
  // `agent-master-detail-workspace.tsx` 换挂到 `RMD_08_RELOCATED`（只换表不销记），本侧在册数 58 → 57。
  // 本轮补登记：`utils.test.ts` 的迁移目标随宿主 `lib/utils.ts` 被 `dd3ad35d` 删除（见豁免表第三条），
  // 从本清单移出 → MOVES 55 → 54、豁免表 2 → 3，一增一减，下面断言的两表之和仍是 57。
  test("removes every legacy source and retains its exact owner target", () => {
    expect(RMD_08_MOVES.length + RMD_08_TARGETS_LATER_DELETED.length).toBe(57);
    for (const [source, target] of RMD_08_MOVES) {
      expect(existsSync(source), `legacy source still exists: ${source}`).toBe(false);
      expect(existsSync(target), `apps/web target is missing: ${target}`).toBe(true);
    }
  });

  // 已批准退役的污染测试在旧根路径和迁移目标中都不得复活。
  test("keeps the retired card renderer test deleted", () => {
    expect(existsSync("web/src/__tests__/card-renderer-pure-utils.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/card-renderer-pure-utils.test.ts")).toBe(false);
  });

  // 侧栏导航表随所有权下沉到各包 `web/contribution.ts` 后退场（§1.6 T11d）：`AgentSidebarConfig.tsx`
  // 的三条路径（旧根、迁入后的 `pages/agent-panel/`、壳层落点 `shell/`）都不得复活——它一旦回来，
  // 侧栏就会出现第二份导航真相源，与产物装配的 14 项无声争抢版式。
  test("keeps the retired sidebar nav table deleted", () => {
    expect(existsSync("web/src/pages/agent-panel/AgentSidebarConfig.tsx")).toBe(false);
    expect(existsSync("apps/web/src/pages/agent-panel/AgentSidebarConfig.tsx")).toBe(false);
    expect(existsSync("apps/web/src/shell/AgentSidebarConfig.tsx")).toBe(false);
  });

  // 自指 i18n 测试随其守护的字典一同退役：`toolNarrator` 字典在 T9c 整份删除（无任何命名空间绑定），
  // 旧根路径与应用壳路径都不得复活，否则等于凭空恢复一份死字典的守护测试。
  test("keeps the self-referential narrator i18n test deleted", () => {
    expect(existsSync("web/src/__tests__/narrators-i18n.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/narrators-i18n.test.ts")).toBe(false);
  });

  // 同款自指测试退役（§1.6 T10b5）：`new-session-dialog-form.test.ts` 在文件内自带一份 `newSessionSchema`
  // 再断言它的 safeParse 行为，而全仓没有任何生产模块导出该 schema（`NewSessionDialog` 已不存在）——五条
  // 断言实际只在测 zod 自身。旧根路径与应用壳路径都不得复活，否则等于恢复一份不守护任何实现的用例。
  test("keeps the self-referential session form schema test deleted", () => {
    expect(existsSync("web/src/__tests__/new-session-dialog-form.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/new-session-dialog-form.test.ts")).toBe(false);
  });

  // 在册后目标被删除的条目（见文件头第 17 条与 `RMD_08_TARGETS_LATER_DELETED`）：源与目标都必须保持
  // 不存在——记录的是「已裁定删除 / 目标已被后续提交删除」，不是「迁移丢失」。第一条一旦复活，宿主就会
  // 重新出现第二套「失败结果如何转 Error」的约定（`unwrapApiResult` 与 `ApiError` 各自抛错）；第三条一旦
  // 复活，等于恢复一份只测宿主杂项函数副本的自指用例（同 `narrators-i18n.test.ts` 口径）。
  test("later-deleted migration targets and their legacy sources stay absent", () => {
    for (const [source, target] of RMD_08_TARGETS_LATER_DELETED) {
      expect(existsSync(source), `legacy source came back: ${source}`).toBe(false);
      expect(existsSync(target), `deleted target came back: ${target}`).toBe(false);
    }
  });

  // 沙盒请求构造测试的 owner 已从应用壳交给资源包：旧根路径与旧 app 壳路径都不得复活，包内必须有唯一落点。
  test("relocates the sandbox request helper test to the resource package", () => {
    expect(existsSync("web/src/__tests__/system-sandbox.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/system-sandbox.test.ts")).toBe(false);
    expect(existsSync("packages/resources/sandbox/web/__tests__/system-sandbox.test.ts")).toBe(true);
  });

  // 跨资源复用的密钥投影已上收到 web-runtime：宿主两份旧路径都不得复活，且包内保留唯一实现。
  test("relocates the admin key projection to web runtime", () => {
    expect(existsSync("web/src/lib/admin-key.ts")).toBe(false);
    expect(existsSync("apps/web/src/lib/admin-key.ts")).toBe(false);
    expect(existsSync("packages/web-runtime/web/lib/admin-key.ts")).toBe(true);
  });

  // 任务 1.3 收口的 9 份 + 任务 1.6 T4 的 1 份 + T8b 的 11 份 + T8c 的 11 份 + T8d 的 15 份 + T9a 的 2 份
  // + T10b1 的 12 份 + T10b2 的 7 份 + T10b3 的 1 份 + T10b4 的 8 份 + T11e 归位的 agent-panel 页面、
  // 首页/概览页自有字典与创建导航助手 + T12 归位的 `agent-form-dialog-ssr.test.tsx`（60 → 59 同批）
  // 与按 owner 拆开搬迁的 `agent-form-dialog-pure-logic.test.ts`（见文件头第 16 条），88 → 89：
  // 旧根路径与应用壳路径都不得复活，且包侧 owner 落点必须存在。副本与 owner 并存是「两份实现各自能跑」
  // 的最坏形态，删除与断言必须成对出现。
  // 在册总数改用两张表的**和**守住（见文件头第 18 条）：一条换到 `..._TARGETS_LATER_DELETED` 只改变它的
  // 断言方向，不等于在册数变小，更不能让它在两张表之间凭空消失。
  test("relocates the leftover host copies to their package owners", () => {
    expect(RMD_08_RELOCATED.length + RMD_08_RELOCATED_TARGETS_LATER_DELETED.length).toBe(90);
    for (const [legacy, shell, owner] of RMD_08_RELOCATED) {
      expect(existsSync(legacy), `legacy source still exists: ${legacy}`).toBe(false);
      expect(existsSync(shell), `host copy still exists: ${shell}`).toBe(false);
      expect(existsSync(owner), `package owner is missing: ${owner}`).toBe(true);
    }
  });
  // 包内 owner 落点被本轮 chat 样式迁移删除的那条（见文件头第 18 条与 `RMD_08_RELOCATED_TARGETS_LATER_DELETED`）：
  // 三条路径都不得复活——宿主或包内任一侧重新出现这份未分层样式表，都等同于把旧排版层接回来，与
  // `primitives/internal/markdown-classes.ts` 的容器工具类形成两份真相（未分层声明会静默压过 @layer utilities）。
  test("relocated targets deleted by the chat style migration stay absent", () => {
    for (const [legacy, shell, owner] of RMD_08_RELOCATED_TARGETS_LATER_DELETED) {
      expect(existsSync(legacy), `legacy source came back: ${legacy}`).toBe(false);
      expect(existsSync(shell), `host copy came back: ${shell}`).toBe(false);
      expect(existsSync(owner), `package owner came back: ${owner}`).toBe(false);
    }
  });
  // 拆分归属的用例无法用 relocated 三元组表达：`context-queue` 的宿主副本连同「队列状态」一半一并删除
  // （那一半与该包 `web/__tests__/context-queue.test.ts` 逐字重复），纯函数一半移入 ui-components。断言
  // 覆盖三件事：旧的根路径与宿主副本都不得复活，两个 owner 侧的用例都必须存在。
  test("splits the host context queue test between its two package owners", () => {
    expect(existsSync("web/src/__tests__/context-queue.test.ts")).toBe(false);
    expect(existsSync("apps/web/src/__tests__/context-queue.test.ts")).toBe(false);
    expect(existsSync("packages/web-runtime/web/__tests__/context-queue.test.ts")).toBe(true);
    expect(existsSync("packages/ui-components/web/__tests__/context-queue.test.ts")).toBe(true);
  });
});
