import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb, stubResourcePermissionRepo } from "../test-utils/helpers";

const now = new Date("2026-07-08T00:00:00.000Z");

describe("deleteAgentConfig", () => {
  beforeEach(() => {
    resetAllStubs();
    stubResourcePermissionRepo({
      listOwnedByOrganization: async () => [],
    });
  });

  test("deletes bound environments before deleting the agent config", async () => {
    const deleteCalls: string[] = [];

    stubDb({
      select: () => ({
        from: () => ({
          where: () =>
            Object.assign(
              Promise.resolve([
                {
                  id: "agc_1",
                  organizationId: "org_1",
                  userId: "user_1",
                  name: "demo-agent",
                  prompt: null,
                  model: null,
                  modelId: null,
                  description: null,
                  extra: null,
                  machineId: null,
                  createdAt: now,
                  updatedAt: now,
                },
              ]),
              {
                limit: async () => [
                  {
                    id: "agc_1",
                    organizationId: "org_1",
                    userId: "user_1",
                    name: "demo-agent",
                    prompt: null,
                    model: null,
                    modelId: null,
                    description: null,
                    extra: null,
                    machineId: null,
                    createdAt: now,
                    updatedAt: now,
                  },
                ],
              },
            ),
        }),
      }),
      transaction: async (callback: (tx: Record<string, unknown>) => Promise<boolean>) =>
        callback({
          delete: () => ({
            where: () => {
              deleteCalls.push(deleteCalls.length === 0 ? "environment" : "agent_config");
              if (deleteCalls.at(-1) === "agent_config") {
                return {
                  returning: async () => [{ id: "agc_1" }],
                };
              }
              return Promise.resolve({ count: 2 });
            },
          }),
        }),
    });

    const { deleteAgentConfig } = await import("../services/config/agent-config");
    const deleted = await deleteAgentConfig({ organizationId: "org_1", userId: "user_1", role: "owner" }, "demo-agent");

    expect(deleted).toBe(true);
    expect(deleteCalls).toEqual(["environment", "agent_config"]);
  });
});
