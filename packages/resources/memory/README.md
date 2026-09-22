# @fenix/resource-memory

Hindsight 长期记忆在平台内的唯一 owner：记忆可用性判定、Hindsight MCP server 与 bank 的幂等登记（登记能力当前无生产调用方，见已知项 10）、`agent_memory_config` 的读写，以及 `/web/hindsight/**` 代理路由与记忆控制台页面。

## 定位与 owner

- **manifest**（`fenix.module.ts`，`id` / `kind` / `dependsOn` / `capabilities` 是任务 1.3 W1 的裁定值，本切片未改）：`id: "memory"`、`kind: "resource"`、`dependsOn: []`、`capabilities: ["resource.memory"]`；`create` 是惰性组合根（`() => import("./src/module").then((m) => m.createMemoryModule())`）。`src/module.ts` 当前只承载 id：本包服务端能力都是无状态函数（判定、登记、转发、仓储查询），没有需要进程级单例的可变状态，`contributions` / `web` 字段要与消费端（§1.5 宿主挂载、§1.6 WebShell）同时定型，故不在本任务声明。
- **出口面**（`package.json` 的 `exports`，7 条，目标文件实测全部存在）：

  | 子路径 | 目标 | 用途 |
  | --- | --- | --- |
  | `.` | `src/index.ts` | 通用入口 |
  | `./db` | `db/schema.ts` | 本包唯一表定义（`agent_memory_config`，§1.7 B10 迁入） |
  | `./module` | `fenix.module.ts` | 模块索引层（生成 registry 导入 `moduleManifest`） |
  | `./server` | `src/server.ts` | 服务端交付物唯一入口 |
  | `./server/testing` | `src/server/testing.ts` | 模块配置基线（宿主测试 preload 用） |
  | `./web` | `web/index.ts` | 浏览器面唯一入口 |
  | `./web/i18n` | `web/i18n/index.ts` | i18n 资源与命名空间 |

- **owner 边界（实测）**：`agent_memory_config` 全仓只有两处引用——本包 `db/schema.ts` 的表定义与 `src/server/repositories/agent-memory-config.ts` 的读写（§1.7 B10 起表定义也归本包，`apps/server/src/db/schema.ts` 不再转出），没有第二份读写实现；对 Hindsight HTTP 上游的调用只有本包的 `proxyToHindsight()`（全仓无第二处 `v1/default/banks` 客户端）。
- **消费方（实测 `command grep -rn "@fenix/resource-memory" packages apps --include="*.ts"`）**：`@fenix/agent-config`（`isAgentMemoryEnabled` / `setEnabled`）、`@fenix/agent-runtime`（`HINDSIGHT_PLUGIN_DEFAULTS` / `shouldEnableAgentMemory`）、宿主 `apps/server/src/routes/web/index.ts:11,45`（**已改**用 `createWebHindsightRoutes({ authGuardPlugin })` 路由工厂）、宿主 `apps/server/src/test-utils/setup-mocks.ts:29`（模块配置基线）与 `apps/web/src/i18n/index.ts:18,123,137`（字典，均见「共享文件改动」）、`apps/generated/module-registry.ts`（`moduleManifest`）。这些符号全部在 `src/server.ts` / `fenix.module.ts` / `web/i18n` 的导出面内。
- 分层 L1（`dependsOn` 为空，无资源间依赖）。

## 服务端交付物

`bun test packages/resources/memory`：**107 pass / 0 fail / 280 expect() calls / 10 文件**（`env -u ANTHROPIC_MODEL` 消除会话环境变量污染后实测；§1.7 B10 表定义迁出后本包测试集合未变，`expect` 计数 +1 来自浏览器面负例新增的递归深度断言、+4 来自 2026-09-22 去重新增的四条可达面清单项）。较 W2 切片收口的 97 pass / 8 文件增加 `web/__tests__/hindsight-failure.test.ts`、`web/__tests__/hindsight-failure-notice.test.tsx` 两个文件，以及 §1.3(6) 的失败分类与渲染契约用例。

- **判定入口**：`src/server/services/agent-memory.ts` 的两级模型——系统级 `isHindsightAvailable()`（模块配置是否给出 `hindsightMcpUrl`）与 Agent 级 `isAgentMemoryEnabled(agentConfigId)`（`agent_memory_config.enabled`），由 `shouldEnableAgentMemory()` 组合。`HINDSIGHT_PLUGIN_DEFAULTS` 是同文件导出的插件运行时默认值。
- **模块配置**：`src/server/config.ts` 的 `getMemoryConfig()` 经平台 `getModuleConfig("memory")` 读取，用 `z.strictObject` 校验（`hindsightMcpUrl` 可选；形状非法抛错并且不回显字段值）。**空串与字段缺失同等视为「未配置」**：docker 默认部署的 `HINDSIGHT_MCP_URL: ${HINDSIGHT_MCP_URL:-}` 在 .env 未设置时透传空串，不归一就会让「未部署记忆」从静默禁用变成校验抛错（`web/__tests__/hindsight-service.test.ts` 用例钉住）。包内**不读** `process.env`（实测生产代码 0 处命中），值的来源是宿主 `apps/server/src/env.ts` 解析后的 `HINDSIGHT_MCP_URL`。
- **数据访问**：`src/server/db.ts` 的 `getMemoryDatabase()`（= 平台 `getDatabase<T>()`，请求期读取）；`src/server/repositories/agent-memory-config.ts` 是唯一数据访问点（`getByAgentConfigId` / `setEnabled` 幂等 upsert），route 不碰 db。`agent_memory_config` 的**表对象**自 §1.7 B10 起由本包 `db/schema.ts` 持有，仓储经出口 `@fenix/resource-memory/db` 取用（自我引用而非相对路径：`db/` 不进包 `tsconfig.json` 的 `include`，只有走包 `exports` 才能被解析，`@fenix/agent-config` 同形）。
- **bank 与 MCP 登记**：`ensureHindsightMcpServer(ctx, { registerSystemMcpServer })` 先用 `getIdentityDirectory().resolveMembershipId()` 把「当前用户在活跃组织下的 member id」解析为 bank ID（不直查身份表），再幂等登记系统托管 MCP server，最后 `ensureBank()` 以 `PUT /v1/default/banks/{bankId}` 保证 bank 存在。系统 MCP 的写入经**参数注入**，不 import `@fenix/resource-mcp`：`dependsOn` 冻结为 `[]`，而生成器的 `assertDependsOnDeclared` 要求 `dependsOn` 每条都能在 `package.json` 找到 `workspace:` 区间，直接 import 会以「未声明编译依赖」失败。**该登记能力当前无生产调用方**（迁移前也无），影响与移除条件见已知项 10。
- **路由工厂**：`src/server/routes/web/hindsight.ts` 导出 `createWebHindsightRoutes({ authGuardPlugin })`（实测 19 个处理器：`GET /status`、`GET /graph`、`GET /bank-stats`、`GET|POST|DELETE /memories(/:id)`、`POST /recall`、`POST /reflect`、`GET|POST|DELETE /documents(/:id)`、`GET /documents/:id/chunks`、`GET|DELETE /mental-models(/:id)`、`GET /entities`、`GET /entities/:id`、`GET /entities/graph`），守卫与依赖类型在 `src/server/routes/dependencies.ts`（只声明 `AnyElysia`）。守卫必须注入而不能在包内 `.use()`：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；`AuthContext` 也只取用到的 `{ organizationId, userId }`，不引用宿主类型。除 status 外，无法解析 bank 映射为 403、上游不可达映射为 503。
- **测试设施**：`src/server/testing.ts` 提供 `createMemoryModuleConfig()` / `initializeMemoryModuleConfig()`；`src/__tests__/guard-stubs.ts` 是会话守卫替身（携带组织上下文，供跨组织隔离用例切换）。

## 浏览器面与 i18n

- **入口**：`web/index.ts` 导出 `MemoriesPage`、`hindsightApi`、`HINDSIGHT_NS` / `hindsightResources` 与 `web/pages/hindsight/types`。浏览器安全由 `web/__tests__/memory-browser-surface.test.ts` 守护：从 `web/index.ts` 出发按值导入图递归（跨包经对方 `exports` 解析到真实源文件），白名单只含浏览器安全外部依赖；负例注入本包 `./server` 出口时递归会进入服务端实现并触发拦截（本包服务端子树没有 `node:` 内建导入，故 `node:` 断言在正向图与负例图里都是空集；§1.7 B10 后本包 `src/**` 对宿主零引用，负例的「递归深度」取证改为「到达最深的仓储文件 `src/server/repositories/agent-memory-config.ts`」+「经自我引用跨出到 `db/schema.ts`」，外加原「白名单外外部依赖」一条）。
- **分支重放**：本包 `web/` 按 §6.5 规则重放 `origin/feat/ui-components-demo` 的 13 个文件，全部取分支版本（`git diff origin/feat/ui-components-demo -- <13 文件>` 逐文件 0 差异）。复核结论：HEAD → 分支的差异**只有 import 说明符**（其中 4 个文件还各带一处孤立空行的删除，即 brief 里记为「非 import 变更 1 行」的那一行），本包因此不存在需要按「以本分支为底」回退的授权语义冲突（分支的 `resourceAccess: ResourceAccess` 旧形状只出现在 skill 包）。原 `@/` 别名 **46 处 / 14 个目标**全部改指：`@fenix/ui-components/{ui,components,lib}`、`@fenix/web-runtime/{api/request,i18n/namespace}`、包内相对路径；本包无 `@fenix/<pkg>/src` 深路径导入。
- **包内共享件（2026-09-22 去重）**：`pages/hindsight/memory-type-title.ts`（类型标题的共用实现，读 `memoryDetail.*` 键）、`components/MemoryDetailBody.tsx`（弹窗与面板共用的详情正文，`variant` 选排版、`labels` 由调用方翻译传入）、`components/MemoryPagination.tsx`（表格视图与实体列表共用的分页条：四按钮 + 页码 + 左侧区间文案；时间线视图的**分组滚动导航**是另一套交互，不在收敛范围）、`pages/hindsight/recency.ts`（近期热度的归一化 `recencyHeat` 与图例两端 `recencyEndpoints`：表格视图按 `recencyBasis` 取时间、实体视图取共现边的最近一次共现，数据来源不同但归一化口径必须一致）。四者都只有本包消费，因此不上移 `@fenix/ui-components`。
- **失败/无权限状态（§1.3(6)，本切片补齐）**：本包后端在除 `/status` 外的全部路由上把「无法解析 bank 映射」映射为 403 `{ code: "forbidden" }`，但 request 层 `normalizeErrorCode` 会原样透传后端的 `code`（只有无 code 的 401/403 才归一到 `UNAUTHORIZED`），因此前端的授权判定**必须同时接受 `forbidden` 与 `UNAUTHORIZED`**。`web/pages/hindsight/failure.ts` 就是这一层分类（`toHindsightFailure()` → `{ kind: "forbidden" }` 或 `{ kind: "error", detail }`），`components/HindsightFailureNotice.tsx` 是唯一的失败块渲染器：无权限分支只给本地化文案、**不渲染重试按钮**（对 403 重试永远得到同一个 403，给按钮等于提供死循环操作），通用失败分支才接 `onRetry`；块本身经库的 `EmptyState`（`tone="danger"`）渲染，`role="alert"` 内聚在组件里，调用方只用 `className` 表达各自的外间距（2026-09-22 去重前这里是裸片段，五处调用点各复写一遍居中容器与 `role`）。接线的六处是 `MemoriesPage`（status 探测）、`DataView`（事实列表）、`EntitiesView`（实体列表 / 关系图 / 详情浮层三处失败）、`MentalModelsView`（列表失败从 toast 改为持久分支，之前 toast 消失后只剩「暂无心理模型」，会把 403 伪装成空数据）、`MemoryDetailModal`（只展示原因、不接重试）、`MemoryDetailPanel`（详情面板：此前失败只写 `console.error` 并静默回落到行摘要，现给出可见失败块与重试）。分类依赖 `code` 透传这一行为，由 `web/__tests__/hindsight-api-error.test.ts` 里一条打真实 403 JSON 响应的端到端用例钉住；交互契约（无权限 0 按钮、通用失败 1 按钮且真的触发回调）由 `web/__tests__/hindsight-failure-notice.test.tsx` 钉住。`web/pages/hindsight/components/DocumentsView.tsx` 的取数分支**未改**：它不在 `web/index.ts` 的值导入图内（见已知项 2 的同类情况），改它属 §1.6 页面重接线范围。
- **依赖声明**（T2e）：`react` / `react-dom` / `react-i18next` / `i18next` 为 peerDependencies（范围与根 `package.json` 逐字一致，避免第二份实例）；`@fenix/agent-config`（§1.7 B10 起：`db/schema.ts` 的外键目标 `agent_config`，只取列对象、不是装配依赖，故不进 `dependsOn`）、`@fenix/ui-components`、`@fenix/web-runtime`、`@fenix/platform-sdk`、`cytoscape`、`cytoscape-fcose`、`@chenglou/pretext`、`lucide-react`、`sonner`、`react-markdown`、`remark-gfm`、`drizzle-orm`、`elysia`、`zod` 为 dependencies；`happy-dom` 只在测试用，为 devDependencies。
- **i18n**：命名空间固定 `hindsight`（`web/i18n/namespace.ts`，与宿主 `@fenix/web-runtime/i18n/namespace` 的 `NS.HINDSIGHT` 同值，测试钉住）；词典路径 `web/i18n/locales/{en,zh}/hindsight.json`，各 **253 个叶子键**，en/zh 键集与插值占位对齐。2026-09-22 详情去重把详情类型标题的键从 `memoryDetailModal.*`（面板此前跨组借用）移到共同前缀 `memoryDetail.*`（4 键，中英文措辞不变），并删去随之失去引用的 `memoryDetailModal.defaultTitle` / `type*` 与 `memoryDetailPanel.title`；同批新增面板失败态的两键 `memoryDetailPanel.loadFailed` / `retry`。本切片（§1.3(6) 的「无权限」分支）新增 3 键并两侧同步：`errors.forbiddenTitle`、`errors.forbiddenHint`、`mentalModels.retry`。**宿主已改经包出口取字典**：`apps/web/src/i18n/index.ts:18,123,137` 用 `@fenix/resource-memory/web/i18n` 的 `HINDSIGHT_NS` / `hindsightResources` 登记，不再深相对路径 import 这两份 JSON。注意「改经出口」不等于「JSON 路径可动」——包内挪动文件同样会经出口断链，症状仍是文案整片回退成 key 回显（`memory-i18n.test.ts` 以「文件真正在哪」表达该契约）。既有缺键在 `web/__tests__/memory-i18n.test.ts` 里以清单钉住（见已知项 1）。

## 边界残留与共享文件改动

**宿主内部导入已归零（§1.7 B10）**：本包最后一条残留 `@server/db/schema`（`agent_memory_config` 表定义，原在 `src/server/repositories/agent-memory-config.ts:1`）随表定义迁入本包 `db/schema.ts` 一并消失；台账 `apps-boundary` 的 memory 条目（owner 1.7）随之删除。复核命令 `command grep -rn --include="*.ts" --include="*.tsx" -E 'from "@server/' src web db` → **0 处**。

**包内 tsconfig 自包含**（静态条件 3）：`tsconfig.json` 不 `extends` 任何包外文件，`jsx` / `moduleResolution` / `lib` / `types` / `strict` 等选项内联声明——继承 `apps/web/tsconfig.json` 会让本包的编译设置由宿主应用决定，且 `packages/**` 内出现指向 `apps/web` 的相对路径正是条件 3 禁止的形态。`paths` 已整体删除（原表只有一条 `@server/db/schema` 映射，B10 后零消费；失效映射留着会掩盖新的宿主导入回潮，同 `@/` 别名表的处置）。

本切片切断的宿主符号（HEAD 实测 **9 处 / 5 文件**，B10 后 `src/**` + `web/**` + `db/**` 生产代码 **0 处**）：

| HEAD 导入（处数） | 改法 |
| --- | --- |
| `@server/plugins/auth`（4：2 处生产 + 2 处测试的 `setTestAuth` / `AuthContext`） | 生产改路由工厂 + 宿主注入守卫；测试改包内 `src/__tests__/guard-stubs.ts` 替身 |
| `@server/services/config`（1，`upsertSystemMcpServer`） | `ensureHindsightMcpServer()` 的参数注入 `RegisterSystemMcpServer` |
| `@server/services/config-utils`（1，`configSuccess`） | 路由内 `ok()` 信封（与既有 `/web/*` 响应形状一致） |
| `@server/services/org-context`（1，测试 `setTestOrgContext`） | 守卫替身直接携带组织上下文，`setTestOrgContext` 用例消失 |
| `@server/db`（1，`db` 句柄） | `getMemoryDatabase()`（平台 `getDatabase()`） |
| `@server/db/schema`（1） | **§1.7 B10 迁出**：表定义移入本包 `db/schema.ts`，仓储改经 `@fenix/resource-memory/db` 取用 |

**共享文件改动（`apps/**`、`scripts/**` 归编排者，本包只列清单）**。1–4 项已在工作区落地（`git status` 实测均为 `M`），本包 README 只记录其形状与原因：

1. `apps/server/src/main.ts:194`：`moduleConfigs: { memory: { hindsightMcpUrl: env.HINDSIGHT_MCP_URL } }`——**已落地**。不装配则 `getModuleConfig("memory")` 抛「未声明应用基础设施配置」（`envDefinitions` 声明归 §1.7）。
2. `apps/server/src/test-utils/setup-mocks.ts:29`：`registerModuleConfigBaseline("memory", createMemoryModuleConfig())`（import 自 `@fenix/resource-memory/server/testing`）——**已落地**。落地前实测：只登记 skill 基线时 `bun test packages/agent-runtime/src/__tests__/round43-launch-spec-builder.test.ts` 在 `getMemoryConfig` 抛「应用基础设施尚未初始化」（10 pass / 13 fail）；补上 memory 基线后同一命令 **23 pass / 0 fail**。
3. `apps/server/src/routes/web/index.ts:11,45`：`import { createWebHindsightRoutes } from "@fenix/resource-memory/server"` + `createWebHindsightRoutes({ authGuardPlugin })`——**已落地**（此前该行导入的是已删除的 `webHindsightRoutes`，探针实测 TS 报 `has no exported member named 'webHindsightRoutes'`；该诊断当时被 workflow 包正在写文件的语法错误掩盖，见已知项 8）。
4. `scripts/architecture/exceptions.json`：`apps-boundary` 的 memory 条目（HEAD 改写为「1 处 `@server/db/schema` 表定义、owner 1.7」）已随 §1.7 B10 归零**删除**；`web-package-not-to-app` 的 memory 条目（HEAD 46 处 / 13 文件）在 1.5c 删除——**已落地**。
5. §1.6 重接线——**已落地**：宿主 `apps/web/src/i18n/index.ts:18,123,137` 经 `@fenix/resource-memory/web/i18n` 登记字典；`apps/web/src/routes/agent/_panel/memories.tsx` 的懒加载说明符已随 T11e 改指 `@fenix/resource-memory/web`，不再经 `@/src/pages/hindsight/MemoriesPage` 别名穿透本包 `web/**`。宿主 `apps/web/src/types/cytoscape-fcose.d.ts` 也已不存在（本包自带的 `web/types/cytoscape-fcose.d.ts` 垫片是唯一一份）。

## 已知项

1. **12 个既有缺键**（`web/__tests__/memory-i18n.test.ts` 的 `KNOWN_MISSING_KEYS` 清单钉住，JSON 未改）：`common.clear`（跨命名空间用点号 `common.clear` 而非宿主的分隔符，英文侧回落到 `defaultValue`）、`constellation.tooltip{Entities,Id,Proofs,Tags}`、`graph2d.{controlsHint,emptyState,linkTooltipEntity,linkTooltipWeight,linkTypeCausal,linkTypeGeneric,loading}`。补译文属产品文案，不在本切片。
2. **`web/pages/hindsight/components/CompactMarkdown.tsx` 无消费者**（实测除测试外无人导入，浏览器图也进不去）：其 `react-markdown` / `remark-gfm` 依赖因此仍留在 `dependencies` 里；删文件与删依赖需与 §1.6 的页面重接线一起判断。
3. ~~**`happy-dom-window.ts` 有 4 份副本**~~ **已收敛（§1.6 T10a）**：全仓唯一实现现为 `@fenix/ui-components/testing` 的 `initializeHappyDomWindow`，本包 `web/__tests__/happy-dom-window.ts` 与其余三份副本已删除，2 个调用点改经该子路径导入（happy-dom 由 `@fenix/ui-components` 声明为 devDependency）。
4. **真实守卫的拒绝路径无覆盖**：迁移前有两条「未认证访问必须 401」用例，守卫改为注入后包内无法表达（注入真实守卫即等于依赖宿主）；宿主 `apps/server/src/__tests__/` 实测暂无 hindsight 用例，该合同归 §1.5。缺口写在 `src/__tests__/guard-stubs.ts` 头部。
5. **2 处既有 biome 错误的处置**（`web/pages/hindsight/components/{Constellation.tsx,DataView.tsx}` 的 `useExhaustiveDependencies`，HEAD 快照逐字复现同一位置同一规则，故非 W2 引入）：`Constellation` 的 `drawLabel` 改为 `useCallback(..., [])`——它只依赖模块级常量与入参，身份稳定后 `animate` 不再每次渲染重建、启动动画的 effect 也不再被反复重启；`DataView` 的挂载期单次加载保留单次语义并加行级 `biome-ignore` 说明原因（`loadData` 未 memo 且内部 setState，列入依赖会形成「渲染→拉取→渲染」循环；`factType` / 检索词变化由父级 `MemoriesPage` 的 `key` 重挂载表达）。`./node_modules/.bin/biome check packages/resources/memory` 现为 **0 error 0 warning**。同一规则在宿主文件（`apps/web/components/ui/tree.tsx:315`）的命中不属本包范围。补测收口时同一门禁还报出 `src/server/routes/web/hindsight.ts` 与 `src/__tests__/hindsight-routes.test.ts` 两处**纯格式**错误（HEAD 快照逐字复现，非本切片引入，两文件属 W2 切片的工作区改动）；为让包级门禁归零，已用 biome 确定性格式化这两处（仅折行，无语义变更），故路由文件行数由 610 变为 628。
6. **1 处既有 latent 类型错误**：`web/__tests__/hindsight-api-error.test.ts:13`（fetch 替身缺 Bun 的 `preconnect`）。内容与 HEAD 逐字相同；此前被包内 tsconfig 的 `baseUrl` 弃用告警（TS5101，fatal）掩盖，本切片修掉该配置错误后才可见。修法是给替身补参数并收窄类型，属既有测试文件的独立修复，未顺手改（`tsc -p packages/resources/memory/tsconfig.json` 现在只剩这一条）。
7. **超大文件（既有，违反「单文件 ≤ 500 行」，未在本切片拆分）**：路由文件 628 行（HEAD 592 行，本切片 +18 行是工厂外壳、其余差额来自已知项 5 的格式化）、`DataView.tsx` 1034 行、`Constellation.tsx` 1023 行、`Graph2d.tsx` 737 行（后三者 HEAD 同值，本切片只改其失败分支）。拆分属模块边界重构，与本切片的目标（切边界、补交付物）正交，留给后续 review；在拆分前这批文件是包内对 CLAUDE.md「单文件不得超过 500 行」的已知例外。
8. **宿主 typecheck 当前被掩盖**：`bunx tsc --noEmit` 只报 workflow 包在写文件的 12 条语法错误（`packages/resources/workflow/src/server/repositories/workflow-def.ts`）；实测「同程序内一处语法错误会抑制全部语义诊断」（包内三文件探针复现），因此宿主那行失效导入的诊断要等 workflow 切片落地后才可见。
9. **§1.4 待办（不在本包）**：`packages/agent-runtime/src/services/launch-spec-builder.ts:579,613` 仍直读 `process.env.HINDSIGHT_MCP_URL` / `HINDSIGHT_API_TOKEN` 构造启动参数；本包不下发这两个环境变量的读取职责（§1.4 收敛）。
10. **交付能力当前无生产调用方（`ensureHindsightMcpServer` / `ensureBank`）——需 owner 裁定「接线 or 删除」**：实测 `command grep -rn "ensureHindsightMcpServer\|ensureBank" apps packages scripts --include="*.ts"` 在 `apps/**`、`scripts/**` 命中 0 处生产调用，包内命中只有 `src/server/services/hindsight.ts` 的定义、`ensureHindsightMcpServer` 内部对 `ensureBank` 的调用，以及 `src/__tests__/hindsight-service.test.ts` 的 7 条用例；`git grep HEAD -- apps scripts` 里宿主侧只有 `upsertSystemMcpServer` 的定义与测试替身，没有任何 `ensureHindsightMcpServer` 调用点。**这是迁移前就存在的死能力，不是本切片新引入的缺口**（因此不删：删掉的是「已被验证过的登记实现」，接线时还要重写）。**影响**：记忆 bank 与系统托管 MCP server 的幂等登记在运行时不可达——`agent_memory_config` 写入与 `/web/hindsight/**` 转发都不经过它，但「启用记忆时自动建好 bank/MCP」这条路径永远不会执行，用户必须由部署侧或管理员手工准备 bank，否则 `resolveMembershipId` 之外的请求会以 403「无法解析 bank ID」进入本切片新增的无权限分支。**移除/接线的条件**：由 owner 二选一——(a) 接线：在记忆启用流程（`setEnabled` 的调用点或宿主对应 `/web` 入口）调用 `ensureHindsightMcpServer(ctx, { registerSystemMcpServer })`，届时需同步 `dependsOn`/`package.json` 依赖声明与集成测试（当前 `dependsOn: []` 靠参数注入绕开编译依赖，接线后该约束要重新评审）；(b) 删除：连带删除 `src/server/services/hindsight.ts` 的登记实现、`resolveMemberId` 与上述 7 条用例。裁定前保留实现与用例。**可追踪**：本条即追踪入口（§1.3 交付面的已知缺口），owner 裁定后应落到具体任务再闭环。**2026-09-21 更新（任务 1.5c 收尾）**：宿主侧那份 `upsertSystemMcpServer` 薄包装（`apps/server/src/services/config/mcp-system-server.ts` 与其转发 barrel `services/config/index.ts`）已按「零生产消费方」删除——它的唯一消费者是本条所述那条未接线的路径，删除只是消除一份死适配器，不改变上面的 (a)/(b) 裁定；选 (a) 接线时在装配点注入一次 `getMcpServerModule().service.upsertSystemServer` 委托即可（详见 review/task-1.5-host-aggregation.md §1.5c-8）。
