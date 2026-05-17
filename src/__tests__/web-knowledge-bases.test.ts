import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../auth/better-auth", () => ({
  auth: {
    api: {
      getSession: async () => ({
        user: { id: "kb-user-1", email: "kb@test.com", name: "KB User" },
        session: { id: "sess-kb-1", userId: "kb-user-1", token: "tok-kb-1" },
      }),
    },
  },
}));

// 固定的测试团队 UUID，与 mock getAuthContext 返回一致
const TEST_TEAM_ID = "a0000000-0000-0000-0000-000000000001";

mock.module("../services/team", () => ({
  getAuthContext: async () => ({ teamId: TEST_TEAM_ID, userId: "kb-user-1", role: "owner" }),
  getAuthContextByTeamId: async () => ({ teamId: TEST_TEAM_ID, userId: "kb-user-1", role: "owner" }),
  ensurePersonalTeam: async () => {},
  listMyTeams: async () => [{ id: TEST_TEAM_ID, name: "KB Test Team", slug: "kb-test-team" }],
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

const { default: Elysia } = await import("elysia");
const { db } = await import("../db");
const {
  agentConfig,
  agentKnowledgeBinding,
  knowledgeBase,
  knowledgeResource,
  user,
  team,
} = await import("../db/schema");
const { eq } = await import("drizzle-orm");
const webKnowledgeBases = (await import("../routes/web/knowledge-bases")).default;
const { setKnowledgeProviderForTesting } = await import("../services/knowledge-base");

const testApp = new Elysia().use(webKnowledgeBases);

function request(path: string, init?: RequestInit) {
  return testApp.handle(new Request(`http://localhost${path}`, init));
}

const fakeProvider = {
  async createKnowledgeBase(input: { slug: string; name: string }) {
    return {
      remoteId: null,
      name: input.name,
      status: "empty" as const,
      description: null,
      lastError: null,
    };
  },
  async addResource() {
    throw new Error("unused");
  },
  async listResources() {
    return [];
  },
  async deleteResource() {
    return;
  },
  async search() {
    return [];
  },
  async readResource() {
    return { resourceId: "unused", content: "" };
  },
};

async function ensureUser() {
  const now = new Date();
  const [existing] = await db.select().from(user).where(eq(user.id, "kb-user-1"));
  if (!existing) {
    await db.insert(user).values({
      id: "kb-user-1",
      name: "KB User",
      email: "kb@test.com",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
  }
}

/** 确保测试团队存在 */
async function ensureTeam() {
  const [existing] = await db.select().from(team).where(eq(team.id, TEST_TEAM_ID));
  if (!existing) {
    const now = new Date();
    await db.insert(team).values({
      id: TEST_TEAM_ID,
      name: "KB Test Team",
      slug: "kb-test-team",
      createdBy: "kb-user-1",
      createdAt: now,
      updatedAt: now,
    });
  }
}

describe("Knowledge base routes", () => {
  beforeEach(async () => {
    setKnowledgeProviderForTesting(fakeProvider as any);
    await db.delete(agentKnowledgeBinding);
    await db.delete(knowledgeResource);
    await db.delete(knowledgeBase);
    await db.delete(agentConfig);
    await db.delete(user).where(eq(user.id, "kb-user-1"));
    await db.delete(user).where(eq(user.id, "other-user"));
    await ensureUser();
    await ensureTeam();
  });

  test("POST /web/knowledgeBases returns 201 with UUID id", async () => {
    const response = await request("/web/knowledgeBases", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Project Docs",
        slug: "project-docs",
        description: "docs",
      }),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    // id 现在是 UUID 格式
    expect(body.id).toMatch(/^[0-9a-f]{8}-/);
    expect(body.remoteId).toBe("viking://resources/kb/kb-user-1/project-docs/");
  });

  test("GET /web/knowledgeBases lists only current user rows with binding summary", async () => {
    const now = new Date();
    await db.insert(user).values({
      id: "other-user",
      name: "Other User",
      email: "other@test.com",
      emailVerified: false,
      createdAt: now,
      updatedAt: now,
    });
    const [kbA] = await db.insert(knowledgeBase).values({
      userId: "kb-user-1",
      teamId: TEST_TEAM_ID,
      name: "Docs A",
      slug: "docs-a",
      description: null,
      provider: "openviking",
      remoteId: "remote-a",
      status: "ready",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    const [kbB] = await db.insert(knowledgeBase).values({
      userId: "other-user",
      teamId: TEST_TEAM_ID,
      name: "Docs B",
      slug: "docs-b",
      description: null,
      provider: "openviking",
      remoteId: "remote-b",
      status: "ready",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).returning();
    await db.insert(agentKnowledgeBinding).values({
      agentConfigId: null,
      agentName: "build",
      knowledgeBaseId: kbA.id,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const response = await request("/web/knowledgeBases");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(kbA.id);
    expect(body[0].bindingsCount).toBe(1);
  });

  test("PATCH /web/knowledgeBases/:id updates description and preserves other fields", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const [kb] = await db.insert(knowledgeBase).values({
      userId: "kb-user-1",
      teamId: TEST_TEAM_ID,
      name: "Docs",
      slug: "docs",
      description: "before",
      provider: "openviking",
      remoteId: "remote-docs",
      status: "ready",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const response = await request(`/web/knowledgeBases/${kb.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ description: "after" }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.description).toBe("after");
    expect(body.name).toBe("Docs");
    expect(body.updatedAt).toBeGreaterThan(body.createdAt);
  });

  test("DELETE /web/knowledgeBases/:id removes the row and subsequent GET returns 404", async () => {
    const deleteCalls: Array<{ remoteId: string; recursive?: boolean }> = [];
    setKnowledgeProviderForTesting({
      ...fakeProvider,
      async deleteResource(input: { resourceRemoteId: string; recursive?: boolean }) {
        deleteCalls.push({ remoteId: input.resourceRemoteId, recursive: input.recursive });
      },
    } as any);
    const now = new Date();
    const [kb] = await db.insert(knowledgeBase).values({
      userId: "kb-user-1",
      teamId: TEST_TEAM_ID,
      name: "Docs",
      slug: "docs",
      description: null,
      provider: "openviking",
      remoteId: "viking://resources/kb/kb-user-1/docs/",
      status: "ready",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const deleteResponse = await request(`/web/knowledgeBases/${kb.id}`, {
      method: "DELETE",
    });
    expect(deleteResponse.status).toBe(200);
    expect(deleteCalls).toEqual([
      { remoteId: "viking://resources/kb/kb-user-1/docs/", recursive: true },
    ]);

    const detailResponse = await request(`/web/knowledgeBases/${kb.id}`);
    expect(detailResponse.status).toBe(404);
  });

  test("DELETE /web/knowledgeBases/:id returns provider error message when remote delete fails", async () => {
    setKnowledgeProviderForTesting({
      ...fakeProvider,
      async deleteResource() {
        throw new Error("Resource is being processed: viking://resources/kb/kb-user-1/docs/");
      },
    } as any);
    const now = new Date();
    const [kb] = await db.insert(knowledgeBase).values({
      userId: "kb-user-1",
      teamId: TEST_TEAM_ID,
      name: "Docs Busy",
      slug: "docs-busy",
      description: null,
      provider: "openviking",
      remoteId: "viking://resources/kb/kb-user-1/docs/",
      status: "ready",
      lastError: null,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const response = await request(`/web/knowledgeBases/${kb.id}`, {
      method: "DELETE",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.message).toBe("Resource is being processed: viking://resources/kb/kb-user-1/docs/");
  });
});
