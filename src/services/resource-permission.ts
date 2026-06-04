import { AppError } from "../errors";
import type { AuthContext } from "../plugins/auth";
import { type IOrganizationRepo, organizationRepo } from "../repositories/organization";
import {
  type IResourcePermissionRepo,
  type ResourcePermissionAccessibleRow,
  type ResourcePermissionType,
  resourcePermissionRepo,
} from "../repositories/resource-permission";
import type { ResourceAccess, ResourceAccessInput } from "./config/types";

export const _deps: { repo: IResourcePermissionRepo; organizationRepo: IOrganizationRepo } = {
  organizationRepo,
  repo: resourcePermissionRepo,
};

export function _resetDeps() {
  _deps.organizationRepo = organizationRepo;
  _deps.repo = resourcePermissionRepo;
}

export function setResourcePermissionRepoForTesting(repo: IResourcePermissionRepo) {
  _deps.repo = repo;
}

export function setOrganizationRepoForTesting(repo: IOrganizationRepo) {
  _deps.organizationRepo = repo;
}

export function buildResourceAccess(
  ctx: AuthContext,
  _resourceType: ResourcePermissionType,
  row: ResourceAccessInput,
  publicReadable?: boolean,
  sourceOrganizationName?: string,
): ResourceAccess {
  const internal = row.organizationId === ctx.organizationId;
  return {
    ownership: internal ? "internal" : "external",
    sourceOrganizationId: row.organizationId,
    sourceOrganizationName,
    resourceUid: row.id,
    resourceKey: `${row.organizationId}/${row.id}`,
    // Public-read toggles go through the original resource write APIs, which only
    // require the resource to belong to the current organization.
    manageable: internal,
    writable: internal,
    publicReadable: internal ? publicReadable : undefined,
  };
}

export async function listReadableResourceRefs(ctx: AuthContext, resourceType: ResourcePermissionType) {
  const rows = await _deps.repo.listAccessibleForPrincipal(ctx.organizationId, resourceType);
  return rows.filter((row) => row.organizationId !== ctx.organizationId);
}

export async function getPublicReadMap(ctx: AuthContext, resourceType: ResourcePermissionType, resourceIds: string[]) {
  const idSet = new Set(resourceIds);
  const rows = await _deps.repo.listOwnedByOrganization(ctx.organizationId, resourceType);
  return new Map(rows.filter((row) => idSet.has(row.resourceId)).map((row) => [row.resourceId, row.hasPublicRead]));
}

export async function decorateResourceAccess<T extends ResourceAccessInput>(
  ctx: AuthContext,
  resourceType: ResourcePermissionType,
  rows: T[],
): Promise<(T & { resourceAccess: ResourceAccess })[]> {
  const internalIds = rows.filter((row) => row.organizationId === ctx.organizationId).map((row) => row.id);
  const publicReadMap = await getPublicReadMap(ctx, resourceType, internalIds);
  const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
  const organizationNameMap = await _deps.organizationRepo.listNamesByIds(organizationIds);

  return rows.map((row) => ({
    ...row,
    resourceAccess: buildResourceAccess(
      ctx,
      resourceType,
      row,
      publicReadMap.get(row.id) ?? false,
      organizationNameMap.get(row.organizationId),
    ),
  }));
}

export async function setPublicRead(
  ctx: AuthContext,
  resourceType: ResourcePermissionType,
  ownerOrganizationId: string,
  resourceId: string,
  enabled: boolean,
) {
  assertInternalWritable(ctx, resourceType, resourceId, ownerOrganizationId);
  if (enabled) {
    return _deps.repo.createGrant({
      organizationId: ownerOrganizationId,
      resourceType,
      resourceId,
      principalType: "all",
      principalId: null,
      action: "read",
      createdBy: ctx.userId,
    });
  }
  return _deps.repo.deleteGrant({
    organizationId: ownerOrganizationId,
    resourceType,
    resourceId,
    principalType: "all",
    principalId: null,
    action: "read",
  });
}

export async function canReadResource(
  ctx: AuthContext,
  resourceType: ResourcePermissionType,
  resourceId: string,
  ownerOrganizationId: string,
) {
  if (ownerOrganizationId === ctx.organizationId) return true;
  return _deps.repo.canReadExternalResource(ownerOrganizationId, resourceType, resourceId, ctx.organizationId);
}

export function assertInternalWritable(
  ctx: AuthContext,
  _resourceType: ResourcePermissionType,
  _resourceId: string,
  ownerOrganizationId: string,
) {
  if (ownerOrganizationId !== ctx.organizationId) {
    throw new AppError("External resource is read-only", "FORBIDDEN", 403);
  }
}

export type { ResourcePermissionAccessibleRow, ResourcePermissionType };
