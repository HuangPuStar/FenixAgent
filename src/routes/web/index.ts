import {
  webAgentGenerationRoutes as webAgentGeneration,
  webAgentSitesRoutes as webAgentSites,
} from "@fenix/agent-config/server";
import { webModelGatewayRoutes as webModelGateway } from "@fenix/model-management/server";
import { webChannelsRoutes } from "@fenix/resource-channel/server";
import { webKnowledgeBaseRoutes as webKnowledgeBases } from "@fenix/resource-knowledge/server";
import { webHindsightRoutes as webHindsight } from "@fenix/resource-memory/server";
import { webTasksV2Routes } from "@fenix/resource-task/server";
import {
  webWorkflowCustomTools,
  webWorkflowDefs,
  webWorkflowEngine,
  webWorkflowSse,
  workflowRunsRoutes,
} from "@fenix/resource-workflow/server";
import Elysia from "elysia";
import webApiKeys from "./api-keys";
import webBranding from "./branding";
import webConfig from "./config";
import webEnvironments from "./environments";
import webFileEvents from "./file-events";
import webFs from "./fs";
import webInstances from "./instances";
import webMetaAgent from "./meta-agent";
import webOrganizations from "./organizations";
import webPeriTaskDetails from "./peri-task-details";
import webProdViews from "./prod-views";
import webRegistry from "./registry";
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
  .use(webProdViews)
  .use(webAgentGeneration);

export default webApp;
