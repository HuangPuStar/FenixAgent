import { describe, expect, test } from "bun:test";
import {
  type ActorContext,
  RESOURCE_QUERY_CONSTRAINT_PAYLOAD,
  type ResourceDefinition,
  type ResourceScope,
  type ResourceScopeStore,
} from "@fenix/platform-sdk";
import { ACCESS_CONTROL_PROVIDER, DefaultAccessControl } from "../index";

const resource: ResourceDefinition = {
  type: "agent-config",
  ownershipMode: "organization",
  actions: ["read", "create", "update", "delete", "use"],
  memberDefaultActions: ["read", "use"],
  publicDefaultActions: ["read"],
};

function storeWith(scope: ResourceScope): ResourceScopeStore {
  return {
    initialize: async () => undefined,
    getMany: async () => new Map([["resource-1", scope]]),
    update: async () => undefined,
    remove: async () => undefined,
  };
}

function actor(role: "owner" | "admin" | "member", userId = "user-1"): ActorContext {
  return { kind: "user", userId, activeOrganizationId: "org-1", memberships: [{ organizationId: "org-1", role }] };
}

function create(scope: ResourceScope): DefaultAccessControl {
  return new DefaultAccessControl(storeWith(scope));
}

describe("DefaultAccessControl", () => {
  // 组织 owner/admin 获得资源声明的全部动作，member 只获得默认动作。
  test("resolves organization role actions", async () => {
    const accessControl = create({ organizationId: "org-1", visibility: "private" });

    await expect(
      accessControl.resolveAccess({ actor: actor("owner"), resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: resource.actions });
    await expect(
      accessControl.resolveAccess({ actor: actor("member"), resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: resource.memberDefaultActions });
  });

  // member 只能读/运行组织资源，写动作必须被拒绝，不能退化为"同组织即可写"。
  test("rejects write actions for organization members", async () => {
    const accessControl = create({ organizationId: "org-1", visibility: "private" });

    await expect(
      accessControl.authorize({ actor: actor("member"), action: "update", resource, resourceId: "resource-1" }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // public 资源在归属规则之外叠加公开默认动作，不提升为 update/delete。
  test("grants only public default actions on public resources", async () => {
    const accessControl = create({ organizationId: "org-other", visibility: "public" });

    await expect(
      accessControl.resolveAccess({ actor: actor("member", "user-other"), resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: resource.publicDefaultActions });
    await expect(
      accessControl.authorize({
        actor: actor("member", "user-other"),
        action: "update",
        resource,
        resourceId: "resource-1",
      }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // 跨组织 private 资源必须拒绝，即使主体属于另一个组织。
  test("rejects cross-organization private access", async () => {
    const accessControl = create({ organizationId: "org-other", visibility: "private" });

    await expect(
      accessControl.authorize({ actor: actor("owner"), action: "read", resource, resourceId: "resource-1" }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // 组织口径是当前组织：只是成员（哪怕是 admin）但不是当前组织的资源，一律不可见、不可写。
  // 这条是"控制台列表混入其他组织私有资源"的回归护栏——按成员关系取并集会让 org-2 的私有资源
  // 出现在 org-1 的列表里。
  test("denies resources of another organization the actor belongs to", async () => {
    const accessControl = create({ organizationId: "org-2", visibility: "private" });
    const multiOrganization: ActorContext = {
      kind: "user",
      userId: "user-1",
      activeOrganizationId: "org-1",
      memberships: [
        { organizationId: "org-1", role: "member" },
        { organizationId: "org-2", role: "admin" },
      ],
    };

    await expect(
      accessControl.resolveAccess({ actor: multiOrganization, resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: [] });
    await expect(
      accessControl.authorize({ actor: multiOrganization, action: "read", resource, resourceId: "resource-1" }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // 同一个主体切到该组织后立刻按该组织里的角色拿到动作：收敛的是口径而不是成员关系本身。
  test("grants actions after switching the active organization", async () => {
    const accessControl = create({ organizationId: "org-2", visibility: "private" });
    const switched: ActorContext = {
      kind: "user",
      userId: "user-1",
      activeOrganizationId: "org-2",
      memberships: [
        { organizationId: "org-1", role: "member" },
        { organizationId: "org-2", role: "admin" },
      ],
    };

    await expect(accessControl.resolveAccess({ actor: switched, resource, resourceId: "resource-1" })).resolves.toEqual(
      { actions: resource.actions },
    );
  });

  // 跨组织共享仍然由 public 表达：不是当前组织、也不是成员组织的公开资源照常只读可见。
  test("keeps public resources of non-member organizations readable", async () => {
    const accessControl = create({ organizationId: "org-foreign", visibility: "public" });
    const actorInOwnOrganization: ActorContext = {
      kind: "user",
      userId: "user-1",
      activeOrganizationId: "org-1",
      memberships: [{ organizationId: "org-1", role: "owner" }],
    };

    await expect(
      accessControl.resolveAccess({ actor: actorInOwnOrganization, resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: resource.publicDefaultActions });
  });

  // 当前组织不在成员关系里（成员关系已失效）时不得回退成任何组织身份：只剩公开受众。
  test("denies organization resources when the active organization is not a membership", async () => {
    const accessControl = create({ organizationId: "org-1", visibility: "private" });
    const staleActor: ActorContext = {
      kind: "user",
      userId: "user-1",
      activeOrganizationId: "org-1",
      memberships: [{ organizationId: "org-9", role: "owner" }],
    };

    await expect(
      accessControl.resolveAccess({ actor: staleActor, resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: [] });
  });

  // organization-personal 资源的 owner 也必须处于资源所属组织，不能跨组织复用 owner 身份。
  test("isolates organization-personal owners by active organization", async () => {
    const personalResource = { ...resource, ownershipMode: "organization-personal" as const };
    const accessControl = create({ organizationId: "org-other", ownerUserId: "user-1", visibility: "private" });

    await expect(
      accessControl.authorize({
        actor: actor("member"),
        action: "read",
        resource: personalResource,
        resourceId: "resource-1",
      }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // 纯个人资源只归 owner，同组织成员不因成员身份获得任何动作。
  test("grants personal resources only to their owner", async () => {
    const personalResource = { ...resource, ownershipMode: "personal" as const };
    const accessControl = create({ ownerUserId: "user-1", visibility: "private" });

    await expect(
      accessControl.resolveAccess({ actor: actor("owner"), resource: personalResource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: resource.actions });
    await expect(
      accessControl.authorize({
        actor: actor("owner", "user-2"),
        action: "read",
        resource: personalResource,
        resourceId: "resource-1",
      }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // super-admin 分支只由构造的 ActorContext 覆盖：当前没有任何生产赋值点（决策 D8）。
  test("grants every declared action to a constructed super-admin actor", async () => {
    const accessControl = create({ organizationId: "org-other", visibility: "private" });
    const superAdmin: ActorContext = { kind: "user", userId: "user-1", systemRole: "super-admin", memberships: [] };

    await expect(
      accessControl.resolveAccess({ actor: superAdmin, resource, resourceId: "resource-1" }),
    ).resolves.toEqual({ actions: resource.actions });
  });

  // 批量版本与单资源版本结论一致，避免列表与详情出现两套动作。
  test("resolves many resources consistently with the single-resource path", async () => {
    const accessControl = new DefaultAccessControl({
      initialize: async () => undefined,
      getMany: async () =>
        new Map([
          ["resource-1", { organizationId: "org-1", visibility: "private" }],
          ["resource-2", { organizationId: "org-other", visibility: "public" }],
        ]),
      update: async () => undefined,
      remove: async () => undefined,
    });

    const access = await accessControl.resolveAccessMany({
      actor: actor("member"),
      resource,
      resourceIds: ["resource-1", "resource-2", "resource-missing"],
    });

    expect([...access.entries()]).toEqual([
      ["resource-1", { actions: resource.memberDefaultActions }],
      ["resource-2", { actions: resource.publicDefaultActions }],
    ]);
  });

  // 初始归属在 INSERT 之前解析：组织资源必须带目标组织，个人资源不得携带组织。
  test("resolves initial scope from the actor context", async () => {
    const accessControl = create({ visibility: "private" });

    await expect(accessControl.resolveInitialScope({ actor: actor("owner"), resource })).resolves.toEqual({
      organizationId: "org-1",
      visibility: "private",
    });
    await expect(
      accessControl.resolveInitialScope({
        actor: actor("owner"),
        resource: { ...resource, ownershipMode: "personal" as const },
      }),
    ).resolves.toEqual({ ownerUserId: "user-1", visibility: "private" });
    await expect(
      accessControl.resolveInitialScope({
        actor: { kind: "user", userId: "user-1", memberships: [] },
        resource,
      }),
    ).rejects.toThrow("资源创建需要目标组织上下文");
  });

  // member 不拥有 create 动作（决策 D1）：创建期的归属解析必须在写入前就拒绝。
  test("rejects initial scope resolution for members without create action", async () => {
    const accessControl = create({ visibility: "private" });

    await expect(accessControl.resolveInitialScope({ actor: actor("member"), resource })).rejects.toThrow(
      "当前主体无权创建该资源",
    );
  });

  // 列表条件是不透明句柄：只暴露产出者、资源类型与动作，载荷键不进 JSON、不被资源模块读取。
  test("emits an opaque list constraint carrying the resolved facts", async () => {
    const accessControl = create({ visibility: "private" });
    const constraint = await accessControl.createListConstraint({ actor: actor("member"), resource, action: "read" });

    expect(constraint.provider).toBe(ACCESS_CONTROL_PROVIDER);
    expect(constraint.resourceType).toBe(resource.type);
    expect(constraint.action).toBe("read");
    expect(JSON.stringify(constraint)).not.toContain("actorUserId");
    expect(Object.getOwnPropertySymbols(constraint)).toEqual([RESOURCE_QUERY_CONSTRAINT_PAYLOAD]);
  });
});
