import {
  createWebAgentGenerationRoutes,
  createWebAgentSitesRoutes,
  createWebMetaAgentRoutes,
  createWebSidebarConfigRoutes,
} from "@fenix/agent-config/server";
import { rotateCallerApiKey } from "@fenix/identity/server";
import { createWebModelGatewayRoutes, createWebPeriTaskDetailsRoutes } from "@fenix/model-management/server";
import Elysia, { type AnyElysia } from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import { verifyEnvironmentOwnership } from "../../services/resource-module-ports";
import webBranding from "./branding";
import { createWebConfigApp } from "./config";

// 迁移中（1.5e）：资源包路由逐批改为 manifest 的 `app-route` 贡献——包声明「怎么造这条路由 + 挂哪个槽」，
// 装配期按槽登记（`bootstrap/route-contributions.ts`），本文件按槽取出挂载。已迁出的包不再出现在这里。
//
// 仍在手写序列里的只有 agent-config（4 条）与 model-management（2 条）：它们的迁移需要
// `ServerRouteHost` 扩 `rotateCallerApiKey` / `verifyEnvironmentOwnership` 两个端口（宿主装配面的改动
// 与它服务的迁移同批），故本文件暂留这两个端口与守卫的注入。
// - `rotateCallerApiKey`：meta agent 要轮换调用方名下的 API Key，而「同名 key 只保留一把」的编排只在
//   身份侧实现一处（资源包不得依赖 `@fenix/identity`），故由这里从 identity 取来注入；
// - `verifyEnvironmentOwnership`：peri 任务详情路由要校验 Environment 归属，而该表的 owner 是
//   `@fenix/agent-runtime`，资源包不得依赖它。
// 端口实现见 `services/resource-module-ports.ts`。
const webSidebarConfig = createWebSidebarConfigRoutes();
const webAgentSites = createWebAgentSitesRoutes({ authGuardPlugin });
const webModelGateway = createWebModelGatewayRoutes({ authGuardPlugin });
const webPeriTaskDetails = createWebPeriTaskDetailsRoutes({
  authGuardPlugin,
  getOwnedEnvironment: verifyEnvironmentOwnership,
});
const webMetaAgent = createWebMetaAgentRoutes({ authGuardPlugin, rotateCallerApiKey });
const webAgentGeneration = createWebAgentGenerationRoutes({ authGuardPlugin });

/** 按聚合槽传入的路由贡献；槽位定义与装配期收集见 `apps/server/src/bootstrap/route-contributions.ts`。 */
export interface WebRouteSlots {
  readonly web: readonly AnyElysia[];
  readonly webConfig: readonly AnyElysia[];
}

/**
 * `/web` 聚合实例。
 *
 * `slots` 是按 registry 装配结果登记到 `web` / `web-config` 两个槽的路由（1.5e 起逐包从下面的手写序列迁入；
 * `/web/config/*` 面的贡献由 `createWebConfigApp` 内挂载）。贡献统一挂在本聚合手写序列之后：贡献之间的
 * 相对顺序由装配收集顺序决定，兜底类贡献在自己声明处写 `order` 自证优先级，宿主不再维护「谁必须最后挂」
 * 的清单（review §3.3）。
 *
 * 改为工厂（不再是模块级单例）的原因：贡献实例只有在 `bootstrapServerAssembly()` 的 mount 阶段才存在，
 * 而装配跑在 app 构造之前——顶层构造的单例拿不到它们（review §3.3 的时序）。
 */
export function createWebApp(slots: WebRouteSlots): AnyElysia {
  return (
    new Elysia({ name: "web", prefix: "/web" })
      .use(webBranding)
      .use(webSidebarConfig)
      .use(webAgentSites)
      .use(createWebConfigApp(slots.webConfig))
      .use(webMetaAgent)
      .use(webModelGateway)
      .use(webPeriTaskDetails)
      .use(webAgentGeneration)
      // Elysia 的 `.use()` 接数组参数（不是展开），见 `node_modules/elysia/dist/index.d.ts` 的重载。
      .use([...slots.web])
  );
}
