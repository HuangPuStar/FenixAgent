import type { ApiSystemUserRecord, UserSearchInput } from "@fenix/platform-sdk";
import { and, asc, eq, ilike, inArray, or } from "drizzle-orm";
import { member, user } from "../../db/schema";
import { getIdentityDatabase } from "../db";

/**
 * 用户读取。
 *
 * 迁移自 `packages/resources/identity-admin/src/repositories/user.ts`（CE 阶段 2 任务 1.2：身份职责
 * 迁入 `@fenix/identity`，identity-admin 随后整包删除）。除 DB 来源改为 `getIdentityDatabase()`、
 * 补上目录契约所需的读取之外，SQL 条件与语义保持原样。
 *
 * 本文件不导出给包外：资源模块读取用户只能经 `IdentityDirectory` 契约，宿主以外的调用方不得持有
 * 身份表的查询条件（ce-ee-engineering-standards §2.3）。
 */

/** 用户基础展示信息；不含账号状态与凭据字段。 */
export interface UserBasicInfo {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

/** 用户手机号读取结果。 */
export interface UserPhoneNumber {
  readonly id: string;
  readonly phoneNumber: string | null;
}

/** 组织成员候选项；含手机号以便区分同名用户。 */
export interface OrganizationMemberCandidate {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly phoneNumber: string | null;
}

const SYSTEM_USER_FIELDS = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  phoneNumber: user.phoneNumber,
  phoneNumberVerified: user.phoneNumberVerified,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
};

/**
 * 按用户 ID 批量查询基础展示信息。
 */
export async function findUsersBasicInfoByIds(userIds: string[]): Promise<UserBasicInfo[]> {
  if (userIds.length === 0) return [];

  const db = getIdentityDatabase();
  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(user)
    .where(inArray(user.id, userIds))
    .execute();
}

/**
 * 按用户 ID 读取单个用户的基础展示信息；不存在时返回 null。
 */
export async function findUserBasicInfoById(userId: string): Promise<UserBasicInfo | null> {
  const db = getIdentityDatabase();
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 按登录名读取用户基础展示信息。
 *
 * 同名多行时取最早创建的一行：调用点（如按 username 解析远程实例属主）需要确定性结果，
 * 而 `member.createdAt` 之前的历史实现依赖 `limit 1` 的未定义顺序。
 */
export async function findUserBasicInfoByName(name: string): Promise<UserBasicInfo | null> {
  const db = getIdentityDatabase();
  const rows = await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(user)
    .where(eq(user.name, name))
    .orderBy(asc(user.createdAt), asc(user.id))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 判断手机号是否已被占用。
 *
 * 手机号是账号标识而非普通资料字段，唯一性判断属于身份模块：宿主 `/api/auth/sign-up/phone` 需要在
 * 调用 better-auth 前给出稳定的 422，而它不该持有身份表的查询条件。
 */
export async function isPhoneNumberRegistered(phoneNumber: string): Promise<boolean> {
  const db = getIdentityDatabase();
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.phoneNumber, phoneNumber)).limit(1);
  return rows.length > 0;
}

/**
 * 管理端用户检索。
 *
 * 迁移自 `packages/resources/model-management/src/server/repositories/model-gateway-subject.ts` 的
 * `findModelGatewayUsers`（该实现把身份表查询放在资源包里，1.2 收敛回身份模块）。`organizationId`
 * 通过成员关系限定，`keyword` 对姓名/邮箱/手机号做模糊匹配，结果按创建时间与 ID 升序，保证分页稳定。
 */
export async function searchSystemUsers(input: UserSearchInput): Promise<ApiSystemUserRecord[]> {
  const db = getIdentityDatabase();
  const conditions = [];
  if (input.organizationId) {
    conditions.push(eq(member.organizationId, input.organizationId));
  }
  if (input.userId) conditions.push(eq(user.id, input.userId));
  if (input.keyword?.trim()) {
    const keyword = `%${input.keyword.trim()}%`;
    conditions.push(or(ilike(user.name, keyword), ilike(user.email, keyword), ilike(user.phoneNumber, keyword)));
  }

  if (input.organizationId) {
    return db
      .select(SYSTEM_USER_FIELDS)
      .from(user)
      .innerJoin(member, eq(member.userId, user.id))
      .where(and(...conditions))
      .orderBy(asc(user.createdAt), asc(user.id));
  }
  return db
    .select(SYSTEM_USER_FIELDS)
    .from(user)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(user.createdAt), asc(user.id));
}
