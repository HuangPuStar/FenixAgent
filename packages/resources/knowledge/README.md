# @fenix/resource-knowledge

知识库、知识资源与 agent 知识库绑定的唯一 owner：服务端领域规则加 RAGFlow provider 适配，浏览器侧交付控制台页面与 API client。

## 职责

- **仓储**：`src/server/repositories/knowledge-base.ts` 是 `knowledgeBase` / `knowledgeResource` / `agentKnowledgeBinding` 的唯一数据访问点，导出 `knowledgeBaseRepo` / `knowledgeResourceRepo` / `agentKnowledgeBindingRepo` 三个单例。
- **知识库领域**：`src/server/services/knowledge-base.ts` 负责 slug 生成与唯一性校验、名称与 slug 的本地校验（在访问 DB 和 provider 之前拒绝）、状态推导（`upsertKnowledgeBaseStatusFromResources`）、删除前的绑定占用检查，以及创建表单选项（`listKnowledgeFormOptions`：嵌入模型 / 分块方法 / pipeline）。
- **Provider 抽象**：`knowledge-provider/types.ts` 定义 `KnowledgeProvider` 契约（dataset 创建与列举、检索、检索测试、`readResource`、知识图谱、模型目录），唯一实现是 `ragflow.ts` 的 `RagFlowKnowledgeProvider`（`mapRunStatus` 把 RAGFlow 的 run 字符串映射为 `pending/processing/ready/error`，`checkRagFlowHealth()` 供宿主启动期探活）；`registry.ts` 的 `getKnowledgeProvider()` 是惰性单例，`setKnowledgeProviderForTesting()` 是包内测试 seam。
- **资源入库**：`knowledge-upload.ts` 负责上传落盘、URL 导入、重新解析、状态刷新与删除，并按资源汇总回写知识库状态；上传与导入是幂等的（按 sourceName / remoteId 复用 pending 资源）。
- **Agent 绑定与检索**：`agent-knowledge.ts` 维护 binding 的读写与策略归一化（`searchFirst` / `maxResults` / `defaultNamespaces`）；`knowledge-runtime.ts` 按绑定知识库检索、读取单个资源、生成/读取/删除知识图谱并轮询进度，检索按 embedding model 分组（RAGFlow 要求同一请求的 dataset 同模型），远端失败只跳过该分组不整单失败。
- **HTTP 交付物**：`/web/knowledgeBases*`（CRUD、资源上传与文件/PDF 预览、chunk 管理与启停、检索测试、知识图谱，另有 action 风格的 `POST /web/knowledgeBases/models` 模型管理）与 `/api/knowledge-bases`（对外只读分页列表，`sessionAuth`）。宿主挂载点：`apps/server/src/routes/web/index.ts`（挂在 `/web` 前缀下）与 `apps/server/src/main.ts`。
- **浏览器交付物**：`web/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` 及目录/资源面板、`web/api/*`、`web/types/knowledge.ts`、`web/i18n/locales/{zh,en}/knowledge.json`（各 54 个顶层键）。
- **模块描述符**：`fenix.module.ts` 只声明 `id` / `kind` / `dependsOn` / `capabilities`，是 W1 建立的装配契约；组合根状态见「边界外的已知项」。

## 依赖边界

本包属 `resources` 类别，`dependsOn: []` 来自实测：

- `src/**` 的 workspace 值导入只有 `@fenix/platform-sdk`（`WebOkSchema` / `WebErrSchema`）与包内自引用 `@fenix/resource-knowledge/server`（`src/server/services/agent-knowledge.ts` 取仓储）；
- `@fenix/model-management` 只用于 web 侧（`AgentKnowledgeBasesPage.tsx` 引入 `EmbeddingModelManager`），web 贡献不进服务端装配顺序，故不成边；
- 反方向由消费方声明：`@fenix/resource-mcp`、`@fenix/resource-agent-config`、`@fenix/resource-workflow` 的 package.json 依赖本包，本包不反向依赖它们。

## 守卫由宿主注入

本包路由是 **default export 的 Elysia 实例**（`name` 分别为 `web-knowledge-bases` / `api-knowledge-bases`），直接 `.use(authGuardPlugin)`——守卫实现来自宿主 `@server/plugins/auth`，本包不导出、也不构造第二份认证实例。包内路由用例同样跑在宿主实现上：`setTestAuth` / `resetTestAuth` 注入上下文，再用 `route.handle(new Request(...))` 驱动，不做协议层替身。

与 sandbox 包的「工厂 + 守卫注入」形态尚未对齐：Elysia 的 macro / state 是实例作用域的，父实例无法向已构造的子实例回填，工厂化必须与守卫收敛同时进行（见下节）。

## 配置与 DB

- 不读 `process.env`：RAGFlow API key 经 `resolveRagflowApiKey()` 从宿主配置取值（`@server/config` 的 `config.ragflowApiKey`，未配置即抛错），`ragflow.ts` 也从同一处取上游地址；`envDefinitions` 与 preflight 收敛归 §1.7；
- DB 经 `@server/db` 与 `@server/db/schema`：只有 repository 取句柄与表对象，`routes/**` 与 `services/**` 不得直接访问；
- 上传文件落盘在 `data/knowledge-upload`（相对 `process.cwd()`），随实例本地目录，不跨机器共享。

## 边界外的已知项

- **无 `web/index.ts` 浏览器出口**：前端交付物靠宿主 `apps/web/vite.config.ts` 的显式 alias 映射（`@/src/api/knowledge-bases`、`@/src/pages/agent-panel/pages/AgentKnowledgeBasesPage` 等 10 个文件），包内 web 文件又反向 import 宿主别名（`@/components/ui`、`@/src/i18n`、`@/src/contexts/OrgContext` 等约 60 处）。归属 WebShell 切片（1.6）。
- **路由未工厂化**：仍是 default export + `.use(authGuardPlugin)`，与宿主的引用方式（1.5 宿主挂载）一起收敛，工厂化形态归 W2 切片。
- **无 `src/module.ts` 单例**：`fenix.module.ts` 不声明 `create`，provider registry 与三个仓储仍是模块级 `export const`；组合根归 W2 切片。
- **表定义仍导入 `@server/db/schema`**：`knowledgeBase` / `knowledgeResource` / `agentKnowledgeBinding` 定义在 `apps/server/src/db/schema.ts`，迁出归 §1.7。
- **包内自环**：`src/server.ts` ↔ `src/server/services/agent-knowledge.ts`（后者经包入口取仓储），台账登记为 `no-circular`（owner 1.5），组合面收敛时一并消除。
- **「全局 KB」短路未收敛**：`knowledge-runtime.ts` 保留 `isGlobal = true` 与 `|| true` 的组织过滤短路（历史行为），跨组织可见性未经 `@fenix/access-control` 判定。
