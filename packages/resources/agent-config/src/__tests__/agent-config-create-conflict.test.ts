import { describe, expect, test } from "bun:test";
import type { ActorContext, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { agentConfigResource } from "../server/access/agent-config-resource";
import { AgentConfigFacade } from "../server/facades/agent-config-facade";
import { createStubAgentConfigService } from "../server/testing";
import {
  createFakeAccessControl,
  createRecordingScopeStore,
  scopedAgent,
  testActor,
  testListConstraint,
} from "./fixtures";

/**
 * 创建期同名冲突判定的口径（任务 1.36 的回退）。
 *
 * 名称唯一性是主表约束 `idx_agent_config_org_name` = `(organization_id, name)`，`create` 的 upsert
 * 冲突目标也是这两列；因此创建前的 409 预检必须按**归属组织**判定：
 *
 * 1. 命中口径 = 组织内，不是授权可见集合——其他组织公开的同名 Agent 不构成冲突（可见判定会让这类
 *    合法创建返回 409）；
 * 2. 判定不读取授权条件——唯一性是约束而非授权事实，挂在授权上会随 `memberDefaultActions` /
 *    `ownershipMode` 变化变宽或变窄，upsert 的冲突目标却不会跟着变；
 * 3. 没有目标组织时不是冲突：归属缺失由 `create` 报错，不在这里制造第二种错误语义。
 */

/** 构造真实 Facade，只把领域服务与平台授权替换为可记录的替身。 */
function buildFacade(
  options: {
    readonly row?: ReturnType<typeof scopedAgent>;
    /** 授权可见集合命中的行；用来表达"其他组织公开的同名资源"。 */
    readonly visibleRow?: ReturnType<typeof scopedAgent>;
  } = {},
) {
  const unscopedInputs: { name: string; organizationId: string }[] = [];
  const constraintCalls: ResourceQueryConstraint[] = [];
  const { store } = createRecordingScopeStore();

  const facade = new AgentConfigFacade(
    createStubAgentConfigService({
      findByNameUnscoped: async (input) => {
        unscopedInputs.push(input);
        return options.row;
      },
      // 可见集合读取：带 organizationId 的本组织查询不命中，不带组织的兜底查询命中跨组织公开同名行——
      // 与 `findVisible` 的真实两段式一致。
      findByName: async (input) => (input.organizationId === undefined ? options.visibleRow : undefined),
    }),
    {
      accessControl: createFakeAccessControl({
        createListConstraint: async ({ action }) => {
          const constraint = testListConstraint(action);
          constraintCalls.push(constraint);
          return constraint;
        },
      }),
      resource: agentConfigResource.definition,
      scopeStore: store,
    },
  );

  return { facade, unscopedInputs, constraintCalls };
}

describe("AgentConfig 创建期同名冲突判定", () => {
  // 组织内已有同名行时判为冲突：入参必须是 (name, activeOrganizationId)，两者缺一都会让判定失真。
  test("组织内同名命中时返回 true，并按 (name, activeOrganizationId) 定位", async () => {
    const { facade, unscopedInputs } = buildFacade({ row: scopedAgent({ name: "demo-agent" }) });

    const exists = await facade.existsInOrganization(testActor(), "demo-agent");

    expect(exists).toBe(true);
    expect(unscopedInputs).toEqual([{ name: "demo-agent", organizationId: "org-1" }]);
  });

  // 组织内没有同名行时判为非冲突：调用方据此放行创建，交给仓储的唯一约束兜底并发。
  test("组织内没有同名行时返回 false", async () => {
    const { facade, unscopedInputs } = buildFacade();

    const exists = await facade.existsInOrganization(testActor(), "demo-agent");

    expect(exists).toBe(false);
    expect(unscopedInputs).toEqual([{ name: "demo-agent", organizationId: "org-1" }]);
  });

  // 判定不得读取授权条件：一旦走授权查询，作用域就会跟着可见集合走，与 upsert 的 (organization_id,
  // name) 冲突目标脱钩（其他组织的公开同名资源会让合法创建返回 409）。
  test("判定不经过授权查询", async () => {
    const { facade, constraintCalls } = buildFacade({ row: scopedAgent({ name: "demo-agent" }) });

    await facade.existsInOrganization(testActor(), "demo-agent");

    expect(constraintCalls).toHaveLength(0);
  });

  // 主体没有 active organization 时无从谈"组织内同名"：返回 false 并把归属缺失留给 create 报错。
  test("缺少 active organization 时返回 false 且不查询", async () => {
    const actor: ActorContext = { ...testActor(), activeOrganizationId: undefined };
    const { facade, unscopedInputs } = buildFacade({ row: scopedAgent({ name: "demo-agent" }) });

    const exists = await facade.existsInOrganization(actor, "demo-agent");

    expect(exists).toBe(false);
    expect(unscopedInputs).toHaveLength(0);
  });

  // 这正是回退要修的场景：本组织没有同名行、另一个组织公开了同名 Agent。可见判定（`get`）为真，
  // 组织内判定必须为假——否则那次合法创建会被 409 挡掉。实现一旦退回可见口径，本例即失败。
  test("其他组织公开的同名 Agent 不算冲突（可见 ≠ 组织内）", async () => {
    const { facade } = buildFacade({
      visibleRow: scopedAgent({
        id: "agent-external",
        name: "demo-agent",
        organizationId: "org-2",
        visibility: "public",
      }),
    });

    expect(await facade.get(testActor(), "demo-agent")).toBeDefined();
    expect(await facade.existsInOrganization(testActor(), "demo-agent")).toBe(false);
  });
});
