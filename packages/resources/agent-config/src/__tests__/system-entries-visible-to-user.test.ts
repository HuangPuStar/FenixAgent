import { afterEach, describe, expect, test } from "bun:test";
import type { ActorContext, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { agentConfigResource } from "../server/access/agent-config-resource";
import { AgentConfigFacade } from "../server/facades/agent-config-facade";
import type { ScopedAgentConfigRow } from "../server/repositories/agent-config-resource";
import { getAgentConfigVisibleToUser } from "../server/system-entries";
import { createStubAgentConfigService } from "../server/testing";
import {
  createFakeAccessControl,
  createRecordingScopeStore,
  installAgentModuleStub,
  resetAgentModuleStub,
  scopedAgent,
  testActor,
} from "./fixtures";

/**
 * 「实例起来之前」读 Agent 配置的两处接缝（review §9.1）。
 *
 * 两件事必须同时成立，且用不同的用例守住：
 *
 * 1. **主体真实**：系统流程手上只有 userId 与组织，主体由 `getAgentConfigVisibleToUser` 用身份目录
 *    的成员关系还原——成员关系为空时不得补出任何角色（迁移前那四处传硬编码 `role: "owner"`）。
 * 2. **不带 `access`**：`findReadableRowById` 与 `getById` 走同一个 `read` 谓词，但不为结果补
 *    `access`（那是给持有 actor 的协议层用的视图，带出去会让系统路径以为自己拿到了权限结论），
 *    也顺带省掉一次 `resolveAccess` 查询。
 *
 * 授权规则本身由 `@fenix/access-control` 的用例覆盖；这里只验证两处接缝的编排与契约。
 */

/** 构造真实 Facade，只替换领域服务与平台授权；`resolveAccess` 计数用来证明系统路径没有补 `access`。 */
function buildFacade(row?: ScopedAgentConfigRow) {
  const findByIdInputs: { readonly resourceId: string; readonly access: ResourceQueryConstraint }[] = [];
  let resolveAccessCalls = 0;
  const facade = new AgentConfigFacade(
    createStubAgentConfigService({
      findById: async (input) => {
        findByIdInputs.push(input);
        return row;
      },
    }),
    {
      accessControl: createFakeAccessControl({
        resolveAccess: async () => {
          resolveAccessCalls += 1;
          return { actions: ["read"] };
        },
      }),
      resource: agentConfigResource.definition,
      scopeStore: createRecordingScopeStore().store,
    },
  );
  return { facade, findByIdInputs, resolveAccessCalls: () => resolveAccessCalls };
}

describe("AgentConfigFacade 的系统路径读取", () => {
  // 走 read 谓词读取并原样返回资源行：返回值里不能多出 access 字段，否则系统路径会以为拿到了权限结论。
  test("按 read 谓词读行，返回值不含 access 元数据", async () => {
    const row = scopedAgent();
    const { facade, findByIdInputs, resolveAccessCalls } = buildFacade(row);

    const result = await facade.findReadableRowById(testActor(), "agent-1");

    expect(result).toEqual(row);
    expect(Object.hasOwn(result as object, "access")).toBe(false);
    expect(findByIdInputs).toHaveLength(1);
    expect(findByIdInputs[0]?.resourceId).toBe("agent-1");
    expect(findByIdInputs[0]?.access.action).toBe("read");
    // 关键点：不调用 `resolveAccess`（`getById` 的 `withAccess` 会调），这是与 `getById` 的唯一差别。
    expect(resolveAccessCalls()).toBe(0);
  });

  // 行不可见（谓词未命中）时返回 undefined：由调用方决定失败语义，本方法不制造第二种错误形状。
  test("谓词未命中时返回 undefined", async () => {
    const { facade } = buildFacade(undefined);

    expect(await facade.findReadableRowById(testActor(), "agent-1")).toBeUndefined();
  });
});

describe("getAgentConfigVisibleToUser", () => {
  afterEach(() => resetAgentModuleStub());

  // 主体由本入口还原：userId 与组织取入参，成员关系取身份目录，调用方没有伪造角色的机会。
  test("用身份目录的真实成员关系构造主体", async () => {
    const captured: ActorContext[] = [];
    installAgentModuleStub({
      identity: { listMemberships: async () => [{ organizationId: "org-1", role: "member" }] },
      facade: {
        findReadableRowById: async (actor) => {
          captured.push(actor);
          return scopedAgent();
        },
      },
    });

    const row = await getAgentConfigVisibleToUser({
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(captured[0]).toEqual({
      kind: "user",
      userId: "user-1",
      activeOrganizationId: "org-1",
      memberships: [{ organizationId: "org-1", role: "member" }],
    });
    expect(row?.id).toBe("agent-1");
  });

  // 身份目录没有该用户的成员关系时不补角色也不补成员：判断整体落到公开受众那一条，由平台谓词决定。
  test("身份目录无成员关系时不伪造成员与角色", async () => {
    const captured: ActorContext[] = [];
    installAgentModuleStub({
      identity: { listMemberships: async () => [] },
      facade: {
        findReadableRowById: async (actor): Promise<ScopedAgentConfigRow | undefined> => {
          captured.push(actor);
        },
      },
    });

    const row = await getAgentConfigVisibleToUser({
      agentConfigId: "agent-1",
      organizationId: "org-1",
      userId: "user-1",
    });

    expect(captured[0]?.memberships).toEqual([]);
    expect(row).toBeNull();
  });
});
