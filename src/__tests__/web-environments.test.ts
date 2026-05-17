import { describe, test, expect, beforeEach, mock } from "bun:test";

// 固定的测试团队 UUID
const TEST_TEAM_ID = "d0000000-0000-0000-0000-000000000001";

// Mock config before imports
mock.module("../config", () => ({
  config: { port: 3000, host: "0.0.0.0", apiKeys: [], baseUrl: "http://localhost:3000" },
  getBaseUrl: () => "http://localhost:3000",
}));

// Mock auth to bypass authentication
mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "test-user-1", email: "test@test.com", name: "TestUser" },
        session: { id: "sess-1", userId: "test-user-1", token: "tok-1" },
      }),
      signUpEmail: async () => ({}),
    },
  },
}));

mock.module("../services/team", () => ({
  getAuthContext: async () => ({ teamId: TEST_TEAM_ID, userId: "test-user-1", role: "owner" }),
    getAuthContextByTeamId: async () => ({ teamId: TEST_TEAM_ID, userId: "test-user-1", role: "owner" }),
  ensurePersonalTeam: async () => {},
  listMyTeams: async () => [],
  getTeamDetail: async () => null,
  createTeam: async () => null,
  switchTeam: async () => null,
  addMember: async () => {},
  removeMember: async () => false,
  updateRole: async () => false,
  getTeamMembers: async () => [],
  updateTeam: async () => false,
  deleteTeam: async () => false,
}));

// Mock instance service
mock.module("../services/instance", () => ({
  findRunningInstanceByEnvironment: mock(() => undefined),
  spawnInstanceFromEnvironment: mock(async (_ctx: any, _envId: string) => ({
    id: "inst_test_auto",
    teamId: TEST_TEAM_ID,
    port: 8888,
    pid: 12345,
    status: "running",
    command: "acp-link ...",
    error: null,
    apiKey: "test_key",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    environmentId: _envId,
    sessionId: "session_auto_spawned",
    instanceNumber: 1,
  })),
  listInstancesByEnvironment: mock(() => []),
  getRunningInstancesByEnvironment: mock(() => []),
}));

const { resetAllRepos, environmentRepo } = await import("../repositories");
const { db } = await import("../db");
const { user, team } = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const { default: Elysia } = await import("elysia");
const instanceMock = await import("../services/instance");
const webEnvironments = (await import("../routes/web/environments")).default;

const testApp = new Elysia().use(webEnvironments);

function request(path: string, init?: RequestInit) {
  return testApp.handle(new Request(`http://localhost${path}`, init));
}

async function ensureTestUser() {
  const existing = await db.select().from(user).where(eq(user.id, "test-user-1")).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  try {
    await db.insert(user).values({
      id: "test-user-1",
      name: "TestUser",
      email: "test-webenv@test.com",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // User might already exist from other tests
  }
}

/** 确保测试团队存在 */
async function ensureTestTeam() {
  const existing = await db.select().from(team).where(eq(team.id, TEST_TEAM_ID)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  try {
    await db.insert(team).values({
      id: TEST_TEAM_ID,
      name: "WebEnv Test Team",
      slug: "webenv-test-team",
      createdBy: "test-user-1",
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    // Team might already exist from other tests
  }
}

await ensureTestUser();
await ensureTestTeam();

describe("Web Environments CRUD API", () => {
  beforeEach(() => {
    resetAllRepos();
    (instanceMock.listInstancesByEnvironment as any).mockClear?.();
    (instanceMock.listInstancesByEnvironment as any).mockReturnValue?.([]);
    (instanceMock.getRunningInstancesByEnvironment as any).mockClear?.();
    (instanceMock.getRunningInstancesByEnvironment as any).mockReturnValue?.([]);
    (instanceMock.spawnInstanceFromEnvironment as any).mockClear?.();
    (instanceMock.findRunningInstanceByEnvironment as any).mockClear?.();
  });

  test("POST /web/environments — registers successfully", async () => {
    const envName = `test-env-${Date.now()}`;
    const res = await request("/web/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: envName, workspacePath: "/tmp/test-crud-ws" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).toBeDefined();
    expect(body.name).toBe(envName);
    expect(body.secret).toMatch(/^env_secret_/);
    expect(body.workspace_path).toBe("/tmp/test-crud-ws");
  });

  test("POST /web/environments — rejects invalid name", async () => {
    const res = await request("/web/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "INVALID", workspacePath: "/tmp/ws" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("VALIDATION_ERROR");
  });

  test("POST /web/environments — rejects relative workspacePath", async () => {
    const res = await request("/web/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "env-rel", workspacePath: "relative/path" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("VALIDATION_ERROR");
  });

  test("POST /web/environments — rejects system directory", async () => {
    const res = await request("/web/environments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "env-sys", workspacePath: "/" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.type).toBe("VALIDATION_ERROR");
  });

  test("GET /web/environments — lists environments without secret", async () => {
    const resBefore = await request("/web/environments");
    const before = (await resBefore.json()).length;

    const envName = `env-list-${Date.now()}`;
    await environmentRepo.create({ name: envName, workspacePath: "/tmp/ws1", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });

    const res = await request("/web/environments");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.length - before).toBe(1);
    const added = body.find((e: any) => e.name === envName);
    expect(added).toBeDefined();
    expect(added.secret).toBeUndefined();
  });

  test("GET /web/environments/:id — returns detail with secret", async () => {
    const env = await environmentRepo.create({ name: `env-detail-${Date.now()}`, workspacePath: "/tmp/ws", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });

    const res = await request(`/web/environments/${env.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBe(env.secret);
  });

  test("GET /web/environments/:id — returns 404 for non-existent", async () => {
    const res = await request("/web/environments/env_noexist");
    expect(res.status).toBe(404);
  });

  test("PUT /web/environments/:id — updates description", async () => {
    const env = await environmentRepo.create({ name: `env-put-${Date.now()}`, workspacePath: "/tmp/ws", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });

    const res = await request(`/web/environments/${env.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "updated desc" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.description).toBe("updated desc");
  });

  test("DELETE /web/environments/:id — deletes environment", async () => {
    const env = await environmentRepo.create({ name: `env-del-${Date.now()}`, workspacePath: "/tmp/ws", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });

    const res = await request(`/web/environments/${env.id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(await environmentRepo.getById(env.id)).toBeUndefined();
  });

  test("GET /web/environments — returns instances array and instances_count", async () => {
    const envName = `env-inst-count-${Date.now()}`;
    await environmentRepo.create({ name: envName, workspacePath: "/tmp/ws1", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });

    const res = await request("/web/environments");
    expect(res.status).toBe(200);
    const body = await res.json();
    const added = body.find((e: any) => e.name === envName);
    expect(added).toBeDefined();
    expect(Array.isArray(added.instances)).toBe(true);
    expect(added.instances_count).toBe(0);
  });

  test("GET /web/environments — includes active instance data", async () => {
    const env = await environmentRepo.create({ name: `env-inst-data-${Date.now()}`, workspacePath: "/tmp/ws2", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });
    (instanceMock.listInstancesByEnvironment as any).mockReturnValue([{
      id: "inst_1",
      instanceNumber: 1,
      status: "running",
      sessionId: "session_a",
      port: 8888,
      createdAt: new Date("2026-01-01T00:00:00Z"),
    }]);

    const res = await request("/web/environments");
    expect(res.status).toBe(200);
    const body = await res.json();
    const found = body.find((e: any) => e.id === env.id);
    expect(found).toBeDefined();
    expect(found.instances).toHaveLength(1);
    expect(found.instances[0].instance_number).toBe(1);
    expect(found.instances[0].status).toBe("running");
    expect(found.instances_count).toBe(1);
  });

  test("POST /:id/enter with empty body auto-creates instance", async () => {
    const env = await environmentRepo.create({ name: `env-enter-auto-${Date.now()}`, workspacePath: "/tmp/ws3", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });

    const res = await request(`/web/environments/${env.id}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instance_id).toBeDefined();
    expect(body.instance_number).toBe(1);
  });

  test("POST /:id/enter with instance_number selects specific instance", async () => {
    const env = await environmentRepo.create({ name: `env-enter-num-${Date.now()}`, workspacePath: "/tmp/ws4", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });
    (instanceMock.getRunningInstancesByEnvironment as any).mockReturnValue([
      { id: "inst_1", instanceNumber: 1, status: "running", sessionId: "session_a", port: 8888, createdAt: new Date() },
      { id: "inst_2", instanceNumber: 2, status: "running", sessionId: "session_b", port: 8889, createdAt: new Date() },
    ]);

    const res = await request(`/web/environments/${env.id}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_number: 2 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instance_number).toBe(2);
    expect(body.instance_id).toBe("inst_2");
  });

  test("POST /:id/enter with non-existent instance_number returns 404", async () => {
    const env = await environmentRepo.create({ name: `env-enter-404-${Date.now()}`, workspacePath: "/tmp/ws5", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });
    (instanceMock.getRunningInstancesByEnvironment as any).mockReturnValue([
      { id: "inst_1", instanceNumber: 1, status: "running", sessionId: "session_a", port: 8888, createdAt: new Date() },
    ]);

    const res = await request(`/web/environments/${env.id}/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ instance_number: 5 }),
    });
    expect(res.status).toBe(404);
  });

  test("GET /:id/instances returns active instance list", async () => {
    const env = await environmentRepo.create({ name: `env-list-inst-${Date.now()}`, workspacePath: "/tmp/ws6", userId: "test-user-1", teamId: TEST_TEAM_ID, status: "idle" });
    (instanceMock.listInstancesByEnvironment as any).mockReturnValue([
      { id: "inst_1", instanceNumber: 1, status: "running", sessionId: "session_a", port: 8888, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "inst_2", instanceNumber: 2, status: "starting", sessionId: "session_b", port: 8889, createdAt: new Date("2026-01-02T00:00:00Z") },
    ]);

    const res = await request(`/web/environments/${env.id}/instances`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.environment_id).toBe(env.id);
    expect(body.instances).toHaveLength(2);
    expect(body.instances[0].instance_number).toBe(1);
    expect(body.instances[1].instance_number).toBe(2);
  });

  test("GET /:id/instances returns 404 for non-existent environment", async () => {
    const res = await request("/web/environments/env_noexist/instances");
    expect(res.status).toBe(404);
  });
});
