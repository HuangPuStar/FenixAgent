import { describe, test, expect, beforeEach } from "bun:test";
import {
  storeReset,
  storeCreateEnvironment,
  storeGetEnvironment,
  storeGetEnvironmentBySecret,
  storeUpdateEnvironment,
  storeListActiveEnvironments,
  storeListEnvironmentsByUserId,
  storeCreateSession,
  storeGetSession,
  storeUpdateSession,
  storeListSessions,
  storeListSessionsByEnvironment,
  storeListSessionsByUserId,
  storeDeleteSession,
  storeDeleteEnvironment,
  storeListAcpAgents,
  storeListAcpAgentsByUserId,
  storeListOnlineAcpAgents,
  storeListSessionsForAgentByCwd,
} from "../store";
import { db } from "../db";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";

function ensureUser(userId: string) {
  const existing = db.select().from(user).where(eq(user.id, userId)).limit(1).all();
  if (existing.length === 0) {
    const now = new Date();
    db.insert(user).values({
      id: userId,
      name: userId,
      email: `${userId}@test.com`,
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    }).run();
  }
}

describe("store", () => {
  beforeEach(() => {
    storeReset();
    ensureUser("user1");
    ensureUser("user-a");
    ensureUser("user-b");
    ensureUser("u1");
  });

  // ---------- Environment ----------

  describe("storeCreateEnvironment", () => {
    test("creates environment with required fields", () => {
      const env = storeCreateEnvironment({ userId: "user1" });
      expect(env.id).toMatch(/^env_/);
      expect(env.secret).toBeTruthy();
      expect(env.status).toBe("active");
      expect(env.userId).toBe("user1");
      expect(env.maxSessions).toBe(1);
      expect(env.workerType).toBe("acp");
      expect(env.lastPollAt).toBeInstanceOf(Date);
      expect(env.createdAt).toBeInstanceOf(Date);
      expect(env.updatedAt).toBeInstanceOf(Date);
    });

    test("auto-generates name when not provided", () => {
      const env = storeCreateEnvironment({ userId: "user1" });
      expect(env.name).toMatch(/^env-/);
    });

    test("uses provided name", () => {
      const env = storeCreateEnvironment({ userId: "user1", name: `my-env-${Date.now()}` });
      expect(env.name).toMatch(/^my-env-/);
    });

    test("defaults workspacePath to /tmp when not provided", () => {
      const env = storeCreateEnvironment({ userId: "user1" });
      expect(env.workspacePath).toBe("/tmp");
    });

    test("creates environment with all optional fields", () => {
      const env = storeCreateEnvironment({
        userId: "user1",
        name: `test-env-${Date.now()}`,
        description: "A test environment",
        workspacePath: "/home/user/project",
        agentName: "build",
        machineName: "my-agent",
        workerType: "acp",
        capabilities: { foo: true },
      });
      expect(env.name).toMatch(/^test-env-/);
      expect(env.description).toBe("A test environment");
      expect(env.workspacePath).toBe("/home/user/project");
      expect(env.agentName).toBe("build");
      expect(env.machineName).toBe("my-agent");
      expect(env.capabilities).toEqual({ foo: true });
    });

    test("creates with custom status", () => {
      const env = storeCreateEnvironment({ userId: "user1", status: "idle" });
      expect(env.status).toBe("idle");
    });

    test("uses provided secret when given", () => {
      const secret = `custom-secret-${Date.now()}`;
      const env = storeCreateEnvironment({ secret, userId: "user1" });
      expect(env.secret).toBe(secret);
    });

    test("auto-generates secret when not provided", () => {
      const env = storeCreateEnvironment({ userId: "user1" });
      expect(env.secret).toMatch(/^sec_/);
    });
  });

  describe("storeGetEnvironment", () => {
    test("returns undefined for non-existent env", () => {
      expect(storeGetEnvironment("env_no")).toBeUndefined();
    });

    test("returns created environment by id", () => {
      const env = storeCreateEnvironment({ userId: "u1" });
      const fetched = storeGetEnvironment(env.id);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(env.id);
      expect(fetched!.secret).toBe(env.secret);
      expect(fetched!.userId).toBe("u1");
    });
  });

  describe("storeGetEnvironmentBySecret", () => {
    test("returns environment matching secret", () => {
      const env = storeCreateEnvironment({ userId: "u1" });
      const fetched = storeGetEnvironmentBySecret(env.secret);
      expect(fetched).toBeDefined();
      expect(fetched!.id).toBe(env.id);
    });

    test("returns undefined for non-existent secret", () => {
      expect(storeGetEnvironmentBySecret("no_such_secret")).toBeUndefined();
    });
  });

  describe("storeUpdateEnvironment", () => {
    test("updates existing environment fields", () => {
      const env = storeCreateEnvironment({ userId: "u1" });
      const result = storeUpdateEnvironment(env.id, { status: "offline", machineName: "host1", capabilities: { bar: 1 } });
      expect(result).toBe(true);
      const updated = storeGetEnvironment(env.id);
      expect(updated?.status).toBe("offline");
      expect(updated?.machineName).toBe("host1");
      expect(updated?.capabilities).toEqual({ bar: 1 });
    });

    test("returns false for non-existent environment", () => {
      expect(storeUpdateEnvironment("env_no", { status: "active" })).toBe(false);
    });
  });

  describe("storeListActiveEnvironments", () => {
    test("returns only active environments", () => {
      const before = storeListActiveEnvironments().length;
      const env1 = storeCreateEnvironment({ userId: "u1" });
      storeCreateEnvironment({ userId: "u1" });
      storeUpdateEnvironment(env1.id, { status: "offline" });
      const active = storeListActiveEnvironments();
      expect(active.length - before).toBe(1);
    });
  });

  describe("storeListEnvironmentsByUserId", () => {
    test("filters by userId", () => {
      const beforeA = storeListEnvironmentsByUserId("user-a").length;
      const beforeB = storeListEnvironmentsByUserId("user-b").length;
      storeCreateEnvironment({ userId: "user-a" });
      storeCreateEnvironment({ userId: "user-b" });
      storeCreateEnvironment({ userId: "user-a" });
      expect(storeListEnvironmentsByUserId("user-a").length - beforeA).toBe(2);
      expect(storeListEnvironmentsByUserId("user-b").length - beforeB).toBe(1);
      expect(storeListEnvironmentsByUserId("user-c")).toHaveLength(0);
    });
  });

  // ---------- Session ----------

  describe("storeCreateSession", () => {
    test("creates session with defaults", () => {
      const session = storeCreateSession({});
      expect(session.id).toMatch(/^session_/);
      expect(session.status).toBe("idle");
      expect(session.source).toBe("acp");
      expect(session.environmentId).toBeNull();
      expect(session.userId).toBeNull();
    });

    test("creates session with options", () => {
      const env = storeCreateEnvironment({ userId: "u1" });
      const session = storeCreateSession({
        environmentId: env.id,
        title: "Test Session",
        source: "web",
        userId: "u1",
      });
      expect(session.environmentId).toBe(env.id);
      expect(session.title).toBe("Test Session");
      expect(session.source).toBe("web");
      expect(session.userId).toBe("u1");
    });
  });

  describe("storeGetSession", () => {
    test("returns undefined for non-existent session", () => {
      expect(storeGetSession("nope")).toBeUndefined();
    });
  });

  describe("storeUpdateSession", () => {
    test("updates existing session", () => {
      const session = storeCreateSession({});
      storeUpdateSession(session.id, { title: "Updated", status: "active" });
      const updated = storeGetSession(session.id);
      expect(updated?.title).toBe("Updated");
      expect(updated?.status).toBe("active");
    });
  });

  describe("storeListSessions", () => {
    test("returns all sessions", () => {
      storeCreateSession({});
      storeCreateSession({});
      expect(storeListSessions()).toHaveLength(2);
    });
  });

  describe("storeListSessionsByEnvironment", () => {
    test("filters by environment", () => {
      const env = storeCreateEnvironment({ userId: "u1" });
      storeCreateSession({ environmentId: env.id });
      storeCreateSession({});
      expect(storeListSessionsByEnvironment(env.id)).toHaveLength(1);
    });
  });

  describe("storeListSessionsByUserId", () => {
    test("filters by userId", () => {
      storeCreateSession({ userId: "user-a" });
      storeCreateSession({ userId: "user-b" });
      storeCreateSession({ userId: "user-a" });
      expect(storeListSessionsByUserId("user-a")).toHaveLength(2);
      expect(storeListSessionsByUserId("user-b")).toHaveLength(1);
    });
  });

  describe("storeDeleteSession", () => {
    test("deletes existing session", () => {
      const session = storeCreateSession({});
      expect(storeDeleteSession(session.id)).toBe(true);
      expect(storeGetSession(session.id)).toBeUndefined();
    });
  });

  // ---------- ACP Agent ----------

  describe("ACP agent lifecycle", () => {
    test("deletes agent and associated sessions", () => {
      const env = storeCreateEnvironment({ userId: "u1", workerType: "acp", machineName: "agent1" });
      storeCreateSession({ environmentId: env.id, title: "test session", userId: "u1" });
      expect(storeDeleteEnvironment(env.id)).toBe(true);
      expect(storeGetEnvironment(env.id)).toBeUndefined();
      expect(storeListSessionsByEnvironment(env.id)).toHaveLength(0);
    });

    test("lists ACP agents", () => {
      const before = storeListAcpAgents().length;
      storeCreateEnvironment({ userId: "u1", workerType: "acp", machineName: "a1" });
      storeCreateEnvironment({ userId: "u1", workerType: "acp", machineName: "a2" });
      expect(storeListAcpAgents().length - before).toBe(2);
    });

    test("lists ACP agents by userId", () => {
      const beforeA = storeListAcpAgentsByUserId("user-a").length;
      const beforeB = storeListAcpAgentsByUserId("user-b").length;
      storeCreateEnvironment({ userId: "user-a", workerType: "acp", machineName: "a1" });
      storeCreateEnvironment({ userId: "user-b", workerType: "acp", machineName: "a2" });
      expect(storeListAcpAgentsByUserId("user-a").length - beforeA).toBe(1);
      expect(storeListAcpAgentsByUserId("user-b").length - beforeB).toBe(1);
    });

    test("lists online ACP agents", () => {
      const before = storeListOnlineAcpAgents().length;
      storeCreateEnvironment({ userId: "u1", workerType: "acp", machineName: "a1" });
      storeCreateEnvironment({ userId: "u1", workerType: "acp", machineName: "a2" });
      expect(storeListOnlineAcpAgents().length - before).toBe(2);
    });
  });

  // ---------- storeListSessionsForAgentByCwd ----------

  describe("storeListSessionsForAgentByCwd", () => {
    test("returns sessions for agent with matching cwd (exact)", () => {
      ensureUser("u-cwd1");
      const env = storeCreateEnvironment({ userId: "u-cwd1", workerType: "acp", workspacePath: "/home/user/project" });
      storeCreateSession({ environmentId: env.id, title: "session 1", userId: "u-cwd1" });
      storeCreateSession({ environmentId: env.id, title: "session 2", userId: "u-cwd1" });

      const result = storeListSessionsForAgentByCwd(env.id, "/home/user/project");
      expect(result).toHaveLength(2);
    });

    test("returns sessions for agent with prefix cwd match", () => {
      ensureUser("u-cwd2");
      const env = storeCreateEnvironment({ userId: "u-cwd2", workerType: "acp", workspacePath: "/home/user/project/subdir" });
      storeCreateSession({ environmentId: env.id, title: "session 1", userId: "u-cwd2" });

      const result = storeListSessionsForAgentByCwd(env.id, "/home/user/project");
      expect(result).toHaveLength(1);
    });

    test("returns empty when cwd does not match", () => {
      ensureUser("u-cwd3");
      const env = storeCreateEnvironment({ userId: "u-cwd3", workerType: "acp", workspacePath: "/home/user/other-project" });
      storeCreateSession({ environmentId: env.id, title: "session 1", userId: "u-cwd3" });

      const result = storeListSessionsForAgentByCwd(env.id, "/home/user/project");
      expect(result).toHaveLength(0);
    });

    test("returns all sessions when cwd is not specified", () => {
      ensureUser("u-cwd4");
      const env = storeCreateEnvironment({ userId: "u-cwd4", workerType: "acp", workspacePath: "/home/user/project" });
      storeCreateSession({ environmentId: env.id, title: "session 1", userId: "u-cwd4" });
      storeCreateSession({ environmentId: env.id, title: "session 2", userId: "u-cwd4" });

      const result = storeListSessionsForAgentByCwd(env.id);
      expect(result).toHaveLength(2);
    });

    test("returns empty for non-existent agent", () => {
      const result = storeListSessionsForAgentByCwd("env_nonexistent", "/any/path");
      expect(result).toHaveLength(0);
    });
  });

  // ---------- storeReset ----------

  describe("storeReset", () => {
    test("clears in-memory data", () => {
      storeCreateSession({});

      storeReset();

      expect(storeListSessions()).toHaveLength(0);
    });
  });

  // ---------- Session Ownership ----------

  describe("storeBindSession / storeIsSessionOwner", () => {
    test("binds user to session and checks ownership", () => {
      const { storeBindSession, storeIsSessionOwner } = require("../store");
      const s = storeCreateSession({});
      storeBindSession(s.id, "uuid-1");
      expect(storeIsSessionOwner(s.id, "uuid-1")).toBe(true);
      expect(storeIsSessionOwner(s.id, "uuid-2")).toBe(false);
    });

    test("supports multiple owners", () => {
      const { storeBindSession, storeGetSessionOwners } = require("../store");
      const s = storeCreateSession({});
      storeBindSession(s.id, "uuid-1");
      storeBindSession(s.id, "uuid-2");
      const owners = storeGetSessionOwners(s.id);
      expect(owners).toBeDefined();
      expect(owners!.size).toBe(2);
    });
  });

  // ---------- Work Items ----------

  describe("Work Items", () => {
    test("create and get work item", () => {
      const { storeCreateWorkItem, storeGetWorkItem } = require("../store");
      const env = storeCreateEnvironment({ userId: "u1" });
      const session = storeCreateSession({ environmentId: env.id });
      const item = storeCreateWorkItem({
        environmentId: env.id,
        sessionId: session.id,
        secret: "test-secret",
      });
      expect(item.id).toMatch(/^work_/);
      expect(item.state).toBe("pending");

      const fetched = storeGetWorkItem(item.id);
      expect(fetched).toBeDefined();
      expect(fetched!.environmentId).toBe(env.id);
    });

    test("get pending work item by environment", () => {
      const { storeCreateWorkItem, storeGetPendingWorkItem } = require("../store");
      const env = storeCreateEnvironment({ userId: "u1" });
      const session = storeCreateSession({ environmentId: env.id });
      storeCreateWorkItem({ environmentId: env.id, sessionId: session.id, secret: "s1" });

      const pending = storeGetPendingWorkItem(env.id);
      expect(pending).toBeDefined();
      expect(pending!.state).toBe("pending");
    });

    test("update work item state", () => {
      const { storeCreateWorkItem, storeUpdateWorkItem, storeGetWorkItem } = require("../store");
      const env = storeCreateEnvironment({ userId: "u1" });
      const session = storeCreateSession({ environmentId: env.id });
      const item = storeCreateWorkItem({ environmentId: env.id, sessionId: session.id, secret: "s1" });

      storeUpdateWorkItem(item.id, { state: "completed" });
      const updated = storeGetWorkItem(item.id);
      expect(updated!.state).toBe("completed");
    });
  });

  // ---------- Session Workers ----------

  describe("Session Workers", () => {
    test("upsert and get session worker", () => {
      const { storeUpsertSessionWorker, storeGetSessionWorker } = require("../store");
      const worker = storeUpsertSessionWorker("session-1", { workerStatus: "running" });
      expect(worker.sessionId).toBe("session-1");
      expect(worker.workerStatus).toBe("running");

      const fetched = storeGetSessionWorker("session-1");
      expect(fetched).toBeDefined();
      expect(fetched!.workerStatus).toBe("running");
    });

    test("upsert updates existing worker", () => {
      const { storeUpsertSessionWorker, storeGetSessionWorker } = require("../store");
      storeUpsertSessionWorker("session-1", { workerStatus: "running" });
      storeUpsertSessionWorker("session-1", { workerStatus: "idle" });
      const fetched = storeGetSessionWorker("session-1");
      expect(fetched!.workerStatus).toBe("idle");
    });
  });

  // ---------- storeListAllEnvironments ----------

  describe("storeListAllEnvironments", () => {
    test("returns all environments regardless of status", () => {
      const { storeListAllEnvironments } = require("../store");
      const before = storeListAllEnvironments().length;
      const env1 = storeCreateEnvironment({ userId: "u1", status: "active" });
      storeCreateEnvironment({ userId: "u1", status: "active" });
      // Deregister one
      const { storeUpdateEnvironment } = require("../store");
      storeUpdateEnvironment(env1.id, { status: "deregistered" });
      const all = storeListAllEnvironments();
      expect(all.length - before).toBe(2);
    });
  });
});
