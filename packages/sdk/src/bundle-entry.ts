const baseUrl = process.env.USER_META_BASE_URL;
const token = process.env.USER_META_API_KEY;

if (!baseUrl) {
  throw new Error("[agent-platform-api] Missing environment variable: USER_META_BASE_URL");
}
if (!token) {
  throw new Error("[agent-platform-api] Missing environment variable: USER_META_API_KEY");
}

const _originalFetch = globalThis.fetch;

globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  let url: string;
  if (typeof input === "string") {
    url = input.startsWith("/") ? baseUrl + input : input;
  } else if (input instanceof URL) {
    url = input.href;
  } else {
    url = input.url;
  }

  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
    Authorization: `Bearer ${token}`,
  };

  return _originalFetch(url, { ...init, headers });
};

export { BaseApi } from "./base";
export { AuthApi } from "./modules/auth";
export { ChannelApi } from "./modules/channel";
export { AgentApi, McpApi, ModelApi, ProviderApi, SkillConfigApi } from "./modules/config";
export { EnvironmentApi } from "./modules/environment";
export { FileApi, UserFileApi } from "./modules/file";
export { InstanceApi } from "./modules/instance";
export { KnowledgeBaseApi } from "./modules/knowledge";
export { MetaAgentApi } from "./modules/meta-agent";
export { ApiKeyApi, OrganizationApi } from "./modules/organization";
export { S3FileApi } from "./modules/s3-file";
export { ControlApi, SessionApi } from "./modules/session";
export { TaskApi } from "./modules/task";
export { V1EnvironmentApi } from "./modules/v1-environment";
export { V1SessionApi } from "./modules/v1-session";
export { V2CodeSessionApi } from "./modules/v2-code-session";
export { V2WorkerApi } from "./modules/v2-worker";
export { WorkflowDefApi } from "./modules/workflow-defs";
export { WorkflowEngineApi } from "./modules/workflow-engine";
