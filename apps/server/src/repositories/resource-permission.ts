import type {
  CreateResourcePermissionGrantInput,
  DeleteResourcePermissionGrantInput,
  IResourcePermissionRepo,
} from "@fenix/access-control/server";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../db";
import { resourcePermission } from "../db/schema";

function grantIdentityWhere(input: CreateResourcePermissionGrantInput | DeleteResourcePermissionGrantInput) {
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

/** PostgreSQL 持久化实现仅属于 server 宿主，平台包通过端口调用。 */
export const pgResourcePermissionRepo: IResourcePermissionRepo = {
  async listByResource(organizationId, resourceType, resourceId) {
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
  },
  async createGrant(input) {
    const existing = await db.select().from(resourcePermission).where(grantIdentityWhere(input)).limit(1);
    if (existing[0]) return existing[0];
    const [created] = await db
      .insert(resourcePermission)
      .values({ ...input, updatedAt: new Date() })
      .returning();
    return created;
  },
  async deleteGrant(input) {
    const deleted = await db
      .delete(resourcePermission)
      .where(grantIdentityWhere(input))
      .returning({ id: resourcePermission.id });
    return deleted.length > 0;
  },
  async listOwnedByOrganization(organizationId, resourceType) {
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
      ...row,
      grantCount: Number(row.grantCount),
      hasPublicRead: Boolean(row.hasPublicRead),
    }));
  },
  async listAccessibleForPrincipal(organizationId, resourceType) {
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
    return rows.map((row) => ({ ...row, hasPublicRead: Boolean(row.hasPublicRead) }));
  },
  async canReadExternalResource(ownerOrganizationId, resourceType, resourceId, organizationId) {
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
  },
};
