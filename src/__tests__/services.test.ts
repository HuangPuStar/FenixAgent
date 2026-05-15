import { describe, test, expect, beforeEach, mock } from "bun:test";

// Mock config before importing modules
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

import { resetAllRepos, environmentRepo } from "../repositories";
import { db } from "../db";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  createSession,
  createCodeSession,
  getSession,
  updateSessionTitle,
  updateSessionStatus,
  archiveSession,
  incrementEpoch,
  listSessions,
  listSessionSummaries,
  listSessionSummariesByUsername,
  listSessionsByEnvironment,
} from "../services/session";
import {
  registerEnvironment,
  deregisterEnvironment,
  getEnvironment,
  updatePollTime,
  listActiveEnvironments,
  listActiveEnvironmentsResponse,
  listActiveEnvironmentsByUsername,
  reconnectEnvironment,
} from "../services/environment";
import { normalizePayload, publishSessionEvent } from "../services/transport";
import { getEventBus, removeEventBus, getAllEventBuses } from "../transport/event-bus";

async function ensureUser(userId: string) {
  const existing = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  try {
    await db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@services-test.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // User might already exist
  }
}

// ---------- Session Service ----------

describe("Session Service", () => {
  beforeEach(async () => {
    await ensureUser("u1");
    resetAllRepos();
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
  });

  describe("createSession", () => {
    test("creates a session with defaults", async () => {
      const resp = await createSession({});
      expect(resp.id).toMatch(/^session_/);
      expect(resp.status).toBe("idle");
      expect(resp.source).toBe("acp");
      expect(resp.environment_id).toBeNull();
      expect(resp.worker_epoch).toBe(0);
      expect(resp.created_at).toBeGreaterThan(0);
    });

    test("creates a session with all options", async () => {
      const env = await environmentRepo.create({ userId: "u1" });
      const resp = await createSession({
        environment_id: env.id,
        title: "My Session",
        source: "cli",
        permission_mode: "auto",
      });
      expect(resp.environment_id).toBe(env.id);
      expect(resp.title).toBe("My Session");
      expect(resp.source).toBe("cli");
      expect(resp.permission_mode).toBe("auto");
    });

    test("creates session with username", async () => {
      const resp = await createSession({ username: "alice" });
      expect(resp.username).toBe("alice");
    });
  });

  describe("createCodeSession", () => {
    test("creates a code session with cse_ prefix", async () => {
      const resp = await createCodeSession({});
      expect(resp.id).toMatch(/^cse_/);
    });
  });

  describe("getSession", () => {
    test("returns null for non-existent session", async () => {
      expect(await getSession("nope")).toBeNull();
    });

    test("returns created session", async () => {
      const created = await createSession({});
      const fetched = await getSession(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
    });
  });

  describe("updateSessionTitle", () => {
    test("updates title", async () => {
      const s = await createSession({});
      await updateSessionTitle(s.id, "New Title");
      expect((await getSession(s.id))?.title).toBe("New Title");
    });
  });

  describe("updateSessionStatus", () => {
    test("updates status", async () => {
      const s = await createSession({});
      await updateSessionStatus(s.id, "active");
      expect((await getSession(s.id))?.status).toBe("active");
    });
  });

  describe("archiveSession", () => {
    test("sets status to archived and removes event bus", async () => {
      const s = await createSession({});
      // Create event bus for this session
      getEventBus(s.id);
      await archiveSession(s.id);
      expect((await getSession(s.id))?.status).toBe("archived");
      expect(getAllEventBuses().has(s.id)).toBe(false);
    });
  });

  describe("incrementEpoch", () => {
    test("increments epoch by 1", async () => {
      const s = await createSession({});
      expect(await incrementEpoch(s.id)).toBe(1);
      expect(await incrementEpoch(s.id)).toBe(2);
      expect((await getSession(s.id))?.worker_epoch).toBe(2);
    });

    test("throws for non-existent session", async () => {
      await expect(incrementEpoch("nope")).rejects.toThrow("Session not found");
    });
  });

  describe("listSessions", () => {
    test("returns all sessions", async () => {
      await createSession({});
      await createSession({});
      expect(await listSessions()).toHaveLength(2);
    });
  });

  describe("listSessionSummaries", () => {
    test("returns summaries with correct fields", async () => {
      await createSession({ title: "Test" });
      const summaries = await listSessionSummaries();
      expect(summaries).toHaveLength(1);
      expect(summaries[0].title).toBe("Test");
      expect(summaries[0].updated_at).toBeGreaterThan(0);
      // Summary should not have environment_id
      expect("environment_id" in summaries[0]).toBe(false);
    });
  });

  describe("listSessionSummariesByUsername", () => {
    test("filters by username", async () => {
      await createSession({ username: "alice" });
      await createSession({ username: "bob" });
      expect(await listSessionSummariesByUsername("alice")).toHaveLength(1);
    });
  });

  describe("listSessionsByEnvironment", () => {
    test("filters by environment", async () => {
      const env = await environmentRepo.create({ userId: "u1" });
      await createSession({ environment_id: env.id });
      await createSession({});
      expect(await listSessionsByEnvironment(env.id)).toHaveLength(1);
    });
  });
});

// ---------- Environment Service ----------

describe("Environment Service", () => {
  beforeEach(async () => {
    await ensureUser("system");
    resetAllRepos();
  });

  describe("registerEnvironment", () => {
    test("registers environment with defaults", async () => {
      const result = await registerEnvironment({});
      expect(result.environment_id).toMatch(/^env_/);
      expect(result.environment_secret).toMatch(/^env_[0-9a-f]+$/);
      expect(result.status).toBe("active");
    });

    test("registers with options", async () => {
      const result = await registerEnvironment({
        machine_name: "mac1",
        directory: "/home/user",
        branch: "main",
        git_repo_url: "https://github.com/test/repo",
        max_sessions: 5,
        worker_type: "custom",
      });
      const env = await getEnvironment(result.environment_id);
      expect(env?.machineName).toBe("mac1");
      expect(env?.directory).toBe("/home/user");
      expect(env?.maxSessions).toBe(5);
    });

    test("registers with username", async () => {
      const result = await registerEnvironment({ username: "alice" });
      // username is not persisted in DB, but registration succeeds
      expect(result.environment_id).toMatch(/^env_/);
      expect(result.status).toBe("active");
    });
  });

  describe("deregisterEnvironment", () => {
    test("sets status to deregistered", async () => {
      const result = await registerEnvironment({});
      await deregisterEnvironment(result.environment_id);
      const env = await getEnvironment(result.environment_id);
      expect(env?.status).toBe("deregistered");
    });
  });

  describe("updatePollTime", () => {
    test("updates lastPollAt", async () => {
      const result = await registerEnvironment({});
      const before = (await getEnvironment(result.environment_id))?.lastPollAt;
      // Small delay to ensure time difference
      await updatePollTime(result.environment_id);
      const after = (await getEnvironment(result.environment_id))?.lastPollAt;
      expect(after!.getTime()).toBeGreaterThanOrEqual(before!.getTime());
    });
  });

  describe("listActiveEnvironments", () => {
    test("returns active environments", async () => {
      const before = (await listActiveEnvironments()).length;
      await registerEnvironment({});
      await registerEnvironment({});
      expect((await listActiveEnvironments()).length - before).toBe(2);
    });
  });

  describe("listActiveEnvironmentsResponse", () => {
    test("returns response format", async () => {
      const result = await registerEnvironment({ machine_name: "mac1" });
      const envs = await listActiveEnvironmentsResponse();
      const found = envs.find((e: any) => e.id === result.environment_id);
      expect(found).toBeDefined();
      expect(found!.machine_name).toBe("mac1");
      expect(found!.last_poll_at).toBeGreaterThan(0);
    });
  });

  describe("listActiveEnvironmentsByUsername", () => {
    test("filters by username", async () => {
      // Create users alice and bob so the lookup by name works
      await ensureUser("alice");
      await ensureUser("bob");
      const beforeAlice = (await listActiveEnvironmentsByUsername("alice")).length;
      await registerEnvironment({ username: "alice", userId: "alice" });
      await registerEnvironment({ username: "bob", userId: "bob" });
      expect((await listActiveEnvironmentsByUsername("alice")).length - beforeAlice).toBe(1);
    });
  });

  describe("reconnectEnvironment", () => {
    test("sets status back to active", async () => {
      const result = await registerEnvironment({});
      await deregisterEnvironment(result.environment_id);
      expect((await getEnvironment(result.environment_id))?.status).toBe("deregistered");
      await reconnectEnvironment(result.environment_id);
      expect((await getEnvironment(result.environment_id))?.status).toBe("active");
    });
  });
});

// ---------- Transport Service ----------

describe("Transport Service", () => {
  beforeEach(() => {
    resetAllRepos();
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
  });

  describe("normalizePayload", () => {
    test("handles string payload", () => {
      const result = normalizePayload("user", "hello world");
      expect(result.content).toBe("hello world");
      expect(result.raw).toBe("hello world");
    });

    test("handles null payload", () => {
      const result = normalizePayload("user", null);
      expect(result.content).toBe("");
      expect(result.raw).toBeNull();
    });

    test("handles object with direct content", () => {
      const result = normalizePayload("user", { content: "direct text" });
      expect(result.content).toBe("direct text");
    });

    test("handles object with message.content string", () => {
      const result = normalizePayload("assistant", { message: { role: "assistant", content: "reply" } });
      expect(result.content).toBe("reply");
    });

    test("handles object with message.content array", () => {
      const result = normalizePayload("assistant", {
        message: {
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world" },
          ],
        },
      });
      expect(result.content).toBe("hello world");
    });

    test("preserves tool fields", () => {
      const result = normalizePayload("tool_use", { tool_name: "Bash", tool_input: { cmd: "ls" } });
      expect(result.tool_name).toBe("Bash");
      expect(result.tool_input).toEqual({ cmd: "ls" });
    });

    test("preserves permission fields", () => {
      const result = normalizePayload("permission", {
        request_id: "req_1",
        approved: true,
        updated_input: { cmd: "ls -la" },
      });
      expect(result.request_id).toBe("req_1");
      expect(result.approved).toBe(true);
      expect(result.updated_input).toEqual({ cmd: "ls -la" });
    });

    test("preserves message field", () => {
      const msg = { role: "user", content: "hi" };
      const result = normalizePayload("user", { message: msg });
      expect(result.message).toEqual(msg);
    });

    test("preserves uuid field", () => {
      const result = normalizePayload("user", {
        uuid: "msg_123",
        content: "hi",
      });
      expect(result.uuid).toBe("msg_123");
    });

    test("preserves isSynthetic field", () => {
      const result = normalizePayload("user", {
        content: "scheduled job: refresh analytics cache",
        isSynthetic: true,
      });
      expect(result.isSynthetic).toBe(true);
    });

    test("uses name as tool_name fallback", () => {
      const result = normalizePayload("tool", { name: "Read" });
      expect(result.tool_name).toBe("Read");
    });

    test("uses input as tool_input fallback", () => {
      const result = normalizePayload("tool", { input: { path: "/tmp" } });
      expect(result.tool_input).toEqual({ path: "/tmp" });
    });

    test("handles empty content array", () => {
      const result = normalizePayload("assistant", {
        message: { content: [] },
      });
      expect(result.content).toBe("");
    });

    test("preserves task_state fields", () => {
      const result = normalizePayload("task_state", {
        task_list_id: "team-alpha",
        tasks: [{ id: "1", subject: "Task 1", status: "pending" }],
      });
      expect(result.task_list_id).toBe("team-alpha");
      expect(result.tasks).toEqual([
        { id: "1", subject: "Task 1", status: "pending" },
      ]);
    });

    test("preserves status metadata for conversation reset events", () => {
      const result = normalizePayload("status", {
        status: "conversation_cleared",
        subtype: "status",
        message: "conversation_cleared",
      });
      expect(result.status).toBe("conversation_cleared");
      expect(result.subtype).toBe("status");
      expect(result.message).toBe("conversation_cleared");
    });

    test("handles undefined payload", () => {
      const result = normalizePayload("user", undefined);
      expect(result.content).toBe("");
    });
  });

  describe("publishSessionEvent", () => {
    test("publishes event to session bus", () => {
      const event = publishSessionEvent("s1", "user", { content: "hello" }, "outbound");
      expect(event.type).toBe("user");
      expect(event.direction).toBe("outbound");
      expect(event.sessionId).toBe("s1");
      expect(event.seqNum).toBe(1);
    });

    test("normalizes payload before publishing", () => {
      const event = publishSessionEvent("s1", "assistant", { message: { content: "reply" } }, "inbound");
      const payload = event.payload as Record<string, unknown>;
      expect(payload.content).toBe("reply");
    });
  });
});
