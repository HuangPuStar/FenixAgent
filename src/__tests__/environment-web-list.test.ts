import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubCoreBootstrap, stubDb } from "../test-utils/helpers";

const now = new Date("2026-07-08T00:00:00.000Z");

function makeEnvRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "env_1",
    name: "runtime-demo-agent",
    description: null,
    workspacePath: "",
    agentConfigId: "agc_1",
    status: "idle",
    machineName: null,
    branch: null,
    gitRepoUrl: null,
    maxSessions: 1,
    workerType: "acp",
    capabilities: null,
    secret: "sec_1",
    userId: "user_1",
    organizationId: "org_1",
    autoStart: true,
    lastPollAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("listEnvironmentsWithInstances", () => {
  beforeEach(() => {
    resetAllStubs();
    stubCoreBootstrap({
      getCoreRuntime: () =>
        ({
          listInstances: () => [],
        }) as never,
    });
  });

  afterEach(() => {
    resetAllStubs();
  });

  test("returns only environments bound to an agent config", async () => {
    stubDb({
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: async () => [
              {
                env: makeEnvRow({ id: "env_bound", agentConfigId: "agc_bound" }),
                agentName: "bound-agent",
              },
            ],
          }),
        }),
      }),
    });

    const { listEnvironmentsWithInstances } = await import("../services/environment-web");
    const rows = await listEnvironmentsWithInstances("org_1", "user_1");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("env_bound");
    expect(rows[0]?.agent_config_id).toBe("agc_bound");
    expect(rows[0]?.agent_name).toBe("bound-agent");
  });
});
