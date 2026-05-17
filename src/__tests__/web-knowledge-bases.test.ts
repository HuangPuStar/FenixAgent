import { beforeEach, afterEach, describe, expect, test } from "bun:test";

import { default as Elysia } from "elysia";
import { db } from "../db";
import {
  agentConfig,
  agentKnowledgeBinding,
  knowledgeBase,
  knowledgeResource,
  user,
  team,
} from "../db/schema";
import { eq } from "drizzle-orm";
import webKnowledgeBases from "../routes/web/knowledge-bases";
import { setKnowledgeProviderForTesting } from "../services/knowledge-base";
import { setTestAuth, resetTestAuth } from "../plugins/auth";
import { setTestTeamContext } from "../services/team-context";

// 固定的测试团队 UUID，与 authContext 返回一致
const TEST_TEAM_ID = "a0000000-0000-0000-0000-000000000001";
const TEST_USER_ID = "kb-user-1";

import { teamMember } from "../db/schema";

const testApp = new Elysia().use(webKnowledgeBases);

function request(path: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-active-team-id", TEST_TEAM_ID);
  return testApp.handle(new Request(`http://localhost${path}`, { ...init, headers }));
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
  const [existing] = await db.select().from(user).where(eq(user.id, TEST_USER_ID));
  if (!existing) {
    await db.insert(user).values({
      id: TEST_USER_ID,
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
      createdBy: TEST_USER_ID,
      createdAt: now,
      updatedAt: now,
    });
  }
  const [membership] = await db.select().from(teamMember)
    .where(eq(teamMember.teamId, TEST_TEAM_ID)).limit(1);
  if (!membership) {
    await db.insert(teamMember).values({ teamId: TEST_TEAM_ID, userId: TEST_USER_ID, role: "owner" });
  }
}

describe("Knowledge base routes", () => {
  beforeEach(async () => {
    const authCtx = { teamId: TEST_TEAM_ID, userId: TEST_USER_ID, role: "owner" as const };
    setTestAuth({
      user: { id: TEST_USER_ID, email: "kb@test.com", name: "KB User" },
      authContext: authCtx,
    });
    setTestTeamContext(authCtx);
    setKnowledgeProviderForTesting(fakeProvider as any);
    await db.delete(agentKnowledgeBinding);
    await db.delete(knowledgeResource);
    await db.delete(knowledgeBase);
    await db.delete(agentConfig);
    await db.delete(user).where(eq(user.id, TEST_USER_ID));
    await db.delete(user).where(eq(user.id, "other-user"));
    await ensureUser();
    await ensureTeam();
  });

  afterEach(() => {
    resetTestAuth();
    setTestTeamContext(null);
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

    expect(response.status).toBe(200);
    const body = await response.json();
    // id 现在是 UUID 格式
    expect(body.id).toMatch(/^[0-9a-f]{8}-/);
    expect(body.remoteId).toBe("viking://resources/kb/kb-user-1/project-docs/");
  });

  test("GET /web/knowledgeBases lists team rows with binding summary", async () => {
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
      userId: TEST_USER_ID,
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
    const [acForBinding] = await db.insert(agentConfig).values({
      userId: TEST_USER_ID,
      teamId: TEST_TEAM_ID,
      name: "build",
    }).returning();
    await db.insert(agentKnowledgeBinding).values({
      agentConfigId: acForBinding.id,
      knowledgeBaseId: kbA.id,
      priority: 0,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).returning();

    const response = await request("/web/knowledgeBases");
    expect(response.status).toBe(200);
    const body = await response.json();
    // 同一 team 下所有知识库都返回（多租户按 team 隔离）
    expect(body).toHaveLength(2);
    const foundA = body.find((e: any) => e.id === kbA.id);
    expect(foundA).toBeDefined();
    expect(foundA.bindingsCount).toBe(1);
  });

  test("PATCH /web/knowledgeBases/:id updates description and preserves other fields", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const [kb] = await db.insert(knowledgeBase).values({
      userId: TEST_USER_ID,
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
      userId: TEST_USER_ID,
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
      userId: TEST_USER_ID,
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
