import { and, eq, ilike, inArray, or } from "drizzle-orm";
import { db } from "../db";
import { member, user } from "../db/schema";
import { normalizeChineseMainlandPhoneNumber } from "../services/phone-number";

/**
 * 查询用户在各组织下的成员角色映射。
 */
export async function findMembershipRolesByUserId(userId: string) {
  return db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .execute();
}

/**
 * 批量查询用户手机号，用于补全 better-auth 返回的成员信息。
 */
export async function findUsersPhoneNumbersByIds(userIds: string[]) {
  if (userIds.length === 0) return [];

  return db
    .select({ id: user.id, phoneNumber: user.phoneNumber })
    .from(user)
    .where(inArray(user.id, userIds))
    .execute();
}

/**
 * 在全站用户中搜索组织成员候选项。
 */
export async function searchOrganizationMemberCandidates(keyword: string) {
  const trimmed = keyword.trim();
  const compact = trimmed.replace(/[\s()-]+/g, "");
  const conditions = [ilike(user.name, `%${trimmed}%`), ilike(user.email, `%${trimmed}%`)];

  if (compact) {
    conditions.push(ilike(user.phoneNumber, `%${compact}%`));
  }

  try {
    const normalizedPhone = normalizeChineseMainlandPhoneNumber(trimmed);
    conditions.push(eq(user.phoneNumber, normalizedPhone));
  } catch {
    // 非手机号搜索时忽略标准化失败，保留姓名/邮箱模糊匹配。
  }

  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      phoneNumber: user.phoneNumber,
    })
    .from(user)
    .where(or(...conditions))
    .limit(20);
}

/**
 * 查询候选用户中哪些已在目标组织内。
 */
export async function findOrganizationMemberUserIds(organizationId: string, userIds: string[]) {
  if (userIds.length === 0) return [];

  return db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), inArray(member.userId, userIds)))
    .execute();
}
