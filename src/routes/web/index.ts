import Elysia from "elysia";
import webAgentGeneration from "./agent-generation";
import webAgentSites from "./agent-sites";
import webApiKeys from "./api-keys";
import webBranding from "./branding";
import webChannels from "./channels";
import webConfig from "./config";
import webControl from "./control";
import webEnvironments from "./environments";
import webFiles from "./files";
import webFs from "./fs";
import webHindsight from "./hindsight";
import webInstances from "./instances";
import webKnowledgeBases from "./knowledge-bases";
import webMetaAgent from "./meta-agent";
import webOrganizations from "./organizations";
import webProdViews from "./prod-views";
import webProxyImage from "./proxy-image";
import webRegistry from "./registry";
import webSidebarConfig from "./sidebar-config";
import webTasks from "./tasks";
import webTasksV2 from "./tasks-v2";
import webUserFile from "./user-file";
import webWorkflowCustomTools from "./workflow-custom-tools";
import webWorkflowDefs from "./workflow-defs";
import webWorkflowEngine from "./workflow-engine";
import { workflowRunsRoutes } from "./workflow-runs";
import webWorkflowSse from "./workflow-sse";

const webApp = new Elysia({ name: "web", prefix: "/web" })
  .use(webApiKeys)
  .use(webBranding)
  .use(webSidebarConfig)
  .use(webAgentSites)
  .use(webChannels)
  .use(webConfig)
  .use(webControl)
  .use(webFiles)
  .use(webFs)
  .use(webInstances)
  .use(webHindsight)
  .use(webKnowledgeBases)
  .use(webMetaAgent)
  .use(webOrganizations)
  .use(webProdViews)
  .use(webProxyImage)
  .use(webRegistry)
  .use(webTasks)
  .use(webTasksV2)
  .use(webUserFile)
  .use(webEnvironments)
  .use(webWorkflowDefs)
  .use(webWorkflowCustomTools)
  .use(webWorkflowEngine)
  .use(webWorkflowSse)
  .use(workflowRunsRoutes)
  .use(webAgentGeneration);

export default webApp;
