import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Sandbox 资源模块描述符。
 *
 * 沙盒资源池、沙盒实例生命周期与远程 Sandbox Cluster 管理协议的唯一 owner。装配面上的消费者是
 * 宿主 `apps/server`（装配期注册 provider、初始化默认池、挂载 `/web/config/sandbox-pools` 与
 * `/api/system/sandbox-*`）与 `@fenix/agent-runtime`（按 pool 解析可执行实例）。
 *
 * `dependsOn: ["machine"]`：本模块生产代码静态导入 `@fenix/resource-machine/server` 的公开入口（创建沙盒
 * 机器、机器在线判定、释放机器 runtime、机器归属查询），两者必须成套启用，方向与 §2.3 依赖矩阵一致。
 * machine 侧的既有反向边（machine → sandbox）已由架构台账登记为 `special-dependency`（owner 1.4，须
 * 消除），因此它不声明本模块，声明也不会构成装配循环；生成器的装配依赖反向校验（`assertDependsOnComplete`）
 * 会持续守着这一点。
 *
 * 声明 `contributions`（1.5e）：`/web/config/sandbox-pools` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot: "web-config"` 指明挂宿主 `/web/config`
 * 聚合面——路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与
 * `create` 同因：registry 会被大量位置导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 1.5f 追加三条 `api` 槽贡献（`/api/system/sandbox-pools`、`-instances`、`-cluster`、`-server` 四组路由由
 * 三个工厂给出）：它们改用系统 API 守卫，与 `/web` 面的会话守卫不是同一份实例，装配面上各自收窄一次。
 *
 * 声明 `envDefinitions`（1.7 C 块，路线 A）：这 13 个 `RCS_*` 部署变量的**唯一 owner 就是本模块**——
 * 逐键核查过全仓消费点，除宿主装配层（`apps/server/src/env.ts` 声明、`apps/server/src/config.ts` 派生、
 * `apps/server/src/bootstrap/module-configs.ts` 投影）外，没有任何其它模块读它们。值的终局是宿主投影进本包
 * `SandboxModuleConfig`，由 `src/server/config.ts` 的 `getSandboxConfig()` 交给沙盒域（默认池初始化、Provider
 * 注册、`SandboxExecutionHandler` 的等待回连超时）；`openSandboxClusterApiKey` 只在本包服务端拼 Cluster 请求头
 * （`src/server/services/sandbox-cluster-client.ts`），浏览器不可见。route A 下 `envDefinitions` 只承担启动期
 * 校验 + 汇总，值仍由宿主 `bootstrap/module-configs.ts` 手工投影，本包既不读 `process.env` 也不做第二份归一。
 *
 * 各键 schema 逐字照抄宿主 `apps/server/src/env.ts:87-102` 的原行（含 `.optional()` / `.default()` 与
 * `.min(1)` 强度），故与宿主同名行等价。**默认值语义有两类，不能一律照 schema 读**：
 *   1. 写在 schema 里的（`RCS_SANDBOX_ENABLED` 的 `"false"`、`RCS_DEFAULT_SANDBOX_AGENT_TYPE` 的
 *      `"peri"`）：`defaultValue` 填 schema `parse()` 的**输入**（原始字符串），由 loader 再 parse 一次，
 *      与宿主原行为一致；
 *   2. **不在 env schema 里、而在宿主 `apps/server/src/config.ts` 的 `??` 里**的五个 timeout：
 *      `RCS_SANDBOX_RUNTIME_CONNECT_TIMEOUT_MS ?? 10000`（config.ts:68）、`PROVIDER_REQUEST ?? 10000`(86)、
 *      `PROVIDER_CREATE ?? 120000`(88)、`PROVIDER_RESUME ?? 60000`(90)、`PROVIDER_DESTROY ?? 60000`(92)。
 *      宿主 schema 行是 `.optional()`、**没有** `.default()`，这里的 schema 因此保持 `.optional()` 原形（不追加
 *      `.default()`，避免与宿主行形状漂移），默认值原样落在 `EnvDefinition.defaultValue`。这样宿主同批删掉
 *      config.ts 的 `??` 后行为不变（未设置 → loader 用 `defaultValue` parse 出同一个数；设置了 → 走同一份
 *      宿主 schema 的校验强度）。**注意**：本包 `SandboxModuleConfigSchema` 把这五个 timeout 声明为**非可选**
 *      的 `z.number().int().positive()`，所以这五个 `defaultValue` 是宿主删 `??` 后的必要前提，不能省。
 * 除 `RCS_SANDBOX_CLUSTER_API_KEY`（Cluster 管理面凭据，`secret: true`，禁止进日志/响应/错误文案）外都是非密钥。
 * 全部只在启动期取一次快照（改后必须重启），故 `restartRequired: true`。
 *
 * 有意**不**声明的兄弟键：沙盒域没有别的部署变量；`dependsOn` 的 machine 域旋钮
 * （`RCS_FILE_WS_*`）归 machine 声明，跨模块共享键（`RCS_DB_*` / `DATABASE_URL` / `RCS_SYSTEM_API_KEYS` 等）
 * 按裁定留在宿主 schema。
 *
 * 不声明 `web`：消费方是 §1.6 的 WebShell 装配，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "sandbox",
  kind: "resource",
  dependsOn: ["machine"],
  capabilities: ["resource.sandbox"],
  // 顺序与宿主 `apps/server/src/env.ts:87-102` 同序，便于整合期逐行核对「模块声明 ↔ 宿主删除」成对。
  envDefinitions: [
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_RUNTIME_CONNECT_TIMEOUT_MS",
      // 与宿主 env.ts:87 逐字等价（`.optional()` 无 default）；默认值不在 schema，而在宿主 config.ts:68 的 `?? 10000`。
      schema: z.coerce.number().int().positive().optional(),
      defaultValue: 10000,
      secret: false,
      restartRequired: true,
      description:
        "沙盒创建/恢复后等待 ACP Runtime 回连的最长时间（毫秒）。默认 10000，由宿主 config.ts 的 `?? 10000` 提供（schema 无 default），由本模块 SandboxExecutionHandler 在等待机器回连时读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_ENABLED",
      // 与宿主 env.ts:88-91 逐字等价：先补默认字符串再归一为布尔，空串/未设置都落在 false。
      schema: z
        .string()
        .default("false")
        .transform((value) => value === "true"),
      defaultValue: "false",
      secret: false,
      restartRequired: true,
      description:
        "是否启用沙盒默认策略的全局开关。默认 false；关闭时本模块不初始化默认 Pool，控制台也不暴露可选资源池（显式指定池的 AgentNode 不受影响）。由本模块初始化默认池与列池选项时读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_DEFAULT_SANDBOX_POOL_ID",
      // 与宿主 env.ts:92 逐字等价（`.optional()` 无 default）：未配置即无默认池。
      schema: z.string().min(1).optional(),
      secret: false,
      restartRequired: true,
      description:
        "未显式指定运行节点时使用的默认沙盒资源池 ID。无默认值；启用沙盒时须配置，否则默认池初始化跳过（本模块在启动期读）。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_DEFAULT_SANDBOX_IMAGE",
      // 与宿主 env.ts:93 逐字等价（`.optional()` 无 default）。
      schema: z.string().min(1).optional(),
      secret: false,
      restartRequired: true,
      description: "默认沙盒镜像名称。无默认值；启用沙盒时须配置，由本模块写入默认 Pool（启动期读）。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_DEFAULT_SANDBOX_AGENT_TYPE",
      // 默认值写在 schema 内，故 defaultValue 填其 parse 输入 `"peri"`。
      schema: z.string().min(1).default("peri"),
      defaultValue: "peri",
      secret: false,
      restartRequired: true,
      description:
        "默认沙盒 Agent 类型。默认 peri（本模块 schema 内建默认）；写入默认 Pool 并用于生成 Sandbox Machine 身份，由本模块在启动期读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_DEFAULT_SANDBOX_RESOURCES_JSON",
      // 与宿主 env.ts:95 逐字等价（`.optional()` 无 default）。
      schema: z.string().min(1).optional(),
      secret: false,
      restartRequired: true,
      description:
        "默认沙盒资源配置 JSON（环境变量、挂载等）。无默认值；启用沙盒时须配置，由本模块写入默认 Pool（启动期读）。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_DEFAULT_SANDBOX_EXTRA_JSON",
      // 与宿主 env.ts:96 逐字等价（`.optional()` 无 default）。
      schema: z.string().min(1).optional(),
      secret: false,
      restartRequired: true,
      description: "默认资源池的 Provider 专属扩展配置 JSON。无默认值，由本模块写入默认 Pool（启动期读）。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_CLUSTER_URL",
      // 与宿主 env.ts:97 逐字等价（`.optional()` 无 default）：未配置时 Cluster 管理面快速失败。
      schema: z.string().min(1).optional(),
      secret: false,
      restartRequired: true,
      description:
        "OpenSandbox Cluster 管理 API 基址。无默认值；未配置时本模块的 Cluster 管理面按「服务不可用」快速失败。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_CLUSTER_API_KEY",
      // 与宿主 env.ts:98 逐字等价（`.optional()` 无 default）。
      schema: z.string().min(1).optional(),
      // 密钥材料：只在本包服务端拼 Cluster 请求头，禁止进入日志、响应与错误文案。
      secret: true,
      restartRequired: true,
      description:
        "调用 OpenSandbox Cluster 管理 API 的凭据。无默认值；只在服务端使用、不返回给浏览器，由本模块 Cluster 客户端读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_PROVIDER_REQUEST_TIMEOUT_MS",
      // 与宿主 env.ts:99 逐字等价（`.optional()` 无 default）；默认值来自宿主 config.ts:86 的 `?? 10000`。
      schema: z.coerce.number().int().positive().optional(),
      defaultValue: 10000,
      secret: false,
      restartRequired: true,
      description:
        "Provider / Cluster 单次普通请求的超时（毫秒）。默认 10000，由宿主 config.ts 的 `?? 10000` 提供（schema 无 default），由本模块在发起 Provider 请求时读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_PROVIDER_CREATE_TIMEOUT_MS",
      // 与宿主 env.ts:100 逐字等价（`.optional()` 无 default）；默认值来自宿主 config.ts:88 的 `?? 120000`。
      schema: z.coerce.number().int().positive().optional(),
      defaultValue: 120000,
      secret: false,
      restartRequired: true,
      description:
        "Provider 创建沙盒资源的超时（毫秒）。默认 120000，由宿主 config.ts 的 `?? 120000` 提供（schema 无 default），由本模块创建实例时读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_PROVIDER_RESUME_TIMEOUT_MS",
      // 与宿主 env.ts:101 逐字等价（`.optional()` 无 default）；默认值来自宿主 config.ts:90 的 `?? 60000`。
      schema: z.coerce.number().int().positive().optional(),
      defaultValue: 60000,
      secret: false,
      restartRequired: true,
      description:
        "Provider 恢复已停止沙盒资源的超时（毫秒）。默认 60000，由宿主 config.ts 的 `?? 60000` 提供（schema 无 default），由本模块恢复实例时读取。",
    },
    {
      moduleId: "sandbox",
      key: "RCS_SANDBOX_PROVIDER_DESTROY_TIMEOUT_MS",
      // 与宿主 env.ts:102 逐字等价（`.optional()` 无 default）；默认值来自宿主 config.ts:92 的 `?? 60000`。
      schema: z.coerce.number().int().positive().optional(),
      defaultValue: 60000,
      secret: false,
      restartRequired: true,
      description:
        "Provider 销毁沙盒资源的超时（毫秒）。默认 60000，由宿主 config.ts 的 `?? 60000` 提供（schema 无 default），由本模块删除实例时读取。",
    },
  ],
  contributions: [
    {
      id: "sandbox.web-config",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSandboxWebConfigRoutes(host)),
    },
    {
      id: "sandbox.api",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSandboxApiRoutes(host)),
    },
    {
      id: "sandbox.api-cluster",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSandboxApiClusterRoutes(host)),
    },
    {
      id: "sandbox.api-server",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSandboxApiServerRoutes(host)),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 与 provider SDK 拖进模块图。
  create: () => import("./src/module").then((module) => module.createSandboxModule()),
} satisfies ModuleManifest;
