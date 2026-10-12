/**
 * 工单资源包服务端公开入口（`@fenix/resource-tickets/server`）。
 *
 * 依赖方向：宿主 `apps/server` 是合法消费者（装配、路由贡献与测试）。路由一律以工厂形式导出，守卫由宿主
 * 注入（理由见 `./server/routes/dependencies`）；本入口不导出浏览器代码——浏览器面走 `./web` 及其子路径。
 *
 * 不出口的东西（与 `@fenix/git/server` 同一取向）：仓储与领域服务的内部实现、`ForgejoClient`、YAML 引擎、
 * 路由中未列出的 schema。宿主需要的是「装配什么」与「挂哪条路由」，不是「怎么实现」。
 *
 * `resetTicketsServerModule` 与 §4.3 清单相比是**多出的一项**：进程级槽位在 `bun test` 的多文件共享进程里
 * 必须能被复位，否则「未装配即抛错」的用例会被同批其它文件的装配结果污染（`@fenix/agent-config/server`
 * 已按同款出口提供 `resetAgentConfigModule`）。它只服务测试，不改变运行期语义。
 */

export { TICKET_PROJECT_RESOURCE_TYPE, ticketProjectResource } from "./server/access/ticket-project-resource";
export { createTicketsWebRoutes } from "./server/assembly";
export {
  AssigneeNotMemberError,
  GitUnavailableError,
  IdempotencyConflictError,
  RepositoryConflictError,
  TicketChangeInFlightError,
  TicketsPausedError,
  TicketWriteNotAppliedError,
  UnknownLabelError,
  VersionConflictError,
} from "./server/errors";
export type {
  TicketCommentFacadeApi,
  TicketCommentWriteOutcomeView,
} from "./server/facades/ticket-comment-facade";
export type {
  TicketActorView,
  TicketCreateOutcome,
  TicketDetailView,
  TicketEditOutcomeView,
  TicketFacadeApi,
  TicketListPage,
  TicketListQuery,
  TicketOperationView,
  TicketSummaryView,
  TicketUpdateInput,
} from "./server/facades/ticket-facade";
export type {
  TicketLabelFacadeApi,
  TicketLabelWriteInput,
  TicketLabelWriteOutcomeView,
} from "./server/facades/ticket-label-facade";
export type {
  TicketProjectFacadeApi,
  TicketProjectOverview,
  TicketProjectView,
  TicketProvisionInput,
  TicketProvisionOutcome,
} from "./server/facades/ticket-project-facade";
export type {
  TicketCommentPageView,
  TicketCommentView,
  TicketMemberPageView,
  TicketMemberView,
  TicketProjectLabelView,
} from "./server/facades/ticket-view";
export { createTicketsServerModule, type TicketsModuleDeps, type TicketsServerModule } from "./server/module";
export type { WebTicketRouteDependencies } from "./server/routes/dependencies";
export { getTicketsServerModule, installTicketsServerModule, resetTicketsServerModule } from "./server/runtime";
