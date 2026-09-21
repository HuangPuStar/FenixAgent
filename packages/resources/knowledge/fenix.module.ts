import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

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
 * （生成器按包名跳过）。本包已无 `@fenix/model-management` 依赖：`EmbeddingModelManager` 连同它的
 * embedding 模型管理面已收归本包，原先那条 web 侧跨包引用随之消失（原本也因 web 贡献不进服务端装配
 * 顺序而不成边）。生成器的装配依赖反向校验（`assertDependsOnComplete`）
 * 会持续守着这一点：日后 `src/**` 真实值导入任一已注册资源模块，就必须在此处补声明。
 *
 * 不声明反向边：`@fenix/resource-mcp`、`@fenix/resource-agent-config`、`@fenix/resource-workflow` 的
 * workspace 依赖指向上游，方向必须由它们在各自 manifest 里写 `dependsOn: ["knowledge"]`。本包是资源装配
 * 图里的叶子，反向声明会与依赖矩阵和装配拓扑序冲突。
 *
 * 声明 `contributions`（1.5e）：`/web/knowledge-bases` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明挂宿主 `/web` 聚合面——
 * 路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create`
 * 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 不声明 `web` / `envDefinitions`：浏览器交付物由宿主 vite alias 映射（`apps/web/vite.config.ts`），其形状
 * 必须与 §1.6 消费端同时定型，单方面发明会留下第二套装配路径；env 收敛归 §1.7。
 *
 * `create` 指向 `src/module.ts` 的组合根（进程级仓储单例），并保持惰性：registry 会被大量位置导入，
 * 不能在索引层就把 Drizzle、Elysia 与知识库服务图拖进来。
 */
export const moduleManifest = {
  id: "knowledge",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.knowledge"],
  contributions: [
    {
      id: "knowledge.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createKnowledgeWebRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与知识库服务图拖进模块图。
  create: () => import("./src/module").then((module) => module.createKnowledgeModule()),
} satisfies ModuleManifest;
