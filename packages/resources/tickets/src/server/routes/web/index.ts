/**
 * `/web` 工单路由工厂（backend contract §9.1 的七条路由）。
 *
 * 导出的是**构造函数**而不是实例：`sessionAuth` 宏与 `store.actor` 由宿主守卫写入，Elysia 的
 * `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填，因此守卫必须由宿主注入
 * （`WebTicketRouteDependencies`）；构造时机由宿主装配决定，故本文件不持有任何状态。
 *
 * 路径一律写成**相对形式**（`/ticket-projects`、`/tickets/:projectId`…）：`/web` 前缀由宿主的聚合实例
 * 决定（`apps/server/src/routes/web/index.ts` 的 `prefix: "/web"`），包内再写一次会让最终路径变成
 * `/web/web/...`。
 *
 * 三个注册函数按资源分组（项目 / 工单 / 操作账本），各自只调用 `app.get/post/patch`——Elysia 的路由方法
 * 在实例上追加路由并返回同一实例，因此这里把实例交给它们即可，不需要回传链式结果。插件 `name` 在宿主
 * 进程内必须唯一：同名实例会被 Elysia 去重，后构造的一方静默失效。
 */

import Elysia from "elysia";
import type { WebTicketRouteDependencies } from "../dependencies";
import { registerTicketOperationRoutes } from "./ticket-operations";
import { registerTicketProjectRoutes } from "./ticket-projects";
import { registerTicketRoutes } from "./tickets";

/** 工单控制台路由；挂宿主 `web` 聚合槽（`fenix.module.ts` 的 `app-route` 贡献）。 */
export function createWebTicketRoutes(deps: WebTicketRouteDependencies) {
  const app = new Elysia({ name: "web-tickets" }).use(deps.authGuardPlugin);
  registerTicketProjectRoutes(app);
  registerTicketRoutes(app);
  registerTicketOperationRoutes(app);
  return app;
}
