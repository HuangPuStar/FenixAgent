import { randomInt, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, parse, relative, resolve, sep } from "node:path";
import { createLogger, type Logger } from "@fenix/logger";
import { hashPassword } from "better-auth/crypto";
import { and, eq } from "drizzle-orm";
import { account, member, organization, user } from "../../db/schema";
import { getIdentityConfig, type IdentityConfig } from "../config";
import { getIdentityDatabase, type IdentityDatabase } from "../db";

/**
 * 系统管理员启动引导。
 *
 * 迁移自 `packages/resources/identity-admin/src/server/services/system-admin.ts`（CE 阶段 2 任务 1.2）。
 * 除配置来源改为 `getIdentityConfig()`、DB 来源改为 `getIdentityDatabase()` 外，行为保持原样：
 * 凭据文件的原子发布、权限收紧、失败保留 bootstrap intent 等语义都逐字保留。
 */

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
  const db = getIdentityDatabase();
  const rows = await db.select().from(user).where(eq(user.email, email)).limit(1);
  if (!rows[0]) return null;
  return { id: rows[0].id };
}

/** 已存在用户时，必须能定位到 admin 组织归属，否则说明系统状态不一致。 */
async function findAdminOrganizationForUser(userId: string): Promise<SystemAdminOrganizationLookup | null> {
  const db = getIdentityDatabase();
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
  const db = getIdentityDatabase();

  await db.transaction(async (tx: IdentityDatabase) => {
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

interface PreparedPasswordFile {
  password: string;
}

class InvalidSystemAdminCredentialFileError extends Error {
  constructor(
    message = "Existing system admin credential file is invalid; refusing to overwrite",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InvalidSystemAdminCredentialFileError";
  }
}

/** 对目录 fd 执行持久化屏障，确保此前的目录项变更在崩溃后可见。 */
function syncDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  let syncError: unknown;
  try {
    descriptor = openSync(directoryPath, "r");
    fsyncSync(descriptor);
  } catch (error) {
    syncError = error;
  }

  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (closeError) {
      if (syncError !== undefined) {
        throw new AggregateError([syncError, closeError], "Unable to sync system admin credential directory");
      }
      throw new Error("Unable to close system admin credential directory", { cause: closeError });
    }
  }
  if (syncError !== undefined) {
    throw new Error("Unable to sync system admin credential directory", { cause: syncError });
  }
}

/** 删除目录项后同步父目录，避免进程崩溃让已删除文件重新出现。 */
function unlinkAndSync(filePath: string, directoryPath: string): void {
  unlinkSync(filePath);
  _deps.syncDirectory(directoryPath);
}

/** 创建缺失目录并自上而下持久化每层 dentry；失败时不递归删除可能已创建的空目录。 */
function ensureDirectoryDurably(directoryPath: string): void {
  const absoluteDirectoryPath = resolve(directoryPath);

  try {
    mkdirSync(absoluteDirectoryPath, { recursive: true });
  } catch (error) {
    throw new Error("Unable to create system admin credential directory hierarchy", { cause: error });
  }

  const { root } = parse(absoluteDirectoryPath);
  const childSegments = relative(root, absoluteDirectoryPath)
    .split(sep)
    .filter((segment) => segment.length > 0);
  const syncedParents = new Set<string>();
  let parentPath = root;
  for (const childSegment of childSegments) {
    const childPath = join(parentPath, childSegment);
    if (!syncedParents.has(parentPath)) {
      try {
        _deps.syncDirectory(parentPath);
        syncedParents.add(parentPath);
      } catch (error) {
        throw new Error("Unable to persist system admin credential directory hierarchy", { cause: error });
      }
    }
    parentPath = childPath;
  }
}

/** 判断系统错误是否表示路径不存在。 */
function isNoEntryError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** lstat 快速拒绝 symlink、FIFO、socket 和 device，避免阻塞或跟随非普通文件。 */
function inspectCredentialPath(targetPath: string, allowMissing: boolean): boolean {
  try {
    if (!lstatSync(targetPath).isFile()) {
      throw new InvalidSystemAdminCredentialFileError("Existing system admin credential intent must be a regular file");
    }
  } catch (error) {
    if (allowMissing && isNoEntryError(error)) return false;
    if (error instanceof InvalidSystemAdminCredentialFileError) throw error;
    throw new Error("Unable to inspect existing system admin credential file", { cause: error });
  }
  return true;
}

/** 通过 no-follow/non-blocking 打开并在同一 fd 上复核普通文件，封闭 lstat/open 的 TOCTOU 窗口。 */
function withSecureCredentialFile<T>(targetPath: string, operation: (descriptor: number) => T): T {
  if (typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") {
    throw new Error("Secure system admin credential files require O_NOFOLLOW and O_NONBLOCK support");
  }

  let descriptor: number | undefined;
  let result: T | undefined;
  let operationError: unknown;
  try {
    descriptor = _deps.openPasswordFile(targetPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!fstatSync(descriptor).isFile()) {
      throw new InvalidSystemAdminCredentialFileError("Existing system admin credential intent must be a regular file");
    }
    result = operation(descriptor);
  } catch (error) {
    operationError = error;
  }

  let closeError: unknown;
  if (descriptor !== undefined) {
    try {
      closeSync(descriptor);
    } catch (error) {
      closeError = error;
    }
  }
  if (operationError !== undefined && closeError !== undefined) {
    throw new AggregateError(
      [operationError, closeError],
      "Unable to securely process existing system admin credential file",
    );
  }
  if (operationError !== undefined) {
    if (operationError instanceof InvalidSystemAdminCredentialFileError) throw operationError;
    throw new Error("Unable to securely open existing system admin credential file", { cause: operationError });
  }
  if (closeError !== undefined) {
    throw new Error("Unable to close existing system admin credential file", { cause: closeError });
  }
  return result as T;
}

/** 严格读取受控格式的普通凭据文件，格式不符时绝不覆盖。 */
function readExistingPasswordFile(targetPath: string, allowMissing = false): PreparedPasswordFile | null {
  if (!inspectCredentialPath(targetPath, allowMissing)) return null;
  const content = withSecureCredentialFile(targetPath, (descriptor) => {
    fchmodSync(descriptor, 0o600);
    return readFileSync(descriptor, "utf8");
  });

  const lines = content.split("\n");
  const passwordMatch = /^password: ([A-Za-z0-9]{16})$/.exec(lines[3] ?? "");
  if (
    lines.length !== 6 ||
    lines[0] !== "system admin account" ||
    lines[1] !== `username: ${SYSTEM_ADMIN_NAME}` ||
    lines[2] !== `email: ${SYSTEM_ADMIN_EMAIL}` ||
    !passwordMatch ||
    lines[4] !== `organization: ${SYSTEM_ADMIN_ORG_NAME}` ||
    lines[5] !== ""
  ) {
    throw new InvalidSystemAdminCredentialFileError();
  }

  return { password: passwordMatch[1] };
}

/** 判断 hard-link 发布是否因目标已由另一启动进程创建而失败。 */
function isAlreadyExistsError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "EEXIST";
}

/**
 * 先在目标目录写入唯一临时文件，再通过 hard-link 原子且排他地发布凭据文件。
 * POSIX rename 会覆盖既有目标；hard-link 的 EEXIST 语义可避免并发启动覆盖有效凭据。
 */
function preparePasswordFile(password: string): PreparedPasswordFile {
  const targetPath = resolve(_deps.getConfig().systemAdminPasswordFile);
  const targetDir = dirname(targetPath);
  const temporaryPath = join(targetDir, `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor: number | undefined;

  ensureDirectoryDurably(targetDir);
  const existingPasswordFile = readExistingPasswordFile(targetPath, true);
  if (existingPasswordFile) return existingPasswordFile;

  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, buildPasswordFileContent(password), "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      unlinkAndSync(temporaryPath, targetDir);
      const concurrentPasswordFile = readExistingPasswordFile(targetPath);
      if (!concurrentPasswordFile) throw new Error("Concurrent system admin credential publication disappeared");
      return concurrentPasswordFile;
    }
    _deps.syncDirectory(targetDir);
    unlinkAndSync(temporaryPath, targetDir);
    return { password };
  } catch (error) {
    if (error instanceof InvalidSystemAdminCredentialFileError) throw error;
    const cleanupErrors: unknown[] = [];
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (existsSync(temporaryPath)) {
      try {
        unlinkAndSync(temporaryPath, targetDir);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([error, ...cleanupErrors], "Unable to prepare system admin credential file");
    }
    throw new Error("Unable to prepare system admin credential file", { cause: error });
  }
}

/** 已有 admin 不重写凭据，仅在文件仍存在时收紧权限。 */
function secureExistingPasswordFile(): void {
  const targetPath = resolve(_deps.getConfig().systemAdminPasswordFile);
  if (!inspectCredentialPath(targetPath, true)) return;
  withSecureCredentialFile(targetPath, (descriptor) => fchmodSync(descriptor, 0o600));
}

/** 可替换依赖：让启动引导逻辑能在不触碰真实 DB 和文件系统的情况下测试。 */
export const _deps: {
  findUserByEmail: (email: string) => Promise<SystemAdminUserLookup | null>;
  findAdminOrganizationForUser: (userId: string) => Promise<SystemAdminOrganizationLookup | null>;
  createSystemAdminRecords: (password: string) => Promise<{ userId: string; organizationId: string }>;
  generateSystemAdminPassword: () => string;
  getConfig: () => IdentityConfig;
  preparePasswordFile: (password: string) => PreparedPasswordFile;
  openPasswordFile: (path: string, flags: number) => number;
  secureExistingPasswordFile: () => void;
  syncDirectory: (directoryPath: string) => void;
  logger: Pick<Logger, "info">;
} = {
  findUserByEmail,
  findAdminOrganizationForUser,
  createSystemAdminRecords,
  generateSystemAdminPassword,
  getConfig: getIdentityConfig,
  preparePasswordFile,
  openPasswordFile: openSync,
  secureExistingPasswordFile,
  syncDirectory,
  logger: systemAdminLog,
};

/** 测试辅助：恢复默认依赖实现。 */
export function _resetDeps() {
  _deps.findUserByEmail = findUserByEmail;
  _deps.findAdminOrganizationForUser = findAdminOrganizationForUser;
  _deps.createSystemAdminRecords = createSystemAdminRecords;
  _deps.generateSystemAdminPassword = generateSystemAdminPassword;
  _deps.getConfig = getIdentityConfig;
  _deps.preparePasswordFile = preparePasswordFile;
  _deps.openPasswordFile = openSync;
  _deps.secureExistingPasswordFile = secureExistingPasswordFile;
  _deps.syncDirectory = syncDirectory;
  _deps.logger = systemAdminLog;
}

/**
 * 确保系统 admin 用户和 admin 组织存在。
 *
 * 约束：
 * - `admin@fenix.com` 已存在时不重置密码或覆盖内容，仅在凭据文件存在时收紧为 `0600`
 * - 首次创建时只把初始密码写入密码文件，日志不得泄露明文凭据
 * - 合法凭据完成持久发布后作为 bootstrap intent 保留，DB 初始化失败不得删除
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
    _deps.secureExistingPasswordFile();
    _deps.logger.info(`Skip bootstrap for existing system admin: ${SYSTEM_ADMIN_EMAIL}`);
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

  const preparedFile = _deps.preparePasswordFile(_deps.generateSystemAdminPassword());
  let created: { userId: string; organizationId: string };
  try {
    created = await _deps.createSystemAdminRecords(preparedFile.password);
  } catch (error) {
    throw new Error("System admin bootstrap failed; credential intent was preserved for retry", { cause: error });
  }
  _deps.logger.info(
    [
      "System admin account created",
      `username=${SYSTEM_ADMIN_NAME}`,
      `email=${SYSTEM_ADMIN_EMAIL}`,
      `organization=${SYSTEM_ADMIN_ORG_NAME}`,
      `passwordFile=${_deps.getConfig().systemAdminPasswordFile}`,
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

/**
 * 读取系统托管租户（`IdentityDirectory.resolveSystemTenant` 的实现）。
 *
 * 引导是幂等的（{@link ensureSystemAdmin} 对已存在账号不重置密码、不覆盖凭据文件），因此本方法
 * 是系统托管资源的唯一入口：调用方不需要、也不得自行判断"是否已引导"再决定要不要建号。
 *
 * 引导失败（例如 admin 账号存在但组织归属缺失）时抛错，不返回空值让调用方把系统资源写到错误
 * 归属下。`userId` / `email` 是审计主体：系统托管资源的 `user_id` 列必须写这个真实用户 ID，
 * 不得伪造 actor。
 */
export async function resolveSystemAdminTenant(): Promise<{
  organizationId: string;
  organizationSlug: string;
  userId: string;
  email: string;
}> {
  const admin = await ensureSystemAdmin();
  return {
    organizationId: admin.organization.id,
    organizationSlug: admin.organization.slug,
    userId: admin.userId,
    email: admin.email,
  };
}
