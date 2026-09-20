import type { ModuleManifest } from "@fenix/platform-sdk";

/**
 * Knowledge 资源模块描述符。
 *
 * 知识库、知识资源与 agent 知识库绑定的唯一 owner：服务端交付三张表的领域规则与仓储
 * （`src/server/services/knowledge-base.ts`、`src/server/services/knowledge-upload.ts`、
 * `src/server/repositories/knowledge-base.ts`）与 RAGFlow provider 适配
 * （`src/server/services/knowledge-provider/`），HTTP 面是 `/web/knowledgeBases*` 与
 * `/api/knowledge-bases`。装配面上的消费者是宿主 `apps/server`（挂载两条路由、启动期调用
 * `checkRagFlowHealth()`、从 env 构造 RAGFlow 配置）与 `@fenix/agent-runtime`（Agent 运行时按绑定检索
 * 与读取资源）。
 *
 * `dependsOn: []` 是实测结论，不是省略：本包 `src/**` 的 workspace 值导入只有三类，都不构成资源模块装配
 * 依赖——`src/server/routes/web/knowledge-bases.ts` 与 `src/server/schemas/knowledge.schema.ts` 从
 * `@fenix/platform-sdk` 取响应信封 schema（基础模块是 profile 固定槽位，非 `resource` 类别）；
 * `src/server/services/agent-knowledge.ts` 引用的 `@fenix/resource-knowledge/server` 是包内自引用
 * （生成器按包名跳过）。`@fenix/model-management` 只出现在 web 侧
 * （`web/pages/agent-panel/pages/AgentKnowledgeBasesPage.tsx` 引入 `EmbeddingModelManager`），而 web
 * 贡献不进服务端装配顺序，因此不产生装配边。生成器的装配依赖反向校验（`assertDependsOnComplete`）
 * 会持续守着这一点：日后 `src/**` 真实值导入任一已注册资源模块，就必须在此处补声明。
 *
 * 不声明反向边：`@fenix/resource-mcp`、`@fenix/resource-agent-config`、`@fenix/resource-workflow` 的
 * workspace 依赖指向上游，方向必须由它们在各自 manifest 里写 `dependsOn: ["knowledge"]`。本包是资源装配
 * 图里的叶子，反向声明会与依赖矩阵和装配拓扑序冲突。
 *
 * 不声明 `contributions` / `web` / `envDefinitions` / `create`：宿主当前按显式调用装配（路由 default
 * export 直接 `.use` 宿主守卫），浏览器交付物由宿主 vite alias 映射（`apps/web/vite.config.ts`）；
 * 它们的形状必须与消费端同时定型，单方面发明会留下第二套装配路径。`create` 对应的组合根
 * （`src/module.ts` 单例）属 W2 切片。
 */
export const moduleManifest = {
  id: "knowledge",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.knowledge"],
} satisfies ModuleManifest;
