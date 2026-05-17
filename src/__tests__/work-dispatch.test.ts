import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock config before imports
const mockConfig = {
  port: 3000,
  host: "0.0.0.0",
  apiKeys: ["test-api-key"],
  baseUrl: "http://localhost:3000",
  pollTimeout: 1, // Short timeout for tests
  heartbeatInterval: 20,
  jwtExpiresIn: 3600,
  disconnectTimeout: 300,
};

mock.module("../config", () => ({
  config: mockConfig,
  getBaseUrl: () => "http://localhost:3000",
}));

import { resetAllRepos, environmentRepo, sessionRepo, workItemRepo } from "../repositories";
import { db } from "../db";
import { user, team } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  createWorkItem,
  pollWork,
  ackWork,
  stopWork,
  heartbeatWork,
  reconnectWorkForEnvironment,
} from "../services/work-dispatch";

const TEST_TEAM_ID = "d0000000-0000-0000-0000-000000000002";

async function ensureTeam() {
  const [existing] = await db.select().from(team).where(eq(team.id, TEST_TEAM_ID));
  if (!existing) {
    const now = new Date();
    await db.insert(team).values({
      id: TEST_TEAM_ID,
      name: "Work Dispatch Test Team",
      slug: "work-dispatch-test-team",
      createdBy: "u1",
      createdAt: now,
      updatedAt: now,
    });
  }
}

describe("Work Dispatch", () => {
  let envId: string;
  let sessionId: string;

  beforeEach(async () => {
    process.env.RCS_API_KEYS = "test-api-key";
    resetAllRepos();
    // Ensure user exists for foreign key constraint
    const existing = await db.select().from(user).where(eq(user.id, "u1")).limit(1);
    if (existing.length === 0) {
      const now = new Date();
      await db.insert(user).values({ id: "u1", name: "u1", email: "u1@test.com", emailVerified: false, createdAt: now, updatedAt: now });
    }
    await ensureTeam();
    const env = await environmentRepo.create({ userId: "u1", teamId: TEST_TEAM_ID });
    envId = env.id;
    const session = await sessionRepo.create({ environmentId: envId });
    sessionId = session.id;
  });

  describe("createWorkItem", () => {
    test("creates work item for active environment", async () => {
      const workId = await createWorkItem(envId, sessionId);
      expect(workId).toMatch(/^work_/);
      const item = await workItemRepo.getById(workId);
      expect(item?.state).toBe("pending");
      expect(item?.sessionId).toBe(sessionId);
    });

    test("throws for non-existent environment", async () => {
      await expect(createWorkItem("env_no", sessionId)).rejects.toThrow("not found");
    });

    test("throws for inactive environment", async () => {
      const inactiveEnv = await environmentRepo.create({ userId: "u1", teamId: TEST_TEAM_ID });
      // Manually set status to deregistered
      await environmentRepo.update(inactiveEnv.id, { status: "deregistered" });
      await expect(createWorkItem(inactiveEnv.id, sessionId)).rejects.toThrow("not active");
    });

    test("encodes work secret as base64 JSON", async () => {
      const workId = await createWorkItem(envId, sessionId);
      const item = await workItemRepo.getById(workId);
      const decoded = JSON.parse(Buffer.from(item!.secret, "base64url").toString());
      expect(decoded.version).toBe(1);
      expect(decoded.session_ingress_token).toMatch(/^eyJ/);
      expect(decoded.api_base_url).toBe("http://localhost:3000");
    });
  });

  describe("pollWork", () => {
    test("returns null when no work available (timeout)", async () => {
      const result = await pollWork(envId, 0.1);
      expect(result).toBeNull();
    });

    test("returns pending work and marks as dispatched", async () => {
      const workId = await createWorkItem(envId, sessionId);
      const result = await pollWork(envId, 1);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(workId);
      expect(result!.state).toBe("dispatched");
      expect(result!.data.type).toBe("session");
      expect(result!.data.id).toBe(sessionId);
      // Work should no longer be pending
      expect(await workItemRepo.getPendingByEnvironment(envId)).toBeUndefined();
    });

    test("does not return work for different environment", async () => {
      const env2 = await environmentRepo.create({ userId: "u1", teamId: TEST_TEAM_ID });
      await createWorkItem(envId, sessionId);
      const result = await pollWork(env2.id, 0.1);
      expect(result).toBeNull();
    });
  });

  describe("ackWork", () => {
    test("marks work as acked", async () => {
      const workId = await createWorkItem(envId, sessionId);
      await ackWork(workId);
      expect((await workItemRepo.getById(workId))?.state).toBe("acked");
    });
  });

  describe("stopWork", () => {
    test("marks work as completed", async () => {
      const workId = await createWorkItem(envId, sessionId);
      await stopWork(workId);
      expect((await workItemRepo.getById(workId))?.state).toBe("completed");
    });
  });

  describe("heartbeatWork", () => {
    test("extends lease and returns heartbeat info", async () => {
      const workId = await createWorkItem(envId, sessionId);
      const result = await heartbeatWork(workId);
      expect(result.lease_extended).toBe(true);
      expect(result.ttl_seconds).toBe(40); // heartbeatInterval * 2
      expect(result.last_heartbeat).toBeTruthy();
    });

    test("returns default state for non-existent work", async () => {
      const result = await heartbeatWork("work_no");
      expect(result.state).toBe("acked");
    });
  });

  describe("reconnectWorkForEnvironment", () => {
    test("creates work items for idle sessions in environment", async () => {
      // Create another idle session
      await sessionRepo.create({ environmentId: envId });
      const workIds = await reconnectWorkForEnvironment(envId);
      expect(workIds).toHaveLength(2);
      for (const id of workIds) {
        expect((await workItemRepo.getById(id))?.state).toBe("pending");
      }
    });

    test("skips non-idle sessions", async () => {
      const activeSession = await sessionRepo.create({ environmentId: envId });
      await sessionRepo.update(activeSession.id, { status: "active" });
      const workIds = await reconnectWorkForEnvironment(envId);
      // Only the original idle session should get work
      expect(workIds).toHaveLength(1);
    });

    test("returns empty for environment with no sessions", async () => {
      const emptyEnv = await environmentRepo.create({ userId: "u1", teamId: TEST_TEAM_ID });
      const workIds = await reconnectWorkForEnvironment(emptyEnv.id);
      expect(workIds).toHaveLength(0);
    });
  });
});
