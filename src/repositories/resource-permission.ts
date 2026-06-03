import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { resourcePermission } from "../db/schema";

export type ResourcePermissionType = "provider" | "skill" | "mcp_server";
export type ResourcePermissionPrincipalType = "all" | "organization";
export type ResourcePermissionAction = "read";

export type ResourcePermissionGrantRow = typeof resourcePermission.$inferSelect;

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

function grantIdentityWhere(input: {
  organizationId: string;
  resourceType: ResourcePermissionType;
  resourceId: string;
  principalType: ResourcePermissionPrincipalType;
  principalId: string | null;
  action: ResourcePermissionAction;
}) {
  return and(
    eq(resourcePermission.organizationId, input.organizationId),
    eq(resourcePermission.resourceType, input.resourceType),
    eq(resourcePermission.resourceId, input.resourceId),
    eq(resourcePermission.principalType, input.principalType),
    input.principalId === null
      ? isNull(resourcePermission.principalId)
      : eq(resourcePermission.principalId, input.principalId),
    eq(resourcePermission.action, input.action),
  );
}

class PgResourcePermissionRepo implements IResourcePermissionRepo {
  async listByResource(organizationId: string, resourceType: ResourcePermissionType, resourceId: string) {
    return db
      .select()
      .from(resourcePermission)
      .where(
        and(
          eq(resourcePermission.organizationId, organizationId),
          eq(resourcePermission.resourceType, resourceType),
          eq(resourcePermission.resourceId, resourceId),
        ),
      );
  }

  async createGrant(input: CreateResourcePermissionGrantInput) {
    const existing = await db.select().from(resourcePermission).where(grantIdentityWhere(input)).limit(1);
    if (existing[0]) {
      return existing[0];
    }

    const [created] = await db
      .insert(resourcePermission)
      .values({
        organizationId: input.organizationId,
        resourceType: input.resourceType,
        resourceId: input.resourceId,
        principalType: input.principalType,
        principalId: input.principalId,
        action: input.action,
        createdBy: input.createdBy,
        updatedAt: new Date(),
      })
      .returning();
    return created;
  }

  async deleteGrant(input: DeleteResourcePermissionGrantInput) {
    const deleted = await db
      .delete(resourcePermission)
      .where(grantIdentityWhere(input))
      .returning({ id: resourcePermission.id });
    return deleted.length > 0;
  }

  async listOwnedByOrganization(organizationId: string, resourceType?: ResourcePermissionType) {
    const rows = await db
      .select({
        organizationId: resourcePermission.organizationId,
        resourceType: resourcePermission.resourceType,
        resourceId: resourcePermission.resourceId,
        grantCount: sql<number>`count(*)`,
        hasPublicRead: sql<boolean>`bool_or(${resourcePermission.principalType} = 'all')`,
      })
      .from(resourcePermission)
      .where(
        resourceType
          ? and(
              eq(resourcePermission.organizationId, organizationId),
              eq(resourcePermission.resourceType, resourceType),
            )
          : eq(resourcePermission.organizationId, organizationId),
      )
      .groupBy(resourcePermission.organizationId, resourcePermission.resourceType, resourcePermission.resourceId);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      grantCount: Number(row.grantCount),
      hasPublicRead: Boolean(row.hasPublicRead),
    }));
  }

  async listAccessibleForPrincipal(organizationId: string, resourceType: ResourcePermissionType) {
    const rows = await db
      .select({
        organizationId: resourcePermission.organizationId,
        resourceType: resourcePermission.resourceType,
        resourceId: resourcePermission.resourceId,
        hasPublicRead: sql<boolean>`bool_or(${resourcePermission.principalType} = 'all')`,
      })
      .from(resourcePermission)
      .where(
        and(
          eq(resourcePermission.resourceType, resourceType),
          eq(resourcePermission.action, "read"),
          or(
            and(eq(resourcePermission.principalType, "all"), isNull(resourcePermission.principalId)),
            and(
              eq(resourcePermission.principalType, "organization"),
              eq(resourcePermission.principalId, organizationId),
            ),
          ),
        ),
      )
      .groupBy(resourcePermission.organizationId, resourcePermission.resourceType, resourcePermission.resourceId);

    return rows.map((row) => ({
      organizationId: row.organizationId,
      resourceType: row.resourceType,
      resourceId: row.resourceId,
      hasPublicRead: Boolean(row.hasPublicRead),
    }));
  }

  async canReadExternalResource(
    ownerOrganizationId: string,
    resourceType: ResourcePermissionType,
    resourceId: string,
    organizationId: string,
  ) {
    const rows = await db
      .select({ id: resourcePermission.id })
      .from(resourcePermission)
      .where(
        and(
          eq(resourcePermission.organizationId, ownerOrganizationId),
          eq(resourcePermission.resourceType, resourceType),
          eq(resourcePermission.resourceId, resourceId),
          eq(resourcePermission.action, "read"),
          or(
            and(eq(resourcePermission.principalType, "all"), isNull(resourcePermission.principalId)),
            and(
              eq(resourcePermission.principalType, "organization"),
              eq(resourcePermission.principalId, organizationId),
            ),
          ),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }
}

export const resourcePermissionRepo: IResourcePermissionRepo = new PgResourcePermissionRepo();
