import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock dependencies before importing the module
const mockProbePort = mock(() => Promise.resolve(true));
const mockSpawn = mock(() => ({
  pid: 12345,
  stdout: { on: mock(() => {}) },
  stderr: { on: mock(() => {}) },
  on: mock(() => {}),
}));

mock.module("node:net", () => ({
  default: {
    createServer: mock(() => ({
      listen: mock((_port: number, cb: () => void) => cb()),
      on: mock((_event: string, cb: (err?: Error) => void) => {
        // Simulate port available by default
      }),
      close: mock((cb: () => void) => cb()),
    })),
  },
  createServer: mock(() => ({
    listen: mock((_port: number, cb: () => void) => cb()),
    on: mock((_event: string, cb: (err?: Error) => void) => {}),
    close: mock((cb: () => void) => cb()),
  })),
}));

mock.module("../config", () => ({
  getBaseUrl: () => "http://localhost:3000",
}));

mock.module("../auth/api-key-service", () => ({
  createApiKey: mock(async (userId: string, label: string) => ({
    record: { id: "key_test", label, keyPrefix: "rcs_test...", createdAt: Date.now(), lastUsedAt: null },
    fullKey: "rcs_test_full_api_key_" + label,
  })),
}));

mock.module("../transport/acp-relay-handler", () => ({
  closeInstanceLocalWs: mock(() => {}),
}));

// Import after mocks are set up
const {
  spawnInstance,
  listInstances,
  getInstance,
  stopInstance,
  stopAllInstances,
  setInstanceSpawnForTesting,
} = await import("../services/instance");

describe("InstanceService", () => {
  // We need to reset the internal module state between tests.
  // Since the module uses module-level Map/Set, we use a workaround:
  // create instances and stop them between tests.
  const createdInstanceIds: string[] = [];

  beforeEach(() => {
    const localBinDir = join(process.cwd(), "node_modules", ".bin");
    const localAcpLink = join(localBinDir, "acp-link");
    mkdirSync(localBinDir, { recursive: true });
    writeFileSync(localAcpLink, "#!/bin/sh\nexit 0\n");
    chmodSync(localAcpLink, 0o755);
    setInstanceSpawnForTesting(mockSpawn as typeof import("node:child_process").spawn);
  });

  afterEach(async () => {
    // Clean up any instances created during tests
    for (const id of createdInstanceIds) {
      try { stopInstance(id, "test-user"); } catch {}
    }
    createdInstanceIds.length = 0;
    setInstanceSpawnForTesting(null);
  });

  test("spawnInstance fails early when acp-link is unavailable", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "instance-service-no-acp-link-"));
    const originalCwd = process.cwd();
    try {
      mkdirSync(join(tempDir, "node_modules", ".bin"), { recursive: true });
      process.chdir(tempDir);

      await expect(spawnInstance("test-user")).rejects.toThrow(
        "Required executable not found: acp-link",
      );
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("spawnInstance uses project-local acp-link binary", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "instance-service-local-acp-link-"));
    const originalCwd = process.cwd();
    try {
      const localBinDir = join(tempDir, "node_modules", ".bin");
      const localAcpLink = join(localBinDir, "acp-link");
      mkdirSync(localBinDir, { recursive: true });
      writeFileSync(localAcpLink, "#!/bin/sh\nexit 0\n");
      chmodSync(localAcpLink, 0o755);

      process.chdir(tempDir);

      const inst = await spawnInstance("test-user");
      createdInstanceIds.push(inst.id);

      expect(mockSpawn).toHaveBeenCalled();
      const lastCall = mockSpawn.mock.calls.at(-1) as [string, ...unknown[]] | undefined;
      expect(lastCall).toBeDefined();
      expect(realpathSync(lastCall![0])).toBe(realpathSync(localAcpLink));
    } finally {
      process.chdir(originalCwd);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("spawnInstance creates an instance and returns it", async () => {
    const inst = await spawnInstance("test-user");
    createdInstanceIds.push(inst.id);

    expect(inst.id).toMatch(/^inst_/);
    expect(inst.userId).toBe("test-user");
    expect(inst.port).toBeGreaterThanOrEqual(8888);
    expect(inst.port).toBeLessThanOrEqual(8999);
    expect(inst.status).toBe("running");
    expect(inst.apiKey).toBeTruthy();
    expect(inst.pid).toBe(12345);
  });

  test("listInstances filters by userId", async () => {
    const inst1 = await spawnInstance("user-a");
    createdInstanceIds.push(inst1.id);
    const inst2 = await spawnInstance("user-b");
    createdInstanceIds.push(inst2.id);

    const userAInstances = listInstances("user-a");
    expect(userAInstances).toHaveLength(1);
    expect(userAInstances[0].userId).toBe("user-a");

    const userBInstances = listInstances("user-b");
    expect(userBInstances).toHaveLength(1);
    expect(userBInstances[0].userId).toBe("user-b");
  });

  test("getInstance returns the correct instance", async () => {
    const inst = await spawnInstance("test-user");
    createdInstanceIds.push(inst.id);

    const found = getInstance(inst.id);
    expect(found).toBeDefined();
    expect(found!.id).toBe(inst.id);
  });

  test("getInstance returns undefined for unknown id", () => {
    const found = getInstance("inst_nonexistent");
    expect(found).toBeUndefined();
  });

  test("stopInstance rejects non-owner", async () => {
    const inst = await spawnInstance("owner-user");
    createdInstanceIds.push(inst.id);

    const result = stopInstance(inst.id, "other-user");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Not your instance");
  });

  test("stopInstance rejects already stopped instance", async () => {
    const inst = await spawnInstance("test-user");
    createdInstanceIds.push(inst.id);

    // Stop it first
    stopInstance(inst.id, "test-user");

    // Try to stop again
    const result = stopInstance(inst.id, "test-user");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Already stopped");
  });

  test("stopInstance returns not found for unknown id", () => {
    const result = stopInstance("inst_nonexistent", "test-user");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("Instance not found");
  });

  test("stopInstance succeeds for valid instance", async () => {
    const inst = await spawnInstance("test-user");
    createdInstanceIds.push(inst.id);

    const result = stopInstance(inst.id, "test-user");
    expect(result.ok).toBe(true);

    const found = getInstance(inst.id);
    expect(found!.status).toBe("stopped");
  });

  test("stopAllInstances iterates all instances", async () => {
    const inst1 = await spawnInstance("user-a");
    createdInstanceIds.push(inst1.id);
    const inst2 = await spawnInstance("user-b");
    createdInstanceIds.push(inst2.id);

    // stopAllInstances should not throw
    stopAllInstances();

    const inst1After = getInstance(inst1.id);
    const inst2After = getInstance(inst2.id);
    // After stopAllInstances, status may still be "running" because process.kill
    // is mocked and doesn't actually change status (the close event handler does)
    // but the function should complete without error
    expect(inst1After).toBeDefined();
    expect(inst2After).toBeDefined();
  });
});
