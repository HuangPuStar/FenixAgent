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
export type { ISessionWorkerRepo, SessionWorkerRecord } from "./session-worker";
export { sessionWorkerRepo } from "./session-worker";
export type { IShareLinkRepo } from "./share-link";
export { shareLinkRepo } from "./share-link";
export type { IScheduledTaskRepo, ITaskExecutionLogRepo, ScheduledTaskRow, TaskExecutionLogRow } from "./task";
export { scheduledTaskRepo, taskExecutionLogRepo } from "./task";
export type { ITokenRepo, TokenRecord } from "./token";
export { tokenRepo } from "./token";
export type { IWorkItemRepo, WorkItemRecord } from "./work-item";
export { workItemRepo } from "./work-item";
export type { WorkflowBoardRow } from "./workflow-board";
export {
  createBoard,
  deleteBoard,
  ensureDefaultBoard,
  getBoard,
  getDefaultBoard,
  listBoards,
  updateBoard,
} from "./workflow-board";
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
export type { JobStatus, WorkflowJobListItem, WorkflowJobRow } from "./workflow-job";
export {
  createJob,
  deleteJob,
  getJob,
  listJobs,
  updateJobParams,
  updateJobStatus,
} from "./workflow-job";
export type { IWorkflowTriggerRepo, WorkflowTriggerInsert, WorkflowTriggerRow } from "./workflow-trigger";
export { workflowTriggerRepo } from "./workflow-trigger";

import { sessionRepo } from "./session";
import { sessionWorkerRepo } from "./session-worker";
import { tokenRepo } from "./token";
import { workItemRepo } from "./work-item";

/** 重置所有内存仓储（仅用于测试） */
export function resetAllRepos(): void {
  if (typeof sessionRepo?.reset === "function") sessionRepo.reset();
  if (typeof tokenRepo?.reset === "function") tokenRepo.reset();
  if (typeof workItemRepo?.reset === "function") workItemRepo.reset();
  if (typeof sessionWorkerRepo?.reset === "function") sessionWorkerRepo.reset();
}
