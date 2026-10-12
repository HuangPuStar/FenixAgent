import type { ModuleManifest } from "@fenix/platform-sdk";
import type { ServerRouteHost } from "@fenix/platform-sdk/server";
import { ticketProjectResource } from "./src/server/access/ticket-project-resource";

/**
 * 工单资源模块描述符（`@fenix/resource-tickets`）。
 *
 * 职责：AOS 组织与 Git 仓库绑定之上的工单空间——项目的开通/暂停、工单的创建与查询、以及「远端对象 ↔
 * AOS 作者」的归属账本与幂等操作记录（`db/schema.ts` 五张表）。仓库、Issue、评论与标签的**事实源是
 * Forgejo**，本包只持有 AOS 侧的索引、归属与操作账本，仓库事实经 `@fenix/git` 的 `GitService` 读写。
 *
 * `kind: "resource"`：与 `@fenix/git`、`@fenix/resource-task` 同槽，用现有可选能力槽注册
 * （`deploy/assembly/ce.json` 默认不含本模块，工单启用完全由 profile 决定）。
 *
 * `dependsOn: ["git"]`：git 是必需装配边。`src/**` 值导入 `@fenix/git/server`（`isGitError` / `GitError`），
 * 缺失时 `createModuleRegistry` 的 `resolveProfile` 在产生任何副作用前报「模块 tickets 依赖未启用模块 git」。
 * 生成器的 `assertDependsOnComplete` 只扫 `src/**`（排除 `__tests__`）的值导入、且只对 `kind: "resource"`
 * 的目标包生效——`@fenix/platform-sdk` 不是注册模块，不写；`web/**` 不参与该判定，浏览器面依赖谁由 profile
 * 的 `web` 列表表达。`db/**` 组装期导入的 `@fenix/git/db` 表对象同样不进 `dependsOn`（它只影响迁移链）。
 *
 * `accessControlBindings`：工单项目是受控资源（`ticket_project`），只声明归属列 `organizationId`、不声明
 * 平台受众 `visibility`——跨组织可见性对工单项目不是平台受众模型（详见
 * `src/server/access/ticket-project-resource.ts` 的字段裁定）。绑定经 `ModuleFactoryContext.declarations`
 * 汇总，因此**不得**把 `access-control` 写进 `dependsOn`：那会构成装配环。
 *
 * `envDefinitions` 与 `dependencyServices` 都留白：本包不读 `process.env`，T02 没有部署旋钮（标题与正文
 * 上限是代码常量）；Forgejo 容器与探活由 git manifest 唯一声明，工单不重复声明依赖服务。
 *
 * `web.contribution` 是包浏览器载荷的**入口说明符字符串**（WebShell 生成器只对 manifest 做 AST 静态读取、
 * 不执行它，故必须是字符串字面量）；它不进服务端装配图，`lucide-react` 与 React 只存在于该入口导出的值里。
 * `create` 与 `contributions.value` 都是惰性 import：registry 会被大量位置导入，不能在索引层就把
 * Drizzle、Elysia 或 gray-matter 拖进模块图。
 */
export const moduleManifest = {
  id: "tickets",
  kind: "resource",
  dependsOn: ["git"],
  capabilities: ["resource.tickets"],
  web: {
    id: "tickets",
    contribution: "@fenix/resource-tickets/web/contribution",
  },
  accessControlBindings: [ticketProjectResource.storage],
  contributions: [
    {
      id: "tickets.web",
      kind: "app-route",
      slot: "web",
      value: (host: ServerRouteHost) =>
        import("./src/server/assembly").then((assembly) => assembly.createTicketsWebRoutes(host)),
    },
  ],
  create: (context) => import("./src/module").then((module) => module.createTicketsModule(context)),
} satisfies ModuleManifest;
