import { describe, test, expect, beforeEach, afterAll, mock } from "bun:test";

// Mock config before imports
mock.module("../config", () => ({
  config: {
    port: 3000,
    host: "0.0.0.0",
    apiKeys: ["test-api-key"],
    baseUrl: "http://localhost:3000",
    pollTimeout: 8,
    heartbeatInterval: 20,
    jwtExpiresIn: 3600,
    disconnectTimeout: 300,
  },
  getBaseUrl: () => "http://localhost:3000",
}));

import Elysia from "elysia";
import { db } from "../db";
import { user as userTable } from "../db/schema";
import { eq } from "drizzle-orm";
import { resetAllRepos } from "../repositories";
import { authGuardPlugin } from "../plugins/auth";
import { generateWorkerJwt } from "../auth/jwt";

// Ensure system user exists for apiKeyAuth's ensureSystemUser fallback
async function ensureSystemUser() {
  const existing = await db.select().from(userTable).where(eq(userTable.email, "system@rcs.local")).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  try {
    await db.insert(userTable).values({
      id: "system", name: "System", email: "system@rcs.local",
      emailVerified: false, createdAt: now, updatedAt: now,
    });
  } catch {}
}
await ensureSystemUser();

function createTestApp() {
  return new Elysia()
    .use(authGuardPlugin)
    .get("/api-key-test", ({ store }) => ({ userId: store.user?.id || null }), { apiKeyAuth: true })
    .get("/ingress/:id", () => ({ ok: true }), { sessionIngressAuth: true })
    .get("/uuid-test", ({ store }) => ({ uuid: store.uuid }), { uuidAuth: true })
    .get("/cli-headers", () => ({ ok: true }));
}

function request(app: Elysia, path: string, init?: RequestInit) {
  return app.handle(new Request(`http://localhost${path}`, init));
}

describe("Auth Middleware", () => {
  let app: any;

  beforeEach(() => {
    resetAllRepos();
    app = createTestApp();
  });

  describe("apiKeyAuth", () => {
    test("accepts valid legacy global API key via Bearer header", async () => {
      const res = await request(app, "/api-key-test", {
        headers: { Authorization: "Bearer test-api-key" },
      });
      expect(res.status).toBe(200);
    });

    test("accepts valid legacy global API key via query param", async () => {
      const res = await request(app, "/api-key-test?token=test-api-key");
      expect(res.status).toBe(200);
    });

    test("rejects invalid token", async () => {
      const res = await request(app, "/api-key-test", {
        headers: { Authorization: "Bearer wrong-key" },
      });
      expect(res.status).toBe(401);
    });

    test("rejects missing token", async () => {
      const res = await request(app, "/api-key-test");
      expect(res.status).toBe(401);
    });
  });

  describe("sessionIngressAuth", () => {
    const originalKeys = process.env.RCS_API_KEYS;
    beforeEach(() => {
      process.env.RCS_API_KEYS = "test-api-key";
    });
    afterAll(() => {
      process.env.RCS_API_KEYS = originalKeys;
    });

    test("accepts valid API key", async () => {
      const res = await request(app, "/ingress/ses_123", {
        headers: { Authorization: "Bearer test-api-key" },
      });
      expect(res.status).toBe(200);
    });

    test("accepts valid worker JWT", async () => {
      const jwt = generateWorkerJwt("ses_123", 3600);
      const res = await request(app, "/ingress/ses_123", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
      expect(res.status).toBe(200);
    });

    test("rejects missing token", async () => {
      const res = await request(app, "/ingress/ses_123");
      expect(res.status).toBe(401);
    });

    test("rejects invalid token", async () => {
      const res = await request(app, "/ingress/ses_123", {
        headers: { Authorization: "Bearer invalid" },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("uuidAuth", () => {
    test("accepts UUID from query param", async () => {
      const res = await request(app, "/uuid-test?uuid=test-uuid-1");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.uuid).toBe("test-uuid-1");
    });

    test("rejects missing UUID", async () => {
      const res = await request(app, "/uuid-test");
      expect(res.status).toBe(401);
    });
  });

  describe("acceptCliHeaders", () => {
    test("passes through to handler", async () => {
      const res = await request(app, "/cli-headers");
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });
  });
});
