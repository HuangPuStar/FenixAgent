import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

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
 * `db/schema.ts`（§1.7 B9 新增）是唯一的例外面：它按外键目标导入 `@fenix/agent-config/db` 与
 * `@fenix/identity/db` 的列对象，两者已写入 `package.json` 的 `dependencies`，但**不进** `dependsOn`——
 * 上述校验只扫 `src/**`，且表定义表达的是「列对象来自谁的迁移链」，不是运行期耦合（同口径：agent-config
 * 的 `dependsOn` 也未列 `machine` / `model-management`，尽管它的 schema 取了两者的列对象）。
 *
 * 不声明反向边：`@fenix/resource-mcp`、`@fenix/resource-agent-config`、`@fenix/resource-workflow` 的
 * workspace 依赖指向上游，方向必须由它们在各自 manifest 里写 `dependsOn: ["knowledge"]`。本包是资源装配
 * 图里的叶子，反向声明会与依赖矩阵和装配拓扑序冲突。
 *
 * 声明 `contributions`（1.5e）：`/web/knowledge-bases` 与 `/api/knowledge-bases` 的路由实例由本模块以惰性
 * 构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，`slot` 指明挂宿主哪一面——路由路径
 * 是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create` 同因：registry
 * 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。两条路由共用同一份会话守卫（`/api` 面同样接受
 * 会话 cookie 与 API Key，与 `/web` 无差别）。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**——WebShell 生成器
 * 只对 manifest 做 AST 静态读取、不执行它，所以入口只能是「声明」而不是「推断」，取值必须是字符串字面量；
 * 宿主 vite alias 继续把这些说明符映射到包内实现，不产生第二套装配路径。它**不是**浏览器依赖：
 * `lucide-react` / React 载荷只存在于 `@fenix/resource-knowledge/web/contribution` 导出的值里，不会沿
 * registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 *
 * 声明 `envDefinitions`（§1.7 路线 A）：RAGFlow 三键与 Gotenberg 地址合起来就是 `KnowledgeModuleConfig`
 * 的完整部署面（`src/server/config.ts` 只认这四个字段），宿主既不第二处读取、也没有别的模块消费，因此
 * 唯一 owner 是本模块——这三个宿主键（`RAGFLOW_API_URL` / `RAGFLOW_API_KEY` / `RAGFLOW_REQUEST_TIMEOUT_MS`）
 * 的宿主 `apps/server/src/env.ts` 同名行必须**同批**删除，否则 `assertNoHostKeyOverride` 会在启动期抛
 * 「同一变量只能有一个声明处」。没有留在宿主的兄弟键：本模块的部署面就是这四个，也不与多模块共享键
 * （`DATABASE_URL`、`RCS_REDIS_*` 一类）重叠。声明只承担启动期校验与汇总，值仍由宿主
 * `bootstrap/module-configs.ts` 手工投影成模块配置（路线 A 的窄口径：不引入通用拆分器、不改模块 config.ts 形态）。
 *
 * 键的 zod 形状**逐字转写**宿主 env schema 的原文，只在一处做有意的偏离：`RAGFLOW_API_URL` 与
 * `GOTENBERG_URL` 加 `z.preprocess` 归一空串。宿主的 `z.string().default(...)` 只对 `undefined` 生效，而
 * 迁移前这两个键的取值实现是 `apps/server/src/config.ts` 的 `process.env.X || "<默认>"`——`||` 把空串当
 * 未设置。照抄 `.default(...)` 会让 `RAGFLOW_API_URL=` 从「回退默认地址」变成「空字符串」，`GOTENBERG_URL=`
 * 更会撞上模块配置的 `z.string().min(1)` 而拒绝启动，属真实行为回归。归一手法与宿主同名先例
 * `RCS_DEFAULT_MACHINE_ID`（`apps/server/src/env.ts`）一致：docker-compose 的 `${VAR:-}` 在 .env 未设置时
 * 透传的是空串而非 undefined。`RAGFLOW_API_KEY` 的 `.default("")` 保持原样：空串是「未配置 RAGFlow」这一
 * 真实部署状态的表达，`resolveRagflowApiKey()` 靠它快速失败，不得收紧成必填（`.env.example` 即为空）。
 * `GOTENBERG_URL` 是**补齐**而非迁移：宿主 env schema 从未声明它，默认值取自迁移前的宿主直读实现。
 * 四个键都在装配期被读一次并固化进模块配置（请求期不再读 env），故 `restartRequired: true`；只有
 * `RAGFLOW_API_KEY` 是密钥材料，`secret: true`（禁止进日志、响应与错误文案）。
 *
 * 声明 `dependencyServices`（A3）：两个依赖服务都指向 `docker/ragflow/docker-compose.yml`，因此都取
 * `orchestration: "separate"` 并只留入口指针。`separate` 的判据是「编排入口在 `composeFile`、本声明不重复
 * 定义它的服务」，不是「编排是否属于第三方」：Gotenberg 并入 RAGFlow 栈后，它的镜像与宿主端口只在那一份
 * compose 里定义一次；此处若继续沿用 `"compose-overlay"`，按契约就必须再声明 `image` / `ports`，同一容器
 * 于是有了两份真相（registry 层也把 `image` / `ports` 与 `composeFile` 判为互斥）。两者共用同一份编排与
 * 同一个开关 `FENIX_FEATURE_RAGFLOW`——Gotenberg 原先的独立目录 `docker/gotenberg/` 与
 * `FENIX_FEATURE_GOTENBERG` 已退役，部署面不再有它的独立开关；但 ID 仍是 `gotenberg`（它仍是独立服务、
 * 有独立探针），合并按 ID 做，与 RAGFlow 的声明互不覆盖。
 *
 * 地址口径：容器形态（RCS 在 `fenix-server` 内）走共享网络的服务名 `http://ragflow:9380` 与
 * `http://gotenberg:3000`；宿主回环端口只服务源码运行（`bun run dev`），`GOTENBERG_URL` 的默认值
 * `http://127.0.0.1:3200` 就是后者，与 compose 里发布的回环端口刻意对齐，避免编排与模块默认地址互相打架。
 * 两者 `required: false`：缺失只降级能力（检索不可用、Office 转换回退 LibreOffice CLI），不阻断主服务启动。
 *
 * `create` 指向 `src/module.ts` 的组合根（进程级仓储单例），并保持惰性：registry 会被大量位置导入，
 * 不能在索引层就把 Drizzle、Elysia 与知识库服务图拖进来。
 */
export const moduleManifest = {
  id: "knowledge",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.knowledge"],
  web: {
    id: "knowledge",
    contribution: "@fenix/resource-knowledge/web/contribution",
  },
  contributions: [
    {
      id: "knowledge.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createKnowledgeWebRoutes(host)),
    },
    {
      id: "knowledge.api",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createKnowledgeApiRoutes(host)),
    },
  ],
  // 形状逐字对齐宿主 apps/server/src/env.ts 的同名行；GOTENBERG_URL 的默认值取自迁移前的宿主直读实现。
  envDefinitions: [
    {
      moduleId: "knowledge",
      key: "RAGFLOW_API_URL",
      schema: z.preprocess((value) => (value === "" ? undefined : value), z.string().default("http://localhost:9380")),
      defaultValue: "http://localhost:9380",
      secret: false,
      restartRequired: true,
      description:
        "RAGFlow 检索服务的 API 基址（如 http://localhost:9380）。装配期由宿主投影为模块配置 ragflowApiUrl。" +
        "未设置或为空串时取默认值——空串归一为 undefined，保持迁移前 `process.env.RAGFLOW_API_URL || 默认值` 的" +
        "语义（.env 未设置时 docker-compose 的 :- 缺省语法会透传空串而非 undefined）。",
    },
    {
      moduleId: "knowledge",
      key: "RAGFLOW_API_KEY",
      schema: z.string().default(""),
      defaultValue: "",
      secret: true,
      restartRequired: true,
      description:
        "RAGFlow API key。装配期由宿主投影为模块配置 ragflowApiKey。空串是合法值，表达「未配置 RAGFlow」，" +
        "由 resolveRagflowApiKey() 快速失败，不得收紧成必填。密钥材料，禁止进日志、响应与错误文案。",
    },
    {
      moduleId: "knowledge",
      key: "RAGFLOW_REQUEST_TIMEOUT_MS",
      schema: z.coerce.number().int().positive().default(30000),
      defaultValue: 30000,
      secret: false,
      restartRequired: true,
      description:
        "RAGFlow 单次 HTTP 请求超时（毫秒，正整数）。装配期由宿主投影为模块配置 ragflowRequestTimeoutMs。" +
        "字符串数字经 z.coerce 归一；非正整数在启动期即被拒绝。",
    },
    {
      moduleId: "knowledge",
      key: "GOTENBERG_URL",
      schema: z.preprocess(
        (value) => (value === "" ? undefined : value),
        z.string().min(1).default("http://127.0.0.1:3200"),
      ),
      defaultValue: "http://127.0.0.1:3200",
      secret: false,
      restartRequired: true,
      description:
        "Gotenberg（Office 转 PDF）服务基址，装配期由宿主投影为模块配置 gotenbergUrl；不可用时调用方回退" +
        " LibreOffice CLI。此处为补齐声明：默认值取自迁移前宿主直读实现（http://127.0.0.1:3200）。空串归一为" +
        " undefined 而非原样保留——模块配置对 gotenbergUrl 有 `.min(1)` 约束，原样透传空串会让服务在首次请求期" +
        "报错，而迁移前的 `process.env.GOTENBERG_URL || 默认值` 是回退默认地址。默认值只服务源码运行：服务并入" +
        " docker/ragflow/docker-compose.yml 后发布的是宿主回环端口 3200，容器形态必须显式改成共享网络内的" +
        " `http://gotenberg:3000`（端口口径与理由见该目录 README）。",
    },
  ],
  // 两个依赖服务都是可选的：缺失时知识库只损失对应能力（RAGFlow 给不了检索、Gotenberg 转不了 Office），
  // 主服务仍必须能起来——与 `host-startup.ts` 对 `checkRagFlowHealth()` 的实测语义一致（失败只告警）。
  // 探针锚定上面已声明的地址键，因此插件的部署前自检不会读到不存在的键。
  dependencyServices: [
    {
      id: "ragflow",
      required: false,
      orchestration: "separate",
      envKeys: ["RAGFLOW_API_URL", "RAGFLOW_API_KEY"],
      composeFile: "docker/ragflow/docker-compose.yml",
      // 与 `checkRagFlowHealth()` 同一个端点：启动期探活与部署前自检必须看同一处，否则会出现
      // 「自检通过、启动告警」的分裂口径。
      healthCheck: { kind: "http", addressKey: "RAGFLOW_API_URL", path: "/api/v1/system/healthz" },
      description:
        "RAGFlow 检索服务。编排在 docker/ragflow/docker-compose.yml（多容器栈），本仓不重复定义；" +
        "未部署时知识库检索不可用，Agent 知识库绑定链路快速失败。",
    },
    {
      id: "gotenberg",
      required: false,
      orchestration: "separate",
      envKeys: ["GOTENBERG_URL"],
      // 与 ragflow 同一份编排：服务定义、镜像与宿主端口都在那里，本声明只留入口指针。
      composeFile: "docker/ragflow/docker-compose.yml",
      healthCheck: { kind: "http", addressKey: "GOTENBERG_URL", path: "/health" },
      description:
        "Gotenberg（Office 转 PDF）。编排在 docker/ragflow/docker-compose.yml（与 RAGFlow 同一 compose 项目、" +
        "随开关 FENIX_FEATURE_RAGFLOW 一起启停），本仓不重复定义；容器形态按 http://gotenberg:3000 访问。" +
        "未部署时调用方回退 LibreOffice CLI，只在宿主没装 LibreOffice 的镜像里才真正不可用。",
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与知识库服务图拖进模块图。
  create: () => import("./src/module").then((module) => module.createKnowledgeModule()),
} satisfies ModuleManifest;
