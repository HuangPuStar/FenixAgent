import { and, asc, count, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { member, organization, user } from "../../db/schema";
import { getIdentityDatabase } from "../db";
import { normalizeChineseMainlandPhoneNumber } from "../services/phone-number";
import type { OrganizationMemberCandidate, UserPhoneNumber } from "./user";

/**
 * 组织成员关系读取。
 *
 * 迁移自 `packages/resources/identity-admin/src/server/repositories/organization-member-repository.ts`
 * （CE 阶段 2 任务 1.2），并补上 `IdentityDirectory` 契约需要的成员关系读取。除 DB 来源改为
 * `getIdentityDatabase()` 外，查询条件与过滤语义保持原样。
 */

/** 用户在组织中的成员角色映射。 */
export interface MembershipRole {
  readonly organizationId: string;
  readonly role: string;
}

/**
 * 组织 → 成员展平行；由调用方（identity 目录）聚合成对外的组织成员投影。
 *
 * 仓储返回持久化形状而不是契约投影：投影形状属于 `@fenix/platform-sdk` 的协议面，
 * 不该由持久化层决定（ce-ee-engineering-standards 的分层约束）。
 */
export interface OrganizationMemberRow {
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly userId: string | null;
  readonly userName: string | null;
  readonly userEmail: string | null;
  readonly userPhoneNumber: string | null;
  readonly role: string | null;
}

/**
 * 查询用户在各组织下的成员角色映射。
 *
 * 按 `member.createdAt` 升序（同刻用 `member.id` 兜底）保证顺序确定：调用方把第一条成员关系当作
 * "用户的首个组织"，通常是注册时创建的个人组织，顺序不确定会让组织上下文随机漂移。
 */
export async function findMembershipRolesByUserId(userId: string): Promise<MembershipRole[]> {
  const db = getIdentityDatabase();
  return db
    .select({ organizationId: member.organizationId, role: member.role })
    .from(member)
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt), asc(member.id))
    .execute();
}

/**
 * 读取用户在指定组织中的成员角色；不存在成员关系时返回 undefined。
 *
 * 组织管理授权必须从 identity 自己拥有的成员表实时读取，不能依赖 actor 中可能过期的成员关系快照。
 */
export async function findOrganizationMembershipRole(
  organizationId: string,
  userId: string,
): Promise<string | undefined> {
  const db = getIdentityDatabase();
  const rows: { role: string }[] = await db
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return rows[0]?.role;
}

/**
 * 批量查询用户手机号，用于补全 better-auth 返回的成员信息。
 */
export async function findUsersPhoneNumbersByIds(userIds: string[]): Promise<UserPhoneNumber[]> {
  if (userIds.length === 0) return [];

  const db = getIdentityDatabase();
  return db
    .select({ id: user.id, phoneNumber: user.phoneNumber })
    .from(user)
    .where(inArray(user.id, userIds))
    .execute();
}

/**
 * 在全站用户中搜索组织成员候选项。
 */
export async function searchOrganizationMemberCandidates(keyword: string): Promise<OrganizationMemberCandidate[]> {
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

  const db = getIdentityDatabase();
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
export async function findOrganizationMemberUserIds(
  organizationId: string,
  userIds: string[],
): Promise<{ userId: string }[]> {
  if (userIds.length === 0) return [];

  const db = getIdentityDatabase();
  return db
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), inArray(member.userId, userIds)))
    .execute();
}

/**
 * 解析成员关系行 ID；不存在时返回 undefined。
 *
 * 该 ID 是既有外部约定的稳定标识（例如 Hindsight bank ID 由成员行 ID 派生），调用方不得据此
 * 推断成员权限。
 */
export async function findMembershipId(organizationId: string, userId: string): Promise<string | undefined> {
  const db = getIdentityDatabase();
  const rows: { id: string }[] = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.organizationId, organizationId), eq(member.userId, userId)))
    .limit(1);
  return rows[0]?.id;
}

/**
 * 组织成员的分页读取结果。
 *
 * 只含 `userId` 与 `name` 两列：这个形状专供「成员候选集」这类只需标识与展示名的消费方，
 * 有意与 {@link OrganizationMemberRow} 的全字段展平区分开。新增列等于把身份信息扩散给所有调用方，
 * 需要邮箱/手机号的系统管理面必须另走既有查询。
 */
export interface OrganizationMemberPageRow {
  readonly userId: string;
  readonly name: string;
}

/**
 * 分页读取一个组织的成员（按姓名、用户 ID 升序），并返回同谓词下的总数。
 *
 * 组织谓词拼进 SQL 而不是读到内存再过滤：跨组织的行不可能被本函数返回。`keyword` 非空白时对姓名做
 * **子串匹配**（`strpos(lower(name), lower(keyword)) > 0`，大小写不敏感，trim 口径与 `searchSystemUsers`
 * 一致），不匹配邮箱或手机号——它们是账号标识，不该成为成员下拉框的检索维度。
 *
 * 这里刻意不复用 `searchSystemUsers` 的 `ilike '%…%'`：那是通配符语义，用户输入里的 `%` / `_` 会被当成
 * 模式字符（只输入 `%` 即列出全部成员），而本方法是下拉框的子串过滤，输入必须整体按字面量匹配。分页与
 * `count()` 同条件，`limit`/`offset` 的边界由调用方按契约（`page` 从 1 起、`pageSize` 1..100）校验，
 * 本层不做静默裁剪。
 */
export async function listOrganizationMemberPage(input: {
  organizationId: string;
  keyword?: string;
  page: number;
  pageSize: number;
}): Promise<{ items: OrganizationMemberPageRow[]; total: number }> {
  const db = getIdentityDatabase();
  const keyword = input.keyword?.trim();
  // 不用 `ilike`：通配符语义会让 `%` / `_` 变成模式字符（`q=%` 返回全部成员），`strpos` 只做字面量子串匹配。
  const condition = keyword
    ? and(eq(member.organizationId, input.organizationId), sql`strpos(lower(${user.name}), lower(${keyword})) > 0`)
    : eq(member.organizationId, input.organizationId);

  const [items, totalRows] = await Promise.all([
    db
      .select({ userId: user.id, name: user.name })
      .from(member)
      .innerJoin(user, eq(member.userId, user.id))
      .where(condition)
      .orderBy(asc(user.name), asc(user.id))
      .limit(input.pageSize)
      .offset((input.page - 1) * input.pageSize),
    db.select({ value: count() }).from(member).innerJoin(user, eq(member.userId, user.id)).where(condition),
  ]);
  const total = totalRows[0];
  // `count()` 在有 WHERE 的聚合下恒返回一行；缺行说明驱动异常，按 0 处理会让分页静默错位，故显式失败。
  if (!total) throw new Error("organization member count returned no row");
  return { items, total: total.value };
}

/**
 * 读取全部组织及其成员（展平行）。
 *
 * 组织按名称、ID 升序，成员按用户名称、ID 升序，与系统人员树的既有展示顺序一致；
 * 无成员的组织仍会出现在结果里（成员列为 `null`），由调用方聚合成空成员数组。
 */
export async function listOrganizationMemberRows(): Promise<OrganizationMemberRow[]> {
  const db = getIdentityDatabase();
  return db
    .select({
      organizationId: organization.id,
      organizationName: organization.name,
      organizationSlug: organization.slug,
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      userPhoneNumber: user.phoneNumber,
      role: member.role,
    })
    .from(organization)
    .leftJoin(member, eq(member.organizationId, organization.id))
    .leftJoin(user, eq(member.userId, user.id))
    .orderBy(asc(organization.name), asc(organization.id), asc(user.name), asc(user.id))
    .execute();
}
