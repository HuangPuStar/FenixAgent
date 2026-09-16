import {
  webAgentGenerationRoutes as webAgentGeneration,
  webAgentSitesRoutes as webAgentSites,
} from "@fenix/agent-config/server";
import { webModelGatewayRoutes as webModelGateway } from "@fenix/model-management/server";
import { webChannelsRoutes } from "@fenix/resource-channel/server";
import {
  webApiKeysRoutes as webApiKeys,
  webBrandingRoutes as webBranding,
  webOrganizationsRoutes as webOrganizations,
} from "@fenix/resource-identity-admin/server";
import { webKnowledgeBaseRoutes as webKnowledgeBases } from "@fenix/resource-knowledge/server";
import {
  webFileEventsRoutes as webFileEvents,
  webFsRoutes as webFs,
  webRegistryRoutes as webRegistry,
} from "@fenix/resource-machine/server";
import { webHindsightRoutes as webHindsight } from "@fenix/resource-memory/server";
import { webProdViewsRoutes } from "@fenix/resource-prod-view/server";
import { webTasksV2Routes } from "@fenix/resource-task/server";
import {
  webWorkflowCustomTools,
  webWorkflowDefs,
  webWorkflowEngine,
  webWorkflowSse,
  workflowRunsRoutes,
} from "@fenix/resource-workflow/server";
import Elysia from "elysia";
import webConfig from "./config";
import webEnvironments from "./environments";
import webInstances from "./instances";
import webMetaAgent from "./meta-agent";
import webPeriTaskDetails from "./peri-task-details";
import webSidebarConfig from "./sidebar-config";

const webApp = new Elysia({ name: "web", prefix: "/web" })
  .use(webApiKeys)
  .use(webBranding)
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
