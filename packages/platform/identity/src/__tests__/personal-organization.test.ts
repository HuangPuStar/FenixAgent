import { describe, expect, test } from "bun:test";
import { ensurePersonalOrganization, type PersonalOrganizationWriter } from "../services/personal-organization";

/**
 * 收集写入记录，避免在平台包测试里触达宿主 DB 替身。
 *
 * 生产实现直接落模块 DB，这条不变量无法经 better-auth 钩子验证（测试进程里 better-auth 整体被
 * 替身替换），因此端口注入是唯一可断言路径。
 */
function captureWriter() {
  const calls: Parameters<PersonalOrganizationWriter>[0][] = [];
  const write: PersonalOrganizationWriter = async (rows) => {
    calls.push(rows);
  };
  return { calls, write };
}

describe("ensurePersonalOrganization", () => {
  // 注册后必须创建个人组织，并把新用户加为该组织的 owner。
  test("creates a personal organization with the registrant as owner", async () => {
    const { calls, write } = captureWriter();

    await ensurePersonalOrganization({ id: "user-abcdef123456", name: "张三" }, write);

    expect(calls).toHaveLength(1);
    const [{ organization, member }] = calls;
    expect(organization.name).toBe("张三");
    expect(organization.slug).toBe("personal-user-abc");
    expect(member.organizationId).toBe(organization.id);
    expect(member.userId).toBe("user-abcdef123456");
    expect(member.role).toBe("owner");
  });

  // 组织与成员关系的创建时间必须一致，成员顺序才在同一时刻内确定。
  test("stamps the organization and membership with the same timestamp", async () => {
    const { calls, write } = captureWriter();

    await ensurePersonalOrganization({ id: "user-1", name: "李四" }, write);

    const [{ organization, member }] = calls;
    expect(member.createdAt).toEqual(organization.createdAt);
  });

  // 组织 ID 与成员行 ID 必须是各自独立的标识，不能复用同一个值。
  test("generates distinct ids for the organization and the membership", async () => {
    const { calls, write } = captureWriter();

    await ensurePersonalOrganization({ id: "user-1", name: "王五" }, write);

    const [{ organization, member }] = calls;
    expect(organization.id).not.toBe(member.id);
    expect(organization.id).toHaveLength(32);
    expect(member.id).toHaveLength(32);
  });

  // slug 只取用户 ID 前 8 位，不得把完整用户 ID 写进可分享的组织标识。
  test("derives the slug from a truncated user id", async () => {
    const { calls, write } = captureWriter();

    await ensurePersonalOrganization({ id: "abcdefghijklmnop", name: "赵六" }, write);

    const [{ organization }] = calls;
    expect(organization.slug).toBe("personal-abcdefgh");
  });
});
