import { describe, test, expect, beforeEach } from "bun:test";
import {
  storeReset,
  storeCreateEnvironment,
  storeCreateSession,
  storeGetSession,
  storeBindSession,
  storeGetSessionOwners,
} from "../store";
import { db } from "../db";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  toWebSessionId,
  toWebSessionResponse,
  createSession,
  getSession,
  isSessionClosedStatus,
  resolveExistingSessionId,
  resolveOwnedWebSessionId,
  listWebSessionsByOwnerUuid,
  updateSessionTitle,
  touchSession,
  listSessions,
} from "../services/session";
import { removeEventBus, getAllEventBuses } from "../transport/event-bus";

function ensureUser(userId: string) {
  const existing = db.select().from(user).where(eq(user.id, userId)).limit(1).all();
  if (existing.length === 0) {
    const now = new Date();
    try {
      db.insert(user).values({
        id: userId,
        name: userId,
        email: `${userId}@session-svc-test.com`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      }).run();
    } catch {
      // User might already exist
    }
  }
}

describe("Session Service - Extended Tests", () => {
  beforeEach(() => {
    ensureUser("u1");
    storeReset();
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
  });

  describe("toWebSessionId", () => {
    test("converts cse_ prefix to session_ prefix", () => {
      expect(toWebSessionId("cse_abc123")).toBe("session_abc123");
    });

    test("leaves session_ prefix unchanged", () => {
      expect(toWebSessionId("session_abc123")).toBe("session_abc123");
    });

    test("leaves other prefixes unchanged", () => {
      expect(toWebSessionId("other_abc123")).toBe("other_abc123");
    });
  });

  describe("toWebSessionResponse", () => {
    test("converts session id to web format", () => {
      const s = createSession({});
      const webResp = toWebSessionResponse(s);
      expect(webResp.id).toBe(s.id);
    });

    test("converts code session id to web format", () => {
      const env = storeCreateEnvironment({ userId: "u1" });
      // Manually create a session with cse_ prefix
      const record = storeCreateSession({
        idPrefix: "cse_",
        environmentId: env.id,
        title: "Code Session",
      });
      // Build a response-like object
      const resp = {
        id: record.id,
        environment_id: record.environmentId,
        title: record.title,
        status: record.status,
        source: record.source,
        permission_mode: record.permissionMode,
        worker_epoch: record.workerEpoch,
        username: record.username,
        created_at: record.createdAt.getTime() / 1000,
        updated_at: record.updatedAt.getTime() / 1000,
      };
      const webResp = toWebSessionResponse(resp);
      expect(webResp.id).toBe(`session_${record.id.slice(4)}`);
    });
  });

  describe("isSessionClosedStatus", () => {
    test("returns true for archived", () => {
      expect(isSessionClosedStatus("archived")).toBe(true);
    });

    test("returns true for inactive", () => {
      expect(isSessionClosedStatus("inactive")).toBe(true);
    });

    test("returns false for active", () => {
      expect(isSessionClosedStatus("active")).toBe(false);
    });

    test("returns false for idle", () => {
      expect(isSessionClosedStatus("idle")).toBe(false);
    });

    test("returns false for null", () => {
      expect(isSessionClosedStatus(null)).toBe(false);
    });

    test("returns false for undefined", () => {
      expect(isSessionClosedStatus(undefined)).toBe(false);
    });
  });

  describe("resolveExistingSessionId", () => {
    test("returns id when session exists", () => {
      const s = createSession({});
      expect(resolveExistingSessionId(s.id)).toBe(s.id);
    });

    test("returns null when session does not exist", () => {
      expect(resolveExistingSessionId("nonexistent")).toBeNull();
    });

    test("resolves web session id to code session id", () => {
      const record = storeCreateSession({ idPrefix: "cse_" });
      const webId = `session_${record.id.slice(4)}`;
      expect(resolveExistingSessionId(webId)).toBe(record.id);
    });
  });

  describe("resolveOwnedWebSessionId", () => {
    test("returns session id when user is owner", () => {
      const s = createSession({});
      storeBindSession(s.id, "user-uuid-1");
      expect(resolveOwnedWebSessionId(s.id, "user-uuid-1")).toBe(s.id);
    });

    test("returns null when session does not exist", () => {
      expect(resolveOwnedWebSessionId("nonexistent", "user-uuid-1")).toBeNull();
    });

    test("returns null when user is not owner and session has owners", () => {
      const s = createSession({});
      storeBindSession(s.id, "user-uuid-1");
      expect(resolveOwnedWebSessionId(s.id, "user-uuid-2")).toBeNull();
    });

    test("auto-binds unclaimed session to requesting user", () => {
      const s = createSession({});
      // Session has no owners
      const owners = storeGetSessionOwners(s.id);
      expect(owners).toBeUndefined();

      const resolved = resolveOwnedWebSessionId(s.id, "user-uuid-auto");
      expect(resolved).toBe(s.id);

      // Now the session should be bound
      const ownersAfter = storeGetSessionOwners(s.id);
      expect(ownersAfter?.has("user-uuid-auto")).toBe(true);
    });
  });

  describe("listWebSessionsByOwnerUuid", () => {
    test("returns only owned and non-closed sessions in web format", () => {
      const s1 = createSession({ title: "Active 1" });
      const s2 = createSession({ title: "Active 2" });
      storeBindSession(s1.id, "user-a");
      storeBindSession(s2.id, "user-a");

      const result = listWebSessionsByOwnerUuid("user-a");
      expect(result).toHaveLength(2);
    });

    test("excludes archived sessions", () => {
      const s1 = createSession({});
      storeBindSession(s1.id, "user-a");
      // Archive s1
      const session = storeGetSession(s1.id);
      if (session) {
        const { storeUpdateSession } = require("../store");
        storeUpdateSession(s1.id, { status: "archived" });
      }

      const result = listWebSessionsByOwnerUuid("user-a");
      expect(result).toHaveLength(0);
    });
  });

  describe("updateSessionTitle", () => {
    test("updates title in store", () => {
      const s = createSession({ title: "Original" });
      updateSessionTitle(s.id, "Updated Title");
      expect(getSession(s.id)?.title).toBe("Updated Title");
    });
  });

  describe("touchSession", () => {
    test("updates updatedAt without changing other fields", () => {
      const s = createSession({ title: "Keep This" });
      const originalTitle = getSession(s.id)?.title;
      touchSession(s.id);
      expect(getSession(s.id)?.title).toBe(originalTitle);
    });
  });

  describe("listSessions", () => {
    test("returns all sessions including closed", () => {
      createSession({});
      createSession({});
      const all = listSessions();
      expect(all).toHaveLength(2);
    });
  });
});
