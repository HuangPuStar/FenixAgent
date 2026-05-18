import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import Elysia from "elysia";
import { generateWorkerJwt } from "../auth/jwt";
import { db } from "../db";
import { team as teamTable, user as userTable } from "../db/schema";
import { authGuardPlugin } from "../plugins/auth";
import { environmentRepo, resetAllRepos } from "../repositories";

// Mock 隔离问题：此文件的全局运行会因 mock.module() 缓存污染导致加载失败。
// 单独运行（bun test src/__tests__/middleware.test.ts）正常。
// TODO: 重构为使用独立的 test isolation 或真实 DB 连接

const TEST_USER_ID = "u-mw-test";
const TEST_TEAM_SLUG = "mw-test-team";
let TEST_TEAM_ID: string | undefined;

// 创建测试用 user + team
async function ensureTestData() {
  const now = new Date();
  const existingUser = await db.select().from(userTable).where(eq(userTable.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db
      .insert(userTable)
      .values({
        id: TEST_USER_ID,
        name: "MW Test",
        email: "mw-test@rcs.local",
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      })
      .catch(() => {});
  }
  const existing = await db.select().from(teamTable).where(eq(teamTable.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) {
    TEST_TEAM_ID = existing[0].id;
    return;
  }
  const [created] = await db
    .insert(teamTable)
    .values({
      name: "MW Test Team",
      slug: TEST_TEAM_SLUG,
      createdBy: TEST_USER_ID,
    })
    .returning();
  TEST_TEAM_ID = created.id;
}
await ensureTestData();

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

describe.skip("Auth Middleware", () => {
  let app: any;

  beforeEach(() => {
    resetAllRepos();
    app = createTestApp();
  });

  // apiKeyAuth 通过 environment secret 认证
  describe("apiKeyAuth", () => {
    test("accepts valid environment secret via Bearer header", async () => {
      const env = await environmentRepo.create({
        name: `test-env-${Date.now()}`,
        workspacePath: "/tmp/ws",
        userId: TEST_USER_ID,
        teamId: TEST_TEAM_ID!,
        status: "idle",
      });

      const res = await request(app, "/api-key-test", {
        headers: { Authorization: `Bearer ${env.secret}` },
      });
      expect(res.status).toBe(200);
    });

    test("accepts valid environment secret via query param", async () => {
      const env = await environmentRepo.create({
        name: `test-env-qp-${Date.now()}`,
        workspacePath: "/tmp/ws",
        userId: TEST_USER_ID,
        teamId: TEST_TEAM_ID!,
        status: "idle",
      });

      const res = await request(app, `/api-key-test?token=${env.secret}`);
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

  // sessionIngressAuth 仅接受 Worker JWT
  describe("sessionIngressAuth", () => {
    const originalKeys = process.env.RCS_API_KEYS;
    beforeEach(() => {
      process.env.RCS_API_KEYS = "test-api-key";
    });
    afterAll(() => {
      process.env.RCS_API_KEYS = originalKeys;
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
