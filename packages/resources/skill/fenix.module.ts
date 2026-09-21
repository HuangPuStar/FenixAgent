import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { skillResource } from "./src/server/access/skill-resource";

/**
 * Skill 资源模块描述符。
 *
 * Skill 资源（`skill` 表行 + SKILL.md 文档 + 同级归档文件）的资源归属语义、授权编排与「内容 + 资源行」
 * 补偿写入的唯一 owner。装配面上的消费者是宿主 `apps/server`（组合根装配后挂载 `/web/config/skills`、
 * `/api/skills` 与 `/skills/:name/download`，并经 `installSkillServerModule` 注入装配结果）、
 * `@fenix/resource-agent-config`（绑定表读写、元 Agent 的 Skill 装载，以及启动参数取 Skill 归档路径
 * ——该组装自任务 1.4 W4b 起也在 agent-config）。`./server` 出口含资源注册、组合根与 HTTP 路由；只要装配结果或内容能力的
 * 调用方走窄出口 `./server/runtime`、`./server/content`、`./server/config`——barrel 会连带导出 Elysia
 * 路由与下载令牌，把调用方拉进宿主依赖图（理由见 `src/server/runtime.ts` 与 `src/server-content.ts`
 * 的文件头注释）。
 *
 * `dependsOn: []` 是 `src/**`（不含 `__tests__`）值导入的实测结论：本包的全部跨包值导入只有
 * `@fenix/platform-sdk`（`AccessControlModule` / `AuthorizedResourceQuery` / `IdentityDirectory`
 * 等窄契约与错误分类法，见 `src/server/module.ts`、`src/server/facades/skill-facade.ts`、
 * `src/server/repositories/skill.ts`）与 `@fenix/logger`（`createLogger` 等），两者都不是可装配的
 * `resource` 模块，不构成装配边。授权与身份实现由宿主经 `createSkillServerModule(deps)` 注入，
 * 本包不 import 任何平台实现，也不 import 兄弟资源包，因此 skill 是叶子模块。
 *
 * 不声明别的反向边：`@fenix/resource-agent-config`（其 `src/server/services/agent-associations.ts` 的
 * `listAgentSkillIds` / `syncAgentSkills`、`src/server/services/skill-directory.ts`、
 * `src/server/services/agent-launch-spec/skill-resolution.ts`、`src/services/meta-agent.ts`）
 * 与宿主都导入本包的服务端入口，方向是它们 → 本模块。`@fenix/agent-runtime` 曾有一条入边（旧
 * `src/services/launch-spec-builder.ts`），任务 1.4 W4b 删除该文件后已消除。把这条边写进本模块会反转装配方向并构成装配
 * 循环：skill 与 agent-config 一旦成套启用，`platform-sdk` 的 `visit()` 会以「模块装配依赖存在循环」
 * 失败；即使抛开循环，本包 `package.json` 也没有这些编译依赖，生成器的 `assertDependsOnDeclared` 会
 * 先行报错。依赖本模块的模块各自声明 skill 才是正确形状。
 *
 * 声明 `accessControlBindings`：`skillResource.storage` 是本模块主表（`skill`）的归属列声明，由
 * `access-control` 的工厂经 `ModuleFactoryContext.declarations` 汇总。静态导入资源注册文件是有意的
 * 取舍——绑定是值而不是类型，只能来自静态导出；本模块**不得**为这条边把 `access-control` 写进
 * `dependsOn`，否则授权模块与资源模块会互相等待（理由与加载代价见 `@fenix/resource-mcp` 的同类说明）。
 *
 * 声明 `create`：指向 `src/module.ts` 的 `createSkillModule(context)`，由 registry 注入装配声明并装入
 * 组合根产出的实例。工厂保持惰性——registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 拖进
 * 模块图。
 *
 * 声明 `contributions`（1.5e）：`/web/config/skills` 与 `/api/skills` 的路由实例由本模块以惰性构造函数
 * `(host) => import("./src/server/assembly").then(...)` 给出，`slot` 指明挂宿主哪一面——路由路径是相对
 * 形式，前缀由宿主的聚合实例决定，「挂哪一面」只能由声明说清。惰性 import 与 `create` 同因：registry 会被
 * 大量位置导入，不能在索引层就把 Elysia 拖进模块图。两条路由共用同一份会话守卫。
 *
 * 1.5f-1b 追加一条顶层 `app` 槽贡献：`/skills/:name/download`。它用独立的 skill 下载 token 认证而不是
 * 会话守卫，与 `/web`、`/api` 两面都不同前缀，因此单列一槽（`skillDownloadRoutes` 是模块级单例，装配面
 * 只包一层惰性构造函数，理由见 `src/server/assembly.ts` 的 `createSkillDownloadAppRoutes`）。
 *
 * 声明 `web`（§1.6 已定型）：`contribution` 是该包浏览器载荷的惰性**入口说明符字符串**，指向已有的
 * `web/index.ts` 浏览器出口上的贡献值——WebShell 生成器只对 manifest 做 AST 静态读取、不执行它，所以入口
 * 只能是「声明」而不是「推断」，取值必须是字符串字面量。它**不是**浏览器依赖：`lucide-react` / React 载荷
 * 只存在于 `@fenix/resource-skill/web/contribution` 导出的值里，不会沿 registry 进入服务端装配图（server
 * 侧拿到的只有这一条字符串）。
 *
 * `envDefinitions` 的留白保持不变：消费方是 §1.7 的宿主 env 登记，形状必须与消费端同时定型。
 */
export const moduleManifest = {
  id: "skill",
  kind: "resource",
  dependsOn: [],
  capabilities: ["resource.skill"],
  web: {
    id: "skill",
    contribution: "@fenix/resource-skill/web/contribution",
  },
  accessControlBindings: [skillResource.storage],
  contributions: [
    {
      id: "skill.web-config",
      kind: "app-route",
      slot: "web-config",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSkillWebConfigRoutes(host)),
    },
    {
      id: "skill.api",
      kind: "app-route",
      slot: "api",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createSkillApiRoutes(host)),
    },
    {
      id: "skill.app-download",
      kind: "app-route",
      slot: "app",
      // 工厂不消费 host：下载凭令牌自授权，没有守卫可注入。
      value: () => import("./src/server/assembly").then((assembly) => assembly.createSkillDownloadAppRoutes()),
    },
  ],
  // 工厂保持惰性：registry 会被大量位置导入，不能在索引层就把 Drizzle、Elysia 拖进模块图。
  create: (context) => import("./src/module").then((module) => module.createSkillModule(context)),
} satisfies ModuleManifest;
