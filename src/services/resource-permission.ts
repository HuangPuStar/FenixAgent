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
    publicReadable,
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

/** 查询外部资源的公开可读状态，按 (organizationId, resourceId) 索引 */
async function getExternalPublicReadMap(
  ctx: AuthContext,
  resourceType: ResourcePermissionType,
  orgIdResourceIdPairs: { organizationId: string; resourceId: string }[],
): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  for (const { organizationId, resourceId } of orgIdResourceIdPairs) {
    // 检查外部资源是否有 public read grant（principalType === "all"）
    const rows = await _deps.repo.listByResource(organizationId, resourceType, resourceId);
    map.set(
      `${organizationId}/${resourceId}`,
      rows.some((r) => r.principalType === "all" && r.principalId === null),
    );
  }
  return map;
}

export async function decorateResourceAccess<T extends ResourceAccessInput>(
  ctx: AuthContext,
  resourceType: ResourcePermissionType,
  rows: T[],
): Promise<(T & { resourceAccess: ResourceAccess })[]> {
  const internalIds = rows.filter((row) => row.organizationId === ctx.organizationId).map((row) => row.id);
  const publicReadMap = await getPublicReadMap(ctx, resourceType, internalIds);

  // 查询外部资源的公开可读状态
  const externalPairs = rows
    .filter((row) => row.organizationId !== ctx.organizationId)
    .map((row) => ({ organizationId: row.organizationId, resourceId: row.id }));
  const externalPublicReadMap =
    externalPairs.length > 0
      ? await getExternalPublicReadMap(ctx, resourceType, externalPairs)
      : new Map<string, boolean>();

  const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
  const organizationNameMap = await _deps.organizationRepo.listNamesByIds(organizationIds);

  return rows.map((row) => {
    const isInternal = row.organizationId === ctx.organizationId;
    const publicReadable = isInternal
      ? (publicReadMap.get(row.id) ?? false)
      : (externalPublicReadMap.get(`${row.organizationId}/${row.id}`) ?? false);
    return {
      ...row,
      resourceAccess: buildResourceAccess(
        ctx,
        resourceType,
        row,
        publicReadable,
        organizationNameMap.get(row.organizationId),
      ),
    };
  });
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
