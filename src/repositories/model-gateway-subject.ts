import { and, asc, eq, ilike, or } from "drizzle-orm";
import { db } from "../db";
import { member, user } from "../db/schema";
import type { SystemApiUserRecord } from "../services/system-api";

export interface ModelGatewayUserSearchInput {
  keyword?: string;
  organizationId?: string;
  userId?: string;
}

function buildUserConditions(input: ModelGatewayUserSearchInput) {
  const conditions = [];
  if (input.organizationId) {
    conditions.push(eq(member.organizationId, input.organizationId));
  }
  if (input.userId) conditions.push(eq(user.id, input.userId));
  if (input.keyword?.trim()) {
    const keyword = `%${input.keyword.trim()}%`;
    conditions.push(or(ilike(user.name, keyword), ilike(user.email, keyword), ilike(user.phoneNumber, keyword)));
  }
  return conditions;
}

/** 查询符合管理端主体条件的用户，组织维度通过成员关系限定。 */
export async function findModelGatewayUsers(input: ModelGatewayUserSearchInput): Promise<SystemApiUserRecord[]> {
  const conditions = buildUserConditions(input);
  const fields = {
    id: user.id,
    name: user.name,
    email: user.email,
    emailVerified: user.emailVerified,
    phoneNumber: user.phoneNumber,
    phoneNumberVerified: user.phoneNumberVerified,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
  if (input.organizationId) {
    return db
      .select(fields)
      .from(user)
      .innerJoin(member, eq(member.userId, user.id))
      .where(and(...conditions))
      .orderBy(asc(user.createdAt), asc(user.id));
  }
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      phoneNumber: user.phoneNumber,
      phoneNumberVerified: user.phoneNumberVerified,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })
    .from(user)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(user.createdAt), asc(user.id));
}
