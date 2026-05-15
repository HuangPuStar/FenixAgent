import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock config with very short timeout for testing
const mockConfig = {
  port: 3000,
  host: "0.0.0.0",
  apiKeys: ["test-api-key"],
  baseUrl: "http://localhost:3000",
  pollTimeout: 8,
  heartbeatInterval: 20,
  jwtExpiresIn: 3600,
  disconnectTimeout: 300,
};

mock.module("../config", () => ({
  config: mockConfig,
  getBaseUrl: () => "http://localhost:3000",
}));

import {
  resetAllRepos,
  environmentRepo,
  sessionRepo,
} from "../repositories";
import { db } from "../db";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import { getEventBus, getAllEventBuses, removeEventBus } from "../transport/event-bus";
import { runDisconnectMonitorSweep } from "../services/disconnect-monitor";

async function ensureUser(userId: string) {
  const existing = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  try {
    await db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@disconnect-monitor-test.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // User might already exist
  }
}

describe("Disconnect Monitor Logic", () => {
  beforeEach(async () => {
    await ensureUser("u1");
    resetAllRepos();
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
  });

  test("environment times out when lastPollAt is too old", async () => {
    const env = await environmentRepo.create({ userId: "u1", workerType: "legacy" });
    const timeoutMs = 300 * 1000; // 5 minutes

    // Simulate lastPollAt being 6 minutes ago
    const oldDate = new Date(Date.now() - timeoutMs - 60000);
    await environmentRepo.update(env.id, { lastPollAt: oldDate });

    await runDisconnectMonitorSweep();

    const updated = await environmentRepo.getById(env.id);
    expect(updated?.status).toBe("disconnected");
  });

  test("environment stays active when lastPollAt is recent", async () => {
    const env = await environmentRepo.create({ userId: "u1", workerType: "legacy" });
    await runDisconnectMonitorSweep();

    const updated = await environmentRepo.getById(env.id);
    expect(updated?.status).toBe("active");
  });

  test("session becomes inactive when updatedAt is too old", async () => {
    const session = await sessionRepo.create({});
    await sessionRepo.update(session.id, { status: "running" });
    const rec = await sessionRepo.getById(session.id);
    expect(rec).toBeTruthy();
    if (!rec) return;

    rec.updatedAt = new Date(Date.now() - 300 * 1000 * 2 - 60000);

    await runDisconnectMonitorSweep();

    const updated = await sessionRepo.getById(session.id);
    expect(updated?.status).toBe("inactive");
  });

  test("session stays running when recently updated", async () => {
    const session = await sessionRepo.create({});
    await sessionRepo.update(session.id, { status: "running" });

    await runDisconnectMonitorSweep();

    const updated = await sessionRepo.getById(session.id);
    expect(updated?.status).toBe("running");
  });

  test("session timeout publishes an inactive session_status event", async () => {
    const session = await sessionRepo.create({});
    await sessionRepo.update(session.id, { status: "idle" });
    const rec = await sessionRepo.getById(session.id);
    expect(rec).toBeTruthy();
    if (!rec) return;
    rec.updatedAt = new Date(Date.now() - 300 * 1000 * 2 - 60000);

    const bus = getEventBus(session.id);
    const events: Array<{ type: string; payload: { status?: string } }> = [];
    bus.subscribe((event) => {
      events.push({ type: event.type, payload: event.payload as { status?: string } });
    });

    await runDisconnectMonitorSweep();

    expect(events).toContainEqual({
      type: "session_status",
      payload: { status: "inactive" },
    });
  });
});
