import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Workflow V2 资源模块描述符（上游工作流引擎 画布桥接）。
 *
 * 与自研 workflow 引擎并存的第二个工作流模块：控制台经 iframe 嵌入上游工作流引擎 画布，画布请求经
 * `/workflow-canvas/bff/*` 透传给 workflow-v2，由本模块以**平台身份**转接上游后端。领域规则、持久化与
 * HTTP 交付物都在本包服务端：控制台面 `/web/workflow-v2/*`、对外触发面 `/api/workflow-v2/*`、画布透传面
 * `/workflow-canvas/bff/*`、画布静态反代 `/workflow-canvas/*`。契约见
 * `docs/design/2026-09-29-workflow-v2-interface-freeze.md`（下称冻结）。
 *
 * `dependsOn: []`（叶子模块）：本包服务端生产代码只值导入未注册的基础包（`@fenix/platform-sdk`、
 * `@fenix/logger`）与第三方库，没有任何指向已注册 `resource` 模块的值导入；跨包只允许 `import type`。
 * `db/schema.ts` 不导入任何对端表对象（四张表无跨包外键），因此没有 §6.1 的组装期例外要申报。
 *
 * 四条 `app-route` 贡献的声明序即挂载序（冻结 §2.1）：`bff/` 必须先于静态反代出现在路由表里——静态面
 * 是通配路由，挂载靠后才不会吞掉 `/workflow-canvas/bff/*`。`web` 与 `api` 两个槽注入会话守卫（分别由宿主的
 * `/web`、`/api` 聚合实例挂载）：对外触发面用控制台 API Key 认证，解析链与面板会话同源，因此守卫是同一份
 * 实例；两条 `app` 槽贡献不带认证守卫：`bff` 的凭据是请求头票据（冻结 §6），静态资源是同源 iframe 的公开
 * 资产。惰性 `import()` 与 `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * `envDefinitions`：冻结 §2.2 的九枚键（上游基址、画布基址、账号邮箱/密码、票据密钥、code/票据 TTL、
 * 上游超时、节点白名单、对账周期、三枚限流）。两枚默认值与上游服务同机（`http://127.0.0.1:18080`），
 * 三枚必填（账号邮箱/密码、票据签名密钥），其余为带默认值的旋钮。
 *
 * 历史：2026-10-09 曾为「运行日志执行列表」临时增加五枚上游库只读连接键
 * （`WORKFLOW_V2_UPSTREAM_DB_*`）；上游于同日（commit `3a028cf1`）实现 `list_spans` 后按 ADR
 * `2026-10-09-workflow-v2-upstream-db-read.md` 的移除条件整体删除，运行列表已切回 HTTP。这些键的唯一运行期消费者是本包
 * `src/server/config.ts` 的 `getWorkflowV2Config()`，宿主经 `module-configs.ts` 投影（路线 A，与 workflow
 * 模块同形）；宿主 `apps/server/src/env.ts` 不得重复声明（同名即启动期失败，见 `env-loader.ts` 的
 * `assertNoHostKeyOverride`）。`secret` / `restartRequired` 按声明语义填写，供 preflight / readiness 消费。
 *
 * `create` 指向 `src/module.ts` 的组合根，返回包内既有单例（上游会话在进程内唯一，重复构造等于开两条
 * 登录/重登路径）。
 *
 * web 贡献块（id `"workflow"`、contribution `"@fenix/resource-workflow-v2/web/contribution"`）于 2F 批次与旧包
 * `packages/resources/workflow` 的前端删除同批启用（2026-09-29）：两个 manifest 若同时声明 `web.id` 为
 * `"workflow"`，`generate:web-contributions` 会以「Web 模块 ID 重复」当场失败。id 沿用旧包取值而非
 * `"workflow-v2"`：它是导航项的**路由目标**（Shell 拼成 `/agent/workflow`），改名会同时改掉侧栏入口与用户
 * 的书签；服务端模块 id（`"workflow-v2"`）与 web id 是两个独立的命名空间，不需要一致。
 */
export const moduleManifest = {
  id: "workflow-v2",
  kind: "resource",
  capabilities: ["resource.workflow-v2"],
  dependsOn: [],
  envDefinitions: [
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_UPSTREAM_BASE_URL",
      schema: z.string().default("http://127.0.0.1:18080"),
      defaultValue: "http://127.0.0.1:18080",
      secret: false,
      restartRequired: true,
      description:
        "上游工作流引擎上游服务基址，workflow-v2 调用 `/api/workflow_api/*` 与 passport 登录的目标；默认 " +
        "http://127.0.0.1:18080，与同机部署的上游服务一致。装配期由宿主投影固化进模块配置，" +
        "请求期不再读 env，改值需重启进程。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_CANVAS_UPSTREAM_URL",
      schema: z.string().default("http://127.0.0.1:18080"),
      defaultValue: "http://127.0.0.1:18080",
      secret: false,
      restartRequired: true,
      description:
        "`/workflow-canvas/*` 静态反代的上游基址（上游自带前端的静态资源）；默认 http://127.0.0.1:18080。" +
        "与 `WORKFLOW_V2_UPSTREAM_BASE_URL` 分开声明，供静态资源与 API 分别指向不同入口时独立配置；装配期固化 " +
        "进模块配置，改值需重启进程。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_PLATFORM_ACCOUNT_EMAIL",
      // 必填：无 defaultValue，缺失即启动失败（`loadDeclaredEnv` 用同一 schema 校验）。
      schema: z.string().min(1),
      secret: false,
      restartRequired: true,
      description:
        "平台上游账号的登录邮箱（FenixAgent 整体映射上游一个用户，设计 §3.1）：账号不存在时，首次引导" +
        "（如第一个租户建 App）会用它与 `WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD` 向上游自助注册，因此不必先人工建号" +
        "（注册幂等，邮箱已存在则跳过）。无默认值，缺失即启动失败；不属于密钥材料，但仍不得出现在面向用户的" +
        "响应与错误文案里。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_PLATFORM_ACCOUNT_PASSWORD",
      schema: z.string().min(1),
      secret: true,
      restartRequired: true,
      description:
        "平台上游账号的登录密码（passport 邮箱登录用）；账号不存在时，首次引导会以它作为新账号的密码完成" +
        "自助注册。无默认值，缺失即启动失败；密钥材料，禁止进日志、响应与错误文案。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_TICKET_SECRET",
      schema: z.string().min(1),
      secret: true,
      restartRequired: true,
      description:
        "画布 iframe 票据（HMAC-SHA256）的签名密钥；无默认值，缺失即启动失败。密钥材料，禁止进日志与" +
        "响应。多副本部署必须配置同一个值，否则票据跨副本校验失败。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_IFRAME_CODE_TTL_SECONDS",
      schema: z.coerce.number().int().positive().default(60),
      defaultValue: 60,
      secret: false,
      restartRequired: true,
      description:
        "iframe 一次性 code 的有效期（秒）；默认 60。code 绑定 user + org + workflow 且单次消费，超时即" +
        "作废（冻结 §7）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_IFRAME_TICKET_TTL_SECONDS",
      schema: z.coerce.number().int().positive().default(900),
      defaultValue: 900,
      secret: false,
      restartRequired: true,
      description:
        "画布票据的有效期（秒）；默认 900（15 分钟）。`/session/refresh` 只能续到「原过期时间」与「不超过" +
        " 15 分钟」的较小者（冻结 §7）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_UPSTREAM_TIMEOUT_MS",
      schema: z.coerce.number().int().positive().default(10000),
      defaultValue: 10000,
      secret: false,
      restartRequired: true,
      description:
        "单次上游调用的超时（毫秒）；默认 10000。只读接口在该超时上叠加退避重试预算，写接口不自动" +
        "重试（设计 §4.7）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_NODE_WHITELIST",
      // 默认值取自冻结 §5 的**节点许可集**；消费方 `node-scope.ts` 是 fail-closed：只有命中它才放行，
      // 未命中的（含上游新增的未知类型）一律滤除。`4`（Api，插件节点）刻意不在默认值内，`45` 才是 HTTP。
      schema: z.string().default("1,2,3,5,8,11,13,15,18,20,30,31,45,58"),
      defaultValue: "1,2,3,5,8,11,13,15,18,20,30,31,45,58",
      secret: false,
      restartRequired: true,
      description:
        "节点许可集（逗号分隔的数字节点类型）；默认见设计 §5。配置**整体替换**许可集，可放宽也可收窄；" +
        "节点类型一律以数字字符串书写，名称形式（`start`）会被忽略，全部忽略时回退默认集。" +
        "`node-scope` 对 `node_type` / `node_template_list` / `node_panel_search` 的响应按它过滤，" +
        "客户端无法绕过（权威过滤在服务端）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_RECONCILE_INTERVAL_SECONDS",
      // 0 是合法取值（禁用对账），故用 nonnegative。
      schema: z.coerce.number().int().nonnegative().default(300),
      defaultValue: 300,
      secret: false,
      restartRequired: true,
      description:
        "对账任务的运行周期（秒）；默认 300，`0` 表示禁用。任务在模块装配时启动（随模块清理停止），" +
        "每轮收敛 `pending_delete` 的待删对象、补写本地缺失的归属行并清理创建补偿留下的孤儿（任务清单 4A）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_BFF_RATE_LIMIT_PER_MINUTE",
      schema: z.coerce.number().int().positive().default(1200),
      defaultValue: 1200,
      secret: false,
      restartRequired: true,
      description:
        "画布透传面（`/workflow-canvas/bff/*`）的令牌桶容量与每分钟补充量，按票据 `sub` 计数；默认 1200" +
        "（≈20 rps）。画布的调试运行以 300ms 间隔轮询 `get_process`（≈3.3 rps），默认值留了足够余量；" +
        "调低会让高频轮询收到 429（画布侧只在 401 换票，429 是普通失败）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_SESSION_RATE_LIMIT_PER_MINUTE",
      schema: z.coerce.number().int().positive().default(60),
      defaultValue: 60,
      secret: false,
      restartRequired: true,
      description:
        "票据端点（`session/exchange` / `session/refresh` / `session/revoke`）的令牌桶容量与每分钟补充量；" +
        "默认 60。带票据的请求按 `sub` 计数，兑换与无有效票据的请求按来源地址计数（兑换还没有票据可用）。",
    },
    {
      moduleId: "workflow-v2",
      key: "WORKFLOW_V2_API_RATE_LIMIT_PER_MINUTE",
      schema: z.coerce.number().int().positive().default(60),
      defaultValue: 60,
      secret: false,
      restartRequired: true,
      description:
        "对外触发面（`POST /api/workflow-v2/workflows/:id/run`）的令牌桶容量与每分钟补充量，按**调用方身份**" +
        "（API Key 恢复出的用户）计数；默认 60。外部系统重试会产生多次真实运行（上游没有幂等键），因此这里的" +
        "阈值是成本闸门而不只是保护阈值——调高前先确认上游配额与自身成本承受度。",
    },
  ],
  web: {
    id: "workflow",
    contribution: "@fenix/resource-workflow-v2/web/contribution",
  },
  contributions: [
    {
      id: "workflow-v2.web-control",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowV2WebRoutes(host)),
    },
    {
      id: "workflow-v2.external-api",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowV2ExternalApiRoutes(host)),
    },
    {
      id: "workflow-v2.canvas-bff",
      kind: "app-route",
      slot: "app",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowV2CanvasBffRoutes(host)),
    },
    {
      id: "workflow-v2.canvas-static",
      kind: "app-route",
      slot: "app",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createWorkflowV2CanvasStaticRoutes(host)),
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createWorkflowV2Module(context)),
} satisfies ModuleManifest;
