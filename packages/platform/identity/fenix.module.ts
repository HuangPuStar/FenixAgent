import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";

/**
 * Identity 平台模块描述符。
 *
 * 身份、组织、成员、认证与 API Key 的唯一 owner。它是平台基础模块：不依赖任何其他模块
 * （`dependsOn` 为空），资源与运行时模块也**不得**直接依赖它——依赖矩阵禁止任何类别依赖
 * `platform-impl`。调用方需要的身份数据只经 `@fenix/platform-sdk` 的 `IdentityDirectory`
 * 窄契约取得，由宿主 `apps/server` 注册实现。
 *
 * 本模块声明的运行期依赖只有应用基础设施中的 DB（经 `@fenix/platform-sdk/server` 读取）；
 * better-auth 与系统管理员密码文件等部署配置当前仍由宿主解析后经 `initializeApplicationInfrastructure`
 * 的模块配置传入，模块自身的 `envDefinitions` 与 preflight 随 1.7 的 env 收敛一并补齐。
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
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle 与 better-auth 拖进模块图。
  create: () => import("./src/module").then((module) => module.createIdentityModule()),
} satisfies ModuleManifest;
