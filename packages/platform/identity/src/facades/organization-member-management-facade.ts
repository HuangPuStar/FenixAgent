import { type ActorContext, ForbiddenError } from "@fenix/platform-sdk";
import { findOrganizationMembershipRole } from "../repositories/organization-member";
import {
  addOrganizationMembers,
  searchAvailableOrganizationMemberCandidates,
  updateOrganizationMemberRole,
} from "../services/web-organization-service";

type MemberCandidate = Awaited<ReturnType<typeof searchAvailableOrganizationMemberCandidates>>[number];
type AddedMember = Awaited<ReturnType<typeof addOrganizationMembers>>[number];

/** 组织成员管理所需的边界端口。 */
export interface OrganizationMemberManagementFacadeDeps {
  /** 查询当前主体在组织中的实时成员角色。 */
  readonly findMembershipRole?: (organizationId: string, userId: string) => Promise<string | undefined>;
  readonly searchCandidates?: (organizationId: string, keyword: string) => Promise<MemberCandidate[]>;
  readonly addMembers?: (
    organizationId: string,
    userIds: string[],
    role: string,
    headers: Headers,
  ) => Promise<AddedMember[]>;
  readonly updateMemberRole?: (
    organizationId: string,
    memberId: string,
    role: string,
    headers: Headers,
  ) => Promise<void>;
}

/**
 * 组织成员管理的应用 Facade。
 *
 * identity 是 access-control 的基础依赖，组织和成员关系也由 identity 持有；因此此处直接从成员表
 * 实时校验目标组织中的角色，避免产生反向依赖或授权装配循环。
 */
export class OrganizationMemberManagementFacade {
  private readonly searchCandidatesPort: (organizationId: string, keyword: string) => Promise<MemberCandidate[]>;
  private readonly addMembersPort: (
    organizationId: string,
    userIds: string[],
    role: string,
    headers: Headers,
  ) => Promise<AddedMember[]>;
  private readonly findMembershipRolePort: (organizationId: string, userId: string) => Promise<string | undefined>;
  private readonly updateMemberRolePort: (
    organizationId: string,
    memberId: string,
    role: string,
    headers: Headers,
  ) => Promise<void>;

  constructor(deps: OrganizationMemberManagementFacadeDeps) {
    this.searchCandidatesPort = deps.searchCandidates ?? searchAvailableOrganizationMemberCandidates;
    this.addMembersPort = deps.addMembers ?? addOrganizationMembers;
    this.findMembershipRolePort = deps.findMembershipRole ?? findOrganizationMembershipRole;
    this.updateMemberRolePort = deps.updateMemberRole ?? updateOrganizationMemberRole;
  }

  /** 搜索当前组织可添加的成员候选人。 */
  async searchCandidates(actor: ActorContext, organizationId: string, keyword: string): Promise<MemberCandidate[]> {
    await this.requireMemberManager(actor, organizationId);
    if (!keyword) return [];
    return this.searchCandidatesPort(organizationId, keyword);
  }

  /** 向当前组织批量添加成员。 */
  async addMembers(
    actor: ActorContext,
    organizationId: string,
    userIds: string[],
    role: string,
    headers: Headers,
  ): Promise<AddedMember[]> {
    const managerRole = await this.requireMemberManager(actor, organizationId);
    this.assertMayAssignRole(managerRole, role);
    return this.addMembersPort(organizationId, userIds, role, headers);
  }

  /** 更新目标组织成员的角色。 */
  async updateMemberRole(
    actor: ActorContext,
    organizationId: string,
    memberId: string,
    role: string,
    headers: Headers,
  ): Promise<void> {
    const managerRole = await this.requireMemberManager(actor, organizationId);
    this.assertMayAssignRole(managerRole, role);
    await this.updateMemberRolePort(organizationId, memberId, role, headers);
  }

  /** 校验主体在目标组织中具有 admin 或 owner 角色。 */
  private async requireMemberManager(actor: ActorContext, organizationId: string): Promise<"admin" | "owner"> {
    const role = await this.findMembershipRolePort(organizationId, actor.userId);
    if (role !== "admin" && role !== "owner") {
      throw new ForbiddenError("当前主体无权管理该组织成员");
    }
    return role;
  }

  /** owner 角色会授予组织最高权限，只允许现有 owner 显式授予。 */
  private assertMayAssignRole(managerRole: "admin" | "owner", role: string): void {
    const assignsOwner = role
      .split(",")
      .map((item) => item.trim())
      .includes("owner");
    if (!assignsOwner) return;

    if (managerRole !== "owner") {
      throw new ForbiddenError("只有组织 owner 可以授予 owner 角色");
    }
  }
}
