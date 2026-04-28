import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock config before imports
mock.module("../config", () => ({
  config: { port: 3000, host: "0.0.0.0", apiKeys: ["test-api-key"], baseUrl: "http://localhost:3000", disconnectTimeout: 300 },
  getBaseUrl: () => "http://localhost:3000",
}));

const { storeReset, storeCreateEnvironment, storeGetEnvironment, storeGetEnvironmentBySecret, storeUpdateEnvironment, storeDeleteEnvironment } = await import("../store");
const { db } = await import("../db");
const { user } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const { runDisconnectMonitorSweep } = await import("../services/disconnect-monitor");

function ensureUser(userId: string) {
  const existing = db.select().from(user).where(eq(user.id, userId)).limit(1).all();
  if (existing.length > 0) return;
  const now = new Date();
  try {
    db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@acp-token-test.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    }).run();
  } catch {
    // User might already exist
  }
}

describe("ACP Token Match", () => {
  beforeEach(() => {
    storeReset();
    ensureUser("u-acp-test");
  });

  test("environment.secret can be looked up by secret", () => {
    const env = storeCreateEnvironment({
      name: `test-env-${Date.now()}`,
      workspacePath: "/tmp/ws",
      userId: "u-acp-test",
      status: "idle",
    });

    const found = storeGetEnvironmentBySecret(env.secret);
    expect(found).toBeDefined();
    expect(found!.id).toBe(env.id);
    expect(found!.userId).toBe("u-acp-test");
  });

  test("environment.secret returns undefined for non-existent secret", () => {
    expect(storeGetEnvironmentBySecret("no_such_secret")).toBeUndefined();
  });

  test("persistent environment disconnect updates status to idle", () => {
    const env = storeCreateEnvironment({
      name: `persistent-env-${Date.now()}`,
      workspacePath: "/tmp/ws",
      userId: "u-acp-test",
      status: "active",
    });

    // Simulate disconnect — update status to idle
    storeUpdateEnvironment(env.id, { status: "idle" });

    const updated = storeGetEnvironment(env.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("idle");
  });

  test("temporary environment disconnect deletes record", () => {
    const env = storeCreateEnvironment({
      userId: "u-acp-test",
      status: "active",
    });

    storeDeleteEnvironment(env.id);
    expect(storeGetEnvironment(env.id)).toBeUndefined();
  });

  test("disconnect monitor ACP agent timeout updates status to idle", () => {
    const past = new Date(Date.now() - 600_000); // 10 minutes ago
    const env = storeCreateEnvironment({
      name: `timeout-env-${Date.now()}`,
      workspacePath: "/tmp/ws",
      userId: "u-acp-test",
      status: "active",
    });

    // Manually set lastPollAt to past
    storeUpdateEnvironment(env.id, { lastPollAt: past });

    runDisconnectMonitorSweep();

    const updated = storeGetEnvironment(env.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("idle");
  });
});
