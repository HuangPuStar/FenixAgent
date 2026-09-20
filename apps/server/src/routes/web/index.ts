import {
  createWebAgentGenerationRoutes,
  createWebAgentSitesRoutes,
  createWebSidebarConfigRoutes,
} from "@fenix/agent-config/server";
import { createWebApiKeysRoutes, createWebOrganizationsRoutes } from "@fenix/identity/server";
import { createWebModelGatewayRoutes } from "@fenix/model-management/server";
import { createWebChannelsRoutes } from "@fenix/resource-channel/server";
import { createWebKnowledgeBaseRoutes } from "@fenix/resource-knowledge/server";
import { createWebFileEventsRoutes, createWebFsRoutes, createWebRegistryRoutes } from "@fenix/resource-machine/server";
import { createWebHindsightRoutes } from "@fenix/resource-memory/server";
import { createWebProdViewsRoutes } from "@fenix/resource-prod-view/server";
import { createWebTasksV2Routes } from "@fenix/resource-task/server";
import {
  createWebWorkflowCustomToolsRoutes,
  createWebWorkflowDefsRoutes,
  createWebWorkflowEngineRoutes,
  createWebWorkflowRunsRoutes,
  createWebWorkflowSseRoutes,
} from "@fenix/resource-workflow/server";
import Elysia from "elysia";
import { authenticateRequest, authGuardPlugin } from "../../plugins/auth";
import { environmentLookup } from "../../services/resource-module-ports";
import webBranding from "./branding";
import webConfig from "./config";
import webControl from "./control";
import webEnvironments from "./environments";
import webInstances from "./instances";
import webMetaAgent from "./meta-agent";
import webPeriTaskDetails from "./peri-task-details";

// 资源包路由一律改为工厂：守卫必须与宿主的认证解析是同一份实例（Elysia 的 macro / state 是实例
// 作用域的，父实例无法向已构造的子实例回填），因此在这里注入而不是让包自建。
// - `authenticateRequest`：`/web/file-events` 走 WS 升级，不经过 `sessionAuth` 宏，自己调用宿主的
//   显式认证入口；
// - `environmentLookup`：通道绑定要读 Environment 归属，而该表的 owner 是 `@fenix/agent-runtime`。
// 端口实现见 `services/resource-module-ports.ts`。
const webApiKeys = createWebApiKeysRoutes({ authGuardPlugin });
const webOrganizations = createWebOrganizationsRoutes({ authGuardPlugin });
const webSidebarConfig = createWebSidebarConfigRoutes();
const webAgentSites = createWebAgentSitesRoutes({ authGuardPlugin });
const webChannelsRoutes = createWebChannelsRoutes({ authGuardPlugin, environmentLookup });
const webFs = createWebFsRoutes({ authGuardPlugin });
const webFileEvents = createWebFileEventsRoutes({ authenticateRequest });
const webHindsight = createWebHindsightRoutes({ authGuardPlugin });
const webKnowledgeBases = createWebKnowledgeBaseRoutes({ authGuardPlugin });
const webModelGateway = createWebModelGatewayRoutes({ authGuardPlugin });
const webTasksV2Routes = createWebTasksV2Routes({ authGuardPlugin });
const webRegistry = createWebRegistryRoutes({ authGuardPlugin });
const webWorkflowDefs = createWebWorkflowDefsRoutes({ authGuardPlugin });
const webWorkflowCustomTools = createWebWorkflowCustomToolsRoutes({ authGuardPlugin });
const webWorkflowEngine = createWebWorkflowEngineRoutes({ authGuardPlugin });
const webWorkflowSse = createWebWorkflowSseRoutes({ authGuardPlugin });
const workflowRunsRoutes = createWebWorkflowRunsRoutes({ authGuardPlugin });
const webProdViewsRoutes = createWebProdViewsRoutes({ authGuardPlugin });
const webAgentGeneration = createWebAgentGenerationRoutes({ authGuardPlugin });

const webApp = new Elysia({ name: "web", prefix: "/web" })
  .use(webApiKeys)
  .use(webBranding)
  .use(webControl)
  .use(webSidebarConfig)
  .use(webAgentSites)
  .use(webChannelsRoutes)
  .use(webConfig)
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
  .use(webProdViewsRoutes)
  .use(webAgentGeneration);

export default webApp;
