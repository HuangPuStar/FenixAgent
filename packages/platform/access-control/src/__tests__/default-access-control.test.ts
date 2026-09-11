import { describe, expect, test } from "bun:test";
import { requestAls } from "@fenix/logger";
import type { ActorContext, ResourceDefinition, ResourceScope, ResourceScopeStore } from "@fenix/platform-sdk";
import { DefaultAccessControl } from "../index";

const resource: ResourceDefinition = {
  type: "agent-config",
  ownershipMode: "organization",
  actions: ["read", "create", "update", "delete", "use"],
  memberDefaultActions: ["read", "use"],
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

describe("DefaultAccessControl", () => {
  // 组织 owner/admin 获得资源声明的全部动作，member 只获得默认动作。
  test("resolves organization role actions", async () => {
    const accessControl = new DefaultAccessControl({
      scopeStore: storeWith({ organizationId: "org-1", visibility: "private" }),
    });

    await expect(
      accessControl.resolveAccess({ actor: actor("owner"), resource, resourceId: "resource-1" }),
    ).resolves.toEqual({
      actions: resource.actions,
    });
    await expect(
      accessControl.resolveAccess({ actor: actor("member"), resource, resourceId: "resource-1" }),
    ).resolves.toEqual({
      actions: resource.memberDefaultActions,
    });
  });

  // public 资源只对已认证主体开放资源声明的默认动作，不提升为 update/delete。
  test("exposes only default actions for public resources", async () => {
    const accessControl = new DefaultAccessControl({
      scopeStore: storeWith({ organizationId: "org-other", visibility: "public" }),
    });

    await expect(
      accessControl.resolveAccess({ actor: actor("member", "user-other"), resource, resourceId: "resource-1" }),
    ).resolves.toEqual({
      actions: resource.memberDefaultActions,
    });
  });

  // 跨组织 private 资源必须拒绝，即使主体属于另一个组织。
  test("rejects cross-organization private access", async () => {
    const accessControl = new DefaultAccessControl({
      scopeStore: storeWith({ organizationId: "org-other", visibility: "private" }),
    });

    await expect(
      accessControl.authorize({ actor: actor("owner"), action: "read", resource, resourceId: "resource-1" }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // organization-personal 资源的 owner 也必须处于资源所属组织，不能跨组织复用 owner 身份。
  test("isolates organization-personal owners by active organization", async () => {
    const personalResource = { ...resource, ownershipMode: "organization-personal" as const };
    const accessControl = new DefaultAccessControl({
      scopeStore: storeWith({ organizationId: "org-other", ownerUserId: "user-1", visibility: "private" }),
    });

    await expect(
      accessControl.authorize({
        actor: actor("member"),
        action: "read",
        resource: personalResource,
        resourceId: "resource-1",
      }),
    ).rejects.toThrow("当前主体无权执行资源动作");
  });

  // 初始化归属必须使用 actor 的可信组织上下文，不能从资源请求传入的字段推导。
  test("requires organization context for organization resources", async () => {
    const accessControl = new DefaultAccessControl({ scopeStore: storeWith({ visibility: "private" }) });
    const noOrganization: ActorContext = { kind: "user", userId: "user-1", memberships: [] };

    await expect(
      accessControl.initializeResourceAccess({ actor: noOrganization, resource, resourceId: "resource-1" }),
    ).rejects.toThrow("资源创建需要当前组织上下文");
  });

  // 默认 actor resolver 从认证 ALS 继承当前组织和角色，保持 session/API key 的既有语义。
  test("resolves the authenticated role from request context", async () => {
    const accessControl = new DefaultAccessControl({
      scopeStore: storeWith({ organizationId: "org-1", visibility: "private" }),
    });
    const result = await requestAls.run(
      { requestId: "req-access", userId: "user-1", organizationId: "org-1", role: "admin" },
      () => accessControl.createActorContext({ actorId: "user-1" }),
    );

    expect(result.memberships).toEqual([{ organizationId: "org-1", role: "admin" }]);
  });
});
