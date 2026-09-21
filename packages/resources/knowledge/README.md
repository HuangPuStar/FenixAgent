# @fenix/resource-knowledge

知识库、知识资源与 agent 知识库绑定的唯一 owner：服务端领域规则加 RAGFlow provider 适配，浏览器侧交付控制台页面与 API client。

## 职责

- **仓储**：`src/server/repositories/knowledge-base.ts` 是 `knowledge_base` / `knowledge_resource` / `agent_knowledge_binding` 三张表的唯一数据访问点（35 个方法，每个方法首行 `const db = getKnowledgeDatabase()`），导出 `knowledgeBaseRepo` / `knowledgeResourceRepo` / `agentKnowledgeBindingRepo` 三个单例。实测（含未跟踪新增文件）`grep -rn --include="*.ts" -E 'from "@server/' src web` 只命中一行——该文件的 `@server/db/schema`：`services/**` 与 `routes/**` 都不直接取句柄。
- **知识库领域**：`src/server/services/knowledge-base.ts` 负责 slug 生成与唯一性校验、名称与 slug 的本地校验（在访问 DB 和 provider 之前拒绝）、状态推导（`upsertKnowledgeBaseStatusFromResources`）、删除前的绑定占用检查，以及创建表单选项（`listKnowledgeFormOptions`：嵌入模型 / 分块方法 / pipeline）。
- **Provider 抽象**：`src/server/services/knowledge-provider/types.ts` 定义 `KnowledgeProvider` 契约（dataset 创建与列举、检索、检索测试、`readResource`、知识图谱、模型目录），唯一实现是同目录 `ragflow.ts` 的 `RagFlowKnowledgeProvider`（`:27` 的 `mapRunStatus` 把 RAGFlow 的 run 字符串映射为 `pending/processing/ready/error`，`checkRagFlowHealth()` 供宿主启动期探活——宿主调用点 `apps/server/src/main.ts:383`）；`registry.ts` 的 `getKnowledgeProvider()` 是惰性单例，`setKnowledgeProviderForTesting()` 是包内测试 seam。
- **资源入库**：`knowledge-upload.ts` 负责上传落盘、URL 导入、重新解析、状态刷新与删除，并按资源汇总回写知识库状态；上传与导入是幂等的（按 sourceName / remoteId 复用 pending 资源）。
- **Agent 绑定与检索**：`agent-knowledge.ts` 维护 binding 的读写与策略归一化（`searchFirst` / `maxResults` / `defaultNamespaces`）；`knowledge-runtime.ts` 按绑定知识库检索、读取单个资源、生成/读取/删除知识图谱并轮询进度，检索按 embedding model 分组（RAGFlow 要求同一请求的 dataset 同模型），远端失败只跳过该分组不整单失败。
- **HTTP 交付物**：两条路由都以工厂形式导出——`createWebKnowledgeBaseRoutes(deps)`（23 条控制台端点：CRUD、资源上传与文件/PDF 预览、chunk 管理与启停、检索测试、知识图谱，以及 action 风格的 `POST /web/knowledgeBases/models` 模型管理）与 `createApiKnowledgeBaseRoutes(deps)`（`/api/knowledge-bases`，对外只读分页列表，1 条端点）。工厂出参是 Elysia 实例（`name` 分别为 `web-knowledge-bases` / `api-knowledge-bases`），宿主挂载点见「边界外的已知项」。
- **浏览器交付物**：`web/index.ts` 是唯一公开面（页面、目录/资源面板、`kbApi`、`embeddingModelApi`、`ResourcePreview*`、图谱面板、i18n 资源与类型）；`web/i18n/{namespace,index}.ts` 提供命名空间常量与字典，字典文件仍是 `web/i18n/locales/{en,zh}/knowledge.json`（各 55 个顶层键 / 245 个叶子键，两语言键集一致，实测见下）。
- **组合根**：`src/module.ts` 的 `createKnowledgeModule()` 返回三个仓储单例（对象身份即数据访问点，跨包调用方拿到同一批实例）；`fenix.module.ts` 的惰性 `create` 指向它，`dependsOn` / `capabilities` 未变。

## 依赖边界

本包属 `resources` 类别。`dependsOn: []` 来自实测：`src/**` 对外只有 `@fenix/platform-sdk`（根入口的响应信封 schema `ApiErrorResponseSchema` / `WebErrSchema` / `WebOkSchema`，`/server` 子路径的 `getDatabase` / `getModuleConfig` / `overrideModuleConfig`，`/testing` 子路径的 `stubDb` / `getDbStub` / `readJson` / `resetAllStubs` / `initializeTestApplicationInfrastructure`，后者只出现在 `src/server/testing.ts` 与用例）与宿主表定义 `@server/db/schema`（§1.7 残留）。三条都是 `platform` 基建，不产生 `resource` 装配边。

- `package.json` 的 `exports`（每个目标文件均已核对存在）：`.` → `src/index.ts`、`./module` → `fenix.module.ts`、`./server` → `src/server.ts`、`./server/schema` → `src/server/schemas/knowledge.schema.ts`、`./server/testing` → `src/server/testing.ts`、`./web` → `web/index.ts`、`./web/i18n` → `web/i18n/index.ts`。
- 跨包消费方全部经公开面。实测导入说明符只有四个公开出口：`@fenix/resource-knowledge/server`（22 处）、`/web`（4 处，全部在 `@fenix/resource-agent-config`）、`/server/schema`（1 处）、`/module`（1 处）。消费方：宿主（`main.ts`、`routes/web/index.ts`、`repositories/index.ts`、`schemas/index.ts`、`plugins/auth.ts`）、`@fenix/resource-mcp`（`searchKnowledgeDetailedForAgent` / `readKnowledgeResourceForAgent` / `getKnowledgeGraphForAgent`）、`@fenix/resource-agent-config`（`InvalidKnowledgeBindingError` / `resolveAgentKnowledgePolicy` / `AgentKnowledgeConfig` / `AgentKnowledgePolicy`）、`@fenix/agent-runtime`（`src/services/launch-spec-builder.ts` 与用例的 `setListAgentKnowledgeBindingsById`）、`@fenix/resource-workflow` 的用例。实测 `git grep -nE "@fenix/[a-z-]+/src/" -- packages/resources/knowledge` 为 0。
- `@fenix/model-management` 依赖已移除：`EmbeddingModelManager` 连同 `embeddingModelApi` 的消费于本次收敛（方向一）整体移入本包 `web/src/pages/agent-panel/components/EmbeddingModelManager.tsx`，本包 web 侧不再引用 model-management。此前该依赖只在 web 侧（不进服务端装配顺序）、但构成本包与 model-management 的**互引环**，现已消除；`model-management/README.md` 的同条已知项同步关闭。
- `@fenix/identity` 的 web 侧依赖已消除（§1.6 T7）：`AgentKnowledgeBasesPage.tsx` 原经 `@fenix/identity/web` 取 `useOrg` / `useSession`（1 处 / 1 文件，§6.5 裁定组织上下文必须取宿主同一份），在 §2.3 矩阵里是 `special-dependency`（禁止 resource → platform-impl）。现改为 `@fenix/web-runtime/contexts/org-session` 的 `useOrgSession()`，取值形状 `{ organizationId, userId, isOwner, pending }`：契约落在平台中立的 web-runtime，**实现方仍是身份包的 `OrgProvider`**，因此拿到的还是宿主挂载的同一份 context 实例；页面据此算 `canManage`（`isOwner`）与详情页的本人判定（`userId`）。台账条目 `@fenix/resource-knowledge → @fenix/identity` 已随之删除。

## 守卫由宿主注入

路由是**工厂 + 注入守卫**：`createWebKnowledgeBaseRoutes({ authGuardPlugin })` / `createApiKnowledgeBaseRoutes({ authGuardPlugin })`，依赖类型定义在 `src/server/routes/dependencies.ts`（只声明本包消费的 `SessionAuthContext { organizationId, userId }` 窄契约）。

为什么必须注入而不是包内自建：Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；守卫必须与宿主的认证解析（session cookie / Environment Secret / API Key、active organization 解析）是同一份实例，否则同一进程会出现两套互不可见的认证状态，且 Elysia 按 plugin `name` 去重会让先构造的一方静默生效。RAGFlow 密钥经 `resolveRagflowApiKey()`（`src/server/services/ragflow-key.ts`）从模块配置读取：空值即抛 `RAGFLOW_API_KEY is not configured`（快速失败，不把空 Bearer 送到上游），密钥不进日志、不进错误响应。三个位置参数是历史调用面的占位（实测 23 处调用点），删除属接口收敛，不在本切片范围。

包内用例注入 `src/__tests__/guard-stubs.ts` 的替身：装成允许态时写入 `AUTH_CONTEXT = { organizationId: "org-1", userId: "user-1" }`，装成拒绝态（`createStubSessionAuthGuardPlugin(null)`）时返回与宿主同形的 401，用来断言端点确实声明了 `sessionAuth`。替身插件名刻意与宿主的 `auth-guard` 不同，避免 Elysia 去重造成「替身没生效却因真实守卫恰好放行而假绿」。真实守卫下的认证行为由宿主用例覆盖，本包不复制第二份鉴权策略。

## 配置与 DB

- **配置**：`src/server/config.ts` 的 `getKnowledgeConfig()` 读 `getModuleConfig("knowledge")`，用 `z.strictObject` 校验 `ragflowApiUrl` / `ragflowApiKey` / `ragflowRequestTimeoutMs` / `gotenbergUrl` 四个字段，校验失败只报 `path:code` 不回显取值。`GOTENBERG_URL` 原先由本包路由直接读 `process.env`，现已改由模块配置注入；该变量的宿主读取点只剩 `apps/server/src/config.ts:100`（`process.env.GOTENBERG_URL || "http://127.0.0.1:3200"`），宿主 `env.ts` 仍未声明它（`apps/server/src/main.ts:185` 的注释与之一致）——**声明与接线归宿主 env 链**（见「边界外的已知项」）。实测 `grep -rn "process\.env" src web` 无实际读取点（仅 `src/server/config.ts:9` 注释提及）。
- **DB**：`src/server/db.ts` 的 `getKnowledgeDatabase()` 返回 `getDatabase<KnowledgeDatabase>()`（`@fenix/platform-sdk/server` 的基础设施，未初始化即抛错）；表对象仍来自 `@server/db/schema`（迁出归 §1.7），所以 `@server/*` 的残留只有这一处 import。
- **测试基建**：`src/server/testing.ts` 导出 `createKnowledgeModuleConfig()` / `initializeKnowledgeModuleConfig()` / `stubKnowledgeConfig()`；DB 走转发 Proxy（`get` 实时转 `getDbStub()`），因此一次初始化后每个用例仍可 `stubDb()` 换替身。包内**不** import 宿主的 `@server/test-utils/**`（实测 0 处），也不依赖宿主 preload 提供的 `mock.module` 桩：把 cwd 换到仓库外仍能全绿（本轮实测 `cd /tmp && env -u ANTHROPIC_MODEL bun test <绝对路径>/src/__tests__/knowledge-base-repository.test.ts <绝对路径>/web/__tests__/knowledge-i18n.test.ts` → 9 pass / 0 fail），说明本包用例的装配面只有 `@fenix/platform-sdk/testing`。
- **上传落盘**：`data/knowledge-upload`（相对运行目录），随实例本地目录，不跨机器共享。

## 边界外的已知项

- **宿主调用点已接线（共享文件，本轮实测）**：`apps/server/src/main.ts:62` 已改为 `import { checkRagFlowHealth, createApiKnowledgeBaseRoutes }`（实例 `.use(...)` 在 `:476`），`apps/server/src/routes/web/index.ts:9` 已改为 `createWebKnowledgeBaseRoutes`（构造在 `:50`）；`moduleConfigs.knowledge` 在 `main.ts:171/187` 注入（`ragflowApiUrl` / `ragflowApiKey` / `ragflowRequestTimeoutMs` / `gotenbergUrl`），启动期探活在 `main.ts:383`。上一版 README 记的「旧导出名导入会直接失败」已消解。
- **`GOTENBERG_URL` 需要 env schema 声明**：见「配置与 DB」。收敛后该变量与 RAGFlow 三项一起进入宿主 env → 模块配置链（§1.7）。
- **i18n 宿主接线已完成（共享文件，本轮实测）**：宿主 `apps/web/src/i18n/index.ts:15` 已改经包出口登记——`import { KNOWLEDGE_NS, knowledgeResources } from "@fenix/resource-knowledge/web/i18n"`，注册点在 `:122` / `:136`。字典仍只有一份：`web/i18n/locales/{en,zh}/knowledge.json`。键归属实测：`en`/`zh` 各 56 顶层 / 247 叶子键、键集一致（补 `accessDenied.*` 与 error/retry 收口的 `loadFailure.*` 后重新计数），`observer` 字典里没有本包键，故无 movedIn / movedOut。
- **web 面宿主 alias（§1.6 T11e 后）**：宿主 `apps/web/src/routes/agent/_panel/knowledge-bases.tsx` 已直连 `@fenix/resource-knowledge/web` 取 `AgentKnowledgeBasesPage`，`apps/web/vite.config.ts` 中指向 `web/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` 的 alias 已无消费方；`@/src/types/knowledge`、`@/src/pages/agent-panel/components/knowledge-graph-state`、`@/src/api/knowledge-bases` 三条 alias 本轮实测全仓零消费方（属既有死条目）。跨包消费方（`agent-config`、`model-management`）本就走本包 `./web` 出口，故别名表删除后本包 web 出口是唯一公开面。**删除已随 §1.6 T11e-4b 执行**：上述三条 alias（连带其余全部桥接条目）已从宿主两份别名表移除，2026-09-21 实测 `git grep -n '"@/src/types/knowledge"'`、`"@/src/pages/agent-panel/components/knowledge-graph-state"`、`"@/src/api/knowledge-bases"` 均 0 命中；宿主别名表现在只保留宿主自有别名。
- **表定义仍在宿主**：`knowledgeBase` / `knowledgeResource` / `agentKnowledgeBinding` 定义在 `apps/server/src/db/schema.ts`，迁出归 §1.7。
- **「全局 KB」短路未收敛**：`knowledge-runtime.ts` 保留 `isGlobal = true` 与 `|| true` 的组织过滤短路（历史行为），跨组织可见性未经 `@fenix/access-control` 判定；属 §1.4 授权收敛范围，本任务只做边界切断。
- **`resource → @fenix/identity` 已消除**：见「依赖边界」（§1.6 T7 改经 `@fenix/web-runtime` 的 org/session 契约，台账条目已删除）。上一版 README 记的「machine 改名中间态留下 17 处无法解析导入、门禁结论不可信」本轮实测已不成立：脚本扫描 `packages/resources/machine/src/**/*.ts`（85 个文件）相对导入解析失败 0 处，`machine/web` 仅 1 处（`web/__tests__/machine-browser-surface.test.ts -> ./api/registry`，在该包自己的用例内）。本包 `src`（43 文件）与 `web`（20 文件）各 0 处。门禁本身的结论需由编排者复跑 `bun run check:dependencies` 确认，本包只给静态扫描结果。
- **包内 lint 已清零（W2.5 修复）**：上一版 README 列的 8 条 error（`web/components/knowledge/ResourcePreviewContent.tsx` ×5、`web/src/pages/agent-panel/components/ChunkDetailSheet.tsx` ×2、`web/src/pages/agent-panel/components/RetrievalTestPanel.tsx` ×1）本轮全部处置，`./node_modules/.bin/biome check packages/resources/knowledge`（W2.5 时 69 个文件，本轮新增两个文件后为 71 个文件）0 error / 0 warning。处置口径与一处**刻意偏离**见下节。

## W2.5 处置与刻意偏离（2026-09-20）

- **`@antv/g6` 改惰性加载**：`web/pages/agent-panel/KnowledgeGraphPanel.tsx` 原先静态 `import { Graph } from "@antv/g6"`——`g6 → @antv/g → html2canvas` 在导入期读 `window.document.createElement`，在无 DOM 的 bun 环境下一加载 `@fenix/resource-knowledge/web` 即崩，连带消费方（`model-management`、`agent-config`）的用例 0 断言。现改为 `const { Graph } = await import("@antv/g6")`，并以 `renderTokenRef` 取消令牌丢弃过期结果（`await` 期间组件卸载或资源已切换时不建图）。新增静态守卫「本包 web 源码不得静态导入 g6」，已负向验证（临时插入静态导入即红）。
- **8 条 lint 全清零**：3 处 `noDangerouslySetInnerHtml`（RAGFlow 切片内容 / 检索高亮 HTML / mammoth docx 输出）都在同一行加 `DOMPurify.sanitize` 后配行级 `biome-ignore` 写明依据（`dompurify` 已在依赖里，默认白名单保留 `<em>` / `<span class>` 高亮与 data: URI 图片）；3 处 `noArrayIndexKey` 保留位置键并写明理由（表格整表重绘、位置即语义，空白行/空白单元格无唯一标识，内容派生键会撞键），与仓库内兄弟包骨架屏的同款取舍一致。
- **刻意偏离（缺陷清单要求删 `resource.id` 依赖，本包不删）**：`ResourcePreviewContent.tsx` 的 effect 依赖里 `resource.id` 不是多余项，而是「换了资源」的唯一重触发信号——ahooks `useRequest({ manual: true })` 的 `run` 身份稳定，两个同类型资源互换时 `needsFetch` / `needsOfficeCheck` 都不变。实测探针（happy-dom + react-dom，跑完即删）：依赖含 `resource.id` 时切资源重拉 `/file/r1` → `/file/r2`；去掉后只拉 `/file/r1`，预览停在上一个资源。故保留依赖 + 行级 ignore，与 `agent-config` 的 `SiteFrame` reloadKey 同款取舍。
- **消费方守卫收窄 + 注释漂移**：`web/__tests__/knowledge-browser-surface.test.ts` 的三个断言改为只统计本包 web 子图内的引用（`ownRefs`），修正被钉死的跨包路径（`model-management/web/index.ts`），并新增「不得静态导入 g6」用例——W2 快照里那 3 条失败即由此消解；跨包消费（`model-management/web` 反向引用本包）不再误判为违例。另修 `src/server/routes/web/knowledge-bases.ts:227` 的端点计数漂移（不再重复计数，实测 23 条）。
- **宿主 i18n 注册表在本轮切到包出口**：切换过程中宿主一度按 `packages/resources/{channel,observer,prod-view,task,workflow}/web/i18n/{en,zh}/*.json` 的旧布局导入（字典已迁到 `locales/`），任何加载宿主 i18n 注册表的用例都会在加载期抛 `Cannot find module`（本包 `web/src/__tests__/context-panel-ssr.test.tsx` 与 `model-management` 的 web 用例均被挡；该文件已于 CE 阶段 2 §1.6 T5d 删除——它断言的 `ContextPanel` 宿主从不渲染，见 `docs/design/ce-ee-refactoring/review/task-1.6-web-shell.md` §四.9）；宿主已改为经 `@fenix/<pkg>/web/i18n` 登记（本包见 `apps/web/src/i18n/index.ts:15`），本包用例随之恢复全绿（412 pass / 0 fail）。

## 前端状态补齐与死副本清理（2026-09-20，§1.3(6) 缺口修复）

口径来源：`docs/design/ce-ee-refactoring/ce-ee-refactoring-stage-2-plan.md` §1.3 第 36 条（浏览器入口需补齐 loading / empty / error / retry / 无权限 / 成功反馈 / 可访问性）。本轮只动 `web/**`，未改服务端与 schema。

- **删除死副本 `web/pages/agent-panel/agent-editor-knowledge.css`**：删除前复核（`grep -rn "agent-editor-knowledge" .` 排除 `node_modules`）全仓只有 `@fenix/resource-agent-config` 的 `AgentFormDialog.tsx:43` 一处 `import "./agent-editor-knowledge.css"`，且解析到它**自己**的 `web/pages/agent-panel/agent-editor/agent-editor-knowledge.css`；两份正文逐字相同（仅 agent-config 那份多一段归属说明注释），全部选择器都挂在 `.agent-editor-root` 下、22 个 `agent-knowledge-*` 类名的唯一消费方也是 agent-config 的知识库分区组件，故 knowledge 侧零消费者。删除后上面的 grep 只剩 agent-config 的两处命中（自身 import + 自身注释里的历史路径说明）。
- **新增无权限分支**：`web/pages/agent-panel/pages/agent-knowledge-access-denied.tsx` 提供 `isKnowledgeAccessDenied(error)` 与 `AgentKnowledgeAccessDenied`，页面在列表请求失败且错误码为 `UNAUTHORIZED` 时**整页接管**。判定按错误码而非 HTTP 状态：`request()` 的 `statusToCode` 已把 401/403 归一为 `UNAUTHORIZED`，前端拿不到原始状态码；`instanceof ApiError` 是主路径，另留结构判定（`code` 字段）兜底宿主重复打包 `@fenix/web-runtime` 导致 `instanceof` 跨实例失效的场景。**刻意不提供重试按钮**：无权限下重试不会改变结果，真正的动作是重新登录或联系组织管理员；这也是它与目录面板里「带重试的行内错误」分开成两个分支的原因（后者保留原样）。
- **补齐成功反馈**：更新知识库、删除知识库、删除资源三处原先静默完成（注释写明「静默操作，不弹 toast」），现各补一条 `toast.success`，复用字典里**已存在但无引用**的 `toast.updated` / `toast.deleted` / `toast.resourceDeleted`（不新增文案）。增删改其余路径原本已有成功反馈（创建、上传、重新解析、导入、图谱、嵌入模型管理）。
- **可访问性补齐**：`agent-knowledge-resources.tsx` 的预览 / 删除两个纯图标按钮只有 `title`，补 `aria-label`（与目录面板的删除按钮取同一写法）。`title` 保留用于悬浮提示。
- **守卫同步**：`web/__tests__/knowledge-browser-surface.test.ts` 的到达文件清单加 `pages/agent-panel/pages/agent-knowledge-access-denied.tsx`、`reachedWebFiles` 期望值 16 → 17（新文件经页面进入值导入图）；新增 `web/__tests__/knowledge-access-denied.test.tsx`（判定口径 + 跨实例兜底 + 「无按钮」渲染契约）。
- **本轮实测**：`env -u ANTHROPIC_MODEL bun test packages/resources/knowledge` → 416 pass / 0 fail（26 文件）；`bunx biome check packages/resources/knowledge` → 71 个文件 0 error / 0 warning；`bunx tsc -p apps/web/tsconfig.json --noEmit` → 0 error（本包页面经宿主路由的懒加载别名进入该 program）。字典 `accessDenied.title` / `accessDenied.description` 已同时加入 en / zh，键集仍一致。

### 同一口径下的残留：三条已全部闭环（2026-09-20，§1.3(6) error/retry 收口）

上一版在这里登记的三条「只弹 toast / 只 `console.error`、界面落回空态」本轮**全部闭环**，判据统一为一句话：
**`error && 无数据` 才让失败区整区接管（`role="alert"` + 连回原请求的重试按钮）；已有数据后的刷新失败保留旧数据，
只 toast 兜底**。401/403（`request()` 已归一为 `UNAUTHORIZED`）走既有 `isKnowledgeAccessDenied` / `AgentKnowledgeAccessDenied`
无权限态并**刻意不给重试按钮**，不新增第二套权限分支。三条共用同一个受控组件
`web/pages/agent-panel/pages/agent-knowledge-load-failure.tsx`（`KnowledgeLoadFailure`，实测 34-52 行为判定与渲染主体；
无权限在 `:38` 短路、一般失败在 `:41` 起为 `role="alert"`、重试按钮在 `:47-50`），保证判据、可访问性契约与
「无权限不给重试」逐字一致，而不是在三处各写一遍。

- **`AgentKnowledgeBasesPage.tsx` 表单选项（`kbApi.getFormOptions`）已闭环**：请求在 `:183-190`，`onError` 只留
  `console.error("Failed to load knowledge form options", err)`（诊断上下文留痕，不再静默降级）；失败判据在 `:194`
  `formOptionsError != null && options == null`；创建弹窗的解析配置区在 `:842-846` 整区接管为
  `KnowledgeLoadFailure` + `onRetry={refreshFormOptions}`，失败时 `form.configLockedAfterCreate` 等配置区文案必须让位
  （不是与错误态叠在一起）。上一版担心的「分块方法静态兜底会导致降级语义打架」经实测不成立：一旦选项请求失败，
  三个下拉本来就都是空的，整区接管比留下一个「没有可选模型」的空表单更诚实，也没有删掉任何静态兜底。
- **`ChunkDetailSheet.tsx:55-57` 切片列表已闭环**：`fetchChunks` 的 `catch` 在 `:61-65` 保留 `console.error` +
  toast（有旧数据时这是唯一可见反馈）；新增 `error` state 于 `:41-43`，失败判据在 `:212`
  `!loading && error != null && data == null` → `KnowledgeLoadFailure`（`:213-217`，`onRetry` 用当前
  `page` / `keyword` 重发原请求）；`chunk.empty` 空态在 `:221` 追加 `error == null` 前置条件，空态从此只表达
  「确实没有数据」。
- **`RetrievalTestPanel.tsx:150-166` 检索测试已闭环**：`search` 失败的两条分支（业务错误 `:161-166`、异常
  `:173-175`）都写入新增的 `error` state（`:88-90`）；结果区在 `:404-406` 整区接管为
  `KnowledgeLoadFailure` + `onRetry={runSearch}`；`retrieval.noResults` 的两处渲染入口（`:421`、`:435-437`）
  都加了 `error == null` 前置条件，失败不再冒充「没有命中」。
- **本轮实测（2026-09-20，命令均带 `env -u ANTHROPIC_MODEL`）**：
  `bun test packages/resources/knowledge` → **425 pass / 0 fail**（29 文件）；只跑上一轮已有的 27 个文件为
  417 pass / 0 fail，即本轮新增的 8 个用例全绿且未改动任何既有断言（这 27 个文件里含一个早前遗留的探针
  `web/__tests__/zz-probe-import.test.tsx`，它只断言页面可导入、无中文用例注释，正是上一版记的基线 416
  与本次 417 的那 1 个差额；本轮未删，待编排者确认后清理）。
  `bunx biome check packages/resources/knowledge` → 75 个文件 0 error / 0 warning。新增
  `web/__tests__/knowledge-panel-load-failure-states.test.tsx`（6 用例：切片面板首载失败 / 403 / 翻页失败三态 +
  检索面板失败 / 403 / 空结果三态）与 `web/__tests__/agent-knowledge-bases-page-states.test.tsx`（2 用例：
  选项失败整区接管并可重试、403 复用无权限态且无重试按钮）。守卫同步：`knowledge-browser-surface.test.ts`
  的到达清单加 `pages/agent-panel/pages/agent-knowledge-load-failure.tsx`、`reachedWebFiles` 期望值 17 → 18；
  `knowledge-i18n.test.ts` 与 `web/i18n/index.ts` 的实测计数刷新为 56 顶层 / 247 叶子键、字面量键 159。
- **两个新用例的 i18n 取用方式刻意偏离本批「mock `react-i18next`」的模板（有实测依据，不是随手换写法）**：
  它们改用真实 i18next 实例 + `I18nextProvider` 挂本包 en 字典。原因是 `mock.module("react-i18next")` 一旦注册
  就是**进程级且不可撤销**：实测（对照组，跑完即删）`mock.restore()` 之后加载的文件、以及再注册一次真实
  命名空间，拿到的仍是替身；替身只提供 `useTranslation` 时本包 `knowledge-access-denied.test.tsx` /
  `web/src/__tests__/context-panel-ssr.test.tsx` 在加载期抛 `SyntaxError: Export named 'I18nextProvider' not found`，
  补上真实导出后它们又会因 `t` 被换掉而断言失败（这两个文件用空字典断言 key 回显，必须拿到真实库；
  `context-panel-ssr.test.tsx` 已在 §1.6 T5d 随 `ContextPanel` 死代码链删除，现存的是 `knowledge-access-denied.test.tsx`）。
  真实实例的代价是 `resources` 形状必须是 `{ [语言]: { [命名空间]: 字典 } }`（少一层语言维度时 `t()` 静默回显 key，
  已在两个用例里写明），收益是断言直接取本包字典文案、不再需要逐字复刻的替身表。
- **仍未接同一组件的两处（同口径核对后不闭环，理由与移除条件在下面）**：
  - `web/components/knowledge/ResourcePreviewContent.tsx` 的预览内容拉取失败（`fetchError` 在 `:175`、
    内容分支 `:293` / `:304` / `:313`）已经有**持久错误占位**（`ErrorPlaceholder`，`:424-426`），不会落回空态，
    因此不属于本轮的「失败落回空态」缺口；它缺的只是「重试接回原请求」与 `role="alert"`，且预览区不是整个区域
    可以无条件接管的对象（office 分支还有 PDF/docx 多条降级路径）。移除条件：把 `ErrorPlaceholder` 换成
    `KnowledgeLoadFailure` 并接上 `run`/`refresh`，同时确认三条 office 降级路径的语义不被接管吃掉。
  - `web/src/pages/agent-panel/components/EmbeddingModelManager.tsx` 的模型列表 / 厂商列表失败仍是
    **只弹 toast**（`:68`、`:362`），未接持久错误态与重试。它同样在创建弹窗的渲染面上，但不在本轮委派点名的
    三处之内，且其文案仍是硬编码中文（未走 `t()`），改造会同时牵出 i18n 键补齐与新增断言，因此本轮只登记。
    移除条件：把这两处失败也换成 `KnowledgeLoadFailure`（重试接回原 `loadModels` / 厂商请求），并为其补
    `t()` 文案与渲染用例——届时可与上一条合并成一次「本包 web 失败态全量统一」的收口。
