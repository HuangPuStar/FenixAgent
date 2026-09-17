export type ResourcePermissionType = "provider" | "skill" | "mcp_server" | "agent_config";
export type ResourcePermissionPrincipalType = "all" | "organization";
export type ResourcePermissionAction = "read";

export interface ResourcePermissionGrantRow {
  id: string;
  organizationId: string;
  resourceType: ResourcePermissionType;
  resourceId: string;
  principalType: ResourcePermissionPrincipalType;
  principalId: string | null;
  action: ResourcePermissionAction;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResourcePermissionOwnedRow {
  organizationId: string;
  resourceType: ResourcePermissionType;
  resourceId: string;
  grantCount: number;
  hasPublicRead: boolean;
}

export interface ResourcePermissionAccessibleRow {
  organizationId: string;
  resourceType: ResourcePermissionType;
  resourceId: string;
  hasPublicRead: boolean;
}

export interface CreateResourcePermissionGrantInput {
  organizationId: string;
  resourceType: ResourcePermissionType;
  resourceId: string;
  principalType: ResourcePermissionPrincipalType;
  principalId: string | null;
  action: ResourcePermissionAction;
  createdBy: string;
}

export interface DeleteResourcePermissionGrantInput {
  organizationId: string;
  resourceType: ResourcePermissionType;
  resourceId: string;
  principalType: ResourcePermissionPrincipalType;
  principalId: string | null;
  action: ResourcePermissionAction;
}

/** resource_permission 仓储接口。 */
export interface IResourcePermissionRepo {
  listByResource(
    organizationId: string,
    resourceType: ResourcePermissionType,
    resourceId: string,
  ): Promise<ResourcePermissionGrantRow[]>;
  createGrant(input: CreateResourcePermissionGrantInput): Promise<ResourcePermissionGrantRow>;
  deleteGrant(input: DeleteResourcePermissionGrantInput): Promise<boolean>;
  listOwnedByOrganization(
    organizationId: string,
    resourceType?: ResourcePermissionType,
  ): Promise<ResourcePermissionOwnedRow[]>;
  listAccessibleForPrincipal(
    organizationId: string,
    resourceType: ResourcePermissionType,
  ): Promise<ResourcePermissionAccessibleRow[]>;
  canReadExternalResource(
    ownerOrganizationId: string,
    resourceType: ResourcePermissionType,
    resourceId: string,
    organizationId: string,
  ): Promise<boolean>;
}

let runtimeRepo: IResourcePermissionRepo | undefined;

/** 宿主在启动期注入数据库实现；平台包不依赖具体 ORM 或应用装配层。 */
export function configureResourcePermissionRepository(repo: IResourcePermissionRepo): void {
  runtimeRepo = repo;
}

function requireRuntimeRepo(): IResourcePermissionRepo {
  if (!runtimeRepo) throw new Error("ResourcePermission repository has not been configured");
  return runtimeRepo;
}

/** 委托给宿主注入的持久化实现，保持调用方的稳定仓储接口。 */
export const resourcePermissionRepo: IResourcePermissionRepo = {
  listByResource: (...args) => requireRuntimeRepo().listByResource(...args),
  createGrant: (...args) => requireRuntimeRepo().createGrant(...args),
  deleteGrant: (...args) => requireRuntimeRepo().deleteGrant(...args),
  listOwnedByOrganization: (...args) => requireRuntimeRepo().listOwnedByOrganization(...args),
  listAccessibleForPrincipal: (...args) => requireRuntimeRepo().listAccessibleForPrincipal(...args),
  canReadExternalResource: (...args) => requireRuntimeRepo().canReadExternalResource(...args),
};
