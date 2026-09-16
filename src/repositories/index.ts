export type { IOrganizationRepo } from "@fenix/resource-identity-admin/server/repository";
export { organizationRepo } from "@fenix/resource-identity-admin/server/repository";
export type {
  AgentKnowledgeBindingRow,
  IAgentKnowledgeBindingRepo,
  IKnowledgeBaseRepo,
  IKnowledgeResourceRepo,
  KnowledgeBaseRow,
  KnowledgeResourceRow,
} from "@fenix/resource-knowledge/server";
export { agentKnowledgeBindingRepo, knowledgeBaseRepo, knowledgeResourceRepo } from "@fenix/resource-knowledge/server";
export { agentEngineRepo } from "./agent-engine";
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
export type { IShareLinkRepo } from "./share-link";
export { shareLinkRepo } from "./share-link";
export type { ITokenRepo, TokenRecord } from "./token";
export { tokenRepo } from "./token";
export { findUsersBasicInfoByIds } from "./user";

import { tokenRepo } from "./token";

/** 重置所有内存仓储（仅用于测试） */
export function resetAllRepos(): void {
  if (typeof tokenRepo?.reset === "function") tokenRepo.reset();
}
