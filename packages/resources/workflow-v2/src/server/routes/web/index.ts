import { Elysia } from "elysia";
import type { WorkflowV2RouteDependencies } from "../dependencies";
import { createWebWorkflowV2IframeCodeRoutes } from "./iframe-code";
import { createWebWorkflowV2OrgAppRoutes } from "./org-app";
import { createWebWorkflowV2PlatformAccountRoutes } from "./platform-account";
import { createWebWorkflowV2PublishRoutes } from "./workflow-publish";
import { createWebWorkflowV2RunRoutes } from "./workflow-runs";
import { createWebWorkflowV2WorkflowRoutes } from "./workflows";

/**
 * `/web/workflow-v2/*` 控制台面（设计 §4.3，冻结 §2.1 的 `workflow-v2.web-control`）。
 *
 * 本文件只做「挂载与分组」，不放任何业务 handler：各条子路由各自归属一个后续任务（1B 会话、2A 租户 App、
 * 2B 注册表与发布记录读出口、1C 票据），它们的函数体在各自任务里填充，本文件因此不会成为并行开发的冲突点。
 * 发布记录读出口独立成 `workflow-publish.ts`（同一前缀下的另一条子路由），挂载方式与其余子路由一致；运行日志
 * 读路径独立成 `workflow-runs.ts`（页面级视图，不挂在单个 workflow 上）。
 *
 * 前缀 `/workflow-v2` 写在实例上（而不是各条路由里）：`web` 槽的贡献由宿主 `/web` 聚合实例挂载，只有
 * 「前缀由宿主决定」这一形态才能让 `/web/workflow-v2/*` 与其它模块的 `/web/*` 面共存（与既有
 * `/workflow-ui` 静态代理同形）。
 *
 * 全部端点走会话 cookie 鉴权（`sessionAuth`），组织隔离按 `activeOrganizationId` 做（冻结 §4.3）；守卫由
 * 各子路由 `.use(deps.authGuardPlugin)` 注入——Elysia 的 macro 是实例作用域的，父实例无法向已构造的子
 * 实例回填，因此注入必须发生在每个子实例的构造处。
 */
export function createWebWorkflowV2Routes(deps: WorkflowV2RouteDependencies) {
  return new Elysia({ name: "web-workflow-v2", prefix: "/workflow-v2" })
    .use(createWebWorkflowV2PlatformAccountRoutes(deps))
    .use(createWebWorkflowV2OrgAppRoutes(deps))
    .use(createWebWorkflowV2WorkflowRoutes(deps))
    .use(createWebWorkflowV2PublishRoutes(deps))
    .use(createWebWorkflowV2RunRoutes(deps))
    .use(createWebWorkflowV2IframeCodeRoutes(deps));
}
