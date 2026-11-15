import { afterEach, describe, expect, test } from "bun:test";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import { resolveApiAgentInstance, setApiInstanceResolutionDeps } from "../server/services/api-instance-resolution";

const owner = { organizationId: "org-1", userId: "u1" };
const instance: AgentInstanceRecord = {
  id: "inst_selected",
  environmentId: "env-explicit",
  ownerUserId: "u1",
  creationSource: "user",
  name: "custom",
  isDefault: false,
  createdByUserId: "u1",
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
afterEach(() => setApiInstanceResolutionDeps(null));
describe("API instance selection", () => {
  // 显式实例必须使用自己的 Environment，不能先选默认环境再误拒绝。
  test("explicit instance resolves its own owned environment", async () => {
    setApiInstanceResolutionDeps({
      findVisibleAgentConfig: async () => ({ id: "a", name: "agent", description: null, node: null }),
      getOwnedInstance: async () => instance,
      getEnvironmentById: async () =>
        ({ id: "env-explicit", organizationId: "org-1", userId: "u1", agentConfigId: "a" }) as never,
      listEnvironmentsByOrganizationId: async () => {
        throw new Error("must not choose default");
      },
    });
    expect(await resolveApiAgentInstance(owner, "a", { instanceId: instance.id })).toMatchObject({
      environmentId: "env-explicit",
      instance: { id: "inst_selected" },
    });
  });
  // 工作流来源和跨主体实例不能被 HTTP 调用接管。
  test("rejects workflow and foreign instances", async () => {
    for (const invalid of [
      { ...instance, creationSource: "workflow" as const },
      { ...instance, ownerUserId: "other" },
    ]) {
      setApiInstanceResolutionDeps({
        findVisibleAgentConfig: async () => ({ id: "a", name: "agent", description: null, node: null }),
        getOwnedInstance: async () => invalid,
        getEnvironmentById: async () =>
          ({ id: "env-explicit", organizationId: "org-1", userId: "u1", agentConfigId: "a" }) as never,
      });
      await expect(resolveApiAgentInstance(owner, "a", { instanceId: instance.id })).rejects.toMatchObject({
        statusCode: 404,
      });
    }
  });
  // 多个已有环境按稳定键选择，自动选择只能使用 api/api。
  test("automatic selection is stable by creation time and ID", async () => {
    setApiInstanceResolutionDeps({
      findVisibleAgentConfig: async () => ({ id: "a", name: "agent", description: null, node: null }),
      withEnvironmentLock: async (_owner, _id, fn) => fn(),
      listEnvironmentsByOrganizationId: async () =>
        [
          { id: "env-z", createdAt: new Date(0), organizationId: "org-1", userId: "u1", agentConfigId: "a" },
          { id: "env-a", createdAt: new Date(0), organizationId: "org-1", userId: "u1", agentConfigId: "a" },
        ] as never,
      resolveInstance: async (input) => {
        expect(input.automaticSelection).toBe("api");
        return { ...instance, environmentId: input.environmentId, creationSource: "api", name: "primary" };
      },
    });
    expect((await resolveApiAgentInstance(owner, "a")).environmentId).toBe("env-a");
  });
});

// 临时环境即使更早创建，也不能被普通调用当作默认环境选中。
test("automatic selection excludes temporary environments", async () => {
  setApiInstanceResolutionDeps({
    findVisibleAgentConfig: async () => ({
      id: "a",
      name: "agent",
      description: null,
      organizationId: "org-1",
      node: null,
    }),
    withEnvironmentLock: async (_owner, _id, operation) => operation(),
    listEnvironmentsByOrganizationId: async () =>
      [
        { id: "temp-earliest", createdAt: new Date(0), organizationId: "org-1", userId: "u1", agentConfigId: "a" },
        { id: "env-regular", createdAt: new Date(1), organizationId: "org-1", userId: "u1", agentConfigId: "a" },
      ] as never,
    resolveInstance: async (input) => ({ ...instance, environmentId: input.environmentId }),
  });
  expect((await resolveApiAgentInstance(owner, "a")).environmentId).toBe("env-regular");
});
// 过期错误只能在完整归属及 Agent use 授权后返回，跨组织仍是404。
test("expired owned selection returns 410 while foreign selection stays 404", async () => {
  setApiInstanceResolutionDeps({
    getOwnedInstance: async () => ({ ...instance, environmentId: "temp-expired" }),
    getEnvironmentById: async () =>
      ({
        id: "temp-expired",
        organizationId: "org-1",
        userId: "u1",
        agentConfigId: "a",
        expiresAt: new Date(0),
      }) as never,
    findVisibleAgentConfig: async () => ({
      id: "a",
      name: "agent",
      description: null,
      organizationId: "org-1",
      node: null,
    }),
  });
  await expect(resolveApiAgentInstance(owner, "a", { instanceId: instance.id })).rejects.toMatchObject({
    statusCode: 410,
    code: "ENVIRONMENT_EXPIRED",
  });
  await expect(
    resolveApiAgentInstance({ ...owner, organizationId: "other" }, "a", { instanceId: instance.id }),
  ).rejects.toMatchObject({ statusCode: 404 });
});
