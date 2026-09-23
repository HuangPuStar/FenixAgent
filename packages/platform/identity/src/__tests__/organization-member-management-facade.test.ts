import { describe, expect, test } from "bun:test";
import type { ActorContext } from "@fenix/platform-sdk";
import { ForbiddenError } from "@fenix/platform-sdk";
import { OrganizationMemberManagementFacade } from "../facades/organization-member-management-facade";

const adminActor: ActorContext = {
  kind: "user",
  userId: "user-admin",
  activeOrganizationId: "org-1",
  memberships: [{ organizationId: "org-1", role: "admin" }],
};

const ownerActor: ActorContext = {
  ...adminActor,
  userId: "user-owner",
  memberships: [{ organizationId: "org-1", role: "owner" }],
};

describe("OrganizationMemberManagementFacade", () => {
  // 普通成员不得查询全站候选人，避免借成员管理接口枚举 PII。
  test("searchCandidates 拒绝普通成员且不查询候选人", async () => {
    let queried = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "member",
      searchCandidates: async () => {
        queried = true;
        return [];
      },
      addMembers: async () => [],
    });

    await expect(facade.searchCandidates(adminActor, "org-1", "alice")).rejects.toThrow(ForbiddenError);
    expect(queried).toBeFalse();
  });

  // 空关键词也必须先鉴权，不能让未授权调用者绕过组织管理接口的拒绝语义。
  test("searchCandidates 对空关键词先鉴权且不查询候选人", async () => {
    let queried = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "member",
      searchCandidates: async () => {
        queried = true;
        return [];
      },
      addMembers: async () => [],
    });

    await expect(facade.searchCandidates(adminActor, "org-1", "")).rejects.toThrow(ForbiddenError);
    expect(queried).toBeFalse();
  });

  // 已授权的空关键词不应退化为全站用户查询。
  test("searchCandidates 对已授权主体的空关键词不查询候选人", async () => {
    let queried = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "admin",
      searchCandidates: async () => {
        queried = true;
        return [];
      },
      addMembers: async () => [],
    });

    await expect(facade.searchCandidates(adminActor, "org-1", "")).resolves.toEqual([]);
    expect(queried).toBeFalse();
  });

  // admin 在当前活跃组织可以添加普通成员。
  test("addMembers 允许 admin 添加非 owner 成员", async () => {
    const calls: unknown[] = [];
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "admin",
      searchCandidates: async () => [],
      addMembers: async (...input) => {
        calls.push(input);
        return [];
      },
    });

    await facade.addMembers(adminActor, "org-1", ["user-2"], "member", new Headers());

    expect(calls).toHaveLength(1);
  });

  // admin 不得借添加接口授予 owner，避免绕过 better-auth 的角色提升限制。
  test("addMembers 拒绝 admin 授予 owner", async () => {
    let added = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "admin",
      searchCandidates: async () => [],
      addMembers: async () => {
        added = true;
        return [];
      },
    });

    await expect(facade.addMembers(adminActor, "org-1", ["user-2"], "owner", new Headers())).rejects.toThrow(
      ForbiddenError,
    );
    expect(added).toBeFalse();
  });

  // owner 可以显式授予 owner，组织所有权交接不应被普通成员管理规则阻断。
  test("addMembers 允许 owner 授予 owner", async () => {
    let added = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "owner",
      searchCandidates: async () => [],
      addMembers: async () => {
        added = true;
        return [];
      },
    });

    await facade.addMembers(ownerActor, "org-1", ["user-2"], "owner", new Headers());

    expect(added).toBeTrue();
  });

  // admin 不得通过组合角色绕过 owner 授予限制，避免把自己或其他成员提升为 owner。
  test("updateMemberRole 拒绝 admin 授予组合 owner 角色", async () => {
    let updated = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "admin",
      searchCandidates: async () => [],
      addMembers: async () => [],
      updateMemberRole: async () => {
        updated = true;
      },
    });

    await expect(
      facade.updateMemberRole(adminActor, "org-1", "member-admin", "owner,admin", new Headers()),
    ).rejects.toThrow(ForbiddenError);
    expect(updated).toBeFalse();
  });

  // owner 可合法完成组合角色授权，Facade 不应阻断组织所有权交接。
  test("updateMemberRole 允许 owner 授予组合 owner 角色", async () => {
    let updated = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => "owner",
      searchCandidates: async () => [],
      addMembers: async () => [],
      updateMemberRole: async () => {
        updated = true;
      },
    });

    await facade.updateMemberRole(ownerActor, "org-1", "member-2", "owner,admin", new Headers());

    expect(updated).toBeTrue();
  });

  // 管理范围由目标组织中的实时角色决定，不要求先切换 active organization。
  test("addMembers 允许管理非当前活跃组织", async () => {
    let lookedUp = false;
    let added = false;
    const facade = new OrganizationMemberManagementFacade({
      findMembershipRole: async () => {
        lookedUp = true;
        return "admin";
      },
      searchCandidates: async () => [],
      addMembers: async () => {
        added = true;
        return [];
      },
    });

    await facade.addMembers(ownerActor, "org-2", ["user-2"], "member", new Headers());

    expect(lookedUp).toBeTrue();
    expect(added).toBeTrue();
  });
});
