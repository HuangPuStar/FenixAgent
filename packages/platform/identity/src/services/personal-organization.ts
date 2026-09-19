import * as schema from "../../db/schema";
import { getIdentityDatabase } from "../db";

/**
 * 个人组织引导：新用户注册后立即拥有一个自己的组织与 owner 成员关系。
 *
 * 这是多租户的不变量：`org-context` 的默认组织取自 `member.createdAt` 最小的成员关系，
 * 没有这行成员关系，用户登录后会落到"无组织"分支。因此写入必须与用户创建同一次注册流程完成，
 * 由 better-auth 的 `databaseHooks.user.create.after` 触发（见 `auth/better-auth.ts`）。
 *
 * 迁移自宿主的 better-auth 配置（CE 阶段 2 任务 1.2），ID 生成方式与 slug 形态逐字保留。
 */

/** better-auth 默认 ID 生成：32 位大小写字母数字。 */
function generateId(size = 32): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return Array.from({ length: size }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

/**
 * 个人组织引导的写入端口。
 *
 * 生产实现直接落模块 DB；抽出端口是因为这条不变量无法经 better-auth 钩子验证（测试进程里
 * better-auth 整体被替身替换），而"注册即拥有个人组织 + owner 成员"必须可断言。
 */
export type PersonalOrganizationWriter = (rows: {
  organization: typeof schema.organization.$inferInsert;
  member: typeof schema.member.$inferInsert;
}) => Promise<void>;

const writeWithModuleDatabase: PersonalOrganizationWriter = async ({ organization, member }) => {
  const db = getIdentityDatabase();
  await db.insert(schema.organization).values(organization);
  await db.insert(schema.member).values(member);
};

/** 为新用户创建个人组织与 owner 成员关系。 */
export async function ensurePersonalOrganization(
  user: { id: string; name: string },
  write: PersonalOrganizationWriter = writeWithModuleDatabase,
): Promise<void> {
  const organizationId = generateId();
  const createdAt = new Date();
  await write({
    organization: {
      id: organizationId,
      name: user.name,
      // slug 只取用户 ID 前 8 位：既保证可读性，也不把完整用户 ID 暴露在可分享的标识里。
      slug: `personal-${user.id.slice(0, 8)}`,
      createdAt,
    },
    member: {
      id: generateId(),
      organizationId,
      userId: user.id,
      role: "owner",
      createdAt,
    },
  });
}
