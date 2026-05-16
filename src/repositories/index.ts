export { environmentRepo } from "./environment";
export type { EnvironmentRecord, EnvironmentCreateParams, EnvironmentUpdateParams, IEnvironmentRepo } from "./environment";

export { sessionRepo } from "./session";
export type { SessionRecord, SessionCreateParams, ISessionRepo } from "./session";

export { sessionWorkerRepo } from "./session-worker";
export type { SessionWorkerRecord, ISessionWorkerRepo } from "./session-worker";

export { shareLinkRepo } from "./share-link";
export type { IShareLinkRepo } from "./share-link";

export { tokenRepo } from "./token";
export type { TokenRecord, ITokenRepo } from "./token";

export { workItemRepo } from "./work-item";
export type { WorkItemRecord, IWorkItemRepo } from "./work-item";

export { scheduledTaskRepo, taskExecutionLogRepo } from "./task";
export type { IScheduledTaskRepo, ITaskExecutionLogRepo, ScheduledTaskRow, TaskExecutionLogRow } from "./task";

export { channelBindingRepo } from "./channel-binding";
export type { IChannelBindingRepo, ChannelBindingRow, ChannelBindingInsert } from "./channel-binding";

export { knowledgeBaseRepo, knowledgeResourceRepo, agentKnowledgeBindingRepo } from "./knowledge-base";
export type {
  IKnowledgeBaseRepo,
  IKnowledgeResourceRepo,
  IAgentKnowledgeBindingRepo,
  KnowledgeBaseRow,
  KnowledgeResourceRow,
  AgentKnowledgeBindingRow,
} from "./knowledge-base";

import { sessionRepo } from "./session";
import { tokenRepo } from "./token";
import { workItemRepo } from "./work-item";
import { sessionWorkerRepo } from "./session-worker";

/** 重置所有内存仓储（仅用于测试） */
export function resetAllRepos(): void {
  sessionRepo.reset();
  tokenRepo.reset();
  workItemRepo.reset();
  sessionWorkerRepo.reset();
}
