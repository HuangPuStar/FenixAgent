import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { resetCoreRuntime } from "../services/core-bootstrap";
import { _deps, _resetDeps } from "../services/instance";
import { setBuildLaunchSpec } from "../services/launch-spec-builder";

const mockEnvGetById = mock(() => Promise.resolve(undefined as any));

beforeEach(() => {
  resetCoreRuntime();
  _deps.getCoreRuntime = () =>
    ({
      listInstances: mock(() => []),
      getInstance: mock(() => undefined),
      launchInstance: mock(async () => ({})),
      stopInstance: mock(async () => {}),
    }) as any;
  _deps.getAgentConfigById = mock(async () => null as any) as any;
  _deps.getAgentFullConfig = mock(async () => ({ agentConfig: null, providers: [], skills: [], mcpServers: [] }));
  _deps.environmentRepo = { getById: mockEnvGetById } as any;
  _deps.findOrCreateForEnvironment = mock(async () => ({ id: "ses_test" })) as any;
  setBuildLaunchSpec(mock(async () => ({})) as any);
});

afterEach(() => {
  _resetDeps();
  setBuildLaunchSpec(null);
});

import { spawnInstanceFromEnvironment } from "../services/instance";

function makeEnv(overrides: Record<string, unknown>) {
  return {
    userId: "user-1",
    teamId: "user-1",
    ...overrides,
  };
}

describe("instance workspacePath ?? vs || 语义", () => {
  it("workspacePath 为 null 时 fallback 到 directory", async () => {
    mockEnvGetById.mockImplementation(() =>
      Promise.resolve(
        makeEnv({
          id: "env-test",
          workspacePath: null,
          directory: "/home/user/project",
          secret: "secret",
        }),
      ),
    );
    try {
      await spawnInstanceFromEnvironment("user-1", "env-test");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("Workspace directory not set");
    }
  });

  it("workspacePath 和 directory 都为 null 时抛 VALIDATION_ERROR", async () => {
    mockEnvGetById.mockImplementation(() =>
      Promise.resolve(
        makeEnv({
          id: "env-test2",
          workspacePath: null,
          directory: null,
          secret: "secret",
        }),
      ),
    );
    try {
      await spawnInstanceFromEnvironment("user-1", "env-test2");
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect(err).toHaveProperty("code", "VALIDATION_ERROR");
      expect((err as Error).message).toContain("Workspace directory not set");
    }
  });

  it("workspacePath 为空字符串时 ?? 保留空串、触发 !cwd 校验", async () => {
    mockEnvGetById.mockImplementation(() =>
      Promise.resolve(
        makeEnv({
          id: "env-test3",
          workspacePath: "",
          directory: "/home/user/project",
          secret: "secret",
        }),
      ),
    );
    try {
      await spawnInstanceFromEnvironment("user-1", "env-test3");
      expect(true).toBe(false);
    } catch (err: unknown) {
      expect(err).toHaveProperty("code", "VALIDATION_ERROR");
      expect((err as Error).message).toContain("Workspace directory not set");
    }
  });
});
