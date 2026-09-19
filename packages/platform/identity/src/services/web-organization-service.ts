import { getAuth } from "../auth/better-auth";
import {
  findMembershipRolesByUserId,
  findOrganizationMemberUserIds,
  findUsersPhoneNumbersByIds,
  searchOrganizationMemberCandidates,
} from "../repositories/organization-member";

/**
 * `/web/organizations` 的成员与角色装配。
 *
 * 迁移自 `packages/resources/identity-admin/src/server/services/web-organization-service.ts`
 * （CE 阶段 2 任务 1.2）。语义保持原样：成员数据仍由 better-auth organization API 提供，本文件只
 * 补齐角色、手机号与"是否已是成员"的展示字段。
 *
 * better-auth 实例改为经 `getAuth()` 惰性取得：它依赖已初始化的 DB 与模块配置，模块顶层求值会
 * 引入隐式的加载顺序依赖。
 */

interface OrgApi {
  addMember: (opts: {
    body: { userId: string; role: string; organizationId: string };
    headers: Headers;
  }) => Promise<MemberLike>;
}

type MemberLike = {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string; phoneNumber?: string | null };
};

/**
 * 取 better-auth organization API。
 *
 * `addMember` 不在 better-auth 的公开类型签名里（由 organization 插件在运行时挂载），因此这里
 * 收窄为最小可调用结构；断言范围仅限这一个 API 对象。
 */
function getOrgApi(): OrgApi {
  return getAuth().api as unknown as OrgApi;
}

/**
 * 为组织列表补齐当前用户的角色信息。
 */
export async function enrichOrganizationsWithRoles<T extends { id: string }>(
  userId: string,
  organizations: T[],
): Promise<Array<T & { role: string }>> {
  if (organizations.length === 0) return [];

  const memberships = await findMembershipRolesByUserId(userId);
  const roleMap = new Map(memberships.map((membership) => [membership.organizationId, membership.role]));

  return organizations.map((organization) => ({
    ...organization,
    role: roleMap.get(organization.id as string) ?? "member",
  }));
}

/**
 * 为成员列表补齐手机号字段，避免同名用户难以区分。
 */
export async function enrichMembersWithPhoneNumbers(members: MemberLike[]) {
  const userIds = Array.from(
    new Set(members.map((memberItem) => memberItem.user?.id ?? memberItem.userId).filter(Boolean)),
  );
  if (userIds.length === 0) return members;

  const users = await findUsersPhoneNumbersByIds(userIds);
  const phoneMap = new Map(users.map((row) => [row.id, row.phoneNumber]));

  return members.map((memberItem) => {
    if (!memberItem.user) return memberItem;
    return {
      ...memberItem,
      user: {
        ...memberItem.user,
        phoneNumber: phoneMap.get(memberItem.user.id) ?? null,
      },
    };
  });
}

/**
 * 搜索组织可添加成员，并标记已在组织内的用户。
 */
export async function searchAvailableOrganizationMemberCandidates(organizationId: string, keyword: string) {
  const matchedUsers = await searchOrganizationMemberCandidates(keyword);
  if (matchedUsers.length === 0) return [];

  const existingMembers = await findOrganizationMemberUserIds(
    organizationId,
    matchedUsers.map((matchedUser) => matchedUser.id),
  );
  const existingMemberIds = new Set(existingMembers.map((row) => row.userId));

  return matchedUsers.map((matchedUser) => ({
    ...matchedUser,
    isMember: existingMemberIds.has(matchedUser.id),
  }));
}

/**
 * 批量向组织添加成员。
 */
export async function addOrganizationMembers(
  organizationId: string,
  userIds: string[],
  role: string,
  headers: Headers,
) {
  const api = getOrgApi();
  return Promise.all(
    userIds.map((userId) =>
      api.addMember({
        body: { userId, role, organizationId },
        headers,
      }),
    ),
  );
}
