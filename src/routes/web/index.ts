import Elysia from "elysia";
import webAuth from "./auth";
import webBranding from "./branding";
import webChannels from "./channels";
import webConfig from "./config";
import webControl from "./control";
import webEnvironments from "./environments";
import webFiles from "./files";
import webKnowledgeBases from "./knowledge-bases";
import webMetaAgent from "./meta-agent";
import webOrganizations from "./organizations";
import webRegistry from "./registry";
import webS3Files from "./s3-files";
import webSessions from "./sessions";
import webSkills from "./skills";
import webTasks from "./tasks";
import webUserFile from "./user-file";
import webWorkflowBoards from "./workflow-boards";
import webWorkflowDefs from "./workflow-defs";
import webWorkflowEngine from "./workflow-engine";
import webWorkflowJobs from "./workflow-jobs";
import webWorkflowJobsLogs from "./workflow-jobs-logs";
import webWorkflowJobsSse from "./workflow-jobs-sse";
import webWorkflowSse from "./workflow-sse";
import webWorkflowStats from "./workflow-stats";

const webApp = new Elysia({ name: "web", prefix: "/web" })
  .use(webBranding)
  .use(webAuth)
  .use(webChannels)
  .use(webConfig)
  .use(webControl)
  .use(webFiles)
  .use(webKnowledgeBases)
  .use(webMetaAgent)
  .use(webOrganizations)
  .use(webS3Files)
  .use(webSessions)
  .use(webSkills)
  .use(webTasks)
  .use(webUserFile)
  .use(webEnvironments)
  .use(webRegistry)
  .use(webWorkflowDefs)
  .use(webWorkflowEngine)
  .use(webWorkflowJobs)
  .use(webWorkflowJobsSse)
  .use(webWorkflowJobsLogs)
  .use(webWorkflowStats)
  .use(webWorkflowBoards)
  .use(webWorkflowSse);

export default webApp;
