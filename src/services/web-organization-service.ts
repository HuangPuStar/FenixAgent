import { auth } from "../auth/better-auth";
import {
  findMembershipRolesByUserId,
  findOrganizationMemberUserIds,
  findUsersPhoneNumbersByIds,
  searchOrganizationMemberCandidates,
} from "../repositories/organization-member-repository";

interface OrgApi {
  addMember: (opts: {
    body: { userId: string; role: string; organizationId: string };
    headers: Headers;
  }) => Promise<MemberLike>;
}

const api = auth.api as unknown as OrgApi;

type MemberLike = {
  id: string;
  userId: string;
  role: string;
  user?: { id: string; name: string; email: string; phoneNumber?: string | null };
};

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
  return Promise.all(
    userIds.map((userId) =>
      api.addMember({
        body: { userId, role, organizationId },
        headers,
      }),
    ),
  );
}
