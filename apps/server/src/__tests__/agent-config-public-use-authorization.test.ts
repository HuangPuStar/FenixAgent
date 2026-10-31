import { describe, expect, test } from "bun:test";
import { createDrizzleAccessControl } from "@fenix/access-control/suite";
import { agentConfigResource } from "@fenix/agent-config/server";
import type { ActorContext } from "@fenix/platform-sdk";

/**
 * `agent_config` 公开共享的授权口径回归。
 *
 * 共享 Agent 的产品语义是「其他组织可以看到，也可以启动」：可见性来自公开受众的 `read`，
 * 启动来自同一受众的 `use`。两者都由资源注册的 `publicDefaultActions` 表达，不另起一套判定。
 * 公开只放大这两个动作，写动作仍然只属于归属组织的 owner / admin。
 */

const RESOURCE = agentConfigResource.definition;

/** 跨组织主体：属于 org-b，且不是 org-a 的成员。 */
const CROSS_ORG_ACTOR: ActorContext = {
  kind: "user",
  userId: "user-b",
  activeOrganizationId: "org-b",
  memberships: [{ organizationId: "org-b", role: "owner" }],
};

type AccessControlDatabase = Parameters<typeof createDrizzleAccessControl>[0]["database"];

/**
 * 用真实授权策略 + 真实资源注册构造授权。
 *
 * 数据库替身只回答归属范围查询，不触达 SQL：本用例验证的是策略推导，不是谓词编译（后者由
 * access-control 自己的用例覆盖）。`as unknown` 是因为 Drizzle 的链式句柄类型无法在这里精确构造。
 */
function createAccessControl(scope: { organizationId: string; visibility: "public" | "private" }) {
  const database = {
    select: () => ({
      from: () => ({ where: async () => [{ id: "agent-1", userId: "user-a", ...scope }] }),
    }),
  } as unknown as AccessControlDatabase;
  return createDrizzleAccessControl({
    database,
    bindings: [agentConfigResource.storage],
  }).accessControl;
}

describe("agent_config 公开共享授权", () => {
  // 公开=可运行：跨组织非成员必须能 use，否则环境可以创建却无法启动（线上共享 Agent 启动失败的根因）。
  test("公开的 Agent 允许其他组织用户 use", async () => {
    const accessControl = createAccessControl({ organizationId: "org-a", visibility: "public" });

    await expect(
      accessControl.authorize({
        actor: CROSS_ORG_ACTOR,
        action: "use",
        resource: RESOURCE,
        resourceId: "agent-1",
      }),
    ).resolves.toBeUndefined();
  });

  // 公开只放大读与运行，不放大写：跨组织用户不得修改或删除别人共享的 Agent。
  test("公开的 Agent 不授予其他组织写入动作", async () => {
    const accessControl = createAccessControl({ organizationId: "org-a", visibility: "public" });

    await expect(
      accessControl.authorize({
        actor: CROSS_ORG_ACTOR,
        action: "update",
        resource: RESOURCE,
        resourceId: "agent-1",
      }),
    ).rejects.toThrow();
  });

  // 私有 Agent 对非成员仍然拒绝：公开共享不能退化为「跨组织全放行」。
  test("私有 Agent 拒绝跨组织 use", async () => {
    const accessControl = createAccessControl({ organizationId: "org-a", visibility: "private" });

    await expect(
      accessControl.authorize({
        actor: CROSS_ORG_ACTOR,
        action: "use",
        resource: RESOURCE,
        resourceId: "agent-1",
      }),
    ).rejects.toThrow();
  });
});
