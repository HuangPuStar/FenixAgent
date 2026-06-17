import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubConfigPg, stubDb } from "../test-utils/helpers";

const { createWebEnvironment } = await import("../services/environment-web");

function makeEnvironmentRow(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date("2026-06-16T03:35:59.081Z");
  return {
    id: "env_existing",
    name: "env-127f5beb",
    description: null,
    workspacePath: "",
    agentConfigId: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: "env_secret_existing",
    userId: "user-1",
    organizationId: "org-1",
    autoStart: true,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function createSelectChain(selectResults: unknown[][]) {
  let callIndex = 0;
  return () => ({
    from: () => ({
      where: async () => selectResults[callIndex++] ?? [],
      limit: async () => selectResults[callIndex++] ?? [],
    }),
  });
}

describe("createWebEnvironment", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 已有同 agent 的 environment 时应直接复用，避免重复插入。
  test("reuses existing environment for the same agentConfigId", async () => {
    let insertCalled = 0;
    stubConfigPg({
      getReadableAgentConfigById: async () => ({
        id: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
        machineId: null,
      }),
    });
    stubDb({
      select: createSelectChain([[makeEnvironmentRow()]]),
      insert: () => ({
        values: async () => {
          insertCalled += 1;
        },
      }),
    });

    const result = await createWebEnvironment({
      name: "env-127f5beb",
      agentConfigId: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
      autoStart: true,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result.id).toBe("env_existing");
    expect(insertCalled).toBe(0);
  });

  // 同组织下不同用户访问同一 agent 时，不应复用其他用户的 runtime environment。
  test("does not reuse another user's environment for the same agentConfigId", async () => {
    const insertedNames: string[] = [];
    stubConfigPg({
      getReadableAgentConfigById: async () => ({
        id: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
        machineId: null,
      }),
    });
    stubDb({
      select: createSelectChain([[makeEnvironmentRow({ userId: "user-1" })]]),
      insert: () => ({
        values: async (payload: { name: string }) => {
          insertedNames.push(payload.name);
        },
      }),
    });

    const result = await createWebEnvironment({
      name: "env-127f5beb",
      agentConfigId: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
      autoStart: true,
      userId: "user-2",
      organizationId: "org-1",
    });

    expect(result.id).not.toBe("env_existing");
    expect(result.userId).toBe("user-2");
    expect(result.name).toBe("env-127f5beb");
    expect(insertedNames).toEqual(["env-127f5beb"]);
  });

  // 同一用户对同一 agent 的并发创建撞上唯一索引后，应回查并返回已创建的 environment。
  test("returns existing environment after unique conflict on org user agentConfig tuple", async () => {
    stubConfigPg({
      getReadableAgentConfigById: async () => ({
        id: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
        machineId: null,
      }),
    });
    stubDb({
      select: createSelectChain([[], [makeEnvironmentRow()]]),
      insert: () => ({
        values: async () => {
          throw new Error('duplicate key value violates unique constraint "idx_environment_org_user_agent_config"');
        },
      }),
    });

    const result = await createWebEnvironment({
      name: "env-127f5beb",
      agentConfigId: "127f5beb-c4a5-4b6e-8ce3-26fa4bac514b",
      autoStart: true,
      userId: "user-1",
      organizationId: "org-1",
    });

    expect(result.id).toBe("env_existing");
    expect(result.name).toBe("env-127f5beb");
  });
});
