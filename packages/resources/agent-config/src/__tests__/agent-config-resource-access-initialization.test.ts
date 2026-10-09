import { describe, expect, test } from "bun:test";
import type { ResourceScope } from "@fenix/platform-sdk";
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

/** 创建真实 Facade，并让领域与授权端口记录创建生命周期。 */
function buildFacade(
  options: {
    readonly created?: boolean;
    readonly initialize?: () => Promise<void>;
    readonly onCreate?: (input: { readonly visibility: string }) => void;
    readonly onInitialize?: (scope: ResourceScope) => void;
  } = {},
) {
  const events: string[] = [];
  const actor = testActor();
  const readConstraint = testListConstraint();
  const scope = {
    organizationId: "org-1",
    ownerUserId: "user-1",
    visibility: "private",
  } satisfies ResourceScope;
  const created = scopedAgent({ id: "agent-created", name: "created-agent" });
  const { store } = createRecordingScopeStore();
  const facade = new AgentConfigFacade(
    createStubAgentConfigService({
      create: async (input) => {
        options.onCreate?.(input);
        events.push("create");
        return { id: created.id, created: options.created ?? true };
      },
      findById: async ({ access, resourceId }) => {
        expect(access).toBe(readConstraint);
        expect(resourceId).toBe(created.id);
        events.push("reload");
        return created;
      },
    }),
    {
      accessControl: createFakeAccessControl({
        resolveInitialScope: async (input) => {
          expect(input.actor).toBe(actor);
          expect(input.resource).toBe(agentConfigResource.definition);
          return scope;
        },
        initializeResourceAccess: async (input) => {
          events.push(`initialize:${input.resourceId}`);
          expect(input.actor).toBe(actor);
          expect(input.resource).toBe(agentConfigResource.definition);
          expect(input.resourceId).toBe(created.id);
          options.onInitialize?.(input.scope);
          await options.initialize?.();
        },
        createListConstraint: async (input) => {
          expect(input.action).toBe("read");
          return readConstraint;
        },
      }),
      resource: agentConfigResource.definition,
      scopeStore: store,
    },
  );

  return { actor, created, events, facade };
}

describe("AgentConfig 创建期资源访问初始化", () => {
  // Facade 不要求进程级事务基础设施。
  test("首次创建后初始化访问范围并返回授权后的 Agent", async () => {
    const { actor, created, events, facade } = buildFacade();

    const result = await facade.create(actor, { name: "created-agent", data: {} });

    expect(result).toEqual({ ...created, access: { actions: ["read", "create", "update", "delete", "use"] } });
    expect(events).toEqual(["create", "initialize:agent-created", "reload"]);
  });

  // 初始化失败必须原样抛出，并且不得回读尚未完成初始化的资源。
  test("初始化访问范围失败时不回读", async () => {
    const failure = new Error("initialize failed");
    const { actor, events, facade } = buildFacade({
      initialize: async () => {
        throw failure;
      },
    });

    await expect(facade.create(actor, { name: "created-agent", data: {} })).rejects.toBe(failure);

    expect(events).toEqual(["create", "initialize:agent-created"]);
  });

  // 同名幂等更新不重新初始化关系。
  test("幂等更新跳过资源访问初始化", async () => {
    const { actor, events, facade } = buildFacade({ created: false });

    await facade.create(actor, { name: "created-agent", data: {} });

    expect(events).toEqual(["create", "reload"]);
  });

  // AgentConfig 的公开读取输入必须收敛为最终 scope，主表与初始化 Hook 不得得到不同 visibility。
  test("公开创建将最终 visibility 同时传给主表与初始化 Hook", async () => {
    let writtenVisibility: string | undefined;
    let initializedVisibility: string | undefined;
    const { actor, events, facade } = buildFacade({
      onCreate: (input) => {
        writtenVisibility = input.visibility;
      },
      onInitialize: (scope) => {
        initializedVisibility = scope.visibility;
      },
    });

    await facade.create(actor, { name: "created-agent", data: {}, publicReadable: true });

    expect(writtenVisibility).toBe("public");
    expect(initializedVisibility).toBe("public");
    expect(events).toEqual(["create", "initialize:agent-created", "reload"]);
  });
});
