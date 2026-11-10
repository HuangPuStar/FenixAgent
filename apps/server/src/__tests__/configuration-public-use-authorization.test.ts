import { describe, expect, test } from "bun:test";
import { createDrizzleAccessControl } from "@fenix/access-control/suite";
import type { ActorContext } from "@fenix/platform-sdk";
import { mcpServerResource } from "@fenix/resource-mcp/server";
import { skillResource } from "@fenix/resource-skill/server";

const SHARED_RESOURCES = [skillResource, mcpServerResource] as const;

const CROSS_ORG_ACTOR: ActorContext = {
  kind: "user",
  userId: "user-b",
  activeOrganizationId: "org-b",
  memberships: [{ organizationId: "org-b", role: "owner" }],
};

type AccessControlDatabase = ReturnType<Parameters<typeof createDrizzleAccessControl>[0]["database"]>;

/** 只替换数据库归属查询，保留各资源注册与实际授权策略。 */
function createAccessControl(resource: (typeof SHARED_RESOURCES)[number], visibility: "public" | "private") {
  const database = {
    select: () => ({
      from: () => ({
        where: async () => [{ id: "resource-1", userId: "user-a", organizationId: "org-a", visibility }],
      }),
    }),
  } as unknown as AccessControlDatabase;
  return createDrizzleAccessControl({
    database: () => database,
    bindings: [resource.storage],
  }).accessControl;
}

for (const resource of SHARED_RESOURCES) {
  describe(`${resource.definition.type} 公开共享授权`, () => {
    // 公开资源必须同时允许查看与使用，否则选择列表可见但保存 Agent 绑定会失败。
    test("其他组织用户可读取并使用公开资源", async () => {
      const accessControl = createAccessControl(resource, "public");

      await expect(
        accessControl.resolveAccess({
          actor: CROSS_ORG_ACTOR,
          resource: resource.definition,
          resourceId: "resource-1",
        }),
      ).resolves.toEqual({ actions: ["read", "use"] });
      await expect(
        accessControl.authorize({
          actor: CROSS_ORG_ACTOR,
          action: "use",
          resource: resource.definition,
          resourceId: "resource-1",
        }),
      ).resolves.toBeUndefined();
    });

    // 公开受众不获得写权限，防止共享内容被跨组织篡改或删除。
    test("其他组织用户不能修改或删除公开资源", async () => {
      const accessControl = createAccessControl(resource, "public");

      for (const action of ["update", "delete"] as const) {
        await expect(
          accessControl.authorize({
            actor: CROSS_ORG_ACTOR,
            action,
            resource: resource.definition,
            resourceId: "resource-1",
          }),
        ).rejects.toThrow();
      }
    });

    // 私有资源仍然隔离；公开共享不能扩大到未公开的跨组织资源。
    test("其他组织用户不能读取或使用私有资源", async () => {
      const accessControl = createAccessControl(resource, "private");

      for (const action of ["read", "use"] as const) {
        await expect(
          accessControl.authorize({
            actor: CROSS_ORG_ACTOR,
            action,
            resource: resource.definition,
            resourceId: "resource-1",
          }),
        ).rejects.toThrow();
      }
    });
  });
}
