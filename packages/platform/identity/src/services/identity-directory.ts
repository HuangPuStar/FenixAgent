import type {
  ApiSystemUserRecord,
  IdentityDirectory,
  MemberRole,
  MembershipSummary,
  OrganizationMemberSummary,
  OrganizationSummary,
  OrganizationWithMembers,
  SystemTenant,
  UserDisplayInfo,
  UserSearchInput,
} from "@fenix/platform-sdk";
import { findOrganizationBasicInfoById, organizationRepo } from "../repositories/organization";
import {
  findMembershipId,
  findMembershipRolesByUserId,
  listOrganizationMemberRows,
} from "../repositories/organization-member";
import {
  findUserBasicInfoById,
  findUserBasicInfoByName,
  findUsersBasicInfoByIds,
  searchSystemUsers,
} from "../repositories/user";
import { resolveSystemAdminTenant } from "./ensure-system-admin";

/**
 * `IdentityDirectory` 契约的持久化实现。
 *
 * 承接 `packages/resources/identity-admin` 的身份读取职责（CE 阶段 2 任务 1.2）：此前资源模块直接
 * 查询身份表或经该包的仓储函数读取，迁入后统一收敛到本目录，模块间只依赖 `@fenix/platform-sdk`
 * 的契约类型。
 *
 * 本实现是纯只读投影：不判断动作、不返回归属范围、不参与事务，也不缓存结果——成员关系与组织名录
 * 会随用户操作变化，跨请求复用会读到过期视图（请求内的一次性缓存由调用方按需处理）。
 */

/**
 * 把 `member.role` 收窄到契约取值域。
 *
 * 角色列是自由文本（历史数据可能写入非三态值）；契约是既有权限体系的取值域，未知值退化为最小
 * 权限 `member`，与 web 组织列表补角色时的 `?? "member"` 口径一致。
 */
function toMemberRole(role: string | null): MemberRole {
  return role === "owner" || role === "admin" ? role : "member";
}

/** 创建身份目录实现。 */
export function createIdentityDirectory(): IdentityDirectory {
  return {
    async listUserDisplayInfo(userIds: readonly string[]): Promise<ReadonlyMap<string, UserDisplayInfo>> {
      const rows = await findUsersBasicInfoByIds([...userIds]);
      return new Map(rows.map((row): [string, UserDisplayInfo] => [row.id, row]));
    },

    async getUser(userId: string): Promise<UserDisplayInfo | undefined> {
      return (await findUserBasicInfoById(userId)) ?? undefined;
    },

    async findUserByName(name: string): Promise<UserDisplayInfo | undefined> {
      return (await findUserBasicInfoByName(name)) ?? undefined;
    },

    async searchUsers(input: UserSearchInput): Promise<readonly ApiSystemUserRecord[]> {
      return searchSystemUsers(input);
    },

    async listOrganizationNames(organizationIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
      return organizationRepo.listNamesByIds([...organizationIds]);
    },

    async getOrganization(organizationId: string): Promise<OrganizationSummary | undefined> {
      return (await findOrganizationBasicInfoById(organizationId)) ?? undefined;
    },

    async resolveMembershipId(input: { organizationId: string; userId: string }): Promise<string | undefined> {
      return findMembershipId(input.organizationId, input.userId);
    },

    async listMemberships(userId: string): Promise<readonly MembershipSummary[]> {
      const rows = await findMembershipRolesByUserId(userId);
      return rows.map(
        (row): MembershipSummary => ({
          organizationId: row.organizationId,
          role: toMemberRole(row.role),
        }),
      );
    },

    async resolveSystemTenant(): Promise<SystemTenant> {
      return resolveSystemAdminTenant();
    },

    async listOrganizationsWithMembers(): Promise<readonly OrganizationWithMembers[]> {
      const rows = await listOrganizationMemberRows();
      const organizations = new Map<
        string,
        { id: string; name: string; slug: string; members: OrganizationMemberSummary[] }
      >();
      for (const row of rows) {
        let entry = organizations.get(row.organizationId);
        if (!entry) {
          entry = {
            id: row.organizationId,
            name: row.organizationName,
            slug: row.organizationSlug,
            members: [],
          };
          organizations.set(row.organizationId, entry);
        }
        // 无成员的组织在 leftJoin 下产生一行成员全为 null 的记录，不构成成员项。
        if (!row.userId) continue;
        entry.members.push({
          userId: row.userId,
          name: row.userName ?? "",
          email: row.userEmail ?? "",
          phoneNumber: row.userPhoneNumber,
          role: toMemberRole(row.role),
        });
      }
      return [...organizations.values()];
    },
  };
}
