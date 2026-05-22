/**
 * sdk.ts — 前端 SDK 实例工厂
 *
 * 所有模块类无状态，可以安全复用单例。
 * 前端通过 `import { envApi, sessionApi } from "@/src/api/sdk"` 使用。
 */

import {
  EnvironmentApi,
  SessionApi,
  ControlApi,
  InstanceApi,
  TaskApi,
  FileApi,
  UserFileApi,
  S3FileApi,
  KnowledgeBaseApi,
  ChannelApi,
  ProviderApi,
  ModelApi,
  AgentApi,
  SkillConfigApi,
  McpApi,
  OrganizationApi,
  ApiKeyApi,
  WorkflowEngineApi,
  WorkflowDefApi,
  MetaAgentApi,
  AuthApi,
  V1EnvironmentApi,
  V1SessionApi,
  V2CodeSessionApi,
  V2WorkerApi,
} from "@mothership/sdk";

// ── Web 模块 ──
export const envApi = new EnvironmentApi();
export const sessionApi = new SessionApi();
export const controlApi = new ControlApi();
export const instanceApi = new InstanceApi();
export const taskApi = new TaskApi();
export const fileApi = new FileApi();
export const userFileApi = new UserFileApi();
export const s3FileApi = new S3FileApi();
export const kbApi = new KnowledgeBaseApi();
export const channelApi = new ChannelApi();
export const providerApi = new ProviderApi();
export const modelApi = new ModelApi();
export const agentApi = new AgentApi();
export const skillConfigApi = new SkillConfigApi();
export const mcpApi = new McpApi();
export const orgApi = new OrganizationApi();
export const apiKeyApi = new ApiKeyApi();
export const workflowEngineApi = new WorkflowEngineApi();
export const workflowDefApi = new WorkflowDefApi();
export const metaAgentApi = new MetaAgentApi();
export const authApi = new AuthApi();

// ── V1/V2 模块（一般前端不直接使用，保留导出） ──
export const v1EnvApi = new V1EnvironmentApi();
export const v1SessionApi = new V1SessionApi();
export const v2CodeSessionApi = new V2CodeSessionApi();
export const v2WorkerApi = new V2WorkerApi();
