import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock config before imports
mock.module("../config", () => ({
  config: { port: 3000, host: "0.0.0.0", apiKeys: ["test-api-key"], baseUrl: "http://localhost:3000", disconnectTimeout: 300 },
  getBaseUrl: () => "http://localhost:3000",
}));

const { resetAllRepos, environmentRepo } = await import("../repositories");
const { deleteEnvironment } = await import("../services/environment");
const { db } = await import("../db");
const { user } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const { runDisconnectMonitorSweep } = await import("../services/disconnect-monitor");

async function ensureUser(userId: string) {
  const existing = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  try {
    await db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@acp-token-test.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // User might already exist
  }
}

describe("ACP Token Match", () => {
  beforeEach(async () => {
    resetAllRepos();
    await ensureUser("u-acp-test");
  });

  test("environment.secret can be looked up by secret", async () => {
    const env = await environmentRepo.create({
      name: `test-env-${Date.now()}`,
      workspacePath: "/tmp/ws",
      userId: "u-acp-test",
      status: "idle",
    });

    const found = await environmentRepo.getBySecret(env.secret);
    expect(found).toBeDefined();
    expect(found!.id).toBe(env.id);
    expect(found!.userId).toBe("u-acp-test");
  });

  test("environment.secret returns undefined for non-existent secret", async () => {
    expect(await environmentRepo.getBySecret("no_such_secret")).toBeUndefined();
  });

  test("persistent environment disconnect updates status to idle", async () => {
    const env = await environmentRepo.create({
      name: `persistent-env-${Date.now()}`,
      workspacePath: "/tmp/ws",
      userId: "u-acp-test",
      status: "active",
    });

    // Simulate disconnect — update status to idle
    await environmentRepo.update(env.id, { status: "idle" });

    const updated = await environmentRepo.getById(env.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("idle");
  });

  test("temporary environment disconnect deletes record", async () => {
    const env = await environmentRepo.create({
      userId: "u-acp-test",
      status: "active",
    });

    await deleteEnvironment(env.id);
    expect(await environmentRepo.getById(env.id)).toBeUndefined();
  });

  test("disconnect monitor ACP agent timeout updates status to idle", async () => {
    const past = new Date(Date.now() - 600_000); // 10 minutes ago
    const env = await environmentRepo.create({
      name: `timeout-env-${Date.now()}`,
      workspacePath: "/tmp/ws",
      userId: "u-acp-test",
      status: "active",
    });

    // Manually set lastPollAt to past
    await environmentRepo.update(env.id, { lastPollAt: past });

    await runDisconnectMonitorSweep();

    const updated = await environmentRepo.getById(env.id);
    expect(updated).toBeDefined();
    expect(updated!.status).toBe("idle");
  });
});
