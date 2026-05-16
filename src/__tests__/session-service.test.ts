import { describe, test, expect, beforeEach } from "bun:test";
import {
  resetAllRepos,
  environmentRepo,
} from "../repositories";
import { db } from "../db";
import { user } from "../db/schema";
import { eq } from "drizzle-orm";
import {
  createSession,
  getSession,
  updateSessionStatus,
  archiveSession,
  resolveExistingSessionId,
} from "../services/session";
import { getEventBus, removeEventBus, getAllEventBuses } from "../transport/event-bus";

async function ensureUser(userId: string) {
  const existing = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (existing.length === 0) {
    const now = new Date();
    try {
      await db.insert(user).values({
        id: userId,
        name: userId,
        email: `${userId}@session-svc-test.com`,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      });
    } catch {
      // User might already exist
    }
  }
}

describe("Session Service - Core Functions", () => {
  beforeEach(async () => {
    await ensureUser("u1");
    resetAllRepos();
    for (const [key] of getAllEventBuses()) {
      removeEventBus(key);
    }
  });

  // createSession 返回轻量存根
  describe("createSession", () => {
    test("creates session with session_ prefix and defaults", async () => {
      const resp = await createSession({});
      expect(resp.id).toMatch(/^session_/);
      expect(resp.status).toBe("idle");
    });
  });

  // getSession 检查 EventBus 是否活跃
  describe("getSession", () => {
    test("returns null when no EventBus exists", async () => {
      expect(await getSession("nonexistent")).toBeNull();
    });

    test("returns active session stub when EventBus exists", async () => {
      getEventBus("test-s1");
      const s = await getSession("test-s1");
      expect(s).not.toBeNull();
      expect(s!.id).toBe("test-s1");
      expect(s!.status).toBe("active");
    });
  });

  // resolveExistingSessionId 检查 EventBus 是否活跃
  describe("resolveExistingSessionId", () => {
    test("returns id when EventBus exists", async () => {
      getEventBus("test-s2");
      expect(await resolveExistingSessionId("test-s2")).toBe("test-s2");
    });

    test("returns null when no EventBus", async () => {
      expect(await resolveExistingSessionId("nonexistent")).toBeNull();
    });
  });

  // updateSessionStatus 发布事件到 EventBus
  describe("updateSessionStatus", () => {
    test("publishes status event on bus", async () => {
      const bus = getEventBus("test-s3");
      const events: any[] = [];
      bus.subscribe((e: any) => events.push(e));

      await updateSessionStatus("test-s3", "running");
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("session_status");
      expect(events[0].payload.status).toBe("running");
    });

    test("no-ops when no EventBus exists", async () => {
      // Should not throw
      await updateSessionStatus("nonexistent", "active");
    });
  });

  // archiveSession 移除 EventBus
  describe("archiveSession", () => {
    test("removes EventBus for session", async () => {
      getEventBus("test-s4");
      expect(getAllEventBuses().has("test-s4")).toBe(true);
      await archiveSession("test-s4");
      expect(getAllEventBuses().has("test-s4")).toBe(false);
    });
  });
});
