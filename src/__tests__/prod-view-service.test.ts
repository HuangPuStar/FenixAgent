import { beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubEnvironmentService } from "../test-utils/helpers";

function createSelectChain(selectResults: unknown[][]) {
  let callIndex = 0;
  return () => ({
    from: () => ({
      where: () => ({
        limit: async () => selectResults[callIndex++] ?? [],
      }),
    }),
  });
}

describe("loadProdView", () => {
  beforeEach(() => {
    resetAllStubs();
  });

  // 同组织成员访问发布视图时，应解析到自己的 runtime environment，而不是创建者的私有环境。
  test("returns viewer-specific environment for shared prod view", async () => {
    stubDb({
      select: createSelectChain([
        [
          {
            id: "7539073b-caff-4e5a-baf0-97556a502a84",
            organizationId: "org-1",
            name: "shared-view",
            description: null,
            agentId: "4db8c247-a1e5-436e-8c15-565e3aa60c6e",
            modulesConfig: { chatView: { enabled: true } },
            enabled: true,
            createdBy: "owner-user",
            createdAt: new Date("2026-07-22T06:27:32.585Z"),
            updatedAt: new Date("2026-07-22T06:27:32.585Z"),
          },
        ],
      ]),
    });
    stubEnvironmentRepo({
      findByAgentConfigId: async () => ({
        id: "env_owner",
        userId: "owner-user",
        organizationId: "org-1",
        agentConfigId: "4db8c247-a1e5-436e-8c15-565e3aa60c6e",
      }),
    });
    stubEnvironmentService({
      createWebEnvironment: async () =>
        ({
          id: "env_viewer",
          name: "env-4db8c247",
          description: null,
          agentConfigId: "4db8c247-a1e5-436e-8c15-565e3aa60c6e",
          secret: "env_secret_viewer",
          machineName: null,
          directory: null,
          workspacePath: "",
          branch: null,
          gitRepoUrl: null,
          maxSessions: 1,
          workerType: "acp",
          capabilities: null,
          status: "idle",
          username: null,
          userId: "viewer-user",
          organizationId: "org-1",
          autoStart: true,
          lastPollAt: new Date("2026-07-22T06:28:39.326Z"),
          createdAt: new Date("2026-07-22T06:28:39.326Z"),
          updatedAt: new Date("2026-07-22T06:28:39.326Z"),
        }) as never,
    });

    const { loadProdView } = await import("../services/prod-view");
    const result = await loadProdView(
      {
        organizationId: "org-1",
        userId: "viewer-user",
        role: "member",
      },
      "7539073b-caff-4e5a-baf0-97556a502a84",
    );

    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.environmentId).toBe("env_viewer");
  });
});
