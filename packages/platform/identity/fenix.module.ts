import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { z } from "zod/v4";

/**
 * Identity 平台模块描述符。
 *
 * 身份、组织、成员、认证与 API Key 的唯一 owner。它是平台基础模块：不依赖任何其他模块
 * （`dependsOn` 为空）。资源的**调用期**（service / repository）不得依赖它——依赖矩阵禁止任何类别
 * 依赖 `platform-impl`，调用方需要的身份数据只经 `@fenix/platform-sdk` 的 `IdentityDirectory`
 * 窄契约取得，由宿主 `apps/server` 注册实现。
 *
 * 唯一的例外在 **schema 组装期**：其他模块的 `db/schema.ts` 会导入这里的表对象表达跨模块外键
 * （Drizzle 的 `.references()` 只接受列对象，没有字符串形式）。该例外仅限各模块 `db/` 子目录下的文件，
 * `src/` 与 `web/` 的跨包导入仍按 §2.3 判定为违规；口径与边界见
 * `docs/design/ce-ee-refactoring/ce-ee-engineering-standards.md` §6.1。
 *
 * 本模块声明的运行期依赖只有应用基础设施中的 DB（经 `@fenix/platform-sdk/server` 读取）。部署值走
 * **两条互不重叠的通道**：`envDefinitions`（见下）声明形状与默认值，供启动期统一校验与汇总；值的传递
 * 仍由宿主 `apps/server/src/bootstrap/module-configs.ts` 把已校验的 env 投影成本模块配置，本模块经
 * `getModuleConfig("identity")` 读取（1.7 C 块路线 A：声明只承担校验与汇总，不改模块配置的形态）。
 * 因此这里只为「本模块独有的部署变量」声明，且**不重复宿主已经做过的归一**（例如路径 `resolve`）；
 * preflight / readiness 不在本批范围（1.8）。
 *
 * 声明 `contributions`（1.5e）：`/web/api-keys`、`/web/organizations` 与 `/api/system/*` 的路由实例由本模块
 * 以惰性构造函数 `(host) => import("./src/server/assembly").then(...)` 给出，`slot` 指明挂宿主哪一面——
 * 路由路径是相对形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。**基础模块同样参与贡献挂载**：
 * 装配的 mount 阶段遍历 profile 解析出的全部模块（`bootstrapModules` 的 `orderContributions`），不区分
 * 类别，因此这两条路由与其他资源包的路由走同一条接线。惰性 import 与 `create` 同因：registry 会被大量位置
 * 导入，不能在索引层就把 Elysia 拖进模块图。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是本模块浏览器载荷的惰性**入口说明符字符串**，供 WebShell
 * 生成器静态定位——生成器只对 manifest 做 AST 静态读取、不执行它，所以取值必须是字符串字面量。它**不是**
 * 浏览器依赖：`lucide-react` / React 载荷只存在于 `@fenix/identity/web/contribution` 导出的值里，不会沿
 * registry 进入服务端装配图（server 侧拿到的只有这一条字符串）。
 */
export const moduleManifest = {
  id: "identity",
  kind: "identity",
  dependsOn: [],
  capabilities: ["platform.identity"],
  web: {
    id: "identity",
    contribution: "@fenix/identity/web/contribution",
  },
  // identity 不声明 accessControlBindings：access-control 依赖 identity，而 organization/member 表又由本模块
  // 持有；若 identity 反向走 access-control 会形成依赖与装配循环。组织成员管理由本包 Facade 直接从 member
  // 表校验目标组织的 admin/owner 角色。这只是基础模块特例，skill、mcp 等资源模块仍须声明绑定。
  contributions: [
    {
      id: "identity.web-api-keys",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createIdentityWebApiKeysRoutes(host)),
    },
    {
      id: "identity.web-organizations",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createIdentityWebOrganizationsRoutes(host)),
    },
    {
      id: "identity.api-system",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createIdentityApiSystemRoutes(host)),
    },
  ],
  // ── 部署变量声明（1.7 C2，路线 A）──
  //
  // 这四个键的「唯一 owner = 本模块」判据是**消费者**而不是键名：取值只进 better-auth 实例的构造参数与
  // 系统管理员密码文件路径，两类消费者都在本包内（`src/auth/better-auth.ts`、
  // `src/services/ensure-system-admin.ts`）。一旦别的模块也要读它们，说明认证契约被旁路，那时才该升格为平台级键。
  //
  // `BETTER_AUTH_URL` / `RCS_TRUSTED_ORIGINS` / `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 由宿主 `env.ts` 迁入
  // （宿主 143 / 55 / 65 行；迁移时宿主侧那一行必须同批删除，否则 `assertNoHostKeyOverride` 启动期直接抛错）。
  // `BETTER_AUTH_SECRET` 是**补缺键**：宿主 schema 从未声明它，而 better-auth 内部直读同名 `process.env`
  // （`create-context` 的 `options.secret || env.BETTER_AUTH_SECRET || env.AUTH_SECRET`），缺省回落到内置默认串、
  // 生产环境直接拒绝启动。不声明它，「env 是唯一真相来源」就永远缺一角。
  //
  // 默认值语义**逐字照抄宿主行**，不做「顺手改进」：空串与相对路径都是宿主既有默认值，模块侧不再二次归一
  // （`buildTrustedOrigins` 自己 trim/split，路径由宿主 `config.ts` resolve 后再投影进来）。两个 optional 键
  // 在宿主那一行没有可省略的默认值，因此**省略 `defaultValue`**：未设置时 better-auth 自行回落
  // （`undefined` 与不传等价），写 `null` 会让 `loadDeclaredEnv` 的取值路径漂移。
  //
  // 不迁的兄弟键与理由：`RCS_BASE_URL`（宿主 `getBaseUrl()` 被 skill / workflow / agent-runtime 共用，非本模块独有）、
  // `RCS_DISABLE_SIGNUP`（真消费者是宿主路由 `apps/server/src/plugins/auth.ts` 的公开注册开关）、
  // `RCS_SYSTEM_API_KEYS`（平台级系统接口守卫，observer / sandbox / model-management 同样消费）。三键留在宿主 schema。
  //
  // `secret` / `restartRequired` 当前没有消费者（1.7 review §8.1 第 8 条已登记），此处按语义如实标注，
  // 不因为「没人读」就把密钥材料标成非密钥。四项都只在启动期读取（better-auth 单例与密码文件路径在启动时定型）。
  envDefinitions: [
    {
      moduleId: "identity",
      key: "BETTER_AUTH_URL",
      // 与宿主 env.ts:143 逐字等价：无可省略的默认值，未设置即 `undefined`。
      schema: z.string().optional(),
      secret: false,
      restartRequired: true,
      description:
        "better-auth 的 baseURL（回调/重定向 URL 基址），构造 better-auth 实例时读取。未设置时 better-auth 回落到 RCS_BASE_URL，故不写 defaultValue 以保留 undefined 语义。",
    },
    {
      moduleId: "identity",
      key: "RCS_TRUSTED_ORIGINS",
      // 与宿主 env.ts:55 逐字等价：默认空串，即不追加额外来源。
      schema: z.string().default(""),
      defaultValue: "",
      secret: false,
      restartRequired: true,
      description:
        "逗号分隔的额外可信来源，与 BETTER_AUTH_URL / RCS_BASE_URL 一起经 buildTrustedOrigins 归一后写入 better-auth 的 trustedOrigins。默认空串（照抄宿主），即只信本机回环与两个基址。",
    },
    {
      moduleId: "identity",
      key: "RCS_SYSTEM_ADMIN_PASSWORD_FILE",
      // 与宿主 env.ts:65 逐字等价：默认 ./data/password.txt；resolve 由宿主负责，本模块不重复。
      schema: z.string().default("./data/password.txt"),
      defaultValue: "./data/password.txt",
      secret: false,
      restartRequired: true,
      description:
        "系统管理员首次启动引导所用的密码文件路径，ensureSystemAdmin 在启动期读取并生成口令。默认 ./data/password.txt（照抄宿主）；宿主负责 resolve 为绝对路径后再投影进模块配置，本模块不重复归一。",
    },
    {
      moduleId: "identity",
      key: "BETTER_AUTH_SECRET",
      // 补缺键：宿主 schema 无对应行，形状按 better-auth 自己的回落语义（无默认值）声明。
      schema: z.string().optional(),
      secret: true,
      restartRequired: true,
      description:
        "better-auth 的签名/加密密钥材料（补缺键：宿主 schema 此前未声明，由 better-auth 直读同名变量）。未设置时 better-auth 自行回落内置默认串，生产环境会拒绝启动，故不写 defaultValue。密钥值不得进入日志、响应或错误文案。",
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle 与 better-auth 拖进模块图。
  create: () => import("./src/module").then((module) => module.createIdentityModule()),
} satisfies ModuleManifest;
