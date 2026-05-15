import { describe, test, expect, beforeEach, mock, afterEach } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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
  config: {
    knowledgeProvider: "openviking",
    knowledgeBaseUrl: "http://localhost:8090",
    knowledgeApiKey: "",
    knowledgeRequestTimeoutMs: 15000,
  },
  getBaseUrl: () => "http://localhost:3000",
}));

let mockKnowledgeBindings: Array<{ knowledgeBaseId: string; priority: number; enabled: boolean }> = [];

mock.module("../services/agent-knowledge", () => ({
  listAgentKnowledgeBindings: mock(async () => mockKnowledgeBindings),
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

mock.module("../repositories", () => ({
  environmentRepo: {
    getById: mock(async (id: string) => ({
      id,
      userId: "test-user",
      agentName: "test-agent",
      name: "test-env",
      workspacePath: process.cwd(),
      secret: "env_secret_test123",
    })),
    getBySecret: mock(async (secret: string) => {
      if (secret === "env_secret_test123") {
        return {
          id: "env_test_secret",
          userId: "test-user",
          agentName: "test-agent",
          name: "test-env",
          workspacePath: process.cwd(),
          secret,
        };
      }
      if (secret === "env_secret_kb_mcp") {
        return {
          id: "env_kb_mcp",
          userId: "kb-mcp-user",
          agentName: "general",
          name: "kb-mcp-env",
          workspacePath: process.cwd(),
          secret,
        };
      }
      return undefined;
    }),
    update: mock(async () => true),
    delete: mock(async () => true),
    create: mock(async (params: any) => ({
      id: `env_${Date.now()}`,
      ...params,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastPollAt: new Date(),
      maxSessions: 1,
      workerType: "acp",
      capabilities: null,
      status: params.status || "active",
    })),
    listActive: mock(async () => []),
    listAll: mock(async () => []),
    listByUserId: mock(async () => []),
    listActiveByUsername: mock(async () => []),
    listAcpAgents: mock(async () => []),
    listAcpAgentsByUserId: mock(async () => []),
    listOnlineAcpAgents: mock(async () => []),
  },
  sessionRepo: {
    create: mock(async (req: any) => ({
      id: `session_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      environmentId: req.environmentId ?? null,
      title: req.title ?? null,
      status: "idle",
      source: req.source ?? "acp",
      permissionMode: null,
      workerEpoch: 0,
      username: null,
      userId: req.userId ?? null,
      cwd: null,
      shareMode: "none",
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
    getById: mock(async () => undefined),
    update: mock(async () => true),
    delete: mock(async () => true),
    listAll: mock(async () => []),
    listByEnvironment: mock(async () => []),
    listByUserId: mock(async () => []),
    listForAgentByCwd: mock(async () => []),
    listByOwnerUuid: mock(async () => []),
    listByUsername: mock(async () => []),
    dissociateFromEnvironment: mock(async () => {}),
    loadFromDB: mock(async () => {}),
    bindOwner: mock(async () => {}),
    isOwner: mock(async () => false),
    getOwners: mock(async () => undefined),
    setShareMode: mock(() => {}),
    reset: mock(() => {}),
  },
  sessionWorkerRepo: {
    get: mock(async () => undefined),
    upsert: mock(async (_sessionId: string, patch: any) => ({ sessionId: _sessionId, workerStatus: patch?.workerStatus ?? null, externalMetadata: null, requiresActionDetails: null, lastHeartbeatAt: null })),
    reset: mock(() => {}),
  },
  shareLinkRepo: {},
  tokenRepo: {
    create: mock(async () => {}),
    getByToken: mock(async () => undefined),
    reset: mock(() => {}),
  },
  workItemRepo: {
    create: mock(async (params: any) => ({ id: `work_${Date.now()}`, ...params, state: "pending", createdAt: new Date(), updatedAt: new Date() })),
    getById: mock(async () => undefined),
    getPendingByEnvironment: mock(async () => undefined),
    update: mock(async () => true),
    reset: mock(() => {}),
  },
  resetAllRepos: mock(() => {}),
}));

mock.module("../utils/executable", () => ({
  resolveExecutable: mock(() => process.cwd() + "/node_modules/.bin/acp-link"),
}));

// Import after mocks are set up
const {
  spawnInstance,
  listInstances,
  getInstance,
  stopInstance,
  stopAllInstances,
  setInstanceSpawnForTesting,
  listInstancesByEnvironment,
  getRunningInstancesByEnvironment,
  spawnInstanceFromEnvironment,
} = await import("../services/instance");

describe("InstanceService", () => {
  // We need to reset the internal module state between tests.
  // Since the module uses module-level Map/Set, we use a workaround:
  // create instances and stop them between tests.
  const createdInstanceIds: string[] = [];
  let originalCwd = process.cwd();
  let testCwd: string | null = null;

  beforeEach(() => {
    originalCwd = process.cwd();
    testCwd = mkdtempSync(join(tmpdir(), "instance-service-cwd-"));
    const localBinDir = join(testCwd, "node_modules", ".bin");
    const localAcpLink = join(localBinDir, "acp-link");
    mkdirSync(localBinDir, { recursive: true });
    writeFileSync(localAcpLink, "#!/bin/sh\nexit 0\n");
    chmodSync(localAcpLink, 0o755);
    process.chdir(testCwd);
    mockKnowledgeBindings = [];
    setInstanceSpawnForTesting(mockSpawn as unknown as typeof import("node:child_process").spawn);
  });

  afterEach(async () => {
    // Clean up any instances created during tests
    for (const id of createdInstanceIds) {
      try { stopInstance(id, "test-user"); } catch {}
    }
    createdInstanceIds.length = 0;
    setInstanceSpawnForTesting(null);
    process.chdir(originalCwd);
    if (testCwd) {
      rmSync(testCwd, { recursive: true, force: true });
      testCwd = null;
    }
  });

  test("spawnInstance falls back to system PATH when local acp-link is missing", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "instance-service-no-acp-link-"));
    const cwdBeforeSwitch = process.cwd();
    try {
      mkdirSync(join(tempDir, "node_modules", ".bin"), { recursive: true });
      process.chdir(tempDir);

      // resolveExecutable should fall back to system PATH (which acp-link)
      // If acp-link is globally installed, spawn succeeds; otherwise it throws.
      try {
        const inst = await spawnInstance("test-user");
        createdInstanceIds.push(inst.id);
        // Success — global acp-link was found
      } catch (e: any) {
        // If not found anywhere, error message should mention both the executable and install command
        expect(e.message).toContain("Required executable not found: acp-link");
        expect(e.message).toContain("bun install -g");
      }
    } finally {
      process.chdir(cwdBeforeSwitch);
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test("spawnInstance uses project-local acp-link binary", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "instance-service-local-acp-link-"));
    const cwdBeforeSwitch = process.cwd();
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
      process.chdir(cwdBeforeSwitch);
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

describe("InstanceService multi-instance", () => {
  let originalCwd = process.cwd();
  let testCwd: string | null = null;

  beforeEach(() => {
    originalCwd = process.cwd();
    testCwd = mkdtempSync(join(tmpdir(), "instance-multi-"));
    process.chdir(testCwd);
    mockKnowledgeBindings = [];
    setInstanceSpawnForTesting(mockSpawn as unknown as typeof import("node:child_process").spawn);
  });

  afterEach(() => {
    stopAllInstances();
    setInstanceSpawnForTesting(null);
    process.chdir(originalCwd);
    if (testCwd) {
      rmSync(testCwd, { recursive: true, force: true });
      testCwd = null;
    }
  });

  test("multiple instances can be created for the same environment", async () => {
    const inst1 = await spawnInstanceFromEnvironment("test-user", "env_test_1");
    const inst2 = await spawnInstanceFromEnvironment("test-user", "env_test_1");
    expect(inst1.id).not.toBe(inst2.id);
    expect(inst1.status).toBe("running");
    expect(inst2.status).toBe("running");
  });

  test("instance numbers are strictly increasing", async () => {
    const inst1 = await spawnInstanceFromEnvironment("test-user", "env_test_num");
    const inst2 = await spawnInstanceFromEnvironment("test-user", "env_test_num");
    const inst3 = await spawnInstanceFromEnvironment("test-user", "env_test_num");
    expect(inst1.instanceNumber).toBe(1);
    expect(inst2.instanceNumber).toBe(2);
    expect(inst3.instanceNumber).toBe(3);
  });

  test("instance numbers are not recycled after stop", async () => {
    const inst1 = await spawnInstanceFromEnvironment("test-user", "env_test_recycle");
    stopInstance(inst1.id, "test-user");
    const inst2 = await spawnInstanceFromEnvironment("test-user", "env_test_recycle");
    expect(inst2.instanceNumber).toBe(2);
  });

  test("listInstancesByEnvironment returns only active instances", async () => {
    const inst1 = await spawnInstanceFromEnvironment("test-user", "env_test_list");
    const inst2 = await spawnInstanceFromEnvironment("test-user", "env_test_list");
    const inst3 = await spawnInstanceFromEnvironment("test-user", "env_test_list");
    stopInstance(inst1.id, "test-user");
    const active = listInstancesByEnvironment("env_test_list");
    expect(active).toHaveLength(2);
    expect(active.every(i => i.status !== "stopped" && i.status !== "error")).toBe(true);
  });

  test("getRunningInstancesByEnvironment returns only running instances", async () => {
    const inst1 = await spawnInstanceFromEnvironment("test-user", "env_test_running");
    const inst2 = await spawnInstanceFromEnvironment("test-user", "env_test_running");
    const running = getRunningInstancesByEnvironment("env_test_running");
    expect(running).toHaveLength(2);
    expect(running.every(i => i.status === "running")).toBe(true);
  });

  test("each instance gets an independent session", async () => {
    const inst1 = await spawnInstanceFromEnvironment("test-user", "env_test_session");
    const inst2 = await spawnInstanceFromEnvironment("test-user", "env_test_session");
    expect(inst1.sessionId).toBeTruthy();
    expect(inst2.sessionId).toBeTruthy();
    expect(inst1.sessionId).not.toBe(inst2.sessionId);
  });

  test("default agent with knowledge bindings injects kb MCP config", async () => {
    mockKnowledgeBindings = [{ knowledgeBaseId: "kb_1", priority: 0, enabled: true }];
    await spawnInstanceFromEnvironment("test-user", "env_test_inject");

    const configPath = join(process.cwd(), ".opencode", "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.default_agent).toBe("test-agent");
    expect(config.mcp.kb).toEqual({
      type: "remote",
      url: "http://localhost:3000/mcp/knowledge",
      headers: { Authorization: "Bearer env_secret_test123" },
      enabled: true,
      timeout: 15000,
    });
  });

  test("default agent without knowledge bindings does not inject knowledge MCP config", async () => {
    await spawnInstanceFromEnvironment("test-user", "env_test_no_kb");

    const configPath = join(process.cwd(), ".opencode", "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.default_agent).toBe("test-agent");
    expect(config.mcp).toBeUndefined();
  });
});
