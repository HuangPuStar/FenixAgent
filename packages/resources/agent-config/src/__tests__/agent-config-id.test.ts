import { afterEach, expect, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "@fenix/platform-sdk";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { agentConfigResource } from "../server/access/agent-config-resource";
import { AgentConfigFacade } from "../server/facades/agent-config-facade";
import { createStubAgentConfigService } from "../server/testing";
import { createFakeAccessControl, createRecordingScopeStore, denied, scopedAgent, testActor } from "./fixtures";

afterEach(resetAllStubs);

/** 用同名不同归属的行验证真实 Facade 的 ID 定位，而非路由替身。 */
function setup(readOnly = false) {
  const rows = [
    scopedAgent({ id: "agent-a", name: "same-name", organizationId: "org-1" }),
    scopedAgent({ id: "agent-b", name: "same-name", organizationId: "org-2" }),
    scopedAgent({ id: "built-in-id", name: "meta" }),
  ];
  const writes: string[] = [];
  const { store } = createRecordingScopeStore();
  const facade = new AgentConfigFacade(
    createStubAgentConfigService({
      findById: async ({ resourceId }) => rows.find((row) => row.id === resourceId),
      update: async ({ resourceId }) => {
        writes.push(resourceId);
        return true;
      },
      listBoundEnvironmentIds: async ({ resourceId }) => {
        writes.push(`stop:${resourceId}`);
        return [];
      },
      remove: async ({ resourceId }) => {
        writes.push(`delete:${resourceId}`);
        return true;
      },
    }),
    {
      accessControl: createFakeAccessControl(readOnly ? { authorize: async () => denied() } : {}),
      resource: agentConfigResource.definition,
      scopeStore: store,
    },
  );
  return { facade, writes };
}

// 同名资源的修改、重启与删除必须严格命中指定 ID。
test("Agent 同名资源按 ID 隔离全部管理动作", async () => {
  const { facade, writes } = setup();
  const actor = testActor();
  expect((await facade.updateById(actor, "agent-b", { prompt: "changed" })).id).toBe("agent-b");
  await facade.restartInstancesById(actor, "agent-b");
  await facade.removeById(actor, "agent-b");
  expect(writes).toEqual(["agent-b", "stop:agent-b", "stop:agent-b", "delete:agent-b"]);
});

// 传入 UUID 不能绕过内置名称删除保护；未知 ID 不能回退名称或创建。
test("内置 Agent 与失效 ID 不产生写入", async () => {
  const { facade, writes } = setup();
  await expect(facade.removeById(testActor(), "built-in-id")).rejects.toBeInstanceOf(ForbiddenError);
  await expect(facade.updateById(testActor(), "same-name", {})).rejects.toBeInstanceOf(NotFoundError);
  expect(writes).toEqual([]);
});

// ID 只负责定位，update 授权拒绝时不能执行任何写入或实例清理。
test("只读 Agent 的 ID 写入仍被拒绝", async () => {
  const { facade, writes } = setup(true);
  await expect(facade.updateById(testActor(), "agent-b", {})).rejects.toBeInstanceOf(ForbiddenError);
  expect(writes).toEqual([]);
});
