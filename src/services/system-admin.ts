import { randomInt, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "@fenix/logger";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { account, member, organization, user } from "../db/schema";

const systemAdminLog = createLogger("system-admin");

const SYSTEM_ADMIN_NAME = "admin";
const SYSTEM_ADMIN_EMAIL = "admin@fenix.com";
const SYSTEM_ADMIN_ORG_NAME = "admin";
const SYSTEM_ADMIN_ORG_SLUG = "admin";
const PASSWORD_LENGTH = 16;
const PASSWORD_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** 系统 admin 启动引导结果，供启动流程和 builtin 编排复用。 */
export interface SystemAdminBootstrapResult {
  created: boolean;
  userId: string;
  email: string;
  organization: { id: string; slug: string };
}

interface SystemAdminUserLookup {
  id: string;
}

interface SystemAdminOrganizationLookup {
  organizationId: string;
  slug: string;
}

/** 仅在首次启动创建账号时生成明文密码；后续启动不会重置密码。 */
function generateSystemAdminPassword(): string {
  return Array.from({ length: PASSWORD_LENGTH }, () => PASSWORD_CHARS[randomInt(0, PASSWORD_CHARS.length)]).join("");
}

/** 密码文件是部署侧找回初始凭据的唯一持久化出口，因此格式保持固定、可读。 */
function buildPasswordFileContent(password: string): string {
  return [
    "system admin account",
    `username: ${SYSTEM_ADMIN_NAME}`,
    `email: ${SYSTEM_ADMIN_EMAIL}`,
    `password: ${password}`,
    `organization: ${SYSTEM_ADMIN_ORG_NAME}`,
    "",
  ].join("\n");
}

/** 只查最小字段，避免把 better-auth user 全量结构泄漏到启动引导逻辑里。 */
async function findUserByEmail(email: string): Promise<SystemAdminUserLookup | null> {
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!rows[0]) return null;
  return { id: rows[0].id };
}

/** 已存在用户时，必须能定位到 admin 组织归属，否则说明系统状态不一致。 */
async function findAdminOrganizationForUser(userId: string): Promise<SystemAdminOrganizationLookup | null> {
  const rows = await db
    .select({
      organizationId: organization.id,
      slug: organization.slug,
    })
    .from(member)
    .innerJoin(organization, eq(member.organizationId, organization.id))
    .where(and(eq(member.userId, userId), eq(organization.slug, SYSTEM_ADMIN_ORG_SLUG)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 直接写底层 better-auth 表，目的是在无 session 的启动阶段完成一次性系统账号引导。
 * 这里同时创建 credential account、admin organization 和 owner membership，保证后续资源归属完整。
 */
async function createSystemAdminRecords(password: string): Promise<{ userId: string; organizationId: string }> {
  const now = new Date();
  const userId = randomUUID();
  const organizationId = randomUUID();
  const hashedPassword = await hashPassword(password);

  await db.transaction(async (tx) => {
    await tx.insert(user).values({
      id: userId,
      name: SYSTEM_ADMIN_NAME,
      email: SYSTEM_ADMIN_EMAIL,
      emailVerified: true,
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
      name: SYSTEM_ADMIN_ORG_NAME,
      slug: SYSTEM_ADMIN_ORG_SLUG,
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

  return { userId, organizationId };
}

/** 首次启动才写密码文件；后续启动保留原文件，避免让部署侧拿到过期信息。 */
function writePasswordFile(password: string) {
  mkdirSync(dirname(config.systemAdminPasswordFile), { recursive: true });
  writeFileSync(config.systemAdminPasswordFile, buildPasswordFileContent(password), "utf-8");
}

/** 可替换依赖：让启动引导逻辑能在不触碰真实 DB 和文件系统的情况下测试。 */
export const _deps: {
  findUserByEmail: (email: string) => Promise<SystemAdminUserLookup | null>;
  findAdminOrganizationForUser: (userId: string) => Promise<SystemAdminOrganizationLookup | null>;
  createSystemAdminRecords: (password: string) => Promise<{ userId: string; organizationId: string }>;
  generateSystemAdminPassword: () => string;
  writePasswordFile: (password: string) => void;
} = {
  findUserByEmail,
  findAdminOrganizationForUser,
  createSystemAdminRecords,
  generateSystemAdminPassword,
  writePasswordFile,
};

/** 测试辅助：恢复默认依赖实现。 */
export function _resetDeps() {
  _deps.findUserByEmail = findUserByEmail;
  _deps.findAdminOrganizationForUser = findAdminOrganizationForUser;
  _deps.createSystemAdminRecords = createSystemAdminRecords;
  _deps.generateSystemAdminPassword = generateSystemAdminPassword;
  _deps.writePasswordFile = writePasswordFile;
}

/**
 * 确保系统 admin 用户和 admin 组织存在。
 *
 * 约束：
 * - 只要 `admin@fenix.com` 已存在，就完全跳过，不做修复和密码重置
 * - 首次创建时同时写日志和密码文件，方便部署方获取初始凭据
 * - 如果发现用户已存在但没有 admin 组织归属，直接抛错阻断启动，避免系统资源写入到不明确归属下
 */
export async function ensureSystemAdmin(): Promise<SystemAdminBootstrapResult> {
  const existing = await _deps.findUserByEmail(SYSTEM_ADMIN_EMAIL);
  if (existing) {
    const existingOrganization = await _deps.findAdminOrganizationForUser(existing.id);
    if (!existingOrganization) {
      throw new Error(
        `[system-admin] ${SYSTEM_ADMIN_EMAIL} exists but admin organization membership is missing; bootstrap cannot continue`,
      );
    }
    systemAdminLog.info(`Skip bootstrap for existing system admin: ${SYSTEM_ADMIN_EMAIL}`);
    return {
      created: false,
      userId: existing.id,
      email: SYSTEM_ADMIN_EMAIL,
      organization: {
        id: existingOrganization.organizationId,
        slug: existingOrganization.slug,
      },
    };
  }

  const password = _deps.generateSystemAdminPassword();
  const created = await _deps.createSystemAdminRecords(password);
  _deps.writePasswordFile(password);
  systemAdminLog.info(
    [
      "System admin account created",
      `username=${SYSTEM_ADMIN_NAME}`,
      `email=${SYSTEM_ADMIN_EMAIL}`,
      `password=${password}`,
      `organization=${SYSTEM_ADMIN_ORG_NAME}`,
      `passwordFile=${config.systemAdminPasswordFile}`,
    ].join(" "),
  );
  return {
    created: true,
    userId: created.userId,
    email: SYSTEM_ADMIN_EMAIL,
    organization: {
      id: created.organizationId,
      slug: SYSTEM_ADMIN_ORG_SLUG,
    },
  };
}
