import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Workflow 资源模块描述符。
 *
 * 工作流定义 / 版本 / 运行 / 触发的唯一 owner。装配面上的服务端交付物是五组 `/web/workflow-*` 路由
 * （defs、runs、engine action、SSE 事件流、custom-tools）、`/api/workflows/:workflowId/execute`、
 * `/workflow-ui` 静态代理与 Webhook 接收路由 `createHookRoutes`（`/hooks/:publicHash`，另见
 * `handleWebhookRequest`）；消费者是宿主 `apps/server`（`main.ts` 与 `routes/web/index.ts`）。
 *
 * `dependsOn: []`：本包服务端生产代码（`src/**`）没有任何对已注册 `resource` 模块的值导入，是叶子模块。
 * 现有跨包导入都属于「不构成装配依赖」的三类边，故不声明：
 * - `@fenix/agent-runtime/runtime`：`src/server/services/workflow/index.ts:14` 取运行 port 后调
 * `stopInstance` 清理 run 创建的实例、`workflow-events.ts` 经 `session.getEventBus` 取事件总线、
 * `agent-chat-transport.ts` 经 port 做实例启动/心跳/停止（1.4 W6b 前这三处都从 `./server` 取，
 * 观测面与总线归位后不再有装配面取数）。agent-runtime 是
 * 基础类别，在 assembly profile 里是固定槽位（`requireFoundation`），跨类别边由 §2.3 依赖矩阵负责；
 * - `@fenix/workflow-engine` 与 `@fenix/plugin-sdk`（后者在 `agent-chat-transport.ts:26` 仅 `import type`，
 * 编译期擦除）：两者都未注册为模块，写进 `dependsOn` 会被 registry 生成器以「引用了未注册模块」拒绝；
 * - `@fenix/chat-channel`（1.4 W6a 新增，`agent-chat-transport.ts` 取 `extractJsonRpc`）：同属未注册为
 * 模块的基础类别包，理由同上；本包私有 JSON-RPC 副本删除后，帧解析统一由该包协议层提供。
 *
 * 原先四类中的第四类（`@server/db/schema` 的宿主表定义）已随任务 1.7 B6（2026-09-22）消失：九张领域表
 * 迁入本包 `db/schema.ts` 后，`src/**` 生产代码对 `@server/**` **零命中**（机器证据是 `apps-boundary
 * @fenix/resource-workflow → @fenix/server-app` 台账条目被 `architecture:check` 的 stale 检测判为过期）。
 * 更早在本任务切片内切断的三条反向依赖仍是同一结论的成因：`@server/db` → `getWorkflowDatabase()`、
 * `@server/config` → `getModuleConfig("workflow")`、`@server/plugins/auth` → 路由工厂注入守卫。
 *
 * `create` 指向 `src/module.ts` 的组合根（返回包内既有进程级单例，不新建第二套 engine 缓存）；
 * 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Elysia、Drizzle 与 workflow-engine 拖进模块图。
 *
 * 声明 `contributions`（1.5e）：`/web/workflow-defs`、`-custom-tools`、`-engine`、`-sse`、`-runs` 五条路由
 * 实例由本模块以惰性构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web"` 指明
 * 挂宿主 `/web` 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性
 * import 与 `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。五条贡献的声明
 * 序就是挂载序（与迁移前宿主手写序列一致）。
 *
 * 1.5f 追加一条 `api` 槽贡献：`/api/workflows/:workflowId/execute`。1.5f-1b 再追加两条顶层 `app` 槽贡献：
 * `/workflow-ui/*` 静态代理（`createWorkflowStaticApp`，会话守卫面但与 `/web` 不同前缀）与
 * `/hooks/:publicHash` Webhook 接收（无认证——`publicHash` 即凭据）。三条 `app` 槽路由各自带独立前缀与
 * 认证口径，因此单列一槽而不是塞进 `/web` 或 `/api`（两条都在本模块声明序末尾）。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**——WebShell 生成器
 * 只对 manifest 做 AST 静态读取、不执行它，所以入口只能是「声明」而不是「推断」，取值必须是字符串字面量。
 * 它**不是**浏览器依赖：`lucide-react` / React 载荷只存在于 `@fenix/resource-workflow/web/contribution`
 * 导出的值里，不会沿 registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 *
 * `envDefinitions` 与 preflight 的收敛归任务 1.7，本文件只落 `envDefinitions` 这一半（路线 A，窄口径）。本模块只认领**有唯一 owner 的部署键**
 * 三枚——`WORKFLOW_TOOLS_DIR`（自定义节点工具目录，装配期经宿主投影为 `toolsDir`，启动时
 * `initCustomToolsRegistry()` 扫描注册 CustomNode）、`ACPX_G_URL`（`/workflow-ui` 静态代理的转发目标）与
 * **补齐声明**的 `RCS_WORKFLOW_HMAC_SECRET`（工作流引擎审批令牌的 HMAC 密钥）。三者的唯一运行期消费者都在本包
 * `src/server/config.ts` 的 `getWorkflowConfig()`，宿主只做「已校验 env → 模块配置」的投影（路线 A：本批只让
 * `envDefinitions` 承担启动期校验 + 汇总，值仍手工投影，不改模块 `config.ts` 的形态）。
 *
 * 前两键在宿主 `apps/server/src/env.ts` 有同名行，按 `apps/server/src/env-loader.ts` 的
 * `assertNoHostKeyOverride`，声明与从宿主 schema 删除**必须同批**（宿主与模块同名即启动期抛错）；本文件只负责
 * 声明这一半。第三键宿主从未登记（`bootstrap/module-configs.ts` 的 workflow 条目自述「宿主 env schema 尚未
 * 声明」），属 1.7 C2 点名的两枚补齐键之一，宿主侧只需新增投影、无需删除。
 *
 * 不迁的兄弟键 `RCS_BASE_URL`：模块配置的 `baseUrl` 虽由本模块消费，但该键被 identity / agent-runtime 等多个
 * 模块共享，按「键归唯一模块」的裁定属宿主 schema 保留项，本包不重复声明（两处声明会让同一契约的校验强度与
 * 默认值语义维护两份，而 `assertDefinitions` 只在逐字段完全一致时才放行）。
 *
 * `secret` / `restartRequired` 目前没有运行期消费者（`assertDefinitions` 只比较其跨模块一致性），按声明语义
 * 填写，供任务 1.8 的 preflight / readiness 消费。
 */
export const moduleManifest = {
  id: "workflow",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.workflow"],
  envDefinitions: [
    {
      moduleId: "workflow",
      key: "WORKFLOW_TOOLS_DIR",
      // 与宿主 apps/server/src/env.ts 的同名行逐字等价（z.string().default("./tools")），默认值照抄。
      schema: z.string().default("./tools"),
      defaultValue: "./tools",
      secret: false,
      restartRequired: true,
      description:
        "自定义节点（CustomNode）工具目录，宿主部署默认 ./tools。装配期由宿主投影为模块配置 toolsDir，启动时" +
        "initCustomToolsRegistry() 扫描该目录下的 .ts 文件并注册到 CustomNodeRegistry，/web/workflow-custom-tools" +
        "在请求时经 getWorkflowConfig() 读取同一份启动期快照。刻意不做空串归一（宿主行只有 .default()）：" +
        "显式给空串会原样落成 toolsDir 并被模块配置的 min(1) 拒绝，与宿主原行等价。",
    },
    {
      moduleId: "workflow",
      key: "ACPX_G_URL",
      // 与宿主 apps/server/src/env.ts 的同名行逐字等价（z.string().default("http://localhost:8848")）。
      schema: z.string().default("http://localhost:8848"),
      defaultValue: "http://localhost:8848",
      secret: false,
      restartRequired: true,
      description:
        "acpx-g 内部服务基址，/workflow-ui/* 静态代理的转发目标；宿主部署默认 http://localhost:8848。装配期由" +
        "宿主投影为模块配置 acpxGUrl，本包路由 workflow-proxy.ts 在每次请求时经 getWorkflowConfig() 现取。" +
        "空串按原样保留（宿主行未做空串归一），由模块配置的 min(1) 拒绝，与宿主原行等价。'现取'读到的是装配期" +
        "固化进模块配置的快照而非 process.env，改值仍须重启进程才生效，故 restartRequired 为 true（与同文件" +
        "WORKFLOW_TOOLS_DIR 口径一致）。",
    },
    {
      moduleId: "workflow",
      key: "RCS_WORKFLOW_HMAC_SECRET",
      // 补齐声明：宿主 apps/server/src/env.ts 从未登记该键（1.7 C2 点名的两枚补齐键之一），故无宿主行可照抄，
      // 形状与消费侧契约 src/server/config.ts 的 `hmacSecret: z.string().min(1).optional()` 一致。
      // 空串归一用 z.preprocess（先例见宿主 apps/server/src/env.ts 的 RCS_DEFAULT_MACHINE_ID 行）：docker-compose
      // 的 `${VAR:-}` 在 .env 未设置时透传空串而非 undefined，而迁移前的实现是
      // `process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID()`——`||` 把空串当未配置。不归一会让空串撞上
      // min(1) 变成**启动期拒绝启动**，是行为回归；归一后空串与未设置同路，都落成 undefined 再由包内 `??` 走随机密钥。
      schema: z.preprocess((v) => (v === "" ? undefined : v), z.string().min(1).optional()),
      secret: true,
      restartRequired: true,
      description:
        "工作流引擎审批令牌（approval token）的 HMAC 签名密钥。无默认值（省略 defaultValue，写死默认值会把" +
        "「未配置」从 undefined 改成固定字符串）；未配置或空串（经 z.preprocess 归一为 undefined）时本包在" +
        "getTeamEngine 内按进程随机生成（crypto.randomUUID()）——随机值只在单实例内自洽，多实例部署必须显式配置" +
        "同一密钥，否则跨实例恢复的 run 会签名校验失败。密钥材料，禁止进日志、响应与错误文案。",
    },
  ],
  web: {
    id: "workflow",
    contribution: "@fenix/resource-workflow/web/contribution",
  },
  contributions: [
    {
      id: "workflow.web-defs",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebDefsRoutes(host)),
    },
    {
      id: "workflow.web-custom-tools",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebCustomToolsRoutes(host)),
    },
    {
      id: "workflow.web-engine",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebEngineRoutes(host)),
    },
    {
      id: "workflow.web-sse",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebSseRoutes(host)),
    },
    {
      id: "workflow.web-runs",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowWebRunsRoutes(host)),
    },
    {
      id: "workflow.api",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowApiRoutes(host)),
    },
    {
      id: "workflow.app-static",
      kind: "app-route",
      slot: "app",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowStaticAppRoutes(host)),
    },
    {
      id: "workflow.app-hooks",
      kind: "app-route",
      slot: "app",
      // 工厂不消费 host：无认证是 Webhook 端点的协议语义，没有守卫可注入。
      value: () => import("./src/server/assembly").then((assembly) => assembly.createWorkflowHooksAppRoutes()),
    },
  ],
  create: () => import("./src/module").then((module) => module.createWorkflowModule()),
} satisfies ModuleManifest;
