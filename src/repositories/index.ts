export type { AgentSiteAppInsert, AgentSiteAppRow, Visibility } from "./agent-site-app";
export { agentSiteAppRepo } from "./agent-site-app";
export type { ChannelBindingInsert, ChannelBindingRow, IChannelBindingRepo } from "./channel-binding";
export { channelBindingRepo } from "./channel-binding";
export type {
  EnvironmentCreateParams,
  EnvironmentRecord,
  EnvironmentUpdateParams,
  IEnvironmentRepo,
} from "./environment";
export { environmentRepo } from "./environment";
export type {
  AgentKnowledgeBindingRow,
  IAgentKnowledgeBindingRepo,
  IKnowledgeBaseRepo,
  IKnowledgeResourceRepo,
  KnowledgeBaseRow,
  KnowledgeResourceRow,
} from "./knowledge-base";
export { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "./knowledge-base";
export type { IOrganizationRepo } from "./organization";
export { organizationRepo } from "./organization";
export type {
  CreateResourcePermissionGrantInput,
  DeleteResourcePermissionGrantInput,
  IResourcePermissionRepo,
  ResourcePermissionAccessibleRow,
  ResourcePermissionAction,
  ResourcePermissionGrantRow,
  ResourcePermissionOwnedRow,
  ResourcePermissionPrincipalType,
  ResourcePermissionType,
} from "./resource-permission";
export { resourcePermissionRepo } from "./resource-permission";
export type { ISessionRepo, SessionCreateParams, SessionRecord } from "./session";
export { sessionRepo } from "./session";
export type { IShareLinkRepo } from "./share-link";
export { shareLinkRepo } from "./share-link";
export type { IScheduledTaskRepo, ITaskExecutionLogRepo, ScheduledTaskRow, TaskExecutionLogRow } from "./task";
export { scheduledTaskRepo, taskExecutionLogRepo } from "./task";
export type { ITokenRepo, TokenRecord } from "./token";
export { tokenRepo } from "./token";
export type { AuthCtx as WorkflowAuthCtx, WorkflowDefRow, WorkflowVersionRow } from "./workflow-def";
export {
  createWorkflowDef,
  deleteWorkflowDef,
  getVersions,
  getVersionYaml,
  getWorkflowDef,
  listRecoverableWorkflows,
  listWorkflowDefs,
  publishVersion,
  recoverWorkflows,
  restoreVersionToDraft,
  saveDraft,
  setLatestVersion,
  updateWorkflowMeta,
} from "./workflow-def";
export type { IWorkflowTriggerRepo, WorkflowTriggerInsert, WorkflowTriggerRow } from "./workflow-trigger";
export { workflowTriggerRepo } from "./workflow-trigger";

import { sessionRepo } from "./session";
import { tokenRepo } from "./token";

/** 重置所有内存仓储（仅用于测试） */
export function resetAllRepos(): void {
  if (typeof sessionRepo?.reset === "function") sessionRepo.reset();
  if (typeof tokenRepo?.reset === "function") tokenRepo.reset();
}
