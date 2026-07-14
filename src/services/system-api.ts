import { randomUUID } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import { hashPassword } from "better-auth/crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "../db";
import { account, apikey, member, organization, user } from "../db/schema";
import { buildPhoneTempEmail, normalizeChineseMainlandPhoneNumber } from "./phone-number";

export interface SystemApiPagination {
  page: number;
  pageSize: number;
}

export interface SystemApiUserRecord {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface SystemApiOrganizationRecord {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SystemApiOrganizationMemberRecord {
  id: string;
  organizationId: string;
  userId: string;
  role: string;
  createdAt: Date;
}

export interface SystemApiUserOrganizationRecord extends SystemApiOrganizationRecord {
  memberId: string;
  role: string;
  memberCreatedAt: Date;
}

export interface SystemApiCreateUserInput {
  email?: string;
  emailVerified?: boolean;
  phoneNumber?: string;
  phoneNumberVerified?: boolean;
  name: string;
  password: string;
}

export interface SystemApiCreateOrganizationInput {
  name: string;
  slug: string;
  ownerUserId?: string;
  metadata?: Record<string, unknown>;
}

export interface SystemApiResetUserPasswordInput {
  userId?: string;
  email?: string;
  phoneNumber?: string;
  password: string;
}

export interface SystemApiAddOrganizationMemberInput {
  organizationId: string;
  userId: string;
  role: "owner" | "admin" | "member";
}

export interface SystemApiCreateUserApiKeyInput {
  userId: string;
  organizationId: string;
  role: "owner" | "admin" | "member";
  name: string;
  expiresIn?: number | null;
  metadata?: Record<string, unknown>;
}

export interface SystemApiUserApiKeyResult {
  id: string;
  name: string | null;
  prefix: string | null;
  key: string;
  start: string | null;
  userId: string;
  organizationId: string;
  role: string;
  createdAt: Date;
  expiresAt: Date | null;
  metadata: Record<string, unknown> | null;
}

export interface SystemApiUserApiKeyListItem extends Omit<SystemApiUserApiKeyResult, "key"> {}

export interface SystemApiDeleteResult {
  deleted: true;
}

export interface SystemApiUpdateResult {
  updated: true;
}

const API_KEY_START_LENGTH = 6;

function buildPersonalOrganizationSlug(userId: string) {
  return `personal-${userId.slice(0, 8)}`;
}

function buildApiKeyMetadata(
  organizationId: string,
  role: "owner" | "admin" | "member",
  metadata?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    organizationId,
    role,
  };
}

function generateApiKeyString(prefix = "rcs_") {
  return `${prefix}${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
}

/**
 * better-auth 的 apikey.metadata 当前以字符串列存储。
 * 系统接口需要给外部返回结构化 metadata，因此这里做一次容错解析。
 */
function parseApiKeyMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

async function assertUserExists(userId: string) {
  const rows = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (rows.length === 0) {
    throw new Error(`User '${userId}' not found`);
  }
}

async function assertOrganizationExists(organizationId: string) {
  const rows = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`Organization '${organizationId}' not found`);
  }
}

async function assertUserBelongsToOrganization(userId: string, organizationId: string) {
  const rows = await db
    .select({ id: member.id })
    .from(member)
    .where(and(eq(member.userId, userId), eq(member.organizationId, organizationId)))
    .limit(1);
  if (rows.length === 0) {
    throw new Error(`User '${userId}' is not a member of organization '${organizationId}'`);
  }
}

async function resolveUserIdForPasswordReset(input: SystemApiResetUserPasswordInput) {
  if (input.userId) {
    await assertUserExists(input.userId);
    return input.userId;
  }

  if (input.email) {
    const rows = await db.select({ id: user.id }).from(user).where(eq(user.email, input.email.trim())).limit(1);
    if (rows.length === 0) {
      throw new Error(`User '${input.email}' not found`);
    }
    return rows[0].id;
  }

  if (input.phoneNumber) {
    const normalizedPhoneNumber = normalizeChineseMainlandPhoneNumber(input.phoneNumber);
    const rows = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.phoneNumber, normalizedPhoneNumber))
      .limit(1);
    if (rows.length === 0) {
      throw new Error(`User '${normalizedPhoneNumber}' not found`);
    }
    return rows[0].id;
  }

  throw new Error("userId, email or phoneNumber is required");
}

/**
 * 创建用户时同步补齐 credential account 与个人组织，保持与正常注册路径一致。
 */
export async function createUser(input: SystemApiCreateUserInput): Promise<SystemApiUserRecord> {
  const normalizedPhoneNumber = input.phoneNumber ? normalizeChineseMainlandPhoneNumber(input.phoneNumber) : null;
  const phoneNumberVerified = normalizedPhoneNumber ? (input.phoneNumberVerified ?? false) : false;
  const resolvedEmail =
    input.email?.trim() || (normalizedPhoneNumber ? buildPhoneTempEmail(normalizedPhoneNumber) : "");

  if (!resolvedEmail) {
    throw new Error("email or phoneNumber is required");
  }

  const existingByEmail = await db.select({ id: user.id }).from(user).where(eq(user.email, resolvedEmail)).limit(1);
  if (existingByEmail.length > 0) {
    throw new Error(`User '${resolvedEmail}' already exists`);
  }

  if (normalizedPhoneNumber) {
    const existingByPhone = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.phoneNumber, normalizedPhoneNumber))
      .limit(1);
    if (existingByPhone.length > 0) {
      throw new Error(`User '${normalizedPhoneNumber}' already exists`);
    }
  }

  const now = new Date();
  const userId = randomUUID();
  const organizationId = randomUUID();
  const hashedPassword = await hashPassword(input.password);

  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: input.name,
      email: resolvedEmail,
      emailVerified: input.emailVerified ?? false,
      phoneNumber: normalizedPhoneNumber,
      phoneNumberVerified,
      image: null,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(account).values({
      id: randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: hashedPassword,
      createdAt: now,
      updatedAt: now,
    });

    await tx.insert(organization).values({
      id: organizationId,
      name: input.name,
      slug: buildPersonalOrganizationSlug(userId),
      createdAt: now,
    });

    await tx.insert(member).values({
      id: randomUUID(),
      organizationId,
      userId,
      role: "owner",
      createdAt: now,
    });
  });

  return {
    id: userId,
    name: input.name,
    email: resolvedEmail,
    emailVerified: input.emailVerified ?? false,
    phoneNumber: normalizedPhoneNumber,
    phoneNumberVerified,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 全量用户列表按创建时间倒序返回，供系统管理台做分页展示。
 */
export async function listUsers(pagination: SystemApiPagination) {
  const rows = await db.select().from(user).orderBy(desc(user.createdAt));
  const total = rows.length;
  const start = (pagination.page - 1) * pagination.pageSize;
  return {
    items: rows.slice(start, start + pagination.pageSize),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

/**
 * 按 ID 获取单个用户详情。
 */
export async function getUserById(userId: string): Promise<SystemApiUserRecord | null> {
  const rows = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  return rows[0] ?? null;
}

/**
 * 按用户列出系统侧签发的 API key。
 * 这里只返回脱敏后的列表项，避免把明文 key 误暴露到查询接口里。
 */
export async function listUserApiKeys(userId: string, pagination: SystemApiPagination) {
  await assertUserExists(userId);

  const rows = await db.select().from(apikey).where(eq(apikey.referenceId, userId)).orderBy(desc(apikey.createdAt));
  const items: SystemApiUserApiKeyListItem[] = rows.map((row) => {
    const metadata = parseApiKeyMetadata(row.metadata);
    return {
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      start: row.start,
      userId,
      organizationId: typeof metadata?.organizationId === "string" ? metadata.organizationId : "",
      role: typeof metadata?.role === "string" ? metadata.role : "",
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      metadata,
    };
  });
  const total = items.length;
  const start = (pagination.page - 1) * pagination.pageSize;

  return {
    items: items.slice(start, start + pagination.pageSize),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

/**
 * 按用户列出其所属组织，并携带该用户在组织中的成员角色上下文。
 */
export async function listUserOrganizations(userId: string, pagination: SystemApiPagination) {
  await assertUserExists(userId);

  const rows = await db
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      metadata: organization.metadata,
      createdAt: organization.createdAt,
      memberId: member.id,
      role: member.role,
      memberCreatedAt: member.createdAt,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(eq(member.userId, userId))
    .orderBy(asc(member.createdAt));
  const total = rows.length;
  const start = (pagination.page - 1) * pagination.pageSize;

  return {
    items: rows.slice(start, start + pagination.pageSize) as SystemApiUserOrganizationRecord[],
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

/**
 * 删除用户，并清理其直接归属的 API key。
 * 这里只处理与 user 主键直接关联的数据；跨组织文本引用资源不在本接口隐式级联范围内。
 */
export async function deleteUser(userId: string): Promise<SystemApiDeleteResult> {
  await assertUserExists(userId);

  await db.transaction(async (tx) => {
    await tx.delete(apikey).where(eq(apikey.referenceId, userId));
    await tx.delete(user).where(eq(user.id, userId));
  });

  return { deleted: true };
}

/**
 * 重置指定用户的 credential 密码。
 */
export async function resetUserPassword(input: SystemApiResetUserPasswordInput): Promise<SystemApiUpdateResult> {
  const userId = await resolveUserIdForPasswordReset(input);
  const hashedPassword = await hashPassword(input.password);
  const rows = await db
    .update(account)
    .set({
      password: hashedPassword,
      updatedAt: new Date(),
    })
    .where(and(eq(account.userId, userId), eq(account.providerId, "credential")))
    .returning({ id: account.id });

  if (rows.length === 0) {
    throw new Error(`User '${userId}' credential account not found`);
  }

  return { updated: true };
}

/**
 * 创建组织，并可选地立即绑定 owner。
 */
export async function createOrganization(
  input: SystemApiCreateOrganizationInput,
): Promise<SystemApiOrganizationRecord> {
  const existing = await db
    .select({ id: organization.id })
    .from(organization)
    .where(eq(organization.slug, input.slug))
    .limit(1);
  if (existing.length > 0) {
    throw new Error(`Organization slug '${input.slug}' already exists`);
  }
  if (input.ownerUserId) {
    await assertUserExists(input.ownerUserId);
  }

  const now = new Date();
  const organizationId = randomUUID();

  await db.transaction(async (tx) => {
    await tx.insert(organization).values({
      id: organizationId,
      name: input.name,
      slug: input.slug,
      logo: null,
      metadata: input.metadata ?? null,
      createdAt: now,
    });

    if (input.ownerUserId) {
      await tx.insert(member).values({
        id: randomUUID(),
        organizationId,
        userId: input.ownerUserId,
        role: "owner",
        createdAt: now,
      });
    }
  });

  return {
    id: organizationId,
    name: input.name,
    slug: input.slug,
    logo: null,
    metadata: input.metadata ?? null,
    createdAt: now,
  };
}

/**
 * 列出所有组织，供系统管理页与外部平台分页读取。
 */
export async function listOrganizations(pagination: SystemApiPagination) {
  const rows = await db.select().from(organization).orderBy(asc(organization.createdAt));
  const total = rows.length;
  const start = (pagination.page - 1) * pagination.pageSize;
  return {
    items: rows.slice(start, start + pagination.pageSize),
    total,
    page: pagination.page,
    pageSize: pagination.pageSize,
  };
}

/**
 * 获取组织详情，并附带成员列表，方便系统侧做审计与管理。
 */
export async function getOrganizationById(organizationId: string) {
  const orgRows = await db.select().from(organization).where(eq(organization.id, organizationId)).limit(1);
  const org = orgRows[0];
  if (!org) return null;

  const members = await db
    .select()
    .from(member)
    .where(eq(member.organizationId, organizationId))
    .orderBy(asc(member.createdAt));
  return {
    ...org,
    members,
  };
}

/**
 * 删除组织本体。
 * 当前仅删除 organization 主表记录，member/invitation 依赖 FK 级联，其它文本 organizationId 引用保持显式管理。
 */
export async function deleteOrganization(organizationId: string): Promise<SystemApiDeleteResult> {
  await assertOrganizationExists(organizationId);
  await db.delete(organization).where(eq(organization.id, organizationId));
  return { deleted: true };
}

/**
 * 将现有用户加入指定组织。
 */
export async function addOrganizationMember(
  input: SystemApiAddOrganizationMemberInput,
): Promise<SystemApiOrganizationMemberRecord> {
  await assertOrganizationExists(input.organizationId);
  await assertUserExists(input.userId);

  const now = new Date();
  const membershipId = randomUUID();

  await db.insert(member).values({
    id: membershipId,
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    createdAt: now,
  });

  return {
    id: membershipId,
    organizationId: input.organizationId,
    userId: input.userId,
    role: input.role,
    createdAt: now,
  };
}

/**
 * 以系统视角代指定用户签发 API key，并把组织/角色写入 metadata，
 * 让后续纯 key 请求仍能走现有多租户鉴权链路。
 */
export async function createUserApiKey(input: SystemApiCreateUserApiKeyInput): Promise<SystemApiUserApiKeyResult> {
  await assertUserExists(input.userId);
  await assertOrganizationExists(input.organizationId);
  await assertUserBelongsToOrganization(input.userId, input.organizationId);

  const fullKey = generateApiKeyString("rcs_");
  const now = new Date();
  const expiresAt = input.expiresIn ? new Date(now.getTime() + input.expiresIn * 1000) : null;
  const metadata = buildApiKeyMetadata(input.organizationId, input.role, input.metadata);
  const keyId = randomUUID();
  const hashedKey = await defaultKeyHasher(fullKey);
  // better-auth 自带 createApiKey() 会把 start 预览片段写成 6 位。
  // 这里保持一致，避免 system API 创建出的 key 与其它入口展示格式不一致。
  const keyStart = fullKey.slice(0, API_KEY_START_LENGTH);

  await db.insert(apikey).values({
    id: keyId,
    configId: "default",
    name: input.name,
    start: keyStart,
    referenceId: input.userId,
    prefix: "rcs_",
    key: hashedKey,
    refillInterval: null,
    refillAmount: null,
    lastRefillAt: null,
    enabled: true,
    rateLimitEnabled: false,
    rateLimitTimeWindow: null,
    rateLimitMax: null,
    requestCount: 0,
    remaining: null,
    lastRequest: null,
    expiresAt,
    createdAt: now,
    updatedAt: now,
    permissions: null,
    metadata: JSON.stringify(metadata),
  });

  return {
    id: keyId,
    name: input.name,
    prefix: "rcs_",
    key: fullKey,
    start: keyStart,
    userId: input.userId,
    organizationId: input.organizationId,
    role: input.role,
    createdAt: now,
    expiresAt,
    metadata,
  };
}

/**
 * 删除指定用户 API key。
 */
export async function deleteUserApiKey(apiKeyId: string): Promise<SystemApiDeleteResult> {
  const rows = await db.select({ id: apikey.id }).from(apikey).where(eq(apikey.id, apiKeyId)).limit(1);
  if (rows.length === 0) {
    throw new Error(`API key '${apiKeyId}' not found`);
  }

  await db.delete(apikey).where(eq(apikey.id, apiKeyId));
  return { deleted: true };
}
