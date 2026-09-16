import {
  type IResourcePermissionRepo,
  type ResourcePermissionAccessibleRow,
  type ResourcePermissionType,
  resourcePermissionRepo,
} from "./repositories/resource-permission";
import type { ResourceAccess, ResourceAccessInput } from "./resource-access";

/** 授权服务仅需的认证上下文，避免平台包反向依赖宿主认证实现。 */
export interface ResourcePermissionAuthContext {
  organizationId: string;
  userId: string;
  role: string;
}

/** 授权服务使用的组织名称查询端口。 */
export interface ResourcePermissionOrganizationRepo {
  listNamesByIds(ids: string[]): Promise<Map<string, string>>;
}

export interface ResourcePermissionError extends Error {
  code: string;
  statusCode: number;
}

type ResourcePermissionErrorFactory = (message: string, code: string, statusCode: number) => ResourcePermissionError;

function createDefaultForbiddenError(message: string, code: string, statusCode: number): ResourcePermissionError {
  return Object.assign(new Error(message), { code, statusCode });
}

export const _deps: {
  repo: IResourcePermissionRepo;
  organizationRepo?: ResourcePermissionOrganizationRepo;
  createError: ResourcePermissionErrorFactory;
} = {
  repo: resourcePermissionRepo,
  createError: createDefaultForbiddenError,
};

export function _resetDeps() {
  _deps.repo = resourcePermissionRepo;
  _deps.organizationRepo = undefined;
  _deps.createError = createDefaultForbiddenError;
}

export function setResourcePermissionRepoForTesting(repo: IResourcePermissionRepo) {
  _deps.repo = repo;
}

/** 由宿主装配组织查询端口及标准错误构造器。 */
export function configureResourcePermissionService(input: {
  organizationRepo: ResourcePermissionOrganizationRepo;
  createError: ResourcePermissionErrorFactory;
}) {
  _deps.organizationRepo = input.organizationRepo;
  _deps.createError = input.createError;
}

export function setOrganizationRepoForTesting(repo: ResourcePermissionOrganizationRepo) {
  _deps.organizationRepo = repo;
}

export function buildResourceAccess(
  ctx: ResourcePermissionAuthContext,
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

/** 将可读资源引用转换为按来源组织和资源 ID 索引的公开状态。 */
export function buildExternalPublicReadMap(refs: ResourcePermissionAccessibleRow[]): Map<string, boolean> {
  return new Map(refs.map((ref) => [`${ref.organizationId}/${ref.resourceId}`, ref.hasPublicRead]));
}

export async function listReadableResourceRefs(
  ctx: ResourcePermissionAuthContext,
  resourceType: ResourcePermissionType,
) {
  const rows = await _deps.repo.listAccessibleForPrincipal(ctx.organizationId, resourceType);
  return rows.filter((row) => row.organizationId !== ctx.organizationId);
}

export async function getPublicReadMap(
  ctx: ResourcePermissionAuthContext,
  resourceType: ResourcePermissionType,
  resourceIds: string[],
) {
  const idSet = new Set(resourceIds);
  const rows = await _deps.repo.listOwnedByOrganization(ctx.organizationId, resourceType);
  return new Map(rows.filter((row) => idSet.has(row.resourceId)).map((row) => [row.resourceId, row.hasPublicRead]));
}

export async function decorateResourceAccess<T extends ResourceAccessInput>(
  ctx: ResourcePermissionAuthContext,
  resourceType: ResourcePermissionType,
  rows: T[],
  externalPublicReadMap: ReadonlyMap<string, boolean> = new Map(),
): Promise<(T & { resourceAccess: ResourceAccess })[]> {
  const internalIds = rows.filter((row) => row.organizationId === ctx.organizationId).map((row) => row.id);
  const publicReadMap = await getPublicReadMap(ctx, resourceType, internalIds);
  const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
  const organizationNameMap = await _deps.organizationRepo?.listNamesByIds(organizationIds);

  return rows.map((row) => ({
    ...row,
    resourceAccess: buildResourceAccess(
      ctx,
      resourceType,
      row,
      row.organizationId === ctx.organizationId
        ? (publicReadMap.get(row.id) ?? false)
        : externalPublicReadMap.get(`${row.organizationId}/${row.id}`),
      organizationNameMap?.get(row.organizationId),
    ),
  }));
}

export async function setPublicRead(
  ctx: ResourcePermissionAuthContext,
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
  ctx: ResourcePermissionAuthContext,
  resourceType: ResourcePermissionType,
  resourceId: string,
  ownerOrganizationId: string,
) {
  if (ownerOrganizationId === ctx.organizationId) return true;
  return _deps.repo.canReadExternalResource(ownerOrganizationId, resourceType, resourceId, ctx.organizationId);
}

export function assertInternalWritable(
  ctx: ResourcePermissionAuthContext,
  _resourceType: ResourcePermissionType,
  _resourceId: string,
  ownerOrganizationId: string,
) {
  if (ownerOrganizationId !== ctx.organizationId) {
    throw _deps.createError("External resource is read-only", "FORBIDDEN", 403);
  }
}

export type { ResourcePermissionAccessibleRow, ResourcePermissionType };
