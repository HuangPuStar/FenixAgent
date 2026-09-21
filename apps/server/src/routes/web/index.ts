import {
  createWebAgentGenerationRoutes,
  createWebAgentSitesRoutes,
  createWebMetaAgentRoutes,
  createWebSidebarConfigRoutes,
} from "@fenix/agent-config/server";
import {
  createWebControlRoutes,
  createWebEnvironmentsRoutes,
  createWebInstancesRoutes,
} from "@fenix/agent-runtime/server";
import { createWebApiKeysRoutes, createWebOrganizationsRoutes, rotateCallerApiKey } from "@fenix/identity/server";
import { createWebModelGatewayRoutes, createWebPeriTaskDetailsRoutes } from "@fenix/model-management/server";
import { createWebChannelsRoutes } from "@fenix/resource-channel/server";
import { createWebKnowledgeBaseRoutes } from "@fenix/resource-knowledge/server";
import { createWebFileEventsRoutes, createWebFsRoutes, createWebRegistryRoutes } from "@fenix/resource-machine/server";
import { createWebHindsightRoutes } from "@fenix/resource-memory/server";
import { createWebTasksV2Routes } from "@fenix/resource-task/server";
import {
  createWebWorkflowCustomToolsRoutes,
  createWebWorkflowDefsRoutes,
  createWebWorkflowEngineRoutes,
  createWebWorkflowRunsRoutes,
  createWebWorkflowSseRoutes,
} from "@fenix/resource-workflow/server";
import Elysia, { type AnyElysia } from "elysia";
import { authenticateRequest, authGuardPlugin } from "../../plugins/auth";
import { environmentLookup, verifyEnvironmentOwnership } from "../../services/resource-module-ports";
import webBranding from "./branding";
import { createWebConfigApp } from "./config";

// 资源包路由一律改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 macro / state 是实例
// 作用域的，父实例无法向已构造的子实例回填），因此在这里注入而不是让包自建。
// - `authenticateRequest`：`/web/file-events` 走 WS 升级，不经过 `sessionAuth` 宏，自己调用宿主的
//   显式认证入口；
// - `environmentLookup`：通道绑定要读 Environment 归属，而该表的 owner 是 `@fenix/agent-runtime`；
// - `verifyEnvironmentOwnership`：peri 任务详情路由要校验 Environment 归属，同因（该表的 owner 是
//   `@fenix/agent-runtime`，资源包不得依赖它）；
// - `rotateCallerApiKey`：meta agent 要轮换调用方名下的 API Key，而「同名 key 只保留一把」的编排只在
//   身份侧实现一处（资源包不得依赖 `@fenix/identity`），故由这里从 identity 取来注入。
// 端口实现见 `services/resource-module-ports.ts`。
const webApiKeys = createWebApiKeysRoutes({ authGuardPlugin });
const webOrganizations = createWebOrganizationsRoutes({ authGuardPlugin });
const webControl = createWebControlRoutes({ authGuardPlugin });
const webEnvironments = createWebEnvironmentsRoutes({ authGuardPlugin });
const webInstances = createWebInstancesRoutes({ authGuardPlugin });
const webSidebarConfig = createWebSidebarConfigRoutes();
const webAgentSites = createWebAgentSitesRoutes({ authGuardPlugin });
const webChannelsRoutes = createWebChannelsRoutes({ authGuardPlugin, environmentLookup });
const webFs = createWebFsRoutes({ authGuardPlugin });
const webFileEvents = createWebFileEventsRoutes({ authenticateRequest });
const webHindsight = createWebHindsightRoutes({ authGuardPlugin });
const webKnowledgeBases = createWebKnowledgeBaseRoutes({ authGuardPlugin });
const webModelGateway = createWebModelGatewayRoutes({ authGuardPlugin });
const webPeriTaskDetails = createWebPeriTaskDetailsRoutes({
  authGuardPlugin,
  getOwnedEnvironment: verifyEnvironmentOwnership,
});
const webMetaAgent = createWebMetaAgentRoutes({ authGuardPlugin, rotateCallerApiKey });
const webTasksV2Routes = createWebTasksV2Routes({ authGuardPlugin });
const webRegistry = createWebRegistryRoutes({ authGuardPlugin });
const webWorkflowDefs = createWebWorkflowDefsRoutes({ authGuardPlugin });
const webWorkflowCustomTools = createWebWorkflowCustomToolsRoutes({ authGuardPlugin });
const webWorkflowEngine = createWebWorkflowEngineRoutes({ authGuardPlugin });
const webWorkflowSse = createWebWorkflowSseRoutes({ authGuardPlugin });
const workflowRunsRoutes = createWebWorkflowRunsRoutes({ authGuardPlugin });
const webAgentGeneration = createWebAgentGenerationRoutes({ authGuardPlugin });

/** 按聚合槽传入的路由贡献；槽位定义与装配期收集见 `apps/server/src/bootstrap/route-contributions.ts`。 */
export interface WebRouteSlots {
  readonly web: readonly AnyElysia[];
  readonly webConfig: readonly AnyElysia[];
}

/**
 * `/web` 聚合实例。
 *
 * `contributedRoutes` 是按 registry 装配结果登记到 `web` / `web-config` 两个槽的路由（1.5e 起逐包从下面的
 * 手写序列迁入；`/web/config/*` 面的贡献由 `createWebConfigApp` 内挂载）。贡献统一挂在本聚合手写序列
 * 之后：贡献之间的相对顺序由装配收集顺序决定，兜底类贡献在自己声明处写 `order` 自证优先级，宿主不再
 * 维护「谁必须最后挂」的清单（review §3.3）。
 *
 * 改为工厂（不再是模块级单例）的原因：贡献实例只有在 `bootstrapServerAssembly()` 的 mount 阶段才存在，
 * 而装配跑在 app 构造之前——顶层构造的单例拿不到它们（review §3.3 的时序）。
 */
export function createWebApp(slots: WebRouteSlots): AnyElysia {
  return (
    new Elysia({ name: "web", prefix: "/web" })
      .use(webApiKeys)
      .use(webBranding)
      .use(webControl)
      .use(webSidebarConfig)
      .use(webAgentSites)
      .use(webChannelsRoutes)
      .use(createWebConfigApp(slots.webConfig))
      .use(webFs)
      .use(webFileEvents)
      .use(webInstances)
      .use(webHindsight)
      .use(webKnowledgeBases)
      .use(webMetaAgent)
      .use(webModelGateway)
      .use(webOrganizations)
      .use(webPeriTaskDetails)
      .use(webTasksV2Routes)
      .use(webEnvironments)
      .use(webRegistry)
      .use(webWorkflowDefs)
      .use(webWorkflowCustomTools)
      .use(webWorkflowEngine)
      .use(webWorkflowSse)
      .use(workflowRunsRoutes)
      .use(webAgentGeneration)
      // Elysia 的 `.use()` 接数组参数（不是展开），见 `node_modules/elysia/dist/index.d.ts` 的重载。
      .use([...slots.web])
  );
}
