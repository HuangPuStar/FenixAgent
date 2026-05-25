import Elysia from "elysia";
import webAuth from "./auth";
import webChannels from "./channels";
import webConfig from "./config";
import webControl from "./control";
import webEnvironments from "./environments";
import webFiles from "./files";
import webInstances from "./instances";
import webKnowledgeBases from "./knowledge-bases";
import webMetaAgent from "./meta-agent";
import webOrganizations from "./organizations";
import webS3Files from "./s3-files";
import webSessions from "./sessions";
import webSkills from "./skills";
import webTasks from "./tasks";
import webUserFile from "./user-file";
import webWorkflowDefs from "./workflow-defs";
import webWorkflowEngine from "./workflow-engine";
import webWorkflowSse from "./workflow-sse";

const webApp = new Elysia({ name: "web", prefix: "/web" })
  .use(webAuth)
  .use(webChannels)
  .use(webConfig)
  .use(webControl)
  .use(webEnvironments)
  .use(webFiles)
  .use(webInstances)
  .use(webKnowledgeBases)
  .use(webMetaAgent)
  .use(webOrganizations)
  .use(webS3Files)
  .use(webSessions)
  .use(webSkills)
  .use(webTasks)
  .use(webUserFile)
  .use(webWorkflowDefs)
  .use(webWorkflowEngine)
  .use(webWorkflowSse);

export default webApp;
